// 聊天会话的纯逻辑（无 electron / fetch 依赖，可直接被 vitest 单测）：
// - 上下文窗口：保留最近 20 轮，超出按字符估算 token 优先裁最早，system 永远在最前；
// - 第四面墙彩蛋触发器：深夜 / 长时间未回复 / 关键词 / 长对话，随机命中且带 30 轮冷却。
// 规则来源：persona.md「实现说明」。
import { SYSTEM_PROMPT } from './persona'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 保留的对话轮数上限（一轮 = user + assistant 两条） */
export const MAX_TURNS = 20
/** 历史消息的估算 token 上限（不含 system），超出则从最早的开始裁 */
export const HISTORY_MAX_TOKENS = 4000
/** 彩蛋命中后的冷却轮数 */
export const META_COOLDOWN_TURNS = 30
/** 距离上一条用户消息超过该时长视为「很久没回复」 */
export const META_IDLE_MS = 30 * 60 * 1000
/** 落盘时最多保留的消息条数，避免历史文件无限增长 */
export const PERSIST_MAX_MESSAGES = 100

const SNAPSHOT_VERSION = 1

/** 可持久化的会话快照（ipc.ts 负责读写磁盘，本模块只管结构）。 */
export interface SessionSnapshot {
  version: number
  history: ChatMessage[]
  turnCount: number
  cooldown: number
  lastUserAt: number | null
}

/** 彩蛋触发时追加到 user 消息末尾的隐式指令（persona.md 指定原文） */
export const META_HINT = '[系统：她此刻突然安静下来，眼神变得认真。]'

/**
 * 粗略 token 估算：中文（含全角标点）约 1 字 1 token，其余字符约 4 字符 1 token。
 * 不能一律按 4 字符估——中文会被低估 4 倍，4000 token 的上下文预算就形同虚设。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    // 0x2E80 起为 CJK 部首、假名、中日韩汉字及全角符号
    if (text.charCodeAt(i) >= 0x2e80) cjk++
  }
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/**
 * 把当前时间拼到 system 末尾：模型要靠它把「五分钟后」「明天八点」换算成
 * `<remind at="…">` 标记，否则只能瞎猜。
 */
export function withClock(messages: ChatMessage[], now: Date): ChatMessage[] {
  if (messages.length === 0) return messages
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  return [
    { role: 'system', content: `${messages[0].content}\n\n【当前时间：${stamp}】` },
    ...messages.slice(1)
  ]
}

/** 好感等级越高，彩蛋概率略升（Lv4 为 0.12，其余 0.08）。 */
export function metaRate(affectionLevel: number): number {
  return affectionLevel >= 4 ? 0.12 : 0.08
}

export interface MetaContext {
  now?: Date
  affectionLevel?: number
  /** 注入随机源便于单测 */
  random?: () => number
}

/**
 * 用户主动问到「你是不是 AI」类问题：这类明确的提问不再掷骰子，
 * 只要不在冷却期就必定破墙——否则用户问了却什么都没发生，看起来像坏了。
 * `ai` 按整词匹配，避免 email / wait 这类英文单词误命中。
 */
export function metaKeywordHit(text: string): boolean {
  const lower = text.toLowerCase()
  if (lower.includes('模型') || lower.includes('deepseek')) return true
  return /(^|[^a-z])ai([^a-z]|$)/.test(lower)
}

/** 命中任一彩蛋时机（不含随机与冷却，便于单测）。 */
export function metaConditionHit(
  text: string,
  opts: { now: Date; lastUserAt: number | null; turnCount: number }
): boolean {
  const hour = opts.now.getHours()
  if (hour >= 0 && hour < 3) return true // 00:00–03:00
  if (opts.lastUserAt !== null && opts.now.getTime() - opts.lastUserAt > META_IDLE_MS) return true
  if (opts.turnCount > MAX_TURNS) return true
  return metaKeywordHit(text)
}

/** 历史裁剪：先按 40 条截断，再按估算 token 从尾部往前保留。 */
export function trimHistory(history: ChatMessage[]): ChatMessage[] {
  let start = Math.max(0, history.length - MAX_TURNS * 2)
  let tokens = 0
  let i = history.length - 1
  for (; i >= start; i--) {
    tokens += estimateTokens(history[i].content)
    if (tokens > HISTORY_MAX_TOKENS) break
  }
  if (i + 1 > start) start = i + 1
  return history.slice(start)
}

export class ChatSession {
  private history: ChatMessage[] = []
  private turnCount = 0
  private cooldown = 0
  private lastUserAt: number | null = null
  /** 注入到 system 末尾的动态上下文（长期记忆摘要等），空串表示不注入 */
  private systemContext = ''

