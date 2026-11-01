// 正则清洗的纯逻辑：规则模型、应用（显示 / 提示词两条链路）、从角色卡 extensions 搬运。
//
// 卡里的真实形状（2026-10-25 反推）：
// extensions.piupiu_regex = { enabled, ignoreEmptyReplace, scripts: [Script…] }
// extensions.regex_scripts = [Script…]
// Script = { scriptName, findRegex, replaceString, disabled, markdownOnly, promptOnly,
//            runOnEdit, trimStrings, placement, … }
// markdownOnly → 只影响显示；promptOnly → 只影响发给模型的内容；两者都 false 时两边都过。

export type RegexTarget = 'display' | 'prompt' | 'both'
export type RegexSource = 'card' | 'global' | 'character'

/** ST 的 placement 取值：1 用户输入 / 2 AI 输出 / 3 斜杠命令 / 5 世界书 / 6 推理 */
export const PLACEMENT_USER_INPUT = 1
export const PLACEMENT_AI_OUTPUT = 2

export interface RegexRule {
  id: string
  name: string
  pattern: string
  flags: string
  replacement: string
  target: RegexTarget
  enabled: boolean
  order: number
  source: RegexSource
  readonly: boolean
  /**
   * ST 的 `minDepth` / `maxDepth`：只作用于「距最新消息 N 层」的消息，最新一条是 0。
   * 状态栏卡全靠它把历史消息里的旧面板折叠掉（`minDepth: 1`）——我们不认这两个字段时，
   * 那条折叠规则会把**当前这条**刚生成的状态页也一起删掉，表现是聊完一轮面板没了。
   */
  minDepth?: number | null
  maxDepth?: number | null
  /** ST 的 `placement`：只在这些位置生效。空数组 = 哪都不生效（ST 也是这么判的） */
  placement?: number[]
}

/**
 * 「占位标签 → 状态栏页面」这类规则的 pattern 是一段裸标签（`<StatusPlaceHolderImpl/>`），
 * 替换出来的是一大段 HTML。它们在 ST 里其实**不是正则干的事**：ST 先把正则套在消息原文上，
 * 之后才由 MVU 前端扩展把占位符换成人看的页面。我们若照原序替换，后面那些「删变量块」的
 * 正则会打进模板自己的 JS 里——《龙脊大陆》的 `去除UpdateVariable数据标签` 就是这么把
 * 34KB 状态栏从中间吞掉 5KB 的（模板里 `textContent.match(/<UpdateVariable>…` 那行被当成了
 * 真的变量块起点），表现是聊完一轮面板只剩半截代码。所以这类规则统一挪到最后一批。
 */
const TAG_ONLY_PATTERN = /^<\/?[A-Za-z][\w:.-]*\s*\/?>$/

function isPlaceholderRule(rule: RegexRule): boolean {
  return TAG_ONLY_PATTERN.test(rule.pattern.trim()) && rule.replacement.includes('<')
}

/** `/pattern/gm` 与 `pattern` 两种写法都认（ST 的 findRegex 两种都有）。 */
export function splitRegex(raw: string): { pattern: string; flags: string } {
  const text = raw.trim()
  if (text.startsWith('/')) {
    const last = text.lastIndexOf('/')
    if (last > 0) {
      const flags = text.slice(last + 1)
      // 只认合法的标志字母，避免把路径里的 / 误当分隔符
      if (/^[dgimsuvy]*$/.test(flags)) return { pattern: text.slice(1, last), flags }
    }
  }
  return { pattern: text, flags: 'g' }
}

function mapTarget(markdownOnly: boolean, promptOnly: boolean): RegexTarget {
  if (promptOnly && !markdownOnly) return 'prompt'
  if (markdownOnly && !promptOnly) return 'display'
  return 'both'
}

