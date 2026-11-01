// 世界书：卡内嵌条目解析、三层激活（常驻 / 关键词 / 选择性 / 预算）、ST 导入导出。
import { describe, expect, it } from 'vitest'
import {
  activateLore,
  isWorldCard,
  mergeLayers,
  parseStLorebook,
  readCardEntries,
  toStLorebook,
  type LoreEntry
} from './worldbook'

function entry(over: Partial<LoreEntry>): LoreEntry {
  return {
    id: 'e',
    name: '条目',
    keys: [],
    secondaryKeys: [],
    content: '内容',
    constant: false,
    selective: false,
    position: 'before_char',
    depth: 4,
    order: 100,
    caseSensitive: false,
    source: 'global',
    readonly: false,
    ...over
  }
}

describe('readCardEntries', () => {
  it('读出卡的世界书条目（comment 当名字、keys 触发词、depth 位置）', () => {
    const data = {
      character_book: {
        entries: [
          {
            id: 3,
            comment: '仙洲历',
            keys: ['时间', '历法'],
            content: '仙洲历以甲子纪年。',
            constant: true,
            insertion_order: 10
          },
          {
            uid: 9,
            keys: '修为',
            secondary_keys: ['境界'],
            selective: true,
            content: '修为分九境。',
            position: 'after_char'
          },
          {
            content: '深度条目',
            position: 4,
            extensions: { depth: 2, case_sensitive: true }
          }
        ]
      }
    }
    const entries = readCardEntries(data)
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({
      id: 'card:3',
      name: '仙洲历',
      keys: ['时间', '历法'],
      constant: true,
      order: 10,
      position: 'before_char',
      source: 'card',
      readonly: true
    })
    expect(entries[1]).toMatchObject({
      keys: ['修为'],
      secondaryKeys: ['境界'],
      selective: true,
      position: 'after_char'
    })
    expect(entries[2]).toMatchObject({ position: 'depth', depth: 2, caseSensitive: true })
  })

  it('禁用条目与空内容不进来；没有书籍字段就返回空数组', () => {
    expect(
      readCardEntries({
        character_book: {
          entries: [{ content: 'a', enabled: false }, { content: 'b', disable: true }, { content: '  ' }]
        }
      })
    ).toHaveLength(0)
    expect(readCardEntries({})).toEqual([])
    expect(readCardEntries(null)).toEqual([])
  })

  it('真卡里每条都带 extensions.depth；position 不是 4/6 就不按深度注入', () => {
    const [first] = readCardEntries({
      character_book: {
        entries: [{ content: 'x', position: 'after_char', extensions: { depth: 9 } }]
      }
    })
    expect(first!.position).toBe('after_char')
    // position:4 但没配 depth 时退回前缀语义
    const [second] = readCardEntries({
      character_book: { entries: [{ content: 'y', position: 4 }] }
    })
    expect(second!.position).toBe('before_char')
  })

  it('真实卡把「@深度」写在 extensions.position = 4（顶层 position 只有前后两种）', () => {
    // 多角色卡 153 条全是这个形状：顶层 after_char + extensions.position 4
    const [depthEntry] = readCardEntries({
      character_book: {
        entries: [
          {
            content: 'z',
            position: 'after_char',
            extensions: { position: 4, depth: 3 }
          }
        ]
      }
    })
    expect(depthEntry!.position).toBe('depth')
    expect(depthEntry!.depth).toBe(3)
    // extensions.position = 1 就是「角色定义之后」，与顶层 after_char 一致
    const [afterEntry] = readCardEntries({
      character_book: { entries: [{ content: 'w', position: 'before_char', extensions: { position: 1 } }] }
    })
    expect(afterEntry!.position).toBe('after_char')
  })
})

describe('activateLore', () => {
  it('常驻条目永远在，关键词条目扫到才进', () => {
    const result = activateLore(
      [
        entry({ id: 'a', name: '世界规则', content: '规则', constant: true }),
        entry({ id: 'b', name: '剑', keys: ['长剑'], content: '长剑设定' }),
        entry({ id: 'c', name: '刀', keys: ['短刀'], content: '短刀设定' })
      ],
      '他拔出一柄长剑'
    )
    expect(result.active.map((item) => item.name)).toEqual(['世界规则', '剑'])
    expect(result.dropped).toHaveLength(0)
  })

  it('没有关键词也不是常驻的条目不注入', () => {
    const result = activateLore([entry({ keys: [], constant: false })], '任何文本')
    expect(result.active).toHaveLength(0)
  })

  it('关键词大小写不敏感，可开 caseSensitive 关闭', () => {
    const rule = entry({ keys: ['Dragon'] })
    expect(activateLore([rule], 'a dragon appears').active).toHaveLength(1)
    expect(
      activateLore([entry({ keys: ['Dragon'], caseSensitive: true })], 'a dragon appears').active
    ).toHaveLength(0)
  })

  it('selective + 二级关键词：二级没命中就不激活', () => {
    const rule = entry({ keys: ['雪山'], secondaryKeys: ['师父'], selective: true })
    expect(activateLore([rule], '雪山很冷').active).toHaveLength(0)
    expect(activateLore([rule], '雪山很冷，师父也在').active).toHaveLength(1)
  })

  it('关键词条目受预算截断，常驻条目不计预算也不被丢', () => {
    const big = 'x'.repeat(1600)
    const result = activateLore(
      [
        entry({ id: 'c', name: '常驻', content: `${big}常`, constant: true }),
        entry({ id: 'k1', name: '一', keys: ['甲'], content: `${big}一`, order: 1 }),
        entry({ id: 'k2', name: '二', keys: ['甲'], content: `${big}二`, order: 2 })
      ],
      '甲',
      300
    )
    expect(result.active.map((item) => item.name)).toEqual(['常驻'])
    expect(result.dropped.map((item) => item.name)).toEqual(['一', '二'])
  })

  it('按 insertion_order 排序；同位置同内容只注入一次', () => {
    const result = activateLore(
      [
        entry({ id: 'late', name: '后', keys: ['x'], content: '后文', order: 200 }),
        entry({ id: 'early', name: '前', keys: ['x'], content: '前文', order: 10 }),
        entry({ id: 'dup', name: '重复', keys: ['x'], content: '重复文', order: 20 })
      ],
      'x'
    )
    expect(result.active.map((item) => item.name)).toEqual(['前', '重复', '后'])

    const dedup = activateLore(
      [
        entry({ id: '1', name: 'A', content: '同文', constant: true }),
        entry({ id: '2', name: 'B', content: '同文', constant: true })
      ],
      ''
    )
    expect(dedup.active).toHaveLength(1)
  })

  it('被预算挤掉的条目不会把同内容的常驻副本也挡掉', () => {
    const big = 'x'.repeat(1600)
    const content = `${big}共用内容`
    const result = activateLore(
      [
        entry({ id: 'k', name: '关键词副本', keys: ['甲'], content, order: 1 }),
        entry({ id: 'c', name: '常驻副本', content, constant: true, order: 2 })
      ],
      '甲',
      300
    )
    expect(result.dropped.map((item) => item.name)).toEqual(['关键词副本'])
    // 常驻的那份必须在，而且只出现一次
    expect(result.active.map((item) => item.name)).toEqual(['常驻副本'])
  })
})

