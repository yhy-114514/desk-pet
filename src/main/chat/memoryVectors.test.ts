// 向量的持久化最容易「静默失效」：文件没写成 / 指纹对不上，表现只是检索退化成关键词，
// 界面上完全看不出来。这里用假 electron + 假 embedding 把整套读写走一遍。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryItem } from './memory'

const embedTexts = vi.fn()
let dir = ''

vi.mock('electron', () => ({ app: { getPath: () => dir } }))
vi.mock('./embedding', () => ({
  EMBEDDING_MODEL: 'test-model',
  embedTexts: (...args: unknown[]) => embedTexts(...args)
}))

type Module = typeof import('./memoryVectors')
let mod: Module

const item = (id: string, content: string): MemoryItem => ({
  id,
  type: 'other',
  content,
  createdAt: 0,
  updatedAt: 0
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'desk-pet-vectors-'))
  embedTexts.mockReset()
  // 每个测试一份新的模块状态（模块里缓存了向量表）
  embedTexts.mockImplementation(async (texts: string[]) => texts.map((text) => [text.length, 1]))
  vi.resetModules()
  mod = await import('./memoryVectors')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.resetModules()
})

describe('ensureVectors / vectorsFor', () => {
  it('补齐缺失向量并落盘，之后能按记忆取到', async () => {
    const items = [item('a', '用户喜欢喝冰红茶'), item('b', '用户养了一只橘猫')]
    await mod.ensureVectors(items, 'sk-test')

    expect(embedTexts).toHaveBeenCalledTimes(1)
    expect(embedTexts.mock.calls[0][0]).toEqual(['用户喜欢喝冰红茶', '用户养了一只橘猫'])
    expect(mod.vectorsFor(items).get('a')).toEqual([8, 1])

    const file = JSON.parse(readFileSync(mod.vectorPath(), 'utf-8')) as {
      model: string
      items: Record<string, unknown>
    }
    expect(file.model).toBe('test-model')
    expect(Object.keys(file.items)).toEqual(['a', 'b'])
  })

  it('已经补齐过的不再重复请求', async () => {
    const items = [item('a', '用户喜欢喝冰红茶')]
    await mod.ensureVectors(items, 'sk-test')
    embedTexts.mockClear()
    await mod.ensureVectors(items, 'sk-test')
    expect(embedTexts).not.toHaveBeenCalled()
  })

  it('索引途中手账改了内容：不会把新指纹配旧向量存下来', async () => {
    const items = [item('a', '用户喜欢喝冰红茶')]
    // 请求在途时手账把内容改了：向量是旧文本算的，指纹必须也是旧文本的
    embedTexts.mockImplementation(async (texts: string[]) => {
      items[0].content = '用户现在爱喝乌龙茶'
      return texts.map((text) => [text.length, 1])
    })
    await mod.ensureVectors(items, 'sk-test')
    // 指纹对不上 → 这条向量视为无效，下次补齐时重算
    expect(mod.vectorsFor(items).has('a')).toBe(false)

    embedTexts.mockImplementation(async (texts: string[]) => texts.map((text) => [text.length, 1]))
    await mod.ensureVectors(items, 'sk-test')
    expect(mod.vectorsFor(items).get('a')).toEqual([9, 1])
  })

  it('内容改过就重新向量化（指纹对不上）', async () => {
    const items = [item('a', '用户喜欢喝冰红茶')]
    await mod.ensureVectors(items, 'sk-test')

    const edited = [item('a', '用户喜欢喝无糖乌龙茶')]
    expect(mod.vectorsFor(edited).has('a')).toBe(false)
    await mod.ensureVectors(edited, 'sk-test')
    expect(embedTexts.mock.calls.at(-1)?.[0]).toEqual(['用户喜欢喝无糖乌龙茶'])
    expect(mod.vectorsFor(edited).get('a')).toEqual([10, 1])
  })

  it('记忆删掉后向量也跟着清掉，不留垃圾', async () => {
    const items = [item('a', '用户喜欢喝冰红茶'), item('b', '用户养了一只橘猫')]
    await mod.ensureVectors(items, 'sk-test')
    await mod.ensureVectors([items[0]], 'sk-test')

    const file = JSON.parse(readFileSync(mod.vectorPath(), 'utf-8')) as {
      items: Record<string, unknown>
    }
    expect(Object.keys(file.items)).toEqual(['a'])
  })

  it('接口失败不抛，只是这一轮没有向量', async () => {
    embedTexts.mockImplementation(async () => {
      throw new Error('向量化失败（401）')
    })
    const items = [item('a', '用户喜欢喝冰红茶')]
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(mod.ensureVectors(items, 'sk-test')).resolves.toBeUndefined()
    expect(mod.vectorsFor(items).size).toBe(0)
    spy.mockRestore()
  })
})

describe('embedQuery', () => {
  it('成功时返回查询向量', async () => {
    await expect(mod.embedQuery('想喝点凉的', 'sk-test')).resolves.toEqual([5, 1])
  })

  it('失败时返回 null，让调用方退回关键词检索', async () => {
    embedTexts.mockImplementation(async () => {
      throw new Error('向量化超时')
    })
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(mod.embedQuery('想喝点凉的', 'sk-test')).resolves.toBeNull()
    spy.mockRestore()
  })
})
