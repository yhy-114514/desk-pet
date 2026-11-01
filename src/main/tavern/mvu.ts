// 变量系统（MVU / MagVarUpdate）的纯逻辑。
//
// 真实卡的做法：让模型在回复末尾输出一段更新块
//   单角色卡： <update><json_patch>[…]</json_patch></update>
//   多角色卡： <UpdateVariable>…</UpdateVariable> / <status_description>…</status_description>
// 内容是 RFC 6902 JSON Patch（add / replace / remove），前端把它应用到状态对象上，
// 再渲染成状态栏。这一块既不该出现在正文里，也不该念出来，所以显示前要洗掉。
//
// 这里只做「解析 + 应用 + 格式化」；状态落库在 variableStore.ts。

export interface JsonPatchOp {
  op: 'add' | 'replace' | 'remove' | 'test'
  path: string
  value?: unknown
}

export type MvuState = Record<string, unknown>

// 标签名大小写、带不带属性都得认：模型会写 `<UPDATE>`、`<update >`，
// `<json_patch version="1">` 也不是没出现过。写死成 `<update>` 的话，
// 闭合块洗不掉（整段 JSON 进正文给用户看），兜底的截断正则反而把它连同
// 标签之后的正常正文一起删掉
// 闭合标签也可能带空格（`</update >`），`<\/\1>` 认不出时整段 ops 会静默丢失
const UPDATE_TAG = /<(update|UpdateVariable)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi
const STATUS_TAG = /<status_description\b[^>]*>[\s\S]*?<\/status_description\s*>/gi
const JSON_PATCH_TAG = /<json_patch\b[^>]*>([\s\S]*?)<\/json_patch\s*>/gi

/** 逐个抠出顶层 `{…}` 片段。不能靠非贪婪正则：value 是对象时会在第一个 `}` 处截断。 */
export function objectChunks(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      // JSON 只认双引号：正文里的撇号不能当字符串起点，否则后面的对象一个都抠不出来
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) depth--
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

/** 从更新块里抠出 JSON Patch 数组；容错：围栏、多余说明、逐个对象一行一项。 */
export function parsePatch(raw: string): JsonPatchOp[] {
  const text = raw.trim()
  if (!text) return []
  // 只有当开头就是 `[` 时才按数组整体解析。按 `indexOf('[')` 找的话，
  // `{"op":"add","path":"/背包","value":["药"]}` 会从 value 的方括号开始截，
  // 截出来的 `["药"]` 恰好是合法数组 → 整批 ops 被当成垃圾丢掉
  if (text.startsWith('[')) {
    const end = text.lastIndexOf(']')
    if (end > 0) {
      try {
        const parsed: unknown = JSON.parse(text.slice(0, end + 1))
        if (Array.isArray(parsed)) return normalizeOps(parsed)
      } catch {
        // 落到下面的逐条解析
      }
    }
  }
  // 有些卡一处一块：{"op":"replace","path":"/x","value":{"a":1}}
  const ops: JsonPatchOp[] = []
  for (const chunk of objectChunks(text)) {
    try {
      const parsed: unknown = JSON.parse(chunk)
      if (parsed && typeof parsed === 'object') ops.push(...normalizeOps([parsed]))
    } catch {
      // 忽略解析不了的那一段
    }
  }
  return ops
}

export function normalizeOps(list: unknown[]): JsonPatchOp[] {
  const ops: JsonPatchOp[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const op = record['op']
    const path = record['path']
    if (
      (op !== 'add' && op !== 'replace' && op !== 'remove' && op !== 'test') ||
      typeof path !== 'string'
    )
      continue
    ops.push({ op, path, value: record['value'] })
  }
  return ops
}

/**
 * 把回复里的更新块 / 状态描述洗掉，返回干净正文与解析出的 ops。
 * 没闭合的块（模型被截断）也整段丢弃——宁可少一条变量，也别把半截 JSON 漏进正文。
 */
export function extractUpdates(raw: string): { text: string; ops: JsonPatchOp[] } {
  const ops: JsonPatchOp[] = []
  for (const match of raw.matchAll(UPDATE_TAG)) {
    const body = match[2] ?? ''
    const patchMatch = [...body.matchAll(JSON_PATCH_TAG)]
    if (patchMatch.length > 0) {
      for (const patch of patchMatch) ops.push(...parsePatch(patch[1] ?? ''))
    } else {
      ops.push(...parsePatch(body))
    }
  }
  // 没套 <update> 壳的裸 <json_patch> 也有卡在用：上面抠不到 ops，
  // 而下面照样把它从正文里洗掉——变量就永远不更新，还查不出原因
  if (ops.length === 0) {
    for (const patch of raw.matchAll(JSON_PATCH_TAG)) ops.push(...parsePatch(patch[1] ?? ''))
  }
  let text = raw
    .replace(UPDATE_TAG, '')
    .replace(STATUS_TAG, '')
    // 截断时只剩开标签：把开头那半截一直剥到结尾
    .replace(/<(update|UpdateVariable|status_description)\b[^>]*>[\s\S]*$/i, '')
  text = text.replace(/<json_patch\b[^>]*>[\s\S]*?<\/json_patch\s*>/gi, '')
  return { text: text.trim(), ops }
}

