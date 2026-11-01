// 预设（Prompt Manager）的纯逻辑：条目模型、ST 预设导入、宏、装配顺序。
// 真实预设的体量是「采样参数 + 200 多条可勾选注入」，其中 marker 条目定义
// 角色描述 / 历史这些卡字段插在哪个占位点（见 TAVERN_ROADMAP §四·二）。
//
// 这里只负责「哪些条目、什么顺序、内容处理成什么样」；
// 真正拼成 messages 的活由 promptBuilder 干（它才知道历史与预算）。

export type PresetRole = 'system' | 'user' | 'assistant'

export interface PresetPrompt {
  identifier: string
  name: string
  content: string
  role: PresetRole
  enabled: boolean
  /** marker：内容为空，代表卡字段 / 历史插在这里 */
  marker: boolean
  /** 1 = 插到历史里第 injectionDepth 条（ST 的 injection_position） */
  injectionPosition: 0 | 1
  injectionDepth: number
}

export interface SamplingParams {
  temperature: number
  topP: number
  topK: number
  minP: number
  frequencyPenalty: number
  presencePenalty: number
  maxTokens: number
}

export interface PresetData {
  name: string
  sampling: SamplingParams
  prompts: PresetPrompt[]
  /** 装配顺序；为空时按 prompts 原顺序 */
  order: { identifier: string; enabled: boolean }[]
}

/** 我们认识的 marker。不认识的 marker 有内容就按普通条目注入（很多预设这么用）。 */
export const MARKER_IDS = [
  'main',
  'worldInfoBefore',
  'worldInfoAfter',
  'charDescription',
  'charPersonality',
  'scenario',
  'personaDescription',
  'dialogueExamples',
  'chatHistory',
  'postHistoryInstructions'
] as const

export type MarkerId = (typeof MARKER_IDS)[number]

export function isMarkerId(id: string): id is MarkerId {
  return (MARKER_IDS as readonly string[]).includes(id)
}

export const DEFAULT_SAMPLING: SamplingParams = {
  temperature: 1,
  topP: 1,
  topK: 0,
  minP: 0,
  frequencyPenalty: 0,
  presencePenalty: 0,
  maxTokens: 1200
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function roleOf(value: unknown): PresetRole {
  return value === 'user' || value === 'assistant' ? value : 'system'
}

/**
 * 导入 ST 预设 JSON。
 * 顶层是采样参数；`prompts[]` 是条目；`prompt_order` 是若干套顺序
 * （每套对应一个 character_id，通用那套通常是 100001），取第一套非空的。
 */
export function parseStPreset(raw: string, fallbackName = '导入的预设'): PresetData {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('不是合法的 JSON 预设')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('预设格式不对')
  const record = parsed as Record<string, unknown>

  const sampling: SamplingParams = {
    temperature: num(record['temperature'], DEFAULT_SAMPLING.temperature),
    topP: num(record['top_p'], DEFAULT_SAMPLING.topP),
    topK: num(record['top_k'], DEFAULT_SAMPLING.topK),
    minP: num(record['min_p'], DEFAULT_SAMPLING.minP),
    frequencyPenalty: num(record['frequency_penalty'], DEFAULT_SAMPLING.frequencyPenalty),
    presencePenalty: num(record['presence_penalty'], DEFAULT_SAMPLING.presencePenalty),
    maxTokens: num(record['openai_max_tokens'] ?? record['max_tokens'], DEFAULT_SAMPLING.maxTokens)
  }

  const rawPrompts = Array.isArray(record['prompts']) ? record['prompts'] : []
  const prompts: PresetPrompt[] = []
  for (const item of rawPrompts) {
    if (!item || typeof item !== 'object') continue
    const prompt = item as Record<string, unknown>
    const identifier =
      typeof prompt['identifier'] === 'string'
        ? prompt['identifier']
        : typeof prompt['id'] === 'string'
          ? prompt['id']
          : ''
    if (!identifier) continue
    // system_prompt: true 的老 marker 写法；marker 字段是现写法
    const marker = prompt['marker'] === true || prompt['system_prompt'] === true
    prompts.push({
      identifier,
      name: typeof prompt['name'] === 'string' ? prompt['name'] : identifier,
      content: typeof prompt['content'] === 'string' ? prompt['content'] : '',
      role: roleOf(prompt['role']),
      enabled: prompt['enabled'] !== false,
      marker,
      injectionPosition: prompt['injection_position'] === 1 ? 1 : 0,
      injectionDepth: num(prompt['injection_depth'], 4)
    })
  }

  const order: { identifier: string; enabled: boolean }[] = []
  const rawOrder = record['prompt_order']
  if (Array.isArray(rawOrder)) {
    for (const set of rawOrder) {
      if (!set || typeof set !== 'object') continue
      const list = (set as Record<string, unknown>)['order']
      if (!Array.isArray(list) || list.length === 0) continue
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue
        const item = entry as Record<string, unknown>
        const identifier = typeof item['identifier'] === 'string' ? item['identifier'] : ''
        if (!identifier) continue
        order.push({ identifier, enabled: item['enabled'] !== false })
      }
      break
    }
  }

  // order 里的勾选状态覆盖条目自身的 enabled（ST 就是这么存的：条目一直开，靠顺序表勾）
  const enabledById = new Map(order.map((item) => [item.identifier, item.enabled]))
  for (const prompt of prompts) {
    const enabled = enabledById.get(prompt.identifier)
    if (enabled !== undefined) prompt.enabled = enabled
  }

  const name =
    typeof record['name'] === 'string' && record['name'].trim() ? record['name'] : fallbackName
  return { name, sampling, prompts, order }
}

