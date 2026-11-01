// 预设：ST 导入（采样 / markers / prompt_order 勾选）、导出回环、装配顺序、宏。
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SAMPLING,
  applyMacros,
  orderedPrompts,
  parseStPreset,
  requestSampling,
  toStPreset,
  type PresetData
} from './preset'

const stPreset = {
  name: '双人成行',
  temperature: 1.2,
  top_p: 0.9,
  top_k: 40,
  min_p: 0.05,
  frequency_penalty: 0.3,
  presence_penalty: 0.2,
  openai_max_tokens: 2048,
  prompts: [
    { identifier: 'main', name: '主提示', content: '', marker: true, role: 'system', enabled: true },
    { identifier: 'charDescription', name: '角色描述', content: '', marker: true },
    { identifier: 'chatHistory', name: '历史', content: '', marker: true },
    { identifier: 'cot', name: '思维链', content: '先想再写', role: 'system', enabled: true },
    { identifier: 'style', name: '文风', content: '轻松温馨', role: 'system', enabled: true },
    { identifier: 'deep', name: '深度注入', content: '别忘了设定', injection_position: 1, injection_depth: 2 }
  ],
  prompt_order: [
    {
      character_id: 100001,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'charDescription', enabled: true },
        { identifier: 'cot', enabled: true },
        { identifier: 'style', enabled: false },
        { identifier: 'chatHistory', enabled: true }
      ]
    },
    { character_id: 999, order: [{ identifier: 'main', enabled: true }] }
  ]
}

describe('parseStPreset', () => {
  it('读采样参数与条目', () => {
    const preset = parseStPreset(JSON.stringify(stPreset))
    expect(preset.name).toBe('双人成行')
    expect(preset.sampling).toMatchObject({
      temperature: 1.2,
      topP: 0.9,
      topK: 40,
      maxTokens: 2048
    })
    expect(preset.prompts).toHaveLength(6)
    expect(preset.prompts[0]).toMatchObject({ identifier: 'main', marker: true })
  })

  it('prompt_order 里的勾选覆盖条目自身 enabled（ST 的存法）', () => {
    const preset = parseStPreset(JSON.stringify(stPreset))
    const style = preset.prompts.find((item) => item.identifier === 'style')!
    expect(style.enabled).toBe(false)
    // 顺序表没提到的条目保留自己的 enabled
    expect(preset.prompts.find((item) => item.identifier === 'deep')!.enabled).toBe(true)
  })

  it('只取第一套非空 prompt_order，深度注入字段读进来', () => {
    const preset = parseStPreset(JSON.stringify(stPreset))
    expect(preset.order.map((item) => item.identifier)).toEqual([
      'main',
      'charDescription',
      'cot',
      'style',
      'chatHistory'
    ])
    const deep = preset.prompts.find((item) => item.identifier === 'deep')!
    expect(deep).toMatchObject({ injectionPosition: 1, injectionDepth: 2 })
  })

  it('老写法 system_prompt:true 也算 marker；没有 identifier 的条目丢弃', () => {
    const preset = parseStPreset(
      JSON.stringify({
        prompts: [
          { identifier: 'main', system_prompt: true, content: '' },
          { name: '没 id', content: 'x' }
        ]
      })
    )
    expect(preset.prompts).toHaveLength(1)
    expect(preset.prompts[0]!.marker).toBe(true)
  })

  it('缺字段时用默认采样；坏 JSON 报错', () => {
    const preset = parseStPreset('{}', '兜底名')
    expect(preset.name).toBe('兜底名')
    expect(preset.sampling).toEqual(DEFAULT_SAMPLING)
    expect(() => parseStPreset('nope')).toThrow()
  })
})

describe('toStPreset', () => {
  it('导出再导入，markers / 勾选 / 采样都不丢', () => {
    const first = parseStPreset(JSON.stringify(stPreset))
    const second = parseStPreset(toStPreset(first))
    expect(second.sampling).toEqual(first.sampling)
    expect(second.prompts.map((item) => [item.identifier, item.marker, item.enabled])).toEqual(
      first.prompts.map((item) => [item.identifier, item.marker, item.enabled])
    )
    expect(second.order).toEqual(first.order)
  })
})

describe('orderedPrompts', () => {
  const base: PresetData = parseStPreset(JSON.stringify(stPreset))

  it('按 prompt_order 排序并跳过未启用', () => {
    expect(orderedPrompts(base).map((item) => item.identifier)).toEqual([
      'main',
      'charDescription',
      'cot',
      'chatHistory',
      // 顺序表没提到的启用条目接在尾部
      'deep'
    ])
  })

  it('没有 order 时按条目原顺序，只留启用的', () => {
    const preset: PresetData = {
      ...base,
      order: [],
      prompts: base.prompts.map((item) => ({ ...item, enabled: item.identifier !== 'cot' }))
    }
    expect(orderedPrompts(preset).map((item) => item.identifier)).not.toContain('cot')
    expect(orderedPrompts(preset)[0]!.identifier).toBe('main')
  })
})

describe('applyMacros', () => {
  it('注释剥掉、setvar 存值且自身不输出、getvar 取回', () => {
    const vars = new Map<string, string>()
    const out = applyMacros('{{//说明}}{{setvar::语气::温柔}}{{getvar::语气}}地说话{{trim}}', vars)
    expect(out).toBe('温柔地说话')
    expect(vars.get('语气')).toBe('温柔')
  })

  it('没定义的变量取空串', () => {
    expect(applyMacros('甲{{getvar::不存在}}乙')).toBe('甲乙')
  })
})

describe('requestSampling', () => {
  it('有预设用预设，没有用兜底', () => {
    const preset = parseStPreset(JSON.stringify(stPreset))
    expect(requestSampling(preset, 1, 1200)).toEqual({ temperature: 1.2, maxTokens: 2048 })
    expect(requestSampling(null, 1, 1200)).toEqual({ temperature: 1, maxTokens: 1200 })
  })

  it('openai_max_tokens: 0（用后端默认）不能原样发出去', () => {
    const preset = parseStPreset(JSON.stringify({ ...stPreset, openai_max_tokens: 0 }))
    expect(requestSampling(preset, 1, 1200).maxTokens).toBe(1200)
  })
})
