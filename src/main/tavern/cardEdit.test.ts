import { describe, expect, it } from 'vitest'
import { removeCardLore, removeCardRegex, upsertCardLore, upsertCardRegex } from './cardEdit'
import { readCardRegexes, type RegexRule } from './regexEngine'

function rule(patch: Partial<RegexRule> = {}): RegexRule {
  return {
    id: 'card:r1',
    name: '隐藏状态栏',
    pattern: '<StatusPlaceHolderImpl/>',
    flags: 'g',
    replacement: '',
    target: 'display',
    enabled: true,
    order: 0,
    source: 'card',
    readonly: true,
    ...patch
  }
}

describe('卡内嵌世界书编辑', () => {
  it('改一条：只动界面管的字段，卡里其它字段原样留着', () => {
    const data: Record<string, unknown> = {
      character_book: {
        entries: [
          {
            id: 3,
            comment: '旧名字',
            keys: ['旧'],
            content: '旧内容',
            probability: 80,
            use_regex: true,
            extensions: { foo: 'bar', depth: 2, position: 1 }
          }
        ]
      }
    }

    const id = upsertCardLore(data, {
      id: 'card:3',
      name: '新名字',
      keys: ['新'],
      secondaryKeys: [],
      content: '新内容',
      constant: true,
      selective: false,
      position: 'depth',
      depth: 4,
      order: 10,
      caseSensitive: true
    })

    expect(id).toBe('card:3')
    const entries = (data['character_book'] as { entries: Record<string, unknown>[] }).entries
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry['comment']).toBe('新名字')
    expect(entry['keys']).toEqual(['新'])
    expect(entry['content']).toBe('新内容')
    expect(entry['constant']).toBe(true)
    expect(entry['insertion_order']).toBe(10)
    // 顶层只有前 / 后，@深度写在 extensions.position
    expect(entry['position']).toBe('before_char')
    const extensions = entry['extensions'] as Record<string, unknown>
    expect(extensions['position']).toBe(4)
    expect(extensions['depth']).toBe(4)
    expect(extensions['foo']).toBe('bar')
    // 卡自己的字段不能因为存了一次就消失
    expect(entry['probability']).toBe(80)
    expect(entry['use_regex']).toBe(true)
  })

  it('新建：避开已有的数字 id，返回可再次编辑的 id', () => {
    const data: Record<string, unknown> = {
      character_book: { entries: [{ id: 0, content: 'a' }, { id: 1, content: 'b' }] }
    }
    const id = upsertCardLore(data, {
      name: '第三条',
      keys: [],
      secondaryKeys: [],
      content: 'c',
      constant: false,
      selective: false,
      position: 'after_char',
      depth: 4,
      order: 100,
      caseSensitive: false
    })
    expect(id).toBe('card:2')
    const entries = (data['character_book'] as { entries: Record<string, unknown>[] }).entries
    expect(entries).toHaveLength(3)
    expect(entries[2]!['position']).toBe('after_char')
    expect((entries[2]!['extensions'] as Record<string, unknown>)['position']).toBe(1)
  })

  it('卡里没有 character_book 时也能新建', () => {
    const data: Record<string, unknown> = {}
    const id = upsertCardLore(data, {
      name: 'x',
      keys: [],
      secondaryKeys: [],
      content: 'y',
      constant: false,
      selective: false,
      position: 'before_char',
      depth: 4,
      order: 100,
      caseSensitive: false
    })
    expect(id).toBe('card:0')
    expect(data['character_book']).toBeTruthy()
  })

  it('新建条目要避开没写 id 条目的下标号', () => {
    // 没写 id 的条目 key 是 card:下标，下标号同样被占着：
    // 只数数字 id 的话新条目会取到 card:0，之后改 / 删都落到那条老条目上
    const data: Record<string, unknown> = {
      character_book: { entries: [{ content: '第一条' }, { id: 2, content: '第二条' }] }
    }
    const id = upsertCardLore(data, {
      name: '新条目',
      keys: ['k'],
      secondaryKeys: [],
      content: '新内容',
      constant: false,
      selective: false,
      position: 'before_char',
      depth: 4,
      order: 100,
      caseSensitive: false
    })
    expect(id).toBe('card:1')
    const entries = (data['character_book'] as { entries: Record<string, unknown>[] }).entries
    expect(entries).toHaveLength(3)
    expect(entries[0]!['content']).toBe('第一条')
  })

  it('删除：命中就删掉，没命中返回 false', () => {
    const data: Record<string, unknown> = {
      character_book: { entries: [{ id: 5, content: 'a' }, { id: 6, content: 'b' }] }
    }
    expect(removeCardLore(data, 'card:5')).toBe(true)
    expect(removeCardLore(data, 'card:5')).toBe(false)
    expect((data['character_book'] as { entries: unknown[] }).entries).toHaveLength(1)
  })
})

