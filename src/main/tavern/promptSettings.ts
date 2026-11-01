// T4 的全局设置：文风、世界书预算 / 扫描深度、回复篇幅、心动接话、状态栏与变量系统开关。
// 与 memorySettings 一样存 settings 表的单个键，读的时候一律夹回合法区间。
import { openTavernDb } from './db'

type Row = Record<string, unknown>

const SETTING_KEY = 'prompt'
const STYLE_KEY = 'prompt.styles'

export interface PromptSettings {
  /** 内置 / 自定义文风的 id，'' = 不加文风指令 */
  styleId: string
  /** 关键词触发的世界书条目总预算（常驻不计） */
  loreBudget: number
  /** 世界书扫描最近几条历史 */
  scanDepth: number
  /** 御言篇幅：最少 / 最多字数，0 = 不限制 */
  replyMinChars: number
  replyMaxChars: number
  /** 心动接话：每轮生成几条可选回复，0 = 关 */
  altCount: number
  /** 回复开头/末尾的动态状态条是否显示 */
  statusEnabled: boolean
  /** 把当前变量状态注入提示词（让模型别忘了设定） */
  statusInPrompt: boolean
  /**
   * 变量系统（MVU）：解析 `<update>` 更新块并落库。
   * 默认开——成品卡的状态栏页面就是照变量画的，不应用更新的话面板永远是开场那一份。
   */
  mvuEnabled: boolean
}

export const DEFAULT_PROMPT_SETTINGS: PromptSettings = {
  styleId: '',
  loreBudget: 1500,
  scanDepth: 6,
  replyMinChars: 0,
  replyMaxChars: 0,
  altCount: 0,
  statusEnabled: true,
  statusInPrompt: false,
  mvuEnabled: true
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function readSetting(key: string): Record<string, unknown> {
  const row = openTavernDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | Row
    | undefined
  if (!row) return {}
  try {
    const parsed: unknown = JSON.parse(String(row['value']))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeSetting(key: string, value: unknown): void {
  openTavernDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value))
}

export function loadPromptSettings(): PromptSettings {
  const raw = readSetting(SETTING_KEY)
  return {
    styleId: typeof raw['styleId'] === 'string' ? raw['styleId'] : DEFAULT_PROMPT_SETTINGS.styleId,
    loreBudget: clampInt(raw['loreBudget'], DEFAULT_PROMPT_SETTINGS.loreBudget, 200, 30000),
    scanDepth: clampInt(raw['scanDepth'], DEFAULT_PROMPT_SETTINGS.scanDepth, 1, 40),
    replyMinChars: clampInt(raw['replyMinChars'], DEFAULT_PROMPT_SETTINGS.replyMinChars, 0, 5000),
    replyMaxChars: clampInt(raw['replyMaxChars'], DEFAULT_PROMPT_SETTINGS.replyMaxChars, 0, 20000),
    altCount: clampInt(raw['altCount'], DEFAULT_PROMPT_SETTINGS.altCount, 0, 5),
    statusEnabled: raw['statusEnabled'] !== false,
    statusInPrompt: raw['statusInPrompt'] === true,
    mvuEnabled: raw['mvuEnabled'] !== false
  }
}

export function savePromptSettings(patch: Partial<PromptSettings>): PromptSettings {
  const next = { ...loadPromptSettings(), ...patch }
  const clean: PromptSettings = {
    styleId: typeof next.styleId === 'string' ? next.styleId : '',
    loreBudget: clampInt(next.loreBudget, 1500, 200, 30000),
    scanDepth: clampInt(next.scanDepth, 6, 1, 40),
    replyMinChars: clampInt(next.replyMinChars, 0, 0, 5000),
    replyMaxChars: clampInt(next.replyMaxChars, 0, 0, 20000),
    altCount: clampInt(next.altCount, 0, 0, 5),
    statusEnabled: next.statusEnabled !== false,
    statusInPrompt: next.statusInPrompt === true,
    mvuEnabled: next.mvuEnabled !== false
  }
  // 最多不超过：两个都填了且最小值比最大值还大时，以最小值为准
  if (clean.replyMaxChars > 0 && clean.replyMinChars > clean.replyMaxChars) {
    clean.replyMaxChars = clean.replyMinChars
  }
  writeSetting(SETTING_KEY, clean)
  return clean
}

// ── 文风 ──────────────────────────────────────────────────────────────

export interface StylePreset {
  id: string
  name: string
  content: string
  builtin: boolean
}

/**
 * 内置文风。只写「怎么写」的指令，不写剧情——剧情是卡的事。
 * 三段都要避开「现代网络用语」，否则切过去用户看不出区别。
 */
export const BUILTIN_STYLES: StylePreset[] = [
  {
    id: 'classical',
    name: '中国古典小说',
    content:
      '【文风】请用中国古典小说的笔法叙述：句子短而留白，多用白描与对偶，少用现代口语与网络词汇；' +
      '人物对白简洁有分寸，环境描写点到为止。不要写成文言文，要让现代读者读得顺畅。',
    builtin: true
  },
  {
    id: 'light',
    name: '轻小说',
    content:
      '【文风】请用轻小说的笔法叙述：节奏轻快，心理描写细腻，适当使用短句与拟声词；' +
      '对话自然活泼，可以有轻微的吐槽感，但不要跳戏成旁白解说。',
    builtin: true
  },
  {
    id: 'literary',
    name: '文艺细腻',
    content:
      '【文风】请用细腻的文学笔法叙述：重视感官细节与情绪流动，善用比喻，但克制、不堆砌；' +
      '段落之间有呼吸感，避免流水账式的动作罗列。',
    builtin: true
  }
]

interface StoredStyle {
  id: string
  name: string
  content: string
}

export function listStyles(): StylePreset[] {
  const raw = readSetting(STYLE_KEY)['items']
  const custom: StylePreset[] = Array.isArray(raw)
    ? raw
        .filter((item): item is StoredStyle => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          id: String(item.id),
          name: String(item.name),
          content: String(item.content),
          builtin: false
        }))
    : []
  return [...BUILTIN_STYLES, ...custom]
}

export function addStyle(name: string, content: string): string {
  const items = listStyles()
    .filter((style) => !style.builtin)
    .map((style) => ({ id: style.id, name: style.name, content: style.content }))
  const id = `custom-${Date.now().toString(36)}`
  items.push({ id, name: name.trim() || '自定义文风', content })
  writeSetting(STYLE_KEY, { items })
  return id
}

export function deleteStyle(id: string): void {
  const items = listStyles()
    .filter((style) => !style.builtin && style.id !== id)
    .map((style) => ({ id: style.id, name: style.name, content: style.content }))
  writeSetting(STYLE_KEY, { items })
  // 删掉的正好是当前选中的，退回「不加文风」
  if (loadPromptSettings().styleId === id) savePromptSettings({ styleId: '' })
}

/** 当前选中的文风指令文本；没选 / 找不到就是空串。 */
export function resolveStyleText(settings: PromptSettings): string {
  if (!settings.styleId) return ''
  return listStyles().find((style) => style.id === settings.styleId)?.content ?? ''
}
