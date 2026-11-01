// 把「预设 + 角色卡 + 世界书 + 用户人设 + 文风 + 历史」装配成一段 messages。
// 纯函数，不碰 DB / 网络。
//
// 有预设时按预设的 prompt_order 排布（markers 决定卡字段插在哪个占位点，
// 见 TAVERN_ROADMAP §四·二）；没预设就退回 T2 的直通模板——两条路都归这一个函数，
// 调用方只交参数。
import { estimateTokens } from '../chat/session'
import { applyMacros, isMarkerId, orderedPrompts, type PresetData } from './preset'
import {
  activateLore as activateLoreEntries,
  readCardEntries,
  type LoreActivation,
  type LoreEntry,
  type LoreSource
} from './worldbook'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 装配只需要卡上这几个字段（不含 id / 立绘那些） */
export interface PromptCard {
  name: string
  description: string
  personality: string
  scenario: string
  mesExample: string
  systemPrompt: string
  postHistoryInstructions: string
}

export interface PromptProfile {
  name: string
  description: string
}

/** 调试面板用的一行：哪一段、多少 token */
export interface PromptPiece {
  label: string
  source: string
  tokens: number
}

export interface PromptDebug {
  pieces: PromptPiece[]
  loreActive: { name: string; source: LoreSource; position: string; tokens: number }[]
  loreDropped: { name: string; source: LoreSource; tokens: number }[]
  historyCount: number
  historyTokens: number
  totalTokens: number
  presetName: string | null
}

export interface BuildPromptInput {
  card: PromptCard
  profile: PromptProfile
  /** 当前分支上的历史（不含本轮用户输入） */
  history: ChatMessage[]
  userText: string
  /** 卡里那份原始 data（没有 lore 时从 data.character_book 读世界书） */
  rawData?: Record<string, unknown> | null
  /** 三层合并后的世界书条目（优先于 rawData） */
  lore?: LoreEntry[]
  /** 关键词条目的 token 预算（常驻不计） */
  loreBudget?: number
  /** 世界书扫描最近几条历史 */
  scanDepth?: number
  /** 历史 + 世界书的 token 预算 */
  budget?: number
  /** 忆境典藏（已格式化的前情提要），插在角色设定之后 */
  dossier?: string
  /** 永久记忆（已格式化的记忆上下文），插在档案之后 */
  memoryContext?: string
  /** 回忆视界：只带最近 N 条历史；不给就是不限条数 */
  recentLimit?: number
  /** 完整视界：不按 token 预算裁剪历史 */
  fullVision?: boolean
  /** 文风指令 */
  styleText?: string
  /** 变量状态（statusInPrompt 打开时注入） */
  statusText?: string
  /**
   * 当前变量的文本形态，用来替换卡里 `{{format_message_variable::stat_data}}`
   * / `{{get_message_variable::stat_data}}`。**和 statusText 是两回事**：
   * statusText 是「额外再补一段」，这里填的是卡自己的条目主动要的实时状态
   */
  statData?: string
  /** 额外指令（御言篇幅等） */
  instructions?: string[]
  /** 预设：有就按 markers 装配 */
  preset?: PresetData | null
  /** 卡的 extensions.depth_prompt（深度注入 / 思维链） */
  depthPrompt?: { text: string; depth: number; role: 'system' | 'user' | 'assistant' } | null
}

/** 历史（含本轮输入）的默认预算。角色卡本身通常就有一两千 token，别按桌宠的 4000 掐。 */
export const DEFAULT_BUDGET = 6000
/** 世界书在预算里的份额：再多也不能让它把对话挤没 */
export const LORE_MAX_TOKENS = 1500

// 旧名字保留：T2 的单测与调用方还在用
export const readLoreEntries = readCardEntries
export function activateLore(
  entries: LoreEntry[],
  scanText: string,
  maxTokens: number = LORE_MAX_TOKENS
): LoreEntry[] {
  return activateLoreEntries(entries, scanText, maxTokens).active
}

