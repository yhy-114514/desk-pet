// 酒馆的 IPC：通道一律走 tavern: 前缀（见 CLAUDE.md §四.4）。
// T0 有开窗 / 关窗 / 自检；T1 补上角色卡那一组（列表、读写、导入导出、立绘、用户人设）。
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions
} from 'electron'
import { openTavernDb, tableNames } from './db'
import {
  clearCards,
  deleteCard,
  exportCard,
  getCard,
  importCardFiles,
  listCards,
  listTags,
  loadProfile,
  restoreCard,
  saveAvatar,
  saveCard,
  saveProfile,
  type CardQuery,
  type UserProfile
} from './cards'
import type { CardInput } from './cardFormat'
import { registerTavernChatIpc } from './chatService'
import { registerTavernMemoryIpc } from './memoryIpc'
import { registerTavernSpectatorIpc } from './spectatorIpc'
import { registerTavernT4Ipc } from './t4Ipc'
import { registerTavernBackupIpc } from './backupIpc'
import { getOnboardingState, setOnboardingFlags, type OnboardingState } from './onboarding'

export interface TavernActions {
  open: () => void
  close: () => void
}

export interface TavernStatus {
  ok: boolean
  tables: string[]
  error?: string
}

/** 文件对话框要挂在酒馆窗口上，否则弹到别处 / 被置顶的桌宠挡住 */
function parentWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function openFileDialog(event: IpcMainInvokeEvent, options: OpenDialogOptions) {
  const win = parentWindow(event)
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
}

function saveFileDialog(event: IpcMainInvokeEvent, options: SaveDialogOptions) {
  const win = parentWindow(event)
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'character'
}

export function registerTavernIpc(actions: TavernActions): void {
  ipcMain.on('tavern:open', () => actions.open())
  ipcMain.on('tavern:close', () => actions.close())

  // 聊天核心（T2）：会话 / 消息树 / 流式
  registerTavernChatIpc()
  // 记忆三层（T3）：永久记忆 / 忆境典藏 / 记忆设置
  registerTavernMemoryIpc()
  // 提示词工具（T4）：世界书 / 正则 / 预设 / 文风 / 回复设置 / 状态栏 / 变量
  registerTavernT4Ipc()
  // 鲸鱼娘旁观（T7）：观战开关 / 问答 / 灵感 / 角色卡助手
  registerTavernSpectatorIpc()
  // 打磨与发布（T9）：备份 / 恢复
  registerTavernBackupIpc()

  // 首次启动引导（T9）：有没有走过引导、现有几张卡
  ipcMain.handle('tavern:onboarding-get', (): OnboardingState => getOnboardingState())
  ipcMain.handle(
    'tavern:onboarding-set',
    (_event, patch: Partial<Pick<OnboardingState, 'firstRunDone' | 'greetShown'>>) =>
      setOnboardingFlags(patch ?? {})
  )
  // 关于：版本号只有一个来源（package.json → app.getVersion）
  ipcMain.handle('tavern:about-get', () => ({ version: app.getVersion(), electron: process.versions.electron }))

  // 自检：顺手把建库 + 迁移跑一遍，结果直接显示在窗口里——
  // 建库失败时桌宠本体不该跟着挂，所以这里吞下异常，只回报给界面。
  ipcMain.handle('tavern:ping', (): TavernStatus => {
    try {
      return { ok: true, tables: tableNames(openTavernDb()) }
    } catch (error) {
      return { ok: false, tables: [], error: (error as Error).message }
    }
  })

  // 剪贴板：卡里的状态页跑在沙箱 iframe 里（opaque origin，非安全上下文），
  // `navigator.clipboard` 是 undefined；转到父页写也不行——那时焦点在 iframe 上，
  // 父页的 `writeText` 会静默 reject。只有主进程的 clipboard 既不看焦点也不看安全上下文。
  ipcMain.handle('tavern:clipboard-write', (_event, text: string) => {
    clipboard.writeText(String(text ?? ''))
  })

  ipcMain.handle('tavern:cards-list', (_event, query: CardQuery = {}) => listCards(query))
  ipcMain.handle('tavern:cards-tags', () => listTags())
  ipcMain.handle('tavern:cards-get', (_event, id: string) => getCard(id))
  ipcMain.handle(
    'tavern:cards-save',
    (_event, input: CardInput & { id?: string; rawData?: Record<string, unknown> | null }) =>
      saveCard(input)
  )
  ipcMain.handle('tavern:cards-delete', (_event, id: string) => deleteCard(id))
  ipcMain.handle('tavern:cards-restore', (_event, id: string) => restoreCard(id))
  ipcMain.handle('tavern:cards-clear', () => clearCards())

  ipcMain.handle('tavern:cards-import', async (event) => {
    const picked = await openFileDialog(event, {
      title: '导入角色卡',
      filters: [{ name: '角色卡', extensions: ['png', 'json'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) return []
    return importCardFiles(picked.filePaths)
  })

  ipcMain.handle(
    'tavern:cards-export',
    async (event, id: string, format: 'json' | 'png'): Promise<{ ok: boolean; error?: string }> => {
      const card = getCard(id)
      if (!card) return { ok: false, error: '角色不存在' }
      const picked = await saveFileDialog(event, {
        title: '导出角色卡',
        defaultPath: `${safeFileName(card.name)}.${format}`,
        filters: [{ name: format === 'png' ? '角色卡 PNG' : '角色卡 JSON', extensions: [format] }]
      })
      if (picked.canceled || !picked.filePath) return { ok: false }
      try {
        exportCard(id, format, picked.filePath)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
    }
  )

  // 选立绘：立刻复制进 avatars/ 并返回文件名，界面上就能直接预览
  ipcMain.handle(
    'tavern:avatar-pick',
    async (event): Promise<{ path: string } | null> => {
      const picked = await openFileDialog(event, {
        title: '选择立绘',
        filters: [{ name: '图片', extensions: ['png'] }],
        properties: ['openFile']
      })
      if (picked.canceled || picked.filePaths.length === 0) return null
      try {
        return { path: saveAvatar(picked.filePaths[0]!) }
      } catch (error) {
        throw new Error(`读取图片失败：${(error as Error).message}`)
      }
    }
  )

  ipcMain.handle('tavern:profile-get', () => loadProfile())
  ipcMain.handle('tavern:profile-set', (_event, profile: UserProfile) => saveProfile(profile))
}
