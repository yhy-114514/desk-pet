// 主动消息的纯决策逻辑（无 electron 依赖，可直接被 vitest 单测）：
// 什么时候该开口、开口时给模型什么提示、开口后状态怎么记。
// 频率控制优先于打扰本身：全局冷却 + 每日上限 + 连续被无视时翻倍降频。

/** 时段问候的类型 */
export type Slot = 'morning' | 'noon' | 'evening'

export const PROACTIVE_VERSION = 1
/** 两次主动开口之间的基础冷却 */
export const BASE_COOLDOWN_MS = 20 * 60 * 1000
/** 连续被无视时冷却翻倍，最多翻到 8 倍（160 分钟） */
export const MAX_BACKOFF = 8
/** 每天最多主动「找人」次数（时段问候另算：每个时段每天各一次） */
export const DAILY_LIMIT = 3
/** 多久没和用户说话算「很久」 */
export const IDLE_MS = 30 * 60 * 1000
/** 问候也要求安静一会儿：刚聊完就道早安很怪 */
export const GREETING_MIN_IDLE_MS = 10 * 60 * 1000
/** 勿扰时段 [QUIET_START, QUIET_END)，跨零点 */
export const QUIET_START = 23
export const QUIET_END = 7

export interface ProactiveState {
  version: number
  /** 统计日期 YYYY-MM-DD，跨天时计数与问候记录一起清零 */
  day: string
  firedToday: number
  /** 上次真正说出口的时间戳（「有没有被无视」以它为准） */
  lastFiredAt: number | null
  /** 上次尝试开口的时间戳（含失败）：冷却以它为准，避免失败后每分钟重试 */
  lastAttemptAt: number | null
  /** 连续「主动开口后用户没回话」的次数，用户一说话就归零 */
  ignored: number
  /** 各时段问候最后一次发出的日期 */
  greetings: Partial<Record<Slot, string>>
}

export function emptyState(): ProactiveState {
  return {
    version: PROACTIVE_VERSION,
    day: '',
    firedToday: 0,
    lastFiredAt: null,
    lastAttemptAt: null,
    ignored: 0,
    greetings: {}
  }
}

