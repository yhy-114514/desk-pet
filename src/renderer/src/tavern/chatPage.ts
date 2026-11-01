// 聊天页（中栏）：小说流阅读 + 流式打字 + 消息操作。
// 三色由 colorParser 切段（旁白默认色 / 对话粉 / 动作青），消息树的分支切换在每条消息上方。
import {
  applyAppearance,
  applyFlowBackground,
  loadAppearance,
  type Appearance,
  type AppearanceTab
} from './appearance'
import { openAppearancePanel } from './appearancePanel'
import { parseColors } from './colorParser'
import { closeGreetingPicker, pickGreeting } from './greetingPicker'
import { openMemoryPanel } from './memoryPanel'
import { openDebugPanel, openPromptPanel, type PromptTab } from './promptPanel'
import { parseSpeaker } from '../../../shared/groupChat'
import { splitRich, streamText } from '../../../shared/richText'
import type { RuntimeSnapshot } from '../../../shared/tavernRuntime'
import { buildStatusBridgeScript } from './statusBridge'
import { cover, h, type ChatMessageNode, type ChatView } from './ui'
import { VoicePlayer } from '../voicePlayer'

export interface ChatHandlers {
  onBack: () => void
  onEditCharacter: (id: string) => void
  onProfile: () => void
  /** 页面就绪 / 重开了一场：右栏的旁观抽屉要知道现在在看哪一场 */
  onReady?: (context: {
    chatId: string
    characterId: string
    characterName: string
    /** 群聊：几个人的档案分开记，旁观在群里看不过来 */
    group?: boolean
  }) => void
}

/** 单角色传角色 id（没聊过就开一场）；群聊传 { chatId }（按会话进） */
export type ChatTarget = string | { chatId: string }

/**
 * ⋯ 面板里的入口清单：11 个快捷设置 + 6 个聊天操作（见 insight 第 130 行）。
 * T2 先把入口全部摆出来、点了有明确交代；功能各自排到后面阶段。
 */
const SETTING_ENTRIES: Array<[string, string]> = [
  ['背景', 'T5'],
  ['气泡', 'T5'],
  ['语音', 'T5'],
  ['记忆', 'T3'],
  ['人设', 'T1'],
  ['回复', 'T4'],
  ['配图', 'T6'],
  ['状态栏', 'T4'],
  ['全局世界书', 'T4'],
  ['全局正则', 'T4'],
  ['全局预设', 'T4']
]

const CHAT_ACTIONS: Array<[string, string]> = [
  ['角色世界书', 'T4'],
  ['角色正则', 'T4'],
  ['注入调试', 'T4'],
  ['搜索', 'T9'],
  ['导出', 'T9'],
  ['导入', 'T9'],
  ['清空', 'T9']
]

/** 状态栏 iframe 里按钮点出来的、需要父页落实的动作 */
export type FrameEvent =
  | { kind: 'focus' }
  | { kind: 'toast'; message: string }
  | { kind: 'vars'; state: Record<string, unknown> }
  | { kind: 'slash'; command: string }

interface ChatPage {
  chatId: string
  alive: boolean
  /** 本轮（用户点发送 / 重生成）的轮次号；主进程把它带回每个事件 */
  currentTurn: number
  /** 流式中的临时节点与累计正文；speaker 是群聊里这一条的发言人（单聊恒为 null） */
  stream: { node: HTMLElement; text: HTMLElement; content: string; speaker: string | null } | null
  onToken: (delta: string) => void
  /** 群聊：这一轮轮到谁说话（每个发言人一条消息） */
  onSpeaker: (name: string) => void
  onDone: (messageId: string | null) => void
  onError: (message: string) => void
  /** 忆境典藏正在后台摘要：顶栏的入口变成「总结中…」 */
  onSummary: (active: boolean) => void
  /** 变量系统（MVU）更新后的状态条文字 */
  onVariables: (lines: string[]) => void
  /** 卡里的状态栏页面要把一句话放进输入框（postMessage 过来的按钮） */
  onFrameText: (text: string) => void
  /** 状态栏页面里的其它动作（提示 / 改变量 / 它自己发起的斜杠命令） */
  onFrameEvent: (event: FrameEvent) => void
  /** 心动接话：这一轮生成的可选回复 */
  onAlternatives: (items: string[]) => void
  /** 外观变了（面板里改的，或别的窗口改的）：重画背景 */
  onAppearance: (settings: Appearance) => void
  /** 朗读下发的一段语音（主进程边生成边合成） */
  onTts: (audio: string, mime: string) => void
  /** 不会再有语音了（队列里的照常念完） */
  onTtsEnd: () => void
  /** 立刻停声（新发言 / 打断 / 关了朗读） */
  onTtsStop: () => void
}

/**
 * 页面上同时只可能有一场对话在流式。IPC 事件没有解绑接口（preload 只暴露 on），
 * 所以监听在模块级只挂一次，靠这个「当前页」引用转发给还活着的那一个。
 */
let activePage: ChatPage | null = null
let listenersBound = false
/** 当前聊天页的语音播放器：离开页面时要把还在念的那句停掉 */
let liveVoice: VoicePlayer | null = null

function bindListeners(): void {
  if (listenersBound) return
  listenersBound = true
  // 只认当前这场对话、当前这一轮：连发两条时上一轮的 done 会晚到，
  // 不比对轮次号就会把刚画出来的新回复当成旧那轮收尾。
  const mine = (data: { chatId: string; turn: number }): boolean =>
    activePage !== null && activePage.alive && activePage.chatId === data.chatId && activePage.currentTurn === data.turn
  window.tavern.onToken((data) => {
    if (mine(data)) activePage?.onToken(data.delta)
  })
  // 群聊的每一个发言人各占一条消息：主进程在开流前先把名字报过来
  window.tavern.onSpeaker((data) => {
    if (mine(data)) activePage?.onSpeaker(data.name)
  })
  window.tavern.onDone((data) => {
    if (mine(data)) activePage?.onDone(data.messageId)
  })
  window.tavern.onError((data) => {
    if (mine(data)) activePage?.onError(data.message)
  })
  // 摘要没有轮次号：它随时可能结束，只认「还是这场对话」
  window.tavern.onSummary((data) => {
    if (activePage?.alive && activePage.chatId === data.chatId) activePage.onSummary(data.active)
  })
  window.tavern.onVariables((data) => {
    if (activePage?.alive && activePage.chatId === data.chatId) activePage.onVariables(data.lines)
  })
  window.tavern.onAlternatives((data) => {
    if (activePage?.alive && activePage.chatId === data.chatId) activePage.onAlternatives(data.items)
  })
  // 外观是全局的：角色库那边改了主题，聊天页也要跟着换背景
  window.tavern.onAppearance((settings) => {
    if (activePage?.alive) activePage.onAppearance(settings)
  })
  // 朗读没有轮次号：语音是这一轮写完还在念的，按「还是这场对话」认
  window.tavern.onTts((data) => {
    if (activePage?.alive && activePage.chatId === data.chatId)
      activePage.onTts(data.audio, data.mime)
  })
  window.tavern.onTtsEnd((data) => {
    if (activePage?.alive && activePage.chatId === data.chatId) activePage.onTtsEnd()
  })
  window.tavern.onTtsStop((data) => {
    if (activePage?.alive && activePage.chatId === data.chatId) activePage.onTtsStop()
  })
}

