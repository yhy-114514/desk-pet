// 右栏：鲸鱼娘观战抽屉（T7）。默认关，开了之后可以问她「刚才发生了什么」，
// 也可以点「出点主意」让她按观测档案给剧情方向。
//
// 问答记录只存在这一页的内存里：它是一次性的聊天，不是酒馆的消息树，
// 不该写进 tavern.db（主进程那边同理，spectator.ts 全程只读）。
import { h } from './ui'

interface SpectatorContext {
  chatId: string
  characterId: string
  characterName: string
  /** 群聊：她只能旁观一场单人对谈，几个人混在一起她分不清谁是谁 */
  group?: boolean
}

interface LogEntry {
  role: 'user' | 'bot'
  text: string
}

/** 一场会话的问答案，按 chatId 存着：切回角色库再进来不至于全没了 */
const logs = new Map<string, LogEntry[]>()
const MAX_LOGS = 40

export interface SpectatorDrawer {
  /** 进到某场对话：显示状态并接上这场的历史问答 */
  show: (context: SpectatorContext) => void
  /** 离开对话（回角色库 / 编辑页）：抽屉只留下静态提示 */
  hide: () => void
}

interface LiveDrawer {
  current: SpectatorContext | null
  /** 正在流式的那条答案（没有就是 null） */
  pending: HTMLElement | null
  onToken: (delta: string) => void
  onError: (message: string) => void
  onDone: () => void
}

let live: LiveDrawer | null = null
let bound = false

function bindListeners(): void {
  if (bound) return
  bound = true
  window.tavern.onSpectatorToken((data) => {
    if (live?.current?.chatId === data.chatId) live.onToken(data.delta)
  })
  window.tavern.onSpectatorDone((data) => {
    if (live?.current?.chatId === data.chatId) live.onDone()
  })
  window.tavern.onSpectatorError((data) => {
    if (live?.current?.chatId === data.chatId) live.onError(data.error)
  })
}

