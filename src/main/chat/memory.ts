// 长期记忆的纯逻辑（无 electron / fetch 依赖，可直接被 vitest 单测）：
// - 抽取结果的清洗与解析；
// - 去重合并与容量上限；
// - 检索（语义向量 + 中文 bigram 关键词，两路取高分；没有向量时只用关键词）；
// - 拼成注入 system 的上下文文本。
// 持久化与 API 调用见 memoryStore.ts / memoryVectors.ts。

export type MemoryType =
  | 'preference'
  | 'event'
  | 'promise'
  | 'identity'
  | 'fact'
  | 'other'

const MEMORY_TYPES: readonly MemoryType[] = [
  'preference',
  'event',
  'promise',
  'identity',
  'fact',
  'other'
]

export interface MemoryItem {
  id: string
  type: MemoryType
  content: string
  createdAt: number
  updatedAt: number
}

/** 模型抽取出的原始记忆（尚未落库）。 */
export interface ExtractedMemory {
  type: MemoryType
  content: string
}

/** 记忆库上限，超出淘汰最久未更新的。 */
export const MEMORY_MAX_ITEMS = 200
/** 每次注入 system 的记忆条数上限。 */
export const MEMORY_CONTEXT_LIMIT = 8

/** 抽取用 system prompt：要求模型只输出 JSON 数组。 */
export const EXTRACT_SYSTEM_PROMPT = `你是一个记忆抽取器。从下面这段对话中提取值得长期记住的用户信息。

规则：
- 只提取关于「用户」的、稳定的、以后可能用得上的事实：喜好/厌恶、重要事件（含时间）、约定/承诺、称呼/身份。
- 忽略寒暄、一次性情绪、客套话、以及关于她（鲸鱼娘）自己的设定。
- type 只能是：preference（喜好厌恶）、event（事件）、promise（约定）、identity（身份：称呼、名字、年龄、职业、和用户的关系）、fact（稳定的客观事实：家人、宠物、住址、常去的地方等）、other（实在归不进上面几类的）。
- 「用户被她称呼为哥哥」属于 identity，不要放进 other。
- 每条 content 用一句简短的中文陈述，以「用户」开头，不超过 40 字。
- 只输出 JSON 数组，不要任何解释或 markdown 围栏。没有值得记的就输出 [].

示例：[{"type":"preference","content":"用户喜欢喝美式咖啡"},{"type":"event","content":"用户将于10月25日去答辩"}]`

/**
 * 抽取 prompt 的完整 system 文本：额外注入当前日期，要求把相对时间换成绝对日期。
 * `selfLabel` 是「对话的另一方」在这个产品里怎么称呼（鲸鱼娘 / 酒馆里的角色），
 * 只影响那一句「别记对方自己的设定」，规则本身一致。
 */
export function buildExtractionPrompt(today: string, selfLabel = '她（鲸鱼娘）'): string {
  const base = EXTRACT_SYSTEM_PROMPT.replace('关于她（鲸鱼娘）自己的设定', `关于${selfLabel}自己的设定`)
  return `${base}

当前日期：${today}。用户说的相对时间（明天、后天、下周、昨天等）必须换算成具体日期写进 content，否则这条记忆过几天就失效了。`
}

/** 把模型返回的任意文本解析成记忆数组；解析失败返回空数组。 */
export function parseExtraction(raw: string): ExtractedMemory[] {
  if (!raw.trim()) return []
  // 容忍模型套了 ```json 围栏或前后带说明文字
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const text = fenced ? fenced[1] : raw
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const result: ExtractedMemory[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as { type?: unknown; content?: unknown }
    if (typeof record.content !== 'string') continue
    const content = record.content.trim()
    if (content.length < 2) continue
    result.push({ type: normalizeType(record.type), content })
  }
  return result
}

/**
 * 把任意值归一到合法的记忆类型；未知类型一律算 other。
 * `address` 是旧版类型键，语义一直是「称呼/身份」，现在统一叫 `identity`。
 */
export function normalizeType(value: unknown): MemoryType {
  const key = value === 'address' ? 'identity' : value
  return typeof key === 'string' && (MEMORY_TYPES as readonly string[]).includes(key)
    ? (key as MemoryType)
    : 'other'
}

