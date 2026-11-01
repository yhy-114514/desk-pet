// T5 的外观与通用设置面板：背景 / 气泡与三色 / 通用（主题·字体·朗读·背景音乐）。
// 所有改动即时落库、即时生效；底部那颗按钮的语义是「撤销本页本次的修改」，不是保存。
import {
  applyAppearance,
  DEFAULT_APPEARANCE,
  mediaUrl,
  type Appearance,
  type AppearanceTab
} from './appearance'
import { h } from './ui'

export interface AppearancePanelOptions {
  root: HTMLElement
  tab: AppearanceTab
  /** 跟随封面模式要用 */
  avatarPath: string | null
  /** 外观变了：聊天页要重画背景 */
  onChanged?: () => void
}

const TAB_LABELS: Record<AppearanceTab, string> = {
  background: '背景',
  bubble: '气泡',
  general: '通用'
}

export function openAppearancePanel(options: AppearancePanelOptions): void {
  const { root } = options
  const overlay = h('div', 'modal-mask')
  const box = h('div', 'modal prompt-modal')
  const title = h('div', 'modal-title', '外观')
  const close = h('button', 'modal-close', '✕')
  const dismiss = (): void => overlay.remove()
  close.onclick = dismiss
  overlay.onclick = (event): void => {
    if (event.target === overlay) dismiss()
  }
  const head = h('div', 'modal-head')
  head.append(title, h('div', 'grow'), close)

  const notice = h('div', 'notice', '')
  const say = (text: string, bad = false): void => {
    notice.textContent = text
    notice.classList.toggle('bad', bad)
  }

  // 页签
  const tabs = h('div', 'prompt-tabs')
  let activeTab: AppearanceTab = options.tab
  const tabButtons: Record<string, HTMLElement> = {}
  for (const key of Object.keys(TAB_LABELS) as AppearanceTab[]) {
    const button = h('button', '', TAB_LABELS[key])
    button.onclick = (): void => {
      activeTab = key
      paintTabs()
      paint()
    }
    tabs.append(button)
    tabButtons[key] = button
  }
  const paintTabs = (): void => {
    for (const [key, button] of Object.entries(tabButtons)) {
      button.setAttribute('aria-pressed', String(key === activeTab))
    }
  }
  paintTabs()

  const body = h('div', 'modal-body')
  const foot = h('div', 'foot')
  const resetBtn = h('button', 'btn ghost', '撤销本页本次的修改')
  foot.append(h('div', 'msg', '改动即时生效'), h('div', 'grow'), resetBtn)

  box.append(head, notice, tabs, body, foot)
  overlay.append(box)
  root.append(overlay)

  let current: Appearance = DEFAULT_APPEARANCE
  let snapshot: Appearance = DEFAULT_APPEARANCE
  let loaded = false

  const save = (patch: Partial<Appearance>): void => {
    void window.tavern
      .appearanceSet(patch)
      .then((next) => {
        current = next
        applyAppearance(current)
        options.onChanged?.()
        paint()
      })
      .catch((error: unknown) => say(`设置没存上：${String(error)}`, true))
  }

  // ── 通用控件 ──
  const sectionTitle = (text: string): HTMLElement => h('div', 'section-title', text)

  const toggle = (
    label: string,
    value: boolean,
    onChange: (value: boolean) => void
  ): HTMLElement => {
    const row = h('div', 'set-row')
    const button = h('button', `switch${value ? ' on' : ''}`, value ? '开' : '关')
    button.onclick = (): void => {
      const next = button.textContent !== '开'
      button.textContent = next ? '开' : '关'
      button.classList.toggle('on', next)
      onChange(next)
    }
    row.append(h('div', 'set-label', label), h('div', 'grow'), button)
    return row
  }

  const slider = (
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    unit: string,
    onInput: (value: number) => void
  ): HTMLElement => {
    const row = h('div', 'set-row')
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    input.value = String(value)
    input.className = 'slider'
    const now = h('div', 'set-value', `${value}${unit}`)
    input.oninput = (): void => {
      now.textContent = `${input.value}${unit}`
    }
    input.onchange = (): void => onInput(Number(input.value))
    row.append(h('div', 'set-label', label), input, now)
    return row
  }

  const choice = (
    label: string,
    items: Array<{ key: string; text: string }>,
    value: string,
    onChange: (key: string) => void
  ): HTMLElement => {
    const row = h('div', 'set-row')
    const group = h('div', 'chips')
    group.style.padding = '0'
    for (const item of items) {
      const button = h('button', 'chip', item.text)
      button.setAttribute('aria-pressed', String(item.key === value))
      button.onclick = (): void => onChange(item.key)
      group.append(button)
    }
    row.append(h('div', 'set-label', label), group)
    return row
  }

  const colorRow = (label: string, value: string, onChange: (value: string) => void): HTMLElement => {
    const row = h('div', 'set-row')
    const input = document.createElement('input')
    input.type = 'color'
    input.value = value
    input.style.cssText =
      'width:44px;height:26px;border:1px solid var(--line);border-radius:6px;background:transparent;padding:1px;cursor:pointer'
    input.onchange = (): void => onChange(input.value)
    const text = h('div', 'set-value', value)
    text.style.width = 'auto'
    row.append(h('div', 'set-label', label), input, text, h('div', 'grow'))
    return row
  }

  const pickImageBtn = (): HTMLElement => {
    const row = h('div', 'set-row')
    const label = h('div', 'set-label', '自定义图片')
    const preview = h('div', 'hintline', '')
    preview.style.cssText = 'max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    const pick = h('button', 'btn', '选择图片…')
    pick.onclick = (): void => {
      void window.tavern.appearanceMediaPick('image').then((name) => {
        if (!name) return
        save({ background: { mode: 'custom', image: name, dim: current.background.dim } })
        say('背景已换。')
      })
    }
    row.append(label, pick, preview, h('div', 'grow'))
    return row
  }

  const bgPreview = (): HTMLElement => {
    const wrap = h('div', 'rich-frame')
    wrap.style.cssText = 'height:120px;margin:4px 0 12px;position:relative'
    wrap.dataset['role'] = 'bg-preview'
    return wrap
  }

  // ── 三个页签 ──
  const paintBackground = (): void => {
    const bg = current.background
    body.append(
      sectionTitle('聊天背景'),
      choice(
        '背景',
        [
          { key: 'default', text: '深海渐变' },
          { key: 'cover', text: '跟随角色封面' },
          { key: 'custom', text: '自定义图片' }
        ],
        bg.mode,
        (mode) => save({ background: { mode: mode as Appearance['background']['mode'], image: bg.image, dim: bg.dim } })
      )
    )
    const preview = bgPreview()
    const source =
      bg.mode === 'cover' && options.avatarPath
        ? `tavern-avatar://local/${encodeURIComponent(options.avatarPath)}`
        : bg.mode === 'custom' && bg.image
          ? mediaUrl(bg.image)
          : ''
    if (source) {
      preview.style.backgroundImage = `url("${source}")`
      preview.style.backgroundSize = 'cover'
      preview.style.backgroundPosition = 'center'
    } else {
      preview.append(h('div', 'hintline', '当前用的是默认的深海渐变。'))
      preview.lastElementChild!.setAttribute('style', 'padding:8px 10px')
    }
    body.append(preview)
    if (bg.mode === 'custom') body.append(pickImageBtn())
    body.append(
      slider('遮罩浓度', 0, 90, 5, bg.dim, '%', (value) =>
        save({ background: { mode: bg.mode, image: bg.image, dim: value } })
      )
    )
    body.append(
      h('div', 'hintline', '遮罩把图片压暗 / 提亮一层，保证正文看得清。')
    )
  }

  const paintBubble = (): void => {
    const bubble = current.bubble
    body.append(
      sectionTitle('气泡'),
      slider('不透明度', 20, 100, 5, Math.round(bubble.opacity * 100), '%', (value) =>
        save({ bubble: { ...bubble, opacity: value / 100 } })
      ),
      slider('字号', 12, 22, 1, bubble.fontSize, ' px', (value) =>
        save({ bubble: { ...bubble, fontSize: value } })
      ),
      sectionTitle('三色'),
      colorRow('旁白', bubble.narrationColor, (value) =>
        save({ bubble: { ...bubble, narrationColor: value } })
      ),
      colorRow('对话（引号内）', bubble.dialogueColor, (value) =>
        save({ bubble: { ...bubble, dialogueColor: value } })
      ),
      colorRow('动作（括号内）', bubble.actionColor, (value) =>
        save({ bubble: { ...bubble, actionColor: value } })
      )
    )
    // 示例：改色后立刻在面板里看见效果
    const demo = h('div', 'msg')
    demo.style.cssText = 'padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-top:10px'
    const text = h('div', 'text')
    const narration = document.createElement('span')
    narration.textContent = '她抬头看向远处，海浪声一层层推过来。'
    const dialogue = h('span', 'seg-dialogue', '“你回来啦。”')
    const action = h('span', 'seg-action', '（歪了歪头）')
    text.append(narration, dialogue, action)
    demo.append(text)
    body.append(demo)
  }

  const paintGeneral = (): void => {
    body.append(
      sectionTitle('主题'),
      choice(
        '外观',
        [
          { key: 'dark', text: '深海夜航' },
          { key: 'light', text: '浅海晨光' }
        ],
        current.theme,
        (key) => save({ theme: key === 'light' ? 'light' : 'dark' })
      ),
      choice(
        '字体',
        [
          { key: 'system', text: '系统默认' },
          { key: 'round', text: '圆体' }
        ],
        current.font,
        (key) => save({ font: key === 'round' ? 'round' : 'system' })
      ),
      sectionTitle('语音朗读'),
      toggle('朗读酒馆的回复（默认关）', current.ttsEnabled, (value) => save({ ttsEnabled: value })),
      h(
        'div',
        'hintline',
        '与鲸鱼娘共用同一个音色（在输入栏「设置」里挑）。每句话合成好就念，不打断正文。'
      ),
      sectionTitle('背景音乐')
    )
    body.append(toggle('播放背景音乐', current.bgm.enabled, (value) =>
      save({ bgm: { ...current.bgm, enabled: value } })
    ))
    const row = h('div', 'set-row')
    const label = h('div', 'set-label', '曲目')
    const pick = h('button', 'btn', current.bgm.track ? '换一首…' : '选择音频…')
    const clear = h('button', 'btn ghost', '移除')
    clear.hidden = !current.bgm.track
    pick.onclick = (): void => {
      void window.tavern.appearanceMediaPick('audio').then((name) => {
        if (!name) return
        save({ bgm: { ...current.bgm, track: name, enabled: true } })
        say('已换背景音乐。')
      })
    }
    clear.onclick = (): void => {
      if (current.bgm.track) void window.tavern.appearanceMediaRemove(current.bgm.track).catch(() => {})
      save({ bgm: { ...current.bgm, track: null } })
    }
    row.append(label, pick, clear, h('div', 'grow'))
    body.append(row)
    if (current.bgm.track) {
      body.append(h('div', 'hintline', `当前曲目：${current.bgm.track}`))
    }
    body.append(
      slider('音量', 0, 100, 5, Math.round(current.bgm.volume * 100), '%', (value) =>
        save({ bgm: { ...current.bgm, volume: value / 100 } })
      ),
      h('div', 'hintline', '曲目会循环播放。语音朗读会盖在音乐上面，两句都能听见。')
    )
  }

  const paint = (): void => {
    body.replaceChildren()
    applyAppearance(current)
    if (activeTab === 'background') paintBackground()
    else if (activeTab === 'bubble') paintBubble()
    else paintGeneral()
  }

  resetBtn.onclick = (): void => {
    if (!loaded) return
    if (activeTab === 'background') {
      save({
        background: {
          mode: snapshot.background.mode,
          image: snapshot.background.image,
          dim: snapshot.background.dim
        }
      })
    } else if (activeTab === 'bubble') {
      save({ bubble: { ...snapshot.bubble } })
    } else {
      save({ theme: snapshot.theme, font: snapshot.font, ttsEnabled: snapshot.ttsEnabled, bgm: { ...snapshot.bgm } })
    }
    say('已撤销本页本次的修改。')
  }

  void (async () => {
    try {
      current = await window.tavern.appearanceGet()
      snapshot = { ...current, background: { ...current.background }, bubble: { ...current.bubble }, bgm: { ...current.bgm } }
      loaded = true
    } catch (error) {
      say(`读取外观设置失败：${String(error)}，先用默认值。`, true)
      current = DEFAULT_APPEARANCE
      snapshot = DEFAULT_APPEARANCE
    }
    if (!overlay.isConnected) return
    paint()
  })()
}
