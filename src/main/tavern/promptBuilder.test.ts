// PromptBuilder 纯逻辑：装配顺序、占位符、世界书激活与预算。
import { describe, expect, it } from 'vitest'
import {
  activateLore,
  buildTavernMessages,
  buildTavernPrompt,
  readLoreEntries,
  substitutePlaceholders,
  substituteVariableMacros,
  trimToBudget
} from './promptBuilder'
import { DEFAULT_SAMPLING, type PresetData, type PresetPrompt } from './preset'

const card = {
  name: '苏月珑',
  description: '{{char}}是月珑峰的师父。',
  personality: '清冷',
  scenario: '清晨',
  mesExample: '{{user}}: 师父\n{{char}}: 徒儿。',
  systemPrompt: '',
  postHistoryInstructions: '保持{{char}}的口吻。'
}

const profile = { name: '小满', description: '住在海边的人。' }

function book(entries: unknown[]): Record<string, unknown> {
  return { character_book: { name: '设定', entries } }
}

describe('占位符', () => {
  it('{{char}} / {{user}} 大小写不敏感', () => {
    expect(substitutePlaceholders('{{char}} 与 {{USER}}，还有 {{Char}}', { char: '阿蕾', user: '小满' })).toBe(
      '阿蕾 与 小满，还有 阿蕾'
    )
  })
})

describe('显示侧的变量宏', () => {
  const state = { 世界层: { 地点: '灰烬堡', 队伍: [{ 名字: '艾莉娅' }] }, 体力: 0, 空: null }

  it('按路径取值填进 HTML（不展开就是一格空格子上的字面量）', () => {
    // 《魔法时代》整张卡就是这个症状：页面结构出来了、数据一个都没有
    expect(substituteVariableMacros('地点：{{format_message_variable::stat_data.世界层.地点}}', state)).toBe(
      '地点：灰烬堡'
    )
  })

  it('数组下标与数字、0 值都能取到', () => {
    expect(
      substituteVariableMacros(
        '{{get_message_variable::stat_data.世界层.队伍.0.名字}}/{{format_message_variable::stat_data.体力}}',
        state
      )
    ).toBe('艾莉娅/0')
  })

  it('取不到（含 null）填空串，不把 undefined 写进页面', () => {
    expect(substituteVariableMacros('a{{format_message_variable::stat_data.没有.这个}}b', state)).toBe('ab')
    expect(substituteVariableMacros('a{{format_message_variable::stat_data.空}}b', state)).toBe('ab')
  })

  it('对象值转 JSON', () => {
    expect(substituteVariableMacros('{{format_message_variable::stat_data.世界层}}', state)).toBe(
      '{"地点":"灰烬堡","队伍":[{"名字":"艾莉娅"}]}'
    )
  })
})

describe('世界书', () => {
  it('constant 常驻；普通条目靠关键词；没命中就不注入', () => {
    const entries = readLoreEntries(
      book([
        { keys: [], content: '仙洲历三千年。', constant: true },
        { keys: ['月珑峰'], content: '月珑峰常年积雪。' },
        { keys: ['魔教'], content: '魔教在北边。' }
      ])
    )
    const active = activateLore(entries, '我们去月珑峰看看吧')
    expect(active.map((entry) => entry.content)).toEqual(['仙洲历三千年。', '月珑峰常年积雪。'])
  })

  it('selective + 二级关键词：只命中一级不激活', () => {
    const entries = readLoreEntries(
      book([
        {
          keys: ['师父'],
          secondary_keys: ['剑'],
          selective: true,
          content: '她有一把断水剑。'
        }
      ])
    )
    expect(activateLore(entries, '师父在哪')).toHaveLength(0)
    expect(activateLore(entries, '师父的那把剑')).toHaveLength(1)
  })

  it('enabled:false / disable:true 的条目不参与', () => {
    const entries = readLoreEntries(
      book([
        { keys: ['月'], content: '停用的', enabled: false },
        { keys: ['月'], content: '旧写法的停用', disable: true },
        { keys: ['月'], content: '启用的' }
      ])
    )
    expect(activateLore(entries, '月亮').map((entry) => entry.content)).toEqual(['启用的'])
  })

  it('按 insertion_order 排序，超出预算的丢弃（常驻优先保留）', () => {
    const long = '很长的设定。'.repeat(200)
    const entries = readLoreEntries(
      book([
        { keys: ['触发'], content: '后注入', insertion_order: 200 },
        { keys: [], content: '常驻', constant: true, insertion_order: 100 },
        { keys: ['触发'], content: '先注入', insertion_order: 10 },
        { keys: ['触发'], content: long, insertion_order: 5 }
      ])
    )
    const active = activateLore(entries, '触发', 60)
    // 长条目被预算挡掉，剩下三条按序号排（常驻序号 100，夹在两条触发条目中间）
    expect(active.map((entry) => entry.content)).toEqual(['先注入', '常驻', '后注入'])
  })

  it('常驻条目再长也不占关键词条目的预算', () => {
    const constant = '世界规则。'.repeat(300) // ~1500 token，已经超过整个 LORE 预算
    const entries = readLoreEntries(
      book([
        { keys: [], content: constant, constant: true },
        { keys: ['月珑峰'], content: '月珑峰常年积雪。' }
      ])
    )
    const active = activateLore(entries, '去月珑峰', 60)
    expect(active.map((entry) => entry.content)).toEqual([constant, '月珑峰常年积雪。'])
  })
})

