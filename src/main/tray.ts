// 托盘：桌宠没有任务栏图标，托盘是它唯一常驻的入口。
// 只放「别处进不去」的操作：显隐、主动说话开关、输入栏、设置、手账、提醒、退出。
import { dialog, Menu, Tray, app, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { loadConfig, onConfigSaved, saveConfig } from './chat/config'
import { isAutoStartEnabled, setAutoStart } from './autostart'

export interface TrayActions {
  isPetVisible: () => boolean
  togglePet: () => void
  showPet: () => void
  feedPet: () => void
  openInput: () => void
  openSettings: () => void
  openMemory: () => void
  openReminders: () => void
  openHelp: () => void
  openTavern: () => void
}

let tray: Tray | null = null

const SHORTCUT = process.platform === 'darwin' ? '⌘⇧Space' : 'Ctrl+Shift+Space'
const HELP_TEXT =
  '托盘菜单是她的常驻入口：可以叫她出来 / 藏起来、喂饭、开记忆手账与提醒。\n' +
  `${SHORTCUT} 唤出输入栏和她说话。\n` +
  '「打开酒馆…」进入多角色卡聊天：导入角色卡、世界书 / 预设 / 状态栏、群聊 @ 某人都在这。\n' +
  '酒馆里的「⚙」可以导出 / 导入备份（换电脑或重装前记得先备份）。'

function showAbout(): void {
  void dialog.showMessageBox({
    type: 'info',
    title: '关于鲸鱼娘',
    message: `鲸鱼娘 桌宠 · 酒馆`,
    detail: `版本 ${app.getVersion()}\n\n${HELP_TEXT}`,
    buttons: ['好'],
    noLink: true
  })
}

function buildMenu(actions: TrayActions): Menu {
  const template: MenuItemConstructorOptions[] = [
    { label: '打开输入栏', accelerator: 'CommandOrControl+Shift+Space', click: actions.openInput },
    { type: 'separator' },
    {
      label: actions.isPetVisible() ? '把她藏起来' : '让她出来',
      click: () => {
        actions.togglePet()
        refresh(actions) // 显隐后菜单文案要跟着换
      }
    },
    { label: '喂她一顿大白饭', click: actions.feedPet },
    {
      label: '允许她主动找我说话',
      type: 'checkbox',
      checked: loadConfig().proactiveEnabled,
      // 配置窗里改也会落盘，两边看到的是同一份 config.json
      click: (item) => saveConfig({ proactiveEnabled: item.checked })
    },
    {
      label: '开机自动醒来',
      type: 'checkbox',
      // 状态直接从注册表读，不另存一份配置
      checked: isAutoStartEnabled(),
      click: (item) => setAutoStart(item.checked)
    },
    // 没有「开启辅助功能权限…」这一项：全局鼠标钩子在 macOS 上整体停用了
    // （uiohook-napi 没权限会 abort 进程、有权限还会死锁，见 globalMouse.ts），
    // 留着这个入口只会把人引到一个开了也没用的设置页。
    { label: '记忆手账…', click: actions.openMemory },
    { label: '提醒事项…', click: actions.openReminders },
    { label: '打开酒馆…', click: actions.openTavern },
    { label: '设置…', click: actions.openSettings },
    { label: '使用说明…', click: actions.openHelp },
    { label: '关于鲸鱼娘…', click: showAbout },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]
  return Menu.buildFromTemplate(template)
}

/** 重建菜单：配置改了、显隐变了都要重来一遍（Electron 的托盘菜单不是响应式的）。 */
function refresh(actions: TrayActions): void {
  tray?.setContextMenu(buildMenu(actions))
}

export function createTray(actions: TrayActions): void {
  // macOS 菜单栏图标走 Template 规则：系统拿 alpha 当蒙版，深色菜单栏自动反白、
  // 浅色菜单栏保持黑。给彩色图的话浅色菜单栏下蓝色鲸鱼娘会糊成一块，认不出是什么。
  // （`trayTemplate@2x.png` 由系统按文件名自动挑，不用手动判断 scale factor）
  const iconName = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'
  const iconPath = join(app.getAppPath(), 'resources', iconName)
  const icon = nativeImage.createFromPath(iconPath)
  // 图标读不到时 Tray 会变成系统托盘里的一个空白位，不留日志根本查不出原因
  if (icon.isEmpty()) console.error('[tray] 托盘图标读取失败：', iconPath)
  // 文件名以 Template 结尾时 Electron 一般会自动标记，但显式设一次更稳：
  // 漏了它，深色菜单栏下就是一块看不出形状的黑影
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('鲸鱼娘')
  // 左键把鱼叫回来：她可能被藏起来了，或跑到别的屏幕后面去了。
  // macOS 上菜单栏图标左键本来就是「弹菜单」，再绑一个 click 会同时叫回鱼 + 弹菜单，
  // 所以只在 Windows 绑——mac 用户找鱼有菜单里那一项。
  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      actions.showPet()
      refresh(actions) // 菜单是快照：叫回来之后「让她出来」要变回「把她藏起来」
    })
  }
  refresh(actions)
  onConfigSaved(() => refresh(actions))
}
