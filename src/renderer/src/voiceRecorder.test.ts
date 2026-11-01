import { describe, expect, it } from 'vitest'
import { encodeWav } from './voiceRecorder'

const ascii = (view: DataView, offset: number, length: number): string =>
  Array.from({ length }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join('')

describe('encodeWav', () => {
  it('头部字段是合法的 PCM16 单声道 WAV', () => {
    const view = new DataView(encodeWav(new Float32Array(4), 16_000))
    expect(ascii(view, 0, 4)).toBe('RIFF')
    expect(ascii(view, 8, 4)).toBe('WAVE')
    expect(ascii(view, 12, 4)).toBe('fmt ')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // 单声道
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(view, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(8) // 4 个采样 × 2 字节
  })

  it('整体长度正好是头 44 字节 + 采样', () => {
    expect(encodeWav(new Float32Array(10)).byteLength).toBe(44 + 20)
    expect(encodeWav(new Float32Array(0)).byteLength).toBe(44)
  })

  it('浮点采样转定点，超出范围按满幅削波而不是回绕', () => {
    const view = new DataView(encodeWav(new Float32Array([0, 0.5, 1, -1, 2, -3])))
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(16_383)
    expect(view.getInt16(48, true)).toBe(32_767)
    expect(view.getInt16(50, true)).toBe(-32_768)
    expect(view.getInt16(52, true)).toBe(32_767)
    expect(view.getInt16(54, true)).toBe(-32_768)
  })
})