describe('装配', () => {
  it('system 在前、历史居中、本轮输入在后、post_history 收尾', () => {
    const messages = buildTavernMessages({
      card,
      profile,
      history: [
        { role: 'assistant', content: '你来了。' },
        { role: 'user', content: '嗯。' }
      ],
      userText: '师父，今天练什么？'
    })

    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toContain('苏月珑的设定')
    expect(messages[0]!.content).toContain('小满的设定')
    expect(messages.slice(1, 3)).toEqual([
      { role: 'assistant', content: '你来了。' },
      { role: 'user', content: '嗯。' }
    ])
    expect(messages[3]).toEqual({ role: 'user', content: '师父，今天练什么？' })
    expect(messages[4]).toEqual({ role: 'system', content: '保持苏月珑的口吻。' })
  })

  it('世界书条目按 position 分列在角色定义前后，占位符一并替换', () => {
    const messages = buildTavernMessages({
      card,
      profile,
      history: [],
      userText: '月珑峰',
      rawData: book([
        { keys: [], content: '前置：{{char}}的师门。', constant: true, position: 'before_char' },
        { keys: ['月珑峰'], content: '后置：{{char}}住的峰。', position: 'after_char' }
      ])
    })
    const system = messages[0]!.content
    const head = system.indexOf('苏月珑的设定')
    expect(system.indexOf('前置：苏月珑的师门。')).toBeLessThan(head)
    expect(system.indexOf('后置：苏月珑住的峰。')).toBeGreaterThan(head)
    expect(messages[1]).toEqual({ role: 'user', content: '月珑峰' })
  })

  it('历史按预算裁最早的，本轮输入不裁', () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      role: 'user' as const,
      content: `第${index}句。`.repeat(10)
    }))
    const messages = buildTavernMessages({ card, profile, history, userText: '最后一句', budget: 120 })
    const kept = messages.slice(1, -2)
    expect(kept.length).toBeLessThan(history.length)
    expect(kept[kept.length - 1]!.content).toContain('第19句')
    expect(messages[messages.length - 2]).toEqual({ role: 'user', content: '最后一句' })
  })

  it('trimToBudget 在预算极小时一条历史都不留，但不动本轮输入', () => {
    expect(trimToBudget([{ role: 'user', content: '很长的历史'.repeat(50) }], '喂', 30)).toEqual([])
  })

  it('没有本轮输入（重生成）时不塞空 user 消息', () => {
    const messages = buildTavernMessages({
      card,
      profile,
      history: [
        { role: 'assistant', content: '你来了。' },
        { role: 'user', content: '嗯。' }
      ],
      userText: ''
    })
    expect(messages.some((item) => item.content.trim() === '')).toBe(false)
    expect(messages[messages.length - 2]).toEqual({ role: 'user', content: '嗯。' })
  })

  it('空卡（没描述 / 没示例）也能装出一段合法的 messages', () => {
    const messages = buildTavernMessages({
      card: { ...card, description: '', personality: '', scenario: '', mesExample: '', postHistoryInstructions: '' },
      profile,
      history: [],
      userText: '你好'
    })
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toContain('你将扮演「苏月珑」')
    expect(messages).toHaveLength(2)
  })

  it('前情提要（档案）与永久记忆排在角色设定之后、历史之前', () => {
    const messages = buildTavernMessages({
      card,
      profile,
      history: [{ role: 'assistant', content: '你来了。' }],
      userText: '继续',
      dossier: '【前情提要】她在月珑峰等你。',
      memoryContext: '【你记得的事】用户怕冷。'
    })
    expect(messages[0]!.role).toBe('system')
    const system = messages[0]!.content
    const charBlock = system.indexOf('苏月珑的设定')
    expect(system.indexOf('她在月珑峰等你')).toBeGreaterThan(charBlock)
    expect(system.indexOf('用户怕冷')).toBeGreaterThan(system.indexOf('她在月珑峰等你'))
    expect(messages[1]).toEqual({ role: 'assistant', content: '你来了。' })
  })

  it('视界深度只带最近 N 条历史，完整视界不按预算裁剪', () => {
    const history = Array.from({ length: 10 }, (_, index) => ({
      role: 'user' as const,
      content: `第${index}句`
    }))
    const sliced = buildTavernMessages({ card, profile, history, userText: '最后', recentLimit: 3 })
    expect(sliced.slice(1, -2).map((item) => item.content)).toEqual(['第7句', '第8句', '第9句'])

    const full = buildTavernMessages({
      card,
      profile,
      history,
      userText: '最后',
      budget: 1,
      fullVision: true
    })
    expect(full.slice(1, -2)).toHaveLength(10)
  })
})

