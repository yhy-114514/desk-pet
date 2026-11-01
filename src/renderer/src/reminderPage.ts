// 提醒列表（#reminders 窗口）：她答应过要提醒你的事，都摊开在这儿。
// 之前只有「设」没有「看 / 改 / 撤」——说了「两分钟后提醒我」，设完就再也查不到了。
interface Entry {
  at: number
  text: string
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** 时间戳 → `<input type="datetime-local">` 要的本地时间串 */
function toInputValue(ts: number): string {
  const date = new Date(ts)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** 反过来解析。不用 `new Date(字符串)`：跨浏览器对「无时区串」的处理值得怀疑 */
function fromInputValue(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5])
  )
  return Number.isFinite(date.getTime()) ? date.getTime() : null
}

/** 离现在多远：列表里一眼看出「哪条马上要响」 */
function distance(ts: number): string {
  const diff = ts - Date.now()
  if (diff <= 0) return '已到点'
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return '不到 1 分钟后'
  if (minutes < 60) return `${minutes} 分钟后`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分钟后` : `${hours} 小时后`
  const days = Math.floor(hours / 24)
  return `${days} 天 ${hours % 24} 小时后`
}

export async function renderReminderPage(): Promise<void> {
  document.body.style.cssText =
    'margin:0;background:var(--pet-bg);color:var(--pet-fg);font:14px var(--pet-font);overflow:hidden'

  // 深色细滚动条：原生白色滚动条在深底上太扎眼
  const style = document.createElement('style')
  style.textContent =
    '::-webkit-scrollbar{width:8px}' +
    '::-webkit-scrollbar-track{background:transparent}' +
    '::-webkit-scrollbar-thumb{background:var(--pet-scrollbar);border-radius:4px}' +
    '::-webkit-scrollbar-thumb:hover{background:var(--pet-scrollbar-hover)}'
  document.head.appendChild(style)

  const wrap = document.createElement('div')
  wrap.style.cssText =
    'box-sizing:border-box;height:100vh;padding:22px 24px;display:flex;flex-direction:column;gap:10px'

  const header = document.createElement('div')
  header.style.cssText = 'display:flex;align-items:baseline;gap:10px'

  const title = document.createElement('div')
  title.textContent = '提醒事项'
  title.style.cssText = 'font-size:16px;font-weight:600'

  const count = document.createElement('div')
  count.style.cssText = 'font-size:12px;color:var(--pet-muted)'

  header.append(title, count)

  const desc = document.createElement('div')
  desc.textContent = '她答应过要提醒你的事。改时间、改内容、或者删掉都行。'
  desc.style.cssText = 'font-size:12px;color:var(--pet-muted);line-height:1.5'

  const list = document.createElement('div')
  list.style.cssText =
    'flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;' +
    'padding:10px 4px 0 0;border-top:1px solid var(--pet-divider)'

  const footer = document.createElement('div')
  footer.style.cssText = 'display:flex;justify-content:flex-end'

  const close = document.createElement('button')
  close.textContent = '关闭'
  close.style.cssText =
    'background:var(--pet-accent);color:var(--pet-on-accent);border:0;border-radius:8px;padding:8px 20px;' +
    'font:13px var(--pet-font);cursor:pointer'
  close.onclick = (): void => window.reminders.close()

  footer.append(close)
  wrap.append(header, desc, list, footer)
  document.body.appendChild(wrap)

  let entries: Entry[] = await window.reminders.list()

  /** 改完统一收口：本地跟着改，再按时间重排一次（改完的可能换了位置） */
  const applyEdit = (entry: Entry, next: Entry): void => {
    if (!next.text.trim()) {
      entries = entries.filter((e) => e !== entry)
      window.reminders.remove(entry)
      render()
      return
    }
    if (next.at === entry.at && next.text === entry.text) return
    window.reminders.edit({ at: entry.at, text: entry.text }, next)
    entry.at = next.at
    entry.text = next.text
    render()
  }

  const render = (): void => {
    entries.sort((a, b) => a.at - b.at)
    list.replaceChildren()
    count.textContent = entries.length > 0 ? `共 ${entries.length} 条` : ''

    if (entries.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = '还没有提醒。跟她说「十分钟后提醒我喝水」就行。'
      empty.style.cssText = 'color:var(--pet-faint);font-size:13px;padding:24px 4px;text-align:center'
      list.appendChild(empty)
      return
    }

    for (const entry of entries) list.appendChild(createRow(entry))
  }

  const createRow = (entry: Entry): HTMLElement => {
    const row = document.createElement('div')
    row.style.cssText =
      'display:flex;flex-direction:column;gap:5px;background:var(--pet-card);border-radius:9px;padding:8px 10px'

    const top = document.createElement('div')
    top.style.cssText = 'display:flex;align-items:center;gap:8px'

    const text = document.createElement('input')
    text.type = 'text'
    text.value = entry.text
    text.style.cssText =
      'flex:1;min-width:0;background:transparent;color:var(--pet-text);border:1px solid transparent;' +
      'border-radius:6px;padding:4px 6px;font:13px var(--pet-font);outline:none'
    text.addEventListener('focus', () => {
      text.style.background = 'var(--pet-input-bg)'
      text.style.borderColor = 'var(--pet-border)'
    })
    text.addEventListener('blur', () => {
      text.style.background = 'transparent'
      text.style.borderColor = 'transparent'
    })
    text.addEventListener('keydown', (event) => {
      // 中文输入法用回车确认候选词，此时不能当成「提交」
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Enter') text.blur()
    })
    text.addEventListener('change', () => applyEdit(entry, { at: entry.at, text: text.value.trim() }))

    const removeButton = document.createElement('button')
    removeButton.textContent = '×'
    removeButton.title = '删掉这条提醒'
    removeButton.style.cssText =
      'flex:none;background:transparent;border:0;color:var(--pet-faint);font-size:16px;line-height:1;' +
      'cursor:pointer;padding:2px 4px'
    removeButton.onmouseenter = (): void => {
      removeButton.style.color = 'var(--pet-danger)'
    }
    removeButton.onmouseleave = (): void => {
      removeButton.style.color = 'var(--pet-faint)'
    }
    removeButton.onclick = (): void => {
      entries = entries.filter((e) => e !== entry)
      window.reminders.remove(entry)
      render()
    }

    top.append(text, removeButton)

    const bottom = document.createElement('div')
    bottom.style.cssText = 'display:flex;align-items:center;gap:8px;padding-left:6px'

    const time = document.createElement('input')
    time.type = 'datetime-local'
    time.value = toInputValue(entry.at)
    time.style.cssText =
      'background:var(--pet-input-bg);color:var(--pet-text);border:1px solid var(--pet-border);border-radius:6px;' +
      'padding:3px 7px;font:12px var(--pet-font);outline:none;color-scheme:dark'
    time.addEventListener('change', () => {
      const at = fromInputValue(time.value)
      // 清空或不认识的值：退回原时间，别把这条改成「立刻响」
      if (at === null) {
        time.value = toInputValue(entry.at)
        return
      }
      applyEdit(entry, { at, text: entry.text })
    })

    const hint = document.createElement('span')
    hint.textContent = distance(entry.at)
    hint.style.cssText = `font-size:11px;color:${entry.at <= Date.now() ? 'var(--pet-warn)' : 'var(--pet-dim)'}`

    bottom.append(time, hint)
    row.append(top, bottom)
    return row
  }

  render()
}
