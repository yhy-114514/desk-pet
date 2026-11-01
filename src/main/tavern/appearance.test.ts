// 外观与通用设置：默认值、深合并、数值 / 颜色夹取、媒体文件名白名单。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir = ''
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  protocol: { handle: (): void => {} }
}))

const { closeTavernDb } = await import('./db')
const {
  DEFAULT_APPEARANCE,
  isMediaFileName,
  loadAppearance,
  parseColor,
  sanitizeAppearance,
  saveAppearance
} = await import('./appearance')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tavern-appearance-'))
})

afterEach(() => {
  closeTavernDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('默认值', () => {
  it('没存过时与默认值一致，朗读默认关、音乐默认关', () => {
    const settings = loadAppearance()
    expect(settings).toEqual(DEFAULT_APPEARANCE)
    expect(settings.ttsEnabled).toBe(false)
    expect(settings.bgm.enabled).toBe(false)
    expect(settings.theme).toBe('dark')
  })
})

describe('保存与深合并', () => {
  it('只改气泡的透明度，其余项保持', () => {
    saveAppearance({ bubble: { ...DEFAULT_APPEARANCE.bubble, opacity: 0.5 } })
    const settings = loadAppearance()
    expect(settings.bubble.opacity).toBe(0.5)
    expect(settings.bubble.fontSize).toBe(DEFAULT_APPEARANCE.bubble.fontSize)
    expect(settings.background).toEqual(DEFAULT_APPEARANCE.background)
  })

  it('背景的深合并不会冲掉没传的字段', () => {
    saveAppearance({ background: { mode: 'custom', image: 'a.png', dim: 20 } })
    saveAppearance({ background: { mode: 'cover', image: null, dim: 20 } })
    const settings = loadAppearance()
    expect(settings.background.mode).toBe('cover')
    expect(settings.background.dim).toBe(20)
  })

  it('主题 / 字体只认白名单取值', () => {
    saveAppearance({ theme: 'light' })
    expect(loadAppearance().theme).toBe('light')
  })
})

describe('夹取', () => {
  it('不透明度 / 音量 / 字号越界被夹回区间', () => {
    const settings = sanitizeAppearance({
      bubble: { opacity: 5, fontSize: 99 },
      bgm: { volume: -1 }
    })
    expect(settings.bubble.opacity).toBe(1)
    expect(settings.bubble.fontSize).toBe(22)
    expect(settings.bgm.volume).toBe(0)
  })

  it('未知的主题 / 背景模式回落到默认', () => {
    const settings = sanitizeAppearance({ theme: 'neon', background: { mode: 'video' } })
    expect(settings.theme).toBe('dark')
    expect(settings.background.mode).toBe('default')
  })

  it('颜色只认 #rgb / #rrggbb，非法值保留默认', () => {
    expect(parseColor('#ABC')).toBe('#aabbcc')
    expect(parseColor('#A1B2C3')).toBe('#a1b2c3')
    expect(parseColor('red')).toBeNull()
    const settings = sanitizeAppearance({ bubble: { narrationColor: 'red' } })
    expect(settings.bubble.narrationColor).toBe(DEFAULT_APPEARANCE.bubble.narrationColor)
  })
})

describe('媒体文件白名单', () => {
  it('uuid + 扩展名 才收', () => {
    expect(isMediaFileName('3f2b1c4d-1111-4222-8333-444455556666.png')).toBe(true)
    expect(isMediaFileName('3f2b1c4d-1111-4222-8333-444455556666.mp3', 'audio')).toBe(true)
  })

  it('路径穿越 / 错扩展名 / 错类别都拒', () => {
    expect(isMediaFileName('../evil.png')).toBe(false)
    expect(isMediaFileName('3f2b1c4d-1111-4222-8333-444455556666.exe', 'image')).toBe(false)
    expect(isMediaFileName('3f2b1c4d-1111-4222-8333-444455556666.png', 'audio')).toBe(false)
  })
})
