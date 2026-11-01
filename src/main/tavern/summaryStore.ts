// 忆境典藏：每 N 条消息后台把「上一份档案 + 之后的新对话」摘要成一份剧情档案，
// 存进 chat_summaries.dossier（同一份 schema 以后给鲸鱼娘观战的「观测档案」用）。
// 摘要失败什么都不改：旧的档案继续用，下一轮再试。
import { randomUUID } from 'node:crypto'
import { loadConfig } from '../chat/config'
import { completeChat } from '../chat/deepseek'
import { DEFAULT_MODEL } from '../chat/persona'
import { activePath } from './chatStore'
import { openTavernDb } from './db'
import { buildSummaryPrompt, hasContent, parseDossier, type Dossier } from './dossier'
import { loadMemorySettings } from './memorySettings'

type Row = Record<string, unknown>

export interface SummaryRecord {
  id: string
  chatId: string
  /** 原始 JSON 文本（用户在手账里编辑的就是它） */
  raw: string
  /** 解析后的档案；解析失败为 null */
  dossier: Dossier | null
  createdAt: number
}

const SUMMARY_TIMEOUT_MS = 45_000
/** 首次摘要（没有旧档案）最多喂这么多条，避免把几百轮全塞进去 */
const FIRST_SUMMARY_MESSAGES = 120

function toRecord(row: Row): SummaryRecord {
  const raw = String(row['dossier'] ?? '{}')
  return {
    id: String(row['id']),
    chatId: String(row['chat_id']),
    raw,
    dossier: parseDossier(raw),
    createdAt: Number(row['created_at'])
  }
}

/** 某场对话的档案，按时间倒序（最新的在最前）。 */
export function listSummaries(chatId: string): SummaryRecord[] {
  const rows = openTavernDb()
    .prepare('SELECT * FROM chat_summaries WHERE chat_id = ? ORDER BY created_at DESC')
    .all(chatId) as Row[]
  return rows.map(toRecord)
}

export function latestSummary(chatId: string): SummaryRecord | null {
  return listSummaries(chatId)[0] ?? null
}

/** 手账里改档案：必须是能解析的 JSON 对象，否则拒绝（旧的留着）。 */
export function updateSummary(id: string, raw: string): boolean {
  const dossier = parseDossier(raw)
  if (!dossier) return false
  openTavernDb()
    .prepare('UPDATE chat_summaries SET dossier = ? WHERE id = ?')
    .run(JSON.stringify(dossier), id)
  return true
}

export function deleteSummary(id: string): void {
  openTavernDb().prepare('DELETE FROM chat_summaries WHERE id = ?').run(id)
}

/** 正在摘要的会话（界面上显示「总结中」）。 */
const summarizing = new Set<string>()

export function isSummarizing(chatId: string): boolean {
  return summarizing.has(chatId)
}

/** 上一次摘要之后又长了多少条消息。 */
function messagesSince(chatId: string): number {
  const path = activePath(chatId)
  const last = latestSummary(chatId)
  if (!last) return path.length
  const row = openTavernDb()
    .prepare('SELECT to_message_id FROM chat_summaries WHERE id = ?')
    .get(last.id) as Row | undefined
  const anchor = row && row['to_message_id'] !== null ? String(row['to_message_id']) : null
  if (!anchor) return path.length
  const index = path.findIndex((item) => item.id === anchor)
  // 锚点被删了（分支切换 / 软删）：按「整场都算新的」处理，宁可多摘一次
  return index < 0 ? path.length : path.length - index - 1
}

/**
 * 到了间隔就后台摘要一次；没到 / 关着 / 正在摘要 / 没配 Key 都直接返回。
 * `onState` 用来通知界面「总结中」，摘要结束（无论成败）回调 false。
 */
export async function summarizeIfDue(
  chatId: string,
  onState?: (active: boolean) => void
): Promise<void> {
  const settings = loadMemorySettings()
  if (!settings.archiveEnabled) return
  const since = messagesSince(chatId)
  if (since < settings.summaryInterval) return
  await summarizeNow(chatId, onState, since)
}

/**
 * 立刻摘要一次（手账里的「立即总结」用，不看间隔）。
 * `since` 不传时按「上次档案之后的所有消息」算。
 */
export async function summarizeNow(
  chatId: string,
  onState?: (active: boolean) => void,
  since = messagesSince(chatId)
): Promise<void> {
  if (summarizing.has(chatId)) return
  const config = loadConfig()
  if (!config.apiKey) return

  const path = activePath(chatId)
  if (path.length === 0) return
  const last = latestSummary(chatId)
  // 有旧档案就只摘它之后的新消息；没有就给最近一段，别把几百轮全塞进去
  const wanted = since > 0 ? since : last ? 0 : FIRST_SUMMARY_MESSAGES
  const count = last ? wanted : Math.min(wanted, FIRST_SUMMARY_MESSAGES)
  const slice = path.slice(Math.max(0, path.length - count))
  if (slice.length === 0) return

  summarizing.add(chatId)
  onState?.(true)
  const now = new Date()
  const today = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
  const transcript = slice
    .map((item) => `${item.role === 'user' ? '用户' : '对方'}：${item.content}`)
    .join('\n\n')
  const previous = last?.dossier ? `旧档案：\n${JSON.stringify(last.dossier)}\n\n` : ''

  try {
    const raw = await completeChat({
      messages: [
        { role: 'system', content: buildSummaryPrompt(today) },
        { role: 'user', content: `${previous}新的对话：\n${transcript}` }
      ],
      apiKey: config.apiKey,
      model: DEFAULT_MODEL,
      temperature: 0.3,
      // 推理 token 也算预算：900 时模型想完就没了，content 是空串、档案永远攒不出来
      maxTokens: 2000,
      signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS)
    })
    const dossier = parseDossier(raw)
    if (!dossier || !hasContent(dossier)) {
      console.warn('[tavern/summary] 摘要结果为空或解析失败，保留旧档案')
      return
    }
    openTavernDb()
      .prepare(
        'INSERT INTO chat_summaries (id, chat_id, from_message_id, to_message_id, dossier, created_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        randomUUID(),
        chatId,
        slice[0]!.id,
        slice[slice.length - 1]!.id,
        JSON.stringify(dossier),
        Date.now()
      )
  } catch (error) {
    console.warn('[tavern/summary] 摘要失败，下一轮再试', error)
  } finally {
    summarizing.delete(chatId)
    onState?.(false)
  }
}