/** 导出回 ST 形状，至少保证重新导入后 markers 与勾选状态不丢。 */
export function toStPreset(preset: PresetData): string {
  return JSON.stringify(
    {
      name: preset.name,
      temperature: preset.sampling.temperature,
      top_p: preset.sampling.topP,
      top_k: preset.sampling.topK,
      min_p: preset.sampling.minP,
      frequency_penalty: preset.sampling.frequencyPenalty,
      presence_penalty: preset.sampling.presencePenalty,
      openai_max_tokens: preset.sampling.maxTokens,
      prompts: preset.prompts.map((prompt) => ({
        identifier: prompt.identifier,
        name: prompt.name,
        content: prompt.content,
        role: prompt.role,
        enabled: prompt.enabled,
        marker: prompt.marker,
        injection_position: prompt.injectionPosition,
        injection_depth: prompt.injectionDepth
      })),
      prompt_order: [{ character_id: 100001, order: preset.order }]
    },
    null,
    2
  )
}

/**
 * 按 prompt_order 排好序、只留启用的条目。
 * 没给 order 时按 prompts 原顺序（导入时已经按文件顺序了）。
 */
export function orderedPrompts(preset: PresetData): PresetPrompt[] {
  const byId = new Map(preset.prompts.map((prompt) => [prompt.identifier, prompt]))
  if (preset.order.length === 0) return preset.prompts.filter((prompt) => prompt.enabled)
  const result: PresetPrompt[] = []
  const seen = new Set<string>()
  for (const item of preset.order) {
    if (!item.enabled) continue
    const prompt = byId.get(item.identifier)
    if (!prompt || seen.has(prompt.identifier) || !prompt.enabled) continue
    seen.add(prompt.identifier)
    result.push(prompt)
  }
  // 顺序表里没提到、但条目自己是启用的（手改过的预设）：接在后面
  for (const prompt of preset.prompts) {
    if (!prompt.enabled || seen.has(prompt.identifier)) continue
    result.push(prompt)
  }
  return result
}

/**
 * ST 宏：`{{//注释}}`、`{{setvar::名::值}}`、`{{getvar::名}}`、`{{trim}}`。
 * 变量是这一轮装配内的（跨轮持久变量属于 MVU，见 mvu.ts），不写 DB。
 */
export function applyMacros(text: string, vars: Map<string, string> = new Map()): string {
  let out = text.replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
  out = out.replace(/\{\{setvar::([^:}]+?)::([\s\S]*?)\}\}/g, (_all, name: string, value: string) => {
    vars.set(name.trim(), value)
    return ''
  })
  out = out.replace(/\{\{getvar::([^:}]+?)\}\}/g, (_all, name: string) => vars.get(name.trim()) ?? '')
  out = out.replace(/\{\{trim\}\}/g, '')
  return out
}

/** 预设里最常用的几项采样参数映射到请求体（top_k / min_p 接口不支持，忽略）。 */
export function requestSampling(preset: PresetData | null, fallbackTemperature: number, fallbackMaxTokens: number): {
  temperature: number
  maxTokens: number
} {
  const maxTokens = preset ? preset.sampling.maxTokens : fallbackMaxTokens
  return {
    temperature: preset ? preset.sampling.temperature : fallbackTemperature,
    // ST 里 `openai_max_tokens: 0` 表示「用后端默认」，原样发出去接口会直接 400
    maxTokens:
      Number.isFinite(maxTokens) && maxTokens >= 1 ? Math.round(maxTokens) : fallbackMaxTokens
  }
}
