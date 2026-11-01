// PNG 里塞 / 取角色卡数据。CRC 算错或块顺序排错，导出的卡 ST 就打不开，
// 而且在自己这边看起来完全正常——所以这里把整条来回都跑一遍。
import { describe, expect, it } from 'vitest'
import { readCardJson, solidPng, writeCardJson } from './png'

const base = (): Buffer => solidPng(4, 4, [10, 20, 30])

describe('PNG 角色卡数据块', () => {
  it('纯色 PNG 是合法 PNG：签名 + IHDR 打头 + 以 IEND 收尾', () => {
    const png = base()
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(png.toString('latin1', 12, 16)).toBe('IHDR')
    expect(png.toString('latin1', png.length - 8, png.length - 4)).toBe('IEND')
  })

  it('写进去的卡能原样读出来，中文不乱码', () => {
    const json = JSON.stringify({ spec: 'chara_card_v2', data: { name: '阿蕾', first_mes: '你来了。' } })
    const png = writeCardJson(base(), json)
    expect(readCardJson(png)).toBe(json)
  })

  it('没有卡数据的 PNG 返回 null（不是所有 PNG 都是角色卡）', () => {
    expect(readCardJson(base())).toBeNull()
  })

  it('重复导出不会在一张图里留下两份卡', () => {
    const first = writeCardJson(base(), '{"a":1}')
    const second = writeCardJson(first, '{"b":2}')
    expect(readCardJson(second)).toBe('{"b":2}')
    // 只剩一个 chara 块（关键字后面一定跟着 \0，base64 里不会出现这个字节）
    expect(second.toString('latin1').split('chara\u0000').length - 1).toBe(1)
  })

  it('不是 PNG 就报错，别把别的文件当卡读', () => {
    expect(() => readCardJson(Buffer.from('hello'))).toThrow('PNG')
    expect(() => writeCardJson(Buffer.from('hello'), '{}')).toThrow('PNG')
  })
})
