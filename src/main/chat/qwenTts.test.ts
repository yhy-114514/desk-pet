import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QWEN_TTS_MODEL, synthesizeQwenSpeech } from './qwenTts'

interface FetchCall {
  url: string
  init?: RequestInit
}

const calls: FetchCall[] = []
const fetchMock = vi.fn()

/** 默认剧本：第一次返回音频 URL，第二次返回音频字节。 */
function stubHappyPath(mime = 'audio/wav'): void {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (calls.length === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ output: { audio: { url: 'https://example.com/audio.wav' } } }),
        headers: new Headers()
      }
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': `${mime}; charset=utf-8` }),
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer
    }
  })
}

beforeEach(() => {
  calls.length = 0
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const options = { key: 'sk-test', voice: 'longanlingxi' }

describe('synthesizeQwenSpeech', () => {
  it('先请求合成拿 URL，再下载音频；两次都带上中止信号', async () => {
    stubHappyPath('audio/wav')

    await expect(synthesizeQwenSpeech('哥哥你回来啦', options)).resolves.toEqual({
      audio: Buffer.from([1, 2, 3]),
      mime: 'audio/wav'
    })

    expect(calls[0].url).toContain('dashscope.aliyuncs.com')
    // Qwen-Audio-TTS 的原生合成端点；multimodal-generation 那条路对这批模型会 404
    expect(calls[0].url).toContain('services/audio/tts/SpeechSynthesizer')
    expect(calls[1].url).toBe('https://example.com/audio.wav')
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
  })

  it('请求体带模型、音色、音频格式与语气指令', async () => {
    stubHappyPath()

    await synthesizeQwenSpeech('哥哥你回来啦', { ...options, instruction: '语气轻快雀跃' })

    const body = JSON.parse(String(calls[0].init?.body)) as {
      model: string
      input: {
        text: string
        voice: string
        format: string
        sample_rate: number
        instruction?: string
      }
    }
    expect(body.model).toBe(QWEN_TTS_MODEL)
    expect(body.input).toMatchObject({
      text: '哥哥你回来啦',
      voice: 'longanlingxi',
      format: 'wav',
      sample_rate: 24000,
      // 指令在 input 里，不是 Qwen3-TTS 那套 parameters.instructions
      instruction: '语气轻快雀跃'
    })
  })

  it('没有情绪时不传 instruction，交给音色本身的语气', async () => {
    stubHappyPath()

    await synthesizeQwenSpeech('哥哥你回来啦', options)

    const body = JSON.parse(String(calls[0].init?.body)) as {
      input: { instruction?: unknown }
    }
    expect(body.input.instruction).toBeUndefined()
  })

  it('HTTP 失败抛错并带上状态码（401 = Key 错 / 429 = 额度用完）', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 429,
      text: async () => 'Throttling',
      headers: new Headers()
    }))

    await expect(synthesizeQwenSpeech('你好', options)).rejects.toThrow('429')
  })

  it('返回里没有音频 URL 时返回 null，交给上层退回 Edge', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 200,
        json: async () => ({ output: {} }),
        headers: new Headers()
      }
    })

    await expect(synthesizeQwenSpeech('你好', options)).resolves.toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('下载到空音频时返回 null', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (calls.length === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ output: { audio: { url: 'https://example.com/a.wav' } } }),
          headers: new Headers()
        }
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/wav' }),
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    })

    await expect(synthesizeQwenSpeech('你好', options)).resolves.toBeNull()
  })
})
