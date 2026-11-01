import { describe, expect, it } from 'vitest'
import {
  ChatSession,
  HISTORY_MAX_TOKENS,
  MAX_TURNS,
  META_COOLDOWN_TURNS,
  PERSIST_MAX_MESSAGES,
  estimateTokens,
  metaConditionHit,
  metaKeywordHit,
  metaRate,
  trimHistory,
  withClock,
  type ChatMessage
} from './session'
import { SYSTEM_PROMPT } from './persona'

const at = (hour: number, minute = 0): Date => new Date(2026, 9, 23, hour, minute, 0)

describe('estimateTokens / metaRate', () => {
  it('英文按 4 字符 ≈ 1 token 估算', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('中文按 1 字 1 token 估算，不低估', () => {
    expect(estimateTokens('你好')).toBe(2)
    expect(estimateTokens('用户喜欢喝美式咖啡')).toBe(9)
    // 全角标点同样按 1 token
    expect(estimateTokens('你好，世界')).toBe(5)
  })

  it('中英混排分别计数', () => {
    // 4 个汉字 + 4 个英文字母 = 4 + 1 = 5
    expect(estimateTokens('你好世界abcd')).toBe(5)
  })

  it('Lv4 彩蛋概率略高', () => {
    expect(metaRate(1)).toBe(0.08)
    expect(metaRate(4)).toBe(0.12)
  })
})

describe('metaConditionHit', () => {
  const base = { now: at(12), lastUserAt: null, turnCount: 1 }

  it('深夜 00:00–03:00 命中', () => {
    expect(metaConditionHit('你好', { ...base, now: at(1) })).toBe(true)
    expect(metaConditionHit('你好', { ...base, now: at(3) })).toBe(false)
  })

  it('超过 30 分钟未回复命中', () => {
    const lastUserAt = at(11).getTime()
    expect(metaConditionHit('在吗', { ...base, now: new Date(lastUserAt + 31 * 60 * 1000), lastUserAt })).toBe(true)
    expect(metaConditionHit('在吗', { ...base, now: new Date(lastUserAt + 29 * 60 * 1000), lastUserAt })).toBe(false)
  })

  it('关键词命中（不区分大小写）', () => {
    expect(metaConditionHit('你是AI吗', base)).toBe(true)
    expect(metaConditionHit('你是什么模型', base)).toBe(true)
    expect(metaConditionHit('DeepSeek 是什么', base)).toBe(true)
    expect(metaConditionHit('今天天气不错', base)).toBe(false)
  })

  it('超过 20 轮命中', () => {
    expect(metaConditionHit('你好', { ...base, turnCount: MAX_TURNS + 1 })).toBe(true)
    expect(metaConditionHit('你好', { ...base, turnCount: MAX_TURNS })).toBe(false)
  })
})

describe('metaKeywordHit', () => {
  it('「AI」按整词匹配，英文单词里的 ai 不算', () => {
    expect(metaKeywordHit('你是AI吗？')).toBe(true)
    expect(metaKeywordHit('ai')).toBe(true)
    expect(metaKeywordHit('你是 ai 吗')).toBe(true)
    expect(metaKeywordHit('email 收到了吗')).toBe(false)
    expect(metaKeywordHit('wait a moment')).toBe(false)
  })

  it('模型 / DeepSeek 命中', () => {
    expect(metaKeywordHit('你用的什么模型')).toBe(true)
    expect(metaKeywordHit('deepseek 好用吗')).toBe(true)
    expect(metaKeywordHit('今天好累')).toBe(false)
  })
})

describe('trimHistory', () => {
  const message = (i: number, content = 'x'): ChatMessage => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content
  })

  it('超过 40 条时只保留最近 20 轮', () => {
    const history = Array.from({ length: 60 }, (_, i) => message(i))
    const trimmed = trimHistory(history)
    expect(trimmed).toHaveLength(MAX_TURNS * 2)
    expect(trimmed[trimmed.length - 1]).toBe(history[59])
  })

  it('按估算 token 上限裁掉最早的消息', () => {
    const long = 'x'.repeat(400) // ≈100 token/条
    const history = Array.from({ length: 60 }, (_, i) => message(i, long))
    const trimmed = trimHistory(history)
    const tokens = trimmed.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    expect(tokens).toBeLessThanOrEqual(HISTORY_MAX_TOKENS)
    expect(trimmed[trimmed.length - 1]).toBe(history[59])
  })

  it('不超限时原样返回', () => {
    const history = [message(0), message(1)]
    expect(trimHistory(history)).toEqual(history)
  })

  it('常规中文对话（每轮约 70 字）不受 token 上限影响，仍保留满 20 轮', () => {
    const history: ChatMessage[] = []
    for (let i = 0; i < 30; i++) {
      history.push({ role: 'user', content: '这是一条用户输入的短消息' })
      history.push({ role: 'assistant', content: '这是一条她的回复，大概有这么长，符合一到三句话的设定。'.repeat(2) })
    }
    expect(trimHistory(history)).toHaveLength(MAX_TURNS * 2)
  })

  it('预算内能装下的消息全部保留（不额外多裁一条）', () => {
    const long = 'x'.repeat(1200) // 300 token/条，4000 预算刚好装得下 13 条
    const history = Array.from({ length: 20 }, (_, i) => message(i, long))
    const trimmed = trimHistory(history)
    expect(trimmed).toHaveLength(13)
    expect(trimmed[0]).toBe(history[7])
  })
})

