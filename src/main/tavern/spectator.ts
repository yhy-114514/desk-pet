// 鲸鱼娘旁观（T7）：她读酒馆的观测档案 / 最近剧情 / 角色卡 / 永久记忆，
// 回答哥哥的问题，也给剧情灵感、帮着看卡。问才答，不问不扰。
//
// 只读：本模块不写 tavern.db（观战开关由 chatStore 落盘），也不碰鲸鱼娘自己的
// memory.json / chat-history.json。回答用一次性 messages，绝不塞进她主会话的
// session.setSystemContext()——那是持久字段，会把酒馆剧情污染进她和哥哥的日常聊天。
import { findCardItem, validateCardFix, type CardFix, type CardIssue } from '../../shared/cardFix'
import { loadConfig } from '../chat/config'
import { completeChat, streamChat } from '../chat/deepseek'
import { stripEmotionTags, stripStrayTags } from '../chat/emotion'
import { SYSTEM_PROMPT } from '../chat/persona'
import { stripReminderTags } from '../chat/reminder'
import { getCard, getCardData, loadProfile, saveCard, updateCardData } from './cards'
import { removeCardLore, removeCardRegex, upsertCardLore, upsertCardRegex, type CardLoreInput } from './cardEdit'
import { activePath, getChat } from './chatStore'
import { formatDossier, type Dossier } from './dossier'
import { extractUpdates, formatStatus, objectChunks } from './mvu'
import { listMemories } from './memoryStore'
import { readCardRegexes, type RegexRule } from './regexEngine'
import { latestSummary } from './summaryStore'
import { loadVariables } from './variableStore'
import { readCardEntries } from './worldbook'

/** 最近剧情喂给她的条数：够回答「刚才发生了什么」，又不至于把整本小说塞进去 */
const RECENT_MESSAGES = 12
/** 单条剧情的截断：有些卡一轮就是三千字 */
const RECENT_CHARS = 700
const MEMORY_LIMIT = 12
const STATUS_LIMIT = 12
const CARD_FIELD_CHARS = 1200
/** 角色卡里世界书条目只给名字与关键词：让审卡能看出「这条和那条打架」，不烧 token */
const CARD_ENTRY_LIMIT = 60

const SPECTATOR_TIMEOUT_MS = 60_000
const SPECTATOR_TEMPERATURE = 0.85
/** 回复上限。DeepSeek 的推理 token 也算在这个预算里：审卡这类要动脑的问题
 *  光思考就可能吃掉七八百，800 会得到「content 为空、finish_reason=length」的空白回答 */
const SPECTATOR_MAX_TOKENS = 3000

export type AskMode = 'ask' | 'idea'

