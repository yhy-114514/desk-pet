import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  protocol,
  session,
  systemPreferences,
  type MenuItemConstructorOptions
} from 'electron'
import { join } from 'node:path'
import { registerStoreIpc } from './petStore'
import { registerGlobalMouse, stopGlobalMouse } from './globalMouse'
import { lockCursor, unlockCursor } from './cursor'
import { hasKey, registerConfigIpc } from './chat/config'
import { registerChatIpc } from './chat/ipc'
import { registerMemoryIpc } from './chat/memoryStore'
import { registerReminderIpc } from './chat/reminderStore'
import { registerAsrIpc } from './chat/asr'
import { closeTavernDb, openTavernDb } from './tavern/db'
import { AVATAR_SCHEME, registerAvatarProtocol } from './tavern/cards'
import { MEDIA_SCHEME, registerMediaProtocol, registerTavernAppearanceIpc } from './tavern/appearanceIpc'
import { registerTavernIpc } from './tavern/ipc'
import { startProactiveScheduler } from './proactive'
import { startReminderScheduler } from './reminders'
import { createTray } from './tray'
import { restoreWindowPosition, trackWindowPosition, watchDisplays } from './windowState'

const WIDTH = 300
// 窗口比角色高 120px：角色仍贴底、头顶留出气泡空间（气泡不盖住脸）
const HEIGHT = 420