/** 本地日期 YYYY-MM-DD（不用 toISOString：那是 UTC，凌晨会算成前一天） */
export function dayString(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** 当前小时落在哪个问候时段；不在任何时段返回 null */
export function timeSlot(hour: number): Slot | null {
  if (hour >= 7 && hour < 10) return 'morning'
  if (hour >= 11 && hour < 14) return 'noon'
  if (hour >= 19 && hour < 22) return 'evening'
  return null
}

export function isQuietHour(hour: number): boolean {
  return hour >= QUIET_START || hour < QUIET_END
}

/**
 * 当前「连续被无视」次数：上一次主动开口之后用户一句话都没说，就再加一。
 * 用户说话了（lastUserAt 晚于上次开口）则从头算。
 */
export function currentIgnored(state: ProactiveState, lastUserAt: number | null): number {
  if (state.lastFiredAt === null) return 0
  if (lastUserAt !== null && lastUserAt >= state.lastFiredAt) return 0
  return state.ignored + 1
}

/** 被无视得越多，下次开口等得越久 */
export function cooldownMs(ignored: number): number {
  return BASE_COOLDOWN_MS * Math.min(2 ** ignored, MAX_BACKOFF)
}

export interface DecideInput {
  now: Date
  state: ProactiveState
  /** 上次用户发言时间；从未说过话为 null */
  lastUserAt: number | null
  /** 配置里的「允许主动找我说话」 */
  enabled: boolean
  /** 正在回复 / 输入栏打开 / 配置窗打开等，一律不打扰 */
  busy: boolean
}

export type Decision =
  | { fire: false }
  | { fire: true; kind: 'greeting'; slot: Slot; ignored: number }
  | { fire: true; kind: 'idle'; ignored: number }

export function decideProactive(input: DecideInput): Decision {
  const { now, state, lastUserAt, enabled, busy } = input
  if (!enabled || busy) return { fire: false }
  if (isQuietHour(now.getHours())) return { fire: false }

  const day = dayString(now)
  const firedToday = state.day === day ? state.firedToday : 0

  const ignored = currentIgnored(state, lastUserAt)
  // 冷却看「上次尝试」而不是「上次成功」：请求失败时也要等一轮，别每分钟重试
  const lastAttempt = state.lastAttemptAt ?? state.lastFiredAt
  if (lastAttempt !== null && now.getTime() - lastAttempt < cooldownMs(ignored)) {
    return { fire: false }
  }

  // 从未说过话时视为「一直安静着」，只可能触发问候
  const idleMs = lastUserAt === null ? Number.POSITIVE_INFINITY : now.getTime() - lastUserAt

  // 时段问候优先：每个时段每天只有一次
  const slot = timeSlot(now.getHours())
  if (slot && state.greetings[slot] !== day && idleMs >= GREETING_MIN_IDLE_MS) {
    return { fire: true, kind: 'greeting', slot, ignored }
  }

  // 长时间没人说话：她来找你。
  // 每日上限只管这类「找人」，否则早上的问候 + 两次空闲就会把额度吃光，
  // 中午、晚上的问候永远轮不到——与「早/午/晚各一条」的设计矛盾。
  if (firedToday >= DAILY_LIMIT) return { fire: false }
  if (lastUserAt !== null && idleMs >= IDLE_MS) {
    return { fire: true, kind: 'idle', ignored }
  }

  return { fire: false }
}

/** 记录这次开口：跨天先清零计数，再累加次数、刷新冷却起点与问候记录。 */
export function applyFire(state: ProactiveState, decision: Decision, now: Date): ProactiveState {
  if (!decision.fire) return state
  const day = dayString(now)
  // 跨天：计数与问候记录一起重置，昨天的「已问候」不能挡住今天的
  const rolled: ProactiveState =
    state.day === day ? state : { ...state, day, firedToday: 0, greetings: {} }

  return {
    ...rolled,
    // 问候不占「找人」的每日额度，只由各时段自己的日期记录去重
    firedToday: decision.kind === 'idle' ? rolled.firedToday + 1 : rolled.firedToday,
    lastFiredAt: now.getTime(),
    lastAttemptAt: now.getTime(),
    ignored: decision.ignored,
    greetings:
      decision.kind === 'greeting'
        ? { ...rolled.greetings, [decision.slot]: day }
        : rolled.greetings
  }
}

/**
 * 这次尝试没说出话（断网 / 401 / 空回复）：不消耗每日额度与问候记录，
 * 但记下尝试时间，让她按正常冷却再试，而不是每分钟重发。
 */
export function applyAttemptFailure(state: ProactiveState, now: Date): ProactiveState {
  return { ...state, lastAttemptAt: now.getTime() }
}

const SLOT_LABEL: Record<Slot, string> = {
  morning: '早上',
  noon: '中午',
  evening: '晚上'
}

function clockText(now: Date): string {
  return `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`
}

/**
 * 把「多久没说话」说成人话。隔了两三天还报「2880 分钟」既荒谬，
 * 模型也会照着这个数字复述出来。
 */
export function humanGap(minutes: number): string {
  if (minutes < 90) return `${minutes} 分钟`
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时`
  return '好几天'
}

/**
 * 生成注入 system 末尾的主动开口提示。
 * 写成【系统：…】而不是 user 消息：她得知道这次是自己开口，不是哥哥在说话。
 */
export function proactiveInstruction(
  decision: Decision,
  now: Date,
  lastUserAt: number | null
): string {
  if (!decision.fire) return ''
  const time = clockText(now)
  if (decision.kind === 'greeting') {
    return `【系统：现在是 ${time}，${SLOT_LABEL[decision.slot]}。哥哥这会儿没在跟你说话，你主动跟他打个招呼，一两句话就好，自然一点，别像客服。】`
  }
  const minutes = lastUserAt === null ? 0 : Math.round((now.getTime() - lastUserAt) / 60_000)
  return `【系统：现在是 ${time}，哥哥已经 ${humanGap(minutes)}没跟你说话了。你忍不住主动开口找他，可以关心他、撒个娇，或者说说自己刚才在做什么。一两句话就好，别每次都问「在吗」。】`
}
