import { describe, expect, it } from 'vitest'
import { parseSSEChunk } from './deepseek'

const event = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

describe('parseSSEChunk', () => {
  it('解析单个完整事件', () => {
    const result = parseSSEChunk(event('你好'))
    expect(result.deltas).toEqual(['你好'])
    expect(result.done).toBe(false)
    expect(result.rest).toBe('')
  })

  it('一次解析多个事件', () => {
    const result = parseSSEChunk(event('你') + event('好'))
    expect(result.deltas).toEqual(['你', '好'])
  })

  it('半截事件留在 rest 中，不产出增量', () => {
    const result = parseSSEChunk('data: {"choices":[{"delta":{"content":"半')
    expect(result.deltas).toEqual([])
    expect(result.rest).toContain('半')
  })

  it('rest 与下一块拼接后可解析', () => {
    const first = parseSSEChunk('data: {"choices":[{"delta":{"content":"半')
    const second = parseSSEChunk(first.rest + '截"}}]}\n\n')
    expect(second.deltas).toEqual(['半截'])
  })

  it('识别 [DONE]', () => {
    const result = parseSSEChunk(`data: [DONE]\n\n`)
    expect(result.done).toBe(true)
  })

  it('兼容 CRLF 换行', () => {
    const raw = `data: ${JSON.stringify({ choices: [{ delta: { content: '嗨' } }] })}\r\n\r\n`
    expect(parseSSEChunk(raw).deltas).toEqual(['嗨'])
  })

  it('跳过坏 JSON 与空 delta', () => {
    const raw =
      'data: {oops\n\n' +
      `data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`
    expect(parseSSEChunk(raw).deltas).toEqual(['ok'])
  })

  it('忽略非 data 行（注释 / 心跳）', () => {
    const raw = `: keep-alive\n\n${event('咚')}`
    expect(parseSSEChunk(raw).deltas).toEqual(['咚'])
  })
})