describe('ChatSession', () => {
  it('system prompt 永远在最前，随后是历史', () => {
    const session = new ChatSession()
    const { messages, meta } = session.pushUser('你好', { now: at(12), random: () => 0.99 })
    expect(meta).toBe(false)
    expect(messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT })
    expect(messages[1]).toEqual({ role: 'user', content: '你好' })
  })

  it('命中彩蛋时在 user 消息末尾追加隐式指令', () => {
    const session = new ChatSession()
    const { messages, meta } = session.pushUser('你是AI吗', { now: at(12), random: () => 0 })
    expect(meta).toBe(true)
    const last = messages[messages.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toContain('你是AI吗')
    expect(last.content).toContain('[系统：她此刻突然安静下来，眼神变得认真。]')
  })

  it('关键词提问必定触发，不受随机值影响', () => {
    const session = new ChatSession()
    const { meta } = session.pushUser('你是AI吗', { now: at(12), random: () => 0.99 })
    expect(meta).toBe(true)
  })

  it('环境时机（深夜等）仍按概率稀发', () => {
    const rare = new ChatSession()
    expect(rare.pushUser('你好', { now: at(1), random: () => 0.99 }).meta).toBe(false)

    const hit = new ChatSession()
    expect(hit.pushUser('你好', { now: at(1), random: () => 0 }).meta).toBe(true)
  })

  it('触发后冷却 30 轮，冷却结束可再次触发', () => {
    const session = new ChatSession()
    const first = session.pushUser('你是AI吗', { now: at(12), random: () => 0 })
    expect(first.meta).toBe(true)

    for (let i = 0; i < META_COOLDOWN_TURNS; i++) session.pushAssistant(`回复 ${i}`)

    const second = session.pushUser('你是AI吗', { now: at(12), random: () => 0 })
    expect(second.meta).toBe(true)
  })

  it('冷却中即使条件命中也不触发', () => {
    const session = new ChatSession()
    session.pushUser('你是AI吗', { now: at(12), random: () => 0 })
    const again = session.pushUser('你是AI吗', { now: at(12), random: () => 0 })
    expect(again.meta).toBe(false)
  })

  it('助手回复被记录进上下文', () => {
    const session = new ChatSession()
    session.pushUser('你好', { now: at(12), random: () => 0.99 })
    session.pushAssistant('哥哥好呀')
    const { messages } = session.pushUser('再说一次', { now: at(12), random: () => 0.99 })
    expect(messages.some((m) => m.role === 'assistant' && m.content === '哥哥好呀')).toBe(true)
  })

  it('请求失败时 dropLastUser 撤回那条 user，历史里不留孤立 user', () => {
    const session = new ChatSession()
    session.pushUser('你好', { now: at(12), random: () => 0.99 })
    session.dropLastUser()
    const { messages } = session.pushUser('再说一次', { now: at(12), random: () => 0.99 })
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(messages[messages.length - 1].content).toBe('再说一次')
  })

  it('reset 清空会话（system 仍在）', () => {
    const session = new ChatSession()
    session.pushUser('你好', { now: at(12), random: () => 0.99 })
    session.pushAssistant('好')
    session.reset()
    const { messages } = session.pushUser('新话题', { now: at(12), random: () => 0.99 })
    expect(messages).toHaveLength(2)
  })
})

