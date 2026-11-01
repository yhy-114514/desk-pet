import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TTS_VOICE } from './speech'
import { synthesizeSpeech } from './tts'

/** 一次假合成的剧本：要么握手失败，要么连上后中途报错，要么吐出这段音频。 */
interface Step {
  connectError?: Error
  error?: Error
  audio?: Buffer
}

// vi.mock 的工厂会被提升到文件顶部，共享状态必须走 vi.hoisted
const plan = vi.hoisted(() => ({
  steps: [] as Step[],
  opened: 0,
  /** 每次 toStream 收到的朗读参数（语速），用于验证透传 */
  prosody: [] as Record<string, unknown>[],
  /** 每次 setMetadata 收到的音色（Edge 只认自己那套名字） */
  voices: [] as string[]
}))
const local = vi.hoisted(() => ({
  calls: 0,
  result: Buffer.from('wav-data') as Buffer | null,
  error: null as Error | null,
  /** 本地兜底收到的参数 */
  options: [] as Record<string, unknown>[]
}))

vi.mock('./localTts', () => ({
  synthesizeLocalSpeech: async (_text: string, options: Record<string, unknown>) => {
    local.calls++
    local.options.push(options)
    if (local.error) throw local.error
    return local.result
  }
}))

/** 千问通道：能按情绪读的那条路，配了 Key 才走。 */
const qwen = vi.hoisted(() => ({
  calls: 0,
  result: { audio: Buffer.from('qwen-wav'), mime: 'audio/wav' } as {
    audio: Buffer
    mime: string
  } | null,
  error: null as Error | null,
  options: [] as Record<string, unknown>[]
}))

vi.mock('./qwenTts', () => ({
  synthesizeQwenSpeech: async (_text: string, options: Record<string, unknown>) => {
    qwen.calls++
    qwen.options.push(options)
    if (qwen.error) throw qwen.error
    return qwen.result
  }
}))

vi.mock('msedge-tts', async () => {
  const { PassThrough } = await import('node:stream')

  class FakeMsEdgeTTS {
    private step: Step | undefined

    async setMetadata(voice: string): Promise<void> {
      plan.voices.push(voice)
      this.step = plan.steps[plan.opened++]
      if (!this.step) throw new Error('剧本用完了')
      if (this.step.connectError) throw this.step.connectError
    }

    toStream(_input: string, options?: Record<string, unknown>) {
      plan.prosody.push(options ?? {})
      return { audioStream: this._play() }
    }

    /** 按剧本吐音频 / 报错，模拟真实流的时序（监听器先挂上才收得到）。 */
    private _play() {
      const audioStream = new PassThrough()
      const step = this.step as Step
      setImmediate(() => {
        if (step.error) {
          audioStream.destroy(step.error)
          return
        }
        if (step.audio) audioStream.write(step.audio)
        audioStream.end()
      })
      return audioStream
    }

    close(): void {}
  }

  return { MsEdgeTTS: FakeMsEdgeTTS, OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' } }
})

beforeEach(() => {
  plan.steps = []
  plan.opened = 0
  plan.prosody = []
  plan.voices = []
  local.calls = 0
  local.result = Buffer.from('wav-data')
  local.error = null
  local.options = []
  qwen.calls = 0
  qwen.result = { audio: Buffer.from('qwen-wav'), mime: 'audio/wav' }
  qwen.error = null
  qwen.options = []
})

describe('synthesizeSpeech 的偶发故障重试', () => {
  it('握手失败时换新实例重试一次，第二次成功', async () => {
    const audio = Buffer.from('mp3-data')
    plan.steps = [{ connectError: new Error('Unexpected server response: 403') }, { audio }]

    await expect(synthesizeSpeech('哥哥你回来啦')).resolves.toEqual({ audio, mime: 'audio/mpeg' })
    expect(plan.opened).toBe(2)
    expect(local.calls).toBe(0)
  })

  it('合成中途连接断了也重试', async () => {
    const audio = Buffer.from('mp3-data')
    plan.steps = [{ error: new Error('Stream closed before the synthesis completed') }, { audio }]

    await expect(synthesizeSpeech('哥哥你回来啦')).resolves.toEqual({ audio, mime: 'audio/mpeg' })
    expect(plan.opened).toBe(2)
  })

  it('两次都失败：退回本地系统语音，保证一定有声音', async () => {
    plan.steps = [
      { connectError: new Error('连接超时') },
      { connectError: new Error('Unexpected server response: 200') }
    ]

    await expect(synthesizeSpeech('哥哥你回来啦')).resolves.toEqual({
      audio: Buffer.from('wav-data'),
      mime: 'audio/wav'
    })
    expect(plan.opened).toBe(2)
    expect(local.calls).toBe(1)
  })

  it('本地语音也失败才抛错（由调用方静默降级），不会无限重试', async () => {
    plan.steps = [{ connectError: new Error('连接被拒') }, { connectError: new Error('连接又被拒了') }]
    local.error = new Error('本地语音合成失败')

    await expect(synthesizeSpeech('哥哥你回来啦')).rejects.toThrow('本地语音合成失败')
    expect(plan.opened).toBe(2)
    expect(local.calls).toBe(1)
  })

  it('用户已经打断：在线和本地都不试', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      synthesizeSpeech('哥哥你回来啦', { signal: controller.signal })
    ).rejects.toThrow('TTS 已取消')
    expect(plan.opened).toBe(0)
    expect(local.calls).toBe(0)
  })

  it('清洗后没有可念的内容：返回 null，不建立连接也不调本地合成', async () => {
    await expect(synthesizeSpeech('嗯')).resolves.toBeNull()
    expect(plan.opened).toBe(0)
    expect(local.calls).toBe(0)
  })
})

