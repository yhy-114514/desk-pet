import { describe, expect, it } from 'vitest'
import {
  EDGE_VOICES,
  QWEN_VOICES,
  TTS_VOICE,
  emotionInstruction,
  escapeSsml,
  isKnownVoice,
  providerFor,
  providerOfVoice,
  stripForSpeech,
  voicesFor
} from './speech'

describe('stripForSpeech', () => {
  it('普通中文原样保留', () => {
    expect(stripForSpeech('哥哥你回来啦，我等你好久了。')).toBe('哥哥你回来啦，我等你好久了。')
  })

  it('去掉 markdown 记号，保留文字', () => {
    expect(stripForSpeech('**完了完了**…我又*八股*了')).toBe('完了完了…我又八股了')
    expect(stripForSpeech('- 第一条\n- 第二条')).toBe('第一条 第二条')
    expect(stripForSpeech('# 标题')).toBe('标题')
  })

  it('代码块整段丢弃，行内代码保留内容', () => {
    expect(stripForSpeech('这样写 `npm run dev` 就行')).toBe('这样写 npm run dev 就行')
    expect(stripForSpeech('看这里\n```js\nconsole.log(1)\n```\n明白了吗')).toBe('看这里 明白了吗')
  })

  it('链接只留文字，裸链接丢弃', () => {
    expect(stripForSpeech('参考[这个](https://a.com/b)吧')).toBe('参考这个吧')
    expect(stripForSpeech('详见 https://a.com/b 哦')).toBe('详见 哦')
  })

  it('去掉 emoji，折叠空白', () => {
    expect(stripForSpeech('好耶🐟🎉！')).toBe('好耶！')
    expect(stripForSpeech('  你好   世界  ')).toBe('你好 世界')
  })

  it('括号里的动作 / 状态描写不念（全角半角都算）', () => {
    expect(stripForSpeech('（小声）那个…哥哥')).toBe('那个…哥哥')
    expect(stripForSpeech('（歪头）你说什么？')).toBe('你说什么？')
    expect(stripForSpeech('我(小声)才没有害羞呢')).toBe('我才没有害羞呢')
  })

  it('markdown 链接先于括号处理，不会被当成描写误删', () => {
    expect(stripForSpeech('参考[这个](https://a.com/b)吧')).toBe('参考这个吧')
  })

  it('括号没闭合时原样保留，不吞掉后面的台词', () => {
    expect(stripForSpeech('（小声今天好热')).toBe('（小声今天好热')
  })

  it('纯符号清洗后为空', () => {
    expect(stripForSpeech('**')).toBe('')
    expect(stripForSpeech('🐟🐟')).toBe('')
  })
})

describe('emotionInstruction', () => {
  it('没有情绪 / normal 不加指令（交给音色本身语气）', () => {
    expect(emotionInstruction(null)).toBeNull()
    expect(emotionInstruction(undefined)).toBeNull()
    expect(emotionInstruction('normal')).toBeNull()
  })

  it('每种情绪都有一句具体指令，且各不相同', () => {
    const emotions = ['happy', 'sad', 'angry', 'surprised', 'shy', 'smug'] as const
    const texts = emotions.map((e) => emotionInstruction(e))
    for (const text of texts) {
      expect(text).toBeTruthy()
      expect(text!.length).toBeGreaterThan(8) // 要能描述语速 / 音调 / 情绪，不是单个词
    }
    expect(new Set(texts).size).toBe(emotions.length)
  })

  it('高兴是快而亮，难过是慢而沉', () => {
    expect(emotionInstruction('happy')).toContain('语速稍快')
    expect(emotionInstruction('sad')).toContain('语速放慢')
  })
})

describe('通道与音色名单', () => {
  it('没配 Key 走免费的 edge，配了走千问', () => {
    expect(providerFor(false)).toBe('edge')
    expect(providerFor(true)).toBe('qwen')
  })

  it('两套音色分开，名字互不通用', () => {
    expect(voicesFor('edge')).toBe(EDGE_VOICES)
    expect(voicesFor('qwen')).toBe(QWEN_VOICES)
    expect(isKnownVoice(TTS_VOICE, 'edge')).toBe(true)
    expect(isKnownVoice(TTS_VOICE, 'qwen')).toBe(false)
    expect(isKnownVoice(QWEN_VOICES[0].name, 'edge')).toBe(false)
  })

  it('按音色名反查通道：两套都能认，乱写返回 null', () => {
    expect(providerOfVoice(TTS_VOICE)).toBe('edge')
    expect(providerOfVoice(QWEN_VOICES[0].name)).toBe('qwen')
    expect(providerOfVoice('Cherry')).toBeNull()
    expect(providerOfVoice('')).toBeNull()
  })

  it('每个音色都有标签，默认音色在各自名单里', () => {
    expect(EDGE_VOICES[0].name).toBe(TTS_VOICE)
    for (const voice of [...EDGE_VOICES, ...QWEN_VOICES]) {
      expect(voice.label.length).toBeGreaterThan(0)
    }
  })
})

describe('escapeSsml', () => {
  it('转义尖括号与 &，且 & 先处理不会二次转义', () => {
    expect(escapeSsml('1 < 2')).toBe('1 &lt; 2')
    expect(escapeSsml('A&B')).toBe('A&amp;B')
    expect(escapeSsml('<tag>')).toBe('&lt;tag&gt;')
    expect(escapeSsml('a &lt; b')).toBe('a &amp;lt; b')
  })

  it('普通中文不受影响', () => {
    expect(escapeSsml('哥哥你回来啦')).toBe('哥哥你回来啦')
  })
})