/** `{{char}}` / `{{user}}` 换成真名，大小写不敏感（`{{Char}}` 也是常见写法）。 */
export function substitutePlaceholders(
  text: string,
  names: { char: string; user: string }
): string {
  // 用函数式替换：直接传字符串时名字里的 `$&` / `$1` 会被当成替换模板展开
  return text
    .replace(/\{\{char\}\}/gi, () => names.char)
    .replace(/\{\{user\}\}/gi, () => names.user)
}

/**
 * 卡和预设里会用到、而 `{{char}}` / `{{user}}` 之外的 ST 内置宏：
 * - `{{format_message_variable::stat_data}}` / `{{get_message_variable::stat_data}}`
 *   是状态栏卡片的命根子（把当前变量整份塞进 `<status_current_variable>`），
 *   不替换的话模型每轮只看到一个空壳宏，完全不知道当前世界时间 / 好感度
 * - `{{lastusermessage}}` 是本轮用户输入
 */
export function substituteSystemMacros(
  text: string,
  values: { statData?: string; lastUserMessage?: string }
): string {
  return text
    .replace(/\{\{(?:format|get)_message_variable::stat_data\}\}/gi, () => values.statData ?? '')
    .replace(/\{\{lastusermessage\}\}/gi, () => values.lastUserMessage ?? '')
}