function prompt(over: Partial<PresetPrompt> & { identifier: string }): PresetPrompt {
  return {
    name: over.identifier,
    content: '',
    role: 'system',
    enabled: true,
    marker: false,
    injectionPosition: 0,
    injectionDepth: 4,
    ...over
  }
}

function preset(prompts: PresetPrompt[], order: string[] = []): PresetData {
  return {
    name: '测试预设',
    sampling: DEFAULT_SAMPLING,
    prompts,
    order: order.map((identifier) => ({ identifier, enabled: true }))
  }
}

describe('预设装配', () => {
  it('按 marker 顺序插入卡字段，普通条目进 system，历史排在 chatHistory 处', () => {
    const messages = buildTavernMessages({
      card,
      profile,
      history: [{ role: 'assistant', content: '你来了。' }],
      userText: '继续',
      preset: preset([
        prompt({ identifier: 'main', marker: true }),
        prompt({ identifier: 'charDescription', marker: true }),
        prompt({ identifier: 'cot', content: '先在心里想清楚再写。' }),
        prompt({ identifier: 'chatHistory', marker: true })
      ])
    })
    expect(messages[0]!.role).toBe('system')
    const system = messages[0]!.content
    expect(system).toContain('扮演「苏月珑」')
    expect(system).toContain('苏月珑的设定')
    expect(system.indexOf('先在心里想清楚再写')).toBeGreaterThan(system.indexOf('苏月珑的设定'))
    expect(messages[1]).toEqual({ role: 'assistant', content: '你来了。' })
    // 本轮输入之后还有卡的后置指令（预设没给它留 marker，照样带上）
    expect(messages.at(-2)).toEqual({ role: 'user', content: '继续' })
    expect(messages.at(-1)!.content).toContain('保持苏月珑的口吻')
  })

  it('prompt_order 决定顺序，导出的启用状态生效', () => {
    const messages = buildTavernMessages({
      card,
      profile,
      history: [{ role: 'assistant', content: '嗨' }],
      userText: '嗯',
      preset: preset(
        [
          prompt({ identifier: 'main', marker: true }),
          prompt({ identifier: 'first', content: '第一句指令' }),
          prompt({ identifier: 'second', content: '第二句指令' }),
          prompt({ identifier: 'chatHistory', marker: true })
        ],
        ['main', 'second', 'first', 'chatHistory']
      )
    })
    const system = messages[0]!.content
    expect(system.indexOf('第二句指令')).toBeLessThan(system.indexOf('第一句指令'))
  })

  it('injection_position=1 的条目插进历史（倒数第 N 条前）', () => {
    const messages = buildTavernMessages({
      card,
      profile,
      history: [
        { role: 'assistant', content: '第一句' },
        { role: 'assistant', content: '第二句' }
      ],
      userText: '第三句',
      preset: preset([
        prompt({ identifier: 'main', marker: true }),
        prompt({ identifier: 'chatHistory', marker: true }),
        prompt({
          identifier: 'deep',
          content: '提醒：天快黑了。',
          injectionPosition: 1,
          injectionDepth: 1
        })
      ])
    })
    // depth=1 紧贴本轮输入之前（ST 的 depth 把本轮输入算第 0 层）
    const userIndex = messages.findIndex((item) => item.content === '第三句')
    expect(messages[userIndex - 1]).toEqual({ role: 'system', content: '提醒：天快黑了。' })
    expect(messages.findIndex((item) => item.content === '第二句')).toBeLessThan(userIndex - 1)
  })

  it('postHistoryInstructions marker 的内容放在最后（本轮输入之后）', () => {
    const messages = buildTavernMessages({
      card,
      profile,
      history: [{ role: 'assistant', content: '嗨' }],
      userText: '嗯',
      preset: preset([
        prompt({ identifier: 'main', marker: true }),
        prompt({ identifier: 'chatHistory', marker: true }),
        prompt({ identifier: 'postHistoryInstructions', marker: true })
      ])
    })
    // 后置指令是模型最后读到的东西：紧跟本轮输入之后，与直通模板一致
    expect(messages.at(-2)).toEqual({ role: 'user', content: '嗯' })
    expect(messages.at(-1)!.role).toBe('system')
    expect(messages.at(-1)!.content).toContain('保持苏月珑的口吻')
  })

  it('预设条目里的 {{char}} / {{user}} 也要换成真名', () => {
    const messages = buildTavernMessages({
      card,
      profile,
      history: [],
      userText: '嗯',
      preset: preset([
        prompt({ identifier: 'main', marker: true }),
        prompt({ identifier: 'cot', content: '你是{{char}}，对方是{{user}}。' }),
        prompt({ identifier: 'chatHistory', marker: true })
      ])
    })
    const system = messages[0]!.content
    expect(system).toContain('你是苏月珑，对方是小满。')
    expect(system).not.toContain('{{char}}')
  })

  it('卡的 system_prompt 取代预设的 Main Prompt（ST 语义）', () => {
    const messages = buildTavernMessages({
      card: { ...card, systemPrompt: '你是{{char}}，永远用古风说话。' },
      profile,
      history: [],
      userText: '嗯',
      preset: preset([
        prompt({ identifier: 'main', content: '预设自带的主提示词' }),
        prompt({ identifier: 'chatHistory', marker: true })
      ])
    })
    const system = messages[0]!.content
    expect(system).toContain('你是苏月珑，永远用古风说话。')
    expect(system).not.toContain('预设自带的主提示词')
  })

  it('预设里没有 main 条目时，卡的 system_prompt 仍然要发出去', () => {
    const messages = buildTavernMessages({
      card: { ...card, systemPrompt: '你是{{char}}。' },
      profile,
      history: [],
      userText: '嗯',
      preset: preset([prompt({ identifier: 'chatHistory', marker: true })])
    })
    expect(messages[0]).toEqual({ role: 'system', content: '你是苏月珑。' })
  })

  it('user / assistant 角色的条目单独成条，不混进 system 段', () => {
    const messages = buildTavernMessages({
      card,
      profile,
      history: [{ role: 'assistant', content: '嗨' }],
      userText: '嗯',
      preset: preset([
        prompt({ identifier: 'main', marker: true }),
        prompt({ identifier: 'chatHistory', marker: true }),
        prompt({ identifier: 'jailbreak', content: '（越狱指令）', role: 'assistant' })
      ])
    })
    const tail = messages.find((item) => item.content === '（越狱指令）')
    expect(tail).toEqual({ role: 'assistant', content: '（越狱指令）' })
    // 不能再混进它前面那条 system 消息里
    expect(messages.some((item) => item.role === 'system' && item.content.includes('越狱'))).toBe(false)
  })

  it('预设没有世界书占位点时，世界书兜底注入而不是静默消失', () => {
    const built = buildTavernPrompt({
      card,
      profile,
      history: [],
      userText: '我们在月珑峰。',
      preset: preset([prompt({ identifier: 'main', marker: true }), prompt({ identifier: 'chatHistory', marker: true })]),
      lore: [
        {
          id: 'c1',
          name: '月珑峰',
          keys: ['月珑峰'],
          secondaryKeys: [],
          content: '月珑峰的设定。',
          constant: false,
          selective: false,
          position: 'before_char',
          depth: 4,
          order: 10,
          caseSensitive: false,
          source: 'card',
          readonly: true
        }
      ]
    })
    expect(built.messages.some((item) => item.content.includes('月珑峰的设定'))).toBe(true)
  })

  it('预设里没有 chatHistory 时历史照样带上', () => {
    const messages = buildTavernMessages({
      card,
      profile,
      history: [{ role: 'assistant', content: '你来了。' }],
      userText: '继续',
      preset: preset([prompt({ identifier: 'main', marker: true })])
    })
    expect(messages.some((item) => item.content === '你来了。')).toBe(true)
    expect(messages.at(-2)).toEqual({ role: 'user', content: '继续' })
  })

  it('卡没写 system_prompt 时，预设 main 条的正文要留下来', () => {
    // main 是普通条目而非 marker：它的正文就是预设的主体（身份设定 / 破限），
    // 一律换成默认角色指令等于把整段丢掉
    const messages = buildTavernMessages({
      card: { ...card, systemPrompt: '' },
      profile,
      history: [],
      userText: '嗯',
      preset: preset([
        prompt({ identifier: 'main', content: '你是{{char}}，说话要古雅。' }),
        prompt({ identifier: 'chatHistory', marker: true })
      ])
    })
    expect(messages[0]!.content).toContain('你是苏月珑，说话要古雅。')
  })

  it('深度条目里的 {{getvar}} 取到前面 {{setvar}} 的值', () => {
    const messages = buildTavernMessages({
      card,
      profile,
      history: [{ role: 'assistant', content: '嗨' }],
      userText: '嗯',
      preset: preset([
        prompt({ identifier: 'main', marker: true }),
        prompt({ identifier: 'setup', content: '{{setvar::腔调::古风}}' }),
        prompt({ identifier: 'chatHistory', marker: true }),
        prompt({
          identifier: 'deep',
          content: '请用{{getvar::腔调}}作答。',
          injectionPosition: 1,
          injectionDepth: 1
        })
      ])
    })
    // chatHistory 配在深度条目之前（真实预设就是这样），宏也得按 order 求值
    expect(messages.some((item) => item.content === '请用古风作答。')).toBe(true)
    expect(messages.some((item) => item.content.includes('{{getvar'))).toBe(false)
  })

  it('injection_depth = 0 的条目落在本轮用户输入之后', () => {
    const messages = buildTavernMessages({
      card,
      profile,
      history: [{ role: 'assistant', content: '嗨' }],
      userText: '嗯',
      preset: preset([
        prompt({ identifier: 'main', marker: true }),
        prompt({ identifier: 'chatHistory', marker: true }),
        prompt({ identifier: 'after', content: '（本轮最后一句指令）', injectionPosition: 1, injectionDepth: 0 })
      ])
    })
    const userIndex = messages.findIndex((item) => item.content === '嗯')
    expect(messages[userIndex + 1]!.content).toBe('（本轮最后一句指令）')
  })

  it('历史之后的 system 条目遇到 assistant 条目时先落下，顺序不乱', () => {
    const messages = buildTavernMessages({
      card,
      profile,
      history: [{ role: 'assistant', content: '嗨' }],
      userText: '嗯',
      preset: preset([
        prompt({ identifier: 'main', marker: true }),
        prompt({ identifier: 'chatHistory', marker: true }),
        prompt({ identifier: 'afterSys', content: '（历史之后的系统指令）' }),
        prompt({ identifier: 'jailbreak', content: '（示例对答）', role: 'assistant' })
      ])
    })
    const sysIndex = messages.findIndex((item) => item.content === '（历史之后的系统指令）')
    const jailIndex = messages.findIndex((item) => item.content === '（示例对答）')
    expect(sysIndex).toBeGreaterThan(0)
    expect(sysIndex).toBeLessThan(jailIndex)
  })

  it('卡条目里的 ST 宏换成实时状态与本轮输入', () => {
    const built = buildTavernPrompt({
      card,
      profile,
      history: [{ role: 'assistant', content: '嗨' }],
      userText: '我们去哪儿？',
      statData: '世界/当前时间: 清晨',
      preset: preset([
        prompt({ identifier: 'main', marker: true }),
        prompt({
          identifier: 'state',
          content: '{{format_message_variable::stat_data}}\n上一句：{{lastusermessage}}'
        }),
        prompt({ identifier: 'chatHistory', marker: true })
      ])
    })
    const system = built.messages[0]!.content
    expect(system).toContain('世界/当前时间: 清晨')
    expect(system).toContain('上一句：我们去哪儿？')
    expect(system).not.toContain('{{format_message_variable')
  })
})

