// 阿里云百炼（DashScope）千问语音合成：唯一能按情绪朗读的通道。
// 免费 Edge 朗读端点不认 mstts:express-as（实测任何写法都断流），所以配了 Key 时优先走这里；
// 没配或调用失败由 tts.ts 依次退回 Edge、本地系统语音。
//
// 注意：这里用的不是 multimodal-generation（那条路的 qwen3-tts-instruct-flash 在不少账号下
// 直接 404 Model not exist），而是 Qwen-Audio-TTS 的原生合成端点。情绪走 input.instruction
// 这个自然语言参数，音色表也随之换成 longan* 那套（见 speech.ts 的 QWEN_VOICES）。
// 非流式返回的是音频文件 URL，要再下载一次才拿到字节。

/** Qwen-Audio-TTS 的 flash 档：1 元/万字符，支持 instruction（情绪 / 角色 / 方言）。 */
export const QWEN_TTS_MODEL = 'qwen-audio-3.0-tts-flash'

const QWEN_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'

/** 百炼返的是 wav，直接指定格式，省得再按 Content-Type 猜。 */
const QWEN_AUDIO_FORMAT = 'wav'
const QWEN_SAMPLE_RATE = 24_000

/** 合成（拿 URL）与下载各给一份预算：主要耗时在合成。 */
const SYNTH_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 15_000

export interface QwenSpeechOptions {
  key: string
  /** 音色名，见 speech.ts 的 QWEN_VOICES */
  voice: string
  /** 自然语言语气指令；null 表示不加，用音色默认语气 */
  instruction?: string | null
  signal?: AbortSignal
}

export interface AudioResult {
  audio: Buffer
  /** 百炼返的是 wav；这里按 Content-Type 兜底，渲染层据此建 Blob */
  mime: string
}

/**
 * 合成一段语音。返回 null 表示这次没有可用音频（交给上层退回 Edge）；
 * 网络 / 鉴权 / 额度错误直接抛，由 tts.ts 决定是否降级。
 */
export async function synthesizeQwenSpeech(
  text: string,
  options: QwenSpeechOptions
): Promise<AudioResult | null> {
  const url = await requestAudioUrl(text, options)
  if (!url) return null
  return downloadAudio(url, options.signal)
}

/** 第一步：POST 合成请求，拿音频 URL。 */
async function requestAudioUrl(text: string, options: QwenSpeechOptions): Promise<string | null> {
  const body = JSON.stringify({
    model: QWEN_TTS_MODEL,
    input: {
      text,
      voice: options.voice,
      format: QWEN_AUDIO_FORMAT,
      sample_rate: QWEN_SAMPLE_RATE,
      // 语气指令与音色同一层（不是 Qwen3-TTS 的 parameters.instructions）；
      // 没有情绪就不传，交给音色本身的平稳语气
      ...(options.instruction ? { instruction: options.instruction } : {})
    }
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SYNTH_TIMEOUT_MS)
  const onOuterAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })

  try {
    const response = await fetch(QWEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.key}`,
        'Content-Type': 'application/json'
      },
      body,
      signal: controller.signal
    })

    if (!response.ok) {
      // 401 = Key 错、429 = 免费额度用完 / 限流，报出来才知道去哪儿查
      const detail = await response.text().catch(() => '')
      throw new Error(
        `千问语音合成失败（${response.status}）${detail ? `：${detail.slice(0, 160)}` : ''}`
      )
    }

    const json = (await response.json()) as { output?: { audio?: { url?: string } } }
    // 文档给的是 output.audio.url；拿不到就当这次没合成出来，别让上层卡住
    return json.output?.audio?.url ?? null
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onOuterAbort)
  }
}

/** 第二步：把 URL 上的音频下载成 Buffer（URL 有效期 24h，所以必须当场取）。 */
async function downloadAudio(url: string, signal?: AbortSignal): Promise<AudioResult | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  const onOuterAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onOuterAbort, { once: true })

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`千问语音下载失败（${response.status}）`)
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/wav'
    const audio = Buffer.from(await response.arrayBuffer())
    return audio.length > 0 ? { audio, mime } : null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}
