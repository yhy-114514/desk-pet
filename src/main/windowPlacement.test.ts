import { describe, expect, it } from 'vitest'
import {
  MARGIN,
  MIN_VISIBLE,
  cornerPosition,
  isVisibleOn,
  resolvePosition,
  type Rect
} from './windowPlacement'

const SIZE = { width: 300, height: 420 }
// 两块 1920×1040（任务栏占 40）的屏幕，副屏在主屏右边
const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const SECOND: Rect = { x: 1920, y: 0, width: 1920, height: 1040 }

describe('cornerPosition', () => {
  it('落在主屏右下角并留出边距', () => {
    expect(cornerPosition(SIZE, PRIMARY)).toEqual({
      x: 1920 - 300 - MARGIN,
      y: 1040 - 420 - MARGIN
    })
  })

  it('副屏有自己的坐标偏移，落点是副屏的右下角', () => {
    expect(cornerPosition(SIZE, SECOND)).toEqual({
      x: 3840 - 300 - MARGIN,
      y: 1040 - 420 - MARGIN
    })
  })
})

describe('isVisibleOn', () => {
  it('完全在屏幕内 → 可见', () => {
    expect(isVisibleOn({ x: 100, y: 100, ...SIZE }, [PRIMARY])).toBe(true)
  })

  it('跨在两块屏幕之间 → 可见', () => {
    expect(isVisibleOn({ x: 1800, y: 100, ...SIZE }, [PRIMARY, SECOND])).toBe(true)
  })

  it('只露出一条边（不足阈值）→ 判定为看不见', () => {
    const barely = { x: 1920 - (MIN_VISIBLE - 1), y: 100, ...SIZE }
    expect(isVisibleOn(barely, [PRIMARY])).toBe(false)
  })

  it('整个在已拔掉的副屏上 → 看不见', () => {
    expect(isVisibleOn({ x: 2200, y: 100, ...SIZE }, [PRIMARY])).toBe(false)
    expect(isVisibleOn({ x: 2200, y: 100, ...SIZE }, [PRIMARY, SECOND])).toBe(true)
  })
})

describe('resolvePosition', () => {
  it('首次启动没有记录 → 主屏右下角', () => {
    expect(resolvePosition(null, SIZE, [PRIMARY, SECOND], PRIMARY)).toEqual(
      cornerPosition(SIZE, PRIMARY)
    )
  })

  it('记住的位置仍可见 → 原样沿用', () => {
    const saved = { x: 2100, y: 200 }
    expect(resolvePosition(saved, SIZE, [SECOND, PRIMARY], PRIMARY)).toEqual(saved)
  })

  it('副屏被拔掉 → 回主屏右下角', () => {
    const saved = { x: 2200, y: 200 }
    expect(resolvePosition(saved, SIZE, [PRIMARY], PRIMARY)).toEqual(
      cornerPosition(SIZE, PRIMARY)
    )
  })

  it('屏幕变小后原有位置只剩下一角 → 回主屏右下角', () => {
    const saved = { x: 1900, y: 1000 }
    expect(resolvePosition(saved, SIZE, [PRIMARY], PRIMARY)).toEqual(
      cornerPosition(SIZE, PRIMARY)
    )
  })
})
