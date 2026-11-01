// 记忆三层（T3）的 IPC：永久记忆手账、忆境典藏、记忆设置。
// 聊天链路本身在 chatService 里（发送前检索、每轮后抽取、到间隔摘要）。
import { ipcMain } from 'electron'
import { getChat } from './chatStore'
import { formatDossier } from './dossier'
import { deleteMemory, listMemories, updateMemory } from './memoryStore'
import { loadMemorySettings, saveMemorySettings, type MemorySettings } from './memorySettings'
import {
  deleteSummary,
  isSummarizing,
  latestSummary,
  listSummaries,
  summarizeNow,
  updateSummary
} from './summaryStore'

export function registerTavernMemoryIpc(): void {
  ipcMain.handle('tavern:memory-settings', () => loadMemorySettings())
  ipcMain.handle('tavern:memory-settings-set', (_event, patch: Partial<MemorySettings>) =>
    saveMemorySettings(patch)
  )

  ipcMain.handle('tavern:memories-list', (_event, characterId: string) => listMemories(characterId))
  ipcMain.handle(
    'tavern:memories-update',
    (_event, payload: { id: string; content: string }) => updateMemory(payload.id, payload.content)
  )
  ipcMain.handle('tavern:memories-delete', (_event, id: string) => deleteMemory(id))

  // 某场对话的档案：最新一份（拼好的文本给界面看）+ 全部（手账里逐条改/删）
  ipcMain.handle('tavern:summary-get', (_event, chatId: string) => {
    const latest = latestSummary(chatId)
    return {
      summarizing: isSummarizing(chatId),
      text: latest?.dossier ? formatDossier(latest.dossier) : '',
      items: listSummaries(chatId).map((item) => ({
        id: item.id,
        raw: item.raw,
        createdAt: item.createdAt
      }))
    }
  })
  // 「立即总结一次」：不看间隔，直接跑。过程用事件通知界面「总结中」
  ipcMain.handle('tavern:summary-refresh', async (event, chatId: string) => {
    if (!getChat(chatId)) return { ok: false, error: '这场对话不在了。' }
    await summarizeNow(chatId, (active) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('tavern:summary', { chatId, active })
      }
    })
    return { ok: true }
  })
  ipcMain.handle(
    'tavern:summary-update',
    (_event, payload: { id: string; raw: string }) => updateSummary(payload.id, payload.raw)
  )
  ipcMain.handle('tavern:summary-delete', (_event, id: string) => deleteSummary(id))
}
