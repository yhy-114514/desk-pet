// T5 外观设置的 IPC 与媒体协议：背景图 / 音乐存在 userData/tavern/media/，
// 界面用 tavern-media://local/<文件名> 取，主进程只放行我们自己生成的 uuid 文件名。
import { BrowserWindow, ipcMain, net, protocol, type IpcMainInvokeEvent } from 'electron'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pickOpenFiles } from './dialogFiles'
import {
  isMediaFileName,
  loadAppearance,
  mediaFilePath,
  removeMedia,
  saveAppearance,
  saveMedia,
  type AppearanceSettings,
  type MediaKind
} from './appearance'

export const MEDIA_SCHEME = 'tavern-media'

/** scheme 要在 app ready 之前登记（main/index.ts），handler 在 ready 之后挂 */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const name = basename(decodeURIComponent(new URL(request.url).pathname))
    // 只认 uuid 命名的白名单扩展名，挡住 ../ 之类的路径穿越
    if (!isMediaFileName(name)) return new Response('bad request', { status: 400 })
    try {
      // net.fetch 走 Electron 自己的文件读取：图片能按需加载，音频也能被 <audio> 正常拉取
      return await net.fetch(pathToFileURL(mediaFilePath(name)).toString())
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

function broadcast(settings: AppearanceSettings): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('tavern:appearance', settings)
  }
}

/** 图片 / 音频的选择对话框。选完立刻拷进 media/，磁盘上的原文件删了也不影响 */
async function pickMedia(event: IpcMainInvokeEvent, kind: MediaKind): Promise<string | null> {
  const extensions = kind === 'image' ? ['png', 'jpg', 'jpeg', 'webp', 'gif'] : ['mp3', 'ogg', 'wav', 'm4a', 'flac']
  const files = await pickOpenFiles(event, kind === 'image' ? '选择背景图片' : '选择背景音乐', extensions)
  if (files.length === 0) return null
  return saveMedia(files[0], kind)
}

export function registerTavernAppearanceIpc(): void {
  ipcMain.handle('tavern:appearance-get', () => loadAppearance())
  ipcMain.handle('tavern:appearance-set', (_event, patch: Partial<AppearanceSettings>) => {
    const next = saveAppearance(patch)
    // 其它窗口（鲸鱼娘的小窗）要即时跟着换主题 / 字体，不等重开
    broadcast(next)
    return next
  })
  ipcMain.handle('tavern:appearance-media-pick', (event, kind: MediaKind) =>
    pickMedia(event, kind === 'audio' ? 'audio' : 'image')
  )
  ipcMain.handle('tavern:appearance-media-remove', (_event, name: string) => removeMedia(name))
}