export interface RecentLine {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** 观战上下文的数据形状（拼文本在 formatObserveContext，分开才好测） */
export interface ObserveContext {
  chatId: string
  characterId: string
  cardName: string
  playerName: string
  dossier: Dossier | null
  recent: RecentLine[]
  memories: string[]
  status: string[]
}

export interface AskOptions {
  chatId: string
  question: string
  mode?: AskMode
  signal?: AbortSignal
  onToken?: (delta: string) => void
}

/** 从库里读观战上下文。只读，不存在返回 null。 */
export function buildObserveContext(chatId: string): ObserveContext | null {
  const chat = getChat(chatId)
  if (!chat) return null
  const card = getCard(chat.characterId)
  if (!card) return null

  const dossier = latestSummary(chatId)?.dossier ?? null
  const recent = activePath(chatId)
    .slice(-RECENT_MESSAGES)
    .map((item) => ({
      role: item.role,
      // 变量更新块不是剧情，别拿去哄她「刚才发生了什么」
      content: extractUpdates(item.content).text.trim().slice(0, RECENT_CHARS)
    }))
    .filter((item) => item.content !== '')
  const memories = listMemories(chat.characterId)
    .slice(0, MEMORY_LIMIT)
    .map((item) => item.content)
  const status = formatStatus(loadVariables(chatId)).slice(0, STATUS_LIMIT)

  return {
    chatId,
    characterId: chat.characterId,
    cardName: card.name,
    playerName: loadProfile().name,
    dossier,
    recent,
    memories,
    status
  }
}

/** 拼成一段给人设看的观测文本。档案为空时明说，别让她硬编。 */
export function formatObserveContext(context: ObserveContext): string {
  const lines: string[] = [
    `【正在看】「${context.playerName}」在和「${context.cardName}」演一场对话。`
  ]

  const dossierText = context.dossier ? formatDossier(context.dossier) : ''
  if (dossierText) {
    lines.push(dossierText)
  } else {
    lines.push('【观测档案】还没有。这场聊得还短，档案要等聊够几轮才会生成——现在只能看下面的最近剧情。')
  }

  if (context.recent.length > 0) {
    const talk = context.recent
      .map((item) => `${item.role === 'user' ? context.playerName : context.cardName}：${item.content}`)
      .join('\n')
    lines.push(`【最近剧情】\n${talk}`)
  }

  if (context.memories.length > 0) {
    lines.push(`【她记得的事】\n${context.memories.map((item) => `- ${item}`).join('\n')}`)
  }

  if (context.status.length > 0) {
    lines.push(`【当前状态】\n${context.status.join('\n')}`)
  }

  return lines.join('\n\n')
}

const ASK_RULES = `【这一轮的任务】哥哥在酒馆里问你关于上面这场对话的事。
- 用旁观者的口吻回答，你是「鲸鱼娘」，不是这场对话里的角色。
- 只根据上面给的材料回答；材料里没写就说「这个我看不清」。
- 不替角色做决定、不编造剧情、不改写哥哥的设定。
- 2~4 句说完，口语化，可以带一点点海洋比喻。
- 不要输出情绪标记、提醒标记或任何尖括号标签，不要分点、不要 markdown。`

const IDEA_RULES = `【这一轮的任务】哥哥想让你给接下来的剧情出点主意。
- 给 2~3 个可以往下走的方向，每个 1~2 句。
- 必须引用上面档案或最近剧情里**真实存在的**剧情节点、伏笔或人物关系，不要凭空编新的设定。
- 每个方向换一行，前面用「·」。
- 不替哥哥做决定，只是提可能。
- 不要输出情绪标记、提醒标记或任何尖括号标签，不要 markdown。`

/** 观战问答的 system：鲸鱼娘人设 + 本轮规则 + 观测材料。 */
export function spectatorSystem(context: ObserveContext, mode: AskMode): string {
  const rules = mode === 'idea' ? IDEA_RULES : ASK_RULES
  return `${SYSTEM_PROMPT}\n\n${rules}\n\n【观测材料】\n${formatObserveContext(context)}`
}

/** 流式过程中把情绪 / 提醒标记洗掉，并给调用方算好可以往外发的增量。 */
function makeStreamCleaner(onToken: (delta: string) => void): {
  push: (delta: string) => void
  finish: () => void
} {
  let raw = ''
  let sent = ''
  return {
    push: (delta) => {
      raw += delta
      // 两段清洗：情绪标记（含末尾半截）+ 提醒标记（含末尾半截）
      const clean = stripReminderTags(stripStrayTags(raw).text, false).text
      // 已发出的部分必须仍是新文本的前缀，否则这一块先不发（与酒馆正文同一条规矩）
      if (!clean.startsWith(sent)) return
      const fresh = clean.slice(sent.length)
      sent = clean
      if (fresh) onToken(fresh)
    },
    finish: () => {
      // 收尾时允许吐出被扣住的尾巴（此时已经不是半个标记了）
      const clean = stripEmotionTags(stripReminderTags(raw, true).text).trim()
      if (!clean.startsWith(sent)) return
      const fresh = clean.slice(sent.length)
      sent = clean
      if (fresh) onToken(fresh)
    }
  }
}

async function runOneShot(
  system: string,
  user: string,
  signal?: AbortSignal,
  onToken?: (delta: string) => void
): Promise<string> {
  const config = loadConfig()
  if (!config.apiKey) {
    throw new Error('还没有配置 API Key。按 Ctrl+Shift+Space 打开输入栏，点「设置」填一下？')
  }
  // 调用方给的是「新问题顶掉旧问题」的 signal，它永远不会自己触发超时；
  // 流挂住时没人兜底，界面会一直显示在等。所以两路取并集，超时照样生效。
  const deadline = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(SPECTATOR_TIMEOUT_MS)])
    : AbortSignal.timeout(SPECTATOR_TIMEOUT_MS)
  const cleaner = onToken ? makeStreamCleaner(onToken) : null
  const raw = await streamChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    apiKey: config.apiKey,
    // 观战走全局模型：会话可能为了状态栏切到 pro，问她两句话不该跟着烧
    model: config.model,
    temperature: SPECTATOR_TEMPERATURE,
    maxTokens: SPECTATOR_MAX_TOKENS,
    signal: deadline,
    onToken: (delta) => cleaner?.push(delta)
  })
  cleaner?.finish()
  const text = stripEmotionTags(stripReminderTags(raw, true).text).trim()
  // 推理 token 吃光预算时接口会返回空 content（finish_reason=length）：
  // 别让界面停在一个空气泡上，明确让她说一句、给一次重问的机会
  if (!text) throw new Error('她这次没说出来（回复被截断了），再问一次？')
  return text
}

