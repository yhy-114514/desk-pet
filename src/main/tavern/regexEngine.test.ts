// 正则清洗：两种 findRegex 写法、显示/提示词分流、坏正则跳过、实时测试。
import { describe, expect, it } from 'vitest'
import {
  applyRegexRules,
  readCardRegexes,
  splitRegex,
  testRegex,
  type RegexRule
} from './regexEngine'

function rule(over: Partial<RegexRule>): RegexRule {
  return {
    id: 'r',
    name: '规则',
    pattern: 'x',
    flags: 'g',
    replacement: '',
    target: 'both',
    enabled: true,
    order: 0,
    source: 'global',
    readonly: false,
    ...over
  }
}

describe('splitRegex', () => {
  it('认 /pattern/flags 与裸 pattern 两种写法', () => {
    expect(splitRegex('/<div>/gi')).toEqual({ pattern: '<div>', flags: 'gi' })
    expect(splitRegex('abc')).toEqual({ pattern: 'abc', flags: 'g' })
  })

  it('斜杠后面不是合法标志时整串当 pattern（路径里的 / 不当分隔符）', () => {
    expect(splitRegex('/a/b/c')).toEqual({ pattern: '/a/b/c', flags: 'g' })
  })
})

describe('readCardRegexes', () => {
  it('搬运 regex_scripts 与 piupiu_regex.scripts，按 id 去重', () => {
    const data = {
      extensions: {
        regex_scripts: [
          { id: 'one', scriptName: '隐藏状态栏', findRegex: '/<Status[^>]*>/g', replaceString: '' },
          { id: 'two', scriptName: '换行', findRegex: '\\n', replaceString: '' }
        ],
        piupiu_regex: {
          enabled: true,
          scripts: [
            { id: 'one', scriptName: '隐藏状态栏', findRegex: '/<Status[^>]*>/g', replaceString: '' },
            { id: 'three', scriptName: '补充', findRegex: '/x/', replaceString: 'y' }
          ]
        }
      }
    }
    const rules = readCardRegexes(data)
    expect(rules.map((item) => item.id)).toEqual(['card:one', 'card:two', 'card:three'])
    expect(rules.every((item) => item.source === 'card' && item.readonly)).toBe(true)
  })

  it('markdownOnly / promptOnly 决定作用面；禁用的跳过', () => {
    const rules = readCardRegexes({
      extensions: {
        piupiu_regex: {
          scripts: [
            { scriptName: '显示', findRegex: '/a/g', markdownOnly: true },
            { scriptName: '提示', findRegex: '/b/g', promptOnly: true },
            { scriptName: '两边', findRegex: '/c/g' },
            { scriptName: '禁用', findRegex: '/d/g', disabled: true }
          ]
        }
      }
    })
    expect(rules.map((item) => [item.name, item.target])).toEqual([
      ['显示', 'display'],
      ['提示', 'prompt'],
      ['两边', 'both']
    ])
  })

  it('编辑面（forEditing）要看得见被禁用的和还没填正则的规则', () => {
    const rules = readCardRegexes(
      {
        extensions: {
          piupiu_regex: {
            scripts: [
              { id: 'on', scriptName: '开', findRegex: '/a/g' },
              { id: 'off', scriptName: '关', findRegex: '/b/g', disabled: true },
              { id: 'blank', scriptName: '空' }
            ]
          }
        }
      },
      { forEditing: true }
    )
    expect(rules.map((item) => [item.name, item.enabled, item.pattern])).toEqual([
      ['开', true, 'a'],
      ['关', false, 'b'],
      ['空', true, '']
    ])
    // 注入 / 显示链路照旧不碰它们
    expect(readCardRegexes({ extensions: { piupiu_regex: { scripts: [{ id: 'off', findRegex: '/b/g', disabled: true }] } } })).toHaveLength(0)
  })

  it('piupiu_regex 整体关掉时不读它；没有 findRegex 的脚本跳过', () => {
    const rules = readCardRegexes({
      extensions: {
        piupiu_regex: { enabled: false, scripts: [{ scriptName: 'x', findRegex: '/a/' }] },
        regex_scripts: [{ scriptName: '空' }]
      }
    })
    expect(rules).toHaveLength(0)
  })
})

