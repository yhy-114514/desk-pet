import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QWEN_ASR_MODEL, transcribeSpeech } from './asr'

interface FetchCall {
  url: string
  init?: RequestInit
}

const calls: FetchCall[] = []
const fetchMock = vi.fn()

const AUDIO = Buffer.from([0x52, 0x49, 0x46, 0x46])

function body(index = 0): {
  model: string
  messages: Array<{ content: Array<{ type: string; input_audio: { data: string } }> }>
} {
  return JSON.parse(String(calls[index].init?.body))
}

beforeEach(() => {
  calls.length = 0
  fetchMock.mockReset()
  vi.stubGlobal(
    'fetch',
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '今天好累啊' } }] })
      }
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('transcribeSpeech', () => {
  it('音频按 data URI 送出去，模型与文本都对', async () => {
    await expect(transcribeSpeech(AUDIO, 'audio/wav', 'sk-test')).resolves.toBe('今天好累啊')

    expect(body().model).toBe(QWEN_ASR_MODEL)
    expect(calls[0].url).toContain('/compatible-mode/v1/chat/completions')
    expect(body().messages[0].content[0]).toEqual({
      type: 'input_audio',
      input_audio: { data: `data:audio/wav;base64,${AUDIO.toString('base64')}` }
    })
  })

  it('content 是分片数组时拼起来', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: [{ text: '帮我' }, { text: '定个闹钟' }] } }] })
    }))
    await expect(transcribeSpeech(AUDIO, 'audio/wav', 'sk-test')).resolves.toBe('帮我定个闹钟')
  })

  it('模型不在账号里（404）时把状态码与原文抛出来，而不是静默', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 404,
      text: async () => '{"code":"ModelNotFound","message":"Model not exist."}'
    }))
    await expect(transcribeSpeech(AUDIO, 'audio/wav', 'sk-test')).rejects.toThrow(/404/)
    await expect(transcribeSpeech(AUDIO, 'audio/wav', 'sk-test')).rejects.toThrow(/Model not exist/)
  })

  it('没有音频时不发请求', async () => {
    await expect(transcribeSpeech(Buffer.alloc(0), 'audio/wav', 'sk-test')).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
