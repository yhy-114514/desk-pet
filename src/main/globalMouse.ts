import { screen, type BrowserWindow } from 'electron'

/**
 * 全局鼠标钩子（右键游动 / 跟随鼠标）**只在 Windows 上启用**。
 *
 * macOS 上 uiohook-napi 有两个都兜不住的问题：
 *  ① 没给「辅助功能」权限时 `start()` 会让进程直接 abort
 *     （`FATAL ERROR: tsfn_to_js_proxy napi_call_function`，uiohook-napi#24）。
 *     `napi_fatal_error` 是 C 层 abort，JS 的 try/catch 拦不住——应用一启动就秒退。
 *  ② 给了权限也还有 CGEventTap 的死锁（libuiohook#188 / uiohook-napi#23），
 *     macOS 14+ / Electron ≥25 上鼠标一动就可能整个卡死。
 *
 * 桌宠常年按 60Hz 收 mousemove，这两条都赌不起，所以 mac 上**连原生模块都不加载**
 * （做法与 cursor.ts 的 koffi 一致）。代价是 mac 上右键游动不可用，其余功能不受影响。
 */

type Uiohook = typeof import('uiohook-napi')['uIOhook']

// 懒加载：非 Windows 平台永远不 require，.node 也就不会被 dlopen。
let uIOhook: Uiohook | null = null

function loadHook(): Uiohook | null {
  if (process.platform !== 'win32') return null
  if (!uIOhook) uIOhook = (require('uiohook-napi') as typeof import('uiohook-napi')).uIOhook
  return uIOhook
}

// uiohook 的坐标是屏幕物理像素，转成 DIP 后与 Electron 窗口坐标一致
function toDip(x: number, y: number): { x: number; y: number } {
  const p = screen.screenToDipPoint({ x, y })
  return { x: p.x, y: p.y }
}

/**
 * 全局鼠标钩子：只关心右键与全局移动，转发给渲染进程。
 * 左键不走这里——左键需要 hitmask 像素级命中，仍由窗口 pointer 事件处理。
 *
 * 注意：uiohook-napi 是纯监听（无法阻止事件传播），因此游动状态下右键屏幕
 * 仍会叠加弹出桌面右键菜单；这是本阶段的已知限制。
 */
export function registerGlobalMouse(getWindow: () => BrowserWindow | null): void {
  const hook = loadHook()
  if (!hook) return

  const send = (channel: string, payload: unknown): void => {
    const wc = getWindow()?.webContents
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  }

  hook.on('mousedown', (e) => {
    // Windows: MOUSE_BUTTON1=左, MOUSE_BUTTON2=右, MOUSE_BUTTON3=中
    if (Number(e.button) !== 2) return
    send('mouse:global-down', toDip(e.x, e.y))
  })

  hook.on('mouseup', (e) => {
    if (Number(e.button) !== 2) return
    send('mouse:global-up', toDip(e.x, e.y))
  })

  // 全局移动：follow 模式跟鼠标用，节流到约 60Hz，避免高频 IPC
  let lastMove = 0
  hook.on('mousemove', (e) => {
    const now = Date.now()
    if (now - lastMove < 16) return
    lastMove = now
    send('mouse:global-move', toDip(e.x, e.y))
  })

  // 抛出去会中断 app.whenReady 后面的启动链（托盘菜单、首启配置窗都在它后面），
  // 右键游动用不了不该让整个应用起不来。
  try {
    hook.start()
  } catch (error) {
    console.error('[globalMouse] 全局钩子启动失败，右键游动 / 跟随鼠标将不可用：', error)
  }
}

/**
 * 退出前停掉钩子。不停的话，Electron 拆 Node 环境时 uiohook 的后台线程还在
 * 往已销毁的 JS 环境里投递事件，进程直接 abort（`uiohook_to_js_event
 * napi_define_properties` + exit 134，2026-10-24 实测）。必须在 will-quit 里调。
 *
 * 非 Windows 上钩子从没起来过，这里直接返回。
 */
export function stopGlobalMouse(): void {
  if (!uIOhook) return
  try {
    uIOhook.stop()
  } catch (error) {
    // 已经停了 / 压根没起来：退出路上不值得再抛一次
    console.error('[globalMouse] 停止全局钩子失败', error)
  }
}
