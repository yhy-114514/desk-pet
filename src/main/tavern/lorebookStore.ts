// 世界书的数据层：lorebooks / lorebook_entries 的 CRUD + 三层合并解析。
// 纯逻辑（激活、导入导出）在 worldbook.ts，这里只管落库。
import { randomUUID } from 'node:crypto'
import { openTavernDb } from './db'
import {
  entryFromRaw,
  mergeLayers,
  parseStLorebook,
  toStLorebook,
  type LoreEntry,
  type LoreSource
} from './worldbook'

type Row = Record<string, unknown>

export interface LorebookSummary {
  id: string
  name: string
  description: string
  scope: string
  characterId: string | null
  chatId: string | null
  enabled: boolean
  entryCount: number
  updatedAt: number
}

export interface LorebookEntryInput {
  id?: string
  name: string
  keys: string[]
  secondaryKeys: string[]
  content: string
  constant: boolean
  selective: boolean
  position: 'before_char' | 'after_char' | 'depth'
  depth: number
  order: number
  caseSensitive: boolean
  enabled?: boolean
}

function parseList(text: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(text))
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function toEntry(row: Row, source: LoreSource): LoreEntry {
  return {
    id: String(row['id']),
    name: String(row['name'] ?? row['comment'] ?? ''),
    keys: parseList(row['keys']),
    secondaryKeys: parseList(row['secondary_keys']),
    content: String(row['content']),
    constant: Number(row['constant']) === 1,
    selective: Number(row['selective']) === 1,
    position: String(row['position']) as LoreEntry['position'],
    depth: Number(row['depth']),
    order: Number(row['order_index']),
    caseSensitive: Number(row['case_sensitive']) === 1,
    source,
    readonly: false
  }
}

