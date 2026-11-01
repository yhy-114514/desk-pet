import { describe, expect, it } from 'vitest'
import {
  MEMORY_MAX_ITEMS,
  MIN_SEMANTIC_SIMILARITY,
  buildExtractionPrompt,
  consolidateMemories,
  cosineSimilarity,
  formatMemoryContext,
  mergeMemories,
  normalizeType,
  parseExtraction,
  searchMemories,
  searchMemoriesByVector,
  type MemoryItem
} from './memory'

const item = (id: string, content: string, updatedAt = 0): MemoryItem => ({
  id,
  type: 'other',
  content,
  createdAt: updatedAt,
  updatedAt
})

describe('buildExtractionPrompt', () => {
  it('注入当前日期并要求相对时间换算成绝对日期', () => {
    const prompt = buildExtractionPrompt('2026年10月23日')
    expect(prompt).toContain('当前日期：2026年10月23日')
    expect(prompt).toContain('换算成具体日期')
    expect(prompt).toContain('JSON 数组')
  })
})

describe('parseExtraction', () => {
  it('解析标准 JSON 数组', () => {
    const raw = JSON.stringify([
      { type: 'preference', content: '用户喜欢喝美式咖啡' },
      { type: 'event', content: '用户十月二十五日要去答辩' }
    ])
    expect(parseExtraction(raw)).toEqual([
      { type: 'preference', content: '用户喜欢喝美式咖啡' },
      { type: 'event', content: '用户十月二十五日要去答辩' }
    ])
  })

  it('容忍 markdown 围栏和前后说明文字', () => {
    const raw = '好的，抽取结果如下：\n```json\n[{"type":"promise","content":"用户答应周末一起看电影"}]\n```'
    expect(parseExtraction(raw)).toEqual([
      { type: 'promise', content: '用户答应周末一起看电影' }
    ])
  })

  it('未知 type 归为 other，短内容被丢弃', () => {
    const raw = JSON.stringify([
      { type: 'weird', content: '用户养了一只猫' },
      { type: 'preference', content: '嗯' }
    ])
    expect(parseExtraction(raw)).toEqual([{ type: 'other', content: '用户养了一只猫' }])
  })

  it('坏 JSON / 非数组 / 空串返回空数组', () => {
    expect(parseExtraction('')).toEqual([])
    expect(parseExtraction('不是 JSON')).toEqual([])
    expect(parseExtraction('[oops')).toEqual([])
    expect(parseExtraction('{"a":1}')).toEqual([])
  })
})

