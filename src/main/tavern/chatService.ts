// 酒馆的聊天服务：按 chat_id 从消息树组装请求体、驱动流式、把正文落回消息树。
// 不复用鲸鱼娘的 ChatSession（它是单角色单例、历史全在内存里），只复用它的 DeepSeek 客户端。
import { ipcMain, type WebContents } from 'electron'
import { loadConfig } from '../chat/config'
import { completeChat, streamChat } from '../chat/deepseek'
import { DEFAULT_MODEL, MODEL_OPTIONS } from '../chat/persona'
import { providerOfVoice } from '../chat/speech'
import { SpeechStreamer } from '../chat/speechStreamer'
import { synthesizeSpeech } from '../chat/tts'
import { streamText } from '../../shared/richText'
import { loadAppearance } from './appearance'
import { getCard, getCardData, loadProfile } from './cards'
import {
  activeLeafId,
  activePath,
  appendMessage,
  chatMaxTokens,
  chatModel,
  createChat,
  createGroupChat,
  deleteMessage,
  editMessage,
  getChat,
  getChatView,
  greetingOptions,
  groupMembers,
  GROUP_MIN_MEMBERS,
  historyUpTo,
  latestChat,
  listGroupChats,
  markInterrupted,
  MAX_TOKENS_OPTIONS,
  openChat,
  setActiveLeaf,
  setChatMaxTokens,
  setChatModel,
  type ChatSummary,
  type GroupMemberInfo
} from './chatStore'
import { buildGroupPrompt, buildGroupSystem, buildScoreMessages, parseScores } from './groupChat'
import { formatDossier } from './dossier'
import { resolveLoreEntries } from './lorebookStore'
import { extractAfterTurn, retrieveMemoryContext } from './memoryStore'
import { loadMemorySettings } from './memorySettings'
import {
  applyJsonPatch,
  extractUpdates,
  formatStatus,
  holdPartialTag,
  normalizeOps,
  objectChunks,
  parsePatch,
  type JsonPatchOp
} from './mvu'
import { readInitVars } from './mvuInit'
import { presetForChat, setChatPreset } from './presetStore'
import { requestSampling } from './preset'
import {
  buildTavernPrompt,
  substitutePlaceholders,
  substituteVariableMacros,
  type ChatMessage,
  type PromptDebug
} from './promptBuilder'
import {
  loadPromptSettings,
  resolveStyleText,
  type PromptSettings
} from './promptSettings'
import { applyRegexRules, PLACEMENT_AI_OUTPUT, PLACEMENT_USER_INPUT } from './regexEngine'
import {
  fallbackSpeaker,
  GROUP_SCORE_THRESHOLD,
  MAX_GROUP_SPEAKERS,
  parseSpeaker,
  pickNamedSpeakers,
  stripSpeakerPrefix
} from '../../shared/groupChat'
import { appendPanelPlaceholder, carryPanels, mvuPlaceholder } from './statusPanel'
import { resolveRegexes } from './regexStore'
import { latestSummary, summarizeIfDue } from './summaryStore'
import { consumeUpdates, loadOrInitVariables, loadVariables, saveVariables } from './variableStore'
import { activateLore, readCardEntries } from './worldbook'

/** 酒馆的采样参数：比桌宠放开一点，小说流需要点文笔；回复上限也别小到写不完一段。 */
const TAVERN_TEMPERATURE = 1
const TAVERN_MAX_TOKENS = 1200
const ALTERNATIVES_TIMEOUT_MS = 20_000
/** 两段式补抽变量的超时：夹在流式之后、done 之前，别让状态栏更新把收尾拖太久 */
const VARIABLE_EXTRACT_TIMEOUT_MS = 8_000

interface ActiveTurn {
  chatId: string
  characterId: string
  controller: AbortController
  /** 这一轮已经收到的原样正文（含变量更新块，落库前才洗） */
  content: string
  /**
   * 已经发给渲染层的干净正文**原文**（流式时要边洗 `<update>` 边发）。
   * 存原文而不是长度：洗标签会让 clean 变短（裸 `<json_patch>` 半截时既不进扣留名单、
   * 也不在截断剥除名单里，等它闭合才被整段摘掉），按长度取增量会从中间错位、吞字。
   */
  sentText: string
  /** 已经交给朗读的正文：只含正文段，状态栏页面（围栏 / 裸 HTML）整段不念 */
  sentSpeech: string
  /** 回复挂在哪个节点下：用户轮是刚才那条用户消息，重生成时是那条消息的父节点 */
  parentId: string | null
  target: WebContents
  /**
   * 渲染层给的轮次号，原样带回每一个事件。
   * 连发两条时上一轮的 done 会落在新一轮开始之后——没有这个号，
   * 界面会把刚画出来的新回复当成旧那轮收尾，打字显示当场断掉。
   */
  clientTurn: number
  /** 本轮用户说了什么（重生成没有新输入，为 null）。抽记忆要用 */
  userText: string | null
  /** 重生成时「被重生成那条回复对应的用户消息」，只给心动接话用 */
  altUserText: string | null
  settled: boolean
}

let active: ActiveTurn | null = null

// ── 群聊（T8）的在途一轮 ─────────────────────────────────────────────
// 一轮里可能有 1~2 个角色依次发言，共用一个 AbortController：
// 点停止 / 又发一条时整轮一起收住，而不是只收住当前这个角色。
interface GroupSpeaker {
  id: string
  name: string
}

interface GroupRound {
  chatId: string
  target: WebContents
  clientTurn: number
  controller: AbortController
  /**
   * 把当前发言人已经收到的半句同步落库（单聊 `settle` 的对应物）。
   * 打断必须同步收尾：`sendUserMessage` 紧接着就要把新用户消息挂到 `activeLeafId` 下，
   * 晚一步（等 abort 的 rejection）落库会把叶子顶回旧分支，新消息反而从界面消失。
   */
  settlePartial: (() => void) | null
}

let activeGroup: GroupRound | null = null
/** 群聊接话打分：便宜模型 + 小请求，超时就按轮换兜底 */
// 打分带推理，预算提上来后耗时也跟着涨；超时只是退回轮换，别让它拖太久
const GROUP_SCORE_TIMEOUT_MS = 10_000

/** 这一轮正在边生成边念的合成器；同一时刻只有一个（朗读默认关，关着就一直是 null） */
let activeSpeaker: SpeechStreamer | null = null
let activeTtsAbort: AbortController | null = null

