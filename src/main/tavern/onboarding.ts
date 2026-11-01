// 首次启动引导用的一次性记号。
// 与 appearance / 提示词设置一样存在全局 settings 表（key/value），不加表不加迁移。
import { openTavernDb } from './db'

const SETTING_KEY = 'tavern.onboarding'

export interface OnboardingState {
  /** 引导弹窗已经走过了（导入过卡或点了跳过） */
  firstRunDone: boolean
  /** 「聊完第一轮」的小提示已经出现过了 */
  greetShown: boolean
  /** 现有角色卡数量：有卡就不必弹引导 */
  cardCount: number
}

function readFlags(): { firstRunDone: boolean; greetShown: boolean } {
  const row = openTavernDb().prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY) as
    | { value: unknown }
    | undefined
  if (!row) return { firstRunDone: false, greetShown: false }
  try {
    const parsed: unknown = JSON.parse(String(row['value']))
    const data = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    return { firstRunDone: data['firstRunDone'] === true, greetShown: data['greetShown'] === true }
  } catch {
    return { firstRunDone: false, greetShown: false }
  }
}

export function getOnboardingState(): OnboardingState {
  const db = openTavernDb()
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM characters WHERE deleted_at IS NULL')
    .get() as { n: unknown }
  return { ...readFlags(), cardCount: Number(row.n) }
}

export function setOnboardingFlags(patch: Partial<Pick<OnboardingState, 'firstRunDone' | 'greetShown'>>): OnboardingState {
  const next = { ...readFlags(), ...patch }
  openTavernDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(SETTING_KEY, JSON.stringify(next))
  return getOnboardingState()
}
