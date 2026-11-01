// 酒馆记忆三层的设置：存在通用 settings 表里（key = 'memory'），全局一份。
// 三层各自独立开关——关掉任意一层，其余照常工作。
import { openTavernDb } from './db'

export interface MemorySettings {
  /** 永久记忆：每轮后抽取、发送前检索注入 */
  permanentEnabled: boolean
  /** 记忆强度：注入记忆的条数上限 */
  memoryStrength: number
  /** 检索范围：拿最近几条消息连同本轮输入一起做检索 */
  memoryRange: number
  /** 忆境典藏：每 N 条消息后台摘要成剧情档案 */
  archiveEnabled: boolean
  /** 总结间隔（层）：累计多少条新消息触发一次摘要 */
  summaryInterval: number
  /** 回忆视界：限制带进上下文的历史条数 */
  visionEnabled: boolean
  /** 视界深度（条）：最近多少条消息原样带上 */
  visionDepth: number
  /** 完整视界：不裁剪最近消息，整段带上（提示会增加消耗） */
  fullVision: boolean
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  permanentEnabled: true,
  memoryStrength: 8,
  memoryRange: 2,
  archiveEnabled: true,
  summaryInterval: 40,
  visionEnabled: true,
  visionDepth: 60,
  fullVision: false
}

const SETTING_KEY = 'memory'

/** 数值一律夹到合法区间：滑块之外的写入（手改库、旧版本）不能让逻辑跑飞。 */
function num(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function loadMemorySettings(): MemorySettings {
  let raw: Record<string, unknown> = {}
  try {
    const row = openTavernDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTING_KEY) as { value?: unknown } | undefined
    if (row && typeof row.value === 'string') {
      const parsed: unknown = JSON.parse(row.value)
      if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>
    }
  } catch {
    // 库还没建好 / 值坏了：用默认值，别让设置拖垮聊天
    return { ...DEFAULT_MEMORY_SETTINGS }
  }
  const fallback = DEFAULT_MEMORY_SETTINGS
  return {
    permanentEnabled: bool(raw['permanentEnabled'], fallback.permanentEnabled),
    memoryStrength: num(raw['memoryStrength'], 5, 50, fallback.memoryStrength),
    memoryRange: num(raw['memoryRange'], 1, 3, fallback.memoryRange),
    archiveEnabled: bool(raw['archiveEnabled'], fallback.archiveEnabled),
    summaryInterval: num(raw['summaryInterval'], 20, 100, fallback.summaryInterval),
    visionEnabled: bool(raw['visionEnabled'], fallback.visionEnabled),
    visionDepth: num(raw['visionDepth'], 20, 120, fallback.visionDepth),
    fullVision: bool(raw['fullVision'], fallback.fullVision)
  }
}

export function saveMemorySettings(patch: Partial<MemorySettings>): MemorySettings {
  const merged = loadMemorySettings()
  for (const key of Object.keys(patch) as (keyof MemorySettings)[]) {
    const value = patch[key]
    if (value !== undefined) (merged[key] as unknown) = value
  }
  const normalized = { ...merged }
  normalized.memoryStrength = num(normalized.memoryStrength, 5, 50, DEFAULT_MEMORY_SETTINGS.memoryStrength)
  normalized.memoryRange = num(normalized.memoryRange, 1, 3, DEFAULT_MEMORY_SETTINGS.memoryRange)
  normalized.summaryInterval = num(normalized.summaryInterval, 20, 100, DEFAULT_MEMORY_SETTINGS.summaryInterval)
  normalized.visionDepth = num(normalized.visionDepth, 20, 120, DEFAULT_MEMORY_SETTINGS.visionDepth)
  openTavernDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(SETTING_KEY, JSON.stringify(normalized))
  return normalized
}
