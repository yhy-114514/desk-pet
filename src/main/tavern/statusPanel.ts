// 卡里的状态栏是「每轮都该挂在正文后面」的面板，但它靠两套机制出现：
//   单角色卡：MVU 给每条 AI 消息补一个 `<StatusPlaceHolderImpl/>` 占位符，正则把它换成页面；
//   多角色卡：世界书要求模型自己输出 `[宝可梦状态栏_始]…[宝可梦状态栏_末]`（数据在里面）。
// 我们两样都没有时，面板只在开场白里出现一次，聊完一轮就没了。
//
// 这里做的是「补最后一条」：最新回复没有面板时，沿用前面最近一次的原块重新渲染。
// 只认开场白里就带着的那种块——论坛 / 手机这类按需弹出的面板不在开场白里，不能每轮带出来。
// 只补最后一条：状态是会话级的，把旧块复制到每一条历史回复上只会得到一排一模一样的面板。
import { compileRule, type RegexRule } from './regexEngine'

export interface DisplayMessage {
  id: string
  role: string
  content: string
}

/**
 * 替换文本是不是「一整块 HTML 页面」。
 * 卡里三种写法都见过：``` 围栏、`<!DOCTYPE html>` 整页、以内联 `<div style=…>` 开头的长面板。
 * 长的那个门槛是为了不把「把某某词包成 <span>」这类小规则也当成面板——
 * 那种规则一旦被 carry，页面上会多出一段凭空冒出来的标签。
 */
function isHtmlReplacement(replacement: string): boolean {
  const text = replacement.trim()
  if (!text) return false
  if (text.includes('```')) return true
  if (/^<!doctype|<html[\s>]/i.test(text)) return true
  return text.startsWith('<') && text.length >= 500
}

/** 会让「卡自带的状态栏页面」出现的那种显示侧规则 */
function isPanelRule(rule: RegexRule): boolean {
  if (!rule.enabled || rule.target === 'prompt') return false
  // `$1` = 把捕获到的面板数据塞进页面；`<XxxPlaceHolder/>` = MVU 那种占位标签；
  // 剩下的是「普通词 → 整页 HTML」（《为什么妹妹才是勇者？！》的「开场白」「主要角色介绍」）。
  // 只认前两种的话，这类卡的页面聊完一轮就再也补不回来
  return (
    rule.replacement.includes('$1') ||
    /^<[\w.:-]+(?:\s[^<>]*)?\/>$/.test(rule.pattern.trim()) ||
    isHtmlReplacement(rule.replacement)
  )
}

/**
 * 卡自己会画状态页（显示侧规则把占位符换成 HTML 页面）。
 * 这时聊天页顶部那条纯文本状态就是重复的：变量一多就是满屏「世界/当前时间: …」，
 * 把真正的状态页挤到看不见。那条只留给「只有变量、没有页面」的卡兜底。
 */
export function hasStatusPage(rules: RegexRule[]): boolean {
  return rules.some(
    (rule) => rule.enabled && rule.target !== 'prompt' && isHtmlReplacement(rule.replacement)
  )
}

/**
 * MVU 卡的占位标签（`<StatusPlaceHolderImpl/>`）。
 * 真 MVU 扩展会给**每条** AI 回复末尾补一个，正则再把它换成状态页；我们原先只在
 * 开场白里见到过它，靠 carryPanels 抄回来——没有开场白（「不用开场白」进卡）或者
 * 开场白被删掉时，状态页就再也出不来。这里取那个标签本身，由调用方补到最后一条回复上。
 *
 * **必须是显示侧有规则把它换成 HTML 时才返回**：宝可梦那张卡有一条只把占位符
 * 洗成空串的提示词侧规则，照补的话正文里会冒出一行字面量 `<StatusPlaceHolderImpl/>`。
 */
export function mvuPlaceholder(rules: RegexRule[]): string | null {
  for (const rule of rules) {
    if (!rule.enabled || rule.target === 'prompt') continue
    const token = rule.pattern.trim()
    if (!/^<[\w.:-]+(?:\s[^<>]*)?\/>$/.test(token)) continue
    if (isHtmlReplacement(rule.replacement)) return token
  }
  return null
}

/**
 * 把占位标签补到最后一条 assistant 消息末尾（已经有了就不重复补）。
 * 返回新的数组：调用方后面还要拿它跑 carryPanels——carryPanels 见到「最新回复
 * 自己带着面板」就不补了，正好避免同一个状态页被画两遍。
 */
export function appendPanelPlaceholder<T extends DisplayMessage>(
  messages: T[],
  placeholder: string
): T[] {
  const index = messages.map((item) => item.role).lastIndexOf('assistant')
  if (index < 0) return messages
  const target = messages[index]!
  if (target.content.includes(placeholder)) return messages
  const next = [...messages]
  next[index] = { ...target, content: `${target.content}\n${placeholder}` }
  return next
}

function firstMatch(rule: RegexRule, text: string): string | null {
  const regex = compileRule(rule)
  if (!regex) return null
  regex.lastIndex = 0
  const match = regex.exec(text)
  return match ? match[0] : null
}

/**
 * 返回「消息 id → 需要补在正文后面的原块」。只补最后一条 assistant 消息，
 * 且只补开场白（第一条 assistant 消息）里已经出现过的面板。
 */
export function carryPanels(
  messages: DisplayMessage[],
  rules: RegexRule[]
): Map<string, string> {
  const extra = new Map<string, string>()
  const replies = messages.filter((item) => item.role === 'assistant')
  if (replies.length < 2) return extra
  const reference = replies[0]!.content
  const panels = rules.filter((rule) => isPanelRule(rule) && firstMatch(rule, reference) !== null)
  if (panels.length === 0) return extra

  const last = replies[replies.length - 1]!
  for (const rule of panels) {
    if (firstMatch(rule, last.content) !== null) continue
    for (let index = replies.length - 2; index >= 0; index--) {
      const block = firstMatch(rule, replies[index]!.content)
      if (!block) continue
      extra.set(last.id, `${extra.get(last.id) ?? ''}\n${block}`)
      break
    }
  }
  return extra
}
