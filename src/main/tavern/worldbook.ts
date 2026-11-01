// 世界书的纯逻辑：条目模型、三层合并、关键词激活、ST 世界书导入导出。
// 不碰 DB / electron，可直接单测（存储见 lorebookStore.ts）。
//
// 真实成品卡里的条目形状（2026-10-25 从两张卡反推）：
// { comment, content, keys, secondary_keys, constant, selective, insertion_order,
//   position: 'before_char'|'after_char', enabled, extensions: { depth, case_sensitive } }
// 老版 World Info 的写法（key / keysecondary / order / disable）也要认——
// 导入来的 .json 世界书大多是那一种。
import { estimateTokens } from '../chat/session'

export type LoreSource = 'card' | 'global' | 'character' | 'chat'

export type LorePosition = 'before_char' | 'after_char' | 'depth'

export interface LoreEntry {
  id: string
  /** 展示名（ST 的 comment）；没写就用内容首行截断 */
  name: string
  keys: string[]
  secondaryKeys: string[]
  content: string
  constant: boolean
  selective: boolean
  position: LorePosition
  /** position === 'depth' 时插入到历史倒数第几条之前（1 = 紧贴本轮输入） */
  depth: number
  order: number
  caseSensitive: boolean
  source: LoreSource
  /** 卡内嵌条目：只读，编辑面只提供「另存为独立世界书」 */
  readonly: boolean
}

/** 预算内被丢弃 / 激活的条目，调试面板要用 */
export interface LoreActivation {
  active: LoreEntry[]
  /** 关键词命中了但被 token 预算挡掉的 */
  dropped: LoreEntry[]
}

export function loreTokens(entry: LoreEntry): number {
  return estimateTokens(entry.content)
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item !== '')
  }
  // 老格式允许写成逗号分隔的一整个字符串
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
  }
  return []
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === 'true'
}

/**
 * 位置归一化。真实卡把「@深度」写在 `extensions.position = 4`（ST 的 convertCharacterBook
 * 就是 `position = extensions.position ?? (顶层 position === 'before_char' ? 0 : 1)`），
 * 顶层 position 只有前后两种取值——只读顶层会把卡里的深度注入全变成角色设定块。
 * 2 / 3 是 AN（作者注释）前后，本模型没有那一栏，按前 / 后近似。
 */
function normalizePosition(
  value: unknown,
  depth: number,
  extensionPosition?: unknown
): LorePosition {
  if (extensionPosition === 4 || extensionPosition === 6) {
    return depth > 0 ? 'depth' : 'before_char'
  }
  if (value === 'depth' || value === 4 || value === 6) return depth > 0 ? 'depth' : 'before_char'
  // 老格式的 .json 世界书用数字：0 = 角色之前，1 = 之后，2 / 3 = 作者注释前 / 后。
  // 只认字符串的话 position: 1 会落到末尾的 before_char，整块后置设定跑到角色设定前面
  if (
    value === 'after_char' ||
    value === 1 ||
    value === 3 ||
    extensionPosition === 1 ||
    extensionPosition === 3
  ) {
    return 'after_char'
  }
  return 'before_char'
}

/**
 * 卡内嵌世界书（`data.character_book.entries`）。
 * `id` 用卡里给的 uid（导出回去时保持稳定），没有就按序号凑一个。
 * `includeEmpty`：编辑面要看到「刚加还没填内容」的条目，注入侧则跳过空条目。
 */
