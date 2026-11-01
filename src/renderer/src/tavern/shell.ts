// 酒馆窗口骨架（#tavern）：深海夜航主题 + 响应式三栏。
// 左栏是角色列表（点开进编辑页），中栏是角色库 / 编辑页 / 人设页，右栏留给鲸鱼娘旁观（T7）。
import { applyAppearance, BgmPlayer, loadAppearance } from './appearance'
import { renderCardEditor } from './cardEditor'
import { disposeChatPage, renderChatPage, type ChatTarget } from './chatPage'
import { pickGroupMembers } from './groupPicker'
import { renderLibrary } from './library'
import { maybeShowGuide } from './onboarding'
import { renderProfilePage } from './profilePage'
import { openSettingsPanel } from './settingsPanel'
import { createSpectatorDrawer } from './spectatorPanel'
import { cover, h, TAVERN_CSS } from './ui'

export async function renderTavernShell(): Promise<void> {
  const style = document.createElement('style')
  style.textContent = TAVERN_CSS
  document.head.append(style)

  // 主题 / 字体 / 三色 / 背景音乐是整窗的：进窗口先应用一次，之后跟着广播走
  const bgm = new BgmPlayer()
  void loadAppearance().then((settings) => {
    applyAppearance(settings)
    bgm.apply(settings)
  })
  window.tavern.onAppearance((settings) => {
    applyAppearance(settings)
    bgm.apply(settings)
  })

  const root = h('div')
  root.id = 'tavern'
  root.dataset['view'] = 'chat'

  // ── 顶栏 ──
  const bar = h('div', 'titlebar')
  const status = h('div', 'status', '正在连接数据库…')
  const closeBtn = h('button', 'close', '✕')
  closeBtn.title = '关闭'
  closeBtn.onclick = (): void => window.tavern.close()
  // 设置与帮助（备份 / 恢复 / 关于）：顶栏这个入口别跟着页面路由走
  const gearBtn = h('button', 'tool', '⚙')
  gearBtn.title = '设置与帮助'
  gearBtn.onclick = (): void => openSettingsPanel(root)
  bar.append(
    h('div', 'mark'),
    h('div', 'name', '酒馆'),
    h('div', 'sub', '深海夜航'),
    h('div', 'grow'),
    status,
    gearBtn,
    closeBtn
  )

  // ── 三栏 ──
  const body = h('div', 'body')

  const left = h('div', 'col col-left')
  const leftHead = h('div', 'col-head', '角色')
  const leftList = h('div', 'left-list')
  left.append(leftHead, leftList)

  const main = h('div', 'col col-main')

  // 右栏：鲸鱼娘观战抽屉（T7）。她只读，不插话；问才答
  const right = h('div', 'col col-right')
  const drawer = createSpectatorDrawer(right)

  body.append(left, main, right)

  // ── 窄屏底部切换 ──
  const tabs = h('div', 'tabs')
  const views: { key: string; label: string }[] = [
    { key: 'list', label: '角色' },
    { key: 'chat', label: '正文' }
  ]
  const paintTabs = (): void => {
    for (const button of Array.from(tabs.querySelectorAll('button'))) {
      button.setAttribute('aria-selected', String(button.dataset['key'] === root.dataset['view']))
    }
  }
  for (const view of views) {
    const button = h('button', '', view.label)
    button.dataset['key'] = view.key
    button.onclick = (): void => {
      root.dataset['view'] = view.key
      paintTabs()
    }
    tabs.append(button)
  }
  paintTabs()

  root.append(bar, body, tabs)
  document.body.append(root)

  // ── 页面路由（中栏）──
  const openLibrary = (): void => {
    // 离开聊天页：还在流的回复不该再往已经拆掉的 DOM 上写字
    disposeChatPage()
    // 旁观抽屉跟着对话走：回到角色库就不再是「在看某一场」了
    drawer.hide()
    renderLibrary(main, {
      onEdit: openEditor,
      onChat: openChat,
      onNewGroup: () => void openNewGroup(),
      onProfile: () => void renderProfilePage(main, openLibrary),
      onChanged: refreshLeft
    })
  }

  /**
   * 进一场对话：单角色传角色 id（沿用「这张卡没聊过就开一场」的语义），
   * 群聊传 `{ chatId }`（群聊必须按会话进，同一个角色可能在好几个群里）。
   */
  const openChatTarget = (target: ChatTarget): void => {
    root.dataset['view'] = 'chat'
    paintTabs()
    void renderChatPage(main, target, {
      onBack: openLibrary,
      onEditCharacter: (id) => openEditor(id),
      // 聊天页准备好（或重开了一场）才告诉抽屉「现在在看哪一场」
      onReady: (context) => drawer.show(context),
      // 人设页的「返回」回到这场对话，而不是角色库
      onProfile: () => {
        // 人设页会重建中栏：先把聊天页拆掉，否则还在流的那一轮会往已卸载的节点里写
        disposeChatPage()
        drawer.hide()
        void renderProfilePage(main, () => openChatTarget(target))
      }
    })
  }

  // 左栏点角色 = 进聊天（酒馆的主线是「和角色说话」，编辑页从角色库里进）
  const openChat = (characterId: string): void => openChatTarget(characterId)
  const openGroupChat = (chatId: string): void => openChatTarget({ chatId })

  const openNewGroup = async (): Promise<void> => {
    const choice = await pickGroupMembers(root)
    if (!choice) return
    try {
      const view = await window.tavern.groupCreate(choice.memberIds, choice.name)
      if (!view) throw new Error('建群失败')
      await refreshLeft()
      openGroupChat(view.chat.id)
    } catch (error) {
      window.alert(`建群失败：${String(error)}`)
    }
  }

  const openEditor = (id: string | null): void => {
    disposeChatPage()
    drawer.hide()
    // 窄屏下从列表点进来时要把中栏露出来，否则点了没反应
    root.dataset['view'] = 'chat'
    paintTabs()
    void renderCardEditor(main, id, {
      onBack: openLibrary,
      // 存完回角色库：新卡立刻出现在格子里，比停在一个改过的表单里更像「存上了」
      onSaved: (): void => {
        void refreshLeft()
        openLibrary()
      },
      onDeleted: (): void => {
        void refreshLeft()
        openLibrary()
      },
      onChanged: refreshLeft
    })
  }

  const refreshLeft = async (): Promise<void> => {
    const [{ items, total }, groups] = await Promise.all([
      window.tavern.cardsList({ limit: 200 }),
      window.tavern.groupsList()
    ])
    leftHead.textContent = total > 0 ? `角色 · ${total}` : '角色'
    leftList.replaceChildren()

    const textCell = (name: string, sub: string): HTMLElement => {
      const text = h('div', 'left-text')
      text.append(h('div', 'left-name', name), h('div', 'left-tag', sub))
      return text
    }

    for (const item of items) {
      const row = h('div', 'left-item')
      row.title = item.name
      row.onclick = (): void => openChat(item.id)
      row.append(cover('left-avatar', item.avatarPath, item.name), textCell(item.name, item.tagline || ' '))
      leftList.append(row)
    }

    // 群聊排在最前：它们是「正在进行的对话」，比角色库里再多一张卡更值得点
    if (groups.length > 0) {
      const sub = h('div', 'left-sub', `群聊 · ${groups.length}`)
      leftList.prepend(sub)
      for (const group of [...groups].reverse()) {
        const row = h('div', 'left-item')
        row.title = group.memberNames.join('、')
        row.onclick = (): void => openGroupChat(group.id)
        row.append(
          h('div', 'left-avatar group-avatar', '群'),
          textCell(group.title || group.memberNames.join('、'), `${group.memberNames.length} 人`)
        )
        sub.after(row)
      }
    }

    if (items.length === 0 && groups.length === 0) {
      const empty = h('div', 'hintline', '还没有角色。\n到右边导入一张角色卡，或者新建一个。')
      empty.style.padding = '8px 8px 0'
      leftList.append(empty)
    }
  }

  openLibrary()
  // 库打不开时 cardsList 会直接 reject：不能让它把 renderTavernShell 掀掉，
  // 否则走不到下面的 ping，顶栏永远停在「正在连接数据库…」，真正的原因看不见
  let readFailed = false
  try {
    await refreshLeft()
  } catch {
    readFailed = true
    leftHead.textContent = '角色 · 读取失败'
  }

  // 首次启动引导：空库且没走过引导时，带用户导入第一张卡（导入成功刷新左栏）
  if (!readFailed) void maybeShowGuide({ root, onImported: refreshLeft })

  // ── 自检：建库结果直接摆在顶栏上，Table 建没建出来一眼可见 ──
  try {
    const result = await window.tavern.ping()
    if (result.ok) {
      status.textContent = `数据库就绪 · ${result.tables.length} 张表`
      status.title = result.tables.join('、')
    } else {
      status.textContent = '数据库不可用'
      status.title = result.error ?? ''
      status.classList.add('bad')
    }
  } catch (error) {
    status.textContent = '数据库不可用'
    status.title = String(error)
    status.classList.add('bad')
  }
}
