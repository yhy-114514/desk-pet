// TTS 文本清洗（纯函数，无 electron / 网络依赖，可单测）。
// 人设禁止 markdown，但模型偶尔仍然会冒出记号；不洗就直接念会读出「星号」「井号」。
import { stripEmotionTags, type Emotion } from './emotion'

/** 免费通道的默认音色：小鱼娘是活泼的少女音；语速略快一点更像撒娇。 */
export const TTS_VOICE = 'zh-CN-XiaoyiNeural'
export const TTS_RATE = 1.1

/**
 * 语音通道：edge = 免费朗读（只能普通语气），qwen = 阿里云百炼千问（能按情绪读）。
 * 配了千问 Key 就用千问，否则用 edge。
 */
export type TtsProvider = 'edge' | 'qwen'

export interface VoiceDef {
  name: string
  label: string
}

/** 免费 Edge 通道的音色。 */
export const EDGE_VOICES: VoiceDef[] = [
  { name: 'zh-CN-XiaoyiNeural', label: '晓伊（幼女 · 默认）' },
  { name: 'zh-CN-XiaoxiaoNeural', label: '晓晓（年轻女声）' },
  { name: 'zh-CN-XiaohanNeural', label: '晓涵（年轻女声）' },
  { name: 'zh-CN-XiaomoNeural', label: '晓墨（年轻女声）' }
]

/**
 * 千问通道的音色：Qwen-Audio-TTS 的系统女声，四个都支持「指令控制」（能按情绪读）。
 * 名字必须与所调模型严格对应（`qwen-audio-3.0-tts-flash` 的音色表），
 * 跨模型混用会直接报 InvalidParameter，所以换模型时整张表都要重核。
 */
export const QWEN_VOICES: VoiceDef[] = [
  { name: 'longanlingxi', label: '龙安灵希（可爱甜美 · 默认）' },
  { name: 'longpaopao_v3.6', label: '龙泡泡（软糯幼女）' },
  { name: 'longanxiaoxin', label: '龙安小昕（亲切活泼）' },
  { name: 'longanfengyue', label: '龙安风悦（自然亲切）' }
]

/** 默认通道：配了千问 Key 就默认走能带情绪的千问，否则走免费的 edge。 */
export function providerFor(hasQwenKey: boolean): TtsProvider {
  return hasQwenKey ? 'qwen' : 'edge'
}

/**
 * 音色属于哪套通道（不认识返回 null）。
 * 合成走哪条路由**由所选音色决定**，不是由有没有 Key 决定——
 * 配了 Key 也可以切回晓伊（普通语气），没配 Key 选了千问音色则只能退回 Edge。
 */
export function providerOfVoice(name: string): TtsProvider | null {
  if (EDGE_VOICES.some((v) => v.name === name)) return 'edge'
  if (QWEN_VOICES.some((v) => v.name === name)) return 'qwen'
  return null
}

export function voicesFor(provider: TtsProvider): VoiceDef[] {
  return provider === 'qwen' ? QWEN_VOICES : EDGE_VOICES
}

/** 音色是否属于该通道；配置里存着旧值 / 换了通道时用它兜底。 */
export function isKnownVoice(name: string, provider: TtsProvider): boolean {
  return voicesFor(provider).some((v) => v.name === name)
}

/**
 * 情绪 → 千问的语气指令（自然语言，模型照着整体改变发音方式：语调、节奏、气息）。
 * 这是「真情绪」的关键：在音频上硬调音高只会得到氦气音，因为共振峰和节奏没动。
 * normal / 未知返回 null——交给音色本身的平稳语气，别用力过猛。
 */
