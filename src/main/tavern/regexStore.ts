// 正则规则的数据层：regexes 表的 CRUD + 「全局 + 角色（含卡内嵌）」合并。
// 应用与测试在 regexEngine.ts，这里只管存取。
import { randomUUID } from 'node:crypto'
import { openTavernDb } from './db'
import { readCardRegexes, type RegexRule, type RegexSource } from './regexEngine'

type Row = Record<string, unknown>

export interface RegexInput {
  id?: string
  name: string
  pattern: string
  flags: string
  replacement: string
  target: 'display' | 'prompt' | 'both'
  enabled: boolean
  order: number
}

function toRule(row: Row, source: RegexSource): RegexRule {
  return {
    id: String(row['id']),
    name: String(row['name']),
    pattern: String(row['pattern']),
    flags: String(row['flags'] || 'g'),
    replacement: String(row['replacement']),
    target: String(row['target']) as RegexRule['target'],
    enabled: Number(row['enabled']) === 1,
    order: Number(row['order_index']),
    source,
    readonly: false
  }
}

export function listRegexes(scope: 'global' | 'character', characterId?: string | null): RegexRule[] {
  const db = openTavernDb()
  const rows =
    scope === 'global'
      ? (db.prepare("SELECT * FROM regexes WHERE scope = 'global' ORDER BY order_index ASC").all() as Row[])
      : (db
          .prepare(
            "SELECT * FROM regexes WHERE scope = 'character' AND character_id = ? ORDER BY order_index ASC"
          )
          .all(characterId ?? '') as Row[])
  return rows.map((row) => toRule(row, scope))
}

export function saveRegex(input: RegexInput, characterId?: string | null): string {
  const db = openTavernDb()
  const now = Date.now()
  const id = input.id ?? randomUUID()
  const scope = input.id ? scopeOf(input.id) : characterId ? 'character' : 'global'
  const fields = [
    input.name.trim() || '未命名规则',
    input.pattern,
    input.replacement,
    input.flags || 'g',
    input.target,
    input.enabled ? 1 : 0,
    Math.round(input.order),
    scope === 'character' ? characterId ?? null : null
  ]
  const existing = db.prepare('SELECT id FROM regexes WHERE id = ?').get(id) as Row | undefined
  if (existing) {
    db.prepare(
      'UPDATE regexes SET name = ?, pattern = ?, replacement = ?, flags = ?, target = ?,' +
        ' enabled = ?, order_index = ?, updated_at = ? WHERE id = ?'
    ).run(...fields.slice(0, 7), now, id)
  } else {
    db.prepare(
      'INSERT INTO regexes (name, pattern, replacement, flags, target, enabled, order_index,' +
        ' character_id, id, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(...fields, id, scope, now, now)
  }
  return id
}

function scopeOf(id: string): 'global' | 'character' {
  const row = openTavernDb().prepare('SELECT scope FROM regexes WHERE id = ?').get(id) as Row | undefined
  return row?.['scope'] === 'character' ? 'character' : 'global'
}

export function deleteRegex(id: string): void {
  openTavernDb().prepare('DELETE FROM regexes WHERE id = ?').run(id)
}

/**
 * 某一轮要用的全部规则：全局 + 角色 DB + 卡内嵌。
 * 卡内嵌规则只读（source='card'），界面上会标明来源。
 */
export function resolveRegexes(input: {
  characterId: string | null
  target: 'display' | 'prompt'
  cardData?: Record<string, unknown> | null
}): RegexRule[] {
  const rules: RegexRule[] = [...listRegexes('global')]
  if (input.characterId) rules.push(...listRegexes('character', input.characterId))
  rules.push(...readCardRegexes(input.cardData))
  return rules.filter((rule) => rule.target === 'both' || rule.target === input.target)
}
