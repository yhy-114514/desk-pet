// 边生成边念：把流式正文逐句送去合成，合成好一句就下发一句。
// 整段合成要等回复写完才开始，首句能晚一两秒；逐句合成让第一句几乎立刻开口。
import { splitSpeechChunks } from './speech'

export interface ChunkAudio {
  audio: Buffer
  mime: string
  /** 后面还有没有语音：渲染层据此决定 talk 要不要继续撑着 */
  more: boolean
}

export interface SpeechStreamerDeps {
  /** 合成一句；失败抛错即可，本句会被跳过 */
  synthesize: (text: string) => Promise<{ audio: Buffer; mime: string } | null>
  onAudio: (chunk: ChunkAudio) => void
  /** 不会再有语音了（全部念完 / 全部失败 / 被取消以外的收尾） */
  onEnd: () => void
}

/**
 * 串行合成队列。
 *
 * 为什么串行而不是并发：播放本身就要花时间（一句二十来字约三四秒），
 * 一句的合成通常一两秒，串行也追得上；并发反而会同时开好几条连接，
 * 而 Edge 通道每次都要一次 WebSocket 握手。
 */
export class SpeechStreamer {
  private buffer = ''
  private queue: string[] = []
  private running = false
  private ended = false
  private cancelled = false

  constructor(private deps: SpeechStreamerDeps) {}

  /** 喂入新到的正文；凑出整句就立刻进合成队列。 */
  push(text: string): void {
    if (this.cancelled || this.ended) return
    this.buffer += text
    const { chunks, rest } = splitSpeechChunks(this.buffer, false)
    this.buffer = rest
    this.queue.push(...chunks)
    void this.pump()
  }

  /** 流结束：尾巴语气不足一句也交出去，然后等队列跑完发 onEnd。 */
  end(): void {
    if (this.cancelled || this.ended) return
    this.ended = true
    const { chunks } = splitSpeechChunks(this.buffer, true)
    this.buffer = ''
    this.queue.push(...chunks)
    void this.pump()
  }

  /** 打断 / 新发言：丢掉还没合成的内容。**不调用 onEnd**——调用方会发 tts-stop。 */
  cancel(): void {
    this.cancelled = true
    this.queue = []
    this.buffer = ''
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length && !this.cancelled) {
        const text = this.queue.shift() as string
        let result: { audio: Buffer; mime: string } | null = null
        try {
          result = await this.deps.synthesize(text)
        } catch {
          // 某一句失败就跳过：后面的句子照样念，总比整轮没声音好
          result = null
        }
        if (this.cancelled) return
        if (!result) continue
        this.deps.onAudio({
          ...result,
          // 队列里还有，或者流还没结束（后面还会来）——两种都算「后面还有」
          more: this.queue.length > 0 || !this.ended
        })
      }
    } finally {
      this.running = false
    }
    // 竞态：push 可能在 finally 之后、这里之前把队列又填上，那种情况交给那次 push 的 pump
    if (this.ended && !this.cancelled && this.queue.length === 0) this.deps.onEnd()
  }
}
