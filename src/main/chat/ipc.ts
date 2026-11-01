// chat:* IPC：接收渲染层发来的消息，转发给 DeepSeek，把流式 token 推回桌宠窗口。
// 主进程是唯一的网络出口，API Key 只在这里使用。
import { ipcMain, type BrowserWindow } from 'electron'
import { loadConfig, type ChatConfig } from './config'
import {
  readEmotionPrefix,
  stripEmotionTags,
  stripStrayTags,
  tagForHistory,
  tagLegacyHistory,
  type Emotion
} from './emotion'
import { streamChat } from './deepseek'
import { synthesizeSpeech } from './tts'
import { SpeechStreamer } from './speechStreamer'
import { emotionInstruction, providerOfVoice } from './speech'
import { ChatSession, withClock, type ChatMessage } from './session'
import { parseReminders, stripReminderTags } from './reminder'
import { addReminders } from './reminderStore'
import { loadHistory, saveHistory } from './historyStore'
import { buildMemoryContext, extractMemories } from './memoryStore'
import { loadStore } from '../petStore'

const session = new ChatSession()

/**
 * chat:send 的代次。记忆语义检索要等一次网络，这期间用户可能已经又发了一条——
 * 代次对不上就整轮丢掉，避免两条消息的历史顺序被打乱。
 */
let sendGeneration = 0

/**
 * 正在等记忆检索的那次发言的代次（0 = 没有）。
 * 这段窗口里 active 仍是 null，必须单独挡住主动消息 / 提醒，否则会并发开两轮。
 *
 * 记代次而不是布尔：布尔值一旦漏清（新发言没配 Key、提前 return 等分支）
 * 就会永久为真，主动消息和提醒从此全哑，而且界面上看不出原因。
 * 代次是「哪一次在等」，被顶掉 / 作废时自然失效。
 */
let pendingGeneration = 0

/** 过短的对话不值得为抽记忆多花一次 API 调用。 */
const EXTRACT_MIN_CHARS = 8

/** 会话快照落盘（历史 + 彩蛋计数），失败不影响主流程。 */
function persistHistory(): void {
  saveHistory(session.snapshot())
}

/** 进行中的一轮请求；settled 保证同一轮只收尾一次（打断与 catch 都可能碰到它）。 */
interface ActiveTurn {
  controller: AbortController
  /** 去掉情绪标记后的正文（进历史、朗读、抽记忆都用它，标记不该被念出来） */
  accumulated: string
  /** 本条回复的情绪；进历史时要把标记加回去，否则模型会照抄「不带标记」的旧格式 */
  emotion: Emotion | null
  /** 情绪标记的前缀缓冲，判定完成后不再使用 */
  prefix: string
  prefixDone: boolean
  /** 末尾可能是半个情绪标记的残片，攒着等下一块拼上 */
  hold: string
  /** 末尾可能是半个提醒标记的残片（`<remind at="20:` 这类），同样先扣住 */
  remindHold: string
  /** 模型原文（含情绪 / 提醒标记），提醒只从原文里解析——正文里已经把它们剥掉了 */
  raw: string
  /** 是否已经真的下发过正文 token（决定失败时要不要补收尾 / 调度器要不要记账） */
  emitted: boolean
  /** 主动消息：不推进彩蛋冷却、失败静默 */
  proactive: boolean
  /** 一轮结束时回调「有没有真的说出话」，供主动消息调度器决定记账还是回滚 */
  onOutcome?: (spoken: boolean) => void
  settled: boolean
}

/** 把一块正文清洗后推给渲染层；末尾半个情绪标记先扣住，流结束时再放行。 */
function emitDelta(turn: ActiveTurn, delta: string): void {
  // 两级清洗：先剥情绪标记（扣住半个），再剥提醒标记（同样扣住半个）
  const emo = stripStrayTags(turn.hold + delta)
  turn.hold = emo.hold
  const rem = stripReminderTags(turn.remindHold + emo.text)
  turn.remindHold = rem.hold
  if (!rem.text) return
  turn.accumulated += rem.text
  turn.emitted = true
  sendToPet('chat:token', { delta: rem.text })
  // 边生成边念：这一块正文攒够一句就立刻送去合成，不等整段写完
  activeSpeaker?.push(rem.text)
}

let active: ActiveTurn | null = null

/**
 * 语音的代次：新一轮发言、打断、或开始念新的一条都会 +1。
 * 合成要一两秒，期间用户可能已经打断或换了话题，旧结果回来时必须丢掉，否则会念上一句。
 */
let speechGeneration = 0
/** 在途合成的控制器，打断时直接 abort，别让旧语音继续占着 WebSocket */
let speechAbort: AbortController | null = null
/** 这一轮正在边生成边念的合成器；同一时刻只有一个 */
let activeSpeaker: SpeechStreamer | null = null