describe('卡内嵌正则编辑', () => {
  it('同一份脚本躺在两处数组时两处一起改，findRegex 保持原写法', () => {
    const data: Record<string, unknown> = {
      extensions: {
        regex_scripts: [
          { id: 'r1', scriptName: '旧', findRegex: '/a/gm', replaceString: '', markdownOnly: true }
        ],
        piupiu_regex: {
          enabled: true,
          scripts: [{ id: 'r1', scriptName: '旧', findRegex: '/a/gm', replaceString: '' }]
        }
      }
    }

    const id = upsertCardRegex(
      data,
      rule({ pattern: 'b', flags: 'gi', replacement: 'X', target: 'prompt' })
    )

    expect(id).toBe('card:r1')
    const extensions = data['extensions'] as Record<string, unknown>
    const first = (extensions['regex_scripts'] as Record<string, unknown>[])[0]!
    const second = ((extensions['piupiu_regex'] as Record<string, unknown>)['scripts'] as Record<
      string,
      unknown
    >[])[0]!
    for (const script of [first, second]) {
      expect(script['scriptName']).toBe('隐藏状态栏')
      expect(script['findRegex']).toBe('/b/gi')
      expect(script['replaceString']).toBe('X')
      expect(script['markdownOnly']).toBe(false)
      expect(script['promptOnly']).toBe(true)
      expect(script['disabled']).toBe(false)
    }
  })

  it('新建：两处数组都写一份，findRegex 沿用裸 pattern 风格', () => {
    const data: Record<string, unknown> = {
      extensions: {
        regex_scripts: [{ id: 'r0', findRegex: 'x', replaceString: '' }],
        piupiu_regex: { enabled: true, scripts: [] }
      }
    }
    const id = upsertCardRegex(data, rule({ id: 'card:new', pattern: 'p', flags: 'g' }))
    expect(id).toMatch(/^card:[0-9a-f-]{36}$/)
    const extensions = data['extensions'] as Record<string, unknown>
    expect((extensions['regex_scripts'] as unknown[]).length).toBe(2)
    const scripts = (extensions['piupiu_regex'] as Record<string, unknown>)['scripts'] as Record<
      string,
      unknown
    >[]
    expect(scripts).toHaveLength(1)
    expect(scripts[0]!['findRegex']).toBe('p')
    expect(scripts[0]!['id']).toBe(id.slice('card:'.length))
  })

  it('卡里没有 extensions 时建一份 piupiu_regex', () => {
    const data: Record<string, unknown> = {}
    upsertCardRegex(data, rule({ id: 'card:new', pattern: '<x>', flags: 'g' }))
    const extensions = data['extensions'] as Record<string, unknown>
    const scripts = (extensions['piupiu_regex'] as Record<string, unknown>)['scripts'] as unknown[]
    expect(scripts).toHaveLength(1)
  })

  it('脚本没写 id 时两份数组按拼接顺序连续编号（与 readCardRegexes 同一口径）', () => {
    const data: Record<string, unknown> = {
      extensions: {
        regex_scripts: [{ findRegex: 'a', replaceString: '' }],
        piupiu_regex: {
          enabled: true,
          scripts: [
            { findRegex: 'b', replaceString: '' },
            { findRegex: 'c', replaceString: '' }
          ]
        }
      }
    }
    const scripts = ((data['extensions'] as Record<string, unknown>)['piupiu_regex'] as Record<
      string,
      unknown
    >)['scripts'] as Record<string, unknown>[]
    // 编号必须和列表侧一致：a=0、b=1、c=2
    expect(readCardRegexes(data).map((item) => item.id)).toEqual(['card:0', 'card:1', 'card:2'])

    upsertCardRegex(data, rule({ id: 'card:2', pattern: 'Z', flags: 'g' }))
    expect(scripts).toHaveLength(2)
    expect(scripts[1]!['findRegex']).toBe('Z')

    // 删掉第二个数组里那条：原先是静默什么都不删
    expect(removeCardRegex(data, 'card:1')).toBe(true)
    expect(scripts).toHaveLength(1)
    expect(scripts[0]!['findRegex']).toBe('Z')
  })

  it('裸 pattern 改了 flags 也要落库（否则界面上的改动静默丢失）', () => {
    const data: Record<string, unknown> = {
      extensions: { regex_scripts: [{ id: 'r1', findRegex: 'a', replaceString: '' }] }
    }
    upsertCardRegex(data, rule({ id: 'card:r1', pattern: 'a', flags: 'gi' }))
    const scripts = ((data['extensions'] as Record<string, unknown>)['regex_scripts'] as Record<
      string,
      unknown
    >[])
    expect(scripts[0]!['findRegex']).toBe('/a/gi')
  })

  it('删除：两处数组都摘掉', () => {
    const data: Record<string, unknown> = {
      extensions: {
        regex_scripts: [{ id: 'r1', findRegex: 'a', replaceString: '' }],
        piupiu_regex: { enabled: true, scripts: [{ id: 'r1', findRegex: 'a', replaceString: '' }] }
      }
    }
    expect(removeCardRegex(data, 'card:r1')).toBe(true)
    expect(removeCardRegex(data, 'card:r1')).toBe(false)
    const extensions = data['extensions'] as Record<string, unknown>
    expect(extensions['regex_scripts']).toEqual([])
    expect((extensions['piupiu_regex'] as Record<string, unknown>)['scripts']).toEqual([])
  })
})
