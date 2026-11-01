// 永久记忆：落库合并、手账改写/删除、发送前检索（无百炼 Key 时走关键词）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir = ''
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  protocol: { handle: (): void => {} }
}))

const fake = vi.hoisted(() => ({ apiKey: '', qwenKey: '' }))
vi.mock('../chat/config', () => ({
  loadConfig: (): { apiKey: string; qwenKey: string; model: string } => ({
    apiKey: fake.apiKey,
    qwenKey: fake.qwenKey,
    model: 'deepseek-flash'
  })
}))

const { closeTavernDb } = await import('./db')
const { saveCard } = await import('./cards')
const { deleteMemory, listMemories, retrieveMemoryContext, saveExtracted, updateMemory } =
  await import('./memoryStore')
const { saveMemorySettings } = await import('./memorySettings')

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
  dir = mkdtempSync(join(tmpdir(), 'tavern-memory-'))
  fake.apiKey = ''
  fake.qwenKey = ''
})

afterEach(() => {
  closeTavernDb()
  rmSync(dir, { recursive: true, force: true })
})

function newCard(name = '苏月珑'): string {
  return saveCard({ ...base, name, firstMes: '你来了。' })
}

describe('永久记忆', () => {
  it('抽取结果落库，近似重复的合并成一条（保留更长的表述）', () => {
    const characterId = newCard()
    saveExtracted(characterId, [{ type: 'preference', content: '用户喜欢喝冰红茶' }], 1000)
    saveExtracted(
      characterId,
      [
        { type: 'preference', content: '用户喜欢喝冰红茶。' },
        { type: 'event', content: '用户下周三要答辩' }
      ],
      2000
    )

    const items = listMemories(characterId)
    expect(items).toHaveLength(2)
    const drink = items.find((item) => item.content.includes('冰红茶'))!
    // 去重后只刷新时间，不会变成两条
    expect(drink.updatedAt).toBe(2000)
  })

  it('手账里改字 / 删条生效', () => {
    const characterId = newCard()
    saveExtracted(characterId, [{ type: 'fact', content: '用户养了一只猫' }], 1000)
    const [item] = listMemories(characterId)

    expect(updateMemory(item!.id, '用户养了一只橘猫')).toBe(true)
    expect(listMemories(characterId)[0]!.content).toBe('用户养了一只橘猫')
    expect(updateMemory(item!.id, '   ')).toBe(false)

    deleteMemory(item!.id)
    expect(listMemories(characterId)).toHaveLength(0)
  })

  it('记忆按角色隔离', () => {
    const first = newCard('苏月珑')
    const second = newCard('阿蕾')
    saveExtracted(first, [{ type: 'other', content: '用户怕冷' }], 1000)
    expect(listMemories(second)).toHaveLength(0)
  })

  it('没有百炼 Key 时检索走关键词；关掉永久记忆就不返回', async () => {
    const characterId = newCard()
    saveExtracted(
      characterId,
      [
        { type: 'event', content: '用户下周三要去答辩' },
        { type: 'preference', content: '用户喜欢冰红茶' }
      ],
      1000
    )

    const hit = await retrieveMemoryContext(characterId, '答辩的事我有点慌')
    expect(hit).toContain('答辩')
    expect(hit).not.toContain('冰红茶')

    // 新话题不硬塞旧记忆
    expect(await retrieveMemoryContext(characterId, '今天天气不错')).toBe('')

    saveMemorySettings({ permanentEnabled: false })
    expect(await retrieveMemoryContext(characterId, '答辩')).toBe('')
  })
})
