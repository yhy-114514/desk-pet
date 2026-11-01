// 群聊的纯逻辑：消息里的「名字：内容」怎么认、被 @ 的是谁、打分失败时谁来兜底。
// 主进程（调度 / 装配提示词）与渲染层（显示发言人）共用这一份，
// 免得两边对「谁在说话」的判断各写一套、慢慢长歪。

/** 群聊最少 / 最多几个人。一个人没得聊，五个人以上就开始刷屏 */
export const GROUP_MIN_MEMBERS = 2
export const GROUP_MAX_MEMBERS = 5

/** 一轮最多几个人接话。再多就变成刷屏，验收口径也是「不刷屏」 */
export const MAX_GROUP_SPEAKERS = 2

/** 打分过这个线才接话；没过就按轮数轮流，保证这一轮总有人说 */
export const GROUP_SCORE_THRESHOLD = 0.5

/** 开局的名字前缀：`阿蕾：` / `阿蕾:`，允许前面有引号或空格 */
const SPEAKER_PREFIX = /^[\s「『]*([^：:\n]{1,24})[：:][ \t]*/

/** 把一条群聊消息拆成「谁说的 + 说了什么」。名字不在成员表里就当没有前缀。 */
export function parseSpeaker(
  content: string,
  names: string[]
): { speaker: string | null; text: string } {
  const match = SPEAKER_PREFIX.exec(content)
  const name = match?.[1]?.trim() ?? ''
  if (match && names.includes(name)) return { speaker: name, text: content.slice(match[0].length) }
  return { speaker: null, text: content }
}

/**
 * 流式版：名字前缀可能被拆在两个 token 里（先来「阿」再来「蕾：」），
 * 所以「目前只收到某个名字的一半」时先扣住，等下一块拼上再说。
 * 扣住的长度最多一个名字，不会吞正文。
 */
export function stripSpeakerPrefix(raw: string, names: string[]): string {
  const { speaker, text } = parseSpeaker(raw, names)
  if (speaker) return text
  const head = raw.trimStart()
  // 名字收全了但那半句「：」还没来，也先扣住
  if (head && names.some((name) => name.startsWith(head))) return ''
  return raw
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 被 @ 点名的成员，按在文本里出现的先后排；最多 MAX_GROUP_SPEAKERS 个（@ 再多也只回两个） */
export function pickNamedSpeakers(text: string, names: string[]): string[] {
  if (names.length === 0) return []
  // 长名字排在前面：「@阿蕾蕾」不能被当成 @阿蕾，否则同名的短名字也会被点名
  const longest = [...names].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`[@＠]\\s*(${longest.map(escapeRegExp).join('|')})`, 'g')
  const hits: string[] = []
  for (const match of text.matchAll(pattern)) {
    const name = match[1] ?? ''
    if (name && !hits.includes(name)) hits.push(name)
  }
  return hits.slice(0, MAX_GROUP_SPEAKERS)
}

/**
 * 打分失败 / 全都没过阈值时的兜底：按轮数轮流。
 * 宁可让一个人接话，也不要没人说话或者每次都同一个。
 */
export function fallbackSpeaker(names: string[], turnCount: number): string | null {
  if (names.length === 0) return null
  return names[Math.abs(turnCount) % names.length] ?? null
}
