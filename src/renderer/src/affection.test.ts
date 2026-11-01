import { describe, expect, it } from 'vitest'
import { Affection, levelFor, localDateString } from './affection'

describe('Affection 好感度', () => {
  it('初始好感 10，等级 Lv1', () => {
    const a = new Affection()
    expect(a.affection).toBe(10)
    expect(a.level).toBe(1)
  })

  it('等级阈值边界', () => {
    expect(levelFor(0)).toBe(1)
    expect(levelFor(19)).toBe(1)
    expect(levelFor(20)).toBe(2)
    expect(levelFor(49)).toBe(2)
    expect(levelFor(50)).toBe(3)
    expect(levelFor(79)).toBe(3)
    expect(levelFor(80)).toBe(4)
    expect(levelFor(100)).toBe(4)
  })

  it('add 在 0–100 之间截断并返回实际变化量', () => {
    const a = new Affection(99)
    expect(a.add(5, '2026-10-21')).toBe(1)
    expect(a.affection).toBe(100)
    expect(a.add(-200, '2026-10-21')).toBe(-100)
    expect(a.affection).toBe(0)
  })

  it('跨天被冷落 -1，同日不变', () => {
    const a = new Affection(10, '2026-10-20')
    expect(a.applyDailyDecay('2026-10-21')).toBe(-1)
    expect(a.affection).toBe(9)
    expect(a.applyDailyDecay('2026-10-21')).toBe(0)
  })

  it('首次启动（无历史日期）只记录今天，不扣分', () => {
    const a = new Affection(10, '')
    expect(a.applyDailyDecay('2026-10-21')).toBe(0)
    expect(a.affection).toBe(10)
    expect(a.storeData.lastActiveDate).toBe('2026-10-21')
  })

  it('add 会记录当天活跃', () => {
    const a = new Affection(10, '2026-10-20')
    a.add(1, '2026-10-21')
    expect(a.storeData.lastActiveDate).toBe('2026-10-21')
  })

  it('localDateString 输出本地 YYYY-MM-DD', () => {
    expect(localDateString(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})