export function createSpectatorDrawer(host: HTMLElement): SpectatorDrawer {
  bindListeners()
  host.replaceChildren()

  const head = h('div', 'col-head', '旁观')

  const state = h('div', 'spec-state')
  const dot = h('div', 'dot')
  const stateText = h('div', 'spec-state-text', '进一场对话，她才会开始看。')
  const toggle = h('button', 'switch', '观战')
  toggle.title = '让她读这场对话的观测档案（只读，不会插话）'
  state.append(dot, stateText, h('div', 'grow'), toggle)

  const chips = h('div', 'spec-chips')
  const askChip = h('button', '', '刚才发生了什么？')
  const ideaChip = h('button', '', '出点主意')
  chips.append(askChip, ideaChip)

  const log = h('div', 'spec-log')
  const hint = h('div', 'spec-hint', '')

  const composer = h('div', 'spec-composer')
  const input = document.createElement('textarea')
  input.placeholder = '问她点什么…'
  input.rows = 1
  input.disabled = true
  const askBtn = h('button', 'btn', '问')
  askBtn.disabled = true
  composer.append(input, askBtn)

  host.append(head, state, chips, log, hint, composer)

  let enabled = false
  let busy = false
  const say = (text: string, bad = false): void => {
    hint.textContent = text
    hint.classList.toggle('bad', bad)
  }

  const paintState = (): void => {
    const ctx = live?.current ?? null
    if (!ctx) {
      dot.classList.remove('on')
      stateText.textContent = '进一场对话，她才会开始看。'
      toggle.textContent = '观战'
      toggle.classList.remove('on')
      toggle.hidden = true
      // 回到角色库后抽屉是失效的，输入框和 chip 也要跟着锁上
      input.disabled = true
      askBtn.disabled = true
      askChip.disabled = true
      ideaChip.disabled = true
      return
    }
    if (ctx.group) {
      toggle.hidden = true
      dot.classList.remove('on')
      stateText.textContent = '群聊里人太多，她看不明白谁在说话。'
      input.disabled = true
      askBtn.disabled = true
      askChip.disabled = true
      ideaChip.disabled = true
      return
    }
    toggle.hidden = false
    dot.classList.toggle('on', enabled)
    stateText.textContent = enabled
      ? `鲸鱼娘正安静地看着「${ctx.characterName}」`
      : '她这会儿没在看，也没在听。'
    toggle.textContent = enabled ? '歇着' : '观战'
    toggle.classList.toggle('on', enabled)
    input.disabled = !enabled
    askBtn.disabled = !enabled
    askChip.disabled = !enabled
    ideaChip.disabled = !enabled
  }

  const paintLog = (): void => {
    const ctx = live?.current
    log.replaceChildren()
    if (!ctx) return
    if (ctx.group) {
      log.append(h('div', 'spec-empty', '她只在单人对话里观战。\n群聊里各人的档案是分开的，凑不到一起。'))
      return
    }
    const entries = logs.get(ctx.chatId) ?? []
    if (entries.length === 0) {
      log.append(
        h(
          'div',
          'spec-empty',
          enabled
            ? '她读完了档案，在等你想问什么。\n她不会主动插话。'
            : '点上面的「观战」，她就会读这场对话的观测档案。\n只读，不改剧情，也不替角色说话。'
        )
      )
      return
    }
    for (const entry of entries) log.append(bubble(entry.role, entry.text))
    scroll()
  }

  const bubble = (role: LogEntry['role'], text: string): HTMLElement => {
    const node = h('div', `spec-msg ${role}`)
    if (role === 'bot') node.append(h('div', 'spec-who', '鲸鱼娘'))
    node.append(h('div', 'spec-text', text))
    return node
  }

  const scroll = (): void => {
    log.scrollTop = log.scrollHeight
  }

  const push = (role: LogEntry['role'], text: string): void => {
    const ctx = live?.current
    if (!ctx) return
    const entries = logs.get(ctx.chatId) ?? []
    entries.push({ role, text })
    // 只留最近几十条，防止问一下午把内存吃满
    if (entries.length > MAX_LOGS) entries.splice(0, entries.length - MAX_LOGS)
    logs.set(ctx.chatId, entries)
  }

  const ask = async (question: string, mode: 'ask' | 'idea'): Promise<void> => {
    const ctx = live?.current
    if (!ctx || !enabled || busy) return
    const text = question.trim()
    if (!text) return
    busy = true
    say('')
    input.value = ''
    push('user', text)
    paintLog()
    // 先摆一条空的答案，token 到了往里写
    const node = bubble('bot', '')
    const body = node.querySelector('.spec-text') as HTMLElement
    log.append(node)
    scroll()
    drawer.pending = body
    askBtn.disabled = true
    let failed = false
    try {
      const result = await window.tavern.spectatorAsk({ chatId: ctx.chatId, question: text, mode })
      if (!result.ok) {
        failed = true
        say(result.error ?? '她没回上来，再问一次？', true)
      }
    } catch (error) {
      failed = true
      say(`她没回上来：${String(error)}`, true)
    } finally {
      busy = false
      if (drawer.current?.chatId === ctx.chatId) {
        // done 事件已经把全文 push 进 logs 并清掉了 pending；
        // 中途断掉时把已收到的半截留下，别让她的话凭空消失
        const partial = drawer.pending?.textContent ?? ''
        drawer.pending = null
        // 断流也把已收到的半截留下：下面 paintLog 会整块重建，不留就等于抹掉
        if (partial) push('bot', partial)
        askBtn.disabled = !enabled
        paintLog()
      }
    }
  }

  toggle.onclick = (): void => {
    const ctx = live?.current
    if (!ctx) return
    const next = !enabled
    toggle.disabled = true
    void window.tavern
      .spectatorSet(ctx.chatId, next)
      .then((value) => {
        // 等请求回来时可能已经换到别的会话：别把这场的开关画到那场上
        if (drawer.current?.chatId !== ctx.chatId) return
        enabled = value
        paintState()
        paintLog()
        say(
          value
            ? '她翻开档案了。聊一段之后，她会跟着剧情一起更新。'
            : '她合上档案，游去别处了。'
        )
      })
      .catch((error: unknown) => say(`开关没成功：${String(error)}`, true))
      .finally(() => {
        toggle.disabled = false
      })
  }

  askChip.onclick = (): void => {
    void ask('刚才发生了什么？用旁观的口吻说两句。', 'ask')
  }
  ideaChip.onclick = (): void => {
    void ask('根据观测档案和还没收的伏笔，给我两三个接下来的剧情方向，要引用真实的剧情节点。', 'idea')
  }
  askBtn.onclick = (): void => {
    void ask(input.value, 'ask')
  }
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.isComposing) return
    event.preventDefault()
    void ask(input.value, 'ask')
  })

  const drawer: LiveDrawer = {
    current: null,
    pending: null,
    onToken: (delta) => {
      if (!drawer.pending) return
      drawer.pending.textContent = (drawer.pending.textContent ?? '') + delta
      scroll()
    },
    onError: (message) => {
      say(message, true)
    },
    onDone: () => {
      if (!drawer.pending) return
      const text = drawer.pending.textContent ?? ''
      if (text) push('bot', text)
      drawer.pending = null
    }
  }
  live = drawer
  const self: SpectatorDrawer = {
    show: (context) => {
      drawer.current = context
      say('')
      // 先按「没开」画，等主进程回来再改成真值：上一场开着的话，
      // 不重置会把「正安静地看着…」和可用的输入框带到这一场
      enabled = false
      if (context.group) {
        paintState()
        paintLog()
        return
      }
      // 状态以主进程为准：左栏换角色后这场可能是关着的
      void window.tavern
        .spectatorGet(context.chatId)
        .then((state) => {
          if (drawer.current?.chatId !== context.chatId) return
          enabled = state.enabled
          paintState()
          paintLog()
          if (state.enabled && !state.hasArchive && state.messageCount > 4) {
            say('档案还在攒，先聊几轮她就记得更清楚。')
          }
        })
        .catch((error: unknown) => {
          if (drawer.current?.chatId !== context.chatId) return
          enabled = false
          paintState()
          paintLog()
          say(`读不到观战状态：${String(error)}`, true)
        })
      paintState()
      paintLog()
    },
    hide: () => {
      drawer.current = null
      drawer.pending = null
      enabled = false
      input.value = ''
      paintState()
      paintLog()
    }
  }
  paintState()
  paintLog()
  return self
}