describe('mergeMemories', () => {
  it('新增不重复的记忆', () => {
    const { items, added } = mergeMemories([], [{ type: 'preference', content: '用户喜欢猫' }], 100, () => 'id-1')
    expect(added).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'id-1', type: 'preference', content: '用户喜欢猫', updatedAt: 100 })
  })

  it('相同内容只刷新更新时间，不重复新增', () => {
    const existing = [item('a', '用户喜欢猫', 10)]
    const { items, added } = mergeMemories(existing, [{ type: 'preference', content: '用户喜欢猫' }], 200)
    expect(added).toHaveLength(0)
    expect(items).toHaveLength(1)
    expect(items[0].updatedAt).toBe(200)
  })

  it('一条包含另一条视为重复，保留更完整的表述', () => {
    const existing = [item('a', '用户喜欢喝美式咖啡', 10)]
    const { items, added } = mergeMemories(
      existing,
      [{ type: 'preference', content: '用户喜欢喝美式咖啡，每天早上一杯' }],
      200
    )
    expect(added).toHaveLength(0)
    expect(items[0].content).toBe('用户喜欢喝美式咖啡，每天早上一杯')
  })

  it('只是相近但并非包含的记忆不误判重复', () => {
    const existing = [item('a', '用户喜欢猫', 10)]
    const { added } = mergeMemories(existing, [{ type: 'preference', content: '用户喜欢狗' }], 200)
    expect(added).toHaveLength(1)
  })

  it('只差一个虚词的近重复也能合并（要/有/有一场）', () => {
    const { items, added } = mergeMemories(
      [],
      [
        { type: 'event', content: '用户下周三要考试' },
        { type: 'event', content: '用户下周三有考试' },
        { type: 'event', content: '用户下周三有一场考试' }
      ],
      100
    )
    expect(added).toHaveLength(1)
    expect(items).toHaveLength(1)
    // 保留最完整的那句
    expect(items[0].content).toBe('用户下周三有一场考试')
  })

  it('中间多几个字也能合并（她被称呼 / 被鲸鱼娘称呼）', () => {
    const existing = [item('a', '用户被她称呼为「哥哥」', 10)]
    const { items, added } = mergeMemories(
      existing,
      [{ type: 'identity', content: '用户被鲸鱼娘称呼为「哥哥」' }],
      200
    )
    expect(added).toHaveLength(0)
    expect(items).toHaveLength(1)
    // 保留更完整的那句
    expect(items[0].content).toBe('用户被鲸鱼娘称呼为「哥哥」')
  })

  it('否定词不同不合并（用户喜欢猫 / 用户不喜欢猫）', () => {
    const existing = [item('a', '用户喜欢猫', 10)]
    const { added } = mergeMemories(existing, [{ type: 'preference', content: '用户不喜欢猫' }], 200)
    expect(added).toHaveLength(1)
  })

  it('去掉「喝」之后相同的也合并（喜欢喝冰红茶 / 喜欢冰红茶）', () => {
    const { items, added } = mergeMemories(
      [],
      [
        { type: 'preference', content: '用户喜欢喝冰红茶' },
        { type: 'preference', content: '用户喜欢冰红茶' }
      ],
      100
    )
    expect(added).toHaveLength(1)
    expect(items).toHaveLength(1)
  })

  it('超过上限时淘汰最久未更新的', () => {
    const existing = Array.from({ length: MEMORY_MAX_ITEMS }, (_, i) => item(`i${i}`, `记忆内容 ${i}`, i))
    const { items } = mergeMemories(existing, [{ type: 'event', content: '用户明天要考试' }], 99999, () => 'new')
    expect(items).toHaveLength(MEMORY_MAX_ITEMS)
    expect(items.some((m) => m.id === 'i0')).toBe(false)
    expect(items.some((m) => m.id === 'new')).toBe(true)
  })
})

describe('consolidateMemories', () => {
  it('把存量里的近重复收成一条，保留最长表述、最早创建、最新更新与具体分类', () => {
    const items: MemoryItem[] = [
      { id: 'a', type: 'other', content: '用户下周三要考试', createdAt: 10, updatedAt: 10 },
      { id: 'b', type: 'event', content: '用户下周三有一场考试', createdAt: 5, updatedAt: 20 },
      { id: 'c', type: 'preference', content: '用户喜欢喝冰红茶', createdAt: 30, updatedAt: 30 },
      { id: 'd', type: 'preference', content: '用户喜欢冰红茶', createdAt: 40, updatedAt: 40 }
    ]
    const { items: out, removed } = consolidateMemories(items)

    expect(removed).toBe(2)
    expect(out).toHaveLength(2)

    const exam = out.find((m) => m.content.includes('考试'))
    expect(exam).toMatchObject({
      content: '用户下周三有一场考试',
      type: 'event',
      createdAt: 5,
      updatedAt: 20
    })

    expect(out.find((m) => m.content.includes('冰红茶'))?.content).toBe('用户喜欢喝冰红茶')
  })

  it('没有重复时原样返回', () => {
    const items = [item('a', '用户喜欢猫', 1), item('b', '用户住在一个小镇上', 2)]
    const { items: out, removed } = consolidateMemories(items)
    expect(removed).toBe(0)
    expect(out.map((m) => m.id)).toEqual(['a', 'b'])
  })
})

