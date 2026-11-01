// 忆境典藏：到间隔才摘要、摘要结果落库、失败保留旧档案。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir = ''
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  protocol: { handle: (): void => {} }
}))

const fake = vi.hoisted(() => ({
  apiKey: 'sk-test',
  reply: '{"world_brief":"仙洲","scene_now":"练剑场","key_events":["拜师"],"open_threads":["断水剑"],"char_relations":[],"tone":"古风","card_name":"苏月珑","player_character":"外门弟子","updated_at":"2026-10-25"}',
  fail: false,
  calls: 0
}))
vi.mock('../chat/config', () => ({
  loadConfig: (): { apiKey: string; qwenKey: string; model: string } => ({
    apiKey: fake.apiKey,
    qwenKey: '',
    model: 'deepseek-flash'
  })
}))
vi.mock('../chat/deepseek', () => ({
  completeChat: async (): Promise<string> => {
    fake.calls++
    if (fake.fail) throw new Error('网络断了')
    return fake.reply
  }
}))

const { closeTavernDb } = await import('./db')
const { saveCard } = await import('./cards')
const { activeLeafId, appendMessage, createChat } = await import('./chatStore')
const { saveMemorySettings } = await import('./memorySettings')
const { listSummaries, summarizeIfDue } = await import('./summaryStore')

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
  dir = mkdtempSync(join(tmpdir(), 'tavern-summary-'))
  fake.apiKey = 'sk-test'
  fake.fail = false
  fake.calls = 0
  // 间隔调到允许的最小值，测试里不用造上百条消息
  saveMemorySettings({ summaryInterval: 20 })
})

afterEach(() => {
  closeTavernDb()
  rmSync(dir, { recursive: true, force: true })
})

/** 造一场有 count 条消息的对话（含开场白） */
function chatWith(count: number): string {
  const cardId = saveCard({ ...base, name: '苏月珑', firstMes: '你来了。' })
  const chat = createChat(cardId, () => 0)
  let parent = activeLeafId(chat.id)
  for (let i = 1; i < count; i++) {
    parent = appendMessage(chat.id, parent, i % 2 === 1 ? 'user' : 'assistant', `第${i}句`)
  }
  return chat.id
}

describe('忆境典藏', () => {
  it('没到总结间隔不动手', async () => {
    const chatId = chatWith(10)
    await summarizeIfDue(chatId)
    expect(fake.calls).toBe(0)
    expect(listSummaries(chatId)).toHaveLength(0)
  })

  it('到间隔后摘要一次，档案解析正确', async () => {
    const chatId = chatWith(25)
    await summarizeIfDue(chatId)

    const [record] = listSummaries(chatId)
    expect(record).toBeDefined()
    expect(record!.dossier?.key_events).toEqual(['拜师'])
    expect(record!.dossier?.open_threads).toEqual(['断水剑'])
  })

  it('摘要失败不落库，也不抛给调用方', async () => {
    const chatId = chatWith(25)
    fake.fail = true
    await expect(summarizeIfDue(chatId)).resolves.toBeUndefined()
    expect(listSummaries(chatId)).toHaveLength(0)
  })

  it('关掉忆境典藏就不摘要', async () => {
    saveMemorySettings({ archiveEnabled: false })
    const chatId = chatWith(25)
    await summarizeIfDue(chatId)
    expect(fake.calls).toBe(0)
  })
})