describe('ChatSession 持久化', () => {
  it('snapshot / restore 往返保留历史', () => {
    const source = new ChatSession()
    source.pushUser('你好', { now: at(12), random: () => 0.99 })
    source.pushAssistant('哥哥好呀')

    const restored = new ChatSession()
    restored.restore(source.snapshot())
    const { messages } = restored.pushUser('还记得我吗', { now: at(12), random: () => 0.99 })

    expect(messages).toHaveLength(4) // system + user + assistant + 新 user
    expect(messages[1]).toEqual({ role: 'user', content: '你好' })
    expect(messages[2]).toEqual({ role: 'assistant', content: '哥哥好呀' })
  })

  it('快照只保留最近 PERSIST_MAX_MESSAGES 条消息', () => {
    const session = new ChatSession()
    for (let i = 0; i < 60; i++) {
      session.pushUser(`u${i}`, { now: at(12), random: () => 0.99 })
      session.pushAssistant(`a${i}`)
    }
    expect(session.snapshot().history).toHaveLength(PERSIST_MAX_MESSAGES)
  })

  it('restore 忽略脏数据并回退为空会话', () => {
    const session = new ChatSession()
    session.restore({ history: [{ role: 'system', content: 'x' }, null] as unknown as ChatMessage[] })
    const { messages } = session.pushUser('在吗', { now: at(12), random: () => 0.99 })
    expect(messages).toHaveLength(2)
  })

  it('buildProactiveMessages 不新增 user 消息，只把指令拼到 system 末尾', () => {
    const session = new ChatSession()
    session.pushUser('你好', { now: at(12), random: () => 0.99 })
    session.pushAssistant('哥哥好呀')
    const messages = session.buildProactiveMessages('【系统：主动开口】')
    expect(messages[0].content).toBe(`${SYSTEM_PROMPT}\n\n【系统：主动开口】`)
    // 原有两条历史原样保留，没有新 push 的 user
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '哥哥好呀' }
    ])
    expect(session.snapshot().history).toHaveLength(2)
  })

  it('buildProactiveMessages 保留 systemContext（长期记忆）', () => {
    const session = new ChatSession()
    session.setSystemContext('【记忆】用户喜欢猫')
    const messages = session.buildProactiveMessages('【系统：主动开口】')
    expect(messages[0].content).toBe(`${SYSTEM_PROMPT}\n\n【记忆】用户喜欢猫\n\n【系统：主动开口】`)
  })

  it('getLastUserAt 在用户发言后可用，restore 后仍在', () => {
    const session = new ChatSession()
    expect(session.getLastUserAt()).toBeNull()
    session.pushUser('在吗', { now: at(12), random: () => 0.99 })
    expect(session.getLastUserAt()).toBe(at(12).getTime())

    const restored = new ChatSession()
    restored.restore(session.snapshot())
    expect(restored.getLastUserAt()).toBe(at(12).getTime())
  })

  it('setSystemContext 追加到 system 末尾，清空后恢复原文', () => {
    const session = new ChatSession()
    session.setSystemContext('【记忆】用户喜欢猫')
    const first = session.pushUser('你好', { now: at(12), random: () => 0.99 })
    expect(first.messages[0].content).toBe(`${SYSTEM_PROMPT}\n\n【记忆】用户喜欢猫`)

    session.setSystemContext('')
    const second = session.pushUser('再说一次', { now: at(12), random: () => 0.99 })
    expect(second.messages[0].content).toBe(SYSTEM_PROMPT)
  })
})

describe('withClock', () => {
  it('时间拼到 system 末尾，历史原样不动', () => {
    const messages = [
      { role: 'system' as const, content: 'SYSTEM' },
      { role: 'user' as const, content: '你好' }
    ]
    const stamped = withClock(messages, new Date(2026, 9, 23, 9, 5))
    expect(stamped[0]).toEqual({ role: 'system', content: 'SYSTEM\n\n【当前时间：2026-10-23 09:05】' })
    expect(stamped[1]).toBe(messages[1])
    // 不改原数组：同一份消息可能被再次使用
    expect(messages[0].content).toBe('SYSTEM')
  })

  it('空消息数组原样返回', () => {
    expect(withClock([], new Date())).toEqual([])
  })
})