/** 中止在途合成、丢掉过期结果，并让渲染层立刻停声。 */
function cancelSpeech(): void {
  speechGeneration++
  speechAbort?.abort()
  speechAbort = null
  activeSpeaker?.cancel()
  activeSpeaker = null
  sendToPet('chat:tts-stop')
}

/**
 * 开始这一轮的边生成边念：正文每凑出一句就送去合成，合成好立刻下发。
 * 整段合成要等回复写完才开始，首句能晚一两秒；这样第一句几乎立刻开口。
 */
function startSpeaking(turn: ActiveTurn): void {
  const gen = speechGeneration
  const controller = new AbortController()
  speechAbort = controller

  // 走哪条通道由**所选音色**决定：选千问音色（且配了 Key）才走能带情绪的千问，
  // 选 Edge 音色就走免费 Edge 的普通语气——这样配了 Key 也能随时切回晓伊。
  const { voice, qwenKey } = loadConfig()
  const useQwen = qwenKey.length > 0 && providerOfVoice(voice) === 'qwen'

  const speaker = new SpeechStreamer({
    // 情绪在流开头才判定出来，这里现读：第一句合成时它已经有值了
    synthesize: (text) =>
      synthesizeSpeech(text, {
        voice,
        instruction: useQwen ? emotionInstruction(turn.emotion) : null,
        qwen: useQwen ? { key: qwenKey } : null,
        signal: controller.signal
      }),
    onAudio: ({ audio, mime, more }) => {
      // 期间被打断、换了话题：这声都不该再响，渲染层那边已有新的指令
      if (gen !== speechGeneration) return
      sendToPet('chat:tts', { audio: audio.toString('base64'), mime, more })
    },
    onEnd: () => {
      if (gen !== speechGeneration) return
      if (speechAbort === controller) speechAbort = null
      if (activeSpeaker === speaker) activeSpeaker = null
      // 「不会再有语音了」：多段语音下，凭 isPlaying 判断不出来
      sendToPet('chat:tts-end')
    }
  })
  activeSpeaker = speaker
}

/** 好感等级决定彩蛋概率（behavior.md 第四节：Lv4 提升到 0.12）。 */
function affectionLevel(): number {
  const value = loadStore().affection
  if (value < 20) return 1
  if (value < 50) return 2
  if (value < 80) return 3
  return 4
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return ''
    return error.message
  }
  return String(error)
}

/** 把一轮请求的结果写进上下文：有内容（成功或被打断）就记下，一条都没收到就撤回那条 user。 */
function settleTurn(turn: ActiveTurn): void {
  if (turn.settled) return
  turn.settled = true
  // 标记万一没打在最前面，会在正文里残留：落库/朗读/抽记忆前统一清掉
  turn.accumulated = stripEmotionTags(turn.accumulated)
  if (active === turn) active = null
  // 历史里保留情绪标记：模型会照着上下文里自己的写法回，剥干净了它就不打标记了
  if (turn.accumulated) {
    session.pushAssistant(tagForHistory(turn.emotion, turn.accumulated), !turn.proactive)
  } else if (!turn.proactive) {
    // 只有用户轮才有「这轮 push 上去的 user」可撤；主动轮若也调，
    // 会把历史里上一条真正的 user（如上次中途退出留下的）一起删掉
    session.dropLastUser()
  }
  // 她答应过的事：从模型原文里解析提醒（正文里已经剥掉了，只能看原文）。
  // 主动轮不解析——那是她自己开口，不是用户托付的事。
  if (!turn.proactive) {
    const found = parseReminders(turn.raw, new Date())
    if (found.length) addReminders(found)
  }
  // 主动消息调度器据此决定「记一次开口」还是「回滚额度」
  turn.onOutcome?.(turn.emitted)
}

/**
 * 打断当前请求。abort() 只是把失败排进微任务队列，这里同步收尾，
 * 保证上下文里的顺序是 user_old → assistant_old → user_new（而不是 assistant_old 落在新 user 之后）。
 */
function interruptActive(): boolean {
  if (!active) return false
  const turn = active
  turn.controller.abort()
  settleTurn(turn)
  return true
}

/** 下发到桌宠窗口的函数；registerChatIpc 时绑定，主动消息也复用它。 */
let sendToPet: (channel: string, payload?: unknown) => void = () => {}

interface TurnInput {
  messages: ChatMessage[]
  config: ChatConfig
  /** 用户轮才有：用于抽取长期记忆 */
  userText?: string
  /** 主动消息：失败静默（她没开口，比弹一条报错打扰人强），也不推进彩蛋冷却 */
  proactive?: boolean
  /** 一轮真正结束时回调「有没有说出话」，主动消息调度器用它记账 / 回滚 */
  onOutcome?: (spoken: boolean) => void
}

