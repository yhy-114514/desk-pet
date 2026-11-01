// T5 的外观与通用设置：主题 / 字体 / 聊天背景 / 三色与气泡 / 朗读开关 / 背景音乐。
// 与 promptSettings 一样存 settings 表的单个键，读的时候一律夹回合法区间——
// 手改库或旧版本写进去的值不能让界面逻辑跑飞。
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'
import { openTavernDb } from './db'

const SETTING_KEY = 'appearance'

/** 用户自选的背景图 / 音乐放在这里，文件走 tavern-media:// 协议给界面读 */
export function mediaDir(): string {
  return join(app.getPath('userData'), 'tavern', 'media')
}

export function mediaFilePath(name: string): string {
  return join(mediaDir(), name)
}

export type ThemeMode = 'dark' | 'light'
export type FontMode = 'system' | 'round'
export type BackgroundMode = 'default' | 'cover' | 'custom'

export interface AppearanceSettings {
  /** 深海夜航（深）/ 浅海晨光（浅） */
  theme: ThemeMode
  /** 字体：系统默认 / 圆体（系统字体栈，不打包字体文件） */
  font: FontMode
  background: {
    /** 默认渐变 / 跟随角色立绘 / 自定义图片 */
    mode: BackgroundMode
    /** 自定义图片在 media/ 下的文件名 */
    image: string | null
    /** 背景遮罩浓度（%），保证字看得清 */
    dim: number
  }
  bubble: {
    /** 用户气泡背景不透明度 0.2–1 */
    opacity: number
    /** 小说流正文字号 */
    fontSize: number
    /** 旁白 / 对话（引号内）/ 动作（括号内）三色，与 colorParser 共用 */
    narrationColor: string
    dialogueColor: string
    actionColor: string
  }
  /** 酒馆回复朗读（默认关，复用桌宠那套 TTS） */
  ttsEnabled: boolean
  bgm: {
    enabled: boolean
    /** 0–1 */
    volume: number
    /** 曲目在 media/ 下的文件名 */
    track: string | null
  }
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'dark',
  font: 'system',
  background: { mode: 'default', image: null, dim: 45 },
  bubble: {
    opacity: 0.85,
    fontSize: 14,
    narrationColor: '#dce8f7',
    dialogueColor: '#ffc6ce',
    actionColor: '#9fd8e8'
  },
  ttsEnabled: false,
  bgm: { enabled: false, volume: 0.5, track: null }
}

/** 图片与音频两种可选的媒体类型 */
export type MediaKind = 'image' | 'audio'

const MEDIA_EXTENSIONS: Record<MediaKind, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
  audio: ['mp3', 'ogg', 'wav', 'm4a', 'flac']
}

function clampNumber(value: unknown, fallback: number, min: number, max: number, step = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  // 按步长取整：手改出来的 0.7331 音量在界面上没有意义
  const snapped = Math.round(value / step) * step
  return Math.min(max, Math.max(min, Number(snapped.toFixed(3))))
}

/** 颜色只收 #rgb / #rrggbb，统一成 6 位小写；别的值给 null */
export function parseColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(raw)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  return /^#[0-9a-f]{6}$/.test(raw) ? raw : null
}

function normalizeColor(value: unknown, fallback: string): string {
  return parseColor(value) ?? fallback
}

/** media/ 下的文件名只认我们自己生成的 uuid + 白名单扩展名 */
export function isMediaFileName(name: unknown, kind?: MediaKind): name is string {
  if (typeof name !== 'string') return false
  const match = /^[a-z0-9-]+\.([a-z0-9]+)$/i.exec(name)
  if (!match) return false
  if (!kind) return true
  return MEDIA_EXTENSIONS[kind].includes(match[1].toLowerCase())
}

function mediaName(value: unknown, kind: MediaKind): string | null {
  return isMediaFileName(value, kind) ? value : null
}

function readSetting(): Record<string, unknown> {
  const row = openTavernDb().prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY) as
    | Record<string, unknown>
    | undefined
  if (!row) return {}
  try {
    const parsed: unknown = JSON.parse(String(row['value']))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeSetting(value: unknown): void {
  openTavernDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(SETTING_KEY, JSON.stringify(value))
}

function group(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = raw[key]
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** 任意输入 → 合法设置。写库与读库都走这里，保证形状只有一种 */
export function sanitizeAppearance(raw: Record<string, unknown>): AppearanceSettings {
  const background = group(raw, 'background')
  const bubble = group(raw, 'bubble')
  const bgm = group(raw, 'bgm')
  const mode = background['mode']
  const font = raw['font']
  return {
    theme: raw['theme'] === 'light' ? 'light' : 'dark',
    font: font === 'round' ? 'round' : 'system',
    background: {
      mode: mode === 'cover' || mode === 'custom' ? mode : 'default',
      image: mediaName(background['image'], 'image'),
      dim: clampNumber(background['dim'], DEFAULT_APPEARANCE.background.dim, 0, 90)
    },
    bubble: {
      opacity: clampNumber(bubble['opacity'], DEFAULT_APPEARANCE.bubble.opacity, 0.2, 1, 0.05),
      fontSize: clampNumber(bubble['fontSize'], DEFAULT_APPEARANCE.bubble.fontSize, 12, 22),
      narrationColor: normalizeColor(
        bubble['narrationColor'],
        DEFAULT_APPEARANCE.bubble.narrationColor
      ),
      dialogueColor: normalizeColor(bubble['dialogueColor'], DEFAULT_APPEARANCE.bubble.dialogueColor),
      actionColor: normalizeColor(bubble['actionColor'], DEFAULT_APPEARANCE.bubble.actionColor)
    },
    ttsEnabled: raw['ttsEnabled'] === true,
    bgm: {
      enabled: bgm['enabled'] === true,
      volume: clampNumber(bgm['volume'], DEFAULT_APPEARANCE.bgm.volume, 0, 1, 0.05),
      track: mediaName(bgm['track'], 'audio')
    }
  }
}

export function loadAppearance(): AppearanceSettings {
  return sanitizeAppearance(readSetting())
}

/** 深合并：界面每次只改一个开关，不该把其它分组冲掉 */
export function saveAppearance(patch: Partial<AppearanceSettings>): AppearanceSettings {
  const current = loadAppearance()
  const next = {
    ...current,
    ...patch,
    background: { ...current.background, ...(patch.background ?? {}) },
    bubble: { ...current.bubble, ...(patch.bubble ?? {}) },
    bgm: { ...current.bgm, ...(patch.bgm ?? {}) }
  }
  const clean = sanitizeAppearance(next as unknown as Record<string, unknown>)
  writeSetting(clean)
  return clean
}

/**
 * 把用户选的图片 / 音频拷进 media/，返回新文件名。
 * 用 uuid 命名：原文件名可能带空格、中文、重名，也会泄露用户的目录结构。
 */
export function saveMedia(sourcePath: string, kind: MediaKind): string {
  const ext = extname(sourcePath).slice(1).toLowerCase()
  if (!MEDIA_EXTENSIONS[kind].includes(ext)) throw new Error(`不支持的${kind === 'image' ? '图片' : '音频'}格式：${ext}`)
  const dir = mediaDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const name = `${randomUUID()}.${ext}`
  copyFileSync(sourcePath, mediaFilePath(name))
  return name
}

/** 只删 media/ 下合法命名的文件；路径穿越 / 任意文件名一律拒绝 */
export function removeMedia(name: string): void {
  if (!isMediaFileName(name)) return
  const file = mediaFilePath(name)
  if (existsSync(file)) rmSync(file, { force: true })
}
