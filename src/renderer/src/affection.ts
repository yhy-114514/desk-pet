// 好感度纯逻辑：数值范围 0–100，初始 10，跨天被冷落 -1。
// 持久化由主进程负责（见 src/main/petStore.ts），本模块只管数值与等级。

export type AffectionLevel = 1 | 2 | 3 | 4

export interface AffectionData {
  affection: number
  lastActiveDate: string
}

export const AFFECTION_MIN = 0
export const AFFECTION_MAX = 100
export const AFFECTION_INITIAL = 10

/** 等级阈值：Lv1 0–19 / Lv2 20–49 / Lv3 50–79 / Lv4 80–100（behavior.md 第四节）。 */
export function levelFor(value: number): AffectionLevel {
  if (value < 20) return 1
  if (value < 50) return 2
  if (value < 80) return 3
  return 4
}

/** 本地日期字符串 YYYY-MM-DD（用本地时区，避免 UTC 跨日偏差）。 */
export function localDateString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export class Affection {
  private value: number
  private activeDate: string

  constructor(initial = AFFECTION_INITIAL, lastActiveDate = '') {
    this.value = clamp(initial)
    this.activeDate = lastActiveDate
  }

  get affection(): number {
    return this.value
  }

  get level(): AffectionLevel {
    return levelFor(this.value)
  }

  get storeData(): AffectionData {
    return { affection: this.value, lastActiveDate: this.activeDate }
  }

  /** 增减好感度并记录今天活跃，返回实际变化量（可能被 clamp 截断）。 */
  add(delta: number, today: string): number {
    const before = this.value
    this.value = clamp(this.value + delta)
    this.markActive(today)
    return this.value - before
  }

  markActive(today: string): void {
    this.activeDate = today
  }

  /**
   * 启动时的每日冷落结算：跨天 -1，同日不变。
   * 首次启动（activeDate 为空）只记录今天、不扣分。
   * 返回实际变化量。
   */
  applyDailyDecay(today: string): number {
    if (this.activeDate === '') {
      this.activeDate = today
      return 0
    }
    if (this.activeDate === today) return 0

    const before = this.value
    this.value = clamp(this.value - 1)
    this.activeDate = today
    return this.value - before
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return AFFECTION_INITIAL
  return Math.min(AFFECTION_MAX, Math.max(AFFECTION_MIN, Math.round(value)))
}