/** 问她一句。调用方必须先确认这场会话开着观战。 */
export async function askSpectator(options: AskOptions): Promise<string> {
  const context = buildObserveContext(options.chatId)
  if (!context) throw new Error('这场对话不在了。')
  const question = options.question.trim()
  if (!question) throw new Error('先说说你想问什么。')
  return runOneShot(
    spectatorSystem(context, options.mode ?? 'ask'),
    question,
    options.signal,
    options.onToken
  )
}

// ── 角色卡编辑器助手 ────────────────────────────────────────────────

export interface CardEntryBrief {
  name: string
  keys: string[]
}

export interface CardContext {
  characterId: string
  name: string
  description: string
  personality: string
  scenario: string
  systemPrompt: string
  entries: CardEntryBrief[]
}

/** 审卡用的材料：平铺字段 + 世界书条目名与关键词。 */
export function buildCardContext(characterId: string): CardContext | null {
  const card = getCard(characterId)
  if (!card) return null
  const rawData = getCardData(characterId)
  const entries = readCardEntries(rawData)
    .slice(0, CARD_ENTRY_LIMIT)
    .map((entry) => ({ name: entry.name, keys: entry.keys }))
  return {
    characterId,
    name: card.name,
    description: card.description.slice(0, CARD_FIELD_CHARS),
    personality: card.personality.slice(0, CARD_FIELD_CHARS),
    scenario: card.scenario.slice(0, CARD_FIELD_CHARS),
    systemPrompt: card.systemPrompt.slice(0, CARD_FIELD_CHARS),
    entries
  }
}

export function formatCardContext(context: CardContext): string {
  const lines: string[] = [`【角色卡】${context.name}`]
  if (context.description) lines.push(`【描述】\n${context.description}`)
  if (context.personality) lines.push(`【性格】\n${context.personality}`)
  if (context.scenario) lines.push(`【场景】\n${context.scenario}`)
  if (context.systemPrompt) lines.push(`【系统提示词】\n${context.systemPrompt}`)
  if (context.entries.length > 0) {
    const names = context.entries
      .map((entry) => `- ${entry.name}${entry.keys.length > 0 ? `（关键词：${entry.keys.join('、')}）` : ''}`)
      .join('\n')
    lines.push(`【世界书条目】只列了名字和关键词：\n${names}`)
  } else {
    lines.push('【世界书条目】这张卡没有内嵌世界书。')
  }
  return lines.join('\n\n')
}

const CARD_RULES = `【这一轮的任务】哥哥正在改角色卡，问了你一个问题。
- 审卡时指出具体的地方：设定互相矛盾、开场白和描述对不上、世界书条目打架、缺了必要字段，都说清楚是哪一处。
- 帮写时直接给出能粘贴进卡里的文字，别绕圈子。
- 卡里没写的就说「卡里没写」，不要替它补设定。
- 用鲸鱼娘的口吻，2~5 句，口语化，不要输出任何尖括号标签、不要 markdown。`