/**
 * 离开页面时还在流的那几轮，按会话 id 记着。主进程不会因为我们切了页面就停下，
 * 回来时要把轮次号接上，否则这一轮的 done 会被 `mine()` 丢掉，表现是「发完消息去
 * 看一眼人设再回来，这条回复一直不出现」。接了号之后 done 会照常触发重绘；万一
 * done 早已错过，回到页面时会补拉一次快照（见 renderChatPage 末尾），落库的回复照样能出来。
 *
 * 用 Map 而不是单个槽位：流着的时候从左栏切到别的角色，那个槽位会被下一次渲染清掉，
 * 再回到原对话号就断了。条目只在真正回到那场对话时消费掉，最多几条，不会长。
 */
const detachedTurns = new Map<string, number>()
/** 「聊完第一轮」的提示每个进程只试一次，别换场对话又弹 */
let greetAttempted = false

function tavernRoot(): HTMLElement {
  return document.getElementById('tavern') ?? document.body
}

// ── 卡里的状态栏页面 ─────────────────────────────────────────────────
let frameSeq = 0

/** 塞进 iframe 末尾的小脚本：把自己的高度报给外面，状态栏有多高就占多高 */
function frameReporter(id: string): string {
  return (
    '<script>(function(){var id=' +
    JSON.stringify(id) +
    ';function send(){try{var d=document.documentElement,b=document.body;' +
    "var h=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0);" +
    "parent.postMessage({__tavernFrame:id,height:h},'*')}catch(e){}}" +
    "window.addEventListener('load',send);" +
    'if(window.ResizeObserver&&document.body){new ResizeObserver(send).observe(document.body)}' +
    'setTimeout(send,300);setTimeout(send,1500)})()<\/script>'
  )
}

/**
 * 沙箱 iframe：卡的前端扩展（状态栏 / 论坛 / 手机界面）本来就是整页 HTML。
 * 不给 allow-same-origin——页面里的脚本碰不到我们的 DOM，只在自己的玻璃罩里跑。
 * `state` 是这场会话的变量，卡里的状态栏页面靠它取数（见 statusBridge）。
 */
function htmlFrame(html: string, runtime: RuntimeSnapshot): HTMLElement {
  const wrap = h('div', 'rich-frame')
  const frame = document.createElement('iframe')
  const id = `tf${++frameSeq}`
  frame.dataset['frame'] = id
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups')
  frame.style.height = '160px'
  frame.srcdoc = withBridge(html, runtime) + frameReporter(id)
  wrap.append(frame)
  return wrap
}

/**
 * 注入脚本必须排在卡页面之前（页面里的函数要能立刻拿到 `$` / `getAllVariables`），
 * 但**不能排在 `<!DOCTYPE>` 前面**——doctype 不是第一个 token 会被当成无效，
 * 整页掉进 quirks mode，卡里那些按标准模式算的盒模型全部错位。
 */
function withBridge(html: string, runtime: RuntimeSnapshot): string {
  const bridge = buildStatusBridgeScript(runtime)
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (!doctype) return `${bridge}${html}`
  const head = html.slice(0, doctype[0].length)
  return `${head}${bridge}${html.slice(doctype[0].length)}`
}

/**
 * 卡的脚本崩了（未捕获异常 / 沙箱里没有的 API）时，在消息下面留一行说明。
 * 不这么做的话，页面只是安静地停在静态模板上，用户完全看不出为什么——
 * 「每次导入新卡都不对劲」有一半是这个盲区。
 */
function showFrameError(source: MessageEventSource | null, message: string): void {
  const frame = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[data-frame]')).find(
    (item) => item.contentWindow === source
  )
  const box = frame?.closest('.msg')
  if (!box || box.querySelector('.frame-error')) return
  const short = message.length > 160 ? `${message.slice(0, 160)}…` : message
  box.append(h('div', 'frame-error', `这个状态页的脚本报错了：${short}`))
  console.warn('[状态栏] 卡里的脚本报错：', message)
}

/**
 * 全页只挂一个消息监听：
 * ① iframe 报高 → 找到对应那个框改高度；
 * ② 页面里的按钮要往输入框放话（宝可梦卡的「呼出洛托姆手机」就是这么过来的），转给当前页。
 */
