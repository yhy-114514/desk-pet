// 变量系统（MVU）的落库：状态挂在 chats.settings.variables 上。
// 会话级而不是角色级——同一张卡重开一场，变量应该从头开始。
import { getCard, getCardData, loadProfile } from './cards'
import { openTavernDb } from './db'
import { applyJsonPatch, extractUpdates, type JsonPatchOp, type MvuState } from './mvu'
import { readInitVars } from './mvuInit'

type Row = Record<string, unknown>

function readSettings(chatId: string): Record<string, unknown> {
  const row = openTavernDb().prepare('SELECT settings FROM chats WHERE id = ?').get(chatId) as
    | Row
    | undefined
  if (!row) return {}
  try {
    const parsed: unknown = JSON.parse(String(row['settings']))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function loadVariables(chatId: string): MvuState {
  const value = readSettings(chatId)['variables']
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as MvuState) : {}
}

export function saveVariables(chatId: string, state: MvuState): void {
  const settings = readSettings(chatId)
  settings['variables'] = state
  // 落过盘就算「这场会话的变量已经建立过」。不写这个记号的话，模型把顶层键
  // 逐个删空后 `variables` 也是 `{}`，下次读取会被当成「还没初始化」，
  // `[initvar]` 又把整份初始值填回来——刚清掉的状态原地复活
  settings['variablesInit'] = true
  openTavernDb()
    .prepare('UPDATE chats SET settings = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(settings), Date.now(), chatId)
}

/**
 * 清空这一场的变量。要留一个「已经初始化过」的记号：空对象和「还没初始化」在
 * `settings.variables` 上长得一样，不留记号的话下次读取会把 `[initvar]` 又填回来，
 * 面板上点「清空状态」等于没点。
 */
export function clearVariables(chatId: string): void {
  const settings = readSettings(chatId)
  settings['variables'] = {}
  settings['variablesInit'] = true
  openTavernDb()
    .prepare('UPDATE chats SET settings = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(settings), Date.now(), chatId)
}

/**
 * 取这一场的变量；还一条都没有时用卡里的 `[initvar]` 开场。
 * 卡自带的状态栏页面是照 stat_data 画的，不初始化就全是 N/A。
 */
export function loadOrInitVariables(chatId: string, characterId: string): MvuState {
  const settings = readSettings(chatId)
  const existing = loadVariables(chatId)
  if (Object.keys(existing).length > 0) return existing
  // 用户点过「清空状态」：空就是空，别再拿卡的初始变量把它填回去
  if (settings['variablesInit'] === true) return existing
  const card = getCard(characterId)
  const init = readInitVars(getCardData(characterId), {
    char: card?.name ?? '',
    user: loadProfile().name
  })
  if (!init) return existing
  saveVariables(chatId, init)
  return init
}

/**
 * 把一条回复里的更新块洗掉，并把 patch 应用到会话状态上。
 * 返回干净正文（落库用它）与本轮实际生效的 ops（调试 / 提示用）。
 */
export function consumeUpdates(
  chatId: string,
  raw: string
): { text: string; ops: JsonPatchOp[] } {
  const { text, ops } = extractUpdates(raw)
  if (ops.length === 0) return { text, ops }
  const current = loadVariables(chatId)
  saveVariables(chatId, applyJsonPatch(current, ops))
  return { text, ops }
}