export function cardAssistantSystem(context: CardContext): string {
  return `${SYSTEM_PROMPT}\n\n${CARD_RULES}\n\n【材料】\n${formatCardContext(context)}`
}

export interface CardAskOptions {
  characterId: string
  question: string
  signal?: AbortSignal
  onToken?: (delta: string) => void
}

/** 问问鲸鱼娘：审卡 / 帮写。同样是一次性 messages，不碰会话上下文。 */
export async function askCardAssistant(options: CardAskOptions): Promise<string> {
  const context = buildCardContext(options.characterId)
  if (!context) throw new Error('这张角色卡不在了。')
  const question = options.question.trim()
  if (!question) throw new Error('先说说你想问什么。')
  return runOneShot(
    cardAssistantSystem(context),
    question,
    options.signal,
    options.onToken
  )
}

// ── 体检：诊断角色卡问题并给出可执行的修复 ────────────────────────
//
// 审卡面板（CARD_RULES）只看到描述 + 世界书条目名，够回答「设定有没有矛盾」，
// 但看不出「哪条正则把卡自己的 JS 洗崩了」这类真问题。体检要读全量：
// 世界书正文、正则的 pattern/replacement、开场白与示例。

/** 世界书正文单条截断：多角色卡一条动辄几千字，全塞进去一轮就是几万 token */
const CARD_LORE_CHARS = 1000
/** 最多列几条世界书：再多模型也读不过来 */
const CARD_LORE_LIMIT = 100
/** 正则 pattern / 替换串的截断：正常规则很短，超长的基本是整页 HTML */
const CARD_REGEX_CHARS = 600
const DIAGNOSE_MAX_TOKENS = 8000
const DIAGNOSE_TEMPERATURE = 0.2

export interface CardRegexBrief {
  id: string
  name: string
  pattern: string
  flags: string
  replacement: string
  target: string
  enabled: boolean
}

export interface CardLoreBrief {
  id: string
  name: string
  keys: string[]
  content: string
  constant: boolean
}

export interface FullCardContext {
  characterId: string
  name: string
  description: string
  personality: string
  scenario: string
  systemPrompt: string
  postHistory: string
  firstMes: string
  alternateGreetings: string[]
  mesExample: string
  lore: CardLoreBrief[]
  /** 世界书实际总条数。`lore` 只带前 CARD_LORE_LIMIT 条，材料里要说清楚免得她以为只有这些。 */
  loreTotal: number
  regexes: CardRegexBrief[]
}

/** 体检用的材料：平铺字段 + 世界书正文 + 正则脚本。 */
export function buildFullCardContext(characterId: string): FullCardContext | null {
  const card = getCard(characterId)
  if (!card) return null
  const rawData = getCardData(characterId)
  const clip = (text: string, limit: number): string =>
    text.length > limit ? `${text.slice(0, limit)}…（后面省略 ${text.length - limit} 字）` : text

  const allLore = readCardEntries(rawData, { includeEmpty: true })
  const lore = allLore.slice(0, CARD_LORE_LIMIT).map((entry) => ({
    id: entry.id,
    name: entry.name,
    keys: entry.keys,
    content: clip(entry.content, CARD_LORE_CHARS),
    constant: entry.constant
  }))
  const regexes = readCardRegexes(rawData, { forEditing: true }).map((rule) => ({
    id: rule.id,
    name: rule.name,
    pattern: clip(rule.pattern, CARD_REGEX_CHARS),
    flags: rule.flags,
    replacement: clip(rule.replacement, CARD_REGEX_CHARS),
    target: rule.target,
    enabled: rule.enabled
  }))

  return {
    characterId,
    name: card.name,
    description: clip(card.description, CARD_FIELD_CHARS),
    personality: clip(card.personality, CARD_FIELD_CHARS),
    scenario: clip(card.scenario, CARD_FIELD_CHARS),
    systemPrompt: clip(card.systemPrompt, CARD_FIELD_CHARS),
    postHistory: clip(card.postHistoryInstructions, CARD_FIELD_CHARS),
    firstMes: clip(card.firstMes, CARD_FIELD_CHARS),
    alternateGreetings: card.alternateGreetings.slice(0, 5).map((text) => clip(text, CARD_FIELD_CHARS)),
    mesExample: clip(card.mesExample, CARD_FIELD_CHARS),
    lore,
    loreTotal: allLore.length,
    regexes
  }
}