/** 中止在途合成并让渲染层立刻停声（新发言 / 打断 / 新一轮开始） */
function stopSpeech(target: WebContents, chatId: string): void {
  if (!activeSpeaker && !activeTtsAbort) return
  activeTtsAbort?.abort()
  activeTtsAbort = null
  activeSpeaker?.cancel()
  activeSpeaker = null
  send(target, 'tavern:tts-stop', { chatId })
}

/** 每场会话最近一次的注入明细与心动接话（调试面板 / 输入栏上方用） */
const lastDebug = new Map<string, PromptDebug>()
const alternatives = new Map<string, string[]>()
/**
 * 心动接话的代次：用户又开口 / 重生成时 +1。
 * 生成要几秒，迟到的结果若直接写回，上一版的接话 chip 会冒回输入框上方、和新一轮回复并存。
 */
const altGen = new Map<string, number>()

/** 作废这场会话现有的接话，并让在途的生成结果失效。 */
function invalidateAlternatives(chatId: string): void {
  altGen.set(chatId, (altGen.get(chatId) ?? 0) + 1)
  alternatives.delete(chatId)
}

function send(target: WebContents, channel: string, payload?: unknown): void {
  if (target.isDestroyed()) return
  target.send(channel, payload)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return ''
    return error.message
  }
  return String(error)
}

/** 把本轮正文落成一条 assistant 消息；一个字都没有就不留空节点。 */
function settle(turn: ActiveTurn): string | null {
  if (turn.settled) return null
  turn.settled = true
  if (active === turn) active = null
  const clean = extractUpdates(turn.content).text
  if (!clean.trim()) return null
  return appendMessage(turn.chatId, turn.parentId, 'assistant', clean)
}

/** 中止在途的这一轮（点停止 / 又发了一条）。已经收到的正文照样落库。 */
function interrupt(): void {
  if (activeGroup) {
    // 半句先同步落库（和单聊的 settle 一个道理），done 仍由 startGroupRound 的 finally 统一发，
    // 否则会和那边的 done 重成两条
    activeGroup.settlePartial?.()
    activeGroup.controller.abort()
    return
  }
  if (!active) return
  const turn = active
  turn.controller.abort()
  stopSpeech(turn.target, turn.chatId)
  const messageId = settle(turn)
  // 半句落库时记一笔：界面上挂个「被打断」小标记，读起来不像莫名其妙断在一半
  if (messageId) markInterrupted(turn.chatId, messageId)
  send(turn.target, 'tavern:done', {
    chatId: turn.chatId,
    messageId,
    turn: turn.clientTurn,
    interrupted: true
  })
}

interface TurnOptions {
  /** 新回复挂在哪个节点下（用户轮是刚存的那条用户消息，重生成是那条消息的父节点） */
  parentId: string | null
  /**
   * 历史取到哪一条（含）为止。用户轮要传「用户消息的父节点」——`parentId` 此时指向
   * 刚刚落库的用户消息，含端点回溯会把它算进历史，`userText` 再追加一次就成了
   * 两条连着的相同发言（多花 token，模型还会当成重复提问）。
   */
  historyUpToId: string | null
  userText?: string
  /** 重生成时传：历史里那条用户消息的原文，心动接话要拿它当上下文 */
  altUserText?: string
  clientTurn?: number
}

/** 御言篇幅指令：最少 / 最多字数。0 表示不限制。 */
function replyInstructions(settings: PromptSettings): string[] {
  const out: string[] = []
  if (settings.replyMinChars > 0) out.push(`【篇幅】这一轮回复不少于 ${settings.replyMinChars} 字。`)
  if (settings.replyMaxChars > 0) out.push(`【篇幅】这一轮回复不超过 ${settings.replyMaxChars} 字。`)
  return out
}

/**
 * 变量系统的硬性提醒。卡的世界书里本来就有一条「变量输出格式」，但 flash 一再忽略它
 * （实测 5 轮回复里一个 `<update>` 都没有，状态栏一直停在初始值），所以在回复要求里
 * 再压一句，位置比世界书靠后、离对话更近。
 */
const MVU_INSTRUCTION =
  '【变量】这一轮回复的最后必须输出变量更新块：`<update><json_patch>[{"op":"replace","path":"/…","value":…}]</json_patch></update>`，' +
  '按世界书「变量输出格式」的规则写；这一轮没有变化就输出空数组。'

/** 这张卡到底用不用变量系统：有 `[initvar]` 初始值，或有名字带 mvu 的世界书规则条目。 */
function cardUsesMvu(rawData: Record<string, unknown> | null): boolean {
  if (readInitVars(rawData)) return true
  const book = rawData?.['character_book']
  const entries = book && typeof book === 'object' ? (book as Record<string, unknown>)['entries'] : null
  if (!Array.isArray(entries)) return false
  return entries.some((item) => {
    if (!item || typeof item !== 'object') return false
    const entry = item as Record<string, unknown>
    const label = `${String(entry['comment'] ?? '')} ${String(entry['name'] ?? '')}`
    return /mvu/i.test(label)
  })
}

/** 这一轮用哪个模型：会话选过的优先，没选过才跟随全局配置。 */
function modelFor(chatId: string): string {
  return chatModel(chatId) ?? loadConfig().model
}

/** 这一轮的回复上限：会话选过就用它，否则全局默认（1200）。 */
function maxTokensFor(chatId: string): number {
  return chatMaxTokens(chatId) ?? TAVERN_MAX_TOKENS
}

/**
 * 卡里 `[mvu_update]…` 的世界书正文（「变量更新规则」「变量输出格式」）。
 * 这些条目本来就是写给模型看的更新指令，但主回复常常整段忽略；
 * 补抽时把它们一起喂回去，等于「在低温下把那套规则重跑一遍」。
 * 不吃 `enabled` 过滤：MVU 的规则条目照样可能是关着的（怕它挤占提示词）。
 */
function readMvuRuleTexts(rawData: Record<string, unknown> | null): string[] {
  const book = rawData?.['character_book']
  const entries = book && typeof book === 'object' ? (book as Record<string, unknown>)['entries'] : null
  if (!Array.isArray(entries)) return []
  const texts: string[] = []
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const label = `${String(entry['comment'] ?? '')} ${String(entry['name'] ?? '')}`
    if (!/mvu_update/i.test(label)) continue
    const content = typeof entry['content'] === 'string' ? entry['content'].trim() : ''
    if (content) texts.push(content)
  }
  return texts
}

