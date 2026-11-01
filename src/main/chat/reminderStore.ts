// 提醒队列持久化（userData/reminders.json）：与其它 store 同款手写 JSON + tmp/rename。
// 只做存取，什么时候该说是 reminders.ts（调度器）与 reminder.ts（纯逻辑）的事。
import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAX_REMINDERS, addToList, removeFromList, replaceInList, type Reminder } from './reminder'

const VERSION = 1

interface ReminderFile {
  version: number
  items: Reminder[]
}

function storePath(): string {
  return join(app.getPath('userData'), 'reminders.json')
}

export function loadReminders(): Reminder[] {
  const file = storePath()
  try {
    if (!existsSync(file)) return []
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ReminderFile>
    if (!Array.isArray(raw.items)) return []
    return raw.items
      .filter(
        (item): item is Reminder =>
          Boolean(item) && typeof item.text === 'string' && Number.isFinite(item.at)
      )
      .map((item) => ({ at: item.at, text: item.text.trim() }))
      .filter((item) => item.text.length > 0)
      .slice(-MAX_REMINDERS)
  } catch {
    // 文件损坏：当作没有提醒，别让它拖住启动
    return []
  }
}

export function saveReminders(items: Reminder[]): void {
  const file = storePath()
  const tmp = `${file}.tmp`
  const data: ReminderFile = { version: VERSION, items: items.slice(-MAX_REMINDERS) }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmp, file)
  } catch (error) {
    console.error('[reminderStore] 写入失败', error)
  }
}

/** 追加一批提醒（去重 + 上限交给 addToList） */
export function addReminders(items: Reminder[]): void {
  if (!items.length) return
  let list = loadReminders()
  for (const item of items) list = addToList(list, item)
  saveReminders(list)
}

/** 撤掉一条（提醒列表页）。调度器每 30 秒重新 load，删完下一轮就不会再响 */
export function deleteReminder(target: Reminder): void {
  saveReminders(removeFromList(loadReminders(), target))
}

/** 改写一条（改时间 / 改内容） */
export function updateReminder(from: Reminder, to: Reminder): void {
  // 内容被清空等于删除：列表页里把字改没了，不该留一条空提醒到点响
  if (!to.text.trim()) {
    deleteReminder(from)
    return
  }
  saveReminders(replaceInList(loadReminders(), from, { at: to.at, text: to.text.trim() }))
}

/** 提醒列表页读写通道（chat:reminders-*）。按时间先后排，最近要响的排在最前。 */
export function registerReminderIpc(): void {
  ipcMain.handle('chat:reminders-list', () =>
    [...loadReminders()].sort((a, b) => a.at - b.at)
  )
  ipcMain.on('chat:reminders-delete', (_event, target: Reminder) => deleteReminder(target))
  ipcMain.on(
    'chat:reminders-edit',
    (_event, data: { from: Reminder; to: Reminder }) => updateReminder(data.from, data.to)
  )
}