describe('三层世界书与调试信息', () => {
  const lore = [
    {
      id: 'g1',
      name: '全局设定',
      keys: [],
      secondaryKeys: [],
      content: '全局常驻。',
      constant: true,
      selective: false,
      position: 'before_char' as const,
      depth: 4,
      order: 10,
      caseSensitive: false,
      source: 'global' as const,
      readonly: false
    },
    {
      id: 'c1',
      name: '角色书条目',
      keys: ['月珑峰'],
      secondaryKeys: [],
      content: '角色书里的月珑峰。',
      constant: false,
      selective: false,
      position: 'after_char' as const,
      depth: 4,
      order: 20,
      caseSensitive: false,
      source: 'character' as const,
      readonly: false
    },
    {
      id: 'card:1',
      name: '卡内嵌条目',
      keys: ['月珑峰'],
      secondaryKeys: [],
      content: '卡内嵌的月珑峰。',
      constant: false,
      selective: false,
      position: 'before_char' as const,
      depth: 4,
      order: 30,
      caseSensitive: false,
      source: 'card' as const,
      readonly: true
    }
  ]

  it('传了 lore 就用它（不再读 rawData），三层条目都生效并分列前后', () => {
    const built = buildTavernPrompt({
      card,
      profile,
      history: [{ role: 'assistant', content: '我们去月珑峰吧。' }],
      userText: '好',
      rawData: book([{ keys: ['月珑峰'], content: '不该出现的旧条目。' }]),
      lore
    })
    const system = built.messages[0]!.content
    expect(system).toContain('全局常驻')
    expect(system).toContain('卡内嵌的月珑峰')
    expect(system).toContain('角色书里的月珑峰')
    expect(system).not.toContain('不该出现的旧条目')
    // after_char 的排在角色设定之后
    expect(system.indexOf('角色书里的月珑峰')).toBeGreaterThan(system.indexOf('苏月珑的设定'))
    // 按 insertion_order 升序：全局(10) → 角色书(20) → 卡内嵌(30)
    expect(built.debug.loreActive.map((item) => item.source)).toEqual(['global', 'character', 'card'])
  })

  it('调试信息给出分段用量、预算丢弃与预设名', () => {
    const built = buildTavernPrompt({
      card,
      profile,
      history: [{ role: 'assistant', content: '我们去月珑峰吧。' }],
      userText: '好',
      lore,
      loreBudget: 1,
      dossier: '【前情提要】她在等你。',
      styleText: '【文风】古风。',
      instructions: ['【篇幅】不少于 100 字。'],
      preset: preset([prompt({ identifier: 'main', marker: true })])
    })
    expect(built.debug.presetName).toBe('测试预设')
    expect(built.debug.historyCount).toBe(1)
    // 常驻不占预算，关键词条目被 1 token 的预算挤掉
    expect(built.debug.loreActive.map((item) => item.name)).toEqual(['全局设定'])
    expect(built.debug.loreDropped.map((item) => item.name)).toEqual([
      '角色书条目',
      '卡内嵌条目'
    ])
    const labels = built.debug.pieces.map((item) => item.label)
    expect(labels).toContain('忆境典藏')
    expect(labels).toContain('文风')
    expect(labels).toContain('回复要求')
    expect(built.debug.totalTokens).toBeGreaterThan(built.debug.historyTokens)
  })

  it('卡有 system_prompt 且预设以 marker 给 main 时只出现一次', () => {
    // blocks.main 本身就是卡的系统提示，marker 走到它就算「已经有 main」；
    // 末尾那条兜底若再 unshift 一遍，指令会重复、token 也翻倍
    const built = buildTavernPrompt({
      card: { ...card, systemPrompt: '你是苏月珑，说话要清冷。' },
      profile,
      history: [{ role: 'assistant', content: '你来了。' }],
      userText: '嗯',
      preset: preset([
        prompt({ identifier: 'main', marker: true }),
        prompt({ identifier: 'chatHistory', marker: true })
      ])
    })
    const all = built.messages.map((item) => item.content).join('\n')
    expect(all.split('你是苏月珑，说话要清冷。')).toHaveLength(2)
  })

  it('预设没有 main 条目、卡也没写 system_prompt 时，默认角色指令照样发', () => {
    // 直通模板一定会发 blocks.main；预设路径漏了它，模型这轮就没被告知「扮演谁」
    const built = buildTavernPrompt({
      card,
      profile,
      history: [{ role: 'assistant', content: '你来了。' }],
      userText: '嗯',
      preset: preset([prompt({ identifier: 'chatHistory', marker: true })])
    })
    expect(built.messages[0]!.role).toBe('system')
    expect(built.messages[0]!.content).toContain('你将扮演「苏月珑」')
    // 只发一次
    const all = built.messages.map((item) => item.content).join('\n')
    expect(all.split('你将扮演「苏月珑」')).toHaveLength(2)
  })

  it('预设存在但条目全空时按直通模板装配，世界书仍逐条记账', () => {
    const built = buildTavernPrompt({
      card,
      profile,
      history: [{ role: 'assistant', content: '我们去月珑峰吧。' }],
      userText: '好',
      lore,
      preset: preset([])
    })
    // 预设是空的 → 走直通模板，世界书确实进了 system，调试里就不能整块漏记
    expect(built.messages[0]!.content).toContain('全局常驻')
    expect(built.debug.pieces.map((item) => item.source)).toContain('lore:global')
  })

  it('worldInfoBefore marker 被取消勾选时仍兜底注入（不能算作已留占位点）', () => {
    const built = buildTavernPrompt({
      card,
      profile,
      history: [{ role: 'assistant', content: '我们去月珑峰吧。' }],
      userText: '好',
      lore,
      preset: preset([
        // 条目还在，但用户把它的勾去掉了：它不产出内容，兜底注入就得接上
        prompt({ identifier: 'worldInfoBefore', marker: true, enabled: false }),
        prompt({ identifier: 'worldInfoAfter', marker: true }),
        prompt({ identifier: 'chatHistory', marker: true })
      ])
    })
    // 默认角色指令会被 unshift 到最前面，所以整条链一起看
    const all = built.messages.map((item) => item.content).join('\n')
    expect(all).toContain('全局常驻')
    expect(all).toContain('卡内嵌的月珑峰')
    expect(all).toContain('角色书里的月珑峰')
    expect(built.debug.pieces.map((item) => item.label)).toContain('角色定义前世界书')
  })

  it('预设路径下世界书不重复记账：已由 marker 注入就不再多列一遍', () => {
    const built = buildTavernPrompt({
      card,
      profile,
      history: [{ role: 'assistant', content: '我们去月珑峰吧。' }],
      userText: '好',
      lore,
      preset: preset([
        prompt({ identifier: 'worldInfoBefore', marker: true }),
        prompt({ identifier: 'worldInfoAfter', marker: true }),
        prompt({ identifier: 'chatHistory', marker: true })
      ])
    })
    // 世界书已经算在 worldInfoBefore / After 那两段里
    expect(built.debug.pieces.some((item) => item.source.startsWith('lore'))).toBe(false)
    expect(built.debug.pieces.map((item) => item.label)).toContain('worldInfoBefore')
  })
})