/**
 * 两段式补抽：主回复漏了 `<update>` 块时，再跑一次低温度、只做 JSON 的小请求，
 * 只让模型吐出本轮的 JSON Patch。flash 在高温多任务下跟不住结构化输出，
 * 「只做一件事 + 低温度」比在同一轮里再压一遍提示词可靠得多。
 *
 * 提示词里必须带上卡自己的更新规则：只给「当前变量 + 这段剧情」的话，
 * 模型不知道这张卡的时间怎么推进（时辰对照表）、任务 / 地点该怎么维护，
 * 抽回来的永远是空数组——状态栏就停在初始值上（实测运行库：剧情已经入夜，
 * 变量还是「卯时」）。
 */
const MVU_EXTRACT_INSTRUCTION =
  '你是变量更新提取器。读下面这段剧情，输出这一轮应该应用到会话变量上的更新。' +
  '只输出一个 JSON 对象：{"operations":[{"op":"replace","path":"/世界/当前时间","value":"黄昏"}]}，' +
  'operations 是 RFC 6902 patch 数组（op 只能是 add / replace / remove / test），不要解释、不要 markdown 代码块。' +
  '只能改「当前变量」里已存在的路径，没有变化就输出 {"operations":[]}。'

/**
 * 截断抢救：JSON 模式被 `max_tokens` 砍在半截时，整体不是合法 JSON
 * （外层对象都没闭合，`parsePatch` 的 objectChunks 也抠不出来），
 * 但数组里前面那些 op 对象是完整的。切到 `"operations":[` 之后再逐个抠。
 */
function salvageOps(text: string): JsonPatchOp[] {
  const at = text.search(/"operations"\s*:\s*\[/)
  const from = at >= 0 ? text.indexOf('[', at) : -1
  const body = from >= 0 ? text.slice(from) : text
  const ops: JsonPatchOp[] = []
  for (const chunk of objectChunks(body)) {
    if (!/"op"/.test(chunk)) continue
    try {
      ops.push(...normalizeOps([JSON.parse(chunk)]))
    } catch {
      // 最后那个被砍断的对象，跳过
    }
  }
  return ops
}

/**
 * 解析补抽结果。优先按 JSON 模式的对象外壳 `{"operations":[…]}` 解；
 * 解析不了就抢救被截断的完整 op 对象，再不行才回退 `parsePatch` 的自由文本容错。
 */
function parseExtraction(raw: string): JsonPatchOp[] {
  const text = raw.trim()
  if (!text) return []
  try {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed)) return normalizeOps(parsed)
    if (parsed && typeof parsed === 'object') {
      const operations = (parsed as Record<string, unknown>)['operations']
      if (Array.isArray(operations)) return normalizeOps(operations)
    }
  } catch {
    // 不是合法 JSON：走下面的抢救 / 容错
  }
  const salvaged = salvageOps(text)
  if (salvaged.length > 0) return salvaged
  return parsePatch(text)
}

async function extractVariablesByModel(
  chatId: string,
  reply: string,
  userText: string,
  rawData: Record<string, unknown> | null,
  signal: AbortSignal
): Promise<JsonPatchOp[]> {
  const config = loadConfig()
  if (!config.apiKey) return []
  const current = JSON.stringify(loadVariables(chatId), null, 2)
  // 规则是这张卡写的，长度不定（萝莉师父那张两条加起来 6600 字）；两段一起截，
  // 但别截到 4000 以下——被切掉的多半是「输出格式」那半，规则正文也会跟着少一半
  const rules = readMvuRuleTexts(rawData).join('\n\n').slice(0, 6000)
  const system = rules
    ? `${MVU_EXTRACT_INSTRUCTION}\n\n【这张卡的变量更新规则】必须照它推进变量（时间 / 地点 / 任务该变就得变）：\n${rules}`
    : MVU_EXTRACT_INSTRUCTION
  try {
    const raw = await completeChat({
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content:
            `当前变量：\n${current.slice(0, 2000)}` +
            (userText.trim() ? `\n\n玩家的行动：\n${userText.slice(0, 400)}` : '') +
            `\n\n本轮剧情：\n${reply.slice(0, 2000)}`
        }
      ],
      apiKey: config.apiKey,
      model: modelFor(chatId),
      temperature: 0.2,
      // 800 不够：一轮常常要改 5–7 条，`当前想法 / 当前状态 / 当前穿着` 每条都是
      // 几十字中文，再加上 reasoning 模型的思考 token 也算这个预算——输出会被砍在
      // 半截字符串上，JSON 直接不合法，变量静默不动（实测就是这个）。给足 4000。
      maxTokens: 4000,
      // JSON 模式：让接口保证输出是合法 JSON，不再靠正则从自由文本里猜
      jsonMode: true,
      signal
    })
    const ops = parseExtraction(raw)
    // 抽到了内容却一条 op 都解不出来 = 解析链路有问题，不能静默
    if (ops.length === 0 && raw.trim()) {
      console.warn('[tavern] 变量补抽解不出 op，原始返回：', raw.slice(0, 500))
    }
    return ops
  } catch (error) {
    console.warn('[tavern] 变量补抽失败', error)
    return []
  }
}

/** 这一轮结束后才做的事：抽永久记忆、到间隔了摘要档案、心动接话。失败静默。 */
function afterTurn(turn: ActiveTurn, settings: PromptSettings): void {
  const content = extractUpdates(turn.content).text
  // 心动接话：重生成没有新一轮输入，就拿被重生成那条回复所对应的用户消息当上下文
  // （不这么做的话，输入栏上会一直停着上一版回复的接话）
  const altPrompt = turn.userText ?? turn.altUserText
  if (settings.altCount > 0 && altPrompt && content.trim()) {
    void makeAlternatives(turn, altPrompt, content, settings.altCount)
  }
  // 抽记忆 / 摘要只认真正的新一轮用户输入
  if (!turn.userText || !content.trim()) return
  void extractAfterTurn({
    characterId: turn.characterId,
    userText: turn.userText,
    assistantText: content
  }).finally(() => {
    void summarizeIfDue(turn.chatId, (active) =>
      send(turn.target, 'tavern:summary', { chatId: turn.chatId, active })
    )
  })
}

/**
 * 心动接话：让模型给「用户」写几句可以接的话，点一下就能发。
 * 异步、失败静默——它是输入栏的便利贴，不是聊天的一部分。
 */