window.addEventListener('message', (event) => {
  const data = event.data as {
    __tavernFrame?: unknown
    height?: unknown
    type?: unknown
    message?: unknown
    text?: unknown
    /** tavern_vars：卡里改了变量 */
    state?: unknown
    /** tavern_slash：卡里发起、我们没实现的斜杠命令 */
    command?: unknown
  } | null
  if (!data) return
  // 沙箱 iframe 没有剪贴板权限，卡里的 navigator.clipboard.writeText 被 statusBridge
  // 改成 postMessage 出来。**别在这里自己写**：消息到达时焦点还在 iframe 里，
  // 父页不是焦点文档，`navigator.clipboard.writeText` 会静默 reject（用户看到的就是
  // 「四个按钮点了没反应」）。改走主进程的 electron.clipboard，它不看焦点也不看安全上下文。
  if (data.type === 'tavern_copy' && typeof data.text === 'string') {
    const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[data-frame]')
    const fromOurs = Array.from(frames).some((item) => item.contentWindow === event.source)
    if (fromOurs) {
      // ①③④ 这类「选项」按钮卡里调的是 writeText 复制。用户要的不止是复制，
      // 而是顺手填进输入框（这样能看一眼再发，不用再去别处粘贴）——沿用
      // send_message 那条「填输入框、不自动发送」的通路。
      void window.tavern.clipboardWrite(data.text).catch(() => {})
      if (activePage?.alive) activePage.onFrameText(data.text)
    }
    return
  }
  if (data.type === 'send_message' && typeof data.message === 'string') {
    // 只认我们自己造的 iframe：别让随便一个页面往输入框里塞字
    const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[data-frame]')
    const fromOurs = Array.from(frames).some((item) => item.contentWindow === event.source)
    if (fromOurs && activePage?.alive) activePage.onFrameText(data.message)
    return
  }
  // 状态栏页面里的其它动作（见 statusBridge 的 triggerSlash / Mvu / toastr）
  if (typeof data.type === 'string' && data.type.startsWith('tavern_')) {
    const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[data-frame]')
    const fromOurs = Array.from(frames).some((item) => item.contentWindow === event.source)
    if (!fromOurs || !activePage?.alive) return
    if (data.type === 'tavern_send' && typeof data.text === 'string') {
      activePage.onFrameText(data.text)
    } else if (data.type === 'tavern_trigger') {
      // 卡里的「发送」按钮：内容已经在输入框里了，不替用户按下去（见 CLAUDE.md 的交互口径）
      activePage.onFrameEvent({ kind: 'focus' })
    } else if (data.type === 'tavern_toast') {
      activePage.onFrameEvent({ kind: 'toast', message: String(data.message ?? '') })
    } else if (data.type === 'tavern_vars' && data.state && typeof data.state === 'object') {
      activePage.onFrameEvent({ kind: 'vars', state: data.state as Record<string, unknown> })
    } else if (data.type === 'tavern_slash') {
      activePage.onFrameEvent({ kind: 'slash', command: String(data.command ?? '') })
    } else if (data.type === 'tavern_error') {
      showFrameError(event.source, String(data.message ?? ''))
    }
    return
  }
  if (typeof data.__tavernFrame !== 'string' || typeof data.height !== 'number') return
  const frame = document.querySelector<HTMLIFrameElement>(
    `iframe[data-frame="${data.__tavernFrame}"]`
  )
  if (!frame) return
  const height = Math.min(6000, Math.max(80, Math.round(data.height)))
  if (Math.abs(frame.clientHeight - height) > 2) frame.style.height = `${height}px`
})

/** 离开聊天页时调用：之后到达的流式事件不再碰已经拆掉的 DOM。 */
export function disposeChatPage(): void {
  if (activePage) {
    activePage.alive = false
    if (activePage.stream) detachedTurns.set(activePage.chatId, activePage.currentTurn)
  }
  activePage = null
  // 朗读属于这个页面：人已经离开这场对话，别让声音留在别的页面继续念
  liveVoice?.stop()
  liveVoice = null
  // 还挂着的开场白选择框属于上一张卡：不关掉的话它会盖在新页面上，
  // 而且那次 chatStart 已经因代次号被丢弃，点哪条都没反应
  closeGreetingPicker()
}

// 连点两个角色 / 会话切换时先发出的 chatOpen 可能后回来，和编辑页一样用代次号收口
let pageSeq = 0

/** 全局单调的轮次号：换页、重开一场都接着往上涨，旧事件不会撞上新的同号 */
let clientTurn = 0

