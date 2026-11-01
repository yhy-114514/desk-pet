// 麦克风录音 → 单声道 PCM16 WAV。识别接口要的是「一段完整音频」，
// 用 MediaRecorder 会拿到 webm/opus（千问 ASR 的 data URI 只认音频容器类型），
// 干脆用 Web Audio 自己取采样、自己封 WAV，格式与采样率都握在手里。

/** 采样率定死 16k：语音识别够用，体积也只有 44.1k 的三分之一 */
const SAMPLE_RATE = 16_000

/** 把 [-1, 1] 的浮点采样封装成 WAV（PCM16 单声道） */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt 块长度
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // 每秒字节数
  view.setUint16(32, 2, true) // 块对齐
  view.setUint16(34, 16, true) // 位深
  writeAscii(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (const sample of samples) {
    // 削波再转定点：超出 [-1,1] 的采样直接按满幅算，别让它回绕成噪音
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }

  return buffer
}

export class VoiceRecorder {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private processor: ScriptProcessorNode | null = null
  private chunks: Float32Array[] = []

  get recording(): boolean {
    return this.context !== null
  }

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    // 浏览器的 autoplay 策略让新建的 AudioContext 停在 suspended；而这里已经 await 过
    // getUserMedia，指针事件所在的「手势上下文」断了，不显式恢复就一个采样也收不到
    await context.resume()
    const source = context.createMediaStreamSource(stream)
    // ScriptProcessorNode 虽已标记废弃，但 AudioWorklet 要单独打包一份模块脚本，
    // 为了这一段录音不值得。它的输出缓冲默认是静音，不会把麦克风声音放出来
    const processor = context.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (event): void => {
      this.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
    }
    source.connect(processor)
    processor.connect(context.destination)

    this.stream = stream
    this.context = context
    this.processor = processor
    this.chunks = []
  }

  /** 停止并返回 WAV 字节；没在录时返回 null */
  async stop(): Promise<ArrayBuffer | null> {
    const context = this.context
    if (!context) return null
    const sampleRate = context.sampleRate
    const chunks = this.chunks
    this.release()

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    if (total === 0) return null
    const samples = new Float32Array(total)
    let offset = 0
    for (const chunk of chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    return encodeWav(samples, sampleRate)
  }

  /** 放弃这次录音（录太久 / 用户中途取消） */
  cancel(): void {
    this.release()
  }

  private release(): void {
    this.processor?.disconnect()
    this.processor = null
    // 麦克风流必须显式停掉，否则系统的「正在使用麦克风」指示灯会一直亮着
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    void this.context?.close()
    this.context = null
    this.chunks = []
  }
}
