// 鲸鱼娘「诊断并修复」用的结构化修复指令。
//
// 模型在 JSON 模式下返回的 fix 是不可信输入：落到写库之前必须先过 validateCardFix，
// 字段名是白名单、正则必须能编译、类型必须对得上。任何一条不合规就整条拒掉，
// 绝不「尽量猜一猜」——写坏一张卡比不修更糟。

export type CardFixField =
  | 'description'
  | 'personality'
  | 'scenario'
  | 'firstMes'
  | 'systemPrompt'
  | 'postHistoryInstructions'
  | 'mesExample'

export interface RegexFixPatch {
  name?: string
  pattern?: string
  flags?: string
  replacement?: string
  target?: 'display' | 'prompt' | 'both'
  enabled?: boolean
}

export interface LoreFixPatch {
  name?: string
  keys?: string[]
  secondaryKeys?: string[]
  content?: string
  constant?: boolean
  selective?: boolean
  position?: 'before_char' | 'after_char' | 'depth'
  depth?: number
  order?: number
  caseSensitive?: boolean
}

export type CardFix =
  | { type: 'regex'; ruleId?: string; patch?: RegexFixPatch; remove?: boolean }
  | { type: 'lore'; entryId?: string; patch?: LoreFixPatch; remove?: boolean }
  | { type: 'field'; field: CardFixField; value: string }

/** 体检结果的一条。fix 为 null = 只提示、不自动改。 */
export interface CardIssue {
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
  fix: CardFix | null
}

export const CARD_FIX_FIELDS: CardFixField[] = [
  'description',
  'personality',
  'scenario',
  'firstMes',
  'systemPrompt',
  'postHistoryInstructions',
  'mesExample'
]

const REGEX_TARGETS = ['display', 'prompt', 'both']
const LORE_POSITIONS = ['before_char', 'after_char', 'depth']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`修复指令里的 ${name} 不是字符串`)
  return value
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`修复指令里的 ${name} 不是布尔值`)
  return value
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`修复指令里的 ${name} 不是数字`)
  return value
}

function optionalStringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`修复指令里的 ${name} 不是字符串数组`)
  }
  return value as string[]
}

function parseRegexPatch(raw: unknown): RegexFixPatch {
  if (raw === undefined || raw === null) return {}
  if (!isPlainObject(raw)) throw new Error('正则修复的 patch 不是对象')
  const patch: RegexFixPatch = {}
  const name = optionalString(raw['name'], 'name')
  if (name !== undefined) patch.name = name
  const pattern = optionalString(raw['pattern'], 'pattern')
  if (pattern !== undefined) {
    // 能不能编译直接在这里判掉：写进卡里再发现是坏正则，用户只会看到「卡又不对了」
    try {
      new RegExp(pattern)
    } catch {
      throw new Error(`修复后的正则不合法：${pattern}`)
    }
    patch.pattern = pattern
  }
  const flags = optionalString(raw['flags'], 'flags')
  if (flags !== undefined) {
    if (!/^[dgimsuvy]*$/.test(flags)) throw new Error(`修复后的正则标志不合法：${flags}`)
    patch.flags = flags
  }
  const replacement = optionalString(raw['replacement'], 'replacement')
  if (replacement !== undefined) patch.replacement = replacement
  const enabled = optionalBoolean(raw['enabled'], 'enabled')
  if (enabled !== undefined) patch.enabled = enabled
  const target = raw['target']
  if (target !== undefined && target !== null) {
    if (typeof target !== 'string' || !REGEX_TARGETS.includes(target)) {
      throw new Error(`修复指令里的 target 不合法：${String(target)}`)
    }
    patch.target = target as RegexFixPatch['target']
  }
  return patch
}

