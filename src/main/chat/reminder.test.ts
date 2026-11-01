import { describe, expect, it } from 'vitest'
import {
  MAX_REMINDERS,
  STALE_MS,
  addToList,
  dueReminders,
  parseReminders,
  reminderInstruction,
  removeFromList,
  replaceInList,
  resolveAt,
  stripReminderTags,
  type Reminder
} from './reminder'

const NOW = new Date(2026, 9, 23, 21, 14, 0)
const MIN = 60 * 1000

describe('stripReminderTags', () => {
  it('完整标记从正文里去掉', () => {
    expect(stripReminderTags('<remind at="20:00">喝水</remind>好呀～').text).toBe('好呀～')
  })

  it('没闭合的开标记整段扣住，不漏进气泡', () => {
    const result = stripReminderTags('好呀<remind at="20:00">喝')
    expect(result.text).toBe('好呀')
    expect(result.hold).toBe('<remind at="20:00">喝')
  })

  it('末尾半个标记先扣住，等下一块拼上', () => {
    expect(stripReminderTags('好呀<rem').hold).toBe('<rem')
    expect(stripReminderTags('好呀<remind at="20').hold).toBe('<remind at="20')
    expect(stripReminderTags('好呀<').hold).toBe('<')
  })

  it('普通正文里的尖括号不会被误扣', () => {
    expect(stripReminderTags('好呀<3')).toEqual({ text: '好呀<3', hold: '' })
  })

  it('流结束时未闭合的标记直接丢弃，不留残片', () => {
    expect(stripReminderTags('好呀<remind at="20:00">喝水', true)).toEqual({
      text: '好呀',
      hold: ''
    })
  })

  it('流结束时的半截标记也丢弃（截断常停在 at 值中间）', () => {
    expect(stripReminderTags('好呀<remind at="20', true)).toEqual({ text: '好呀', hold: '' })
    expect(stripReminderTags('好呀<rem', true)).toEqual({ text: '好呀', hold: '' })
    expect(stripReminderTags('好呀</remind', true)).toEqual({ text: '好呀', hold: '' })
  })

  it('流结束时孤立的 `<` 仍放行，不吞正文', () => {
    expect(stripReminderTags('好呀<', true)).toEqual({ text: '好呀<', hold: '' })
  })
})

describe('resolveAt', () => {
  it('今天的时刻原样解析', () => {
    const at = resolveAt('22:30', NOW)
    expect(new Date(at as number).getHours()).toBe(22)
    expect(new Date(at as number).getMinutes()).toBe(30)
    expect(new Date(at as number).getDate()).toBe(23)
  })

  it('已经过去的时刻按明天算', () => {
    const at = resolveAt('09:00', NOW)
    expect(new Date(at as number).getDate()).toBe(24)
  })

  it('同一分钟算「现在」，不顺延到明天', () => {
    const now = new Date(2026, 9, 23, 20, 0, 30)
    const at = new Date(resolveAt('20:00', now) as number)
    expect(at.getDate()).toBe(23)
    expect(at.getHours()).toBe(20)
    expect(at.getMinutes()).toBe(0)
  })

  it('带日期的解析到指定那天', () => {
    const at = resolveAt('10-25 08:00', NOW)
    expect(new Date(at as number).getMonth()).toBe(9)
    expect(new Date(at as number).getDate()).toBe(25)
    expect(new Date(at as number).getHours()).toBe(8)
  })

  it('跨年：12 月里说「01-02」指的是明年', () => {
    const december = new Date(2026, 11, 28, 10, 0)
    const at = new Date(resolveAt('01-02 08:00', december) as number)
    expect(at.getFullYear()).toBe(2027)
    expect(at.getMonth()).toBe(0)
    expect(at.getDate()).toBe(2)
  })

  it('非法值返回 null', () => {
    expect(resolveAt('25:00', NOW)).toBeNull()
    expect(resolveAt('明天早上', NOW)).toBeNull()
    expect(resolveAt('13-45 08:00', NOW)).toBeNull()
  })

  it('不存在的日期返回 null，不静默滚到下个月', () => {
    // 2026 非闰年；setMonth 会把它们滚成 3 月 1 日 / 3 月 2 日 / 5 月 1 日
    expect(resolveAt('02-29 08:00', NOW)).toBeNull()
    expect(resolveAt('02-30 08:00', NOW)).toBeNull()
    expect(resolveAt('04-31 08:00', NOW)).toBeNull()
    // 闰年 2 月 29 日是合法的
    const leap = resolveAt('02-29 08:00', new Date(2028, 0, 1, 10, 0))
    expect(new Date(leap as number).getMonth()).toBe(1)
    expect(new Date(leap as number).getDate()).toBe(29)
  })
})

