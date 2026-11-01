import { describe, expect, it } from 'vitest'
import {
  BASE_COOLDOWN_MS,
  DAILY_LIMIT,
  IDLE_MS,
  applyAttemptFailure,
  applyFire,
  cooldownMs,
  currentIgnored,
  dayString,
  decideProactive,
  emptyState,
  humanGap,
  isQuietHour,
  proactiveInstruction,
  timeSlot,
  type Decision
} from './proactive'

const MIN = 60 * 1000

/** 本地时间构造（不用 ISO 字符串，避免时区把测试日期推到前后一天） */
function at(hour: number, minute = 0, day = 23): Date {
  return new Date(2026, 9, day, hour, minute, 0, 0)
}

function stateAt(now: Date, patch: Partial<ReturnType<typeof emptyState>> = {}): ReturnType<typeof emptyState> {
  return { ...emptyState(), day: dayString(now), ...patch }
}

describe('timeSlot / quiet hour', () => {
  it('按小时划分早中晚时段', () => {
    expect(timeSlot(7)).toBe('morning')
    expect(timeSlot(9)).toBe('morning')
    expect(timeSlot(10)).toBeNull()
    expect(timeSlot(12)).toBe('noon')
    expect(timeSlot(14)).toBeNull()
    expect(timeSlot(19)).toBe('evening')
    expect(timeSlot(22)).toBeNull()
    expect(timeSlot(3)).toBeNull()
  })

  it('23:00–07:00 为勿扰时段，跨零点', () => {
    expect(isQuietHour(23)).toBe(true)
    expect(isQuietHour(0)).toBe(true)
    expect(isQuietHour(6)).toBe(true)
    expect(isQuietHour(7)).toBe(false)
    expect(isQuietHour(15)).toBe(false)
  })
})

describe('currentIgnored / cooldownMs', () => {
  it('从未开口过时不计被无视', () => {
    expect(currentIgnored(emptyState(), null)).toBe(0)
  })

  it('上次开口后用户没说话 → 连续次数 +1', () => {
    const now = at(15)
    const state = stateAt(now, { lastFiredAt: now.getTime() - 30 * MIN, ignored: 1 })
    expect(currentIgnored(state, now.getTime() - 60 * MIN)).toBe(2)
    expect(currentIgnored(state, null)).toBe(2)
  })

  it('用户在开口之后说过话 → 归零', () => {
    const now = at(15)
    const state = stateAt(now, { lastFiredAt: now.getTime() - 30 * MIN, ignored: 2 })
    expect(currentIgnored(state, now.getTime() - 10 * MIN)).toBe(0)
  })

  it('被无视越多冷却越长，最多 8 倍', () => {
    expect(cooldownMs(0)).toBe(BASE_COOLDOWN_MS)
    expect(cooldownMs(1)).toBe(BASE_COOLDOWN_MS * 2)
    expect(cooldownMs(3)).toBe(BASE_COOLDOWN_MS * 8)
    expect(cooldownMs(10)).toBe(BASE_COOLDOWN_MS * 8)
  })
})

describe('decideProactive', () => {
  it('关掉开关 / 忙碌 / 勿扰时段都不开口', () => {
    const now = at(15)
    const state = stateAt(now)
    const lastUserAt = now.getTime() - 60 * MIN
    expect(decideProactive({ now, state, lastUserAt, enabled: false, busy: false }).fire).toBe(false)
    expect(decideProactive({ now, state, lastUserAt, enabled: true, busy: true }).fire).toBe(false)
    expect(
      decideProactive({ now: at(23), state, lastUserAt, enabled: true, busy: false }).fire
    ).toBe(false)
  })

  it('空闲超过 30 分钟后主动开口', () => {
    const now = at(16)
    const decision = decideProactive({
      now,
      state: stateAt(now),
      lastUserAt: now.getTime() - IDLE_MS,
      enabled: true,
      busy: false
    })
    expect(decision).toEqual({ fire: true, kind: 'idle', ignored: 0 })
  })

  it('空闲不足 / 从未说过话时不触发空闲开口', () => {
    const now = at(16)
    const almost = now.getTime() - (IDLE_MS - MIN)
    expect(
      decideProactive({ now, state: stateAt(now), lastUserAt: almost, enabled: true, busy: false })
        .fire
    ).toBe(false)
    expect(
      decideProactive({ now, state: stateAt(now), lastUserAt: null, enabled: true, busy: false })
        .fire
    ).toBe(false)
  })

  it('全局冷却内不开口', () => {
    const now = at(16)
    const state = stateAt(now, { lastFiredAt: now.getTime() - 19 * MIN })
    expect(
      decideProactive({
        now,
        state,
        lastUserAt: now.getTime() - 60 * MIN,
        enabled: true,
        busy: false
      }).fire
    ).toBe(false)
  })

  it('连续被无视时按翻倍后的冷却等待', () => {
    const now = at(16)
    // 上一次开口在 25 分钟前，没人回：冷却变成 40 分钟
    const state = stateAt(now, { lastFiredAt: now.getTime() - 25 * MIN, ignored: 1 })
    expect(
      decideProactive({
        now,
        state,
        lastUserAt: now.getTime() - 120 * MIN,
        enabled: true,
        busy: false
      }).fire
    ).toBe(false)
  })

  it('达到每日上限后不再开口', () => {
    const now = at(16)
    const state = stateAt(now, { firedToday: DAILY_LIMIT, lastFiredAt: now.getTime() - 120 * MIN })
    expect(
      decideProactive({
        now,
        state,
        lastUserAt: now.getTime() - 120 * MIN,
        enabled: true,
        busy: false
      }).fire
    ).toBe(false)
  })

  it('时段问候优先于空闲开口，同一时段每天只发一次', () => {
    const now = at(8)
    const lastUserAt = now.getTime() - 60 * MIN
    const first = decideProactive({
      now,
      state: stateAt(now),
      lastUserAt,
      enabled: true,
      busy: false
    })
    expect(first).toEqual({ fire: true, kind: 'greeting', slot: 'morning', ignored: 0 })

    const fired = applyFire(stateAt(now), first, now)
    expect(fired.greetings.morning).toBe('2026-10-23')

    // 冷却过后同一时段不再问候（转到空闲分支）
    const later = new Date(now.getTime() + 60 * MIN)
    const second = decideProactive({
      now: later,
      state: fired,
      lastUserAt,
      enabled: true,
      busy: false
    })
    expect(second.fire).toBe(true)
    expect(second.fire && second.kind).toBe('idle')
  })

  it('刚聊完（不足 10 分钟）不道早安', () => {
    const now = at(8)
    expect(
      decideProactive({
        now,
        state: stateAt(now),
        lastUserAt: now.getTime() - 5 * MIN,
        enabled: true,
        busy: false
      }).fire
    ).toBe(false)
  })
})

