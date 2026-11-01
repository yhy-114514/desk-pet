// 备份 / 恢复的 IPC：选文件走原生对话框，恢复成功后让应用自己重启。
import { app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { exportBackup, importBackup, type BackupResult } from './backup'
import { pickOpenFiles, pickSaveFile } from './dialogFiles'

function stamp(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
}

export function registerTavernBackupIpc(): void {
  ipcMain.handle(
    'tavern:backup-export',
    async (event: IpcMainInvokeEvent): Promise<BackupResult> => {
      const target = await pickSaveFile(event, '导出备份', join(app.getPath('documents'), `酒馆备份-${stamp()}.zip`), [
        'zip'
      ])
      if (!target) return { ok: false }
      return exportBackup(app.getPath('userData'), target)
    }
  )

  ipcMain.handle(
    'tavern:backup-import',
    async (event: IpcMainInvokeEvent): Promise<BackupResult> => {
      const picked = await pickOpenFiles(event, '导入备份', ['zip'])
      if (picked.length === 0) return { ok: false }
      const result = importBackup(app.getPath('userData'), picked[0]!)
      if (result.ok) {
        // 数据已经落盘，但库连接关掉了、主进程里的配置 / 记忆 / 历史缓存也还是旧的，
        // 只能整个应用重来一次。稍等一下再退，让渲染层把「正在重启」画出来。
        //
        // 开发模式（npm run dev）不能 relaunch：Electron 一退，electron-vite 连同它
        // 进程里的 vite dev server 一起退出，重启出来的壳子会加载一个已经不存在的
        // 地址——看起来就是白屏卡死。这里改成弹框说明后干净退出，由用户自己重跑。
        if (process.env['ELECTRON_RENDERER_URL']) {
          dialog.showMessageBoxSync({
            type: 'info',
            title: '恢复完成',
            message: '数据已经恢复。',
            detail:
              '开发模式（npm run dev）没法自动重启——重启会把 dev server 一起关掉，' +
              '新开的窗口加载不到界面。应用马上退出，请重新运行 npm run dev。',
            buttons: ['好'],
            noLink: true
          })
          app.quit()
          return { ...result, restart: 'manual' }
        }
        setTimeout(() => {
          app.relaunch()
          // 用 quit 而不是 exit：will-quit 里要停全局鼠标钩子、释放光标裁剪，
          // exit(0) 直接跳过这些清理（uiohook 会在 Node 环境拆除时 abort）
          app.quit()
        }, 300)
        return { ...result, restart: 'auto' }
      }
      return result
    }
  )
}
