// 会话历史持久化：写入 userData/chat-history.json，启动时恢复。
// 与 config.ts / petStore.ts 同样的手写 JSON + tmp/rename 原子写，不引入 electron-store。
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionSnapshot } from './session'

export function historyPath(): string {
  return join(app.getPath('userData'), 'chat-history.json')
}

/** 读取历史快照；文件不存在或损坏时返回 null（调用方回退为空会话）。 */
export function loadHistory(): SessionSnapshot | null {
  const file = historyPath()
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf-8')) as SessionSnapshot
  } catch {
    return null
  }
}

export function saveHistory(snapshot: SessionSnapshot): void {
  const file = historyPath()
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8')
    renameSync(tmp, file)
  } catch (error) {
    console.error('[chatHistory] 写入失败', error)
  }
}
