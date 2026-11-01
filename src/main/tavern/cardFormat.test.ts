// 卡格式转换是导入导出的中枢：字段映射错一个，导进去的卡就静默丢一段设定。
import { describe, expect, it } from 'vitest'
import {
  mergeCardFields,
  parseStCard,
  parseStCardFull,
  pickGreeting,
  toStCard,
  type TavernCard
} from './cardFormat'

const V2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '  阿蕾  ',
    description: '深海里的灯塔看守人。',
    personality: '安静',
    scenario: '暴风雨夜',
    first_mes: '你终于来了。',
    mes_example: '{{user}}: 你好\n{{char}}: 嗯。',
    system_prompt: '保持沉默寡言',
    post_history_instructions: '不要跳出角色',
    alternate_greetings: ['第二句开场', '   ', '第三句开场'],
    tags: ['奇幻', ' 温柔 '],
    creator: '某人',
    creator_notes: '测试卡'
  }
}

describe('ST v2 卡格式', () => {
  it('v2 卡按 data 取字段，名字去空白、空备选开场白丢掉', () => {
    const card = parseStCard(JSON.stringify(V2))
    expect(card.name).toBe('阿蕾')
    expect(card.description).toBe('深海里的灯塔看守人。')
    expect(card.firstMes).toBe('你终于来了。')
    expect(card.alternateGreetings).toEqual(['第二句开场', '第三句开场'])
    expect(card.tags).toEqual(['奇幻', '温柔'])
    expect(card.avatarPath).toBeNull()
  })

  it('v1 老卡的字段平铺在根上，也要认得', () => {
    const flat = { name: '老卡', description: '没有 data 那层', first_mes: '嗨' }
    const card = parseStCard(JSON.stringify(flat))
    expect(card.name).toBe('老卡')
    expect(card.description).toBe('没有 data 那层')
    expect(card.firstMes).toBe('嗨')
  })

  it('缺角色名 / 不是 JSON 都直接抛错，不为坏卡建空记录', () => {
    expect(() => parseStCard(JSON.stringify({ description: '没有名字' }))).toThrow('角色名')
    expect(() => parseStCard(JSON.stringify({ data: { name: '  ' } }))).toThrow('角色名')
    expect(() => parseStCard('not json')).toThrow('JSON')
  })

  it('导出的结构是 SillyTavern 认的 v2 卡', () => {
    const now = Date.now()
    const card: TavernCard = {
      id: 'x',
      name: '阿蕾',
      description: 'd',
      personality: 'p',
      scenario: 's',
      firstMes: 'f',
      alternateGreetings: ['a1'],
      mesExample: 'e',
      systemPrompt: 'sp',
      postHistoryInstructions: 'phi',
      creator: 'c',
      creatorNotes: 'cn',
      tags: ['t'],
      avatarPath: 'a.png',
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    }
    const exported = toStCard(card) as { spec: string; data: Record<string, unknown> }
    expect(exported.spec).toBe('chara_card_v2')
    expect(exported.data['first_mes']).toBe('f')
    expect(exported.data['alternate_greetings']).toEqual(['a1'])
    expect(exported.data['post_history_instructions']).toBe('phi')
    // 导回去还能原样读出来
    expect(parseStCard(JSON.stringify(exported)).name).toBe('阿蕾')
  })

  it('开场白从主 + 备选里随机挑，全空就是空串', () => {
    const card = { firstMes: '主', alternateGreetings: ['备1', '备2'] }
    expect(pickGreeting(card, () => 0)).toBe('主')
    expect(pickGreeting(card, () => 0.5)).toBe('备1')
    expect(pickGreeting(card, () => 0.999)).toBe('备2')
    // 边界：random 返回 1 也不能越界
    expect(pickGreeting(card, () => 1)).toBe('备2')
    expect(pickGreeting({ firstMes: '  ', alternateGreetings: [] })).toBe('')
  })
})

// 编辑页只管 12 个平铺字段；世界书 / 正则 / 扩展 / 群聊开场白必须原样带出去
const RICH = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '苏月珑',
    description: '修仙者',
    first_mes: '徒儿，起床了',
    group_only_greetings: ['群聊开场一'],
    character_version: '1.2',
    character_book: {
      name: '设定',
      entries: [{ keys: ['月珑峰'], content: '灵峰设定', constant: false, position: 'before_char' }]
    },
    extensions: {
      depth_prompt: { depth: 4, prompt: '思维链', role: 'system' },
      piupiu_regex: { enabled: true, scripts: [{ findRegex: '<update>[\\s\\S]*?</update>' }] }
    }
  }
}

describe('卡的原始 data 保真', () => {
  it('parseStCardFull 把 data 那层原样交出来', () => {
    const parsed = parseStCardFull(JSON.stringify(RICH))
    expect(parsed.fields.name).toBe('苏月珑')
    expect(parsed.data).toEqual((RICH as { data: Record<string, unknown> }).data)
  })

  it('带 rawData 导出时，世界书 / 扩展 / 群聊开场白逐字保留', () => {
    const parsed = parseStCardFull(JSON.stringify(RICH))
    const exported = toStCard(parsed.fields, parsed.data) as { data: Record<string, unknown> }
    expect(exported.data['character_book']).toEqual(RICH.data.character_book)
    expect(exported.data['extensions']).toEqual(RICH.data.extensions)
    expect(exported.data['group_only_greetings']).toEqual(['群聊开场一'])
    expect(exported.data['character_version']).toBe('1.2')
  })

  it('改了字段再合并，只覆盖改到的键，其余不动', () => {
    const parsed = parseStCardFull(JSON.stringify(RICH))
    const edited = { ...parsed.fields, description: '改写后的人设' }
    const exported = toStCard(edited, parsed.data) as { data: Record<string, unknown> }
    expect(exported.data['description']).toBe('改写后的人设')
    expect(exported.data['character_book']).toEqual(RICH.data.character_book)
    expect(exported.data['extensions']).toEqual(RICH.data.extensions)
  })

  it('mergeCardFields 不修改传入的对象（合并要能反复做）', () => {
    const base = { name: '旧名', character_book: { entries: [] } }
    const merged = mergeCardFields(base, { ...parseStCard(JSON.stringify(RICH)), name: '新名' })
    expect(merged['name']).toBe('新名')
    expect(base['name']).toBe('旧名')
  })

  it('新建卡（没有 rawData）导出仍是合法 v2，扩展补空对象', () => {
    const exported = toStCard(parseStCard(JSON.stringify(V2))) as { data: Record<string, unknown> }
    expect(exported.data['extensions']).toEqual({})
    expect(exported.data['name']).toBe('阿蕾')
  })

  it('v3 卡的版本标签原样带出去，不会降级写成 v2', () => {
    const v3 = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: '赵泠', description: '' } }
    const parsed = parseStCardFull(JSON.stringify(v3))
    expect(parsed.spec).toEqual({ spec: 'chara_card_v3', specVersion: '3.0' })
    const exported = toStCard(parsed.fields, parsed.data, parsed.spec) as {
      spec: string
      spec_version: string
    }
    expect(exported.spec).toBe('chara_card_v3')
    expect(exported.spec_version).toBe('3.0')
  })

  it('v3 卡没写 spec_version 时按 3.0 补，v1 不记标签（导出仍是 v2）', () => {
    expect(parseStCardFull(JSON.stringify({ spec: 'chara_card_v3', data: { name: 'a' } })).spec).toEqual({
      spec: 'chara_card_v3',
      specVersion: '3.0'
    })
    expect(parseStCardFull(JSON.stringify({ name: 'b', first_mes: '嗨' })).spec).toBeNull()
  })
})