describe('整日模拟', () => {
  it('整天没人回话：早中晚各问候一次，空闲找人不超过每日上限', () => {
    let state = emptyState()
    const start = new Date(2026, 9, 23, 0, 0)
    // 用户在模拟开始前一小时说过话，之后一直没回
    const lastUserAt = start.getTime() - 60 * MIN
    const fired: Decision[] = []

    for (let minute = 1; minute <= 24 * 60; minute++) {
      const now = new Date(start.getTime() + minute * MIN)
      const decision = decideProactive({ now, state, lastUserAt, enabled: true, busy: false })
      if (!decision.fire) continue
      fired.push(decision)
      state = applyFire(state, decision, now)
    }

    const greetings = fired.flatMap((d) => (d.fire && d.kind === 'greeting' ? [d.slot] : []))
    expect(greetings).toEqual(['morning', 'noon', 'evening'])

    const idles = fired.filter((d) => d.fire && d.kind === 'idle')
    expect(idles.length).toBeLessThanOrEqual(DAILY_LIMIT)
  })
})

describe('applyFire', () => {
  it('空闲找人累加每日次数并记录冷却起点', () => {
    const now = at(12)
    const next = applyFire(
      stateAt(now, { firedToday: 1 }),
      { fire: true, kind: 'idle', ignored: 0 },
      now
    )
    expect(next.firedToday).toBe(2)
    expect(next.lastFiredAt).toBe(now.getTime())
    expect(next.lastAttemptAt).toBe(now.getTime())
  })

  it('问候记录时段日期，但不占找人的每日次数', () => {
    const now = at(12)
    const decision: Decision = { fire: true, kind: 'greeting', slot: 'noon', ignored: 0 }
    const next = applyFire(stateAt(now, { firedToday: 2 }), decision, now)
    expect(next.firedToday).toBe(2)
    expect(next.greetings.noon).toBe('2026-10-23')
  })

  it('失败的尝试不消耗额度与问候，但按冷却等待', () => {
    const now = at(8)
    const failed = applyAttemptFailure(stateAt(now), now)
    expect(failed.firedToday).toBe(0)
    expect(failed.greetings).toEqual({})
    expect(failed.lastFiredAt).toBeNull()
    expect(failed.lastAttemptAt).toBe(now.getTime())

    // 一分钟后不该立刻重试
    expect(
      decideProactive({
        now: new Date(now.getTime() + MIN),
        state: failed,
        lastUserAt: now.getTime() - 60 * MIN,
        enabled: true,
        busy: false
      }).fire
    ).toBe(false)

    // 冷却过后仍然可以正常问候
    expect(
      decideProactive({
        now: new Date(now.getTime() + 21 * MIN),
        state: failed,
        lastUserAt: now.getTime() - 60 * MIN,
        enabled: true,
        busy: false
      }).fire
    ).toBe(true)
  })

  it('跨天时重置每日次数与问候记录', () => {
    const now = at(9, 0, 24)
    const state = {
      ...emptyState(),
      day: '2026-10-23',
      firedToday: 3,
      greetings: { morning: '2026-10-23' }
    }
    const next = applyFire(state, { fire: true, kind: 'greeting', slot: 'morning', ignored: 0 }, now)
    expect(next.day).toBe('2026-10-24')
    expect(next.firedToday).toBe(0)
    expect(next.greetings).toEqual({ morning: '2026-10-24' })
  })
})

describe('proactiveInstruction', () => {
  it('问候与空闲的提示文案不同，且带上时间', () => {
    const now = at(8, 30)
    const greeting = proactiveInstruction(
      { fire: true, kind: 'greeting', slot: 'morning', ignored: 0 },
      now,
      null
    )
    expect(greeting).toContain('8:30')
    expect(greeting).toContain('早上')

    const idle = proactiveInstruction(
      { fire: true, kind: 'idle', ignored: 0 },
      at(16),
      at(15).getTime()
    )
    expect(idle).toContain('60 分钟')
  })

  it('间隔天数多了不再报分钟数', () => {
    expect(humanGap(30)).toBe('30 分钟')
    expect(humanGap(60)).toBe('60 分钟')
    expect(humanGap(120)).toBe('2 小时')
    expect(humanGap(2880)).toBe('好几天')
  })

  it('不开口时返回空串', () => {
    expect(proactiveInstruction({ fire: false }, at(8), null)).toBe('')
  })
})