async function makeAlternatives(
  turn: ActiveTurn,
  userText: string,
  reply: string,
  count: number
): Promise<void> {
  const config = loadConfig()
  if (!config.apiKey) return
  const card = getCard(turn.characterId)
  if (!card) return
  const profile = loadProfile()
  const gen = altGen.get(turn.chatId) ?? 0
  try {
    const raw = await completeChat({
      messages: [
        {
          role: 'system',
          content:
            `你正在为「${profile.name}」代写 ${count} 句可以接下去说的话，回复给「${card.name}」。` +
            '只输出 JSON 字符串数组，每句不超过 30 字，风格自然、各不相同，不要编号、不要解释。'
        },
        {
          role: 'user',
          content: `刚才的对话：\n${userText}\n${card.name}：${reply.slice(0, 800)}`
        }
      ],
      apiKey: config.apiKey,
      model: modelFor(turn.chatId),
      temperature: 0.9,
      maxTokens: 200,
      signal: AbortSignal.timeout(ALTERNATIVES_TIMEOUT_MS)
    })
    const start = raw.indexOf('[')
    const end = raw.lastIndexOf(']')
    if (start < 0 || end <= start) return
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(parsed)) return
    const list = parsed
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .slice(0, count)
    if (list.length === 0) return
    // 生成期间用户又开口了：这一版接话作废，别画回输入框
    if ((altGen.get(turn.chatId) ?? 0) !== gen) return
    alternatives.set(turn.chatId, list)
    send(turn.target, 'tavern:alternatives', { chatId: turn.chatId, items: list })
  } catch (error) {
    console.warn('[tavern] 心动接话生成失败', error)
  }
}

function startTurn(target: WebContents, chatId: string, options: TurnOptions): void {
  const chat = getChat(chatId)
  const card = chat ? getCard(chat.characterId) : null
  const config = loadConfig()
  const clientTurn = options.clientTurn ?? 0
  if (!card || !chat) {
    send(target, 'tavern:error', { chatId, message: '角色不存在。', turn: clientTurn })
    return
  }
  if (!config.apiKey) {
    send(target, 'tavern:error', {
      chatId,
      message: '还没有配置 API Key。按 Ctrl+Shift+Space 打开输入栏，点「设置」填一下？',
      turn: clientTurn
    })
    return
  }

  const turn: ActiveTurn = {
    chatId,
    characterId: chat.characterId,
    controller: new AbortController(),
    content: '',
    sentText: '',
    sentSpeech: '',
    parentId: options.parentId,
    target,
    clientTurn,
    userText: options.userText?.trim() || null,
    altUserText: options.altUserText?.trim() || null,
    settled: false
  }
  // 先登记再 await：等内存检索的这几百毫秒里用户又发一条，interrupt() 能立刻收住这一轮
  active = turn

  // 朗读（T5，默认关）：上一轮可能还在念，先收住，再按本轮开关决定要不要开口
  stopSpeech(target, chatId)
  const appearance = loadAppearance()
  const useQwen = config.qwenKey.length > 0 && providerOfVoice(config.voice) === 'qwen'
  const ttsAbort = new AbortController()
  const speaker = appearance.ttsEnabled
    ? new SpeechStreamer({
        synthesize: (text) =>
          synthesizeSpeech(text, {
            voice: config.voice,
            qwen: useQwen ? { key: config.qwenKey } : null,
            signal: ttsAbort.signal
          }),
        onAudio: ({ audio, mime, more }) => {
          if (ttsAbort.signal.aborted) return
          send(target, 'tavern:tts', {
            chatId,
            audio: audio.toString('base64'),
            mime,
            more
          })
        },
        onEnd: () => {
          if (activeSpeaker === speaker) activeSpeaker = null
          if (activeTtsAbort === ttsAbort) activeTtsAbort = null
          if (!ttsAbort.signal.aborted) send(target, 'tavern:tts-end', { chatId })
        }
      })
    : null
  if (speaker) {
    activeSpeaker = speaker
    activeTtsAbort = ttsAbort
  }

  const cardData = getCardData(card.id)
  const memory = loadMemorySettings()
  const settings = loadPromptSettings()
  const preset = presetForChat(chatId)
  const sampling = requestSampling(preset, TAVERN_TEMPERATURE, maxTokensFor(chatId))

  // 提示词侧的正则先过一遍：卡里「对 AI 隐藏状态栏」这类规则就是 promptOnly
  const promptRules = resolveRegexes({ characterId: card.id, target: 'prompt', cardData })
  const rawHistory = historyUpTo(chatId, options.historyUpToId) as ChatMessage[]
  // 深度按「距本轮最新一条」算（最新 = 0）：卡里「只输出最后三条状态栏」这种规则
  // 就是靠 minDepth 把更早的历史状态栏洗掉，少给模型几 KB 旧面板
  const lastHistory = rawHistory.length - 1
  const history = rawHistory.map((item, index) => ({
    role: item.role,
    content: applyRegexRules(item.content, promptRules, 'prompt', [], {
      // ST 里本轮用户输入才是第 0 层，历史按距离顺延：最后一条历史是 1。
      // 历史最后一条也算 0 的话，`maxDepth: 0`（只洗当前消息）的规则会连带改掉上一轮回复，
      // 而 `minDepth: 1`（折叠历史）的规则反倒漏掉最新那条历史
      depth: lastHistory - index + 1,
      placement: item.role === 'user' ? PLACEMENT_USER_INPUT : PLACEMENT_AI_OUTPUT
    })
  }))
  const userText = options.userText ?? ''

  void (async () => {
    try {
      let memoryContext = ''
      try {
        // 检索范围：最近几条消息 + 本轮输入一起当查询（让「接着刚才那个话题」也能想起来）
        const query = [
          ...history.slice(-memory.memoryRange).map((item) => item.content),
          userText
        ]
          .filter(Boolean)
          .join('\n')
        memoryContext = await retrieveMemoryContext(chat.characterId, query)
      } catch (error) {
        // 检索是增强：出错就当没有记忆，绝不能挡住这句回复
        console.warn('[tavern] 记忆检索失败，这一轮不带记忆', error)
      }
      if (turn.controller.signal.aborted || active !== turn) return

      const dossier = memory.archiveEnabled ? latestSummary(chatId)?.dossier : null
      // 变量只要 MVU 开着就取出来：卡里的 `{{format_message_variable::stat_data}}`
      // 靠它填实时状态，`statusInPrompt` 只是「额外再补一段」的开关
      const variableLines = settings.mvuEnabled
        ? formatStatus(loadOrInitVariables(chatId, card.id)).join('\n')
        : ''
      const statusText = settings.statusInPrompt ? variableLines : ''
      const built = buildTavernPrompt({
        card,
        profile: loadProfile(),
        history,
        userText: applyRegexRules(userText, promptRules, 'prompt', [], {
          depth: 0,
          placement: PLACEMENT_USER_INPUT
        }),
        rawData: cardData,
        lore: resolveLoreEntries({
          characterId: card.id,
          chatId,
          cardEntries: readCardEntries(cardData)
        }),
        loreBudget: settings.loreBudget,
        scanDepth: settings.scanDepth,
        dossier: dossier ? formatDossier(dossier) : '',
        memoryContext,
        recentLimit: memory.visionEnabled ? memory.visionDepth : undefined,
        fullVision: memory.visionEnabled && memory.fullVision,
        styleText: settings.styleId ? resolveStyleText(settings) : '',
        statusText,
        statData: variableLines,
        instructions: [
          ...replyInstructions(settings),
          ...(settings.mvuEnabled && cardUsesMvu(cardData) ? [MVU_INSTRUCTION] : [])
        ],
        preset,
        depthPrompt: readDepthPrompt(cardData, { char: card.name, user: loadProfile().name })
      })
      lastDebug.set(chatId, built.debug)

      await streamChat({
        messages: built.messages,
        apiKey: config.apiKey,
        model: modelFor(chatId),
        temperature: sampling.temperature,
        maxTokens: sampling.maxTokens,
        signal: turn.controller.signal,
        onToken: (delta) => {
          if (turn.controller.signal.aborted) return
          turn.content += delta
          // 边流边洗：变量更新块 / 状态描述不能给用户看到半个 JSON。
          // 末尾可能是半个标签（`<upd`），先扣住，下一块拼上再说
          const clean = holdPartialTag(extractUpdates(turn.content).text)
          // 已发出去的那段必须仍然是 clean 的前缀，增量才是干净的。
          // 洗标签可能让 clean 缩短或改写（半截标签闭合后整段被摘掉），这时按长度
          // 取增量会从中间错位、吞掉字；这一块先不发，等 done 之后整页重绘兜底。
          if (clean.startsWith(turn.sentText)) {
            const fresh = clean.slice(turn.sentText.length)
            turn.sentText = clean
            if (fresh) {
              send(target, 'tavern:token', { chatId, delta: fresh, turn: clientTurn })
              // 朗读只念正文：状态栏页面（```html 围栏 / 裸 HTML）整段跳过，否则 TTS 会把
              // 十几 KB 的标签和状态文本一句句念出来。切段规则与渲染层藏代码共用一份
              const speech = streamText(clean)
              if (speech.startsWith(turn.sentSpeech)) {
                const spoken = speech.slice(turn.sentSpeech.length)
                turn.sentSpeech = speech
                if (spoken) speaker?.push(spoken)
              }
            }
          }
        }
      })
      if (turn.settled) return
      // 正文写完：尾巴那句也交给合成队列；后面继续在后台念，不挡 done
      speaker?.end()
      // 变量系统：把更新块应用到会话状态上（开关关着就只洗掉，不落状态）
      if (settings.mvuEnabled) {
        let { ops } = consumeUpdates(chatId, turn.content)
        // 主回复一个更新块都没吐（flash 常见）：补一次低温度小请求，只抽 JSON Patch。
        // 必须在 settle/done 之前补上——done 会让渲染层带着最新变量重绘状态栏。
        if (ops.length === 0 && cardUsesMvu(cardData)) {
          const clean = extractUpdates(turn.content).text
          const patched = await extractVariablesByModel(
            chatId,
            clean,
            turn.userText ?? turn.altUserText ?? '',
            cardData,
            AbortSignal.timeout(VARIABLE_EXTRACT_TIMEOUT_MS)
          )
          if (patched.length > 0) {
            saveVariables(chatId, applyJsonPatch(loadVariables(chatId), patched))
            ops = patched
          }
        }
        if (ops.length > 0) {
          send(target, 'tavern:variables', { chatId, lines: formatStatus(loadVariables(chatId)) })
        }
      }
      const messageId = settle(turn)
      send(target, 'tavern:done', { chatId, messageId, turn: clientTurn })
      afterTurn(turn, settings)
    } catch (error) {
      if (turn.settled) return
      // 这一轮失败了：别再往下念半截话
      speaker?.cancel()
      ttsAbort.abort()
      send(target, 'tavern:tts-stop', { chatId })
      const messageId = settle(turn)
      const message = errorMessage(error)
      // 被打断的那一轮已由 interrupt() 发过 done，这里不重复报错
      if (!message) {
        send(target, 'tavern:done', { chatId, messageId, turn: clientTurn, interrupted: true })
        return
      }
      send(target, 'tavern:error', { chatId, message, turn: clientTurn })
    }
  })()
}