export function readCardEntries(
  rawData?: Record<string, unknown> | null,
  options: { includeEmpty?: boolean } = {}
): LoreEntry[] {
  const book = rawData?.['character_book']
  if (!book || typeof book !== 'object') return []
  const raw = (book as Record<string, unknown>)['entries']
  if (!Array.isArray(raw)) return []

  const entries: LoreEntry[] = []
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    // ST 里 disabled 既可能写 enabled:false，也可能写 disable:true
    if (entry['enabled'] === false || entry['disable'] === true) continue
    const content = typeof entry['content'] === 'string' ? entry['content'] : ''
    if (!content.trim() && !options.includeEmpty) continue
    const extensions = (entry['extensions'] ?? {}) as Record<string, unknown>
    const depth = num(extensions['depth'] ?? entry['depth'], 0)
    const keys = asStringList(entry['keys'] ?? entry['key'])
    entries.push({
      id: `card:${String(entry['id'] ?? entry['uid'] ?? index)}`,
      name:
        (typeof entry['comment'] === 'string' && entry['comment'].trim()) ||
        content.trim().split('\n')[0]!.slice(0, 40) ||
        '（未命名条目）',
      keys,
      secondaryKeys: asStringList(entry['secondary_keys'] ?? entry['keysecondary']),
      content,
      constant: bool(entry['constant']),
      selective: bool(entry['selective']) || keys.length === 0,
      // 真卡里每条都带 extensions.depth（多角色卡 153 条全有），但 depth 本身不等于
      // 「要注入到历史里」——要看 extensions.position / 顶层 position 是不是「@深度」
      position: normalizePosition(entry['position'], depth, extensions['position']),
      depth: depth > 0 ? depth : 4,
      order: num(entry['insertion_order'] ?? entry['order'], 100),
      caseSensitive: bool(extensions['case_sensitive'] ?? entry['case_sensitive']),
      source: 'card',
      readonly: true
    })
  }
  return entries
}

/** 外部世界书的原始条目（导入时用）：字段名两种写法都认。 */
export function entryFromRaw(
  raw: Record<string, unknown>,
  source: LoreSource,
  index: number
): LoreEntry | null {
  const content = typeof raw['content'] === 'string' ? raw['content'] : ''
  if (!content.trim()) return null
  if (raw['enabled'] === false || raw['disable'] === true) return null
  const extensions = (raw['extensions'] ?? {}) as Record<string, unknown>
  const depth = num(raw['depth'] ?? extensions['depth'], 0)
  const keys = asStringList(raw['keys'] ?? raw['key'])
  return {
    id: `${source}:${index}`,
    name:
      (typeof raw['name'] === 'string' && raw['name'].trim()) ||
      (typeof raw['comment'] === 'string' && raw['comment'].trim()) ||
      content.trim().split('\n')[0]!.slice(0, 40),
    keys,
    secondaryKeys: asStringList(raw['secondary_keys'] ?? raw['keysecondary']),
    content,
    constant: bool(raw['constant']),
    selective: bool(raw['selective']) || keys.length === 0,
    position: normalizePosition(raw['position'], depth, extensions['position']),
    depth: depth > 0 ? depth : 4,
    order: num(raw['insertion_order'] ?? raw['order'], 100),
    caseSensitive: bool(raw['case_sensitive'] ?? extensions['case_sensitive']),
    source,
    readonly: false
  }
}

function hit(text: string, keyword: string, caseSensitive: boolean): boolean {
  if (!keyword) return false
  return caseSensitive ? text.includes(keyword) : text.toLowerCase().includes(keyword.toLowerCase())
}

/**
 * 挑出这一轮要注入的条目：
 * - constant 常驻，不靠关键词；
 * - 其余扫最近几条历史 + 本轮输入，命中任一 keys 才算激活；
 * - selective + secondary_keys 时，二级关键词也得命中（ST 的「选择性」语义）。
 * 结果按 insertion_order 升序；关键词条目受 token 预算截断，常驻条目永远保留
 * （多角色卡的世界规则就是这个量级，算进预算的话关键词条目会被全挤掉）。
 */
export function activateLore(
  entries: LoreEntry[],
  scanText: string,
  maxTokens = 1500
): LoreActivation {
  const active = entries.filter((entry) => {
    if (entry.constant) return true
    if (entry.keys.length === 0) return false
    if (!entry.keys.some((keyword) => hit(scanText, keyword, entry.caseSensitive))) return false
    if (entry.selective && entry.secondaryKeys.length > 0) {
      return entry.secondaryKeys.some((keyword) => hit(scanText, keyword, entry.caseSensitive))
    }
    return true
  })

  const ordered = [...active].sort((a, b) => a.order - b.order)
  const kept: LoreEntry[] = []
  const dropped: LoreEntry[] = []
  const seen = new Set<string>()
  let used = 0
  for (const entry of ordered) {
    // 三层合并后可能撞条：同一条内容只注入一次。
    // 只有**真的注入**时才记账——先记的话，一条被预算挤掉的关键词条目会把
    // 后面同内容的常驻副本也挡掉（标着常驻的内容整轮消失，调试面板还看不见）
    const fingerprint = `${entry.position}\0${entry.content}`
    if (seen.has(fingerprint)) continue
    if (entry.constant) {
      seen.add(fingerprint)
      kept.push(entry)
      continue
    }
    const cost = loreTokens(entry)
    if (used + cost > maxTokens) {
      dropped.push(entry)
      continue
    }
    seen.add(fingerprint)
    kept.push(entry)
    used += cost
  }
  return { active: kept.sort((a, b) => a.order - b.order), dropped }
}

