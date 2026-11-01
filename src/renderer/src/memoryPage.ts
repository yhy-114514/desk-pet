// 记忆手账（#memory 窗口）：把「她记住了什么」摊开给用户看，可搜可筛可改可删。
// 抽出来的记忆难免有偏差，能看见、能改，用户才敢信她会记住。
const TYPE_LABELS: Record<string, string> = {
  preference: '喜好',
  event: '事件',
  promise: '约定',
  identity: '身份',
  fact: '事实',
  other: '其他'
}

/** 筛选标签的固定顺序（按关心程度排，不是按字母） */
const FILTER_ORDER = ['preference', 'event', 'promise', 'identity', 'fact', 'other']

interface Entry {
  id: string
  type: string
  content: string
  createdAt: number
  updatedAt: number
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** `10-23 21:14`：手账里不需要年份，但需要一眼看出新旧 */
function stamp(ts: number): string {
  if (!ts) return ''
  const date = new Date(ts)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export async function renderMemoryPage(): Promise<void> {
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
  title.textContent = '记忆手账'
  title.style.cssText = 'font-size:16px;font-weight:600'

  const count = document.createElement('div')
  count.style.cssText = 'font-size:12px;color:var(--pet-muted)'

  header.append(title, count)

  const desc = document.createElement('div')
  desc.textContent = '她自己记下来的事。改一下、或者删掉都行——下次聊天她会按这里的来。'
  desc.style.cssText = 'font-size:12px;color:var(--pet-muted);line-height:1.5'

  const search = document.createElement('input')
  search.type = 'text'
  search.placeholder = '搜一下她记住了什么…'
  search.style.cssText =
    'box-sizing:border-box;width:100%;background:var(--pet-input-bg);color:var(--pet-text);border:1px solid var(--pet-border);' +
    'border-radius:8px;padding:8px 11px;font:13px var(--pet-font);outline:none'
  search.addEventListener('focus', () => (search.style.borderColor = 'var(--pet-border-focus)'))
  search.addEventListener('blur', () => (search.style.borderColor = 'var(--pet-border)'))

  // 分类筛选：点「全部」看全部，点某一类只看那一类；每类带条数
  const chips = document.createElement('div')
  chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px'

  const chipButtons = new Map<string, HTMLButtonElement>()

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
  close.onclick = (): void => window.memory.close()

  footer.append(close)
  wrap.append(header, desc, search, chips, list, footer)
  document.body.appendChild(wrap)

  let entries: Entry[] = await window.memory.list()
  let keyword = ''
  let filter = 'all'

  const matches = (entry: Entry): boolean => {
    if (filter !== 'all' && entry.type !== filter) return false
    return !keyword || entry.content.toLowerCase().includes(keyword.toLowerCase())
  }

  const buildChip = (key: string, label: string): HTMLButtonElement => {
    const button = document.createElement('button')
    button.textContent = label
    button.style.cssText =
      'border:0;border-radius:999px;padding:4px 11px;cursor:pointer;font:12px system-ui,' +
      '"Microsoft YaHei",sans-serif;transition:background .12s,color .12s'
    button.onclick = (): void => {
      filter = key
      render()
    }
    chipButtons.set(key, button)
    return button
  }

  const paintChips = (): void => {
    chips.replaceChildren()
    const keys = ['all', ...FILTER_ORDER]
    for (const key of keys) {
      const label = key === 'all' ? '全部' : (TYPE_LABELS[key] ?? key)
      const total = key === 'all' ? entries.length : entries.filter((e) => e.type === key).length
      const button = chipButtons.get(key) ?? buildChip(key, '')
      button.textContent = `${label} ${total}`
      // 一条都没有的分类不显示（除非正筛选着它，否则会显得乱）
      if (total === 0 && key !== 'all' && filter !== key) continue
      const active = filter === key
      button.style.background = active ? 'var(--pet-accent)' : 'var(--pet-toggle-bg)'
      button.style.color = active ? 'var(--pet-on-accent)' : 'var(--pet-label-alt)'
      chips.appendChild(button)
    }
  }

  const render = (): void => {
    paintChips()
    list.replaceChildren()
    const shown = entries.filter(matches)
    count.textContent =
      shown.length === entries.length
        ? entries.length > 0
          ? `共 ${entries.length} 条`
          : ''
        : `${shown.length} / ${entries.length} 条`

    if (shown.length === 0) {
      const empty = document.createElement('div')
      empty.textContent =
        entries.length === 0
          ? '还什么都没记住呢。多聊几句，她会慢慢记住你的事。'
          : '没有符合条件的一条。'
      empty.style.cssText = 'color:var(--pet-faint);font-size:13px;padding:24px 4px;text-align:center'
      list.appendChild(empty)
      return
    }

    for (const entry of shown) list.appendChild(createRow(entry))
  }

  /** 改完/删完统一在这里收口，避免每一处都各写一遍重绘 */
  const applyEdit = (entry: Entry, content: string): void => {
    const text = content.trim()
    if (!text) {
      entries = entries.filter((e) => e.id !== entry.id)
      window.memory.remove(entry.id)
      render()
      return
    }
    if (text === entry.content) return
    entry.content = text
    entry.updatedAt = Date.now()
    window.memory.edit(entry.id, text)
    // 改完可能不再符合当前搜索/筛选，重画一次让列表和数量都跟上
    render()
  }

  const createRow = (entry: Entry): HTMLElement => {
    const row = document.createElement('div')
    row.style.cssText =
      'display:flex;align-items:center;gap:8px;background:var(--pet-card);border-radius:9px;padding:8px 10px'

    const badge = document.createElement('span')
    badge.textContent = TYPE_LABELS[entry.type] ?? '其他'
    badge.style.cssText =
      'flex:none;font-size:11px;color:var(--pet-chip-fg);background:var(--pet-chip-bg);border-radius:6px;padding:2px 7px'

    const main = document.createElement('div')
    main.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px'

    const input = document.createElement('input')
    input.type = 'text'
    input.value = entry.content
    input.style.cssText =
      'width:100%;box-sizing:border-box;background:transparent;color:var(--pet-text);border:1px solid transparent;' +
      'border-radius:6px;padding:4px 6px;font:13px var(--pet-font);outline:none'
    input.addEventListener('focus', () => {
      input.style.background = 'var(--pet-input-bg)'
      input.style.borderColor = 'var(--pet-border)'
    })
    input.addEventListener('blur', () => {
      input.style.background = 'transparent'
      input.style.borderColor = 'transparent'
    })
    input.addEventListener('keydown', (event) => {
      // 中文输入法用回车确认候选词，此时不能当成「提交」
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Enter') input.blur()
    })
    input.addEventListener('change', () => applyEdit(entry, input.value))

    const meta = document.createElement('div')
    meta.style.cssText = 'font-size:11px;color:var(--pet-dim);padding:0 6px'
    const created =
      entry.createdAt && entry.createdAt !== entry.updatedAt
        ? ` · ${stamp(entry.createdAt).slice(0, 5)} 创建`
        : ''
    meta.textContent = `${stamp(entry.updatedAt)} 更新${created}`

    const removeButton = document.createElement('button')
    removeButton.textContent = '×'
    removeButton.title = '删掉这条'
    removeButton.style.cssText =
      'flex:none;background:transparent;border:0;color:var(--pet-faint);font-size:16px;line-height:1;' +
      'cursor:pointer;padding:2px 4px'
    removeButton.onmouseenter = (): void => {
      removeButton.style.color = 'var(--pet-danger)'
    }
    removeButton.onmouseleave = (): void => {
      removeButton.style.color = 'var(--pet-faint)'
    }
    removeButton.onclick = (): void => applyEdit(entry, '')

    main.append(input, meta)
    row.append(badge, main, removeButton)
    return row
  }

  search.addEventListener('input', () => {
    keyword = search.value.trim()
    render()
  })

  render()
}
