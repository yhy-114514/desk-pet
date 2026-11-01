// 长期记忆的持久化与抽取：memory.json 原子写 + 后台调用 DeepSeek 抽取。
// 纯逻辑（解析/去重/检索/格式化）在 memory.ts，这里只负责 electron 侧。
import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { completeChat } from './deepseek'
import { DEFAULT_MODEL } from './persona'
import { loadConfig } from './config'
import { embedQuery, ensureVectors, vectorsFor } from './memoryVectors'
import {
  MEMORY_CONTEXT_LIMIT,
  buildExtractionPrompt,
  consolidateMemories,
  formatMemoryContext,
  mergeMemories,
  normalizeType,
  parseExtraction,
  searchMemories,
  searchMemoriesByVector,
  type ExtractedMemory,
  type MemoryItem
} from './memory'

const VERSION = 1
const DEFAULT_LIMIT = MEMORY_CONTEXT_LIMIT

export interface MemoryStoreData {
  version: number
  items: MemoryItem[]
}

const DEFAULT_DATA: MemoryStoreData = { version: VERSION, items: [] }

let cached: MemoryStoreData | null = null

export function memoryPath(): string {
  return join(app.getPath('userData'), 'memory.json')
}

export function loadMemory(): MemoryStoreData {
  if (cached) return cached
  const file = memoryPath()
  try {
    if (!existsSync(file)) {
      cached = { ...DEFAULT_DATA, items: [] }
      return cached
    }
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<MemoryStoreData>
    const storedCount = Array.isArray(raw.items) ? raw.items.length : 0
    cached = sanitize(raw)
    // 加载时顺手合并存量近重复（旧去重规则漏掉的），合并过就回写一次。
    // 这是唯一的近重复合并入口：合并规则是确定性的，手账里再点一次只会得到同样的结果，
    // 所以没有「合并重复」按钮（曾经有过，用户点了永远只会看到「没有发现重复」）。
    if (cached.items.length < storedCount) saveMemory(cached)
  } catch {
    cached = { ...DEFAULT_DATA, items: [] }
  }
  return cached
}

function saveMemory(data: MemoryStoreData): void {
  const file = memoryPath()
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmp, file)
  } catch (error) {
    console.error('[chatMemory] 写入失败', error)
  }
}

function sanitize(raw: Partial<MemoryStoreData>): MemoryStoreData {
  const items: MemoryItem[] = []
  if (Array.isArray(raw.items)) {
    for (const item of raw.items) {
      if (!item || typeof item.content !== 'string' || !item.content.trim()) continue
      items.push({
        id: typeof item.id === 'string' && item.id ? item.id : `${items.length}-${item.createdAt ?? 0}`,
        type: normalizeType(item.type),
        content: item.content.trim(),
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0
      })
    }
  }
  // 互为重复的合并成一条：存量里「下周三要/有/有一场考试」这类变体太多
  return { version: VERSION, items: consolidateMemories(items).items }
}

/** 记忆变了就顺手把向量补上（后台跑，失败下一轮再试）。 */
function refreshVectors(): void {
  const key = loadConfig().qwenKey.trim()
  if (key) void ensureVectors(loadMemory().items, key)
}

/** 合并新记忆并落盘，返回本次真正新增的条目。 */
export function addMemories(incoming: ExtractedMemory[], now = Date.now()): MemoryItem[] {
  const data = loadMemory()
  const { items, added } = mergeMemories(data.items, incoming, now)
  // 没有抽取结果就不写盘；有结果时即使全是重复（只刷新了 updatedAt）也要落盘，否则淘汰顺序会失真
  if (incoming.length > 0) {
    cached = { version: VERSION, items }
    saveMemory(cached)
    refreshVectors()
  }
  return added
}

/** 手账页：删除一条记忆。 */
export function deleteMemory(id: string): void {
  const data = loadMemory()
  const items = data.items.filter((m) => m.id !== id)
  if (items.length === data.items.length) return
  cached = { version: VERSION, items }
  saveMemory(cached)
  refreshVectors()
}

/** 手账页：改写一条记忆的内容；改成空白等于删除。 */
export function updateMemory(id: string, content: string): void {
  const text = content.trim()
  if (!text) {
    deleteMemory(id)
    return
  }
  const data = loadMemory()
  const target = data.items.find((m) => m.id === id)
  if (!target || target.content === text) return
  target.content = text
  target.updatedAt = Date.now()
  cached = { version: VERSION, items: data.items }
  saveMemory(cached)
  refreshVectors()
}

/** 手账页读写通道（chat:memory-*）。 */
export function registerMemoryIpc(): void {
  // 最近更新的排在最前，刚聊到的记忆一眼能看到
  ipcMain.handle('chat:memory-list', () =>
    [...loadMemory().items].sort((a, b) => b.updatedAt - a.updatedAt)
  )
  ipcMain.on('chat:memory-delete', (_event, id: string) => deleteMemory(id))
  ipcMain.on('chat:memory-edit', (_event, data: { id: string; content: string }) => {
    updateMemory(data.id, data.content)
  })
  // 启动就把存量记忆索引好，别让升级后的第一条消息还在用关键词检索
  refreshVectors()
}

/**
 * 按当前用户输入检索相关记忆（供注入 system 用）。
 *
 * 有百炼 Key 时走向量语义检索：「想喝点凉的」也能想起「用户喜欢喝冰红茶」。
 * 没 Key、超时、接口报错都退回中文 bigram 关键词——和引入向量之前完全一样，
 * 不会因为多了个可选功能把基本盘搞坏。
 */
export async function recallMemories(
  query: string,
  limit = DEFAULT_LIMIT
): Promise<MemoryItem[]> {
  const items = loadMemory().items
  const key = loadConfig().qwenKey.trim()
  // 空输入 = 没有话题可检索，返回最近更新的几条（和关键词版行为一致）
  if (!query.trim() || !key || items.length === 0) return searchMemories(items, query, limit)

  // 缺向量的记忆（刚加的、手账里改过的）在后台补，这一轮先用关键词兜底
  void ensureVectors(items, key)
  const queryVector = await embedQuery(query, key)
  if (!queryVector) return searchMemories(items, query, limit)
  return searchMemoriesByVector(items, query, queryVector, vectorsFor(items), limit)
}

/** 生成注入 system 末尾的记忆上下文；无相关记忆时返回空串。 */
export async function buildMemoryContext(query: string): Promise<string> {
  return formatMemoryContext(await recallMemories(query))
}

/**
 * 一轮正常对话结束后抽取记忆。调用方 fire-and-forget，失败静默：
 * 记忆是锦上添花，绝不能因为抽取失败影响主对话。
 */
export async function extractMemories(opts: {
  userText: string
  assistantText: string
  apiKey: string
  now?: Date
}): Promise<MemoryItem[]> {
  const now = opts.now ?? new Date()
  const today = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
  const raw = await completeChat({
    messages: [
      { role: 'system', content: buildExtractionPrompt(today) },
      { role: 'user', content: `用户说：${opts.userText}\n她回答：${opts.assistantText}` }
    ],
    apiKey: opts.apiKey,
    model: DEFAULT_MODEL,
    temperature: 0.2,
    maxTokens: 400,
    // 后台任务不该无限悬挂；超时交给调用方静默吞掉
    signal: AbortSignal.timeout(15_000)
  })
  return addMemories(parseExtraction(raw), now.getTime())
}
