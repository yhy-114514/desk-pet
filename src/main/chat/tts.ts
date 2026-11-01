// 语音合成：走 Edge 朗读接口（免费、无需 Key），主进程合成后把 mp3 交给渲染层播放。
// 与记忆抽取一样属于锦上添花：任何失败都静默，绝不影响主对话。
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import { SEC_MS_GEC_VERSION, TRUSTED_CLIENT_TOKEN, generateSecMsGecV2 } from './edgeToken'
import { synthesizeLocalSpeech } from './localTts'
import { synthesizeQwenSpeech } from './qwenTts'
import {
  SPEECH_MIN_CHARS,
  TTS_RATE,
  TTS_VOICE,
  escapeSsml,
  providerOfVoice,
  stripForSpeech
} from './speech'

/**
 * 旧端点。微软 2026-10 把朗读迁到了 api.msedgeservices.com，但那个新端点的 Akamai 会拒绝
 * Electron 的 TLS 指纹（同样的报文，系统 Node 能拿到 101，Electron 一律 200），
 * 旧端点不查指纹，只认 v2 token，所以在 Electron 里反而更可靠。
 */
const EDGE_WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'

/**
 * 让 msedge-tts 用旧端点 + v2 token。
 * 库把 URL 和 token 生成写死在静态方法里、也没留扩展点，只能替换掉整个 getSynthUrl。
 * 不改 node_modules：那样每次 npm install 都要重新打补丁。
 */
function installEdgeEndpoint(): void {
  const ctor = MsEdgeTTS as unknown as {
    generateUUID: () => string
    getSynthUrl: () => Promise<string>
  }
  ctor.getSynthUrl = async (): Promise<string> => {
    const params = new URLSearchParams({
      TrustedClientToken: TRUSTED_CLIENT_TOKEN,
      'Sec-MS-GEC': generateSecMsGecV2(),
      'Sec-MS-GEC-Version': SEC_MS_GEC_VERSION,
      ConnectionId: ctor.generateUUID()
    })
    return `${EDGE_WSS_URL}?${params.toString()}`
  }
}
installEdgeEndpoint()

/**
 * 空闲超时：每收到一块音频就重新计时。
 * 不能设成「总时长」——回复长一点，合成到一半就会被误杀，整段一个字都不出声。
 */
const IDLE_TIMEOUT_MS = 20_000

/**
 * 尝试次数（含首次）。握手被拒 / socket 中途断开 / 合成超时这几类都是瞬时故障，
 * 换个新实例重试一次基本就好了；但必须有上限——一直重试会占着连接，
 * 而没声音远好过拖着不出声。
 */
const MAX_ATTEMPTS = 2
/** 两次尝试之间歇一下：立刻重连容易再撞上同一个瞬时故障。 */
const RETRY_DELAY_MS = 400

/**
 * 在线合成的总预算。Edge 正常情况下 1–2 秒就合成完；超过这个时间基本没戏，
 * 早点放弃好退回本地语音，别让人干等（单次空闲超时是 20 秒，重试两次就太久了）。
 */
const EDGE_BUDGET_MS = 8_000

export interface SpeechOptions {
  voice?: string
  rate?: number
  /** 语气的自然语言指令；null/不传就用音色默认语气。只有千问通道认它 */
  instruction?: string | null
  /** 配了千问 Key 时优先走它（免费 Edge 端点不支持情绪） */
  qwen?: { key: string } | null
  /** 打断时中止在途合成，别让旧语音占着连接 */
  signal?: AbortSignal
}

export interface SpeechAudio {
  audio: Buffer
  /** 在线合成给 mp3，本地系统语音给 wav，渲染层按这个决定 Blob 类型 */
  mime: string
}

/**
 * 合成一段语音；文本清洗后没有可念的内容时返回 null。
 * 优先千问（能按情绪读）→ Edge 朗读（免费，但只能普通语气）→ 本地系统语音。
 * 全失败才抛错，由调用方静默降级——不出声远比报错打扰人好。
 */
