// 卡内嵌世界书 / 正则的原地编辑（纯逻辑）。
//
// 卡才是这些数据的家：改完必须写回 characters.data_json，导出时才带着新内容走。
// 这里只认 ST 的原始形状，其余字段（probability / use_regex / placement…）原样保留——
// 用户没编辑的东西不该因为我们存了一次就消失。
import { randomUUID } from 'node:crypto'
import type { RegexRule } from './regexEngine'
import type { LorePosition } from './worldbook'

type Raw = Record<string, unknown>

export interface CardLoreInput {
  id?: string
  name: string
  keys: string[]
  secondaryKeys: string[]
  content: string
  constant: boolean
  selective: boolean
  position: LorePosition
  depth: number
  order: number
  caseSensitive: boolean
}

function extensionsOf(entry: Raw): Raw {
  const current = entry['extensions']
  const next = current && typeof current === 'object' ? { ...(current as Raw) } : {}
  entry['extensions'] = next
  return next
}

function entriesOf(data: Raw): Raw[] | null {
  const book = data['character_book']
  if (!book || typeof book !== 'object') return null
  const raw = (book as Raw)['entries']
  return Array.isArray(raw) ? (raw as Raw[]) : null
}

function ensureEntries(data: Raw): Raw[] {
  const existing = entriesOf(data)
  if (existing) return existing
  const book = (data['character_book'] as Raw | undefined) ?? {}
  data['character_book'] = book
  const list: Raw[] = []
  book['entries'] = list
  return list
}

/** 与 readCardEntries 同一套 id 算法，改的就是界面上看到的那一条 */
function entryKey(entry: Raw, index: number): string {
  return `card:${String(entry['id'] ?? entry['uid'] ?? index)}`
}

/** 把界面字段写进 ST 原始条目：@深度 同时写 extensions.position = 4（顶层只有前 / 后）。 */
function applyLore(entry: Raw, input: CardLoreInput): void {
  entry['comment'] = input.name
  entry['keys'] = input.keys
  entry['secondary_keys'] = input.secondaryKeys
  entry['content'] = input.content
  entry['constant'] = input.constant
  entry['selective'] = input.selective
  entry['insertion_order'] = input.order
  entry['enabled'] = true
  delete entry['disable']
  entry['position'] = input.position === 'after_char' ? 'after_char' : 'before_char'
  const extensions = extensionsOf(entry)
  extensions['depth'] = input.depth
  extensions['case_sensitive'] = input.caseSensitive
  extensions['position'] = input.position === 'depth' ? 4 : input.position === 'after_char' ? 1 : 0
}

/** 新建 / 覆盖一条卡内嵌世界书条目，返回条目 id（`card:…`）。 */
export function upsertCardLore(data: Raw, input: CardLoreInput): string {
  const entries = ensureEntries(data)
  if (input.id) {
    const index = entries.findIndex((entry, at) => entryKey(entry, at) === input.id)
    if (index >= 0) {
      applyLore(entries[index]!, input)
      return input.id
    }
  }
  // 新条目：避开卡里已有的数字 id，别让两条撞成同一个 key。
  // 没写 id 的条目 key 是 `card:下标`（entryKey 的口径），它的下标号同样被占着，
  // 不算进来的话新建条目会取到同号，之后改/删会落到那条老条目上
  const used = new Set(
    entries
      .map((entry, at) => Number(entry['id'] ?? entry['uid'] ?? at))
      .filter((id) => Number.isFinite(id))
  )
  let next = 0
  while (used.has(next)) next++
  const created: Raw = { id: next }
  applyLore(created, input)
  entries.push(created)
  return entryKey(created, entries.length - 1)
}

export function removeCardLore(data: Raw, entryId: string): boolean {
  const entries = entriesOf(data)
  if (!entries) return false
  const index = entries.findIndex((entry, at) => entryKey(entry, at) === entryId)
  if (index < 0) return false
  entries.splice(index, 1)
  return true
}

// ── 正则 ─────────────────────────────────────────────────────────────