export async function renderChatPage(
  mount: HTMLElement,
  target: ChatTarget,
  handlers: ChatHandlers
): Promise<void> {
  const seq = ++pageSeq
  disposeChatPage()
  mount.replaceChildren()
  let view: ChatView | null
  if (typeof target === 'string') {
    // 第一次进这张卡：先挑开场白（有备选才有得挑，一条就没什么好问的）
    const greetings = await window.tavern.chatGreetings(target)
    if (seq !== pageSeq) return
    if (greetings && !greetings.hasChat && greetings.options.length > 1) {
      const choice = await pickGreeting(tavernRoot(), greetings.options)
      if (seq !== pageSeq) return
      if (!choice) {
        handlers.onBack()
        return
      }
      view = await window.tavern.chatStart(target, choice.index)
    } else {
      view = await window.tavern.chatOpen(target)
    }
  } else {
    // 群聊按会话进：群成员在 settings 里，没有「这张卡的开场白」这回事
    view = await window.tavern.chatView(target.chatId)
  }
  if (seq !== pageSeq) return
  if (!view) {
    mount.append(h('div', 'empty', '这个角色不在了。'))
    return
  }

  bindListeners()
  let current = view
  // 群聊：标题是群名，发言按「谁说的」分开；记忆 / 世界书 / 状态栏 / 开场白都不适用
  const isGroup = view.chat.isGroup
  let streaming = false
  // 本场用哪个模型：简单卡 flash 就够，几百条世界书 + 变量系统的复杂卡要 pro。
  // 切换只影响下一轮（这一轮已经在流的那条还挂在旧模型上）。
  const modelInfo = await window.tavern.chatModelGet(view.chat.id).catch(() => null)
  if (seq !== pageSeq) return
  let model = modelInfo?.model ?? 'deepseek-flash'
  const modelOptions = modelInfo?.options ?? ['deepseek-flash', 'deepseek-v4-pro']
  // 本场回复上限：模型每轮吐整页 HTML 状态栏的复杂卡（模板上万字）用得起 1200 会永远被截断
  const tokenInfo = await window.tavern.chatMaxTokensGet(view.chat.id).catch(() => null)
  if (seq !== pageSeq) return
  let maxTokens = tokenInfo?.value ?? 1200
  const tokenOptions = tokenInfo?.options ?? [1200, 3000, 6000, 8192]
  /**
   * 卡自带的状态栏页面要的整包数据（消息楼层 / 变量 / 世界书 / 名字）。
   * 注入 iframe 的那份就是它；变量变了只推这一个包，页面自己重绘。
   */
  let runtime: RuntimeSnapshot = {
    charName: current.character.name,
    userName: '',
    messages: [],
    statData: {},
    lorebook: { name: current.character.name, entries: [] }
  }
  /** 取一次快照。开场前、每轮结束后各取一次——变量会随 `<update>` 变 */
  const syncRuntime = async (): Promise<void> => {
    const next = (await window.tavern.runtimeGet(current.chat.id).catch(() => null)) as
      | RuntimeSnapshot
      | null
    if (next) runtime = next
  }

  const page = h('div', 'chat-page')
  const flow = h('div', 'flow')
  // 朗读：主进程一句一句合成好下发，这里排队念，新发言时整队清空
  const voice = new VoicePlayer()
  liveVoice = voice
  // 外观（T5）：主题 / 字体 / 三色由 shell 与这里一起应用，背景只属于聊天页
  let appearance = await loadAppearance()
  const repaintBackground = (): void => {
    applyFlowBackground(flow, appearance, current.character.avatarPath)
  }
  const openAppearance = (tab: AppearanceTab) => (): void => {
    openAppearancePanel({
      root: tavernRoot(),
      tab,
      avatarPath: current.character.avatarPath,
      // 面板里的改动已经即时应用；这里把新设置取回来，背景（跟随封面 / 自定义图）才会跟着换
      onChanged: () => {
        void loadAppearance().then((next) => {
          appearance = next
          repaintBackground()
        })
      }
    })
  }

  const head = h('div', 'chat-head')
  const back = h('button', 'back', '←')
  back.title = '返回角色库'
  back.onclick = (): void => handlers.onBack()

  const face = cover('face', view.character.avatarPath, view.character.name)

  const modelBadge = h('span', 'model-badge', '')

  const who = h('div', 'who')
  who.append(
    h('div', 'n', view.character.name),
    (() => {
      const line = h('div', 's')
      if (isGroup) {
        const names = view.members.map((member) => member.name).join('、')
        const badge = h('span', '', `群聊 · ${view.members.length} 人`)
        badge.title = names
        line.append(h('div', 'online-dot'), badge, modelBadge)
        return line
      }
      line.append(h('div', 'online-dot'), h('span', '', '在线 · 小说流'), modelBadge)
      // 世界卡：描述很短但世界书极多，AI 更像跑团 GM 而不是某个角色
      if (view.worldCard) {
        const badge = h('span', 'world-card', '世界卡')
        badge.title = '这张卡的主体是世界书（场景 / NPC / 规则），她会以旁白口径带你走'
        line.append(badge)
      }
      return line
    })()
  )

  const memory = h('button', 'memory', '忆境')
  memory.title = '记忆：永久记忆 / 忆境典藏 / 回忆视界'
  const setSummarizing = (active: boolean): void => {
    memory.textContent = active ? '总结中…' : '忆境'
    memory.classList.toggle('working', active)
  }
  const openMemory = (): void => {
    openMemoryPanel({
      root: document.getElementById('tavern') ?? document.body,
      characterId: view.character.id,
      chatId: current.chat.id
    })
  }
  memory.onclick = openMemory

  const more = h('button', 'more', '⋯')
  more.title = '更多'
  // 忆境按会话记单人的档案，群聊里几个人的故事混在一起没有意义
  head.append(back, face, who, h('div', 'grow'), ...(isGroup ? [] : [memory]), more)

  const menu = h('div', 'menu')
  menu.hidden = true

  const section = (title: string, cells: HTMLElement[]): void => {
    menu.append(h('div', 'menu-title', title))
    const grid = h('div', 'menu-grid')
    for (const cell of cells) grid.append(cell)
    menu.append(grid)
  }
  const entry = (label: string, action: () => void): HTMLElement => {
    const button = h('button', 'cell', label)
    button.onclick = (): void => {
      menu.hidden = true
      action()
    }
    return button
  }
  /** 还没做的入口：点了要说清楚排在哪个阶段，不然像是点坏了 */
  const later = (label: string, phase: string): HTMLElement => {
    const button = h('button', 'cell', label)
    button.title = `${phase} 里做`
    button.onclick = (): void => {
      menu.hidden = true
      sayHint(`「${label}」排在 ${phase}，还没做。`)
    }
    return button
  }

  const rootEl = tavernRoot
  /** 提示词工具入口：全局页传 characterId=null，角色页传当前角色 */
  const promptCell = (tab: PromptTab, withCharacter: boolean): (() => void) => () => {
    openPromptPanel({
      root: rootEl(),
      tab,
      characterId: withCharacter ? view.character.id : null,
      chatId: current.chat.id,
      onChanged: onSettingsChanged
    })
  }
  const t4Entries: Record<string, () => void> = {
    回复: promptCell('reply', false),
    状态栏: promptCell('status', false),
    全局世界书: promptCell('lore', false),
    全局正则: promptCell('regex', false),
    全局预设: promptCell('preset', true),
    角色世界书: promptCell('lore', true),
    角色正则: promptCell('regex', true),
    注入调试: () => {
      void openDebugPanel(rootEl(), current.chat.id)
    }
  }
  // T5：背景 / 气泡 / 语音三个入口（语音在「通用」页里，和朗读开关、音乐放一起）
  const appearanceEntries: Record<string, () => void> = {
    背景: openAppearance('background'),
    气泡: openAppearance('bubble'),
    语音: openAppearance('general')
  }

  section('本场', [
    ...(isGroup
      ? []
      : [
          entry('重开一场', () => {
            if (!window.confirm('重开一场？现在的这场会留在库里，不过界面上只看得到新的那场。')) return
            void startNewChat()
          }),
          entry('编辑角色', () => handlers.onEditCharacter(view.character.id))
        ]),
    entry('我的人设', () => handlers.onProfile())
  ])

  // 模型：flash 便宜快、跟随复杂指令（变量更新块 / 结构化输出）不稳；
  // pro 稳但要花钱，所以做成每场可选，不是全局一刀切。
  const shortName = (name: string): string => (name.includes('pro') ? 'pro' : 'flash')
  const modelLabel = (name: string): string =>
    name.includes('pro') ? 'Pro · 复杂卡' : 'Flash · 轻快省'
  const modelGrid = h('div', 'menu-grid')
  menu.append(h('div', 'menu-title', '模型（下一轮生效）'), modelGrid)
  const paintModel = (): void => {
    modelBadge.textContent = shortName(model)
    modelBadge.classList.toggle('pro', shortName(model) === 'pro')
    modelBadge.title = `本场模型：${model}（⋯ 菜单里可换）`
    modelGrid.replaceChildren()
    for (const option of modelOptions) {
      const cell = h('button', 'cell', `${option === model ? '✓ ' : ''}${modelLabel(option)}`)
      cell.title = option
      cell.onclick = (): void => {
        menu.hidden = true
        void window.tavern.chatModelSet(current.chat.id, option).then((next) => {
          model = next
          paintModel()
        }).catch(() => {
          sayHint('模型切换失败，可能要先完全重启应用让迁移生效')
        })
      }
      modelGrid.append(cell)
    }
  }
  paintModel()

  // 回复上限：状态栏整页 HTML 的卡要调到 6000 以上才写得完，否则永远被 max_tokens 截断
  const tokenLabel = (value: number): string =>
    value >= 8192 ? '超长 · 8K' : value >= 6000 ? '长 · 6K' : value >= 3000 ? '中 · 3K' : '短 · 1.2K'
  const tokenGrid = h('div', 'menu-grid')
  const tokenTitle = h('div', 'menu-title', '')
  menu.append(tokenTitle, tokenGrid)
  const paintTokens = (): void => {
    tokenTitle.textContent = `回复上限（下一轮生效 · 当前 ${maxTokens}）`
    tokenGrid.replaceChildren()
    for (const option of tokenOptions) {
      const cell = h('button', 'cell', `${option === maxTokens ? '✓ ' : ''}${tokenLabel(option)}`)
      cell.title = `${option} 令牌`
      cell.onclick = (): void => {
        menu.hidden = true
        void window.tavern.chatMaxTokensSet(current.chat.id, option).then((next) => {
          maxTokens = next
          paintTokens()
        }).catch(() => {
          sayHint('回复上限切换失败，可能要先完全重启应用让迁移生效')
        })
      }
      tokenGrid.append(cell)
    }
  }
  paintTokens()
  // 世界书 / 正则 / 预设 / 状态栏都是「一张卡」的东西：群聊里不知道该套谁的，
  // 硬套会把人家的台词和状态一起洗掉，所以整块不给（模型 / 回复上限照常可调）
  if (!isGroup) {
    section(
      '快捷设置',
      SETTING_ENTRIES.map(([label, phase]) => {
        if (label === '人设') return entry(label, () => handlers.onProfile())
        if (label === '记忆') return entry(label, () => openMemory())
        const action = t4Entries[label] ?? appearanceEntries[label]
        if (action) return entry(label, action)
        return later(label, phase)
      })
    )
    section(
      '聊天操作',
      CHAT_ACTIONS.map(([label, phase]) => {
        const action = t4Entries[label]
        return action ? entry(label, action) : later(label, phase)
      })
    )
  }

  more.onclick = (): void => {
    menu.hidden = !menu.hidden
  }
  head.append(menu)

  const composer = h('div', 'composer')
  const input = document.createElement('textarea')
  input.placeholder = isGroup
    ? '说点什么…（@某个人，她一定会接话）'
    : '说点什么…（Enter 发送，Shift+Enter 换行）'
  const sendBtn = h('button', 'btn primary', '发送')
  const hint = h('div', 'hint', '')
  const sayHint = (text: string, bad = false): void => {
    hint.textContent = text
    hint.classList.toggle('bad', bad)
  }
  composer.append(input, sendBtn, hint)

  // 顶部状态条：世界书 / 变量系统（MVU）给的状态，开关在「状态栏」里。
  // 卡自己会画状态页（html 围栏）时这条是重复的——它把变量拍平成满屏「键: 值」，
  // 反倒把正文和状态页挤到看不见，所以只在卡没有状态页时才显示。
  const statusBar = h('div', 'chat-status')
  let statusEnabled = true
  let ownStatusPage = false
  const paintStatus = (lines: string[]): void => {
    statusBar.replaceChildren()
    if (!statusEnabled || ownStatusPage) return
    for (const line of lines) statusBar.append(h('span', '', line))
  }
  const reloadStatus = async (): Promise<void> => {
    if (isGroup) return
    statusEnabled = (await window.tavern.promptSettings()).statusEnabled
    const { lines, ownPanel } = await window.tavern.statusGet(current.chat.id)
    ownStatusPage = ownPanel === true
    paintStatus(lines)
  }

  // 心动接话：这几句是「你可以接的话」，点一下填进输入框（不直接发出去）
  const alts = h('div', 'alts')
  const paintAlts = (items: string[]): void => {
    alts.replaceChildren()
    for (const text of items) {
      const chip = h('button', '', text)
      chip.onclick = (): void => {
        input.value = text
        input.focus()
      }
      alts.append(chip)
    }
  }

  page.append(head, ...(isGroup ? [] : [statusBar]), flow, alts, composer)
  mount.append(page)

  /** 面板里改完设置：重拉这一页（篇幅 / 接话条数下一轮才生效，但状态条要立刻变） */
  function onSettingsChanged(): void {
    void refresh()
    void reloadStatus()
  }

  // 点页面里别处就收起 ⋯ 面板。挂在 page 上而不是 document：页面拆掉时监听跟着走，
  // 不然每进一次聊天就多一个永不释放的全局监听。
  page.addEventListener('click', (event) => {
    if (menu.hidden) return
    if (!menu.contains(event.target as Node) && event.target !== more) menu.hidden = true
  })

  /** 三色渲染：把文本切成旁白 / 对话 / 动作三色的 span */
  const paintColors = (target: HTMLElement, text: string): void => {
    for (const segment of parseColors(text)) {
      if (segment.kind === 'narration') target.append(document.createTextNode(segment.text))
      else target.append(h('span', `seg-${segment.kind}`, segment.text))
    }
  }
  /**
   * 正文渲染：普通文字走三色；```html 整块交给沙箱 iframe（卡里的状态栏），
   * 别的代码块留在等宽块里。直接当文字画的话，开场白下面就是三万字代码。
   */
  const paintText = (target: HTMLElement, text: string): void => {
    target.replaceChildren()
    for (const segment of splitRich(text)) {
      if (segment.kind === 'text') paintColors(target, segment.text)
      else if (segment.kind === 'html') target.append(htmlFrame(segment.html, runtime))
      else target.append(h('pre', 'rich-code', segment.text))
    }
  }

  const scrollToBottom = (): void => {
    flow.scrollTop = flow.scrollHeight
  }

  const repaint = (next: ChatView): void => {
    current = next
    flow.replaceChildren()
    if (next.messages.length === 0) {
      flow.append(
        h(
          'div',
          'empty',
          isGroup
            ? '群里还没人说话。\n打个招呼，或者 @ 一下谁。'
            : '这张卡没写开场白。\n说点什么，开始这场对话吧。'
        )
      )
    }
    for (const item of next.messages) flow.append(messageNode(item))
    // 流式中途也会重绘（切分支等）：正在写的那个临时节点不能被替换掉
    if (pageRef.stream) flow.append(pageRef.stream.node)
    scrollToBottom()
  }

  /**
   * 把最新变量 / 消息推给页面上已有的状态栏 iframe。
   * 卡里的页面用 `eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, …)` 订阅重绘，
   * 收到后自己更新，不用把整个 iframe 拆了重来（410KB 的页面重建一次很贵）。
   */
  const pushRuntime = (): void => {
    if (!pageRef.alive) return
    for (const frame of document.querySelectorAll<HTMLIFrameElement>(
      '.rich-frame iframe[data-frame]'
    )) {
      frame.contentWindow?.postMessage({ __tavernPush: runtime }, '*')
    }
  }

  /**
   * 这一条重画了会不会跟原来不一样。正文只是其中一项：删掉一条分支兄弟之后，
   * 剩下那条的正文一个字没变，但 `‹2/2›` 该变成「没有箭头」，只看 content 的话
   * 界面上会一直挂着旧箭头，点下去跳向已经删掉的分支。`resendable` 同理——
   * 悬空消息点「重发」成功后它由真变假，漏比的话「重发」按钮会一直挂在已经答过的那条上。
   */
  const sameRendering = (before: ChatMessageNode, after: ChatMessageNode): boolean =>
    before.content === after.content &&
    before.branchCount === after.branchCount &&
    before.branchIndex === after.branchIndex &&
    before.branchIds.join('\n') === after.branchIds.join('\n') &&
    before.interrupted === after.interrupted &&
    before.resendable === after.resendable

  /** 刷新代次：只让最后一次刷新落图，先发出的请求后回来时不能盖掉新的 */
  let refreshSeq = 0

  const refresh = async (): Promise<void> => {
    const seq = ++refreshSeq
    const turn = pageRef.currentTurn
    const next = await window.tavern.chatView(current.chat.id)
    if (!next || seq !== refreshSeq) return
    // 等库返回的这几毫秒里用户可能已经点了发送 / 重生成：这份快照里没有刚发出去的那条，
    // 照着重绘会让刚发的话当场消失。只有「又开了新一轮」才算这种情况——流式中的
    // 编辑 / 删除照常重绘（repaint 会把正在写的节点挂回去）。
    if (pageRef.currentTurn !== turn) return
    // 只是「末尾多了几条」（每轮正常收尾）：就地追加，别把已有消息里的状态栏
    // iframe 全拆了重来——那会丢掉页面状态（选中的标签页、滚动位置），
    // 而且 410KB 的页面重建一次要好几帧。
    const prev = current.messages
    const appended =
      !pageRef.stream &&
      next.messages.length >= prev.length &&
      prev.every((item, index) => next.messages[index]?.id === item.id)
    if (appended) {
      current = next
      // 本地画的乐观气泡（`send` 里那条还没有 id 的 user）和空会话占位都不在库里：
      // 快路径只追加 / 替换真消息，不清掉它们的话，落库后的同一条发言会在屏幕上
      // 出现两遍，而且每轮以后还会继续叠；`.empty` 留着则会和一整屏消息并排站着。
      for (const stale of flow.querySelectorAll<HTMLElement>('.msg:not([data-id])')) {
        stale.remove()
      }
      if (next.messages.length > 0) flow.querySelector<HTMLElement>('.empty')?.remove()
      // 画法变过的那几条就地换掉：主进程只给「最后一条」补状态页，
      // 上一轮那条的占位符这一轮会被拿掉，不换的话同一份状态页会挂两条
      for (let index = 0; index < prev.length; index++) {
        const before = prev[index]!
        const after = next.messages[index]!
        if (sameRendering(before, after)) continue
        const old = flow.querySelector<HTMLElement>(`.msg[data-id="${before.id}"]`)
        if (old) old.replaceWith(messageNode(after))
      }
      for (const item of next.messages.slice(prev.length)) flow.append(messageNode(item))
      pushRuntime()
      scrollToBottom()
      return
    }
    repaint(next)
  }

  /** 发言人抬头：小立绘 + 名字，群聊里每条回复都挂一个 */
  const speakerNode = (name: string): HTMLElement => {
    const node = h('div', 'msg-speaker')
    const member = current.members.find((item) => item.name === name)
    if (member) node.append(cover('msg-avatar', member.avatarPath, member.name))
    node.append(h('span', 'msg-speaker-name', name))
    return node
  }

  const messageNode = (item: ChatMessageNode): HTMLElement => {
    const wrap = h('div', `msg ${item.role === 'user' ? 'user' : 'assistant'}`)
    wrap.dataset['id'] = item.id

    // 分支切换：同一起点下的多条回复，上面挂 ‹ 1/2 ›
    if (item.branchCount > 1) {
      const bar = h('div', 'branch-bar')
      const prev = h('button', '', '‹')
      const next = h('button', '', '›')
      const index = item.branchIndex
      prev.disabled = index === 0
      next.disabled = index === item.branchCount - 1
      prev.onclick = (): void => void switchBranch(item.branchIds[index - 1])
      next.onclick = (): void => void switchBranch(item.branchIds[index + 1])
      bar.append(prev, h('span', '', `${index + 1} / ${item.branchCount}`), next)
      wrap.append(bar)
    }

    let body: HTMLElement
    if (item.role === 'user') {
      body = h('div', 'bubble')
      body.textContent = item.content
    } else {
      // 群聊里正文落库时带着「名字：」前缀：拆出来画成发言人抬头，正文只留说的话
      const parsed = isGroup
        ? parseSpeaker(item.content, current.members.map((member) => member.name))
        : { speaker: null, text: item.content }
      if (parsed.speaker) wrap.append(speakerNode(parsed.speaker))
      body = h('div', 'text')
      paintText(body, parsed.text)
    }
    wrap.append(body)
    // 被打断的半句：不标一下的话读起来像莫名其妙断在一半
    if (item.interrupted) wrap.append(h('div', 'msg-cut', '被打断了'))

    const ops = h('div', 'ops')
    if (item.role === 'assistant') {
      const regen = h('button', '', '重生成')
      regen.onclick = (): void => {
        if (streaming) return
        beginStream()
        window.tavern.chatRegenerate(current.chat.id, item.id, pageRef.currentTurn)
      }
      ops.append(regen)
    } else if (item.resendable && !streaming) {
      // 分支末尾悬着一条没有回复的用户消息：多半是崩溃 / 强退留下的，给个重发入口
      const resend = h('button', '', '重发')
      resend.title = '这一轮没有回复（可能上次异常退出了），再发一次'
      resend.onclick = (): void => {
        if (streaming) return
        beginStream()
        window.tavern.chatResend(current.chat.id, item.id, pageRef.currentTurn)
      }
      ops.append(resend)
    }
    const edit = h('button', '', '编辑')
    edit.onclick = (): void => startEdit(wrap, body, item)
    const copy = h('button', '', '复制')
    copy.onclick = (): void => void navigator.clipboard.writeText(item.content)
    const remove = h('button', '', '删除')
    remove.onclick = async (): Promise<void> => {
      if (!window.confirm('删除这条消息？')) return
      await window.tavern.chatDelete(item.id)
      await refresh()
    }
    ops.append(edit, copy, remove)
    wrap.append(ops)
    return wrap
  }

  const startEdit = (wrap: HTMLElement, body: HTMLElement, item: ChatMessageNode): void => {
    if (wrap.querySelector('.editor')) return
    const editor = h('div', 'editor')
    const box = document.createElement('textarea')
    box.value = item.content
    const bars = h('div', 'edit-ops')
    const save = h('button', 'btn primary', '保存')
    const cancel = h('button', 'btn ghost', '取消')
    bars.append(save, cancel)
    editor.append(box, bars)
    body.hidden = true
    wrap.insertBefore(editor, body)
    box.focus()

    cancel.onclick = (): void => {
      editor.remove()
      body.hidden = false
    }
    save.onclick = async (): Promise<void> => {
      if (!box.value.trim()) return
      // 编辑不原地覆盖：主进程会从同一个父节点长出一条新分支
      await window.tavern.chatEdit(item.id, box.value)
      await refresh()
    }
  }

  const switchBranch = async (messageId: string): Promise<void> => {
    const next = await window.tavern.chatBranch(current.chat.id, messageId)
    if (!next) return
    // 切分支用的是刚拿到的视图，比任何在途的刷新都新：作废它们，
    // 否则先发出的快照后落地，会把屏幕上的分支盖回旧叶子
    refreshSeq++
    repaint(next)
  }

  const startNewChat = async (): Promise<void> => {
    // 群聊没有「重开一场」的入口；这里兜底，免得被键盘 / 旧引用触发
    if (isGroup) return
    // 重开一场也让人挑开场白：卡里写了 9 条备选，不该永远只看得到随机那条
    const greetings = await window.tavern.chatGreetings(view.character.id)
    let next: ChatView | null = null
    if (greetings && greetings.options.length > 0) {
      const choice = await pickGreeting(rootEl(), greetings.options, '重开一场：选个开场白')
      if (!choice) return
      next = await window.tavern.chatStart(view.character.id, choice.index)
    } else {
      next = await window.tavern.chatNew(view.character.id)
    }
    if (!next) return
    // 等结果期间已经离开聊天页（点了返回）：不能再往拆掉的 DOM 里画，
    // 更不能 attachPage() 把不在文档里的页面重新登记成 activePage 去吞事件
    if (!pageRef.alive) return
    disposeChatPage()
    // 重开一场时上一轮可能还在流：停掉它，并把临时节点丢掉，
    // 否则重绘会把它又挂到新会话的末尾
    window.tavern.chatStop()
    pageRef.stream = null
    repaint(next)
    setStreaming(false)
    // 重开后要重新登记这次页面，否则流式事件找不到主人
    attachPage()
    // 观战是「按会话」的：换了一场，抽屉要重新读它的开关
    notifyReady()
    // 变量 / 状态条 / 心动接话都是**上一场**的：不重取的话，新开场白的
    // html 状态页会按旧数值画，输入框上方还挂着上一场的接话 chip
    paintAlts([])
    void syncRuntime().then(() => refresh())
    void reloadStatus().catch(() => {})
  }

  const setStreaming = (value: boolean): void => {
    streaming = value
    sendBtn.textContent = value ? '停止' : '发送'
    sendBtn.classList.toggle('primary', !value)
    sendBtn.classList.toggle('danger', value)
    input.disabled = false
  }

  /** 摆一个空的回复节点，token 到了往里写 */
  const showStreamNode = (speaker: string | null = null): void => {
    const node = h('div', 'msg assistant typing')
    if (speaker) node.append(speakerNode(speaker))
    const textNode = h('div', 'text')
    node.append(textNode)
    flow.append(node)
    scrollToBottom()
    pageRef.stream = { node, text: textNode, content: '', speaker }
    setStreaming(true)
  }

  /**
   * 群聊：这一轮轮到下一个人。上一位说的话还留在屏幕上（done 之后整页重绘会换成
   * 带分支按钮的正式节点），这一位另起一条；上一位还没吐出字就先把空壳撤掉。
   */
  const onSpeaker = (name: string): void => {
    if (pageRef.stream) {
      if (pageRef.stream.speaker === name && !pageRef.stream.content) return
      if (!pageRef.stream.content) pageRef.stream.node.remove()
      else pageRef.stream.node.classList.remove('typing')
    }
    showStreamNode(name)
  }

  /** 开一轮流式：领轮次号 + 先把节点摆出来 */
  const beginStream = (): void => {
    pageRef.currentTurn = ++clientTurn
    showStreamNode()
  }

  const send = (): void => {
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    sayHint('')
    // 上一轮的接话建议已经用不上了
    paintAlts([])
    // 用户消息由主进程落库；这里先本地画一条，省掉一次往返
    const optimistic = h('div', 'msg user')
    const bubble = h('div', 'bubble')
    bubble.textContent = text
    optimistic.append(bubble)
    flow.append(optimistic)

    beginStream()
    // 上一轮的朗读立刻收住，新的一轮马上会开口
    voice.stop()
    window.tavern.chatSend(current.chat.id, text, pageRef.currentTurn)
  }

  sendBtn.onclick = (): void => {
    if (streaming) {
      window.tavern.chatStop()
      return
    }
    send()
  }

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    // 中文输入法选词时的回车不能当发送（桌宠输入栏踩过同一个坑）
    if (event.isComposing) return
    event.preventDefault()
    if (streaming) return
    send()
  })

  /**
   * 第一轮聊完之后的一次性小提示（T9 引导的收尾）：只出现一次，之后不再打扰。
   * 严格业务上讲这条不算「功能」，但新用户第一步最容易卡在「然后呢」。
   */
  const maybeFirstGreet = async (): Promise<void> => {
    if (greetAttempted) return
    greetAttempted = true
    const state = await window.tavern.onboardingGet().catch(() => null)
    if (!state || state.greetShown) return
    await window.tavern.onboardingSet({ greetShown: true }).catch(() => {})
    const toast = h('div', 'toast', '这就是酒馆啦，慢慢认识大家吧。⋯ 面板里还有更多设置。')
    page.append(toast)
    setTimeout(() => toast.remove(), 6000)
  }

  const onToken = (delta: string): void => {
    // 切走再切回来时这一轮还在流：轮次号接上了但没有节点，第一个 token 到了才把
    // 节点摆出来（done 早于回来就不留空壳，也不会丢掉后面的正文）
    if (!pageRef.stream) showStreamNode()
    const stream = pageRef.stream!
    stream.content += delta
    // 围栏里的状态栏先藏起来：边流边把三万字 HTML 当正文滚过去太难看，
    // 这一轮结束后整页重绘时会变成 iframe
    paintText(stream.text, streamText(stream.content))
    scrollToBottom()
  }

  const onDone = (): void => {
    pageRef.stream?.node.remove()
    pageRef.stream = null
    setStreaming(false)
    sayHint('')
    // 流完了整页重拉：主进程刚把回复落进消息树，分支序号也可能变了；
    // 变量也可能刚被 `<update>` 改过，所以先取变量再重绘，否则状态栏还是上一轮的数
    void syncRuntime().then(() => refresh())
    void maybeFirstGreet()
  }

  const onError = (message: string): void => {
    pageRef.stream?.node.remove()
    pageRef.stream = null
    setStreaming(false)
    sayHint(message, true)
    // 主进程那边用户消息可能已经落库（网络失败），重拉一遍让界面和库对上
    void refresh()
  }

  // 刚离开又回到同一场对话、那一轮还没收尾：接着用原来的轮次号
  const resumedTurn = detachedTurns.get(current.chat.id) ?? 0
  detachedTurns.delete(current.chat.id)

  const pageRef: ChatPage = {
    chatId: current.chat.id,
    alive: true,
    currentTurn: resumedTurn,
    stream: null,
    onToken,
    onSpeaker,
    onDone,
    onError,
    onSummary: setSummarizing,
    onVariables: paintStatus,
    onAlternatives: paintAlts,
    onAppearance: (settings: Appearance) => {
      appearance = settings
      applyAppearance(settings)
      repaintBackground()
    },
    onTts: (audio: string, mime: string) => voice.enqueue(audio, mime),
    // 「不会再有下一段了」不需要操作：队列里的念完自然停
    onTtsEnd: () => {},
    onTtsStop: () => voice.stop(),
    // 状态栏页面里的按钮：把这句话放进输入框，发不发由用户决定
    onFrameText: (text: string) => {
      input.value = text
      input.focus()
      sayHint('已放进输入框，按 Enter 发送。')
    },
    onFrameEvent: (event: FrameEvent) => {
      if (event.kind === 'focus') {
        input.focus()
        return
      }
      if (event.kind === 'toast') {
        sayHint(event.message)
        return
      }
      if (event.kind === 'vars') {
        // 卡里的按钮直接改了变量（Mvu.replaceMvuData / setMvuVariable / /setvar）：
        // 先落库，再推给所有状态栏，页面自己的重绘回调会跟着跑
        runtime = { ...runtime, statData: event.state }
        void window.tavern
          .variablesSet(current.chat.id, event.state)
          .catch((error: unknown) => sayHint(`状态没存上：${(error as Error).message}`, true))
        pushRuntime()
        return
      }
      // 剩下没实现的斜杠命令：给个提示，别让按钮看起来像点了没反应
      sayHint(`这个按钮要用酒馆命令 ${event.command.split(/\s/)[0]}，暂时不支持。`)
      console.warn('[状态栏] 未支持的斜杠命令：', event.command)
    }
  }
  const attachPage = (): void => {
    pageRef.chatId = current.chat.id
    pageRef.alive = true
    activePage = pageRef
  }
  const notifyReady = (): void => {
    handlers.onReady?.({
      chatId: current.chat.id,
      characterId: current.character.id,
      characterName: current.character.name,
      group: isGroup
    })
  }
  attachPage()
  notifyReady()

  // 状态栏 iframe 要拿变量才画得出内容：先取一份再画第一屏
  await syncRuntime()
  if (!pageRef.alive) return
  applyAppearance(appearance)
  repaintBackground()
  repaint(current)

  // 回到一场刚才还在流的对话：这份快照可能停在那条回复落库之前（done 在我们离开时
  // 发过、被丢掉），补拉一次。还在流的正文由 onToken 把临时节点补起来。
  if (resumedTurn > 0) void refresh()

  // 进来时可能正在摘要（上一轮刚结束、我们刚好切回来）：补一次当前状态
  void window.tavern
    .summaryGet(current.chat.id)
    .then((state) => {
      if (pageRef.alive && pageRef.chatId === current.chat.id) setSummarizing(state.summarizing)
    })
    .catch(() => {})
  // 状态条与上一轮的接话建议：它们在事件里来，切回页面时补一次快照
  void reloadStatus().catch(() => {})
  void window.tavern
    .alternativesGet(current.chat.id)
    .then((items) => {
      if (pageRef.alive) paintAlts(items)
    })
    .catch(() => {})
}
