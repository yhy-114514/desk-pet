// 提醒调度：每 30 秒看一眼队列，到点就用主动消息那条链路说一句。
// 提醒是用户自己要求的，所以不受勿扰时段 / 每日上限 / 冷却约束；
// 但她正在说话、或输入栏开着时不插嘴，留到下个 tick。
import { dueReminders, reminderInstruction } from './chat/reminder'
import { addReminders, loadReminders, saveReminders } from './chat/reminderStore'
import { proactiveStatus, runProactiveTurn } from './chat/ipc'

const TICK_MS = 30_000

export function startReminderScheduler(isBusy: () => boolean): void {
  const timer = setInterval(() => {
    const now = new Date()
    const items = loadReminders()
    const { due, keep } = dueReminders(items, now)

    // 还没到点：只在确实丢弃了「错过太久」的条目时才回写
    if (!due.length) {
      if (keep.length !== items.length) saveReminders(keep)
      return
    }

    // 正在回复 / 输入栏看着：一个字都不动，下个 tick 再来
    if (proactiveStatus().busy || isBusy()) return

    const [first, ...rest] = due
    // 一次只发一条：两条同时到点连着轰炸很吵，剩下的留给下一个 tick
    const started = runProactiveTurn(reminderInstruction(first, now), (spoken) => {
      // 没说出话（断网 / 空回复）：放回队列，别让这条提醒凭空消失
      if (!spoken) addReminders([first])
    })
    if (started) saveReminders([...keep, ...rest])
  }, TICK_MS)

  // 不阻止进程退出
  timer.unref()
}
