import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBEDDING_BATCH, EMBEDDING_MODEL, embedTexts } from './embedding'

interface FetchCall {
  url: string
  init?: RequestInit
}

const calls: FetchCall[] = []
const fetchMock = vi.fn()

function body(index = 0): { model: string; input: string[]; encoding_format: string } {
  return JSON.parse(String(calls[index].init?.body))
}

/** 第 i 条文本的向量：用序号做第一个分量，方便断言顺序 */
function vectorFor(text: string, dim = 3): number[] {
  const n = Number(text.replace(/[^\d]/g, '') || 0)
  return Array.from({ length: dim }, (_, i) => (i === 0 ? n : 0.5))
}

beforeEach(() => {
  calls.length = 0
  fetchMock.mockReset()
  vi.stubGlobal(
    'fetch',
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const input = JSON.parse(String(init?.body)).input as string[]
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: input.map((text, i) => ({ index: i, embedding: vectorFor(text) })) })
      }
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('embedTexts', () => {
  it('走兼容模式端点，模型与输入都在请求体里', async () => {
    await embedTexts(['用户喜欢喝冰红茶'], 'sk-test')
    expect(calls[0].url).toContain('/compatible-mode/v1/embeddings')
    expect(body().model).toBe(EMBEDDING_MODEL)
    expect(body().input).toEqual(['用户喜欢喝冰红茶'])
  })

  it(`超过 ${EMBEDDING_BATCH} 条时分块请求，结果仍按原顺序拼回来`, async () => {
    const texts = Array.from({ length: EMBEDDING_BATCH + 2 }, (_, i) => `文本${i}`)
    const vectors = await embedTexts(texts, 'sk-test')

    expect(calls).toHaveLength(2)
    expect(body(0).input).toHaveLength(EMBEDDING_BATCH)
    expect(body(1).input).toHaveLength(2)
    expect(vectors).toHaveLength(texts.length)
    expect(vectors.map((v) => v[0])).toEqual(texts.map((t) => Number(t.replace(/[^\d]/g, ''))))
  })

  it('返回的 data 顺序被打乱时按 index 排回来', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)).input as string[]
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { index: 2, embedding: vectorFor(input[2]) },
            { index: 0, embedding: vectorFor(input[0]) },
            { index: 1, embedding: vectorFor(input[1]) }
          ]
        })
      }
    })
    const vectors = await embedTexts(['文本0', '文本1', '文本2'], 'sk-test')
    expect(vectors.map((v) => v[0])).toEqual([0, 1, 2])
  })

  it('部分行缺 index 时报错：宁可退回关键词，也不把向量错配给别的记忆', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)).input as string[]
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ index: 1, embedding: vectorFor(input[1]) }, { embedding: vectorFor(input[0]) }]
        })
      }
    })
    await expect(embedTexts(['文本0', '文本1'], 'sk-test')).rejects.toThrow(/缺少序号/)
  })

  it('一行 index 都没给时按返回顺序使用（OpenAI 兼容实现的约定）', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)).input as string[]
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: input.map((text) => ({ embedding: vectorFor(text) })) })
      }
    })
    const vectors = await embedTexts(['文本0', '文本1'], 'sk-test')
    expect(vectors.map((v) => v[0])).toEqual([0, 1])
  })

  it('返回条数不对时报错，不把错位的数据当向量', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ index: 0, embedding: [1, 2, 3] }] })
    }))
    await expect(embedTexts(['a', 'b'], 'sk-test')).rejects.toThrow(/条数不对/)
  })

  it('接口报错时带上状态码与原文', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"message":"batch size is invalid"}'
    }))
    await expect(embedTexts(['a'], 'sk-test')).rejects.toThrow(/400/)
    await expect(embedTexts(['a'], 'sk-test')).rejects.toThrow(/batch size is invalid/)
  })

  it('没有文本时不发请求', async () => {
    await expect(embedTexts([], 'sk-test')).resolves.toEqual([])
    expect(calls).toHaveLength(0)
  })
})
