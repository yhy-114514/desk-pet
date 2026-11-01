// 预设的数据层：presets 表（整份预设 JSON 存在 data 列）+ 「当前用哪一份」。
// 条目数动辄两三百，拆成 preset_entries 表反而难保真（顺序、marker、采样参数都要还原），
// 所以整份 JSON 存一个字段，界面读出来改完再整份写回。
import { randomUUID } from 'node:crypto'
import { openTavernDb } from './db'
import { DEFAULT_SAMPLING, parseStPreset, toStPreset, type PresetData } from './preset'

type Row = Record<string, unknown>

const ACTIVE_KEY = 'preset.active'

export interface PresetSummary {
  id: string
  name: string
  promptCount: number
  enabledCount: number
  updatedAt: number
}

export function listPresets(): PresetSummary[] {
  const rows = openTavernDb()
    .prepare('SELECT id, name, data, updated_at FROM presets ORDER BY updated_at DESC')
    .all() as Row[]
  return rows.map((row) => {
    const data = parseData(row['data'])
    return {
      id: String(row['id']),
      name: String(row['name']),
      promptCount: data?.prompts.length ?? 0,
      enabledCount: data?.prompts.filter((prompt) => prompt.enabled).length ?? 0,
      updatedAt: Number(row['updated_at'])
    }
  })
}

function parseData(text: unknown): PresetData | null {
  try {
    const parsed: unknown = JSON.parse(String(text))
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Partial<PresetData>
    return {
      name: typeof record.name === 'string' ? record.name : '',
      sampling: { ...DEFAULT_SAMPLING, ...(record.sampling ?? {}) },
      prompts: Array.isArray(record.prompts) ? record.prompts : [],
      order: Array.isArray(record.order) ? record.order : []
    }
  } catch {
    return null
  }
}

export function getPreset(id: string): PresetData | null {
  const row = openTavernDb().prepare('SELECT data FROM presets WHERE id = ?').get(id) as
    | Row
    | undefined
  return row ? parseData(row['data']) : null
}

export function savePreset(input: { id?: string; name: string; data: PresetData }): string {
  const db = openTavernDb()
  const now = Date.now()
  const name = input.name.trim() || input.data.name.trim() || '未命名预设'
  const data = JSON.stringify({ ...input.data, name })
  if (input.id) {
    const result = db
      .prepare('UPDATE presets SET name = ?, data = ?, updated_at = ? WHERE id = ?')
      .run(name, data, now, input.id)
    if (Number(result.changes) > 0) return input.id
    // 这份预设可能在别处被删了（deletePreset 会摘掉会话绑定）：按原来的 id 补回去，
    // 否则界面提示「已保存」而改动整份丢掉
    db.prepare('INSERT INTO presets (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      input.id,
      name,
      data,
      now,
      now
    )
    return input.id
  }
  const id = randomUUID()
  db.prepare('INSERT INTO presets (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    name,
    data,
    now,
    now
  )
  return id
}

export function deletePreset(id: string): void {
  // 先摘会话绑定再删：chats.preset_id 是外键，反过来删会被 FK 挡下
  openTavernDb().prepare('UPDATE chats SET preset_id = NULL WHERE preset_id = ?').run(id)
  openTavernDb().prepare('DELETE FROM presets WHERE id = ?').run(id)
  if (activePresetId() === id) setActivePresetId(null)
}

export function importPreset(raw: string, name?: string): { id: string; name: string; prompts: number } {
  const data = parseStPreset(raw, name ?? '导入的预设')
  const id = savePreset({ name: name ?? data.name, data })
  return { id, name: data.name, prompts: data.prompts.length }
}

export function exportPreset(id: string): string {
  const data = getPreset(id)
  if (!data) throw new Error('预设不存在')
  return toStPreset(data)
}

export function activePresetId(): string | null {
  const row = openTavernDb().prepare('SELECT value FROM settings WHERE key = ?').get(ACTIVE_KEY) as
    | Row
    | undefined
  if (!row) return null
  try {
    const parsed: unknown = JSON.parse(String(row['value']))
    return typeof parsed === 'string' && parsed ? parsed : null
  } catch {
    return null
  }
}

export function setActivePresetId(id: string | null): void {
  openTavernDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(ACTIVE_KEY, JSON.stringify(id))
}

/** 这场会话用哪份预设：会话自己挂的优先，否则用全局当前那份。 */
export function presetForChat(chatId: string): PresetData | null {
  const row = openTavernDb().prepare('SELECT preset_id FROM chats WHERE id = ?').get(chatId) as
    | Row
    | undefined
  const perChat = row?.['preset_id']
  if (typeof perChat === 'string' && perChat) {
    const preset = getPreset(perChat)
    if (preset) return preset
  }
  const global = activePresetId()
  return global ? getPreset(global) : null
}

export function setChatPreset(chatId: string, presetId: string | null): void {
  openTavernDb()
    .prepare('UPDATE chats SET preset_id = ?, updated_at = ? WHERE id = ?')
    .run(presetId, Date.now(), chatId)
}
