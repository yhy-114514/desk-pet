// 主动消息调度：每分钟判断一次「现在适合打扰吗」，合适就让主进程替她开一轮对话。
// 决策逻辑在 chat/proactive.ts（纯函数），这里只负责计时、读写 proactive.json 和下发。
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig } from './chat/config'
import { proactiveStatus, runProactiveTurn } from './chat/ipc'
import {
  PROACTIVE_VERSION,
  applyAttemptFailure,
  applyFire,
  decideProactive,
  emptyState,
  proactiveInstruction,
  type ProactiveState,
  type Slot
} from './chat/proactive'

/** 一分钟一判：比这更密没有意义，也比这更疏会错过整点问候时段 */
const TICK_MS = 60_000

const SLOTS: Slot[] = ['morning', 'noon', 'evening']

export function proactivePath(): string {
  return join(app.getPath('userData'), 'proactive.json')
}

export function loadProactiveState(): ProactiveState {
  const file = proactivePath()
  try {
    if (!existsSync(file)) return emptyState()
    return sanitize(JSON.parse(readFileSync(file, 'utf-8')) as Partial<ProactiveState>)
  } catch {
    return emptyState()
  }
}

function saveProactiveState(state: ProactiveState): void {
  const file = proactivePath()
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
    renameSync(tmp, file)
  } catch (error) {
    console.error('[proactive] 写入失败', error)
  }
}

function sanitize(raw: Partial<ProactiveState>): ProactiveState {
  const base = emptyState()
  if (!raw || typeof raw !== 'object') return base
  const greetings: Partial<Record<Slot, string>> = {}
  for (const slot of SLOTS) {
    const value = raw.greetings?.[slot]
    if (typeof value === 'string') greetings[slot] = value
  }
  return {
    version: PROACTIVE_VERSION,
    day: typeof raw.day === 'string' ? raw.day : '',
    firedToday:
      typeof raw.firedToday === 'number' && Number.isFinite(raw.firedToday)
        ? Math.max(0, Math.floor(raw.firedToday))
        : 0,
    lastFiredAt:
      typeof raw.lastFiredAt === 'number' && Number.isFinite(raw.lastFiredAt)
        ? raw.lastFiredAt
        : null,
    lastAttemptAt:
      typeof raw.lastAttemptAt === 'number' && Number.isFinite(raw.lastAttemptAt)
        ? raw.lastAttemptAt
        : null,
    ignored:
      typeof raw.ignored === 'number' && Number.isFinite(raw.ignored)
        ? Math.max(0, Math.floor(raw.ignored))
        : 0,
    greetings
  }
}

/**
 * 启动调度器。isBusy 由调用方提供（输入栏 / 配置窗是否打开）；
 * 「正在回复」由 chat/ipc 自己判断，避免调度器碰会话内部状态。
 */
export function startProactiveScheduler(isBusy: () => boolean): void {
  let state = loadProactiveState()

  const timer = setInterval(() => {
    const now = new Date()
    const status = proactiveStatus()
    const decision = decideProactive({
      now,
      state,
      lastUserAt: status.lastUserAt,
      enabled: loadConfig().proactiveEnabled,
      busy: status.busy || isBusy()
    })
    if (!decision.fire) return

    // 状态在这轮真正结束后才记：没有 Key / 被别的回合挡住时不该耗掉问候；
    // 请求失败或一个字都没说出来时回滚额度（只留尝试时间，避免每分钟重试）
    const baseline = state
    const instruction = proactiveInstruction(decision, now, status.lastUserAt)
    runProactiveTurn(instruction, (spoken) => {
      state = spoken ? applyFire(baseline, decision, now) : applyAttemptFailure(baseline, now)
      saveProactiveState(state)
    })
  }, TICK_MS)

  // 计时器不阻止进程退出
  timer.unref()
}