/**
 * 跑一轮请求（用户发言 / 主动消息共用）：流式推 token，结束后落历史、合成语音。
 * 调用方负责提前处理打断、system 上下文与消息组装。
 */
function startTurn(input: TurnInput): void {
  const { messages, config, userText } = input
  const turn: ActiveTurn = {
    controller: new AbortController(),
    accumulated: '',
    emotion: null,
    prefix: '',
    prefixDone: false,
    hold: '',
    remindHold: '',
    raw: '',
    emitted: false,
    proactive: input.proactive === true,
    onOutcome: input.onOutcome,
    settled: false
  }
  active = turn
  // 一开始就建好：正文一凑出整句就能送出去合成，不用等流结束
  if (config.ttsEnabled) startSpeaking(turn)

  void (async () => {
    try {
      await streamChat({
        // 带上当前时间：她才能把「五分钟后」「明天八点」换算成提醒标记
        messages: withClock(messages, new Date()),
        apiKey: config.apiKey,
        model: config.model,
        signal: turn.controller.signal,
        onToken: (delta) => {
          if (turn.controller.signal.aborted) return
          turn.raw += delta
          // 开头的情绪标记可能被拆到几个 token 里：判定完之前先攒着，
          // 免得 `<emo:happy>` 半截出现在气泡里被念出来
          if (!turn.prefixDone) {
            turn.prefix += delta
            const read = readEmotionPrefix(turn.prefix)
            if (!read.done) return
            turn.prefixDone = true
            if (read.emotion) {
              turn.emotion = read.emotion
              sendToPet('chat:emotion', { emotion: read.emotion })
            }
            if (read.rest) emitDelta(turn, read.rest)
            return
          }
          emitDelta(turn, delta)
        }
      })
      // 流结束但标记还没判定完（比如整段回复只有标记）：兜底放行，别把正文吞了
      if (!turn.settled && !turn.prefixDone) {
        turn.prefixDone = true
        const read = readEmotionPrefix(turn.prefix, true)
        if (read.emotion) {
          turn.emotion = read.emotion
          sendToPet('chat:emotion', { emotion: read.emotion })
        }
        if (read.rest) emitDelta(turn, read.rest)
      }
      // 流结束了还被扣着的残片（多半只是个 < 号）：原样放出去，别把正文吞掉。
      // 提醒标记例外——收不完整本来就不是有效提醒，丢掉，别把半截标签显示给用户
      if (!turn.settled && (turn.hold || turn.remindHold)) {
        const tail = stripReminderTags(turn.hold + turn.remindHold, true).text
        turn.hold = ''
        turn.remindHold = ''
        if (tail) {
          turn.accumulated += tail
          turn.emitted = true
          sendToPet('chat:token', { delta: tail })
        }
      }
      if (turn.settled) return
      settleTurn(turn)
      // 带上「这轮后面还有没有语音」：渲染层据此决定 talk 要不要一直撑到念完。
      // 不能只看开轮时的 config.ttsEnabled：一轮进行中关掉朗读会走 cancelSpeech()，
      // activeSpeaker 已被置 null、这一轮再也不会发 chat:tts-end，渲染层却会照着
      // {tts:true} 一直等下去（talk 永不收尾，`say()` 全被挡住）。
      sendToPet('chat:done', { tts: activeSpeaker !== null })
      persistHistory()

      // 剩下的尾巴（最后半句）补进合成队列；队列跑完会发 chat:tts-end
      activeSpeaker?.end()

      // 后台抽取长期记忆：异步、不阻塞、失败静默（记忆是锦上添花）
      if (userText && turn.accumulated.length >= EXTRACT_MIN_CHARS) {
        void extractMemories({
          userText,
          assistantText: turn.accumulated,
          apiKey: config.apiKey
        }).catch(() => {})
      }
    } catch (error) {
      // 被打断的那一轮已由 interruptActive 同步收尾，这里不再重复写历史
      if (turn.settled) return
      settleTurn(turn)
      // 这一轮断了：已经合成好的那几段也别再念了，用户马上会看到报错
      cancelSpeech()
      if (input.proactive) {
        // 主动消息失败不弹错误气泡，但必须补一次收尾：
        // 已经吐过正文时渲染层已进 talk，收不到 chat:done 会永久卡在说话状态；
        // 一个 token 都没发时也要发，让渲染层清掉可能已缓存的情绪，避免串到下一轮。
        sendToPet('chat:done', { tts: false })
        return
      }
      const message = errorMessage(error)
      if (message) sendToPet('chat:error', { message })
    }
  })()
}

