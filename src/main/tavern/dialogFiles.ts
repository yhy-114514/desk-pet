// 酒馆里的文件对话框（世界书 / 预设导入导出用）。
// 对话框挂在酒馆窗口上，否则会弹到别处、或被置顶的桌宠挡住。
import { BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron'

export async function pickOpenFiles(
  event: IpcMainInvokeEvent,
  title: string,
  extensions: string[]
): Promise<string[]> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const options = {
    title,
    filters: [{ name: title, extensions }],
    properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[]
  }
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return picked.canceled ? [] : picked.filePaths
}

export async function pickSaveFile(
  event: IpcMainInvokeEvent,
  title: string,
  defaultPath: string,
  extensions: string[]
): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const options = { title, defaultPath, filters: [{ name: title, extensions }] }
  const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  return picked.canceled || !picked.filePath ? null : picked.filePath
}

/** 文件名里的非法字符换掉（Windows 上会直接保存失败） */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'export'
}