/** 卡里同一份脚本常同时躺在 regex_scripts 与 piupiu_regex.scripts，两处都要改。 */
function scriptLists(data: Raw): Raw[][] {
  const extensions = data['extensions']
  if (!extensions || typeof extensions !== 'object') return []
  const ext = extensions as Raw
  const lists: Raw[][] = []
  if (Array.isArray(ext['regex_scripts'])) lists.push(ext['regex_scripts'] as Raw[])
  const wrapped = ext['piupiu_regex']
  if (wrapped && typeof wrapped === 'object' && Array.isArray((wrapped as Raw)['scripts'])) {
    lists.push((wrapped as Raw)['scripts'] as Raw[])
  }
  return lists
}

function scriptKey(script: Raw, index: number): string {
  return `card:${String(script['id'] ?? index)}`
}

interface ScriptRef {
  list: Raw[]
  script: Raw
  /** 在**自己那个数组**里的下标（删除时用它 splice） */
  index: number
  key: string
}

/**
 * 两份脚本数组拼成一条、按拼接顺序连续编号。
 * **编号口径必须与 `regexEngine.readCardRegexes` 完全一致**（那边也是先 regex_scripts 再
 * piupiu_regex.scripts 顺次数的）：各自从 0 数的话，后一个数组里没写 `id` 的脚本 id 会整体
 * 错位——改一条会新造一条副本、删一条则静默无效（列表下次刷新又回来）。
 */
function scriptRefs(data: Raw): ScriptRef[] {
  const refs: ScriptRef[] = []
  for (const list of scriptLists(data)) {
    list.forEach((script, index) => {
      refs.push({ list, script, index, key: scriptKey(script, refs.length) })
    })
  }
  return refs
}

/** findRegex 保持原来的写法：ST 里 `/…/gm` 与裸 pattern 都很常见。 */
function formatFind(original: unknown, rule: RegexRule): string {
  const text = typeof original === 'string' ? original : ''
  // 原文是 `/…/flags` 的照旧拼回去；裸 pattern 只有 flags 不是默认的 g 时才补成
  // `/…/flags`——否则界面上的 flags 输入框改了半天，落库只有 pattern，改动静默丢失
  if (text.trim().startsWith('/') || rule.flags !== 'g') {
    return `/${rule.pattern}/${rule.flags}`
  }
  return rule.pattern
}

function applyRegex(script: Raw, rule: RegexRule): void {
  script['scriptName'] = rule.name
  script['findRegex'] = formatFind(script['findRegex'], rule)
  script['replaceString'] = rule.replacement
  script['disabled'] = !rule.enabled
  script['markdownOnly'] = rule.target === 'display'
  script['promptOnly'] = rule.target === 'prompt'
}

/** 新建 / 覆盖一条卡内嵌正则；返回规则 id。 */
export function upsertCardRegex(data: Raw, rule: RegexRule): string {
  const lists = scriptLists(data)
  let hit = false
  for (const ref of scriptRefs(data)) {
    if (ref.key !== rule.id) continue
    hit = true
    applyRegex(ref.script, rule)
  }
  if (hit) return rule.id

  // 新规则：有 regex_scripts 就写进去；没有就建一个 piupiu_regex.scripts
  if (lists.length === 0) {
    const extensions = (data['extensions'] as Raw | undefined) ?? {}
    data['extensions'] = extensions
    const holder = (extensions['piupiu_regex'] as Raw | undefined) ?? { enabled: true, scripts: [] }
    extensions['piupiu_regex'] = holder
    if (!Array.isArray(holder['scripts'])) holder['scripts'] = []
    lists.push(holder['scripts'] as Raw[])
  }
  const id = randomUUID()
  const created: Raw = { id }
  applyRegex(created, rule)
  for (const list of lists) list.push({ ...created })
  return `card:${id}`
}

export function removeCardRegex(data: Raw, ruleId: string): boolean {
  const hits = scriptRefs(data).filter((ref) => ref.key === ruleId)
  if (hits.length === 0) return false
  // 同一个数组里可能有多条命中：从后往前删，别让前面的下标移位
  for (const ref of hits.sort((a, b) => b.index - a.index)) ref.list.splice(ref.index, 1)
  return true
}