/** 点路径取值（`世界层.地点` / `队伍.0.名字`）；取不到返回 undefined */
function readPath(state: unknown, path: string): unknown {
  let cursor: unknown = state
  for (const key of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

function formatMacroValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * 显示侧的状态栏页面里也会写 `{{format_message_variable::stat_data.世界层.地点}}`：
 * 它跟提示词侧那个「整份 stat_data」的宏不是一回事，是按路径取一个值填进 HTML。
 * 不展开的话，卡里那张「旅者手记」面板上每一格都是字面量 `{{…}}`——
 * 页面结构出来了、数据一个都没有（《魔法时代》整张卡就是这个症状）。
 */
export function substituteVariableMacros(text: string, state: unknown): string {
  if (!text.includes('{{')) return text
  return text.replace(/\{\{(?:format|get)_message_variable::\s*stat_data\.([^{}]+?)\s*\}\}/gi, (_, path: string) =>
    formatMacroValue(readPath(state, path.trim()))
  )
}

/** 历史从最早的开始裁，直到装进预算；本轮用户输入不裁（裁掉就没得回了）。 */
export function trimToBudget(history: ChatMessage[], userText: string, budget: number): ChatMessage[] {
  let used = estimateTokens(userText)
  let start = history.length
  while (start > 0) {
    const cost = estimateTokens(history[start - 1]!.content)
    if (used + cost > budget) break
    used += cost
    start--
  }
  return history.slice(start)
}

function section(title: string, body: string): string {
  const trimmed = body.trim()
  return trimmed ? `【${title}】\n${trimmed}` : ''
}

/**
 * 深度注入：插到历史倒数第 depth 条之前（depth=1 就是紧贴本轮输入）。
 * ST 的 depth 把本轮用户输入算作第 0 层，我们的 `history` 不含它，
 * 所以要 `length + 1 - depth`——用 `length - depth` 会整体早一条。
 */
function withDepthInjections(
  history: ChatMessage[],
  injections: { text: string; depth: number; role: ChatMessage['role'] }[]
): ChatMessage[] {
  const list = [...history]
  for (const injection of injections) {
    const depth = Math.max(1, Math.round(injection.depth))
    const index = Math.max(0, list.length + 1 - depth)
    list.splice(index, 0, { role: injection.role, content: injection.text })
  }
  return list
}

export function buildTavernMessages(input: BuildPromptInput): ChatMessage[] {
  return buildTavernPrompt(input).messages
}

/**
 * 装配本轮请求体，并给出调试面板要的分段用量。
 * 直通模板的顺序：卡的 system_prompt → 角色定义前的世界书 → 角色设定 → 用户人设 →
 * 对话示例 → 角色定义后的世界书 → 前情提要 → 永久记忆 → 文风 / 状态 → 历史 →
 * 本轮输入 → 历史后指令。
 */
export function buildTavernPrompt(input: BuildPromptInput): {
  messages: ChatMessage[]
  debug: PromptDebug
} {
  const char = input.card.name.trim() || '角色'
  const user = input.profile.name.trim() || '旅人'
  const names = { char, user }
  const sub = (text: string): string =>
    substituteSystemMacros(substitutePlaceholders(text, names), {
      statData: input.statData,
      lastUserMessage: input.userText
    })
  const pieces: PromptPiece[] = []
  const addPiece = (label: string, source: string, text: string): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    pieces.push({ label, source, tokens: estimateTokens(trimmed) })
  }

  const history = input.history.filter((item) => item.content.trim() !== '')
  const scanDepth = Math.max(1, input.scanDepth ?? 6)
  const scanText = [...history.slice(-scanDepth).map((item) => item.content), input.userText].join('\n')

  const source: LoreActivation =
    input.lore && input.lore.length > 0
      ? activateLoreEntries(input.lore, scanText, input.loreBudget ?? LORE_MAX_TOKENS)
      : activateLoreEntries(
          readCardEntries(input.rawData),
          scanText,
          input.loreBudget ?? LORE_MAX_TOKENS
        )
  const lore = source.active.map((entry) => ({ ...entry, content: sub(entry.content) }))

  const head =
    sub(input.card.systemPrompt).trim() ||
    `你将扮演「${char}」，与「${user}」对话。始终保持在这个角色里，不要以 AI 或助手的身份说话。`

  const blocks = {
    main: head,
    worldInfoBefore: lore
      .filter((entry) => entry.position === 'before_char')
      .map((entry) => entry.content)
      .join('\n\n'),
    charDescription: section(`${char}的设定`, sub(input.card.description)),
    charPersonality: section('性格', sub(input.card.personality)),
    scenario: section('场景', sub(input.card.scenario)),
    personaDescription: section(
      `${user}的设定`,
      [sub(input.profile.description).trim(), `（对方称呼你为「${user}」）`].filter(Boolean).join('\n')
    ),
    dialogueExamples: section('对话示例', sub(input.card.mesExample)),
    worldInfoAfter: lore
      .filter((entry) => entry.position === 'after_char')
      .map((entry) => entry.content)
      .join('\n\n'),
    postHistoryInstructions: sub(input.card.postHistoryInstructions).trim()
  }

  // 「这场对话之前发生过什么」：档案 / 记忆 / 文风 / 状态 / 篇幅
  const context: { label: string; source: string; text: string }[] = [
    { label: '忆境典藏', source: 'memory', text: input.dossier?.trim() ?? '' },
    { label: '永久记忆', source: 'memory', text: input.memoryContext?.trim() ?? '' },
    { label: '文风', source: 'style', text: input.styleText?.trim() ?? '' },
    { label: '变量状态', source: 'status', text: input.statusText?.trim() ?? '' }
  ]
  const contextText = context
    .filter((item) => item.text)
    .map((item) => {
      addPiece(item.label, item.source, item.text)
      return item.text
    })
    .join('\n\n')
  const instructions = (input.instructions ?? []).map((text) => sub(text).trim()).filter(Boolean)
  for (const text of instructions) addPiece('回复要求', 'settings', text)

  const budget = input.fullVision ? Number.POSITIVE_INFINITY : (input.budget ?? DEFAULT_BUDGET)
  const recent =
    input.recentLimit && input.recentLimit > 0 ? history.slice(-input.recentLimit) : history
  const keptHistory = trimToBudget(
    recent.map((item) => ({ role: item.role, content: sub(item.content) })),
    input.userText,
    budget
  )
  const historyTokens = keptHistory.reduce((sum, item) => sum + estimateTokens(item.content), 0)
  pieces.push({
    label: `历史 ${keptHistory.length} 条`,
    source: 'history',
    tokens: historyTokens
  })

  // 深度注入：世界书里 position=depth 的条目 + 卡的 extensions.depth_prompt
  const depthInjections: { text: string; depth: number; role: ChatMessage['role'] }[] = lore
    .filter((entry) => entry.position === 'depth')
    .map((entry) => ({ text: entry.content, depth: entry.depth, role: 'system' }))
  if (input.depthPrompt?.text.trim()) {
    depthInjections.push({
      text: sub(input.depthPrompt.text),
      depth: input.depthPrompt.depth,
      role: input.depthPrompt.role
    })
  }
  const historyWithDepth = withDepthInjections(keptHistory, depthInjections)
  for (const injection of depthInjections) addPiece('深度注入', 'depth', injection.text)

  const messages: ChatMessage[] = []
  const preset = input.preset
  /** 必须在最后一条用户消息之后发出的系统指令（预设给了 marker 或没给都要发） */
  const postInstructions: string[] = []
  /** `injection_depth = 0` 的预设条目：ST 语义是插在本轮用户输入之后 */
  const postUser: ChatMessage[] = []
  if (preset && preset.prompts.length > 0) {
    // 预设没给世界书占位点（worldInfoBefore / After）时不能把条目整段丢掉，
    // 否则多角色卡那 150 多条世界设定会静默消失
    const fallbackLore: string[] = []
    if (!presetHasMarker(preset, 'worldInfoBefore') && blocks.worldInfoBefore) {
      fallbackLore.push(blocks.worldInfoBefore)
      addPiece('角色定义前世界书', 'lore:fallback', blocks.worldInfoBefore)
    }
    if (!presetHasMarker(preset, 'worldInfoAfter') && blocks.worldInfoAfter) {
      fallbackLore.push(blocks.worldInfoAfter)
      addPiece('角色定义后世界书', 'lore:fallback', blocks.worldInfoAfter)
    }
    assembleWithPreset({
      preset,
      blocks,
      cardSystemPrompt: sub(input.card.systemPrompt).trim(),
      contextText,
      fallbackLore,
      instructions,
      history: historyWithDepth,
      messages,
      postInstructions,
      postUser,
      addPiece,
      sub
    })
    if (blocks.postHistoryInstructions && !presetHasMarker(preset, 'postHistoryInstructions')) {
      postInstructions.push(blocks.postHistoryInstructions)
    }
  } else {
    const before = blocks.worldInfoBefore
    const after = blocks.worldInfoAfter
    const system = [
      blocks.main,
      before,
      [blocks.charDescription, blocks.charPersonality, blocks.scenario, blocks.dialogueExamples]
        .filter(Boolean)
        .join('\n\n'),
      blocks.personaDescription,
      after,
      contextText,
      instructions.join('\n\n')
    ]
      .filter(Boolean)
      .join('\n\n')
    messages.push({ role: 'system', content: system })
    messages.push(...historyWithDepth)
    if (blocks.postHistoryInstructions) postInstructions.push(blocks.postHistoryInstructions)
  }

  if (input.userText.trim()) messages.push({ role: 'user', content: sub(input.userText) })
  // depth = 0 的注入离本轮输入 0 条：紧跟在它后面
  for (const item of postUser) messages.push(item)
  // 后置指令是「模型最后读到的东西」，必须紧跟本轮输入之后（ST 的语义）
  for (const text of postInstructions) {
    if (text.trim()) messages.push({ role: 'system', content: text })
  }

  // 调试面板的分段：预设路径下世界书由 marker 那一步记账（重复记会让 token 虚高）。
  // 判断条件必须和装配分支一致（`preset && prompts.length > 0`）：预设存在但条目全被
  // 滤掉时走的是直通模板，世界书确实注入了，这里再按 `!preset` 跳过就会整块漏记
  if (!(preset && preset.prompts.length > 0)) {
    for (const entry of lore) {
      pieces.push({
        label: entry.name,
        source: `lore:${entry.source}`,
        tokens: estimateTokens(entry.content)
      })
    }
  }

  const totalTokens = messages.reduce((sum, item) => sum + estimateTokens(item.content), 0)
  return {
    messages,
    debug: {
      pieces,
      loreActive: source.active.map((entry) => ({
        name: entry.name,
        source: entry.source,
        position: entry.position,
        tokens: estimateTokens(entry.content)
      })),
      loreDropped: source.dropped.map((entry) => ({
        name: entry.name,
        source: entry.source,
        tokens: estimateTokens(entry.content)
      })),
      historyCount: keptHistory.length,
      historyTokens,
      totalTokens,
      presetName: preset?.name ?? null
    }
  }
}

/**
 * 预设里有没有这个占位点。**必须按 `orderedPrompts` 的过滤口径**：被取消勾选的 marker
 * 既不产出内容，也不该算作「已留了占位点」——否则兜底注入跟着跳过，多角色卡那上百条
 * 世界书会整轮静默消失。
 */
function presetHasMarker(preset: PresetData, id: string): boolean {
  return orderedPrompts(preset).some((prompt) => prompt.marker && prompt.identifier === id)
}

interface MarkerBlocks {
  main: string
  worldInfoBefore: string
  charDescription: string
  charPersonality: string
  scenario: string
  personaDescription: string
  dialogueExamples: string
  worldInfoAfter: string
  postHistoryInstructions: string
}

/**
 * 按预设顺序装配：
 * - marker 换成对应的卡字段 / 世界书 / 历史；
 * - 普通 system 条目依次拼进当前这一段，user / assistant 条目**单独成条**插在原位置；
 * - 我们自己的档案 / 记忆 / 文风 / 状态统一放在 chatHistory 之前（预设没有它们的占位点退）；
 * - 历史之后出现的 system 条目单独成一条后置消息；
 * - postHistoryInstructions 交给调用方，等本轮用户输入之后再发。
 */
interface PresetAssembly {
  preset: PresetData
  blocks: MarkerBlocks
  /** 卡自己的 system_prompt：非空时按 ST 的语义取代预设的 Main Prompt */
  cardSystemPrompt: string
  contextText: string
  /** 预设没给世界书占位点时兜底注入的条目 */
  fallbackLore: string[]
  instructions: string[]
  history: ChatMessage[]
  messages: ChatMessage[]
  postInstructions: string[]
  /** `injection_depth = 0` 的条目：本轮用户输入之后才发 */
  postUser: ChatMessage[]
  addPiece: (label: string, source: string, text: string) => void
  sub: (text: string) => string
}

function assembleWithPreset(options: PresetAssembly): void {
  const { preset, blocks, cardSystemPrompt, contextText, fallbackLore, instructions } = options
  const { history, messages, postInstructions, postUser, addPiece, sub } = options
  const vars = new Map<string, string>()
  /** 预设条目和卡字段里的 {{char}} / {{user}} 一样要替换，否则会把字面量发给模型 */
  const render = (text: string): string => sub(applyMacros(text, vars))
  let systemParts: string[] = []
  let afterParts: string[] = []
  let seenHistory = false
  let sawMain = false
  const historyList = [...history]
  /** 深度注入条目：按 order 收集，等 chatHistory 那一步再一次性插进历史 */
  const depthPending: { text: string; depth: number; role: ChatMessage['role'] }[] = []
  const flush = (): void => {
    const text = systemParts.filter(Boolean).join('\n\n')
    if (text.trim()) messages.push({ role: 'system', content: text })
    systemParts = []
  }
  /** 历史之后累积的 system 条目：遇到 role 不是 system 的条目时必须先落下，否则顺序颠倒 */
  const flushAfter = (): void => {
    const tail = afterParts.filter(Boolean).join('\n\n')
    if (tail) messages.push({ role: 'system', content: tail })
    afterParts = []
  }
  const historyWithDepth = (): ChatMessage[] => withDepthInjections(historyList, depthPending)
  const pushContext = (): void => {
    if (contextText) systemParts.push(contextText)
    for (const lore of fallbackLore) systemParts.push(lore)
    if (instructions.length > 0) systemParts.push(instructions.join('\n\n'))
  }

  const ordered = orderedPrompts(preset)
  // 第一遍只求值：深度注入里的 `{{getvar}}` 依赖前面那些 `{{setvar}}` 条目的顺序，
  // 不能提前单独跑；而 `chatHistory` 又可能排在深度条目之前，也不能边装配边收集。
  // 所以先按 order 走一遍把 setvar 推进到位，只留下深度条目。
  for (const prompt of ordered) {
    if (prompt.marker) continue
    const text = render(prompt.content)
    if (prompt.injectionPosition !== 1 || !text.trim()) continue
    if (prompt.injectionDepth <= 0) {
      // ST 的 depth = 0 = 「本轮用户输入之后」
      postUser.push({ role: prompt.role, content: text })
    } else {
      depthPending.push({ text, depth: prompt.injectionDepth, role: prompt.role })
    }
  }
  // 第二遍是真正的装配，宏要按同样的顺序再走一遍，取到的是同位置的值
  vars.clear()
  for (const prompt of ordered) {
    if (!prompt.marker && prompt.injectionPosition === 1) {
      // 内容已在第一遍收进 depthPending，这里只记用量
      addPiece(prompt.name, 'preset:depth', render(prompt.content))
      continue
    }
    if (prompt.marker && isMarkerId(prompt.identifier)) {
      if (prompt.identifier === 'chatHistory') {
        // 档案 / 记忆 / 文风 / 状态紧跟历史之前，与直通模板的语义一致
        pushContext()
        flush()
        messages.push(...historyWithDepth())
        seenHistory = true
        continue
      }
      // `blocks.main` 就是卡的 system_prompt：这个 marker 出现一次就算「main 已经在了」，
      // 否则末尾那条兜底会把它再 unshift 一遍（重复 token + 重复指令）
      if (prompt.identifier === 'main') {
        sawMain = true
        // 卡没写 system_prompt 时 ST 用的是**预设 main 条的正文**（破限主体 / 身份设定）。
        // 一律换成我们拼的默认角色指令，等于把预设的主体整段丢掉
        if (!cardSystemPrompt) {
          const own = render(prompt.content)
          if (own.trim()) {
            addPiece(prompt.identifier, 'preset', own)
            if (seenHistory) afterParts.push(own)
            else systemParts.push(own)
            continue
          }
        }
      }
      const content = blocks[prompt.identifier]
      if (content) {
        addPiece(prompt.identifier, 'card', content)
        if (prompt.identifier === 'postHistoryInstructions') {
          // 后置指令永远在历史与本轮输入之后，不跟当前段混
          postInstructions.push(content)
        } else if (seenHistory) afterParts.push(content)
        else systemParts.push(content)
      }
      continue
    }
    let raw = prompt.content
    if (prompt.identifier === 'main') {
      sawMain = true
      // ST 里卡的 system_prompt 会**取代** Main Prompt，不是再追加一段
      if (cardSystemPrompt) raw = cardSystemPrompt
    }
    const text = render(raw)
    if (!text.trim()) continue
    addPiece(prompt.name, 'preset', text)
    if (prompt.role !== 'system') {
      // user / assistant 条目（jailbreak、示例对答）单独成条，别混进 system 段。
      // 历史之后攒着的 system 条目必须先落下，否则会跑到这条 assistant 后面
      flush()
      flushAfter()
      messages.push({ role: prompt.role, content: text })
      continue
    }
    if (seenHistory) afterParts.push(text)
    else systemParts.push(text)
  }
  if (!seenHistory) {
    // 预设里没有 chatHistory（有问题的预设）：历史仍然要带上
    pushContext()
    flush()
    messages.push(...historyWithDepth())
  } else {
    flush()
    flushAfter()
  }
  // 预设里压根没有 main 条目（或用户把它取消勾选了）：卡的系统提示不能丢，
  // 卡没写 system_prompt 时 `blocks.main` 里那条默认角色指令也不能丢——
  // 否则直通模板会发、预设路径不发，模型这轮连「扮演谁」都没被告知
  if (!sawMain && blocks.main.trim()) {
    addPiece('main', 'card', blocks.main)
    messages.unshift({ role: 'system', content: blocks.main })
  }
}
