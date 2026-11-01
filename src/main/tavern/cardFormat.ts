// SillyTavern 角色卡格式（v2）与内部结构的互转。纯逻辑，不碰 DB / 文件。
//
// v2 卡长这样：{ spec: 'chara_card_v2', spec_version: '2.0', data: { name, first_mes, ... } }
// 早年的 v1 卡没有 data 那层，字段直接平铺在根上——两边都得认，否则老卡全导不进来。

export interface TavernCard {
  id: string
  name: string
  description: string
  personality: string
  scenario: string
  firstMes: string
  alternateGreetings: string[]
  mesExample: string
  systemPrompt: string
  postHistoryInstructions: string
  creator: string
  creatorNotes: string
  tags: string[]
  avatarPath: string | null // avatars/ 下的文件名；null = 没有立绘
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

/** 可编辑的字段（id / 时间戳由数据层负责） */
export type CardInput = Omit<TavernCard, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>

/** 卡信封上的版本标签：v2 / v3。新建的卡没有（导出按 v2 写）。 */
export interface CardSpec {
  spec: string
  specVersion: string
}

export interface ParsedStCard {
  /** 界面上看得到、编辑得了的那些字段 */
  fields: CardInput
  /**
   * ST 卡里 `data` 那层的原样对象。
   * 世界书（character_book）、正则与脚本（extensions）、群聊开场白等全在里面，
   * 不留在库里的话，导出的卡就是一张残卡。
   */
  data: Record<string, unknown>
  /** 原卡的版本标签；v1（没有 spec）与结构不明的卡是 null */
  spec: CardSpec | null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** 解析卡里的 JSON 文本（PNG 里的 base64 解开后也是走这里）。字段缺了补空，没有就报错。 */
export function parseStCardFull(text: string): ParsedStCard {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON')
  }
  if (!raw || typeof raw !== 'object') throw new Error('卡里没有角色数据')

  const outer = raw as Record<string, unknown>
  // v2 / v3 包在 data 里；v1 平铺在根上
  const data =
    outer.data && typeof outer.data === 'object'
      ? (outer.data as Record<string, unknown>)
      : outer
  // v3 的 spec_version 是 "3.0"：记下原值，导出时原样写回。
  // v1（没有 spec）不记——它没有 data 外壳，导回去只能是 v2
  const spec =
    typeof outer.spec === 'string' && outer.spec.startsWith('chara_card')
      ? {
          spec: outer.spec,
          specVersion:
            str(outer.spec_version) || (outer.spec === 'chara_card_v3' ? '3.0' : '2.0')
        }
      : null

  const name = str(data.name).trim()
  if (!name) throw new Error('卡里缺少角色名')

  return {
    fields: {
      name,
      description: str(data.description),
      personality: str(data.personality),
      scenario: str(data.scenario),
      firstMes: str(data.first_mes),
      alternateGreetings: strList(data.alternate_greetings).filter((line) => line.trim() !== ''),
      mesExample: str(data.mes_example),
      systemPrompt: str(data.system_prompt),
      postHistoryInstructions: str(data.post_history_instructions),
      creator: str(data.creator),
      creatorNotes: str(data.creator_notes),
      tags: strList(data.tags)
        .map((tag) => tag.trim())
        .filter(Boolean),
      avatarPath: null
    },
    data,
    spec
  }
}

/** 只要字段版本的解析（调用方不关心原始 data 时用）。 */
export function parseStCard(text: string): CardInput {
  return parseStCardFull(text).fields
}

/** 把（可能被用户改过的）字段覆盖到原始 data 上，其余键——世界书 / 正则 / 扩展——原样保留。 */
export function mergeCardFields(
  base: Record<string, unknown>,
  card: TavernCard | CardInput
): Record<string, unknown> {
  return {
    ...base,
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.firstMes,
    alternate_greetings: card.alternateGreetings,
    mes_example: card.mesExample,
    system_prompt: card.systemPrompt,
    post_history_instructions: card.postHistoryInstructions,
    creator: card.creator,
    creator_notes: card.creatorNotes,
    tags: card.tags
  }
}

/**
 * 内部结构 → ST 卡。给了 rawData 就在原卡上覆盖字段（保真导出），没给就现拼一张新的。
 * `spec` 是原卡的版本标签：v3 卡原样写回 v3，没记过（新建卡 / v1 导入）按 v2 写。
 */
export function toStCard(
  card: TavernCard | CardInput,
  rawData?: Record<string, unknown> | null,
  spec?: CardSpec | null
): Record<string, unknown> {
  return {
    spec: spec?.spec ?? 'chara_card_v2',
    spec_version: spec?.specVersion ?? '2.0',
    data: rawData
      ? mergeCardFields(rawData, card)
      : { ...mergeCardFields({}, card), extensions: {} }
  }
}

/**
 * 进聊天时的开场白：主开场白 + 备选里随机挑一条。
 * 全为空返回空串（T2 用空串表示「这张卡没写开场白」，不要塞一句假的）。
 */
export function pickGreeting(
  card: Pick<CardInput, 'firstMes' | 'alternateGreetings'>,
  random: () => number = Math.random
): string {
  const options = [card.firstMes, ...card.alternateGreetings]
    .map((line) => line.trim())
    .filter(Boolean)
  if (options.length === 0) return ''
  // random() 理论上取不到 1，但兜一下免得越界
  const index = Math.min(options.length - 1, Math.floor(random() * options.length))
  return options[index]!
}