/** 拼成给模型看的体检材料。id 一并给出，修复指令要按 id 指回具体规则 / 条目。 */
export function formatFullCardContext(context: FullCardContext): string {
  const lines: string[] = [`【角色卡】${context.name}`]
  if (context.description) lines.push(`【描述】\n${context.description}`)
  if (context.personality) lines.push(`【性格】\n${context.personality}`)
  if (context.scenario) lines.push(`【场景】\n${context.scenario}`)
  if (context.systemPrompt) lines.push(`【系统提示词】\n${context.systemPrompt}`)
  if (context.postHistory) lines.push(`【历史后指令】\n${context.postHistory}`)
  if (context.firstMes) lines.push(`【主开场白】\n${context.firstMes}`)
  context.alternateGreetings.forEach((text, index) => {
    lines.push(`【备选开场白 ${index + 1}】\n${text}`)
  })
  if (context.mesExample) lines.push(`【对话示例】\n${context.mesExample}`)

  if (context.lore.length > 0) {
    const entries = context.lore.map((entry) => {
      const head = `- id=${entry.id}｜${entry.name}${entry.constant ? '（常驻）' : ''}${
        entry.keys.length > 0 ? `（触发词：${entry.keys.join('、')}）` : '（无触发词）'
      }`
      return `${head}\n  正文：${entry.content || '（空）'}`
    })
    // 材料只带前 CARD_LORE_LIMIT 条（190 条的卡全塞进来是 20 万字）：不写明总数的话，
    // 她会把「只看了一部分」当成「这张卡只有这些」，漏报后半段的条目
    const scope =
      context.loreTotal > context.lore.length
        ? `（共 ${context.loreTotal} 条，以下列前 ${context.lore.length} 条）`
        : `（共 ${context.loreTotal} 条）`
    lines.push(`【世界书条目${scope}】\n${entries.join('\n')}`)
  } else {
    lines.push('【世界书条目】这张卡没有内嵌世界书。')
  }

  if (context.regexes.length > 0) {
    const rules = context.regexes.map((rule) => {
      const using = rule.enabled ? '' : '（已禁用）'
      const where = rule.target === 'display' ? '只显示' : rule.target === 'prompt' ? '只提示词' : '两边'
      return (
        `- id=${rule.id}｜${rule.name}${using}｜作用于：${where}\n` +
        `  pattern: ${rule.pattern}\n  flags: ${rule.flags}\n  replacement: ${
          rule.replacement || '（空）'
        }`
      )
    })
    lines.push(`【正则脚本】\n${rules.join('\n')}`)
  } else {
    lines.push('【正则脚本】这张卡没有内嵌正则。')
  }

  return lines.join('\n\n')
}