/** 卡的 extensions.depth_prompt（深度注入 / 思维链），空内容就是没有 */
function readDepthPrompt(
  cardData: Record<string, unknown> | null,
  names: { char: string; user: string }
): { text: string; depth: number; role: 'system' | 'user' | 'assistant' } | null {
  const extensions = cardData?.['extensions']
  if (!extensions || typeof extensions !== 'object') return null
  const raw = (extensions as Record<string, unknown>)['depth_prompt']
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const text = typeof record['prompt'] === 'string' ? record['prompt'].trim() : ''
  if (!text) return null
  const role =
    record['role'] === 'user' || record['role'] === 'assistant' ? record['role'] : 'system'
  return {
    text: substitutePlaceholders(text, names),
    depth: typeof record['depth'] === 'number' ? record['depth'] : 4,
    role
  }
}

// ── 群聊（T8） ──────────────────────────────────────────────────────

function toSpeaker(member: GroupMemberInfo): GroupSpeaker {
  return { id: member.id, name: member.name }
}

/**
 * 谁接话的打分。返回 null = 这次没打成（没 Key / 超时 / 解析不了），
 * 由调用方按轮换兜底，不能因为打分失败就没人说话。
 */
async function scoreGroupSpeakers(
  members: GroupMemberInfo[],
  history: string[],
  userText: string,
  signal: AbortSignal
): Promise<Record<string, number> | null> {
  const config = loadConfig()
  if (!config.apiKey) return null
  const names = members.map((member) => member.name)
  try {
    const raw = await completeChat({
      messages: buildScoreMessages(names, history, userText),
      apiKey: config.apiKey,
      // 打分用最便宜的模型：这轮要不要说话，不值得上 pro
      model: DEFAULT_MODEL,
      temperature: 0,
      // 推理 token 和正文共用预算：给 800 会被思考吃光，返回空串 → 打分永远失效
      maxTokens: 2000,
      jsonMode: true,
      signal: AbortSignal.any([signal, AbortSignal.timeout(GROUP_SCORE_TIMEOUT_MS)])
    })
    const scores = parseScores(raw, names)
    if (!scores) console.warn('[tavern] 群聊打分结果解析不了，按轮换兜底：', raw.slice(0, 200))
    return scores
  } catch (error) {
    if (!signal.aborted) console.warn('[tavern] 群聊接话打分失败，按轮换兜底', error)
    return null
  }
}