describe('normalizeType', () => {
  it('旧版 address 迁移成 identity', () => {
    expect(normalizeType('address')).toBe('identity')
  })

  it('合法类型原样保留，未知类型归 other', () => {
    expect(normalizeType('fact')).toBe('fact')
    expect(normalizeType('weird')).toBe('other')
    expect(normalizeType(undefined)).toBe('other')
  })
})

describe('searchMemories', () => {
  const items = [
    item('coffee', '用户喜欢喝美式咖啡', 10),
    item('thesis', '用户十月二十五日要去答辩', 20),
    item('cat', '用户养了一只橘猫叫团子', 30)
  ]

  it('按关键词重合度命中相关记忆', () => {
    expect(searchMemories(items, '我明天要答辩了').map((m) => m.id)).toContain('thesis')
    expect(searchMemories(items, '咖啡喝完了').map((m) => m.id)).toContain('coffee')
  })

  it('无关话题不硬塞旧记忆', () => {
    expect(searchMemories(items, '今天天气怎么样')).toEqual([])
  })

  it('查询为空时返回最近更新的几条', () => {
    expect(searchMemories(items, '', 2).map((m) => m.id)).toEqual(['cat', 'thesis'])
  })

  it('遵守 limit', () => {
    expect(searchMemories(items, '用户喜欢 答辩 橘猫', 1)).toHaveLength(1)
  })
})

describe('cosineSimilarity', () => {
  it('同向为 1，正交为 0，反向为 -1', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 3])).toBeCloseTo(0)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
  })

  it('长度不一致或零向量返回 0（换了模型 / 坏数据）', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
  })
})

describe('searchMemoriesByVector', () => {
  const items = [
    item('tea', '用户喜欢喝冰红茶', 10),
    item('thesis', '用户十月二十五日要去答辩', 20),
    item('cat', '用户养了一只橘猫叫团子', 30)
  ]
  // 三维玩具向量：tea 指 [1,0,0]，thesis 指 [0,1,0]
  const vectors = new Map<string, number[]>([
    ['tea', [1, 0, 0]],
    ['thesis', [0, 1, 0]]
  ])

  it('换个说法、关键词一个都不对时也能靠向量捞回来', () => {
    // 「想喝点凉的」与「冰红茶」没有共同 bigram
    expect(searchMemories(items, '想喝点凉的')).toEqual([])
    const found = searchMemoriesByVector(items, '想喝点凉的', [1, 0, 0], vectors)
    expect(found.map((m) => m.id)).toContain('tea')
  })

  it('相似度低于门槛的当作不相关（无关话题不硬塞旧记忆）', () => {
    // 与两条向量的余弦都约 0.35，在门槛下
    const below = [0.4, 0.4, 1]
    expect(cosineSimilarity(below, [1, 0, 0])).toBeLessThan(MIN_SEMANTIC_SIMILARITY)
    expect(searchMemoriesByVector(items, '今天天气怎么样', below, vectors)).toEqual([])
  })

  it('关键词命中照样算数，不会被一次泛泛的语义相似度挤掉', () => {
    const found = searchMemoriesByVector(items, '答辩', [0, 0, 1], vectors)
    expect(found.map((m) => m.id)).toEqual(['thesis'])
  })

  it('没有向量的记忆仍按关键词参与排序', () => {
    const found = searchMemoriesByVector(items, '橘猫', [0, 0, 1], vectors)
    expect(found.map((m) => m.id)).toEqual(['cat'])
  })

  it('语义与关键词都命中时按高分排前面', () => {
    const found = searchMemoriesByVector(items, '答辩', [0, 1, 0], vectors, 2)
    expect(found[0].id).toBe('thesis')
  })
})

describe('formatMemoryContext', () => {
  it('无记忆返回空串', () => {
    expect(formatMemoryContext([])).toBe('')
  })

  it('拼成列表并带说明', () => {
    const text = formatMemoryContext([item('a', '用户喜欢猫', 0), item('b', '用户明天答辩', 0)])
    expect(text).toContain('你记得的事')
    expect(text).toContain('- 用户喜欢猫')
    expect(text).toContain('- 用户明天答辩')
  })
})