  /** 设置动态 system 上下文；传空串清除。 */
  setSystemContext(text: string): void {
    this.systemContext = text.trim()
  }

  /** 上次用户发言的时间戳；从未说过话或刚重启且无记录时为 null。 */
  getLastUserAt(): number | null {
    return this.lastUserAt
  }

  /**
   * 主动开口：不 push user 消息，直接用现有上下文 + 临时指令组装请求体。
   * 复用 buildMessages()，长期记忆等 systemContext 仍会带上；
   * 主动消息没有「本轮用户输入」，所以不走 pushUser / 彩蛋判定。
   */
  buildProactiveMessages(instruction: string): ChatMessage[] {
    const messages = this.buildMessages()
    const extra = instruction.trim()
    if (extra) {
      messages[0] = { role: 'system', content: `${messages[0].content}\n\n${extra}` }
    }
    return messages
  }

  /** 导出可落盘的会话快照（历史只保留最近 PERSIST_MAX_MESSAGES 条）。 */
  snapshot(): SessionSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      history: this.history.slice(-PERSIST_MAX_MESSAGES).map((m) => ({ ...m })),
      turnCount: this.turnCount,
      cooldown: this.cooldown,
      lastUserAt: this.lastUserAt
    }
  }

  /** 从磁盘快照恢复；数据缺失/损坏时回退为空会话。 */
  restore(data: Partial<SessionSnapshot> | null | undefined): void {
    this.reset()
    if (!data || !Array.isArray(data.history)) return

    const history: ChatMessage[] = []
    for (const m of data.history) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
      if (typeof m.content !== 'string' || m.content.length === 0) continue
      history.push({ role: m.role, content: m.content })
    }
    this.history = history.slice(-PERSIST_MAX_MESSAGES)
    this.turnCount =
      typeof data.turnCount === 'number' && Number.isFinite(data.turnCount)
        ? Math.max(0, Math.floor(data.turnCount))
        : this.history.filter((m) => m.role === 'user').length
    this.cooldown =
      typeof data.cooldown === 'number' && Number.isFinite(data.cooldown)
        ? Math.max(0, Math.floor(data.cooldown))
        : 0
    this.lastUserAt =
      typeof data.lastUserAt === 'number' && Number.isFinite(data.lastUserAt) ? data.lastUserAt : null
  }

  /**
   * 记录用户消息并生成本轮请求体。
   * 彩蛋命中时会在 user 消息末尾追加隐式指令，并置 meta=true（调用方据此通知渲染层进 awake）。
   */
  pushUser(text: string, ctx: MetaContext = {}): { messages: ChatMessage[]; meta: boolean } {
    const now = ctx.now ?? new Date()
    const random = ctx.random ?? Math.random
    const hit = metaConditionHit(text, {
      now,
      lastUserAt: this.lastUserAt,
      turnCount: this.turnCount
    })
    // 关键词提问必定触发；深夜 / 久未回复 / 长对话这类环境时机仍按概率稀发
    const keyword = metaKeywordHit(text)
    const meta =
      this.cooldown === 0 && (keyword || (hit && random() < metaRate(ctx.affectionLevel ?? 1)))

    if (meta) this.cooldown = META_COOLDOWN_TURNS
    this.turnCount++
    this.lastUserAt = now.getTime()
    this.history.push({ role: 'user', content: meta ? `${text}\n${META_HINT}` : text })

    return { messages: this.buildMessages(), meta }
  }

  /**
   * 记录助手回复（被中断的回复也调用，保证上下文连贯）。
   * countCooldown=false 用于主动消息：主动开口不是用户轮，不该推进彩蛋冷却。
   */
  pushAssistant(content: string, countCooldown = true): void {
    if (countCooldown && this.cooldown > 0) this.cooldown--
    if (!content.trim()) return
    this.history.push({ role: 'assistant', content })
  }

  /** 本轮没有任何回复可记录（请求失败）时撤回那条 user 消息，避免历史里留下孤立 user。 */
  dropLastUser(): void {
    if (this.history[this.history.length - 1]?.role !== 'user') return
    this.history.pop()
    if (this.turnCount > 0) this.turnCount--
  }

  reset(): void {
    this.history = []
    this.turnCount = 0
    this.cooldown = 0
    this.lastUserAt = null
    this.systemContext = ''
  }

  private buildMessages(): ChatMessage[] {
    const system = this.systemContext
      ? `${SYSTEM_PROMPT}\n\n${this.systemContext}`
      : SYSTEM_PROMPT
    return [{ role: 'system', content: system }, ...trimHistory(this.history)]
  }
}
