// 开机自启：开关在托盘菜单。默认关——第一次启动就往注册表 Run 里塞一条，
// 对一个还没打包的程序来说太自作主张了，让用户自己点一下。
import { app } from 'electron'

/**
 * 登录项的启动命令。
 * 开发模式下 execPath 是 electron.exe，必须把项目路径当参数带上，
 * 否则开机只会拉起一个空白的 Electron 窗口（没有 app 可加载）。
 */
export function loginItemOptions(
  isPackaged: boolean,
  execPath: string,
  appPath: string
): { path: string; args: string[] } {
  return { path: execPath, args: isPackaged ? [] : [appPath] }
}

function options(): { path: string; args: string[] } {
  return loginItemOptions(app.isPackaged, process.execPath, app.getAppPath())
}

/** 读注册表里的真实状态，而不是另存一份配置——两者不同步时用户会看不出问题。 */
export function isAutoStartEnabled(): boolean {
  return app.getLoginItemSettings(options()).openAtLogin
}

export function setAutoStart(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled, ...options() })
}
