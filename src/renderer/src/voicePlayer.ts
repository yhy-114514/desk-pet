// 语音播放：主进程下发 base64 音频（在线是 mp3、本地兜底是 wav），渲染层解码成 Blob 播放。
// 主进程是边生成边念的，一轮回复会分好几段下发——这里排队依次播，
// 新的一段不能打断上一段（否则前半句话会被截断），但新的发言仍会整队清空。
export class VoicePlayer {
  private audio: HTMLAudioElement | null = null
  private url: string | null = null
  private queue: { base64: string; mime: string }[] = []

  /** 还有话没说完（正在念或者排队等着）：talk 要一直持续到全部念完 */
  get isPlaying(): boolean {
    return this.audio !== null || this.queue.length > 0
  }

  /** 排到队尾；当前空闲就立刻开口。 */
  enqueue(base64: string, mime = 'audio/mpeg'): void {
    if (!base64) return
    this.queue.push({ base64, mime })
    if (!this.audio) this.next()
  }

  /** 立刻停声并清空队列（新发言 / 打断 / 关朗读）。 */
  stop(): void {
    this.queue = []
    this.release()
  }

  private next(): void {
    const item = this.queue.shift()
    if (!item) {
      this.release()
      return
    }
    const url = URL.createObjectURL(new Blob([decodeBase64(item.base64)], { type: item.mime }))
    const audio = new Audio(url)
    this.audio = audio
    this.url = url

    // 播完（或出错）就顺手接下一段；自动播放被拦 / 设备异常时静默放弃整段后续，
    // 气泡里已经有字了，不值得再弹什么
    const done = (): void => {
      if (this.audio !== audio) return
      this.audio = null
      this.releaseUrl()
      this.next()
    }
    audio.addEventListener('ended', done)
    audio.addEventListener('error', done)
    void audio.play().catch(done)
  }

  /** 停下当前这一段（队列由调用方决定要不要清）。 */
  private release(): void {
    if (this.audio) {
      this.audio.pause()
      this.audio.removeAttribute('src')
      this.audio.load() // 打断正在缓冲的请求
      this.audio = null
    }
    this.releaseUrl()
  }

  private releaseUrl(): void {
    if (this.url) {
      URL.revokeObjectURL(this.url)
      this.url = null
    }
  }
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