// 酒馆立绘走自定义协议（渲染层拿不到文件系统，也不该把图转成几十 MB 的 data URL）。
// 必须在 app ready 之前登记，否则 <img src> 用不了这个 scheme。
protocol.registerSchemesAsPrivileged([
  { scheme: AVATAR_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // 背景图 / 背景音乐：stream 让 <audio> 不必等整个文件读完才出声
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

// 酒馆的背景音乐要在没有点击的窗口里自动播放：默认策略会因「没有用户手势」拒绝 play()
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let mainWindow: BrowserWindow | null = null
let dashboardWindow: BrowserWindow | null = null
let inputWindow: BrowserWindow | null = null
let configWindow: BrowserWindow | null = null
let memoryWindow: BrowserWindow | null = null
let reminderWindow: BrowserWindow | null = null
let helpWindow: BrowserWindow | null = null
let tavernWindow: BrowserWindow | null = null

/**
 * macOS 的「不在任务栏显示」不是 `skipTaskbar`（mac 没有任务栏），而是藏掉 Dock 图标。
 * 但不能一藏到底：Dock 一没，应用菜单栏也整条消失，输入框里的 ⌘C / ⌘V
 * （走的是菜单里的 role）跟着失效，⌘Tab 也切不回来。
 *
 * 所以按「桌宠之外还有没有可见窗口」动态切换：只挂桌宠时是纯粹的一只鱼，
 * 一开酒馆 / 配置 / 手账就恢复成正常应用。
 */
let dockShown = false

function syncDock(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const others = [
    dashboardWindow,
    inputWindow,
    configWindow,
    memoryWindow,
    reminderWindow,
    helpWindow,
    tavernWindow
  ]
  // 桌宠窗口不算：它就是那个「不该出现在 Dock 里」的东西
  const wanted = others.some((win) => Boolean(win && !win.isDestroyed() && win.isVisible()))
  if (wanted === dockShown) return
  dockShown = wanted
  // show() 会把应用提到前台，误调一次就会把用户正在用的别的程序顶下去——所以上面先判状态
  if (wanted) void app.dock.show()
  else app.dock.hide()
}

/** 让窗口的出现 / 隐藏 / 关闭都驱动一次 Dock 状态（Windows 上是空操作）。 */
function trackDock(win: BrowserWindow): void {
  if (process.platform !== 'darwin') return
  win.on('show', syncDock)
  win.on('hide', syncDock)
  win.on('closed', syncDock)
}

/**
 * macOS 的应用菜单。不设的话系统给的是 Electron 的默认菜单，
 * 且「编辑」一组是空白 —— 没有复制 / 粘贴的 role，⌘C 在输入框里按了没反应。
 * Windows 上不装（那边菜单栏由窗口自己画，装应用菜单反而会多出一条）。
 */
function installApplicationMenu(): void {
  if (process.platform !== 'darwin') return
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: '关于鲸鱼娘' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏鲸鱼娘' },
        { role: 'hideOthers', label: '隐藏其他' },
        { type: 'separator' },
        { role: 'quit', label: '退出鲸鱼娘' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    transparent: true, // 透明窗口
    frame: false, // 无边框
    alwaysOnTop: true, // 置顶
    hasShadow: false,
    resizable: false,
    skipTaskbar: true, // 不在任务栏显示
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 关掉拼写检查：Chromium 会在输入框获得焦点时去 Google 下词典，防火墙下
      // 只会刷一排 `ssl_client_socket_impl.cc handshake failed net_error -100`，中文界面毫无用处
      spellcheck: false
    }
  })

  // 开发走 dev server（HMR），生产走打包产物
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow = win
  // 上次待在哪就还摆哪（副屏被拔掉时回主屏右下角，不会「鱼不见了」）
  // 先挂监听再摆位置：Windows 上 setPosition 是同步派发 move 的，反了就漏掉这一次
  trackWindowPosition(win)
  restoreWindowPosition(win)

  // 默认整窗点击穿透，但继续转发 mousemove：渲染进程据此判断指针是否在角色身上，
  // 在角色上时再关闭穿透，避免透明区域挡住桌面点击。
  win.setIgnoreMouseEvents(true, { forward: true })

  // macOS 的「桌面」是多个 Space：不设这个，切一下桌面鱼就没了；
  // visibleOnFullScreen 让她在全屏应用（看视频 / 写代码）上也浮着。Windows 没有这个概念。
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  // 窗口关闭后清空引用，避免后续 IPC 操作已销毁的窗口
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
}

// 开发期动作预览面板：独立小窗（不参与桌宠的点击穿透），点击按钮切换桌宠动画。
// 仅开发模式创建；后续动作由对话/互动触发时删除本窗口即可。
function createDashboardWindow(): void {
  const win = new BrowserWindow({
    width: 960,
    height: 110,
    x: 120,
    y: 80,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    backgroundColor: '#1e1e24',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 关掉拼写检查：Chromium 会在输入框获得焦点时去 Google 下词典，防火墙下
      // 只会刷一排 `ssl_client_socket_impl.cc handshake failed net_error -100`，中文界面毫无用处
      spellcheck: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#dashboard`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'dashboard' })
  }

  dashboardWindow = win
  trackDock(win)
  win.on('closed', () => {
    if (dashboardWindow === win) dashboardWindow = null
  })
}

// 聊天输入栏：全局快捷键唤起的小浮窗，只做「输入 + 回车发送」，不参与桌宠点击穿透。
function createInputWindow(): void {
  const win = new BrowserWindow({
    // 460 而不是 420：入口多了「喂饭 / 记忆 / 提醒 / 设置」四个，420 会把输入框挤到只剩几个字
    width: 460,
    height: 96,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 关掉拼写检查：Chromium 会在输入框获得焦点时去 Google 下词典，防火墙下
      // 只会刷一排 `ssl_client_socket_impl.cc handshake failed net_error -100`，中文界面毫无用处
      spellcheck: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#chat-input`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'chat-input' })
  }

  // 失焦即收起，避免浮窗一直挡着桌面
  win.on('blur', () => win.hide())
  win.on('closed', () => {
    if (inputWindow === win) inputWindow = null
  })

  inputWindow = win
  trackDock(win)
}

function showInputWindow(): void {
  if (!inputWindow) createInputWindow()
  const win = inputWindow
  if (!win) return
  win.center()
  win.show()
  win.focus()
}

// API Key 配置窗：首次启动无 Key 时弹出，保存后关闭；之后可从输入栏的「设置」再打开。
function createConfigWindow(): void {
  if (configWindow) {
    configWindow.show()
    configWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 460,
    height: 640,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#1e1e24',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 关掉拼写检查：Chromium 会在输入框获得焦点时去 Google 下词典，防火墙下
      // 只会刷一排 `ssl_client_socket_impl.cc handshake failed net_error -100`，中文界面毫无用处
      spellcheck: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#config`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'config' })
  }

  win.on('closed', () => {
    if (configWindow === win) configWindow = null
  })

  configWindow = win
  trackDock(win)
}

// 记忆手账：列出她记住的事，可改可删——让「她记得我」这件事看得见、管得住。
function createMemoryWindow(): void {
  if (memoryWindow) {
    memoryWindow.show()
    memoryWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 520,
    height: 620,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#1e1e24',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 关掉拼写检查：Chromium 会在输入框获得焦点时去 Google 下词典，防火墙下
      // 只会刷一排 `ssl_client_socket_impl.cc handshake failed net_error -100`，中文界面毫无用处
      spellcheck: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#memory`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'memory' })
  }

  win.on('closed', () => {
    if (memoryWindow === win) memoryWindow = null
  })

  memoryWindow = win
  trackDock(win)
}

// 提醒列表：她答应过的事都在这儿，能看见才能放心（可改时间/内容、可撤）
function createReminderWindow(): void {
  if (reminderWindow) {
    reminderWindow.show()
    reminderWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 520,
    height: 560,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#1e1e24',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 关掉拼写检查：Chromium 会在输入框获得焦点时去 Google 下词典，防火墙下
      // 只会刷一排 `ssl_client_socket_impl.cc handshake failed net_error -100`，中文界面毫无用处
      spellcheck: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#reminders`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'reminders' })
  }

  win.on('closed', () => {
    if (reminderWindow === win) reminderWindow = null
  })

  reminderWindow = win
  trackDock(win)
}

// 使用说明：整个软件的功能都在这儿，新手随时能回来查（不自动弹，也没有「已读」记号）
function createHelpWindow(): void {
  if (helpWindow) {
    helpWindow.show()
    helpWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 580,
    height: 740,
    minWidth: 460,
    minHeight: 480,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#1e1e24',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 关掉拼写检查：Chromium 会在输入框获得焦点时去 Google 下词典，防火墙下
      // 只会刷一排 `ssl_client_socket_impl.cc handshake failed net_error -100`，中文界面毫无用处
      spellcheck: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#help`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'help' })
  }

  win.on('closed', () => {
    if (helpWindow === win) helpWindow = null
  })

  helpWindow = win
  trackDock(win)
}

// 酒馆：多角色卡聊天的独立主窗口。它是完整应用窗口（三栏、可缩放），
// 与桌宠那种「无边框置顶小浮窗」不是一类东西，也不参与点击穿透。
function createTavernWindow(): void {
  if (tavernWindow) {
    tavernWindow.show()
    tavernWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 1220,
    height: 800,
    title: '酒馆',
    minWidth: 480, // 720 以下渲染层走单栏布局，所以下限要低于它，否则那条分支永远走不到
    minHeight: 520,
    frame: false,
    backgroundColor: '#0a1224', // 深海夜航底色：先铺上，免得白屏闪一下
    skipTaskbar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 关掉拼写检查：Chromium 会在输入框获得焦点时去 Google 下词典，防火墙下
      // 只会刷一排 `ssl_client_socket_impl.cc handshake failed net_error -100`，中文界面毫无用处
      spellcheck: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#tavern`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'tavern' })
  }

  // 页面自带的 <title> 会盖掉窗口标题，任务栏里就变成「鲸鱼娘」了——酒馆得自己认得出
  win.on('page-title-updated', (event) => event.preventDefault())
  win.on('closed', () => {
    if (tavernWindow === win) tavernWindow = null
  })

  tavernWindow = win
  trackDock(win)
}

function closeTavernWindow(): void {
  tavernWindow?.close()
}

ipcMain.on('chat:memory-open', () => createMemoryWindow())
ipcMain.on('chat:memory-close', () => memoryWindow?.close())
ipcMain.on('chat:reminders-open', () => createReminderWindow())
ipcMain.on('chat:reminders-close', () => reminderWindow?.close())
ipcMain.on('chat:help-open', () => createHelpWindow())
ipcMain.on('chat:help-close', () => helpWindow?.close())
ipcMain.on('tavern:help-open', () => createHelpWindow())

// 输入栏隐藏（回车发送后 / Esc）；配置窗保存后关闭 / 从输入栏重新打开
ipcMain.on('chat:input-hide', () => inputWindow?.hide())
ipcMain.on('chat:config-saved', () => configWindow?.close())
ipcMain.on('chat:config-open', () => createConfigWindow())

// 预览面板 -> 桌宠窗口的转发通道
ipcMain.on('pet:play-group', (_event, group: string) => {
  mainWindow?.webContents.send('pet:play-group', group)
})
ipcMain.on('pet:set-auto', (_event, enabled: boolean) => {
  mainWindow?.webContents.send('pet:set-auto', enabled)
})

// 投喂：托盘菜单与输入栏共用。藏起来了就别喂——看不见鱼，饭只会在空气里落地
const feedPet = (): void => {
  if (!mainWindow?.isVisible()) return
  mainWindow.webContents.send('pet:feed')
}
ipcMain.on('pet:feed', feedPet)

// 拖动：渲染进程发来「相对位移」，主进程累加到当前窗口位置。
// 用相对位移而非绝对屏幕坐标，规避 DPI 缩放下的坐标单位不一致。
ipcMain.on('window:move-by', (_event, delta: { dx: number; dy: number }) => {
  if (!mainWindow) return
  const [x, y] = mainWindow.getPosition()
  mainWindow.setPosition(x + Math.round(delta.dx), y + Math.round(delta.dy))
})

// 渲染进程根据指针是否落在角色像素上切换鼠标穿透
ipcMain.on('window:set-ignore-mouse', (_event, ignore: boolean) => {
  mainWindow?.setIgnoreMouseEvents(ignore, { forward: true })
})

// 拖拽起期间锁定光标。ClipCursor 是全局桌面裁剪，渲染进程若异常不再发解锁，
// 用超时兜底自动释放（drag_enter 约 0.9s，3s 足够），避免光标被永久困住。
const CURSOR_LOCK_MAX_MS = 3000
let cursorUnlockTimer: NodeJS.Timeout | null = null

ipcMain.on('window:lock-cursor', (_event, p: { x: number; y: number }) => {
  lockCursor(p.x, p.y)
  if (cursorUnlockTimer) clearTimeout(cursorUnlockTimer)
  cursorUnlockTimer = setTimeout(() => {
    cursorUnlockTimer = null
    unlockCursor()
  }, CURSOR_LOCK_MAX_MS)
})

ipcMain.on('window:unlock-cursor', () => {
  if (cursorUnlockTimer) {
    clearTimeout(cursorUnlockTimer)
    cursorUnlockTimer = null
  }
  unlockCursor()
})

app.whenReady().then(() => {
  registerStoreIpc()
  registerConfigIpc()
  registerChatIpc(() => mainWindow)
  registerMemoryIpc()
  registerReminderIpc()
  registerAsrIpc()
  registerTavernIpc({ open: createTavernWindow, close: closeTavernWindow })
  registerAvatarProtocol()
  registerMediaProtocol()
  registerTavernAppearanceIpc()
  // 尽早建库跑迁移：有问题在启动日志里就能看到，而不是等用户点开酒馆才发现。
  // 失败只记日志——桌宠本体不该被一个可选模块连累（界面里 tavern:ping 会报出同样的错误）
  try {
    openTavernDb()
  } catch (error) {
    console.error('[tavern] 数据库初始化失败：', error)
  }
  // 应用菜单：macOS 上复制 / 粘贴 / ⌘Q 全靠菜单里的 role，不装等于全废
  installApplicationMenu()

  // 语音输入要麦克风：只放行输入栏那个窗口的 media 请求（桌宠窗口没有理由要麦克风）
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission !== 'media' || webContents !== inputWindow?.webContents) {
      callback(false)
      return
    }
    // macOS 还多一道系统级授权：不问这一句，getUserMedia 会被静默拒绝。
    // 放在这里问，正好是用户第一次点 🎤 的时候，不会一开机就弹窗吓人。
    if (process.platform === 'darwin') {
      systemPreferences.askForMediaAccess('microphone').then(
        (granted) => callback(granted),
        () => callback(false)
      )
      return
    }
    callback(true)
  })
  createWindow()
  // 只挂桌宠时不占 Dock（macOS）；后面每开一个窗口都由 trackDock 切回来。
  // 这里必须显式 hide：dockShown 的初始值就是 false，syncDock 会早退，Dock 会一直挂着。
  if (process.platform === 'darwin' && app.dock) app.dock.hide()
  registerGlobalMouse(() => mainWindow)
  // 运行中拔掉副屏：窗口可能整个落在那块不存在的屏幕上
  watchDisplays(() => mainWindow)
  // 仅在 electron-vite dev 下显示动作预览面板
  if (process.env['ELECTRON_RENDERER_URL']) createDashboardWindow()

  // 聊天入口：全局快捷键唤起输入栏（不占用桌宠的左键/右键手势）。
  // 输入栏窗口按需创建——常驻一个隐藏渲染进程要白白吃掉 40MB 左右
  globalShortcut.register('CommandOrControl+Shift+Space', showInputWindow)

  // 托盘是桌宠唯一的常驻入口（无任务栏图标、无关闭按钮）
  createTray({
    isPetVisible: () => Boolean(mainWindow?.isVisible()),
    togglePet: () => {
      if (!mainWindow) return
      if (mainWindow.isVisible()) mainWindow.hide()
      else mainWindow.show()
    },
    showPet: () => mainWindow?.show(),
    feedPet,
    openInput: showInputWindow,
    openSettings: createConfigWindow,
    openMemory: createMemoryWindow,
    openReminders: createReminderWindow,
    openHelp: createHelpWindow,
    openTavern: createTavernWindow
  })

  // 首次启动没有 API Key → 弹配置窗
  if (!hasKey()) createConfigWindow()

  // 「现在别打扰她」的统一判断：把她藏起来 / 输入栏 / 配置窗 / 手账 / 提醒列表开着
  // （藏起来也算「不想被打扰」——看不见鱼却冒出声音更糟）
  const isBusy = (): boolean =>
    Boolean(
      (mainWindow && !mainWindow.isVisible()) ||
        inputWindow?.isVisible() ||
        configWindow ||
        memoryWindow ||
        reminderWindow
    )

  // 主动消息：静置久了 / 时段问候
  startProactiveScheduler(isBusy)
  // 提醒：用户托付的事到点就说（不受勿扰时段与每日上限约束，但同样不插嘴）
  startReminderScheduler(isBusy)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出前务必释放光标裁剪，避免进程结束后光标仍被困在 1×1 区域；
// 同时停掉全局鼠标钩子——不停会在 Node 环境拆除时 abort（见 globalMouse.ts）
app.on('will-quit', () => {
  stopGlobalMouse()
  globalShortcut.unregisterAll()
  if (cursorUnlockTimer) {
    clearTimeout(cursorUnlockTimer)
    cursorUnlockTimer = null
  }
  unlockCursor()
  // 关库会合并 WAL 并释放文件句柄，别把 -wal 留给下次启动去猜
  closeTavernDb()
})
