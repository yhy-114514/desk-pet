// 极简 JSON 持久化：好感度写入 userData/pet-store.json。
// 只做 P3 需要的最小字段，后续聊天记录 / 窗口位置再按需扩展。
import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const VERSION = 1
const AFFECTION_MIN = 0
const AFFECTION_MAX = 100

export interface PetStoreData {
  version: number
  affection: number
  lastActiveDate: string
}

const DEFAULT_DATA: PetStoreData = { version: VERSION, affection: 10, lastActiveDate: '' }

let cached: PetStoreData | null = null

export function storePath(): string {
  return join(app.getPath('userData'), 'pet-store.json')
}

export function loadStore(): PetStoreData {
  if (cached) return cached
  const file = storePath()
  try {
    if (!existsSync(file)) {
      cached = { ...DEFAULT_DATA }
      return cached
    }
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<PetStoreData>
    cached = sanitize(raw)
  } catch {
    // 文件损坏 / 解析失败 → 回退默认值，不让脏数据阻碍启动
    cached = { ...DEFAULT_DATA }
  }
  return cached
}

export function saveStore(data: PetStoreData): void {
  const file = storePath()
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    // 先写临时文件再 rename，避免写一半断电留下半截 JSON
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    renameSync(tmp, file)
  } catch (error) {
    console.error('[petStore] 写入失败', error)
  }
}

function sanitize(raw: Partial<PetStoreData>): PetStoreData {
  const affection =
    typeof raw.affection === 'number' && Number.isFinite(raw.affection)
      ? Math.min(AFFECTION_MAX, Math.max(AFFECTION_MIN, Math.round(raw.affection)))
      : DEFAULT_DATA.affection
  const lastActiveDate = typeof raw.lastActiveDate === 'string' ? raw.lastActiveDate : ''
  return { version: VERSION, affection, lastActiveDate }
}

export function registerStoreIpc(): void {
  ipcMain.handle('pet:affection-get', () => loadStore())
  ipcMain.on('pet:affection-set', (_event, data: Partial<PetStoreData>) => {
    cached = sanitize(data)
    saveStore(cached)
  })
}