const EMOTION_INSTRUCTIONS: Partial<Record<Emotion, string>> = {
  happy: '语气轻快雀跃，语速稍快，音调偏高，尾音自然上扬',
  sad: '语气低落，语速放慢，声音轻而沉，句尾略微下坠',
  angry: '语气强硬，咬字加重，语速偏快，音量稍大',
  surprised: '语气惊讶，音调抬高，语速先快后缓，带一点急促',
  shy: '语气害羞，声音变小放轻，语速放慢，句子之间有迟疑的停顿',
  smug: '语气得意，语速从容，尾音拖长上扬，带一点撒娇'
}

export function emotionInstruction(emotion: Emotion | null | undefined): string | null {
  if (!emotion || emotion === 'normal') return null
  return EMOTION_INSTRUCTIONS[emotion] ?? null
}

/** 少于这个字数不值得开口（「嗯」「哦」这类单字气声）。 */
export const SPEECH_MIN_CHARS = 2

/** 句末标点：句号 / 感叹 / 问号 / 省略号 / 分号 / 换行。逗号不算——按逗号切会念成一顿一顿的碎片。 */
const SENTENCE_END = /[。！？!?…；;\n]/

/** 单句短于这个字数并到下一句：一段「嗯。」单开一次合成既多花一次请求，听着也断。 */
const MIN_CHUNK_CHARS = 4

/** 一直没有句末标点（模型写出超长句）时按这个长度硬切，别憋到流结束才开口。 */
const MAX_CHUNK_CHARS = 40

/**
 * 从流式文本里切出可以立刻合成的句子。返回切好的段与剩下的尾巴。
 *
 * 边生成边念的关键：模型吐到第一个句号就该开始合成，而不是等整段写完。
 * `final` 为真表示流已结束，剩下的尾巴不论有没有标点都要交出去。
 */
export function splitSpeechChunks(
  pending: string,
  final: boolean
): { chunks: string[]; rest: string } {
  const chunks: string[] = []
  let rest = pending
  for (;;) {
    const cut = findCut(rest)
    if (cut <= 0) break
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (final && rest.trim()) {
    chunks.push(rest)
    rest = ''
  }
  return { chunks, rest }
}

/** 找到下一个切点（含标点）；还不够长 / 没有标点都返回 -1，等更多文字。 */
function findCut(text: string): number {
  let from = 0
  for (;;) {
    const match = SENTENCE_END.exec(text.slice(from))
    if (!match) {
      // 一直没有句末标点：憋太久了就先硬切，优先在逗号处断开，念起来自然些
      if (text.length < MAX_CHUNK_CHARS) return -1
      const comma = Math.max(text.lastIndexOf('，', MAX_CHUNK_CHARS), text.lastIndexOf(',', MAX_CHUNK_CHARS))
      return comma > 0 ? comma + 1 : MAX_CHUNK_CHARS
    }
    const cut = from + match.index + 1
    // 太短的段并到下一句：「嗯。」「好呀！」单独合成一次不划算
    if (cut >= MIN_CHUNK_CHARS) return cut
    from = cut
  }
}

/** 去掉 markdown / 链接 / emoji，把换行压成停顿，供 TTS 朗读。 */
export function stripForSpeech(text: string): string {
  return stripEmotionTags(text)
    .replace(/```[\s\S]*?```/g, ' ') // 代码块整段丢弃
    .replace(/`([^`]*)`/g, '$1') // 行内代码保留内容
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片丢弃
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接只保留文字
    .replace(/https?:\/\/\S+/g, ' ') // 裸链接
    .replace(/[（(][^）)]*[）)]/g, '') // 括号里是状态 / 动作描写（（小声）（歪头）），不是台词，念出来会出戏；不补空格，否则中文会被念出停顿
    .replace(/^\s{0,3}[#>\-*+]\s+/gm, '') // 行首标题 / 引用 / 列表记号
    .replace(/[*_~]/g, '') // 强调记号
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '') // emoji
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * SSML 特殊字符转义。msedge-tts 把文本原样插进 `<prosody>`，不转义的话
 * 一句「1 &lt; 2」就能让整段 SSML 非法，结果是这条回复一个字都念不出来。
 */
export function escapeSsml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
