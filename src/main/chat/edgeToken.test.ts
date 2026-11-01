import { describe, expect, it } from 'vitest'
import { generateSecMsGecV2 } from './edgeToken'

// 期望值来自 rany2/edge-tts PR #492 的 Python 参考实现，同一时间戳逐字比对过。
describe('Sec-MS-GEC v2 token', () => {
  it('固定时间戳产出固定的 token', () => {
    expect(generateSecMsGecV2(1792824456 * 1000)).toBe(
      '1E4EBE222D4AE124-5285B590FECB04CD7C54C5EAAEDDCD2EC450172FB44DD04E81455748869AFFD0'
    )
    expect(generateSecMsGecV2(1700000000 * 1000)).toBe(
      '2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2'
    )
  })

  it('同一 5 分钟窗口内的毫秒差异不影响结果', () => {
    expect(generateSecMsGecV2(1792824456789)).toBe(generateSecMsGecV2(1792824456 * 1000))
  })

  it('格式是 16 位 hex - 64 位 hex', () => {
    expect(generateSecMsGecV2(1700000000 * 1000)).toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/)
  })
})
