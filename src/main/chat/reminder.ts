// 提醒的纯逻辑（无 electron 依赖）：人设约定她把「要提醒的事」写成
// `<remind at="20:00">喝水</remind>`，这里负责把它从正文里摘出来、解析成时间戳，
// 以及到点时给模型的那句提示。标记用户看不到，只走系统侧。

export interface Reminder {
  /** 触发时间戳（毫秒） */
  at: number
  text: string
}

/** 每条提醒保留的正文长度上限（模型偶尔会把整段话塞进标记） */
export const REMINDER_MAX_CHARS = 60
/** 提醒队列上限，超出丢最早的（一条提醒提醒不到不该拖垮整份文件） */
export const MAX_REMINDERS = 20
/**
 * 错过了多久就不再补。关着机过夜、第二天开机时喊你「八点该喝水了」很荒谬，
 * 这种提醒直接丢弃；两小时内的还是补上。
 */
export const STALE_MS = 2 * 60 * 60 * 1000

/** 完整标记：`<remind at="…">正文</remind>`（at 引号内不含引号） */
const BLOCK = /<remind\s+at="([^"]*)"\s*>([\s\S]*?)<\/remind\s*>/gi
/** 没闭合的开标记：从它往后都是「还没说完的标记」，不能漏进气泡 */
const OPEN_TAG = /<remind\s+at="[^"]*"\s*>/i
/** 末尾可能是半个标记的残片（`<`、`<re`、`<remind at="20:` …） */
const PARTIAL = /<(?:\/?(?:r(?:e(?:m(?:i(?:n(?:d(?:\s+(?:a(?:t(?:="[^"]*)?)?)?)?)?)?)?)?)?)?)?$/i

/**
 * 流式清洗：把提醒标记从正文里去掉；末尾可能是半个标记的部分先扣住，
 * final=true 时（流结束）不再扣，未闭合的标记直接丢弃——它本来就不是有效提醒。
 */
export function stripReminderTags(text: string, final = false): { text: string; hold: string } {
  const clean = text.replace(BLOCK, '')
  const open = OPEN_TAG.exec(clean)
  if (open) {
    if (final) return { text: clean.slice(0, open.index), hold: '' }
    return { text: clean.slice(0, open.index), hold: clean.slice(open.index) }
  }
  const partial = clean.match(PARTIAL)
  // 流结束时半截标记同样不能漏出去（MAX_TOKENS 截断 / 流中断常停在这里）。
  // 但只剩一个孤零零的 `<` 时放行——那多半只是正文里的字符，不是标记的开头
  const cut = partial && (partial[0].length > 1 || !final) ? partial[0] : ''
  if (final) return { text: cut ? clean.slice(0, clean.length - cut.length) : clean, hold: '' }
  if (!cut) return { text: clean, hold: '' }
  return { text: clean.slice(0, clean.length - cut.length), hold: cut }
}

/**
 * 把 `at` 的值解析成本地时间戳。
 * - `HH:MM`：今天；已经过了就按明天算（说「八点提醒我」时不会是指几小时前）
 * - `MM-DD HH:MM`：今年；已过去超过一天则按下一年（12 月里说 01-02）
 * 解析不出来返回 null，调用方当作没提过。
 */