const DIAGNOSE_RULES = `【这一轮的任务】哥哥要你给这张角色卡做一次体检，找出会让它在酒馆里表现不正常的问题。
重点查这几类（都是真实成品卡最常犯的）：
1. 正则脚本会误伤卡自己的内容：比如「把英文单引号换成中文引号」的规则，会把卡里状态栏 <script> 中的 '…' 也换掉，脚本直接崩；又或者 pattern 过于宽泛，会把正文或模板 JS 一起洗掉。
2. 世界书条目打架或缺失：两条规则互相矛盾、触发词为空又不是常驻（永远不生效）、正文为空、多个条目对同一设定的描述不一致。
3. 字段自相矛盾：描述 / 性格 / 场景 / 系统提示词之间说法冲突。
4. 开场白与描述对不上（开场白里发生的事、场景、称呼和设定不一致）。
5. 明显的残缺：必要字段空着、开场白空着。

只报你能从材料里**确定**的问题，不要为了凑数编。没问题就返回空数组。
每条问题要给 severity（high / medium / low）、title（一句话）、detail（指明具体是哪一条规则 / 条目 / 字段，哪里不对）。
能给出确定修法时才给 fix，否则 fix 填 null。

fix 只能是下面三种形状之一：
- 改/删一条正则：{"type":"regex","ruleId":"<正则的 id>","patch":{"pattern?":"…","flags?":"g","replacement?":"…","target?":"display|prompt|both","enabled?":true}}；要删就写 {"type":"regex","ruleId":"…","remove":true}
- 改/删/新增一条世界书条目：{"type":"lore","entryId":"<条目 id>","patch":{"name?":"…","keys?":["…"],"content?":"…","constant?":false}}；新增时不写 entryId、必须带 content
- 改一个平铺字段：{"type":"field","field":"description|personality|scenario|firstMes|systemPrompt|postHistoryInstructions|mesExample","value":"新的完整内容"}

只输出一个 JSON 对象，形如：{"issues":[{"severity":"high","title":"…","detail":"…","fix":{…}或null}]}
不要输出任何 JSON 以外的文字。`

/** 诊断结果的一条。fix 为 null = 只提示、不自动改。 */
export type { CardIssue }

const SEVERITIES = ['high', 'medium', 'low']

function toIssue(raw: unknown): CardIssue | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const title = typeof item['title'] === 'string' ? item['title'].trim() : ''
  if (!title) return null
  const detail = typeof item['detail'] === 'string' ? item['detail'].trim() : ''
  const severity = SEVERITIES.includes(String(item['severity']))
    ? (item['severity'] as CardIssue['severity'])
    : 'medium'
  let fix: CardFix | null = null
  if (item['fix'] && typeof item['fix'] === 'object') {
    try {
      fix = validateCardFix(item['fix'])
    } catch {
      // 修法不合规就当「只提示」：界面仍然把问题显示出来，只是不给自动改
      fix = null
    }
  }
  return { severity, title, detail, fix }
}

/** 从被截断的 JSON 里抢救出完整的问题对象（对齐 mvu 的 salvageOps 思路） */
function salvageIssues(text: string): unknown[] {
  const start = text.indexOf('"issues"')
  const from = start >= 0 ? text.indexOf('[', start) : text.indexOf('[')
  if (from < 0) return []
  const items: unknown[] = []
  // 必须用会跳过字符串字面量的抠法：detail / replacement 里带 `{` 或 `}` 时，
  // 数花括号的实现会把深度算歪，后面的整条问题被并进一段解析不了的切片里静默丢掉
  for (const chunk of objectChunks(text.slice(from + 1))) {
    try {
      items.push(JSON.parse(chunk))
    } catch {
      // 这个对象本身不完整，丢掉继续往后扫
    }
  }
  return items
}

/** 解析模型返回的体检结果。整体 JSON 坏了就抢救完整的那几条。 */
export interface DiagnosisResult {
  issues: CardIssue[]
  /**
   * 外层结构到底解出来没有。**空清单有两种含义**：「这张卡确实没毛病」和
   * 「结果被 max_tokens 截断、一个完整问题都没抠到」。被截断的 JSON 里 `"issues"`
   * 这几个字一定在（只是数组没闭合），拿它当判据会把没跑完的体检报成「卡很干净」。
   */
  parsed: boolean
}

export function parseDiagnosis(text: string): DiagnosisResult {
  const body = text.trim()
  let list: unknown[] = []
  let parsed = false
  try {
    const raw: unknown = JSON.parse(body)
    const holder = raw as Record<string, unknown> | null
    if (holder && Array.isArray(holder['issues'])) {
      list = holder['issues'] as unknown[]
      parsed = true
    } else if (Array.isArray(raw)) {
      list = raw as unknown[]
      parsed = true
    }
  } catch {
    list = salvageIssues(body)
  }
  const issues = list.map(toIssue).filter((item): item is CardIssue => item !== null)
  // 截断后抢救出几条完整对象时，至少这部分是真的，照常给用户看
  return { issues, parsed: parsed || issues.length > 0 }
}

