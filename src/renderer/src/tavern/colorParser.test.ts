// 小说流三色解析：旁白 / 对话 / 动作切成片段，未闭合时保持已开状态。
import { describe, expect, it } from 'vitest'
import { parseColors } from './colorParser'

function kinds(text: string): string {
  return parseColors(text)
    .map((segment) => segment.kind)
    .join('|')
}

function texts(text: string): string[] {
  return parseColors(text).map((segment) => segment.text)
}

describe('三色切分', () => {
  it('纯旁白', () => {
    expect(parseColors('海风很凉。')).toEqual([{ kind: 'narration', text: '海风很凉。' }])
  })

  it('中文引号的对话', () => {
    expect(parseColors('她说：“你来了。”')).toEqual([
      { kind: 'narration', text: '她说：' },
      { kind: 'dialogue', text: '“你来了。”' }
    ])
  })

  it('「」与『』都算对话', () => {
    expect(kinds('「嗯。」她应了一声。')).toBe('dialogue|narration')
    expect(kinds('『快走。』')).toBe('dialogue')
  })

  it('中文全角括号里的动作', () => {
    expect(parseColors('（她转过身）走吧。')).toEqual([
      { kind: 'action', text: '（她转过身）' },
      { kind: 'narration', text: '走吧。' }
    ])
  })

  it('半角括号也算动作', () => {
    expect(kinds('(sigh) fine')).toBe('action|narration')
  })

  it('ASCII 双引号成对切换', () => {
    expect(kinds('He said "hi" then left.')).toBe('narration|dialogue|narration')
  })

  it('对话里的括号不打断对话', () => {
    expect(parseColors('“别动（小声）”')).toEqual([{ kind: 'dialogue', text: '“别动（小声）”' }])
  })

  it('动作里的引号不打断动作', () => {
    expect(parseColors('（她低声说“走吧”）')).toEqual([{ kind: 'action', text: '（她低声说“走吧”）' }])
  })

  it('未闭合的引号一直着色到段尾（流式中间态）', () => {
    expect(kinds('她说：“别')).toBe('narration|dialogue')
  })

  it('未闭合的括号同理', () => {
    expect(kinds('（她抬起')).toBe('action')
  })

  it('闭合之后回到旁白，后续不再错乱', () => {
    expect(kinds('“甲”“乙”丙')).toBe('dialogue|dialogue|narration')
  })

  it('空串没有片段', () => {
    expect(parseColors('')).toEqual([])
  })

  it('接续一段就补完上一段（同一段文本重算的稳定性）', () => {
    const partial = parseColors('她说：“别走')
    const full = parseColors('她说：“别走。”')
    expect(partial).toEqual([
      { kind: 'narration', text: '她说：' },
      { kind: 'dialogue', text: '“别走' }
    ])
    expect(full).toEqual([
      { kind: 'narration', text: '她说：' },
      { kind: 'dialogue', text: '“别走。”' }
    ])
  })

  it('多段混合的长消息：片段拼回去等于原文', () => {
    const text =
      '（她合上书）\n“今天想听什么？”\n窗外的雨声很轻，她等了一会儿，又补了一句：「还是老样子？」\n“嗯。”我应道。'
    expect(texts(text).join('')).toBe(text)
    expect(kinds(text)).toBe(
      'action|narration|dialogue|narration|dialogue|narration|dialogue|narration'
    )
  })

  it('只有标点 / 换行也照原样落在旁白里', () => {
    expect(parseColors('\n\n…')).toEqual([{ kind: 'narration', text: '\n\n…' }])
  })
})