describe('mergeLayers', () => {
  it('按 全局 → 角色 → 卡内嵌 → 会话 的顺序平铺', () => {
    const layers = mergeLayers(
      [entry({ id: 'g', source: 'global' })],
      [entry({ id: 'c', source: 'character' })],
      [entry({ id: 'k', source: 'card' })],
      [entry({ id: 's', source: 'chat' })]
    )
    expect(layers.map((item) => item.id)).toEqual(['g', 'c', 'k', 's'])
  })
})

describe('ST 世界书导入导出', () => {
  it('能读数组与对象两种 entries，并剥掉 lorebook 包裹', () => {
    const asArray = parseStLorebook(
      JSON.stringify({ name: '甲', entries: [{ keys: ['k'], content: '内容' }] })
    )
    expect(asArray.name).toBe('甲')
    expect(asArray.entries).toHaveLength(1)

    const asObject = parseStLorebook(
      JSON.stringify({ lorebook: { name: '乙', entries: { 0: { content: '内容' } } } })
    )
    expect(asObject.name).toBe('乙')
    expect(asObject.entries[0]!.name).toBe('内容')
  })

  it('导出后再导入，触发词 / 内容 / 常驻 / 顺序一致', () => {
    const original = [
      entry({ id: 'a', name: '剑', keys: ['长剑'], secondaryKeys: ['锋'], content: '剑设定', order: 7 })
    ]
    const round = parseStLorebook(toStLorebook('测试书', original))
    expect(round.name).toBe('测试书')
    expect(round.entries[0]).toMatchObject({
      name: '剑',
      keys: ['长剑'],
      secondaryKeys: ['锋'],
      content: '剑设定',
      order: 7
    })
  })

  it('导出再导入，按深度注入的条目不会变成角色设定块', () => {
    const original = [
      entry({ id: 'd', name: '状态', content: '当前状态', position: 'depth', depth: 2 }),
      entry({ id: 'b', name: '前言', content: '前言', position: 'before_char' })
    ]
    const round = parseStLorebook(toStLorebook('测试书', original))
    expect(round.entries.map((item) => [item.position, item.depth])).toEqual([
      ['depth', 2],
      ['before_char', 4]
    ])
    // 顶层 position 仍是 ST 认识的两种取值，深度另有 extensions.position = 4
    const raw = JSON.parse(toStLorebook('x', original)) as {
      entries: { position: string; extensions: { position: number } }[]
    }
    expect(raw.entries[0]!.position).toBe('before_char')
    expect(raw.entries[0]!.extensions.position).toBe(4)
  })

  it('老格式的数字 position 要认：1 / 3 是角色之后', () => {
    // 只认字符串的话 position: 1 会落到末尾的 before_char，
    // 整块后置设定（作者注释前后）跑到角色设定前面
    const round = parseStLorebook(
      JSON.stringify({
        entries: [
          { keys: ['k'], content: '之前', position: 0 },
          { keys: ['k'], content: '之后', position: 1 },
          { keys: ['k'], content: '注释后', position: 3 }
        ]
      })
    )
    expect(round.entries.map((item) => item.position)).toEqual([
      'before_char',
      'after_char',
      'after_char'
    ])
  })

  it('坏 JSON 与坏结构都要报错', () => {
    expect(() => parseStLorebook('{oops')).toThrow()
    expect(() => parseStLorebook('"string"')).toThrow()
  })
})

describe('isWorldCard', () => {
  it('描述很短且世界书极多才算世界卡', () => {
    expect(isWorldCard('一个开放世界场景', 153)).toBe(true)
    expect(isWorldCard('一个开放世界场景', 6)).toBe(false)
    expect(isWorldCard('长'.repeat(500), 153)).toBe(false)
  })
})
