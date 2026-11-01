// 角色库（中栏）：网格 + 搜索 + 标签筛选 + 导入 / 新建 / 清空。
// 只有「我的角色」，没有角色市场——市场依赖服务端，已经整体砍掉。
import { cover, h, type CardSummary } from './ui'

const PAGE_SIZE = 24

export interface LibraryHandlers {
  onEdit: (id: string | null) => void
  /** 点卡片上的「聊天」：进这场对话 */
  onChat: (id: string) => void
  onProfile: () => void
  /** 新建群聊：挑几个角色放进同一场对话 */
  onNewGroup: () => void
  /** 卡片有增减时通知外壳刷新左栏 */
  onChanged: () => void | Promise<void>
}

export function renderLibrary(mount: HTMLElement, handlers: LibraryHandlers): void {
  mount.replaceChildren()

  let keyword = ''
  let tag = ''
  let trash = false
  let items: CardSummary[] = []
  let total = 0
  let tags: string[] = []

  const page = h('div', 'page')
  const toolbar = h('div', 'toolbar')
  const search = h('input', 'search')
  search.type = 'text'
  search.placeholder = '搜名字或描述…'

  const importBtn = h('button', 'btn', '导入')
  importBtn.title = '导入 SillyTavern 的 PNG / JSON 角色卡'
  const newBtn = h('button', 'btn primary', '新建')
  const groupBtn = h('button', 'btn', '群聊')
  groupBtn.title = '挑几个角色，让她们在同一场对话里一起说话'
  const trashBtn = h('button', 'btn ghost', '回收站')
  const profileBtn = h('button', 'btn ghost', '我的人设')
  const clearBtn = h('button', 'btn ghost danger', '清空')

  toolbar.append(search, importBtn, newBtn, groupBtn, trashBtn, profileBtn, clearBtn)

  const notice = h('div', 'notice')
  notice.hidden = true

  const chips = h('div', 'chips')
  const scroll = h('div', 'scroll')
  const grid = h('div', 'grid')
  const moreBtn = h('button', 'btn', '加载更多')
  moreBtn.style.margin = '14px auto 0'
  moreBtn.style.display = 'block'
  scroll.append(grid, moreBtn)
  page.append(toolbar, notice, chips, scroll)
  mount.append(page)

  const say = (text: string, bad = false): void => {
    notice.textContent = text
    notice.hidden = false
    notice.classList.toggle('bad', bad)
  }

  // 连打几个字时「ab」的查询可能比「abc」的后回来，把新的结果盖掉。
  // 每次查询领一个代次号，回来时已经不是最新那次就直接丢；「加载更多」也走这套，
  // 否则它带着旧 offset 的结果会铺到新筛选的结果上。
  let querySeq = 0

  const refreshing = async (): Promise<void> => {
    const seq = ++querySeq
    const result = await window.tavern.cardsList({
      keyword,
      tag: tag || undefined,
      onlyDeleted: trash,
      limit: PAGE_SIZE,
      offset: 0
    })
    if (seq !== querySeq) return
    items = result.items
    total = result.total
    paint()
  }

  const loadMore = async (): Promise<void> => {
    const seq = ++querySeq
    const result = await window.tavern.cardsList({
      keyword,
      tag: tag || undefined,
      onlyDeleted: trash,
      limit: PAGE_SIZE,
      offset: items.length
    })
    if (seq !== querySeq) return
    items = items.concat(result.items)
    total = result.total
    paint()
  }

  const paintChips = async (): Promise<void> => {
    tags = await window.tavern.cardsTags()
    chips.replaceChildren()
    if (tags.length === 0) {
      chips.hidden = true
      return
    }
    chips.hidden = false
    const all = h('button', 'chip', '全部')
    all.setAttribute('aria-pressed', String(tag === ''))
    all.onclick = (): void => {
      tag = ''
      void refreshing()
    }
    chips.append(all)
    for (const name of tags) {
      const chip = h('button', 'chip', name)
      chip.setAttribute('aria-pressed', String(tag === name))
      chip.onclick = (): void => {
        tag = tag === name ? '' : name
        void refreshing()
      }
      chips.append(chip)
    }
  }

  const paint = (): void => {
    void paintChips()
    grid.replaceChildren()
    moreBtn.style.display = items.length < total ? 'block' : 'none'
    moreBtn.textContent = `加载更多（${items.length} / ${total}）`

    if (items.length === 0) {
      grid.style.display = 'block'
      grid.append(
        h(
          'div',
          'empty',
          trash
            ? '回收站是空的。'
            : keyword || tag
              ? '没有符合条件的角色。'
              : '还没有角色。\n点「导入」拿一张 SillyTavern 的角色卡，或者「新建」自己写一个。'
        )
      )
      return
    }
    grid.style.display = 'grid'
    for (const item of items) grid.append(card(item))
  }

  const card = (item: CardSummary): HTMLElement => {
    const node = h('div', 'card')
    node.title = item.name
    // 点卡片直接开聊（酒馆的主线是说话）；改设定走右上角的「编辑」
    node.onclick = (): void => {
      if (!trash) handlers.onChat(item.id)
    }

    const acts = h('div', 'acts')
    if (trash) {
      const restore = h('button', '', '恢复')
      restore.onclick = async (event): Promise<void> => {
        event.stopPropagation()
        await window.tavern.cardsRestore(item.id)
        await handlers.onChanged()
        await refreshing()
      }
      acts.append(restore)
    } else {
      const edit = h('button', '', '编辑')
      edit.title = '改这张卡的设定'
      edit.onclick = (event): void => {
        event.stopPropagation()
        handlers.onEdit(item.id)
      }
      const png = h('button', '', 'PNG')
      png.title = '导出为 PNG（内含角色卡数据）'
      png.onclick = async (event): Promise<void> => {
        event.stopPropagation()
        await exportCard(item, 'png')
      }
      const json = h('button', '', 'JSON')
      json.title = '导出为 JSON'
      json.onclick = async (event): Promise<void> => {
        event.stopPropagation()
        await exportCard(item, 'json')
      }
      const remove = h('button', '', '删除')
      remove.onclick = async (event): Promise<void> => {
        event.stopPropagation()
        if (!window.confirm(`删除「${item.name}」？\n会放进回收站，之后还能捡回来。`)) return
        await window.tavern.cardsDelete(item.id)
        await handlers.onChanged()
        await refreshing()
        say(`已把「${item.name}」放进回收站。`)
      }
      acts.append(edit, png, json, remove)
    }

    node.append(
      cover('cover', item.avatarPath, item.name),
      h('div', 'card-name', item.name),
      h('div', 'card-tag', item.tagline || (item.tags.join(' · ') || ' ')),
      acts
    )
    return node
  }

  const exportCard = async (item: CardSummary, format: 'png' | 'json'): Promise<void> => {
    const result = await window.tavern.cardsExport(item.id, format)
    if (result.ok) say(`已导出「${item.name}」。`)
    else if (result.error) say(`导出失败：${result.error}`, true)
  }

  search.addEventListener('input', () => {
    keyword = search.value.trim()
    void refreshing()
  })

  importBtn.onclick = async (): Promise<void> => {
    const results = await window.tavern.cardsImport()
    if (results.length === 0) return
    const ok = results.filter((item) => item.ok)
    const failed = results.filter((item) => !item.ok)
    // 同名卡按「重新导入」处理：覆盖更新，不堆重名
    const updated = ok.filter((item) => item.updated).length
    const parts = [`导入 ${ok.length} 张`]
    if (updated > 0) parts.push(`其中 ${updated} 张是覆盖更新`)
    if (failed.length > 0) {
      parts.push(`${failed.length} 张失败：${failed.map((item) => item.error).join('；')}`)
    }
    say(parts.join('，'), failed.length > 0)
    await handlers.onChanged()
    await refreshing()
  }

  newBtn.onclick = (): void => handlers.onEdit(null)
  groupBtn.onclick = (): void => handlers.onNewGroup()
  profileBtn.onclick = (): void => handlers.onProfile()

  trashBtn.onclick = async (): Promise<void> => {
    trash = !trash
    trashBtn.textContent = trash ? '返回角色库' : '回收站'
    trashBtn.classList.toggle('primary', trash)
    clearBtn.hidden = trash
    importBtn.hidden = trash
    newBtn.hidden = trash
    groupBtn.hidden = trash
    notice.hidden = true
    await refreshing()
  }

  clearBtn.onclick = async (): Promise<void> => {
    // 清空是整库操作，不认当前的搜索 / 标签筛选：再取一次未筛选的总数，
    // 否则筛出 3 张时确认框只说「3 张」，实际把全库都清掉
    const all = await window.tavern.cardsList({ limit: 1 })
    if (all.total === 0) return
    if (!window.confirm(`清空角色库里的全部 ${all.total} 张角色卡？\n会全部放进回收站，之后还能捡回来。`))
      return
    const count = await window.tavern.cardsClear()
    await handlers.onChanged()
    await refreshing()
    say(`已清空 ${count} 张，需要的话到回收站里找回。`)
  }

  moreBtn.onclick = (): void => void loadMore()

  void refreshing()
}