function parseLorePatch(raw: unknown): LoreFixPatch {
  if (raw === undefined || raw === null) return {}
  if (!isPlainObject(raw)) throw new Error('世界书修复的 patch 不是对象')
  const patch: LoreFixPatch = {}
  const name = optionalString(raw['name'], 'name')
  if (name !== undefined) patch.name = name
  const values: [keyof LoreFixPatch, unknown, string][] = [
    ['keys', raw['keys'], 'keys'],
    ['secondaryKeys', raw['secondaryKeys'], 'secondaryKeys'],
    ['content', raw['content'], 'content']
  ]
  for (const [key, value, label] of values) {
    if (key === 'keys' || key === 'secondaryKeys') {
      const list = optionalStringList(value, label)
      if (list !== undefined) (patch as Record<string, unknown>)[key] = list
    } else {
      const text = optionalString(value, label)
      if (text !== undefined) (patch as Record<string, unknown>)[key] = text
    }
  }
  const constant = optionalBoolean(raw['constant'], 'constant')
  if (constant !== undefined) patch.constant = constant
  const selective = optionalBoolean(raw['selective'], 'selective')
  if (selective !== undefined) patch.selective = selective
  const caseSensitive = optionalBoolean(raw['caseSensitive'], 'caseSensitive')
  if (caseSensitive !== undefined) patch.caseSensitive = caseSensitive
  const depth = optionalNumber(raw['depth'], 'depth')
  if (depth !== undefined) patch.depth = depth
  const order = optionalNumber(raw['order'], 'order')
  if (order !== undefined) patch.order = order
  const position = raw['position']
  if (position !== undefined && position !== null) {
    if (typeof position !== 'string' || !LORE_POSITIONS.includes(position)) {
      throw new Error(`修复指令里的 position 不合法：${String(position)}`)
    }
    patch.position = position as LoreFixPatch['position']
  }
  return patch
}

/**
 * 按 id 找卡里的正则 / 世界书条目。模型给的 id 常把 `card:` 前缀抄丢，两种写法都认。
 * 找不到就是找不到：调用方必须报错，绝不能当成「新建一条」——那会在卡里静默长出重复的一条。
 * 主进程执行修复与渲染层的「改动前后」预览必须用同一个判据，否则预览和实际改动对不上。
 */
export function findCardItem<T extends { id: string }>(items: T[], id: string | undefined): T | undefined {
  if (!id) return undefined
  return items.find((item) => item.id === id) ?? items.find((item) => item.id === `card:${id}`)
}

/** 把模型返回的（不可信的）fix 校验成一个可以安全执行的 CardFix。 */
export function validateCardFix(raw: unknown): CardFix {
  if (!isPlainObject(raw)) throw new Error('修复指令不是对象')
  const type = raw['type']
  if (type === 'regex') {
    const fix: CardFix = { type: 'regex', patch: parseRegexPatch(raw['patch']) }
    const ruleId = optionalString(raw['ruleId'], 'ruleId')
    if (ruleId !== undefined) fix.ruleId = ruleId
    const remove = optionalBoolean(raw['remove'], 'remove')
    if (remove !== undefined) fix.remove = remove
    if (!fix.ruleId && !fix.remove) {
      // 新建一条正则要先有完整的 pattern；没 id 又没在 remove，只能是新增
      if (!fix.patch?.pattern) throw new Error('新增正则的修复指令缺少 pattern')
    }
    return fix
  }
  if (type === 'lore') {
    const fix: CardFix = { type: 'lore', patch: parseLorePatch(raw['patch']) }
    const entryId = optionalString(raw['entryId'], 'entryId')
    if (entryId !== undefined) fix.entryId = entryId
    const remove = optionalBoolean(raw['remove'], 'remove')
    if (remove !== undefined) fix.remove = remove
    if (!fix.entryId && !fix.remove && !fix.patch?.content) {
      throw new Error('新增世界书条目的修复指令缺少 content')
    }
    return fix
  }
  if (type === 'field') {
    const field = raw['field']
    if (typeof field !== 'string' || !CARD_FIX_FIELDS.includes(field as CardFixField)) {
      throw new Error(`修复指令里的字段名不合法：${String(field)}`)
    }
    const value = raw['value']
    if (typeof value !== 'string') throw new Error('字段修复的 value 不是字符串')
    return { type: 'field', field: field as CardFixField, value }
  }
  throw new Error(`未知的修复类型：${String(type)}`)
}
