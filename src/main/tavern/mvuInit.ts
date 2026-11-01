// 卡里的 `[initvar]` 世界书条目是变量系统的初始值（YAML 子集）。
// 酒馆里由变量扩展在开场时把它读成 `stat_data`；不做这一步，卡自带的状态栏
// 一进来就全是 N/A——它的 HTML 是通过 getAllVariables().stat_data 取数的。
//
// 只解析卡里实际会出现的形状：缩进嵌套的 `键: 值`、`{}` / `[]`、数字与布尔。
// 块标量（`|`）只有「变量更新规则」那类提示词条目在用，不属于初始值。
import type { MvuState } from './mvu'

function scalar(raw: string): unknown {
  const text = raw.trim()
  if (text === '{}') return {}
  if (text === '[]') return []
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  // 引号包起来的按原样（去掉引号），别把 "007" 变成 7
  if (/^(['"]).*\1$/.test(text)) return text.slice(1, -1)
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  return text
}

/** 缩进嵌套的 YAML 子集 → 对象。解析不了的行直接跳过，不抛错。 */
export function parseInitVars(content: string): MvuState {
  const root: Record<string, unknown> = {}
  const stack: { indent: number; node: Record<string, unknown> }[] = [{ indent: -1, node: root }]
  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue
    const line = rawLine.replace(/\t/g, '  ')
    const indent = line.length - line.trimStart().length
    const text = line.trim()
    const colon = text.indexOf(':')
    if (colon <= 0) continue
    const key = text.slice(0, colon).trim()
    const rest = text.slice(colon + 1).trim()
    // 回到这一层的父节点（比当前缩进浅的那一个）
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop()
    const parent = stack[stack.length - 1]!.node
    if (rest === '') {
      const child: Record<string, unknown> = {}
      parent[key] = child
      stack.push({ indent, node: child })
    } else {
      parent[key] = scalar(rest)
    }
  }
  return root
}

/**
 * 从卡里找 `[initvar]` 条目并解析成初始变量。
 * **不能用 `readCardEntries`**：初始值条目在卡里正是 `enabled: false` 的（不去污染提示词），
 * 读侧会把它过滤掉。没有任何初始值条目时返回 null。
 */
export function readInitVars(
  rawData?: Record<string, unknown> | null,
  names?: { char: string; user: string }
): MvuState | null {
  const book = rawData?.['character_book']
  if (!book || typeof book !== 'object') return null
  const entries = (book as Record<string, unknown>)['entries']
  if (!Array.isArray(entries)) return null

  for (const item of entries) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const comment = typeof entry['comment'] === 'string' ? entry['comment'] : ''
    if (!comment.trim().toLowerCase().startsWith('[initvar')) continue
    const content = typeof entry['content'] === 'string' ? entry['content'] : ''
    if (!content.trim()) continue
    const state = parseInitVars(content)
    if (Object.keys(state).length === 0) continue
    return names ? substituteNames(state, names) : state
  }
  return null
}

/** 初始值里写着 `{{user}}`（「青云宗月珑峰-{{user}}的房间」），换成真名再存 */
function substituteNames(state: MvuState, names: { char: string; user: string }): MvuState {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(/\{\{\s*char\s*\}\}/gi, names.char).replace(/\{\{\s*user\s*\}\}/gi, names.user)
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = walk(item)
      return out
    }
    return value
  }
  return walk(state) as MvuState
}