describe('千问优先，Edge 兜底', () => {
  const QWEN = { key: 'sk-k' }

  it('配了千问就走千问，把音色与语气指令一起传过去', async () => {
    await synthesizeSpeech('哥哥你回来啦', {
      voice: 'longanlingxi',
      instruction: '语气轻快雀跃',
      qwen: QWEN
    })

    expect(qwen.calls).toBe(1)
    expect(qwen.options[0]).toMatchObject({
      key: 'sk-k',
      voice: 'longanlingxi',
      instruction: '语气轻快雀跃'
    })
    expect(plan.opened).toBe(0) // 没碰 Edge
    expect(local.calls).toBe(0)
  })

  it('千问返回 wav，mime 跟着走', async () => {
    await expect(synthesizeSpeech('哥哥你回来啦', { qwen: QWEN })).resolves.toEqual({
      audio: Buffer.from('qwen-wav'),
      mime: 'audio/wav'
    })
  })

  it('千问失败退回 Edge：音色换回 Edge 自己的，否则 Edge 不认识 longanlingxi', async () => {
    qwen.error = new Error('千问语音合成失败（401）')
    plan.steps = [{ audio: Buffer.from('mp3-data') }]

    await expect(
      synthesizeSpeech('哥哥你回来啦', { voice: 'longanlingxi', qwen: QWEN })
    ).resolves.toEqual({ audio: Buffer.from('mp3-data'), mime: 'audio/mpeg' })
    expect(qwen.calls).toBe(1)
    expect(plan.opened).toBe(1)
    // 传给 Edge 的是 Edge 音色（默认晓伊），不是千问的 longanlingxi
    expect(plan.voices[0]).toBe(TTS_VOICE)
    expect(plan.prosody[0]).toMatchObject({ rate: 1.1 })
  })

  it('选了千问音色却没配 Key：Edge 也得换成自己的音色，不能拿 longanlingxi 去连', async () => {
    plan.steps = [{ audio: Buffer.from('mp3-data') }]

    await expect(
      synthesizeSpeech('哥哥你回来啦', { voice: 'longanlingxi', qwen: null })
    ).resolves.toEqual({ audio: Buffer.from('mp3-data'), mime: 'audio/mpeg' })
    expect(qwen.calls).toBe(0)
    expect(plan.voices[0]).toBe(TTS_VOICE)
    expect(local.calls).toBe(0) // 没被打到本地兜底，Edge 这一轮就出声了
  })

  it('千问返回 null（没拿到音频）时也退回 Edge', async () => {
    qwen.result = null
    plan.steps = [{ audio: Buffer.from('mp3-data') }]

    await expect(synthesizeSpeech('哥哥你回来啦', { qwen: QWEN })).resolves.toEqual({
      audio: Buffer.from('mp3-data'),
      mime: 'audio/mpeg'
    })
  })

  it('没配千问就直接走 Edge（Edge 的模板不带情绪，零回归）', async () => {
    plan.steps = [{ audio: Buffer.from('mp3-data') }]

    await synthesizeSpeech('哥哥你回来啦', { voice: 'zh-CN-XiaoyiNeural', instruction: null })

    expect(qwen.calls).toBe(0)
    expect(plan.voices[0]).toBe('zh-CN-XiaoyiNeural')
    expect(plan.prosody[0]).toMatchObject({ rate: 1.1 })
  })

  it('选了别的 Edge 音色就照用（设置里的音色切换要生效）', async () => {
    plan.steps = [{ audio: Buffer.from('mp3-data') }]

    await synthesizeSpeech('哥哥你回来啦', { voice: 'zh-CN-XiaoxiaoNeural' })

    expect(plan.voices[0]).toBe('zh-CN-XiaoxiaoNeural')
  })

  it('千问与 Edge 都失败才退回本地语音', async () => {
    qwen.error = new Error('401')
    plan.steps = [{ connectError: new Error('连接被拒') }, { connectError: new Error('又被拒') }]

    await expect(
      synthesizeSpeech('呜呜…', { qwen: QWEN, instruction: '语气低落' })
    ).resolves.toEqual({ audio: Buffer.from('wav-data'), mime: 'audio/wav' })
    expect(local.calls).toBe(1)
  })
})