const DIAGNOSE_TIMEOUT_MS = 120_000

/** 让鲸鱼娘给这张卡做一次体检。返回问题清单（可能为空）。 */
export async function diagnoseCard(
  characterId: string,
  options: { signal?: AbortSignal } = {}
): Promise<CardIssue[]> {
  const context = buildFullCardContext(characterId)
  if (!context) throw new Error('这张角色卡不在了。')
  const config = loadConfig()
  if (!config.apiKey) {
    throw new Error('还没有配置 API Key。按 Ctrl+Shift+Space 打开输入栏，点「设置」填一下？')
  }
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(DIAGNOSE_TIMEOUT_MS)])
    : AbortSignal.timeout(DIAGNOSE_TIMEOUT_MS)
  const raw = await completeChat({
    messages: [
      { role: 'system', content: `${SYSTEM_PROMPT}\n\n${DIAGNOSE_RULES}\n\n【材料】\n${formatFullCardContext(context)}` },
      { role: 'user', content: '请按规则体检这张卡，只输出 JSON。' }
    ],
    apiKey: config.apiKey,
    model: config.model,
    temperature: DIAGNOSE_TEMPERATURE,
    maxTokens: DIAGNOSE_MAX_TOKENS,
    jsonMode: true,
    // 必须关掉思考：一张大卡（190 条世界书、20 万字）的材料有 59K token，不关的话
    // 模型会把 max_tokens 整个耗在推理上、一个字正文都不输出（4000 / 8000 都实测被吃干净）
    disableThinking: true,
    signal
  })
  const { issues, parsed } = parseDiagnosis(raw)
  if (!parsed) {
    // 完全没解析出东西：别当成「卡很健康」，明确报一句，免得用户以为体检跑过了
    console.warn('[card-assistant] 体检结果没解析出来：', raw.slice(0, 400))
    // 空内容和「被截断」是两回事：空内容多半是模型那边没输出（关思考之前
    // 推理 token 吃满预算就是这个形状），说成「被截断」会让人一直重试同一个错
    throw new Error(
      raw.trim()
        ? '体检结果被截断了，再试一次？'
        : '她这次一个字都没说出来（问题出在模型那边），再试一次？'
    )
  }
  return issues
}

// ── 执行一条修复 ────────────────────────────────────────────────────

function mergeLoreInput(entryId: string, rawData: Record<string, unknown> | null, patch: NonNullable<Extract<CardFix, { type: 'lore' }>['patch']>): CardLoreInput {
  const existing = readCardEntries(rawData, { includeEmpty: true }).find((entry) => entry.id === entryId)
  const base: CardLoreInput = existing
    ? {
        id: existing.id,
        name: existing.name,
        keys: existing.keys,
        secondaryKeys: existing.secondaryKeys,
        content: existing.content,
        constant: existing.constant,
        selective: existing.selective,
        position: existing.position,
        depth: existing.depth,
        order: existing.order,
        caseSensitive: existing.caseSensitive
      }
    : {
        name: '新条目',
        keys: [],
        secondaryKeys: [],
        content: '',
        constant: false,
        selective: false,
        position: 'before_char',
        depth: 4,
        order: 100,
        caseSensitive: false
      }
  return { ...base, ...patch, id: entryId || undefined }
}

/**
 * 执行一条修复并写回卡。`raw` 是界面拿到的不可信指令，先校验再落库。
 * 返回这次改动实际写了什么（供界面标记「已修复」）。
 */