/**
 * 只改变表述、不改变含义的虚词。抽取记忆时模型每次换个说法就会多出一条
 * （「下周三要考试」/「下周三有考试」/「下周三有一场考试」），比较前先去掉这些。
 * 故意取得很保守：宁可漏合并交给手账的「合并重复」，也不要误把两件事并成一件。
 */
// 「她」也去掉：同一件事换个称呼（"被她称呼为哥哥"/"被鲸鱼娘称呼为哥哥"）不该算两条
const DEDUP_STOP_WORDS = ['一场', '一次', '一个', '一下', '已经', '的', '了', '要', '有', '会', '将', '喝', '她']

/** 去掉标点空白与虚词，只留下判断「是不是同一件事」用的骨架。 */
function normalizeForDedup(text: string): string {
  let clean = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  for (const word of DEDUP_STOP_WORDS) clean = clean.split(word).join('')
  return clean
}

/** 短串是否完整出现在长串里（太短的串不比，否则「用户」能撞上任何一条）。 */
function contains(one: string, other: string): boolean {
  const [short, long] = one.length <= other.length ? [one, other] : [other, one]
  return short.length >= 4 && long.includes(short)
}

/** 短串的字符是否按顺序都出现在长串里（允许中间插字：她被称呼 / 被鲸鱼娘称呼）。 */
function isSubsequence(short: string, long: string): boolean {
  let i = 0
  for (const char of long) {
    if (char === short[i]) i++
    if (i === short.length) return true
  }
  return false
}

/** 「用户喜欢猫」和「用户不喜欢猫」是两件事，否定词不同就不许合并。 */
function hasNegation(text: string): boolean {
  return /[不没别未]/.test(text)
}

/** 两条记忆是否指同一件事：原文相同/包含，或去掉虚词后相同/包含/按序包含。 */
function isDuplicate(a: string, b: string): boolean {
  if (a === b) return true
  if (contains(a, b)) return true
  const na = normalizeForDedup(a)
  const nb = normalizeForDedup(b)
  if (!na || !nb) return false
  if (contains(na, nb)) return true
  // 中间多插了几个字也算同一件事（「用户被她称呼为哥哥」/「用户被鲸鱼娘称呼为哥哥」）。
  // 要求长度接近（≥60%），否则「用户喜欢猫」会被「用户喜欢猫和狗」整个吞掉；
  // 合并时保留的是更长、更完整的那句，所以并错也只是少了一句重复表述。
  if (hasNegation(na) !== hasNegation(nb)) return false
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na]
  return short.length >= 4 && short.length / long.length >= 0.6 && isSubsequence(short, long)
}

/**
 * 合并新抽取的记忆：
 * - 重复的只刷新 updatedAt，不新增；
 * - 超过上限时保留最近更新的 MEMORY_MAX_ITEMS 条。
 */
export function mergeMemories(
  existing: MemoryItem[],
  incoming: ExtractedMemory[],
  now: number,
  makeId: () => string = defaultId
): { items: MemoryItem[]; added: MemoryItem[] } {
  const items = existing.map((m) => ({ ...m }))
  const added: MemoryItem[] = []

  for (const raw of incoming) {
    const content = raw.content.trim()
    if (content.length < 2) continue
    const dup = items.find((m) => isDuplicate(m.content, content))
    if (dup) {
      dup.updatedAt = now
      if (content.length > dup.content.length) dup.content = content
      continue
    }
    const item: MemoryItem = {
      id: makeId(),
      type: raw.type,
      content,
      createdAt: now,
      updatedAt: now
    }
    items.push(item)
    added.push(item)
  }

  const trimmed =
    items.length > MEMORY_MAX_ITEMS
      ? [...items].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MEMORY_MAX_ITEMS)
      : items

  return { items: trimmed, added }
}

/**
 * 收拾已经存下来的记忆：把互为重复的合并成一条。
 * 老的去重规则漏判了近重复（差一个虚词就当成两件事），存量里会攒下一堆
 * 「考试」变体；加载时跑一次就能收敛，也可以由手账的「合并重复」手动触发。
 *
 * 合并时保留最完整的表述、最早的创建时间、最近的更新时间，
 * 类型优先保留具体分类（不要因为另一条是 other 就把分类丢了）。
 */
