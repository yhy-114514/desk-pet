// 酒馆的永久记忆：memories 表 + memory_vectors 表（SQLite 版）。
// 鲸鱼娘自己那套 memory.json / memory-vectors.json 一个字节都不动，这里只是复用它的纯逻辑
// （去重合并、bigram / 余弦检索、抽取 prompt），存储换成库里的表。
import { createHash, randomUUID } from 'node:crypto'
import { loadConfig } from '../chat/config'
import { DEFAULT_MODEL } from '../chat/persona'
import { completeChat } from '../chat/deepseek'
import { EMBEDDING_MODEL, embedTexts } from '../chat/embedding'
import {
  buildExtractionPrompt,
  formatMemoryContext,
  mergeMemories,
  parseExtraction,
  searchMemories,
  searchMemoriesByVector,
  type ExtractedMemory,
  type MemoryItem
} from '../chat/memory'
import { openTavernDb } from './db'
import { loadMemorySettings } from './memorySettings'

type Row = Record<string, unknown>

/** 查询向量挡在发消息前面：宁可这一轮退回关键词，也别让回复迟半秒以上。 */
const QUERY_TIMEOUT_MS = 4000
/** 后台补索引 / 抽取：慢一点无妨，给足超时。 */
const INDEX_TIMEOUT_MS = 15_000
const EXTRACT_TIMEOUT_MS = 20_000