/** 这一轮谁来发言：被 @ 的人必回；否则打分过阈值的最多两个；都不行就轮流。 */
async function chooseGroupSpeakers(
  chatId: string,
  members: GroupMemberInfo[],
  userText: string,
  signal: AbortSignal
): Promise<GroupSpeaker[]> {
  const names = members.map((member) => member.name)
  const named = pickNamedSpeakers(userText, names)
  if (named.length > 0) {
    return members.filter((member) => named.includes(member.name)).slice(0, MAX_GROUP_SPEAKERS).map(toSpeaker)
  }
  const history = activePath(chatId).slice(-6).map((item) => item.content)
  const scores = await scoreGroupSpeakers(members, history, userText, signal)
  if (scores) {
    const picked = members
      .map((member) => ({ member, score: scores[member.name] ?? 0 }))
      .filter((item) => item.score >= GROUP_SCORE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_GROUP_SPEAKERS)
      .map((item) => toSpeaker(item.member))
    if (picked.length > 0) return picked
  }
  const fallback = fallbackSpeaker(names, activePath(chatId).length)
  const member = members.find((item) => item.name === fallback) ?? members[0]!
  return [toSpeaker(member)]
}

/**
 * 依次让这一轮选中的角色发言。每个角色一次独立请求：把「这一轮轮到你」写进
 * system，比让一个模型同时演三个人稳定得多；前一个人说的话会进下一个人看到的历史。
 */
async function runGroupSpeakers(
  group: GroupRound,
  chat: ChatSummary,
  members: GroupMemberInfo[],
  options: {
    parentId: string | null
    historyUpToId: string | null
    userText: string | null
    speakers: GroupSpeaker[]
    clientTurn: number
  }
): Promise<string | null> {
  const config = loadConfig()
  const profile = loadProfile()
  const settings = loadPromptSettings()
  const styleText = settings.styleId ? resolveStyleText(settings) : ''
  const names = members.map((member) => member.name)
  // 每个成员的两层世界书（全局 + 角色 + 卡内嵌）合并；重复的全局条目由 activateLore 去重
  const lore = members.flatMap((member, index) =>
    resolveLoreEntries({
      characterId: member.id,
      chatId: index === 0 ? group.chatId : null,
      cardEntries: readCardEntries(getCardData(member.id))
    })
  )

  let replyParent = options.parentId
  let historyTo = options.historyUpToId
  let userText = options.userText ?? ''
  let lastMessageId: string | null = null

  for (const [index, speaker] of options.speakers.entries()) {
    if (group.controller.signal.aborted) break
    // 渲染层收到这个事件才另起一条消息、把发言人的名字画上去
    send(group.target, 'tavern:speaker', {
      chatId: group.chatId,
      turn: options.clientTurn,
      index,
      name: speaker.name
    })
    const history = historyUpTo(group.chatId, historyTo)
    const scan = [...history.slice(-6).map((item) => item.content), userText].join('\n')
    const activeLore = activateLore(lore, scan, settings.loreBudget).active
    const system = buildGroupSystem({
      groupName: chat.title,
      members,
      profile,
      speaker: speaker.name,
      lore: activeLore,
      styleText
    })
    const messages = buildGroupPrompt({ system, history, userText })

    let raw = ''
    let sent = ''
    // 打断 / 停止时 interrupt() 会同步调这个：把屏幕上已经显示的半句落库，
    // 并且只落一次（catch 里还会再调一次，那是个空操作）
    group.settlePartial = () => {
      group.settlePartial = null
      const partial = extractUpdates(stripSpeakerPrefix(raw, names)).text.trim()
      if (!partial) return
      lastMessageId = appendMessage(
        group.chatId,
        replyParent,
        'assistant',
        `${speaker.name}：${partial}`
      )
      markInterrupted(group.chatId, lastMessageId)
      replyParent = lastMessageId
      historyTo = lastMessageId
    }
    try {
      await streamChat({
        messages,
        apiKey: config.apiKey,
        model: modelFor(chat.id),
        temperature: TAVERN_TEMPERATURE,
        maxTokens: maxTokensFor(chat.id),
        signal: group.controller.signal,
        onToken: (delta) => {
          if (group.controller.signal.aborted) return
          raw += delta
          // 模型偶尔无视「别写名字」，开头会带「阿蕾：」：洗掉再显示。
          // 半个名字先扣住，别让界面上先闪一个「阿」
          const clean = holdPartialTag(stripSpeakerPrefix(raw, names))
          if (!clean.startsWith(sent)) return
          const fresh = clean.slice(sent.length)
          sent = clean
          if (fresh) {
            send(group.target, 'tavern:token', {
              chatId: group.chatId,
              turn: options.clientTurn,
              delta: fresh
            })
          }
        }
      })
    } catch (error) {
      // 被打断时屏幕上已经显示的那半句要落库，否则界面一刷新就凭空消失。
      // interrupt() 已经同步落过的话这里就是空操作
      group.settlePartial?.()
      throw error
    }
    // 正文完整回来了：这之后没有半句可收，免得停止按钮再补一条重复的
    group.settlePartial = null

    const text = extractUpdates(stripSpeakerPrefix(raw, names)).text.trim()
    if (!text) continue
    lastMessageId = appendMessage(
      group.chatId,
      replyParent,
      'assistant',
      `${speaker.name}：${text}`
    )
    replyParent = lastMessageId
    historyTo = lastMessageId
    userText = ''
  }
  group.settlePartial = null
  return lastMessageId
}

/**
 * 开一轮群聊：先选人，再依次发言。收尾（done）只在这里发一次，
 * 打断 / 出错 / 正常结束都走 finally，避免界面上收到两条 done。
 */