export function consolidateMemories(items: MemoryItem[]): { items: MemoryItem[]; removed: number } {
  const result: MemoryItem[] = []
  let removed = 0

  for (const item of items) {
    const target = result.find((m) => isDuplicate(m.content, item.content))
    if (!target) {
      result.push({ ...item })
      continue
    }
    removed++
    if (item.content.length > target.content.length) target.content = item.content
    target.createdAt = Math.min(target.createdAt, item.createdAt)
    target.updatedAt = Math.max(target.updatedAt, item.updatedAt)
    if (target.type === 'other' && item.type !== 'other') target.type = item.type
  }

  return { items: result, removed }
}

/** 中文没有空格，按字符 bigram 集合估算两段文本的重合度。 */
function bigrams(text: string): Set<string> {
  const clean = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const set = new Set<string>()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}

/** query 的 bigram 有多少比例出现在 content 里；0 表示一个都没撞上。 */
function keywordScore(content: string, queryGrams: Set<string>): number {
  const grams = bigrams(content)
  if (grams.size === 0 || queryGrams.size === 0) return 0
  let hit = 0
  for (const gram of queryGrams) if (grams.has(gram)) hit++
  return hit / queryGrams.size
}

/** 空查询 = 没有可聊的话题，返回最近更新的几条做背景。 */
function recentMemories(items: MemoryItem[], limit: number): MemoryItem[] {
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
}

/**
 * 检索与 query 相关的记忆：按 bigram 命中比例排序，取前 limit 条。
 * 命中为 0 的不返回（新话题不硬塞旧记忆）。query 为空时返回最近更新的几条做背景。
 */
export function searchMemories(
  items: MemoryItem[],
  query: string,
  limit = MEMORY_CONTEXT_LIMIT
): MemoryItem[] {
  const q = bigrams(query)
  if (q.size === 0) return recentMemories(items, limit)

  const scored: { item: MemoryItem; score: number }[] = []
  for (const item of items) {
    const score = keywordScore(item.content, q)
    if (score > 0) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((s) => s.item)
}

/**
 * 语义命中门槛（余弦相似度）。实测 text-embedding-v4 上：真正相关的记忆
 * 0.46–0.65，无关的散落在 0.27–0.41（2026-10-24 用真实记忆库校准），取 0.45 分开两边。
 */
export const MIN_SEMANTIC_SIMILARITY = 0.45

/** 两段向量的余弦相似度；长度不一致（换了模型）时按 0 处理。 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}

/**
 * 语义检索：每条记忆取「关键词比重」与「余弦相似度」中的高分，排序后取前 limit 条，
 * 分数为 0 的不返回。
 *
 * 两路取最大值而不是加权平均：关键词命中是确定性的（提到「答辩」就该想起答辩那条），
 * 不能被一次泛泛的语义相似度稀释掉；反过来，换个说法的问法（「想喝点凉的」→ 喜欢冰红茶）
 * 关键词一个都对不上，全靠向量这一路捞回来。
 *
 * 没有向量的记忆（刚加的、后台还没索引完）仍按关键词参与排序，不会消失。
 */
export function searchMemoriesByVector(
  items: MemoryItem[],
  query: string,
  queryVector: readonly number[],
  vectors: Map<string, number[]>,
  limit = MEMORY_CONTEXT_LIMIT
): MemoryItem[] {
  const q = bigrams(query)
  if (q.size === 0) return recentMemories(items, limit)

  const scored: { item: MemoryItem; score: number }[] = []
  for (const item of items) {
    const keyword = keywordScore(item.content, q)
    const vector = vectors.get(item.id)
    const cosine = vector ? cosineSimilarity(queryVector, vector) : 0
    const score = Math.max(keyword, cosine >= MIN_SEMANTIC_SIMILARITY ? cosine : 0)
    if (score > 0) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((s) => s.item)
}

/** 把记忆拼成注入 system 末尾的上下文；没有记忆时返回空串。 */
export function formatMemoryContext(items: MemoryItem[]): string {
  if (items.length === 0) return ''
  const lines = items.map((m) => `- ${m.content}`).join('\n')
  return `【你记得的事（长期记忆，对话中需要时自然地提起，不要生硬罗列）】\n${lines}`
}

/** 默认 id：优先用 crypto.randomUUID，做兜底以便非 Node 环境单测。 */
function defaultId(): string {
  const globalCrypto = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
