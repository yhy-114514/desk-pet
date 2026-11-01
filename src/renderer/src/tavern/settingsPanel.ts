// 酒馆顶栏「⚙」：备份与恢复、关于/帮助。
// 复用聊天页那套遮罩（modal-mask + modal），不另造窗口。
import { h } from './ui'

const HELP_TEXT =
  '托盘菜单是她常驻的入口：叫她出来 / 藏起来、喂饭、记忆手账、提醒。\n' +
  'Ctrl+Shift+Space 唤出输入栏。\n' +
  '群聊里用 @名字 点名，被点到的人一定接话。\n' +
  '换电脑或重装之前，先在这里导出一份备份。'

let openOverlay: HTMLElement | null = null

export function openSettingsPanel(root: HTMLElement): void {
  openOverlay?.remove()
  const overlay = h('div', 'modal-mask')
  const box = h('div', 'modal settings-modal')
  const close = h('button', 'modal-close', '✕')
  const head = h('div', 'modal-head')
  head.append(h('div', 'modal-title', '设置与帮助'), h('div', 'grow'), close)
  const dismiss = (): void => {
    if (openOverlay === overlay) openOverlay = null
    overlay.remove()
  }
  close.onclick = dismiss
  overlay.onclick = (event): void => {
    if (event.target === overlay) dismiss()
  }

  const body = h('div', 'modal-body')
  const hint = h('div', 'set-note', '')

  // ── 备份与恢复 ──
  body.append(h('div', 'set-section', '备份与恢复'))
  body.append(
    h(
      'div',
      'set-note',
      '把酒馆数据（角色卡、会话、立绘、世界书、预设、外观）和鲸鱼娘的设置 / 记忆 / 提醒打成一份 .zip。' +
        '导入会覆盖当前全部数据并重启应用。'
    )
  )
  const actions = h('div', 'set-actions')
  const exportBtn = h('button', 'btn primary', '导出备份…')
  const importBtn = h('button', 'btn danger', '导入备份…')
  exportBtn.onclick = async (): Promise<void> => {
    exportBtn.disabled = true
    hint.textContent = '正在打包…'
    hint.classList.remove('bad')
    try {
      const result = await window.tavern.backupExport()
      if (result.ok) hint.textContent = `已导出到 ${result.path}`
      else if (result.error) hint.textContent = `导出失败：${result.error}`
      else hint.textContent = ''
      hint.classList.toggle('bad', !result.ok && !!result.error)
    } catch (error) {
      hint.textContent = `导出失败：${String(error)}`
      hint.classList.add('bad')
    } finally {
      exportBtn.disabled = false
    }
  }
  importBtn.onclick = async (): Promise<void> => {
    if (!window.confirm('导入会覆盖当前全部数据，并重启应用。继续？')) return
    importBtn.disabled = true
    hint.textContent = '正在导入…'
    hint.classList.remove('bad')
    try {
      const result = await window.tavern.backupImport()
      if (result.ok) {
        hint.textContent =
          result.restart === 'manual'
            ? '恢复完成。开发模式没法自动重启，应用即将退出，请重新运行 npm run dev。'
            : '导入完成，正在重启…'
      } else if (result.error) {
        hint.textContent = `导入失败：${result.error}`
        hint.classList.add('bad')
        importBtn.disabled = false
      } else {
        hint.textContent = ''
        importBtn.disabled = false
      }
    } catch (error) {
      hint.textContent = `导入失败：${String(error)}`
      hint.classList.add('bad')
      importBtn.disabled = false
    }
  }
  actions.append(exportBtn, importBtn)
  body.append(actions, hint)

  // ── 关于 ──
  body.append(h('div', 'set-section', '关于'))
  const version = h('div', 'about-help', '正在读取版本…')
  const helpBtn = h('button', 'btn', '打开完整使用说明')
  helpBtn.onclick = (): void => window.tavern.openHelp()
  const helpRow = h('div', 'set-actions')
  helpRow.append(helpBtn)
  body.append(version, h('div', 'about-help', HELP_TEXT), helpRow)
  void window.tavern
    .aboutGet()
    .then((info) => {
      version.textContent = `鲸鱼娘 · 酒馆　版本 ${info.version}（Electron ${info.electron}）`
    })
    .catch(() => {
      version.textContent = '版本信息读取失败'
    })

  box.append(head, body)
  overlay.append(box)
  root.append(overlay)
  openOverlay = overlay
}