export function listLorebooks(scope?: string, ownerId?: string): LorebookSummary[] {
  const db = openTavernDb()
  const where: string[] = []
  const params: string[] = []
  if (scope) {
    where.push('b.scope = ?')
    params.push(scope)
  }
  if (ownerId) {
    where.push('(b.character_id = ? OR b.chat_id = ?)')
    params.push(ownerId, ownerId)
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  const rows = db
    .prepare(
      'SELECT b.*, (SELECT COUNT(*) FROM lorebook_entries e WHERE e.lorebook_id = b.id) AS n' +
        ` FROM lorebooks b${clause} ORDER BY b.updated_at DESC`
    )
    .all(...params) as Row[]
  return rows.map((row) => ({
    id: String(row['id']),
    name: String(row['name']),
    description: String(row['description']),
    scope: String(row['scope']),
    characterId: row['character_id'] === null ? null : String(row['character_id']),
    chatId: row['chat_id'] === null ? null : String(row['chat_id']),
    enabled: Number(row['enabled']) === 1,
    entryCount: Number(row['n'] ?? 0),
    updatedAt: Number(row['updated_at'])
  }))
}

export function createLorebook(input: {
  name: string
  description?: string
  scope: 'global' | 'character' | 'chat'
  characterId?: string | null
  chatId?: string | null
}): string {
  const id = randomUUID()
  const now = Date.now()
  openTavernDb()
    .prepare(
      'INSERT INTO lorebooks (id, scope, character_id, chat_id, name, description, enabled, created_at, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)'
    )
    .run(
      id,
      input.scope,
      input.characterId ?? null,
      input.chatId ?? null,
      input.name.trim() || '未命名世界书',
      input.description ?? '',
      now,
      now
    )
  return id
}

export function deleteLorebook(id: string): void {
  openTavernDb().prepare('DELETE FROM lorebooks WHERE id = ?').run(id)
}

export function setLorebookEnabled(id: string, enabled: boolean): void {
  openTavernDb()
    .prepare('UPDATE lorebooks SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, Date.now(), id)
}

export function listEntries(lorebookId: string, source: LoreSource = 'global'): LoreEntry[] {
  const rows = openTavernDb()
    .prepare('SELECT * FROM lorebook_entries WHERE lorebook_id = ? ORDER BY order_index ASC, created_at ASC')
    .all(lorebookId) as Row[]
  return rows.map((row) => toEntry(row, source))
}

export function saveEntry(lorebookId: string, input: LorebookEntryInput): string {
  const db = openTavernDb()
  const now = Date.now()
  const id = input.id ?? randomUUID()
  const fields = [
    input.name.trim(),
    JSON.stringify(input.keys),
    JSON.stringify(input.secondaryKeys),
    input.content,
    input.constant ? 1 : 0,
    input.selective ? 1 : 0,
    input.position,
    Math.max(0, Math.round(input.depth)),
    Math.round(input.order),
    input.enabled === false ? 0 : 1,
    input.caseSensitive ? 1 : 0
  ]
  const existing = db.prepare('SELECT id FROM lorebook_entries WHERE id = ?').get(id) as
    | Row
    | undefined
  if (existing) {
    db.prepare(
      'UPDATE lorebook_entries SET name = ?, keys = ?, secondary_keys = ?, content = ?, constant = ?,' +
        ' selective = ?, position = ?, depth = ?, order_index = ?, enabled = ?,' +
        ' case_sensitive = ?, updated_at = ? WHERE id = ?'
    ).run(...fields, now, id)
  } else {
    db.prepare(
      'INSERT INTO lorebook_entries (name, keys, secondary_keys, content, constant, selective,' +
        ' position, depth, order_index, enabled, case_sensitive, updated_at, id, lorebook_id, created_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(...fields, now, id, lorebookId, now)
  }
  db.prepare('UPDATE lorebooks SET updated_at = ? WHERE id = ?').run(now, lorebookId)
  return id
}

export function deleteEntry(id: string): void {
  openTavernDb().prepare('DELETE FROM lorebook_entries WHERE id = ?').run(id)
}

/** 导入一本 ST 世界书到指定作用域。返回新书 id 与条目数。 */
export function importLorebook(
  raw: string,
  target: {
    scope: 'global' | 'character' | 'chat'
    characterId?: string | null
    chatId?: string | null
    name?: string
  }
): { id: string; name: string; entries: number } {
  const file = parseStLorebook(raw)
  const id = createLorebook({
    name: target.name ?? file.name,
    scope: target.scope,
    characterId: target.characterId ?? null,
    chatId: target.chatId ?? null
  })
  for (const entry of file.entries) {
    saveEntry(id, {
      name: entry.name,
      keys: entry.keys,
      secondaryKeys: entry.secondaryKeys,
      content: entry.content,
      constant: entry.constant,
      selective: entry.selective,
      position: entry.position,
      depth: entry.depth,
      order: entry.order,
      caseSensitive: entry.caseSensitive
    })
  }
  return { id, name: file.name, entries: file.entries.length }
}

export function exportLorebook(id: string): string {
  const row = openTavernDb().prepare('SELECT name FROM lorebooks WHERE id = ?').get(id) as
    | Row
    | undefined
  return toStLorebook(String(row?.['name'] ?? '世界书'), listEntries(id))
}

/** 把一串条目（比如卡内嵌世界书）存成一本独立世界书。 */
export function saveEntriesAsBook(
  name: string,
  entries: LoreEntry[],
  target: { scope: 'global' | 'character' | 'chat'; characterId?: string | null; chatId?: string | null }
): string {
  const id = createLorebook({
    name,
    scope: target.scope,
    characterId: target.characterId ?? null,
    chatId: target.chatId ?? null
  })
  for (const entry of entries) {
    saveEntry(id, {
      name: entry.name,
      keys: entry.keys,
      secondaryKeys: entry.secondaryKeys,
      content: entry.content,
      constant: entry.constant,
      selective: entry.selective,
      position: entry.position,
      depth: entry.depth,
      order: entry.order,
      caseSensitive: entry.caseSensitive
    })
  }
  return id
}

function booksFor(
  where: string,
  params: (string | number)[]
): LoreEntry[] {
  const db = openTavernDb()
  const books = db.prepare(`SELECT id, scope FROM lorebooks WHERE enabled = 1 AND ${where}`).all(...params) as Row[]
  const entries: LoreEntry[] = []
  for (const book of books) {
    const scope = String(book['scope']) as LoreSource
    entries.push(...listEntries(String(book['id']), scope))
  }
  return entries
}

/**
 * 三层合并后的世界书条目：全局 → 角色（DB 里的书）→ 卡内嵌 → 会话。
 * 卡内嵌条目排在 DB 角色书之后：作者写进卡里的设定更接近「这张卡的定义」。
 */
export function resolveLoreEntries(input: {
  characterId: string
  chatId: string | null
  /** 卡内嵌世界书（readCardEntries 的结果），由调用方传进来，避免这里依赖 cards.ts */
  cardEntries?: LoreEntry[]
}): LoreEntry[] {
  const global = booksFor('scope = ?', ['global'])
  const character = booksFor('scope = ? AND character_id = ?', ['character', input.characterId])
  const chat = input.chatId ? booksFor('scope = ? AND chat_id = ?', ['chat', input.chatId]) : []
  return mergeLayers(global, character, input.cardEntries ?? [], chat)
}
