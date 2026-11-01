// 记忆向量的持久化与补齐：userData/memory-vectors.json。
// 一条记忆一行 { h: 内容指纹, v: 向量 }：内容改动（手账里改字）指纹就对不上，
// 下次补齐时自动重算——不需要额外的失效逻辑。
//
// 检索只在发消息前等一次「查询向量」（约 300ms）。记忆本身的向量全部后台补齐：
// 补的时候这一轮先用关键词兜底，下次就有了。
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EMBEDDING_MODEL, embedTexts } from './embedding'
import type { MemoryItem } from './memory'

const VERSION = 1

/** 查询向量的超时：它就挡在发消息前面，宁可这一轮退回关键词，也别让回复迟半秒以上。 */
const QUERY_TIMEOUT_MS = 4000
/** 后台补索引：一次十句，慢一点无妨，给足超时。 */
const INDEX_TIMEOUT_MS = 15_000

interface VectorEntry {
  /** 内容指纹（含模型名）：内容一改就对不上，自动重算 */
  h: string
  v: number[]
}

interface VectorData {
  version: number
  model: string
  items: Record<string, VectorEntry>
}

const EMPTY: VectorData = { version: VERSION, model: EMBEDDING_MODEL, items: {} }

let cached: VectorData | null = null
/** 补齐任务串行执行：同一批记忆不会被并发索引两遍、互相覆盖写盘 */
let queue: Promise<void> = Promise.resolve()

export function vectorPath(): string {
  return join(app.getPath('userData'), 'memory-vectors.json')
}

/** 内容指纹。带上模型名：换模型后旧向量自动作废。 */
function fingerprint(content: string): string {
  return createHash('sha256').update(`${EMBEDDING_MODEL}\0${content}`).digest('hex').slice(0, 16)
}

function loadData(): VectorData {
  if (cached) return cached
  const file = vectorPath()
  try {
    if (!existsSync(file)) {
      cached = { ...EMPTY, items: {} }
      return cached
    }
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<VectorData>
    // 换了模型：不同模型的向量不能混着算相似度，整份作废重算
    if (raw.model !== EMBEDDING_MODEL || !raw.items || typeof raw.items !== 'object') {
      cached = { ...EMPTY, items: {} }
      return cached
    }
    cached = { version: VERSION, model: EMBEDDING_MODEL, items: raw.items }
  } catch {
    cached = { ...EMPTY, items: {} }
  }
  return cached
}

function saveData(data: VectorData): void {
  const file = vectorPath()
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(data), 'utf-8')
    renameSync(tmp, file)
  } catch (error) {
    console.error('[memoryVectors] 写入失败', error)
  }
}

/** 当前这批记忆里、指纹能对上的向量（内容改过 / 新加的都算没有）。 */
export function vectorsFor(items: MemoryItem[]): Map<string, number[]> {
  const data = loadData()
  const map = new Map<string, number[]>()
  for (const item of items) {
    const entry = data.items[item.id]
    if (entry && entry.h === fingerprint(item.content)) map.set(item.id, entry.v)
  }
  return map
}

/** 查询向量；没有 Key、网络不通、超时都返回 null，调用方退回关键词检索。 */
export async function embedQuery(text: string, key: string): Promise<number[] | null> {
  try {
    const [vector] = await embedTexts([text], key, QUERY_TIMEOUT_MS)
    return vector ?? null
  } catch (error) {
    console.warn('[memoryVectors] 查询向量失败，这一轮退回关键词检索', error)
    return null
  }
}

/**
 * 补齐缺失的向量（新记忆、改过的记忆、首次启用百炼 Key 的存量）。
 * 永远不 reject：向量是锦上添花，失败只记日志，下一轮再试。
 */
export function ensureVectors(items: MemoryItem[], key: string): Promise<void> {
  queue = queue
    .then(() => indexMissing(items, key))
    .catch((error) => console.warn('[memoryVectors] 补齐向量失败，稍后重试', error))
  return queue
}

async function indexMissing(items: MemoryItem[], key: string): Promise<void> {
  const data = loadData()
  // 指纹必须在 await **之前**算好：手账可能在这期间改了内容，
  // 拿改后的指纹去配改前文本的向量，会写进一条「看起来有效、实际对不上」的缓存，
  // 直到下次再改这个字才会被纠正——语义检索会一直用旧文本的向量。
  const missing = items
    .map((item) => ({ id: item.id, text: item.content, hash: fingerprint(item.content) }))
    .filter((entry) => data.items[entry.id]?.h !== entry.hash)
  let changed = prune(data, items)

  if (missing.length > 0) {
    const vectors = await embedTexts(
      missing.map((entry) => entry.text),
      key,
      INDEX_TIMEOUT_MS
    )
    missing.forEach((entry, i) => {
      // 六位小数足够，能把这份文件压到原来的几分之一（1024 维 × 上千字符）
      data.items[entry.id] = {
        h: entry.hash,
        v: vectors[i].map((n) => Math.round(n * 1e5) / 1e5)
      }
    })
    changed = true
  }

  if (changed) saveData(data)
}

/** 删掉已经不在记忆库里的条目（手账删条 / 合并后），顺手清掉改了内容的旧向量。 */
function prune(data: VectorData, items: MemoryItem[]): boolean {
  const current = new Map(items.map((item) => [item.id, fingerprint(item.content)]))
  let changed = false
  for (const id of Object.keys(data.items)) {
    const hash = current.get(id)
    if (hash !== undefined && hash === data.items[id].h) continue
    delete data.items[id]
    changed = true
  }
  return changed
}