function ruleFromScript(
  script: Record<string, unknown>,
  source: RegexSource,
  order: number,
  forEditing = false
): RegexRule | null {
  const raw = script['findRegex'] ?? script['find_regex'] ?? script['pattern']
  const disabled = script['disabled'] === true || script['enabled'] === false
  // 编辑面要看得见「被禁用 / 刚加还没填正则」的规则，否则既改不了也开不了；
  // 注入 / 显示链路照旧跳过它们（`applyRegexRules` 还按 enabled 再过一道）
  if (!forEditing) {
    if (typeof raw !== 'string' || !raw.trim()) return null
    if (disabled) return null
  }
  const { pattern, flags } = splitRegex(typeof raw === 'string' ? raw : '')
  const depthOf = (key: string, snake: string): number | null => {
    const value = script[key] ?? script[snake]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  // 卡里也有把 placement 写成数字字符串的（`["2"]`）：只认 number 会让整个数组变成 `[]`，
  // 而 `[]` 是「哪都不生效」，整条规则被静默禁用。数字串按数字收；一个都认不出来
  // 就当这张卡没标位置（照旧全位置生效）——宁可多套一条，也不能少一条
  const rawPlacement = script['placement']
  let placement: number[] | undefined
  if (Array.isArray(rawPlacement)) {
    const nums = rawPlacement
      .map((item) =>
        typeof item === 'number'
          ? item
          : typeof item === 'string' && /^\s*-?\d+\s*$/.test(item)
            ? Number(item)
            : null
      )
      .filter((item): item is number => item !== null)
    placement = nums.length === 0 && rawPlacement.length > 0 ? undefined : nums
  }
  return {
    id: `card:${String(script['id'] ?? order)}`,
    name: typeof script['scriptName'] === 'string' ? script['scriptName'] : `规则 ${order + 1}`,
    pattern,
    flags,
    replacement: typeof script['replaceString'] === 'string' ? script['replaceString'] : '',
    target: mapTarget(script['markdownOnly'] === true, script['promptOnly'] === true),
    enabled: forEditing ? !disabled : true,
    order,
    source,
    readonly: true,
    minDepth: depthOf('minDepth', 'min_depth'),
    maxDepth: depthOf('maxDepth', 'max_depth'),
    placement
  }
}

/**
 * 从角色卡 extensions 里搬正则（只搬运与展示，不执行卡里的脚本）。
 * `regex_scripts` 优先；`piupiu_regex.scripts` 补上它没有的（两者常是同一份）。
 * `forEditing`：编辑面用，禁用的和还没填正则的也一并列出来（默认跳过）。
 */
export function readCardRegexes(
  rawData?: Record<string, unknown> | null,
  options: { forEditing?: boolean } = {}
): RegexRule[] {
  const extensions = rawData?.['extensions']
  if (!extensions || typeof extensions !== 'object') return []
  const ext = extensions as Record<string, unknown>

  const scripts: Record<string, unknown>[] = []
  const direct = ext['regex_scripts']
  if (Array.isArray(direct)) {
    for (const item of direct) if (item && typeof item === 'object') scripts.push(item as Record<string, unknown>)
  }
  const wrapped = ext['piupiu_regex']
  if (wrapped && typeof wrapped === 'object') {
    const holder = wrapped as Record<string, unknown>
    if (holder['enabled'] !== false && Array.isArray(holder['scripts'])) {
      for (const item of holder['scripts']) {
        if (item && typeof item === 'object') scripts.push(item as Record<string, unknown>)
      }
    }
  }

  const seen = new Set<string>()
  const rules: RegexRule[] = []
  scripts.forEach((script, index) => {
    const rule = ruleFromScript(script, 'card', index, options.forEditing === true)
    if (!rule) return
    if (seen.has(rule.id)) return
    seen.add(rule.id)
    rules.push(rule)
  })
  return rules
}

export interface RegexFailure {
  rule: RegexRule
  error: string
}

/**
 * 编译规则。没有 `g` 时补上——ST 自己也是这么做的（`regex.flags + 'g'`），
 * 而 `String.replace` 不带 g 只换第一处，卡里 `/…/i` 这类写法会每段只洗掉一个匹配。
 */
export function compileRule(rule: RegexRule): RegExp | null {
  try {
    // 全局 / 角色规则的 pattern 也有用户按 ST 习惯填成 `/…/flags` 的：
    // 不拆开的话斜杠会进正则本体，永远 0 命中，而且不报错。
    // flags 仍以界面上那个输入框为准（`splitRegex` 只借用它的 pattern 部分）
    const { pattern } = splitRegex(rule.pattern)
    const flags = rule.flags.includes('g') ? rule.flags : `${rule.flags}g`
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

/**
 * 依次套用规则。单条写错（正则不合法）只跳过它，不让整段正文消失。
 * `target` 传 'display' / 'prompt'，规则自己的 target 为 'both' 时两边都生效。
 *
 * `options.depth` 是这条消息距最新一条的层数（最新 = 0），带 `minDepth` / `maxDepth`
 * 的规则只在区间内生效（ST 的语义）。不传就没有深度信息，这类规则一律不套——
 * 「折叠历史状态栏」那种规则误套到最新消息上，会把刚生成的状态页整段删掉。
 * `options.placement` 同理（1 用户输入 / 2 AI 输出），规则标了 placement 却不在其中就跳过，
 * 不传位置信息时这类规则一样不套。
 */
export function applyRegexRules(
  text: string,
  rules: RegexRule[],
  target: 'display' | 'prompt',
  failures: RegexFailure[] = [],
  options: { depth?: number; placement?: number } = {}
): string {
  let out = text
  const ordered = [...rules].sort((a, b) => a.order - b.order)
  // 普通规则先跑，占位标签替换（状态栏页面）留到最后一轮（见 isPlaceholderRule）
  const passes = [ordered.filter((rule) => !isPlaceholderRule(rule)), ordered.filter(isPlaceholderRule)]
  for (const list of passes) {
    for (const rule of list) {
      if (!rule.enabled) continue
      if (rule.target !== 'both' && rule.target !== target) continue
      // 空 pattern 编出来是 `/(?:)/g`，会在每个字符边界命中：编辑面「新加还没填正则」的规则
      // 正是 pattern 空着、替换文本先填好的，一旦放它过去，正文和发给模型的提示词会被逐字打碎
      if (!rule.pattern.trim()) continue
      if (typeof rule.minDepth === 'number' || typeof rule.maxDepth === 'number') {
        // 没有深度信息时不套：宁可少折叠一行历史，也不能删掉当前这条的状态页
        if (typeof options.depth !== 'number') continue
        if (typeof rule.minDepth === 'number' && options.depth < rule.minDepth) continue
        if (typeof rule.maxDepth === 'number' && options.depth > rule.maxDepth) continue
      }
      // 标了 placement 就只在列出的位置生效，`[]` 是「哪都不生效」。**没有位置信息时同样不套**：
      // 预览（`tavern:regex-preview`）不传 options，若这时放行 `[3]`（只在斜杠命令生效）的规则，
      // 用户看到的预览效果和真正聊天里的效果就对不上了
      if (Array.isArray(rule.placement)) {
        if (typeof options.placement !== 'number' || !rule.placement.includes(options.placement)) continue
      }
      const regex = compileRule(rule)
      if (!regex) {
        failures.push({ rule, error: '正则不合法' })
        continue
      }
      out = out.replace(regex, rule.replacement)
    }
  }
  return out
}

/** 正则测试页的「实时对比」：同时给出命中数与结果。 */
export function testRegex(rule: RegexRule, text: string): {
  ok: boolean
  error?: string
  hits: number
  result: string
} {
  const regex = compileRule(rule)
  if (!regex) return { ok: false, error: '正则不合法', hits: 0, result: text }
  // 计数与替换用同一个正则（compile 已补 g），预览结果和实际套用一致
  let hits = 0
  try {
    hits = [...text.matchAll(regex)].length
  } catch {
    hits = 0
  }
  return { ok: true, hits, result: text.replace(regex, rule.replacement) }
}