export function applyCardFix(characterId: string, raw: unknown): CardFix {
  const fix = validateCardFix(raw)
  const card = getCard(characterId)
  if (!card) throw new Error('这张角色卡不在了。')
  const rawData = getCardData(characterId)

  if (fix.type === 'regex') {
    const rules = readCardRegexes(rawData, { forEditing: true })
    if (fix.remove) {
      if (!fix.ruleId) throw new Error('要删的正则没给 id')
      const target = findCardItem(rules, fix.ruleId)
      if (!target) throw new Error('找不到那条正则（卡可能改过了），重新体检一次？')
      let removed = false
      const ok = updateCardData(characterId, (data) => {
        removed = removeCardRegex(data, target.id)
      })
      if (!ok) throw new Error('角色不存在，或者这张卡里没有可写的卡数据')
      // 删不掉就不能报「已修复」：界面上会显示一个什么都没发生的 ✓
      if (!removed) throw new Error('那条正则没能删掉（卡可能改过了），重新体检一次？')
      return fix
    }
    // 模型偶尔会把 id 抄成不带 card: 前缀的样子：两种写法都认，
    // 都对不上就明确报错——绝不「找不到就当新建一条」，那会在卡里多出条重复规则
    const existing = findCardItem(rules, fix.ruleId)
    if (fix.ruleId && !existing) throw new Error('找不到那条正则（卡可能改过了），重新体检一次？')
    const base: RegexRule =
      existing ??
      ({
        id: fix.ruleId ?? '',
        name: '修复的规则',
        pattern: '',
        flags: 'g',
        replacement: '',
        target: 'display',
        enabled: true,
        order: 100,
        source: 'card',
        readonly: false
      } as RegexRule)
    const rule: RegexRule = {
      ...base,
      ...fix.patch,
      id: existing?.id ?? '',
      source: 'card',
      readonly: false
    }
    if (!rule.pattern.trim()) throw new Error('修复后的正则不能为空')
    const id = applyRegexFix(characterId, rule)
    return { ...fix, ruleId: id }
  }

  if (fix.type === 'lore') {
    const entries = readCardEntries(rawData, { includeEmpty: true })
    if (fix.remove) {
      if (!fix.entryId) throw new Error('要删的条目没给 id')
      const target = findCardItem(entries, fix.entryId)
      if (!target) throw new Error('找不到那条世界书（卡可能改过了），重新体检一次？')
      let removed = false
      const ok = updateCardData(characterId, (data) => {
        removed = removeCardLore(data, target.id)
      })
      if (!ok) throw new Error('角色不存在，或者这张卡里没有可写的卡数据')
      if (!removed) throw new Error('那条世界书没能删掉（卡可能改过了），重新体检一次？')
      return fix
    }
    const hit = findCardItem(entries, fix.entryId)
    if (fix.entryId && !hit) throw new Error('找不到那条世界书（卡可能改过了），重新体检一次？')
    const entryId = hit?.id ?? ''
    const input = mergeLoreInput(entryId, rawData, fix.patch ?? {})
    let id = entryId
    const ok = updateCardData(characterId, (data) => {
      id = upsertCardLore(data, input)
    })
    if (!ok) throw new Error('角色不存在，或者这张卡里没有可写的卡数据')
    return { ...fix, entryId: id }
  }

  // 平铺字段：走 saveCard，带上原始 data_json 以免世界书 / 正则被冲掉
  const value = fix.value
  const current = card
  saveCard({
    id: characterId,
    name: current.name,
    description: fix.field === 'description' ? value : current.description,
    personality: fix.field === 'personality' ? value : current.personality,
    scenario: fix.field === 'scenario' ? value : current.scenario,
    firstMes: fix.field === 'firstMes' ? value : current.firstMes,
    mesExample: fix.field === 'mesExample' ? value : current.mesExample,
    systemPrompt: fix.field === 'systemPrompt' ? value : current.systemPrompt,
    postHistoryInstructions:
      fix.field === 'postHistoryInstructions' ? value : current.postHistoryInstructions,
    alternateGreetings: current.alternateGreetings,
    creator: current.creator,
    creatorNotes: current.creatorNotes,
    tags: current.tags,
    avatarPath: current.avatarPath,
    rawData
  })
  return fix
}

/** upsertCardRegex 要的是「id 为空 = 新建」，这里把这条约定收在一处 */
function applyRegexFix(characterId: string, rule: RegexRule): string {
  let id = rule.id
  const ok = updateCardData(characterId, (data) => {
    id = upsertCardRegex(data, { ...rule, id: rule.id })
  })
  if (!ok) throw new Error('角色不存在，或者这张卡里没有可写的卡数据')
  return id
}