async function startGroupRound(
  target: WebContents,
  chatId: string,
  options: {
    parentId: string | null
    historyUpToId: string | null
    userText: string | null
    clientTurn: number
    /** 重生成时直接指定发言人，不再打分 */
    speakers?: GroupSpeaker[]
  }
): Promise<void> {
  const chat = getChat(chatId)
  const members = groupMembers(chatId)
  if (!chat || members.length < GROUP_MIN_MEMBERS) {
    send(target, 'tavern:error', { chatId, message: '这场群聊不在了。', turn: options.clientTurn })
    return
  }
  const config = loadConfig()
  if (!config.apiKey) {
    send(target, 'tavern:error', {
      chatId,
      message: '还没有配置 API Key。按 Ctrl+Shift+Space 打开输入栏，点「设置」填一下？',
      turn: options.clientTurn
    })
    return
  }

  const group: GroupRound = {
    chatId,
    target,
    clientTurn: options.clientTurn,
    controller: new AbortController(),
    settlePartial: null
  }
  // 先登记：打分要几百毫秒，这期间用户又发一条 / 点停止都能立刻收住
  activeGroup = group
  stopSpeech(target, chatId)

  let messageId: string | null = null
  try {
    const speakers =
      options.speakers ??
      (await chooseGroupSpeakers(chatId, members, options.userText ?? '', group.controller.signal))
    if (!group.controller.signal.aborted && speakers.length > 0) {
      messageId = await runGroupSpeakers(group, chat, members, { ...options, speakers })
    }
  } catch (error) {
    const detail = errorMessage(error)
    if (detail) send(target, 'tavern:error', { chatId, message: detail, turn: options.clientTurn })
  } finally {
    if (activeGroup === group) {
      activeGroup = null
      group.settlePartial = null
    }
    send(target, 'tavern:done', {
      chatId,
      messageId,
      turn: options.clientTurn,
      interrupted: group.controller.signal.aborted
    })
  }
}

/** 用户发一条消息：先落库（界面立刻能看到），再组装请求。 */
function sendUserMessage(
  target: WebContents,
  chatId: string,
  text: string,
  clientTurn: number
): void {
  const trimmed = text.trim()
  if (!trimmed) return
  const chat = getChat(chatId)
  if (!chat) {
    send(target, 'tavern:error', { chatId, message: '这场对话不在了。', turn: clientTurn })
    return
  }
  // 又发一条：先把上一轮收住（已收到的正文落库），再开新的
  interrupt()
  // 用户自己开口了：上一次的「心动接话」不再适用
  invalidateAlternatives(chatId)
  const parentId = activeLeafId(chatId)
  const userMessageId = appendMessage(chatId, parentId, 'user', trimmed)
  if (chat.isGroup) {
    void startGroupRound(target, chatId, {
      parentId: userMessageId,
      historyUpToId: parentId,
      userText: trimmed,
      clientTurn
    })
    return
  }
  startTurn(target, chatId, {
    parentId: userMessageId,
    // 历史到这条用户消息的父节点为止：它自己由 userText 追加一次
    historyUpToId: parentId,
    userText: trimmed,
    clientTurn
  })
}

/** 重生成：同一个父节点下再长一条分支，旧回复留在树里可切回。 */
function regenerate(
  target: WebContents,
  chatId: string,
  messageId: string,
  clientTurn: number
): void {
  const view = getChatView(chatId)
  const message = view?.messages.find((item) => item.id === messageId)
  if (!message) {
    send(target, 'tavern:error', { chatId, message: '这条消息不在了。', turn: clientTurn })
    return
  }
  interrupt()
  // 重生成没有新输入：历史到父节点（通常是那条用户消息）为止，不再追加 userText
  const prompt = message.parentId
    ? view?.messages.find((item) => item.id === message.parentId)?.content
    : undefined
  // 上一版回复的接话立刻作废：等新的正文出来再补一份（重生成也可能失败）
  invalidateAlternatives(chatId)
  send(target, 'tavern:alternatives', { chatId, items: [] })
  if (view?.chat.isGroup) {
    // 群聊里重生成某一条 = 让那个发言人把这句话重说一遍，不重新挑人
    const names = view.members.map((member) => member.name)
    const parsed = parseSpeaker(message.content, names)
    const member = view.members.find((item) => item.name === parsed.speaker) ?? view.members[0]!
    void startGroupRound(target, chatId, {
      parentId: message.parentId,
      historyUpToId: message.parentId,
      userText: null,
      clientTurn,
      speakers: [toSpeaker(member)]
    })
    return
  }
  startTurn(target, chatId, {
    parentId: message.parentId,
    historyUpToId: message.parentId,
    altUserText: prompt,
    clientTurn
  })
}

/**
 * 重发一条悬空的用户消息（崩溃 / 强退后这一轮没有回复）。
 * 和重生成的区别：回复挂在**这条用户消息**下面，用户消息不重新落库。
 */
function resend(target: WebContents, chatId: string, messageId: string, clientTurn: number): void {
  const view = getChatView(chatId)
  const message = view?.messages.find((item) => item.id === messageId)
  if (!message || message.role !== 'user') {
    send(target, 'tavern:error', { chatId, message: '这条消息不在了。', turn: clientTurn })
    return
  }
  interrupt()
  invalidateAlternatives(chatId)
  send(target, 'tavern:alternatives', { chatId, items: [] })
  if (view?.chat.isGroup) {
    // 群聊：历史到用户消息的父节点，这句话由 userText 带进本轮
    void startGroupRound(target, chatId, {
      parentId: messageId,
      historyUpToId: message.parentId,
      userText: message.content,
      clientTurn
    })
    return
  }
  // 单聊：历史取到这条用户消息为止（含），不再追加 userText，免得出现两条相同的发言
  startTurn(target, chatId, {
    parentId: messageId,
    historyUpToId: messageId,
    altUserText: message.content,
    clientTurn
  })
}

/**
 * 显示侧正则在出库时套用：正文本身还是原文，切分支 / 改规则都能重算。
 * `{{user}}` / `{{char}}` 也在这里替换——开场白里到处是占位符，
 * 不换成真名的话界面上就是「{{user}}的小院……」。
 */
