// 群聊提示词装配（T8）：把成员设定、群聊规则、世界书、历史拼成一次请求。
// 每轮只让一个角色说话，所以「这一轮轮到谁」由调用方作为 speaker 传进来；
// 纯函数，不碰 DB / 网络，方便单测。
import {
  DEFAULT_BUDGET,
  substitutePlaceholders,
  trimToBudget,
  type ChatMessage
} from './promptBuilder'
import type { LoreEntry } from './worldbook'

export interface GroupMember {
  id: string
  name: string
  avatarPath: string | null
  description: string
  personality: string
  scenario: string
}

/** 成员设定里每个字段最多喂这么多字：三个人加起来也别把预算吃光 */
const MEMBER_FIELD_CHARS = 800

const GROUP_RULES = `【群聊规则】
- 这是一个多人群聊。你只扮演「{speaker}」这一个人，用第一人称说话。
- 不要替其他角色或玩家说话，也不要写他们没说过的台词。
- 一次只说一小段（2~5 句），像在群里聊天：可以顺着别人的话接，也可以主动找话。
- 不要输出 markdown、代码块或任何尖括号标签。
- 直接说台词，不要在开头写「{speaker}：」。`

export interface GroupPromptInput {
  groupName: string
  members: GroupMember[]
  profile: { name: string; description: string }
  /** 这一轮谁说话 */
  speaker: string
  /** 本轮激活的世界书条目（所有成员的世界书合并后按关键词筛过） */
  lore: LoreEntry[]
  styleText?: string
}

/** 群聊的 system：规则 + 成员设定 + 玩家 + 世界设定 + 文风 */
export function buildGroupSystem(input: GroupPromptInput): string {
  const speaker = input.speaker
  const names = input.members.map((member) => member.name)
  const parts: string[] = [
    `【群聊】「${input.groupName}」的群聊，成员：${names.join('、')}。和你说话的人叫「${input.profile.name}」。`,
    GROUP_RULES.replace(/\{speaker\}/g, () => speaker)
  ]

  const user = input.profile.name
  // 卡里遍地是 {{char}} / {{user}}（「{{user}}是{{char}}的学生」这种），
  // 不替换就原样发给模型，成员设定和扮演对象会错位——单聊路径一直是替换的
  const forSpeaker = (value: string): string =>
    substitutePlaceholders(value, { char: speaker, user })
  const roster = input.members.map((member) => {
    const lines = [`【${member.name}】`]
    const field = (label: string, value: string): void => {
      const text = substitutePlaceholders(value, { char: member.name, user }).trim()
      if (text) lines.push(label ? `${label}：${text.slice(0, MEMBER_FIELD_CHARS)}` : text.slice(0, MEMBER_FIELD_CHARS))
    }
    field('', member.description)
    field('性格', member.personality)
    field('处境', member.scenario)
    return lines.join('\n')
  })
  parts.push(`【成员设定】\n${roster.join('\n\n')}`)

  const profileText = forSpeaker(input.profile.description).trim()
  parts.push(
    profileText
      ? `【${input.profile.name}】\n${profileText.slice(0, MEMBER_FIELD_CHARS)}`
      : `【${input.profile.name}】\n（玩家没有写设定）`
  )

  if (input.lore.length > 0) {
    parts.push(
      `【世界设定】\n${input.lore.map((entry) => forSpeaker(entry.content)).join('\n\n')}`
    )
  }
  const styleText = input.styleText ? forSpeaker(input.styleText).trim() : ''
  if (styleText) parts.push(styleText)
  return parts.join('\n\n')
}

/** system + 历史 + 本轮输入；历史按预算从早裁，本轮输入不裁。 */
export function buildGroupPrompt(input: {
  system: string
  history: ChatMessage[]
  userText: string
}): ChatMessage[] {
  const history = trimToBudget(
    input.history.filter((item) => item.content.trim() !== ''),
    input.userText,
    DEFAULT_BUDGET
  )
  const messages: ChatMessage[] = [{ role: 'system', content: input.system }, ...history]
  if (input.userText.trim()) messages.push({ role: 'user', content: input.userText })
  return messages
}

/** 谁该接话的打分请求（便宜模型、JSON 模式）。 */
export function buildScoreMessages(
  names: string[],
  history: string[],
  userText: string
): ChatMessage[] {
  const transcript = history
    .map((line) => line.replace(/\s+/g, ' ').trim().slice(0, 300))
    .filter(Boolean)
    .join('\n')
  return [
    {
      role: 'system',
      content:
        '你在判断一个多人群聊里，接下来哪位角色最可能接话。' +
        `成员：${names.join('、')}。` +
        '只输出 JSON 对象：{"scores":{"角色名":0到1的小数,…}}，越可能接话分数越高，不要解释。'
    },
    {
      role: 'user',
      content: `${transcript ? `最近的对话：\n${transcript}\n\n` : ''}玩家刚说：${userText}`
    }
  ]
}

/** 从打分结果里抠出每个名字的分数。模型可能给对象外壳、也可能只给 `"阿蕾": 0.8`。 */
export function parseScores(raw: string, names: string[]): Record<string, number> | null {
  const text = raw.trim()
  if (!text) return null
  const scores: Record<string, number> = {}
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1))
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>
        const inner = record['scores']
        const table =
          inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : record
        for (const [key, value] of Object.entries(table)) {
          if (typeof value === 'number' && Number.isFinite(value)) scores[key] = value
        }
      }
    } catch {
      // 非法 JSON：走下面的逐个名字兜底
    }
  }
  if (Object.keys(scores).length === 0) {
    for (const name of names) {
      const match = new RegExp(`"?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s*[:：]\\s*([0-9]+(?:\\.[0-9]+)?)`).exec(
        text
      )
      if (match) scores[name] = Number(match[1])
    }
  }
  return Object.keys(scores).length > 0 ? scores : null
}
