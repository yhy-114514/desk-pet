// 情绪标记解析（纯逻辑，无 electron / fetch）：
// 人设要求她把每句回复的情绪写在开头，形如 `<emo:happy>完了完了…`。
// 流式场景下标记会被拆到多个 token，所以这里做的是「前缀判定」：
// 返回 done=false 表示还需要更多字符才能确定，调用方先攒着别往气泡推。

export const EMOTIONS = ['happy', 'sad', 'angry', 'surprised', 'shy', 'smug', 'normal'] as const
export type Emotion = (typeof EMOTIONS)[number]

/** 标记最长长度；超过还没闭合就认定这不是标记，原样放行，别把用户的话卡住。 */
export const EMOTION_TAG_MAX = 24

export interface EmotionPrefix {
  /** 是否可以放行（false = 前缀还没收完，继续攒） */
  done: boolean
  /** 识别到的情绪；没写标记或标记非法时为 null */
  emotion: Emotion | null
  /** 去掉标记后的正文 */
  rest: string
}

const TAG_PATTERN = /^<emo:([a-z]+)>/i

/**
 * 兜底清洗：人设要求标记打头，但模型偶尔会写在别处（`（小声）<emo:shy>那个…`）。
 * 那种情况下面的前缀判定会原样放行，于是标记会漏进气泡 / 历史 / 朗读 / 记忆抽取，
 * 所以落库前再扫一遍。
 */
export function stripEmotionTags(text: string): string {
  return text.replace(/<emo:[a-z]+>/gi, '')
}

/**
 * 写进聊天历史时把标记加回去。
 * 历史是模型最直接的「示范」：如果存进去的都是剥掉标记的正文，它会照着旧格式回，
 * 标记越打越少、最后干脆不打（实测 0/3），表情联动随之彻底失效。
 * 所以气泡和朗读用干净正文，历史里保留 `<emo:xxx>`，让上下文格式自洽。
 */
export function tagForHistory(emotion: Emotion | null, text: string): string {
  return emotion ? `<emo:${emotion}>${text}` : text
}

/**
 * 流式正文清洗：去掉正文里残留的情绪标记，并把末尾「可能只是半个标记」的片段扣下来。
 * 前缀判定只处理写在最开头的那一个；模型偶尔写在别处（`（小声）<emo:shy>那个…`），
 * 那种标记会原样进气泡。扣留是因为标记常被拆成两块推送：不扣住的话 `<emo:sh` 会先漏出去。
 */
export function stripStrayTags(text: string): { text: string; hold: string } {
  const clean = stripEmotionTags(text)
  // 末尾的 `<`、`<e`、`<emo:`、`<emo:happ` 这类残片先留着，等下一块拼上再判断
  const partial = clean.match(/<(?:\/?e(?:m(?:o(?::[a-z]*)?)?)?)?$/i)
  if (!partial) return { text: clean, hold: '' }
  return { text: clean.slice(0, clean.length - partial[0].length), hold: partial[0] }
}

const HAS_TAG = /^\s*<emo:[a-z]+>/i

/**
 * 旧版本把历史里助手的回复剥干净了再存。加载时补一个 `normal` 回去。
 * 不补就永远起不来：模型照着「不带标记」的历史回 → 这轮也没有标记 → 历史里依旧没有示范。
 */
export function tagLegacyHistory<T extends { role: string; content: string }>(
  history: T[]
): T[] {
  return history.map((message) =>
    message.role === 'assistant' && !HAS_TAG.test(message.content)
      ? { ...message, content: `<emo:normal>${message.content}` }
      : message
  )
}

/**
 * 判定缓冲区开头是不是情绪标记。
 * - `final=true` 用于流结束时兜底：收没收完都要给个结论，避免整段回复卡在缓冲里丢掉。
 */
export function readEmotionPrefix(buffer: string, final = false): EmotionPrefix {
  if (buffer === '') return { done: final, emotion: null, rest: '' }
  // 标记前面允许有空白（模型偶尔会先输出一个换行）
  const lead = buffer.match(/^\s*/)?.[0] ?? ''
  if (lead.length === buffer.length) return { done: final, emotion: null, rest: buffer }

  const body = buffer.slice(lead.length)
  if (!body.startsWith('<')) return { done: true, emotion: null, rest: buffer }

  const end = body.indexOf('>')
  if (end === -1) {
    // 看着像标记但还没收完：短就先等，长到不像标记就原样放行
    if (final || body.length >= EMOTION_TAG_MAX) return { done: true, emotion: null, rest: buffer }
    return { done: false, emotion: null, rest: '' }
  }

  const match = TAG_PATTERN.exec(body.slice(0, end + 1))
  if (!match) return { done: true, emotion: null, rest: buffer }

  const name = match[1].toLowerCase()
  const emotion = (EMOTIONS as readonly string[]).includes(name) ? (name as Emotion) : null
  return { done: true, emotion, rest: body.slice(end + 1).replace(/^\s+/, '') }
}