/** 三层合并：全局 → 角色（含卡内嵌）→ 会话。靠后的层排在后面，同序号时更具体的那层稍后注入。 */
export function mergeLayers(...layers: LoreEntry[][]): LoreEntry[] {
  return layers.flat()
}

// ── ST 世界书导入导出 ────────────────────────────────────────────────

export interface LorebookFile {
  name: string
  entries: LoreEntry[]
}

interface RawLorebookEntry {
  [key: string]: unknown
}

/** 导入 ST 世界书：`{ entries: [] }` 与 `{ entries: { "0": {} } }` 两种都认。 */
export function parseStLorebook(raw: string, name = '导入的世界书'): LorebookFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('不是合法的 JSON')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('世界书格式不对')
  const record = parsed as Record<string, unknown>
  // 有些文件是 { lorebook: {...} }，也顺手剥一层
  const book =
    record['entries'] === undefined && record['lorebook'] && typeof record['lorebook'] === 'object'
      ? (record['lorebook'] as Record<string, unknown>)
      : record
  const rawEntries = book['entries']
  let list: RawLorebookEntry[] = []
  if (Array.isArray(rawEntries)) list = rawEntries as RawLorebookEntry[]
  else if (rawEntries && typeof rawEntries === 'object') {
    list = Object.values(rawEntries as Record<string, unknown>).filter(
      (item): item is RawLorebookEntry => Boolean(item) && typeof item === 'object'
    )
  }
  const entries: LoreEntry[] = []
  list.forEach((item, index) => {
    const entry = entryFromRaw(item, 'global', index)
    if (entry) entries.push(entry)
  })
  const bookName =
    (typeof book['name'] === 'string' && book['name'].trim()) ||
    (typeof record['name'] === 'string' && record['name'].trim()) ||
    name
  return { name: bookName, entries }
}

/**
 * 导出成 ST v2 世界书（字段名与角色卡内嵌的 character_book 一致）。
 * 顶层的 `position` 只有前后两种取值，「@深度」必须同时写进 `extensions.position = 4`
 * ——否则导出再导入，按深度注入历史的条目会静默变成塞进角色设定块。
 */
export function toStLorebook(name: string, entries: LoreEntry[]): string {
  const out = {
    name,
    entries: entries.map((entry, index) => ({
      id: index,
      keys: entry.keys,
      secondary_keys: entry.secondaryKeys,
      comment: entry.name,
      content: entry.content,
      constant: entry.constant,
      selective: entry.selective,
      insertion_order: entry.order,
      enabled: true,
      position: entry.position === 'after_char' ? 'after_char' : 'before_char',
      extensions: {
        depth: entry.depth,
        case_sensitive: entry.caseSensitive,
        position: entry.position === 'depth' ? 4 : entry.position === 'after_char' ? 1 : 0
      }
    }))
  }
  return JSON.stringify(out, null, 2)
}

/**
 * 「世界卡」判断：description 很短、世界书条目却极多（宝可梦那张 153 条、描述只有一句）。
 * 这类卡不是「一个角色」，而是一整个世界 / 剧本，T8 群聊会共用这套判断。
 */
export const WORLD_CARD_MIN_ENTRIES = 40
export const WORLD_CARD_MAX_DESCRIPTION = 400

export function isWorldCard(description: string, loreEntryCount: number): boolean {
  return loreEntryCount >= WORLD_CARD_MIN_ENTRIES && description.trim().length <= WORLD_CARD_MAX_DESCRIPTION
}