function toMemory(row: Row): MemoryItem {
  return {
    id: String(row['id']),
    type: String(row['type']) as MemoryItem['type'],
    content: String(row['content']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at'])
  }
}

/** 某个角色的永久记忆（按最近更新排）。T3 只写 character 作用域。 */
export function listMemories(characterId: string): MemoryItem[] {
  const rows = openTavernDb()
    .prepare(
      'SELECT * FROM memories WHERE scope = ? AND character_id = ? ORDER BY updated_at DESC'
    )
    .all('character', characterId) as Row[]
  return rows.map(toMemory)
}

/** 手账里改内容：改完向量由下一次补齐自动重算（指纹对不上）。 */
export function updateMemory(id: string, content: string): boolean {
  const text = content.trim()
  if (!text) return false
  openTavernDb()
    .prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?')
    .run(text, Date.now(), id)
  return true
}

export function deleteMemory(id: string): void {
  // memory_vectors 有 ON DELETE CASCADE，跟着走
  openTavernDb().prepare('DELETE FROM memories WHERE id = ?').run(id)
}

/**
 * 合并新抽取的记忆：重复的只刷新时间，超上限的淘汰最久未更新的。
 * 复用鲸鱼娘的 mergeMemories（去重规则那一套只写在一处），再把差异落库。
 */
export function saveExtracted(
  characterId: string,
  incoming: ExtractedMemory[],
  now: number = Date.now()
): MemoryItem[] {
  if (incoming.length === 0) return []
  const existing = listMemories(characterId)
  const before = new Map(existing.map((item) => [item.id, item]))
  const { items, added } = mergeMemories(existing, incoming, now, () => randomUUID())

  const db = openTavernDb()
  db.exec('BEGIN')
  try {
    const insert = db.prepare(
      'INSERT INTO memories (id, scope, character_id, chat_id, type, content, created_at, updated_at)' +
        ' VALUES (?, ?, ?, NULL, ?, ?, ?, ?)'
    )
    const update = db.prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?')
    const remove = db.prepare('DELETE FROM memories WHERE id = ?')
    const kept = new Set<string>()
    for (const item of items) {
      kept.add(item.id)
      const old = before.get(item.id)
      if (!old) {
        insert.run(item.id, 'character', characterId, item.type, item.content, item.createdAt, item.updatedAt)
      } else if (old.content !== item.content || old.updatedAt !== item.updatedAt) {
        update.run(item.content, item.updatedAt, item.id)
      }
    }
    // 超过上限被淘汰的
    for (const old of existing) if (!kept.has(old.id)) remove.run(old.id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return added
}

// ── 向量 ──────────────────────────────────────────────────────────────

/** 内容指纹（含模型名）：内容一改就对不上，下次补齐时自动重算。 */
function fingerprint(content: string): string {
  return createHash('sha256').update(`${EMBEDDING_MODEL}\0${content}`).digest('hex').slice(0, 16)
}

function encodeVector(vector: number[]): Buffer {
  const floats = new Float32Array(vector)
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength)
}

function decodeVector(value: unknown): number[] | null {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) return null
  // 复制一份：BLOB 的底层缓冲不保证 4 字节对齐，直接从它建 Float32Array 会抛
  const copy = new Uint8Array(value)
  return Array.from(new Float32Array(copy.buffer))
}

/** 这批记忆里指纹能对上的向量（改过 / 新加的都算没有）。 */
function loadVectors(items: MemoryItem[]): Map<string, number[]> {
  const byId = new Map(items.map((item) => [item.id, item]))
  const map = new Map<string, number[]>()
  if (items.length === 0) return map
  const rows = openTavernDb()
    .prepare('SELECT memory_id, h, v FROM memory_vectors')
    .all() as Row[]
  for (const row of rows) {
    const id = String(row['memory_id'])
    const item = byId.get(id)
    if (!item) continue
    if (String(row['h']) !== fingerprint(item.content)) continue
    const vector = decodeVector(row['v'])
    if (vector) map.set(id, vector)
  }
  return map
}

let vectorQueue: Promise<void> = Promise.resolve()

/**
 * 后台补齐缺失的向量（新记忆、改过的记忆、首次配百炼 Key 的存量）。
 * 永远不 reject：向量是锦上添花，失败只记日志、下一轮再试。
 */
export function ensureVectors(items: MemoryItem[], key: string): Promise<void> {
  vectorQueue = vectorQueue
    .then(async () => {
      const existing = loadVectors(items)
      const missing = items
        .filter((item) => !existing.has(item.id))
        // 指纹必须在 await 之前算好：这期间手账可能改了内容，
        // 拿改后的指纹配改前文本的向量会写进一条「看起来有效、实际对不上」的缓存
        .map((item) => ({ id: item.id, text: item.content, hash: fingerprint(item.content) }))
      if (missing.length === 0) return
      const vectors = await embedTexts(
        missing.map((entry) => entry.text),
        key,
        INDEX_TIMEOUT_MS
      )
      const upsert = openTavernDb().prepare(
        'INSERT INTO memory_vectors (memory_id, h, v) VALUES (?, ?, ?)' +
          ' ON CONFLICT(memory_id) DO UPDATE SET h = excluded.h, v = excluded.v'
      )
      missing.forEach((entry, i) => {
        const vector = vectors[i]
        // 记忆可能在这期间被删了：外键会拒绝插入，跳过就行
        if (!vector) return
        try {
          upsert.run(entry.id, entry.hash, encodeVector(vector))
        } catch {
          // 已删除的记忆：忽略
        }
      })
    })
    .catch((error) => console.warn('[tavern/memory] 补齐向量失败，稍后重试', error))
  return vectorQueue
}

// ── 检索 ──────────────────────────────────────────────────────────────

/**
 * 发送前检索：有百炼 Key 走「关键词 + 语义」双路，没有就只用关键词。
 * 任何失败都退回关键词（记忆是增强，不能挡住聊天）。
 */
export async function retrieveMemoryContext(
  characterId: string,
  queryText: string
): Promise<string> {
  const settings = loadMemorySettings()
  if (!settings.permanentEnabled) return ''
  const items = listMemories(characterId)
  if (items.length === 0) return ''
  const limit = settings.memoryStrength

  const key = loadConfig().qwenKey.trim()
  if (!key) return formatMemoryContext(searchMemories(items, queryText, limit))

  const vectors = loadVectors(items)
  // 还没索引完的在这期间补上，这一轮先用关键词兜底
  void ensureVectors(items, key)
  let queryVector: number[] | null = null
  try {
    const [vector] = await embedTexts([queryText], key, QUERY_TIMEOUT_MS)
    queryVector = vector ?? null
  } catch (error) {
    console.warn('[tavern/memory] 查询向量失败，这一轮只用关键词', error)
  }
  const hits = queryVector
    ? searchMemoriesByVector(items, queryText, queryVector, vectors, limit)
    : searchMemories(items, queryText, limit)
  return formatMemoryContext(hits)
}

// ── 抽取 ──────────────────────────────────────────────────────────────

/**
 * 每轮结束后异步抽取永久记忆（fire-and-forget，失败静默）。
 * 传的是这一轮的用户发言 + 回复，不重读整场对话——抽取的是「这一轮说出了什么值得记的」。
 */
export async function extractAfterTurn(opts: {
  characterId: string
  userText: string
  assistantText: string
}): Promise<void> {
  if (!loadMemorySettings().permanentEnabled) return
  if (!opts.userText.trim() || !opts.assistantText.trim()) return
  const config = loadConfig()
  if (!config.apiKey) return

  const now = new Date()
  const today = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
  try {
    const raw = await completeChat({
      messages: [
        { role: 'system', content: buildExtractionPrompt(today, '对方（角色）') },
        {
          role: 'user',
          content: `用户说：${opts.userText}\n对方回答：${opts.assistantText}`
        }
      ],
      apiKey: config.apiKey,
      model: DEFAULT_MODEL,
      temperature: 0.2,
      maxTokens: 400,
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS)
    })
    const added = saveExtracted(opts.characterId, parseExtraction(raw), now.getTime())
    const key = config.qwenKey.trim()
    if (key && added.length > 0) void ensureVectors(added, key)
  } catch (error) {
    // 抽取失败不该有任何用户可见的痕迹
    console.warn('[tavern/memory] 抽取失败，这一轮不记', error)
  }
}
