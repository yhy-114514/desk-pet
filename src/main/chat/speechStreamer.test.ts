import { describe, expect, it } from 'vitest'
import { splitSpeechChunks } from './speech'
import { SpeechStreamer, type ChunkAudio } from './speechStreamer'

describe('splitSpeechChunks', () => {
  it('凑到一个句末标点就能开口，不必等整段', () => {
    const { chunks, rest } = splitSpeechChunks('哥哥你回来啦，我等你好久了。后面还有', false)
    expect(chunks).toEqual(['哥哥你回来啦，我等你好久了。'])
    expect(rest).toBe('后面还有')
  })

  it('太短的段（嗯。）并到下一句，不单独合成', () => {
    const { chunks, rest } = splitSpeechChunks('嗯。今天好累啊。', false)
    expect(chunks).toEqual(['嗯。今天好累啊。'])
    expect(rest).toBe('')
  })

  it('一次 push 里有好几句就全切出来，太短的最后一句留在尾巴等后续', () => {
    const { chunks, rest } = splitSpeechChunks('我回来啦。今天好热。你呢？', false)
    expect(chunks).toEqual(['我回来啦。', '今天好热。'])
    expect(rest).toBe('你呢？')
  })

  it('没有句末标点时先攒着', () => {
    expect(splitSpeechChunks('哥哥你回来', false)).toEqual({ chunks: [], rest: '哥哥你回来' })
  })

  it('一直没有标点的超长句会硬切（优先切在逗号后）', () => {
    const long = '哥哥你回来了呀，我一直在这边等着你没有走开，今天外面下雨了我又没有带伞所以淋湿了'
    const { chunks } = splitSpeechChunks(long, false)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].endsWith('，')).toBe(true)
    expect(chunks[0].length).toBeLessThanOrEqual(40)
  })

  it('final 时尾巴再短也交出去，清空 rest', () => {
    expect(splitSpeechChunks('再来一句', true)).toEqual({ chunks: ['再来一句'], rest: '' })
  })

  it('标点被拆在两个 token 之间也能正确切', () => {
    let buffer = ''
    const chunks: string[] = []
    for (const piece of ['哥哥你回来啦', '，我等你好久了', '。']) {
      buffer += piece
      const out = splitSpeechChunks(buffer, false)
      chunks.push(...out.chunks)
      buffer = out.rest
    }
    expect(chunks).toEqual(['哥哥你回来啦，我等你好久了。'])
    expect(buffer).toBe('')
  })
})

describe('SpeechStreamer', () => {
  /** 合成器：按文本记录调用顺序，可以控制每次耗时与失败 */
  function setup(behavior: (text: string) => 'ok' | 'fail' | Promise<void> = () => 'ok') {
    const synthesized: string[] = []
    const audio: ChunkAudio[] = []
    const ends = { count: 0 }
    const streamer = new SpeechStreamer({
      synthesize: async (text) => {
        synthesized.push(text)
        const mode = behavior(text)
        if (mode === 'fail') throw new Error('合成失败')
        if (mode instanceof Promise) await mode
        return { audio: Buffer.from(text), mime: 'audio/mpeg' }
      },
      onAudio: (chunk) => audio.push(chunk),
      onEnd: () => {
        ends.count++
      }
    })
    return { streamer, synthesized, audio, ends }
  }

  it('喂一句就合成一句，不用等流结束', async () => {
    const { streamer, synthesized, audio } = setup()

    streamer.push('哥哥你回来啦，我等你好久了。')
    // 只等一个宏任务：合成本身是同步返回的，pump 里 await 一次即可推进
    await Promise.resolve()
    await Promise.resolve()

    expect(synthesized).toEqual(['哥哥你回来啦，我等你好久了。'])
    expect(audio).toHaveLength(1)
    expect(audio[0].more).toBe(true) // 流还没结束
  })

  it('流结束时把尾巴补上，念完全部才 onEnd', async () => {
    const { streamer, synthesized, audio, ends } = setup()

    streamer.push('第一句。')
    streamer.end()
    await settle()

    expect(synthesized).toEqual(['第一句。'])
    expect(audio[0].more).toBe(false) // 已经是最后一句
    expect(ends.count).toBe(1)
  })

  it('多句按顺序下发，最后一句 more=false', async () => {
    const { streamer, audio, ends } = setup()

    streamer.push('第一句。第二句。第三句')
    streamer.end()
    await settle()

    expect(audio.map((a) => a.audio.toString())).toEqual(['第一句。', '第二句。', '第三句'])
    expect(audio.map((a) => a.more)).toEqual([true, true, false])
    expect(ends.count).toBe(1)
  })

  it('某一句合成失败只跳过这一句，后面的照常念', async () => {
    const { streamer, synthesized, audio, ends } = setup((text) =>
      text.includes('第二句') ? 'fail' : 'ok'
    )

    streamer.push('第一句。第二句。第三句')
    streamer.end()
    await settle()

    expect(synthesized).toEqual(['第一句。', '第二句。', '第三句'])
    expect(audio.map((a) => a.audio.toString())).toEqual(['第一句。', '第三句'])
    expect(ends.count).toBe(1)
  })

  it('全部失败也要 onEnd，否则渲染层会一直等一句不会来的话', async () => {
    const { streamer, audio, ends } = setup(() => 'fail')

    streamer.push('第一句。')
    streamer.end()
    await settle()

    expect(audio).toHaveLength(0)
    expect(ends.count).toBe(1)
  })

  it('取消之后不再排队、也不调 onEnd（调用方自己发 tts-stop）', async () => {
    const { streamer, synthesized, audio, ends } = setup()

    streamer.push('第一句。') // 这句已经派出去合成了，压缩不了
    streamer.cancel()
    streamer.push('第二句。')
    streamer.end()
    await settle()

    expect(synthesized).toEqual(['第一句。']) // 在途的那句不再回来
    expect(audio).toHaveLength(0) // 结果到了也丢，不念给已经换了话题的人听
    expect(ends.count).toBe(0)
  })

  it('合成期间新到的句子排队，不会并发开连接', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { streamer, synthesized, audio } = setup(() => gate)

    streamer.push('第一句。')
    streamer.push('第二句。')
    expect(synthesized).toEqual(['第一句。']) // 第二句在排队

    release()
    await settle()
    expect(synthesized).toEqual(['第一句。', '第二句。'])
    expect(audio).toHaveLength(2)
  })
})

/** 让串行队列的所有微任务跑完（每句至少几次 await）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