export function resolveAt(spec: string, now: Date): number | null {
  const timeOnly = /^(\d{1,2}):(\d{2})$/.exec(spec.trim())
  if (timeOnly) {
    const hour = Number(timeOnly[1])
    const minute = Number(timeOnly[2])
    if (hour > 23 || minute > 59) return null
    const date = new Date(now)
    date.setHours(hour, minute, 0, 0)
    // 按分钟比较：模型照着 system 里的【当前时间】换算，可能正好给出这一分钟，
    // 用 `<=` 会把它当成「已经过去了」顺延到明天，24 小时后才响
    const nowMinute = new Date(now)
    nowMinute.setSeconds(0, 0)
    if (date.getTime() < nowMinute.getTime()) date.setDate(date.getDate() + 1)
    return date.getTime()
  }

  const withDate = /^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(spec.trim())
  if (withDate) {
    const month = Number(withDate[1])
    const day = Number(withDate[2])
    const hour = Number(withDate[3])
    const minute = Number(withDate[4])
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null
    const date = new Date(now)
    date.setMonth(month - 1, day)
    date.setHours(hour, minute, 0, 0)
    // setMonth 会把不存在的日期往后滚（「02-30」→ 3 月 2 日、「04-31」→ 5 月 1 日），
    // 那样提醒会在错误的日子响且没人能察觉：日子对不上就当作没提过
    if (date.getMonth() !== month - 1 || date.getDate() !== day) return null
    // 日期已经过去一天以上 → 指的是明年（跨年时说「01-02」）
    if (date.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
      date.setFullYear(date.getFullYear() + 1)
    }
    return date.getTime()
  }

  return null
}

/** 从一整段模型原文里抽出所有有效提醒（时间解析不出来的直接丢）。 */
export function parseReminders(raw: string, now: Date): Reminder[] {
  const found: Reminder[] = []
  for (const match of raw.matchAll(BLOCK)) {
    const at = resolveAt(match[1], now)
    const text = match[2].trim().slice(0, REMINDER_MAX_CHARS)
    if (at === null || !text) continue
    found.push({ at, text })
  }
  return found
}

/**
 * 把队列分成「到点该说」和「继续等」两批。
 * 太旧的（错过超过 STALE_MS）两批都不进——直接丢弃。
 */
export function dueReminders(
  items: Reminder[],
  now: Date
): { due: Reminder[]; keep: Reminder[] } {
  const due: Reminder[] = []
  const keep: Reminder[] = []
  for (const item of items) {
    if (!Number.isFinite(item.at) || !item.text.trim()) continue
    if (item.at > now.getTime()) {
      keep.push(item)
      continue
    }
    if (now.getTime() - item.at <= STALE_MS) due.push(item)
  }
  return { due, keep }
}

/** 同一时刻同一条内容只留一份（模型偶尔会把同一条提醒说两遍）。 */
export function addToList(items: Reminder[], item: Reminder): Reminder[] {
  const exists = items.some((it) => it.at === item.at && it.text === item.text)
  if (exists) return items
  return [...items, item].slice(-MAX_REMINDERS)
}

/** 队列里没有 id，靠「时刻 + 内容」认一条——addToList 保证了它俩组合唯一 */
function sameReminder(a: Reminder, b: Reminder): boolean {
  return a.at === b.at && a.text === b.text
}

/** 撤掉一条提醒（提醒列表页的「×」）。找不到就当没这回事，不报错。 */
export function removeFromList(items: Reminder[], target: Reminder): Reminder[] {
  return items.filter((it) => !sameReminder(it, target))
}

/**
 * 改写一条提醒：认旧的「时刻 + 内容」，换成新的。
 * 改完如果和另一条撞了（同一刻同一句），只留改写后的这条。
 */
export function replaceInList(items: Reminder[], from: Reminder, to: Reminder): Reminder[] {
  const index = items.findIndex((it) => sameReminder(it, from))
  if (index < 0) return items
  return items
    .map((it, i) => (i === index ? to : it))
    .filter((it, i) => i === index || !sameReminder(it, to))
}

/** 到点时注入 system 的那句话（写成【系统：…】，她才知道这是自己答应过的事）。 */
export function reminderInstruction(item: Reminder, now: Date): string {
  const time = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`
  // 「只说这件事」是实测出来的：上下文正聊得起劲时（比如一直在说充电线），
  // 只说「提醒他」模型会顺着旧话题往下聊，提醒就此被悄悄吞掉。
  return `【系统：现在是 ${time}。你之前答应过要提醒他一件事——「${item.text}」，现在到点了。这条消息只说这件事：主动开口提醒他，别顺着刚才的话题继续聊，一两句话，自然一点，别像闹钟。】`
}