function withDisplay(view: ReturnType<typeof getChatView>): ReturnType<typeof getChatView> {
  if (!view) return view
  // 群聊不走单卡那套显示正则 / 状态栏：几条规则混着套会把别人的台词一起洗掉。
  // 只替换占位符——`{{char}}` 按这条消息的发言人算，`{{user}}` 是玩家
  if (view.chat.isGroup) {
    const user = loadProfile().name
    const names = view.members.map((member) => member.name)
    return {
      ...view,
      messages: view.messages.map((item) => {
        const speaker = item.role === 'assistant' ? parseSpeaker(item.content, names).speaker : null
        return {
          ...item,
          content: substitutePlaceholders(item.content, {
            char: speaker ?? view.chat.title,
            user
          })
        }
      })
    }
  }
  // 卡里的 `[initvar]` 初始变量：状态栏页面照 stat_data 画的，不初始化就全是 N/A
  const state = loadOrInitVariables(view.chat.id, view.character.id)
  const rules = resolveRegexes({
    characterId: view.character.id,
    target: 'display',
    cardData: getCardData(view.character.id)
  })
  const names = { char: view.character.name, user: loadProfile().name }
  // MVU 卡：先照真扩展的做派，把占位标签补到最后一条回复上（状态页由此重新出现）；
  // 剩下「模型自己写状态块」的卡，沿用上一次的原块补上，别让面板聊完一轮就消失
  const placeholder = mvuPlaceholder(rules)
  const messages = placeholder ? appendPanelPlaceholder(view.messages, placeholder) : view.messages
  const extra = carryPanels(messages, rules)
  const last = messages.length - 1
  return {
    ...view,
    messages: messages.map((item, index) => ({
      ...item,
      content: substituteVariableMacros(
        substitutePlaceholders(
          applyRegexRules(item.content + (extra.get(item.id) ?? ''), rules, 'display', [], {
            // 「折叠历史状态栏」这类规则靠深度区分历史与当前，最新一条是 0
            depth: last - index,
            placement: item.role === 'user' ? PLACEMENT_USER_INPUT : PLACEMENT_AI_OUTPUT
          }),
          names
        ),
        state
      )
    }))
  }
}

export function registerTavernChatIpc(): void {
  // 点角色进聊天：有会话就接着上次，没有就开一场（开场白作为第一条消息）
  ipcMain.handle('tavern:chat-open', (_event, characterId: string) => {
    if (!getCard(characterId)) return null
    const chat = openChat(characterId)
    return withDisplay(getChatView(chat.id))
  })
  ipcMain.handle('tavern:chat-new', (_event, characterId: string) => {
    if (!getCard(characterId)) return null
    return withDisplay(getChatView(createChat(characterId).id))
  })
  // 第一次进这张卡：有没有旧会话 + 可选的开场白（占位符已替换，直接给界面看）
  ipcMain.handle('tavern:chat-greetings', (_event, characterId: string) => {
    const card = getCard(characterId)
    if (!card) return null
    const names = { char: card.name, user: loadProfile().name }
    return {
      hasChat: latestChat(characterId) !== null,
      options: greetingOptions(characterId).map((text) => substitutePlaceholders(text, names))
    }
  })
  // 选了开场白再开场：greetingIndex = null 表示不要开场白
  ipcMain.handle(
    'tavern:chat-start',
    (_event, payload: { characterId: string; greetingIndex: number | null }) => {
      if (!getCard(payload.characterId)) return null
      const chat = createChat(payload.characterId, Math.random, payload.greetingIndex)
      return withDisplay(getChatView(chat.id))
    }
  )
  ipcMain.handle('tavern:chat-view', (_event, chatId: string) => withDisplay(getChatView(chatId)))

  ipcMain.on(
    'tavern:chat-send',
    (event, payload: { chatId: string; text: string; turn?: number }) => {
      sendUserMessage(event.sender, payload.chatId, payload.text ?? '', payload.turn ?? 0)
    }
  )
  ipcMain.on(
    'tavern:chat-regenerate',
    (event, payload: { chatId: string; messageId: string; turn?: number }) => {
      regenerate(event.sender, payload.chatId, payload.messageId, payload.turn ?? 0)
    }
  )
  ipcMain.on(
    'tavern:chat-resend',
    (event, payload: { chatId: string; messageId: string; turn?: number }) => {
      resend(event.sender, payload.chatId, payload.messageId, payload.turn ?? 0)
    }
  )
  ipcMain.on('tavern:chat-stop', () => interrupt())

  ipcMain.handle('tavern:chat-edit', (_event, payload: { messageId: string; content: string }) => {
    editMessage(payload.messageId, payload.content)
  })
  ipcMain.handle('tavern:chat-delete', (_event, messageId: string) => {
    deleteMessage(messageId)
  })
  ipcMain.handle('tavern:chat-branch', (_event, payload: { chatId: string; messageId: string }) => {
    setActiveLeaf(payload.chatId, payload.messageId)
    return withDisplay(getChatView(payload.chatId))
  })

  // 调试面板：上一轮的注入明细（世界书 / 记忆 / 预设 / 各段 token）
  ipcMain.handle('tavern:debug-get', (_event, chatId: string) => lastDebug.get(chatId) ?? null)
  // 心动接话：点一下把某一句填进输入框
  ipcMain.handle('tavern:alternatives-get', (_event, chatId: string) => alternatives.get(chatId) ?? [])
  // 会话挂哪份预设（null = 跟随全局）
  ipcMain.handle('tavern:chat-preset-set', (_event, payload: { chatId: string; presetId: string | null }) => {
    setChatPreset(payload.chatId, payload.presetId)
  })
  // 这场会话用哪个模型：简单卡 flash、复杂卡 pro（下一轮生效）
  ipcMain.handle('tavern:chat-model-get', (_event, chatId: string) => ({
    model: modelFor(chatId),
    options: [...MODEL_OPTIONS]
  }))
  ipcMain.handle(
    'tavern:chat-model-set',
    (_event, payload: { chatId: string; model: string | null }) => {
      setChatModel(payload.chatId, payload.model)
      return modelFor(payload.chatId)
    }
  )
  // 这场会话的回复上限：复杂卡（模型每轮输出整页 HTML 状态栏）要调高才写得完
  ipcMain.handle('tavern:chat-max-tokens-get', (_event, chatId: string) => ({
    value: maxTokensFor(chatId),
    options: [...MAX_TOKENS_OPTIONS]
  }))
  ipcMain.handle(
    'tavern:chat-max-tokens-set',
    (_event, payload: { chatId: string; value: number | null }) => {
      setChatMaxTokens(payload.chatId, payload.value)
      return maxTokensFor(payload.chatId)
    }
  )
  // 群聊（T8）：建群 + 左栏列表。发送 / 重生成沿用 chat-send / chat-regenerate，
  // 主进程按 isGroup 分流，界面上不需要两套通道
  ipcMain.handle(
    'tavern:group-create',
    (_event, payload: { memberIds: string[]; name?: string }) => {
      const chat = createGroupChat(payload.memberIds ?? [], payload.name ?? '')
      return withDisplay(getChatView(chat.id))
    }
  )
  ipcMain.handle('tavern:groups-list', () => listGroupChats())

  ipcMain.handle('tavern:variables-get', (_event, chatId: string) => {
    const chat = getChat(chatId)
    const state = chat ? loadOrInitVariables(chatId, chat.characterId) : loadVariables(chatId)
    return { state, lines: formatStatus(state) }
  })
}
