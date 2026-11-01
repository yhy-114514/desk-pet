// 首次引导的一次性记号：默认没走过、写一次之后记得住、卡片数决定要不要弹。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir = ''
vi.mock('electron', () => ({ app: { getPath: () => dir }, protocol: { handle: (): void => {} } }))

const { closeTavernDb } = await import('./db')
const { saveCard } = await import('./cards')
const { getOnboardingState, setOnboardingFlags } = await import('./onboarding')

const base = {
  name: '',
  description: '',
  personality: '',
  scenario: '',
  firstMes: '',
  alternateGreetings: [],
  mesExample: '',
  systemPrompt: '',
  postHistoryInstructions: '',
  creator: '',
  creatorNotes: '',
  tags: [],
  avatarPath: null
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tavern-onboarding-'))
})

afterEach(() => {
  closeTavernDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('首次启动引导', () => {
  it('新库默认没走过引导', () => {
    expect(getOnboardingState()).toEqual({ firstRunDone: false, greetShown: false, cardCount: 0 })
  })

  it('写过记号后会记住，且不影响另一个记号', () => {
    setOnboardingFlags({ firstRunDone: true })
    expect(getOnboardingState().firstRunDone).toBe(true)
    expect(getOnboardingState().greetShown).toBe(false)

    setOnboardingFlags({ greetShown: true })
    const state = getOnboardingState()
    expect(state.firstRunDone).toBe(true)
    expect(state.greetShown).toBe(true)

    closeTavernDb() // 重启后仍然记得
    expect(getOnboardingState().greetShown).toBe(true)
  })

  it('已有角色卡时数得出来（界面据此不弹引导）', () => {
    saveCard({ ...base, name: '阿蕾' })
    expect(getOnboardingState().cardCount).toBe(1)
  })
})