describe('applyRegexRules', () => {
  it('按 target 过滤：display 不吃 prompt 规则，both 两边都吃', () => {
    const rules = [
      rule({ id: 'd', pattern: '甲', replacement: 'X', target: 'display' }),
      rule({ id: 'p', pattern: '乙', replacement: 'Y', target: 'prompt' }),
      rule({ id: 'b', pattern: '丙', replacement: 'Z', target: 'both' })
    ]
    expect(applyRegexRules('甲乙丙', rules, 'display')).toBe('X乙Z')
    expect(applyRegexRules('甲乙丙', rules, 'prompt')).toBe('甲YZ')
  })

  it('按 order 依次应用（后一条看得到前一条的结果）', () => {
    const rules = [
      rule({ id: '2', pattern: 'b', replacement: 'c', order: 2 }),
      rule({ id: '1', pattern: 'a', replacement: 'b', order: 1 })
    ]
    expect(applyRegexRules('a', rules, 'display')).toBe('c')
  })

  it('禁用的规则不生效', () => {
    expect(applyRegexRules('a', [rule({ enabled: false })], 'display')).toBe('a')
  })

  it('pattern 还空着的新规则不生效（空正则会在每个字符边界命中）', () => {
    // 编辑面「加一条」存的是 pattern: '' + enabled: true：用户先填了替换文本时，
    // `/(?:)/g` 会把「你好」变成「X你X好X」，正文和发给模型的提示词一起打碎
    const blank = rule({ id: 'new', pattern: '', replacement: 'X' })
    expect(applyRegexRules('你好', [blank], 'display')).toBe('你好')
    expect(applyRegexRules('你好', [blank], 'prompt')).toBe('你好')
  })

  it('全局 / 角色规则的 pattern 写成 /…/flags 也要能命中', () => {
    // 用户按 ST 习惯把斜杠写进 pattern 字段：不拆开的话斜杠进正则本体，
    // 永远 0 命中而且不报错，界面上看着规则「在生效」
    expect(
      applyRegexRules('（一）甲', [rule({ pattern: '/（[^）]*）/i', flags: 'g' })], 'display')
    ).toBe('甲')
  })

  it('坏正则只记失败、跳过，正文其余部分照常替换', () => {
    const failures: { rule: RegexRule; error: string }[] = []
    const out = applyRegexRules(
      'abc',
      [
        rule({ id: 'bad', pattern: '[', replacement: '' }),
        rule({ id: 'ok', pattern: 'b', replacement: 'B' })
      ],
      'display',
      failures
    )
    expect(out).toBe('aBc')
    expect(failures.map((item) => item.rule.id)).toEqual(['bad'])
  })

  it('minDepth / maxDepth 只在区间内生效（最新一条是 0）', () => {
    // 「折叠历史状态栏」这类规则靠深度区分历史与当前：minDepth 1 的规则绝不能套到最新这条上，
    // 否则刚生成的状态页当场被删掉，界面上看是「聊完一轮面板就没了」
    const rules = [rule({ id: 'fold', pattern: '#', replacement: '', minDepth: 1, maxDepth: 99 })]
    expect(applyRegexRules('#', rules, 'display', [], { depth: 0 })).toBe('#')
    expect(applyRegexRules('#', rules, 'display', [], { depth: 3 })).toBe('')
  })

  it('没有深度信息时不套带深度的规则（宁可少折叠，也不能删当前页）', () => {
    const rules = [rule({ id: 'fold', pattern: '#', replacement: '', minDepth: 1 })]
    expect(applyRegexRules('#', rules, 'display')).toBe('#')
  })

  it('placement 不含当前位置时跳过', () => {
    const rules = [rule({ id: 'ai', pattern: '#', replacement: '', placement: [2] })]
    expect(applyRegexRules('#', rules, 'display', [], { placement: 1 })).toBe('#')
    expect(applyRegexRules('#', rules, 'display', [], { placement: 2 })).toBe('')
  })

  // 预览（`tavern:regex-preview`）不带位置信息：`[3]`（只在斜杠命令生效）与 `[]`（哪都不生效）
  // 若在预览里照常命中、真链路里却跳过，用户看到的效果和聊天里就对不上
  // 卡里把 placement 写成数字串时只认 number 会得到 `[]`，而 `[]` 是「哪都不生效」，
  // 整条规则被静默禁用；完全认不出来的（比如 ["display"]）则当没标，宁多勿少
  it('placement 认数字串；认不出来时当没标，不静默禁用', () => {
    const rules = readCardRegexes({
      extensions: {
        piupiu_regex: {
          scripts: [
            { scriptName: '数字串', findRegex: '/a/g', placement: ['2'] },
            { scriptName: '认不出', findRegex: '/b/g', placement: ['display'] },
            { scriptName: '空数组', findRegex: '/c/g', placement: [] }
          ]
        }
      }
    })
    expect(rules[0]!.placement).toEqual([2])
    expect(rules[1]!.placement).toBeUndefined()
    expect(rules[2]!.placement).toEqual([])
    expect(applyRegexRules('b', [rules[1]!], 'display')).toBe('')
    expect(applyRegexRules('c', [rules[2]!], 'display', [], { placement: 2 })).toBe('c')
  })

  it('没有位置信息时，带 placement 的规则一律不套', () => {
    const rules = [
      rule({ id: 'slash', pattern: '#', replacement: '', placement: [3] }),
      rule({ id: 'none', pattern: '@', replacement: '', placement: [] })
    ]
    expect(applyRegexRules('#@', rules, 'display')).toBe('#@')
  })

  it('「占位标签 → 页面」替换排在最后一批（模拟 ST 的先正则后渲染）', () => {
    // 《龙脊大陆》实测：先替换出 34KB 状态页，再跑「删 <UpdateVariable> 块」的正则，
    // 后者会把模板自己 JS 里 `textContent.match(/<UpdateVariable>…` 当成真的变量块起点，
    // 从中间吞掉 5KB，面板只剩半截代码。ST 里是正则跑完才由扩展渲染占位符，所以不会踩到
    const rules = [
      rule({
        id: 'panel',
        name: '状态栏',
        pattern: '<StatusPlaceHolderImpl/>',
        replacement: '```html\n<script>match(/<UpdateVariable>/)</script>\n```'
      }),
      rule({
        id: 'clean',
        name: '去除UpdateVariable数据标签',
        pattern: '<UpdateVariable>[\\s\\S]*?</UpdateVariable>',
        replacement: '',
        order: 1
      })
    ]
    const out = applyRegexRules('<StatusPlaceHolderImpl/><UpdateVariable>{"hp":1}</UpdateVariable>', rules, 'display')
    expect(out).not.toContain('{"hp":1}')
    // 模板里的 JS 完整保留（先替换的话这里会被啃掉半截）
    expect(out).toContain('match(/<UpdateVariable>/)')
    expect(out).toContain('</script>')
  })
})

describe('testRegex', () => {
  it('给出命中数与替换结果', () => {
    const result = testRegex(rule({ pattern: 'a', flags: 'g', replacement: 'b' }), 'a-a')
    expect(result.ok).toBe(true)
    expect(result.hits).toBe(2)
    expect(result.result).toBe('b-b')
  })

  it('没有 g 标志也按全部命中替换（ST 自己会补 g）', () => {
    const result = testRegex(rule({ pattern: 'a', flags: '', replacement: 'b' }), 'aaa')
    expect(result.hits).toBe(3)
    expect(result.result).toBe('bbb')
  })

  it('实际套用同样补齐 g：卡里 /…/i 这类写法要洗掉每一处', () => {
    // 卡里的规则常写成 /（…）/i 这种不带 g 的形式
    const out = applyRegexRules('（一）甲（二）乙', [rule({ pattern: '（[^）]*）', flags: 'i' })], 'display')
    expect(out).toBe('甲乙')
  })

  it('坏正则返回 ok:false 且正文不动', () => {
    const result = testRegex(rule({ pattern: '(' }), 'aaa')
    expect(result).toMatchObject({ ok: false, hits: 0, result: 'aaa' })
  })
})