describe('parseReminders', () => {
  it('从整段回复里抽出一条提醒（当前 21:14，说 20:00 指的是明天）', () => {
    const raw = '<emo:smug>好呀～<remind at="20:00">喝水</remind>八点我喊你。'
    expect(parseReminders(raw, NOW)).toEqual([
      { at: new Date(2026, 9, 24, 20, 0).getTime(), text: '喝水' }
    ])
  })

  it('时间解析不出来或内容为空的不算', () => {
    expect(parseReminders('<remind at="晚上八点">喝水</remind>', NOW)).toEqual([])
    expect(parseReminders('<remind at="20:00">   </remind>', NOW)).toEqual([])
  })

  it('没有标记时返回空数组', () => {
    expect(parseReminders('<emo:normal>今天好热', NOW)).toEqual([])
  })
})

describe('dueReminders', () => {
  const at = (offsetMin: number): Reminder => ({
    at: NOW.getTime() + offsetMin * MIN,
    text: '喝水'
  })

  it('到点的进 due，未来的留在队列', () => {
    const result = dueReminders([at(-5), at(30)], NOW)
    expect(result.due).toHaveLength(1)
    expect(result.keep).toHaveLength(1)
  })

  it('错过太久的不再补，直接丢弃', () => {
    const result = dueReminders([at(-STALE_MS / MIN - 1), at(-30)], NOW)
    expect(result.due).toHaveLength(1)
    expect(result.keep).toHaveLength(0)
  })
})

describe('addToList', () => {
  it('同一时刻同一条内容只留一份', () => {
    const item: Reminder = { at: NOW.getTime(), text: '喝水' }
    expect(addToList(addToList([], item), item)).toEqual([item])
  })

  it('超过上限丢最早的', () => {
    let items: Reminder[] = []
    for (let i = 0; i < MAX_REMINDERS + 3; i++) {
      items = addToList(items, { at: NOW.getTime() + i * MIN, text: `第${i}条` })
    }
    expect(items).toHaveLength(MAX_REMINDERS)
    expect(items[0].text).toBe('第3条')
  })
})

describe('removeFromList / replaceInList', () => {
  const water: Reminder = { at: NOW.getTime() + 10 * MIN, text: '喝水' }
  const stretch: Reminder = { at: NOW.getTime() + 30 * MIN, text: '起来活动' }

  it('按「时刻 + 内容」撤掉一条，其余不动', () => {
    expect(removeFromList([water, stretch], water)).toEqual([stretch])
  })

  it('内容和时刻都改：旧的消失，新的留在原位置', () => {
    const next: Reminder = { at: NOW.getTime() + 20 * MIN, text: '喝热水' }
    expect(replaceInList([water, stretch], water, next)).toEqual([next, stretch])
  })

  it('改完撞上另一条时只留改写后的那条', () => {
    const next: Reminder = { at: stretch.at, text: stretch.text }
    expect(replaceInList([water, stretch], water, next)).toEqual([next])
  })

  it('找不到要改的那条时原样返回', () => {
    expect(replaceInList([water], { at: 0, text: '不存在' }, stretch)).toEqual([water])
  })
})

describe('reminderInstruction', () => {
  it('带上当前时间与提醒内容', () => {
    const text = reminderInstruction({ at: NOW.getTime(), text: '喝水' }, NOW)
    expect(text).toContain('21:14')
    expect(text).toContain('喝水')
  })
})