export async function synthesizeSpeech(text: string, options: SpeechOptions = {}): Promise<SpeechAudio | null> {
  const spoken = stripForSpeech(text)
  if (spoken.length < SPEECH_MIN_CHARS) return null
  if (options.signal?.aborted) throw new Error('TTS 已取消')

  const { voice = TTS_VOICE, qwen, instruction, signal } = options

  try {
    if (qwen) {
      const result = await synthesizeQwenSpeech(spoken, {
        key: qwen.key,
        voice,
        instruction,
        signal
      })
      if (result) return result
      // 没抛错也没拿到音频（比如返回里没有 audio.url）：同样要说一声，
      // 否则用户只会听到 Edge 的声音，却以为设置里的音色没生效
      console.warn('[tts] 千问没有返回音频，退回 Edge')
    }
  } catch (error) {
    // 用户主动打断不是「在线失败」，别接着合成一段他已经不要的语音
    if (signal?.aborted) throw new Error('TTS 已取消')
    // 降级是刻意的（没声音更糟），但必须留痕：Key 错 / 没开通模型 / 额度用完
    // 全都表现成「音色没变」，不打这行根本查不出原因
    console.warn('[tts] 千问合成失败，退回 Edge：', error)
  }

  try {
    // Edge 不认识千问那套音色名（longanlingxi…）。两种情况都会走到这里：
    // 千问合成失败退回、以及选了千问音色却没配 Key（调用方没传 qwen）——
    // 判据必须是音色属于哪套，不是「有没有传 qwen」，否则后一种会拿 longanlingxi 去连 Edge，
    // 连不上再降级成本地 Yaoyao，配置窗承诺的「退回晓伊」就落空了
    const edgeVoice = providerOfVoice(voice) === 'qwen' ? TTS_VOICE : voice
    const audio = await synthesizeEdge(spoken, { ...options, voice: edgeVoice })
    if (audio) return { audio, mime: 'audio/mpeg' }
  } catch {
    if (signal?.aborted) throw new Error('TTS 已取消')
  }

  const audio = await synthesizeLocalSpeech(spoken, options)
  return audio ? { audio, mime: 'audio/wav' } : null
}

/**
 * 在线合成：偶发失败（Edge 接口的瞬时故障）会在换一个新实例后自动重试一次，见 MAX_ATTEMPTS。
 * 整体还受 EDGE_BUDGET_MS 约束，超时即中止，好让调用方尽快回退本地语音。
 */
async function synthesizeEdge(text: string, options: SpeechOptions): Promise<Buffer | null> {
  const input = escapeSsml(text)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EDGE_BUDGET_MS)
  const onOuterAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })

  try {
    let lastError: unknown = new Error('TTS 合成失败')
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const audio = await synthesizeOnce(input, { ...options, signal: controller.signal })
        if (audio) return audio
        // 连着音频块却一个字都没收到，说明这轮已经废了，交给重试
        lastError = new Error('TTS 返回了空音频')
      } catch (error) {
        lastError = error
      }
      if (controller.signal.aborted) throw lastError
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
    throw lastError
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * 单次合成尝试。每次新建实例（含一次 WebSocket 握手），
 * 避免复用实例时残留上一次的合成状态——重试之所以有效正是因为这里足够干净。
 */
async function synthesizeOnce(input: string, options: SpeechOptions): Promise<Buffer | null> {
  const { voice = TTS_VOICE, rate = TTS_RATE, signal } = options
  const tts = new MsEdgeTTS()
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    // 免费 Edge 端点不认 mstts:express-as（实测必断流），所以这条路只做普通朗读；
    // 情绪由千问通道的 instructions 负责，这里连 emotion 都不看。
    const { audioStream } = tts.toStream(input, { rate })

    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const clearIdle = (): void => {
        if (timer !== null) clearTimeout(timer)
        timer = null
      }
      const onAbort = (): void => {
        audioStream.destroy()
        finish()
        reject(new Error('TTS 已取消'))
      }
      const finish = (): void => {
        clearIdle()
        signal?.removeEventListener('abort', onAbort)
      }

      const armIdle = (): void => {
        clearIdle()
        timer = setTimeout(() => {
          audioStream.destroy()
          finish()
          reject(new Error('TTS 合成超时'))
        }, IDLE_TIMEOUT_MS)
      }

      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      audioStream.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        armIdle() // 还有数据在来，就说明没卡死
      })
      audioStream.on('end', () => {
        finish()
        resolve()
      })
      audioStream.on('error', (error) => {
        finish()
        reject(error)
      })
      armIdle()
    })

    const audio = Buffer.concat(chunks)
    return audio.length > 0 ? audio : null
  } finally {
    tts.close()
  }
}