/** 显示前要洗掉的标签（MVU 关闭时也洗——这些本来就不该给用户看）。 */
export function stripUpdateTags(text: string): string {
  return extractUpdates(text).text
}

const UPDATE_TAGS = ['update', 'UpdateVariable', 'status_description']

/**
 * 流式时末尾可能只到了半个标签（`<upd`），先扣住不发给界面，
 * 等下一块拼完整再判断——否则用户会看到 `<upd` 闪一下又消失。
 */
export function holdPartialTag(text: string): string {
  const match = text.match(/<([A-Za-z_]*)$/)
  if (!match) return text
  const fragment = match[1] ?? ''
  // 标签清洗是大小写不敏感的（模型会写 `<UPD`），扣留也得跟着不敏感，
  // 否则半截大写标签会先漏到界面上再消失
  const lower = fragment.toLowerCase()
  const maybeTag = UPDATE_TAGS.some((tag) => tag.toLowerCase().startsWith(lower))
  return maybeTag ? text.slice(0, match.index) : text
}

function decodePath(path: string): string[] {
  return path
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
}

/** 读 path 处的当前值（`test` 用）。路径不存在返回 undefined。 */
function readPath(root: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = root
  for (const key of decodePath(path)) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

/** JSON 语义的深比较（键顺序无关）。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => sameValue(item, b[index]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every((key) => sameValue(left[key], right[key]))
  }
  return false
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = clone(item)
    return out
  }
  return value
}

/**
 * 应用 JSON Patch（只支持 add / replace / remove）。
 * 返回新对象，不改入参——调用方要落库，入参还可能是缓存里的旧状态。
 */
export function applyJsonPatch(state: MvuState, ops: JsonPatchOp[]): MvuState {
  const root = clone(state) as Record<string, unknown>
  // RFC 6902 的 `test` 是守卫：不通过时整个 patch 都不该生效。
  // 原先直接把它丢掉、后面的 remove / replace 照跑，等于把「先确认再改」变成「直接改」
  for (const op of ops) {
    if (op.op === 'test' && !sameValue(readPath(root, op.path), op.value)) return root
  }
  let cursor: Record<string, unknown> | unknown[] = root

  for (const op of ops) {
    // test 已在上面整批判定过了，别再走写入分支
    if (op.op === 'test') continue
    const parts = decodePath(op.path)
    if (parts.length === 0) continue
    // 逐层建出中间对象：卡里的 patch 常常只写最终路径
    cursor = root
    let ok = true
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]!
      const next = (cursor as Record<string, unknown>)[key]
      if (next === undefined) {
        // remove 一个不存在的路径：什么都不用做
        if (op.op === 'remove') {
          ok = false
          break
        }
        ;(cursor as Record<string, unknown>)[key] = {}
      } else if (typeof next !== 'object' || next === null) {
        // 路径中间是个标量：替换成对象再往下走（比整条丢弃更接近作者意图）
        if (op.op === 'remove') {
          ok = false
          break
        }
        ;(cursor as Record<string, unknown>)[key] = {}
      }
      cursor = (cursor as Record<string, unknown>)[key] as Record<string, unknown> | unknown[]
    }
    if (!ok) continue
    const last = parts[parts.length - 1]!
    if (Array.isArray(cursor)) {
      const index = last === '-' ? cursor.length : Number(last)
      if (!Number.isInteger(index) || index < 0) continue
      // 越界不硬写：`replace` 打到不存在的下标会撑长数组并留下空洞，
      // 状态栏就会出现「1、2、、、、x」这种垃圾。add 允许等于长度（追加）
      if (index > cursor.length) continue
      if (op.op === 'remove') cursor.splice(index, 1)
      else if (op.op === 'add') cursor.splice(index, 0, clone(op.value))
      else if (index < cursor.length) cursor[index] = clone(op.value)
      continue
    }
    if (op.op === 'remove') delete (cursor as Record<string, unknown>)[last]
    else (cursor as Record<string, unknown>)[last] = clone(op.value)
  }
  return root
}

/** 把状态对象压成「父/子: 值」的展示行（最多下钻 3 层，状态栏放不下太深的东西）。 */
export function formatStatus(state: MvuState, maxDepth = 3): string[] {
  const lines: string[] = []
  const walk = (value: unknown, prefix: string, depth: number): void => {
    if (value === null || value === undefined) {
      if (prefix) lines.push(`${prefix}: —`)
      return
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      if (depth > 0) {
        const entries = Object.entries(value as Record<string, unknown>)
        if (entries.length === 0) {
          if (prefix) lines.push(`${prefix}: （空）`)
          return
        }
        const label = prefix ? `${prefix}/` : ''
        for (const [key, item] of entries) walk(item, `${label}${key}`, depth - 1)
        return
      }
      // 到了深度上限还是个对象：压成一行 JSON，别把 [object Object] 摆给用户看
      lines.push(`${prefix}: ${JSON.stringify(value)}`)
      return
    }
    if (Array.isArray(value)) {
      const text = value
        .map((item) => (item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item)))
        .join('、')
      lines.push(`${prefix}: ${text || '（空）'}`)
      return
    }
    lines.push(`${prefix}: ${String(value)}`)
  }
  for (const [key, value] of Object.entries(state)) walk(value, key, maxDepth - 1)
  return lines
}
