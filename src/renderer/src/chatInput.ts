// 聊天输入栏（#chat-input 窗口）：全局快捷键唤起的小浮窗，回车发送、Esc 收起。
// 只做输入转发，不初始化 PixiJS。
import { VoiceRecorder } from './voiceRecorder'

/** ArrayBuffer → base64。分块拼：一次性展开整段音频会把调用栈撑爆 */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function renderChatInput(): void {
  document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden'

  const card = document.createElement('div')
  card.style.cssText =
    'display:flex;align-items:center;gap:8px;box-sizing:border-box;' +
    'width:100%;height:100vh;padding:14px 16px;' +
    'background:var(--pet-bar-bg);border:1px solid var(--pet-bar-border);' +
    'border-radius:14px;font:14px var(--pet-font)'

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = '和傻鱼说点什么…'
  input.style.cssText =
    'flex:1;min-width:0;background:var(--pet-input-bg);color:var(--pet-text);border:1px solid var(--pet-border);' +
    'border-radius:9px;padding:9px 12px;font:14px var(--pet-font);outline:none'
  input.addEventListener('focus', () => {
    input.style.borderColor = 'var(--pet-border-focus)'
  })
  input.addEventListener('blur', () => {
    input.style.borderColor = 'var(--pet-border)'
  })

  const hint = document.createElement('span')
  hint.textContent = 'Enter 发送 · Esc 取消'
  hint.style.cssText = 'color:var(--pet-faint);font-size:12px;white-space:nowrap'

  // 喂饭：和托盘菜单同一入口（她闲着/睡着时才吃得进去）
  const feed = document.createElement('span')
  feed.textContent = '喂饭'
  feed.style.cssText = 'color:var(--pet-link);font-size:12px;white-space:nowrap;cursor:pointer'
  feed.onclick = (): void => {
    window.petWindow.feed()
    window.chat.hideInput()
  }

  // 记忆手账入口：看看她到底记住了什么
  const memory = document.createElement('span')
  memory.textContent = '记忆'
  memory.style.cssText = 'color:var(--pet-link);font-size:12px;white-space:nowrap;cursor:pointer'
  memory.onclick = (): void => {
    window.chat.hideInput()
    window.chat.openMemory()
  }

  // 提醒列表入口：她答应过的事设完也得查得到、撤得掉
  const reminders = document.createElement('span')
  reminders.textContent = '提醒'
  reminders.style.cssText = 'color:var(--pet-link);font-size:12px;white-space:nowrap;cursor:pointer'
  reminders.onclick = (): void => {
    window.chat.hideInput()
    window.chat.openReminders()
  }

  // 配置入口：配置窗只在首次启动无 Key 时自动弹出，之后从这里的「设置」再打开
  const settings = document.createElement('span')
  settings.textContent = '设置'
  settings.style.cssText = 'color:var(--pet-link);font-size:12px;white-space:nowrap;cursor:pointer'
  settings.onclick = (): void => {
    window.chat.hideInput()
    window.chat.openConfig()
  }

  // 语音输入：点一下 🎤 开始、再点一下结束。
  // （试过「按住空格录音」，但空格在输入框里本来就是打空格，冲突比便利大，已去掉。）
  // 识别结果填进输入框让人看一眼再发：识别错一个词吐出去，比多按一次回车难受得多。
  const DEFAULT_HINT = hint.textContent ?? 'Enter 发送 · Esc 取消'
  const MAX_RECORD_MS = 60_000
  type VoiceState = 'idle' | 'starting' | 'recording' | 'transcribing'
  let state: VoiceState = 'idle'
  let recorder: VoiceRecorder | null = null
  let maxTimer: ReturnType<typeof setTimeout> | null = null
  let hintTimer: ReturnType<typeof setTimeout> | null = null

  const setHint = (text: string, color = 'var(--pet-faint)', restoreAfter = 0): void => {
    if (hintTimer) clearTimeout(hintTimer)
    hint.textContent = text
    hint.style.color = color
    if (restoreAfter > 0) {
      hintTimer = setTimeout(() => {
        hint.textContent = DEFAULT_HINT
        hint.style.color = 'var(--pet-faint)'
      }, restoreAfter)
    }
  }

  const resetVoice = (): void => {
    if (maxTimer) {
      clearTimeout(maxTimer)
      maxTimer = null
    }
    state = 'idle'
    recorder = null
    mic.style.color = 'var(--pet-link)'
  }

  const startRecording = async (): Promise<void> => {
    if (state !== 'idle') return
    state = 'starting'
    const pending = new VoiceRecorder()
    setHint('正在打开麦克风…')
    try {
      await pending.start()
    } catch (error) {
      resetVoice()
      setHint(
        `麦克风打不开：${error instanceof Error ? error.message.slice(0, 40) : '未知原因'}`,
        'var(--pet-danger)',
        5000
      )
      return
    }
    // 等系统响应的这几百毫秒里可能已经点了第二下、或松开了空格
    if (state !== 'starting') {
      pending.cancel()
      return
    }
    recorder = pending
    state = 'recording'
    mic.style.color = 'var(--pet-recording)'
    setHint('正在录音 · 再点一下结束', 'var(--pet-danger-soft)')
    maxTimer = setTimeout(() => void finishRecording(), MAX_RECORD_MS)
  }

  /** 录制中反悔：丢掉音频，不识别 */
  const cancelRecording = (): void => {
    if (state === 'idle' || state === 'transcribing') return
    recorder?.cancel()
    resetVoice()
    setHint('已取消', 'var(--pet-faint)', 2000)
  }

  const finishRecording = async (): Promise<void> => {
    if (state !== 'recording' || !recorder) return
    const active = recorder
    state = 'transcribing'
    recorder = null
    if (maxTimer) {
      clearTimeout(maxTimer)
      maxTimer = null
    }
    mic.style.color = 'var(--pet-link)'
    const wav = await active.stop()
    if (!wav || wav.byteLength <= 44) {
      state = 'idle'
      setHint('没录到声音', 'var(--pet-danger)', 3000)
      return
    }
    setHint('识别中…', 'var(--pet-link)')
    const result = await window.voice.transcribe(toBase64(wav), 'audio/wav')
    state = 'idle'
    if (!result.ok || !result.text) {
      setHint(result.error ?? '没听清，再说一遍？', 'var(--pet-danger)', 6000)
      return
    }
    // 接在已有内容后面（可能先手打了一半）
    input.value = input.value ? `${input.value.trim()} ${result.text}` : result.text
    input.focus()
    setHint(DEFAULT_HINT)
  }

  const mic = document.createElement('span')
  mic.textContent = '🎤'
  mic.title = '点一下开始录音，再点一下结束'
  mic.style.cssText =
    'color:var(--pet-link);font-size:14px;white-space:nowrap;cursor:pointer;user-select:none;-webkit-user-select:none'
  mic.addEventListener('click', () => {
    if (state === 'idle') void startRecording()
    else if (state === 'starting') cancelRecording()
    else if (state === 'recording') void finishRecording()
    // 识别中点了没用：等这一次的结果回来
  })
  // 录音期间窗口失活（切到别的程序）就把这段收尾，不能让麦克风一直开着
  window.addEventListener('blur', () => {
    if (state === 'recording') void finishRecording()
    else if (state === 'starting') cancelRecording()
  })

  const submit = (): void => {
    // 录音/识别中不发送：此时输入框可能是空的，发出去等于把输入栏关掉
    if (state !== 'idle') return
    const text = input.value.trim()
    input.value = ''
    if (text) window.chat.send(text)
    window.chat.hideInput()
  }

  input.addEventListener('keydown', (event) => {
    // 中文输入法用回车确认候选词：此时不能当成「发送」
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape') {
      if (state === 'starting' || state === 'recording') cancelRecording()
      input.value = ''
      window.chat.hideInput()
    }
  })

  card.append(input, mic, hint, feed, memory, reminders, settings)
  document.body.appendChild(card)

  // 窗口每次被快捷键唤起时主进程会 focus 窗口，这里跟着聚焦输入框
  window.addEventListener('focus', () => input.focus())
  input.focus()
}
