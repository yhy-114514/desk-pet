// 阿里云百炼（DashScope）语音识别：把渲染层录好的整段音频转成文字。
// 走 OpenAI 兼容模式的一次性非实时接口（不是 WebSocket 流式）——桌宠的用法是
// 「按住说完一句、松开识别」，整段送过去最简单，也不用维护长连接。
// 识别完只回文字，不自动发送：让她先看见、能改，再按回车。
import { ipcMain } from 'electron'
import { loadConfig } from './config'

/**
 * Qwen3-ASR-Flash：按音频秒数计费，和 TTS 用的百炼 Key 是同一个账号。
 * 模型不在账号里会返回 404 Model not exist（和 qwen3-tts-instruct-flash 踩过同一个坑），
 * 所以失败时要把状态码与原文报给用户，不能静默。
 */
export const QWEN_ASR_MODEL = 'qwen3-asr-flash'

const ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

/** 一次识别的上限：几句日常对话足够，再长就是在对着鱼念稿子了 */
const TRANSCRIBE_TIMEOUT_MS = 30_000

/** 兼容模式的 content 可能是字符串，也可能是一串分片 */
function readContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : ''))
      .join('')
      .trim()
  }
  return ''
}

/**
 * 把一段音频转成文字。mime 决定 data URI 的类型（我们录的是 16k 单声道 wav）。
 * 失败直接抛：调用方要把原因显示给用户，静默降级在这里等于「按了没反应」。
 */
export async function transcribeSpeech(audio: Buffer, mime: string, key: string): Promise<string> {
  if (!audio.length) throw new Error('没有录到声音')

  const dataUri = `data:${mime};base64,${audio.toString('base64')}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS)

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: QWEN_ASR_MODEL,
        messages: [
          {
            role: 'user',
            content: [{ type: 'input_audio', input_audio: { data: dataUri } }]
          }
        ],
        stream: false
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      // 401 = Key 错、404 = 模型不在账号里、429 = 额度/限流。原文一定要带上，
      // 否则「模型不存在」这种错误在界面上只会表现为「识别不出来」
      console.warn(`[asr] 识别失败 ${response.status}: ${detail.slice(0, 300)}`)
      throw new Error(`语音识别失败（${response.status}）${detail ? `：${detail.slice(0, 160)}` : ''}`)
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>
    }
    return readContent(json.choices?.[0]?.message?.content)
  } catch (error) {
    // fetch 的中止错误原文是英文的对象名，界面上看不出是「等太久」
    if (error instanceof Error && error.name === 'AbortError') throw new Error('语音识别超时')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** 渲染层「按住说话」松开后走这里：音频进、文字出。Key 始终不出主进程。 */
export function registerAsrIpc(): void {
  ipcMain.handle('chat:transcribe', async (_event, payload: { audio: string; mime: string }) => {
    const key = loadConfig().qwenKey.trim()
    if (!key) return { ok: false as const, error: '语音输入需要百炼 Key，去「设置」里填一下' }
    try {
      const audio = Buffer.from(payload.audio, 'base64')
      const text = await transcribeSpeech(audio, payload.mime || 'audio/wav', key)
      if (!text) return { ok: false as const, error: '没听清，再说一遍？' }
      return { ok: true as const, text }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : '语音识别失败' }
    }
  })
}
