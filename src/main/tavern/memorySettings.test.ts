// 记忆设置：默认值、越界钳制、持久化。
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
const { DEFAULT_MEMORY_SETTINGS, loadMemorySettings, saveMemorySettings } = await import(
  './memorySettings'
)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tavern-memset-'))
})

afterEach(() => {
  closeTavernDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('记忆设置', () => {
  it('没存过时是默认值', () => {
    expect(loadMemorySettings()).toEqual(DEFAULT_MEMORY_SETTINGS)
  })

  it('只改传进来的项，其余保持', () => {
    saveMemorySettings({ permanentEnabled: false })
    const settings = loadMemorySettings()
    expect(settings.permanentEnabled).toBe(false)
    expect(settings.summaryInterval).toBe(DEFAULT_MEMORY_SETTINGS.summaryInterval)
  })

  it('越界的滑块值被夹回区间', () => {
    saveMemorySettings({ memoryStrength: 999, memoryRange: 0, visionDepth: 1 })
    const settings = loadMemorySettings()
    expect(settings.memoryStrength).toBe(50)
    expect(settings.memoryRange).toBe(1)
    expect(settings.visionDepth).toBe(20)
  })

  it('重开连接后仍然读得到', () => {
    saveMemorySettings({ fullVision: true, visionDepth: 88 })
    closeTavernDb()
    const settings = loadMemorySettings()
    expect(settings.fullVision).toBe(true)
    expect(settings.visionDepth).toBe(88)
  })
})
