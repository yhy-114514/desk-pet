import { describe, expect, it } from 'vitest'
import {
  readEmotionPrefix,
  stripEmotionTags,
  stripStrayTags,
  tagForHistory,
  tagLegacyHistory
} from './emotion'

describe('stripStrayTags', () => {
  it('清掉写在别处的完整标记', () => {
    expect(stripStrayTags('（小声）<emo:shy>那个…')).toEqual({ text: '（小声）那个…', hold: '' })
  })

  it('末尾的半个标记先扣住，等下一块拼上', () => {
    expect(stripStrayTags('好的<emo:sh')).toEqual({ text: '好的', hold: '<emo:sh' })
    expect(stripStrayTags('<')).toEqual({ text: '', hold: '<' })
    expect(stripStrayTags('1 <')).toEqual({ text: '1 ', hold: '<' })
  })

  it('拼上后确认不是标记，就把扣住的内容原样放回去', () => {
    const first = stripStrayTags('1 <')
    expect(stripStrayTags(first.hold + '2 就行')).toEqual({ text: '<2 就行', hold: '' })
  })
})

describe('readEmotionPrefix', () => {
  it('完整标记：取出情绪并给出去掉标记的正文', () => {
    expect(readEmotionPrefix('<emo:happy>完了完了…')).toEqual({
      done: true,
      emotion: 'happy',
      rest: '完了完了…'
    })
  })

  it('标记被流式拆开时先等待', () => {
    expect(readEmotionPrefix('<emo:ha').done).toBe(false)
    expect(readEmotionPrefix('<emo:').done).toBe(false)
    expect(readEmotionPrefix('<').done).toBe(false)
  })

  it('攒够后拼出完整标记', () => {
    expect(readEmotionPrefix('<emo:sa', false).done).toBe(false)
    expect(readEmotionPrefix('<emo:sad>')).toEqual({ done: true, emotion: 'sad', rest: '' })
  })

  it('第一个字符不是 < 时立刻放行，不留延迟', () => {
    expect(readEmotionPrefix('哥哥')).toEqual({ done: true, emotion: null, rest: '哥哥' })
  })

  it('普通的尖括号开头不会被当成标记，原样放行', () => {
    // 虽然没有情绪标记，但出现了 `>`，立刻能判定不是 <emo:...>，不压字
    expect(readEmotionPrefix('<b>重要</b>')).toEqual({ done: true, emotion: null, rest: '<b>重要</b>' })
    // 一直没有 `>`：只能等到长度上限或流结束，最多压 24 个字符
    expect(readEmotionPrefix('<3 哥哥').done).toBe(false)
    expect(readEmotionPrefix('<3 哥哥', true).rest).toBe('<3 哥哥')
  })

  it('未闭合且太长：放弃识别，原样放行', () => {
    const buffer = '<' + 'x'.repeat(30)
    expect(readEmotionPrefix(buffer)).toEqual({ done: true, emotion: null, rest: buffer })
  })

  it('未知情绪名：标记照剥，情绪记 null', () => {
    expect(readEmotionPrefix('<emo:excited>耶')).toEqual({ done: true, emotion: null, rest: '耶' })
  })

  it('标记前后允许空白', () => {
    expect(readEmotionPrefix('\n<emo:shy> 那个…')).toEqual({
      done: true,
      emotion: 'shy',
      rest: '那个…'
    })
  })

  it('final 兜底：只收到半个标记也要放行，别把正文吞掉', () => {
    expect(readEmotionPrefix('<emo:hap', true)).toEqual({
      done: true,
      emotion: null,
      rest: '<emo:hap'
    })
    expect(readEmotionPrefix('', true)).toEqual({ done: true, emotion: null, rest: '' })
  })
})

describe('tagForHistory', () => {
  it('历史里把标记加回去，让模型有带标记的示范', () => {
    expect(tagForHistory('happy', '哥哥你回来啦')).toBe('<emo:happy>哥哥你回来啦')
    expect(tagForHistory(null, '哥哥你回来啦')).toBe('哥哥你回来啦')
  })
})

describe('tagLegacyHistory', () => {
  it('只给没标记的助手回复补 normal，用户消息和已有标记的原样保留', () => {
    const history = [
      { role: 'user', content: '哥哥回来啦' },
      { role: 'assistant', content: '欢迎回来！' },
      { role: 'assistant', content: '<emo:sad>累了就歇着吧' }
    ]
    expect(tagLegacyHistory(history)).toEqual([
      { role: 'user', content: '哥哥回来啦' },
      { role: 'assistant', content: '<emo:normal>欢迎回来！' },
      { role: 'assistant', content: '<emo:sad>累了就歇着吧' }
    ])
  })
})

describe('stripEmotionTags', () => {
  it('清掉写在别处的标记', () => {
    expect(stripEmotionTags('（小声）<emo:shy>那个…')).toBe('（小声）那个…')
    expect(stripEmotionTags('<emo:happy>哥哥')).toBe('哥哥')
    expect(stripEmotionTags('没有标记')).toBe('没有标记')
  })
})