/** 主动消息调度器要看的运行时状态：正在回复就不能再开口。 */
export function proactiveStatus(): { lastUserAt: number | null; busy: boolean } {
  // 还在等记忆检索也算「忙」：那几秒里 active 仍是空的，
  // 只看 active 的话提醒 / 主动消息会从这道缝里挤进来，和用户这一轮撞成两条并发流
  return { lastUserAt: session.getLastUserAt(), busy: active !== null || pendingGeneration !== 0 }
}

/**
 * 主进程发起的主动消息：复用 chat:token / chat:done / chat:tts 整套通道，
 * 渲染层无需区分是谁开的头。返回是否真的开始了这一轮。
 */
export function runProactiveTurn(instruction: string, onOutcome?: (spoken: boolean) => void): boolean {
  // pendingGeneration：用户这条还没真正开跑（在等记忆检索），更不能抢在她前面开口
  if (active || pendingGeneration !== 0) return false
  const config = loadConfig()
  if (!config.apiKey) return false
  // 她主动开口前，上一句还在念就先停掉，免得两句话叠在一起
  cancelSpeech()
  startTurn({
    messages: session.buildProactiveMessages(instruction),
    config,
    proactive: true,
    onOutcome
  })
  return true
}

export function registerChatIpc(getPetWindow: () => BrowserWindow | null): void {
  sendToPet = (channel: string, payload?: unknown): void => {
    getPetWindow()?.webContents.send(channel, payload)
  }

  // 恢复上次会话：重启后历史与彩蛋冷却都还在。
  // 旧版本的历史里助手回复没有情绪标记，加载时补上（详见 tagLegacyHistory）
  const restored = loadHistory()
  session.restore(
    restored && Array.isArray(restored.history)
      ? { ...restored, history: tagLegacyHistory(restored.history) }
      : restored
  )

  ipcMain.on('chat:send', (_event, payload: { text?: string }) => {
    const text = (payload?.text ?? '').trim()
    if (!text) return
    // 记忆检索要等一次网络（没配百炼 Key 时是本地关键词，立刻可得），
    // 用代次号保证「等的时候用户又发了一条」时旧的那次整轮作废，历史顺序不会乱
    const generation = ++sendGeneration
    // 从收到这条消息起就算忙，还顺带把上一条在等检索的发言作废（它醒来会发现代次变了）。
    // 放在读配置之前：下面任何一条提前 return 的分支都不会留下「没人清的忙标记」。
    pendingGeneration = generation

    // 新一轮发言：上一句还没念完也立刻停掉
    cancelSpeech()

    // 打断上一轮：先结束旧流（渲染层据此收尾），再开始新的请求。
    // replaced 标记「这条不是真的说完了，是马上被下一句顶掉」——渲染层据此推迟收尾，
    // 否则旧回合的收尾会在新回复首个 token 到达前把说话动作打断，闪一下 idle。
    if (interruptActive()) {
      persistHistory()
      sendToPet('chat:done', { tts: false, replaced: true })
    }

    const config = loadConfig()
    if (!config.apiKey) {
      // 这条开不了跑：把它刚占上的「忙」让出来（此时它一定是最新一次，直接清）
      if (pendingGeneration === generation) pendingGeneration = 0
      sendToPet('chat:error', { message: '还没有配置 API Key 哦…按 Ctrl+Shift+Space 打开输入栏，点「设置」填一下？' })
      return
    }

    // 先把与当前输入相关的长期记忆注入 system，再组装本轮请求体。
    // 有向量检索时这一步是异步的（见 memoryStore.recallMemories），其余流程保持不变。
    void (async () => {
      let context = ''
      try {
        context = await buildMemoryContext(text)
      } catch (error) {
        // 记忆检索出了意料之外的错也不该吞掉用户这句：退回「没有记忆」照常回复
        console.warn('[chat] 记忆检索失败，这一轮不注入记忆', error)
      }
      if (generation !== sendGeneration) return

      session.setSystemContext(context)
      const { messages, meta } = session.pushUser(text, { affectionLevel: affectionLevel() })
      if (meta) sendToPet('chat:meta')
      persistHistory()

      startTurn({ messages, config, userText: text })
      // 这一轮已经交给 startTurn（active 已置位），闸门从这一刻起由 active 负责。
      // 只清自己的：被后一条发言顶掉时，pendingGeneration 已经换成它了
      if (pendingGeneration === generation) pendingGeneration = 0
    })()
  })

  // 用户在设置里关掉朗读：正在念的那句、在途的合成都立刻作废
  ipcMain.on('chat:config-set', (_event, data: { ttsEnabled?: boolean }) => {
    if (data?.ttsEnabled === false) cancelSpeech()
  })

  // 主动打断：结束当前回复，渲染层收到 done 后回 idle
  ipcMain.on('chat:stop', () => {
    cancelSpeech()
    if (interruptActive()) {
      persistHistory()
      sendToPet('chat:done')
    }
  })
}
