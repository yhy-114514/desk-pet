// 聊天服务的请求装配：只验「发给模型的那一段 messages」对不对，不真发请求。
// electron / deepseek / config 全换成假实现，库照常建在临时目录。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir = ''
const handlers = new Map<string, (...args: never[]) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  protocol: { handle: (): void => {} },
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown): void => {
      handlers.set(channel, fn)
    },
    on: (channel: string, fn: (...args: never[]) => unknown): void => {
      handlers.set(channel, fn)
    }
  }
}))

/** 每一轮请求装配出来的 messages，按顺序攒着给断言用 */
const prompts: Array<Array<{ role: string; content: string }>> = []
/** 每轮请求实际用的模型（跟着会话级切换走） */
const models: string[] = []

/** 每轮请求实际用的回复上限（跟着会话级设置走） */
const maxTokensSeen: number[] = []

/** 非流式调用的假实现：两段式补抽要能返回补丁，记忆抽取给「什么都没抽到」 */
const ds = vi.hoisted(() => ({
  /** 主回复的正文（默认不带更新块；个别用例改成带 `<update>`） */
  reply: '好。',
  /** 变量补抽时返回的原文（JSON Patch 数组） */
  patch: '[]',
  /** 让下一条流推一句正文后挂住，直到被 abort（模拟「聊到一半又发一条」） */
  hang: false,
  /** 补抽请求的 opts（用来断言温度、模型、提示词内容） */
  extracts: [] as Array<{
    messages: Array<{ role: string; content: string }>
    model?: string
    temperature?: number
    maxTokens?: number
    jsonMode?: boolean
  }>
}))

vi.mock('../chat/deepseek', () => ({
  streamChat: async (opts: {
    messages: Array<{ role: string; content: string }>
    model?: string
    maxTokens?: number
    onToken: (delta: string) => void
    signal?: AbortSignal
  }): Promise<void> => {
    prompts.push(opts.messages)
    models.push(String(opts.model))
    maxTokensSeen.push(Number(opts.maxTokens))
    if (ds.hang) {
      opts.onToken(ds.reply)
      await new Promise<void>((resolve) => {
        if (!opts.signal || opts.signal.aborted) return resolve()
        opts.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      ds.hang = false
      throw new DOMException('aborted', 'AbortError')
    }
    opts.onToken(ds.reply)
  },
  completeChat: async (opts: {
    messages: Array<{ role: string; content: string }>
    model?: string
    temperature?: number
    maxTokens?: number
  }): Promise<string> => {
    const system = opts.messages.find((item) => item.role === 'system')?.content ?? ''
    // 变量补抽的提示词里带 RFC 6902 字样；其余（记忆抽取）当没抽到
    if (system.includes('RFC 6902')) {
      ds.extracts.push(opts)
      return ds.patch
    }
    return '[]'
  }
}))
vi.mock('../chat/config', () => ({
  loadConfig: (): { apiKey: string; qwenKey: string; model: string } => ({
    apiKey: 'test-key',
    qwenKey: '',
    model: 'test-model'
  })
}))

/** 交给合成器的每一句（合成队列切出来的句子），用来断言「念了什么」 */
const spoken = vi.hoisted(() => [] as string[])
vi.mock('../chat/tts', () => ({
  synthesizeSpeech: async (text: string): Promise<{ audio: Buffer; mime: string }> => {
    spoken.push(text)
    return { audio: Buffer.alloc(0), mime: 'audio/mpeg' }
  }
}))

const { closeTavernDb } = await import('./db')
const { saveAppearance } = await import('./appearance')
const { saveCard } = await import('./cards')
const { registerTavernChatIpc } = await import('./chatService')
const { activeLeafId, appendMessage, getChatView } = await import('./chatStore')

registerTavernChatIpc()

const base = {
  name: '',
  description: '',
  personality: '',
  scenario: '',
  firstMes: '',
  alternateGreetings: [],
  mesExample: '',
  systemPrompt: '',
  postHistoryInstructions: '',
  creator: '',
  creatorNotes: '',
  tags: [],
  avatarPath: null
}

interface Sent {
  channel: string
  payload: unknown
}

function fakeTarget(sent: Sent[]): never {
  return {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown): void => {
      sent.push({ channel, payload })
    }
  } as never
}

function call<T>(channel: string, ...args: unknown[]): T {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`没注册 ${channel}`)
  return fn(...(args as never[])) as T
}

/** 等假流跑完（startTurn 是 fire-and-forget 的异步） */
async function until(count: number): Promise<void> {
  for (let i = 0; i < 100 && prompts.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(prompts.length).toBe(count)
}

/** 等到这一轮收尾：两段式补抽发生在 done 之前，等 done 才看得到它的结果 */
async function untilSettled(sent: Sent[]): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (sent.some((item) => item.channel === 'tavern:done' || item.channel === 'tavern:error')) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('这一轮没收尾')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tavern-chat-'))
  prompts.length = 0
  models.length = 0
  maxTokensSeen.length = 0
  spoken.length = 0
  ds.reply = '好。'
  ds.hang = false
  ds.patch = '[]'
  ds.extracts.length = 0
})

afterEach(() => {
  closeTavernDb()
  rmSync(dir, { recursive: true, force: true })
})

function openChatId(name: string): string {
  const id = saveCard({ ...base, name, description: '{{char}}是师父。' })
  const view = call<{ chat: { id: string } } | null>('tavern:chat-open', {}, id)
  return view!.chat.id
}

describe('请求装配', () => {
  it('本轮用户消息只出现一次（历史到父节点为止）', async () => {
    const chatId = openChatId('苏月珑')
    const sent: Sent[] = []
    call('tavern:chat-send', { sender: fakeTarget(sent) }, { chatId, text: '师父在吗', turn: 1 })
    await until(1)

    const messages = prompts[0]!
    const echoed = messages.filter((item) => item.content.includes('师父在吗'))
    expect(echoed).toEqual([{ role: 'user', content: '师父在吗' }])
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '师父在吗' })
  })

  it('第二轮带上上一轮问答，且各自只出现一次', async () => {
    const chatId = openChatId('苏月珑')
    call('tavern:chat-send', { sender: fakeTarget([]) }, { chatId, text: '师父在吗', turn: 1 })
    await until(1)
    call('tavern:chat-send', { sender: fakeTarget([]) }, { chatId, text: '今天练什么', turn: 2 })
    await until(2)

    const messages = prompts[1]!
    expect(messages.map((item) => item.content).slice(-3)).toEqual([
      '师父在吗',
      '好。',
      '今天练什么'
    ])
  })

  // 提示词侧正则的 minDepth / maxDepth 按「距最新消息几层」判，而本轮用户输入才是第 0 层。
  // 历史最后一条若也算 0 层，`maxDepth: 0`（只洗当前消息）的规则会连带改掉上一轮回复
  it('提示词侧正则的深度：本轮输入是 0 层，最后一条历史是 1 层', async () => {
    const id = saveCard({
      ...base,
      name: '苏月珑',
      description: '{{char}}是师父。',
      rawData: {
        name: '苏月珑',
        description: '{{char}}是师父。',
        extensions: {
          regex_scripts: [
            {
              scriptName: '只洗当前消息',
              findRegex: '好',
              replaceString: '妙',
              promptOnly: true,
              maxDepth: 0
            }
          ]
        }
      }
    })
    const chatId = call<{ chat: { id: string } }>('tavern:chat-open', {}, id)!.chat.id
    call('tavern:chat-send', { sender: fakeTarget([]) }, { chatId, text: '好', turn: 1 })
    await until(1)
    call('tavern:chat-send', { sender: fakeTarget([]) }, { chatId, text: '好', turn: 2 })
    await until(2)

    const messages = prompts[1]!
    // 上一轮那句用户发言（2 层）和 AI 回复（1 层）都原样不动，只有本轮输入被换掉
    expect(messages.map((item) => item.content).slice(-3)).toEqual(['好', '好。', '妙'])
  })

  it('重生成不追加空的 user 消息，历史仍以用户那句话收尾', async () => {
    const chatId = openChatId('苏月珑')
    call('tavern:chat-send', { sender: fakeTarget([]) }, { chatId, text: '师父在吗', turn: 1 })
    await until(1)

    const view = call<{ messages: Array<{ id: string; role: string }> }>('tavern:chat-view', {}, chatId)
    const reply = view.messages[view.messages.length - 1]!
    expect(reply.role).toBe('assistant')
    call('tavern:chat-regenerate', { sender: fakeTarget([]) }, { chatId, messageId: reply.id, turn: 2 })
    await until(2)

    const messages = prompts[1]!
    expect(messages.some((item) => item.content.trim() === '')).toBe(false)
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '师父在吗' })
  })

  it('重生成落成同一父节点下的新分支，旧回复还在树里', async () => {
    const chatId = openChatId('苏月珑')
    call('tavern:chat-send', { sender: fakeTarget([]) }, { chatId, text: '师父在吗', turn: 1 })
    await until(1)
    const first = getChatView(chatId)!.messages
    const reply = first[first.length - 1]!

    call('tavern:chat-regenerate', { sender: fakeTarget([]) }, { chatId, messageId: reply.id, turn: 2 })
    await until(2)

    const after = getChatView(chatId)!.messages
    const branch = after[after.length - 1]!
    expect(branch.branchCount).toBe(2)
    expect(branch.branchIds).toContain(reply.id)
  })
})

describe('会话级模型', () => {
  it('没选过就跟随全局配置，可选列表是两档', () => {
    const chatId = openChatId('苏月珑')
    const info = call<{ model: string; options: string[] }>('tavern:chat-model-get', {}, chatId)
    expect(info.model).toBe('test-model')
    expect(info.options).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
  })

  it('切换后这一场的请求换模型，另一场还是全局那个', async () => {
    const a = openChatId('苏月珑')
    call('tavern:chat-model-set', {}, { chatId: a, model: 'deepseek-v4-pro' })
    call('tavern:chat-send', { sender: fakeTarget([]) }, { chatId: a, text: '在吗', turn: 1 })
    await until(1)
    expect(models[0]).toBe('deepseek-v4-pro')

    // 换一场：不受上一场的选择影响
    const b = openChatId('赵泠')
    call('tavern:chat-model-get', {}, b)
    call('tavern:chat-send', { sender: fakeTarget([]) }, { chatId: b, text: '在吗', turn: 1 })
    await until(2)
    expect(models[1]).toBe('test-model')
  })

  it('存了不认识的模型名就当没选过，回退全局', () => {
    const chatId = openChatId('苏月珑')
    expect(call<string>('tavern:chat-model-set', {}, { chatId, model: 'gpt-9' })).toBe('test-model')
  })
})

describe('变量系统（硬提醒与两段式补抽）', () => {
  /** 带 `[initvar]` 的卡：变量系统是开着的 */
  function mvuCard(name: string): string {
    return saveCard({
      ...base,
      name,
      description: '{{char}}是师父。',
      rawData: {
        name,
        description: '{{char}}是师父。',
        character_book: {
          entries: [
            { comment: '[initvar]初始变量', content: '世界:\n  当前时间: 卯时', enabled: false },
            {
              comment: '[[mvu_update]变量更新规则]',
              content: '时间推进规则：每过一个时辰推进一格（卯→辰→巳…）。',
              enabled: true
            },
            { comment: '设定', content: '月珑峰', enabled: true, keys: ['月珑峰'] }
          ]
        }
      }
    })
  }

  it('卡用了 MVU：回复要求里带一句 update 块硬提醒', async () => {
    const id = mvuCard('苏月珑')
    const chatId = call<{ chat: { id: string } }>('tavern:chat-open', {}, id)!.chat.id
    const sent: Sent[] = []
    call('tavern:chat-send', { sender: fakeTarget(sent) }, { chatId, text: '师父在吗', turn: 1 })
    await until(1)

    const text = prompts[0]!.map((item) => item.content).join('\n')
    expect(text).toContain('json_patch')
  })

  it('普通卡不塞 update 字样', async () => {
    const chatId = openChatId('阿蕾')
    call('tavern:chat-send', { sender: fakeTarget([]) }, { chatId, text: '你好', turn: 1 })
    await until(1)

    const text = prompts[0]!.map((item) => item.content).join('\n')
    expect(text).not.toContain('json_patch')
  })

  it('主回复没吐更新块时，收尾前补抽一次并落库', async () => {
    ds.patch = '[{"op":"replace","path":"/世界/当前时间","value":"黄昏"}]'
    const id = mvuCard('苏月珑')
    const chatId = call<{ chat: { id: string } }>('tavern:chat-open', {}, id)!.chat.id
    const sent: Sent[] = []
    call('tavern:chat-send', { sender: fakeTarget(sent) }, { chatId, text: '过了一个时辰', turn: 1 })
    await untilSettled(sent)

    // 补抽只做一次，且低温度（主链路 1.0 的 flash 抽不准）
    expect(ds.extracts).toHaveLength(1)
    expect(ds.extracts[0]!.temperature).toBeLessThan(0.5)
    // 带上了当前变量，模型才知道有哪些路径可改
    const userText = ds.extracts[0]!.messages.find((item) => item.role === 'user')?.content ?? ''
    expect(userText).toContain('当前时间')
    // 也带上了玩家这一轮说了什么：没有输入的那一轮（重生成）才为空
    expect(userText).toContain('过了一个时辰')
    // 卡里的 `[mvu_update]` 规则必须一起喂进去：只给变量和剧情的话，
    // 模型不知道这张卡的时间怎么推进，抽回来的永远是空数组（状态栏停在卯时）
    const system = ds.extracts[0]!.messages.find((item) => item.role === 'system')?.content ?? ''
    expect(system).toContain('每过一个时辰推进一格')
    // JSON 模式开着：让接口保证输出是合法 JSON
    expect(ds.extracts[0]!.jsonMode).toBe(true)
    // 预算要够：一轮常改 5–7 条，每条几十字中文 + reasoning 的思考 token 也算在这里，
    // 800 会把输出砍在半截字符串上（JSON 不合法 → 变量静默不动）
    expect(ds.extracts[0]!.maxTokens).toBeGreaterThanOrEqual(2000)
    // 补到的变量落库并推给界面
    const got = sent.find((item) => item.channel === 'tavern:variables')
    expect(got).toBeTruthy()
    const state = call<{ state: Record<string, unknown> }>('tavern:variables-get', {}, chatId).state
    expect(JSON.stringify(state)).toContain('黄昏')
  })

  it('补抽走 JSON 模式的对象外壳 {"operations":[…]} 也能解出 ops', async () => {
    // JSON 模式要求顶层是对象，模型按指令输出 {"operations":[…]}
    ds.patch = '{"operations":[{"op":"replace","path":"/世界/当前时间","value":"戌时"}]}'
    const id = mvuCard('苏月珑')
    const chatId = call<{ chat: { id: string } }>('tavern:chat-open', {}, id)!.chat.id
    const sent: Sent[] = []
    call('tavern:chat-send', { sender: fakeTarget(sent) }, { chatId, text: '练到戌时', turn: 1 })
    await untilSettled(sent)

    const state = call<{ state: Record<string, unknown> }>('tavern:variables-get', {}, chatId).state
    expect(JSON.stringify(state)).toContain('戌时')
  })

  it('补抽被 max_tokens 截断时，前面写完整的 op 仍然落库', async () => {
    // 真机形态：后面那条被砍在半截字符串上，整个 JSON 不合法。
    // 不能因为尾巴坏了就把前半段也丢掉——那正是「变量静默不动」的成因
    ds.patch =
      '{"operations":[{"op":"replace","path":"/世界/当前时间","value":"子时"},' +
      '{"op":"replace","path":"/世界/当前地点","value":"演武场"},{"op":"replace","path":"/当前角色/苏月珑/当前想法","value":"修炼了一整'
    const id = mvuCard('苏月珑')
    const chatId = call<{ chat: { id: string } }>('tavern:chat-open', {}, id)!.chat.id
    const sent: Sent[] = []
    call('tavern:chat-send', { sender: fakeTarget(sent) }, { chatId, text: '继续修炼', turn: 1 })
    await untilSettled(sent)

    const state = call<{ state: Record<string, unknown> }>('tavern:variables-get', {}, chatId).state
    expect(JSON.stringify(state)).toContain('子时')
    expect(JSON.stringify(state)).toContain('演武场')
  })

  it('主回复自带更新块就不再补抽（省一次请求）', async () => {
    ds.reply =
      '好。<update><json_patch>[{"op":"replace","path":"/世界/当前时间","value":"入夜"}]</json_patch></update>'
    const id = mvuCard('苏月珑')
    const chatId = call<{ chat: { id: string } }>('tavern:chat-open', {}, id)!.chat.id
    const sent: Sent[] = []
    call('tavern:chat-send', { sender: fakeTarget(sent) }, { chatId, text: '继续', turn: 1 })
    await untilSettled(sent)

    expect(ds.extracts).toHaveLength(0)
    const state = call<{ state: Record<string, unknown> }>('tavern:variables-get', {}, chatId).state
    expect(JSON.stringify(state)).toContain('入夜')
  })

  it('普通卡不补抽（没有变量系统可更新）', async () => {
    const chatId = openChatId('阿蕾')
    const sent: Sent[] = []
    call('tavern:chat-send', { sender: fakeTarget(sent) }, { chatId, text: '你好', turn: 1 })
    await untilSettled(sent)
    expect(ds.extracts).toHaveLength(0)
  })
})

describe('状态栏面板', () => {
  /** MVU 卡：占位符由显示侧正则换成整页状态页（萝莉师父那张卡的结构） */
  function panelCard(name: string): string {
    const firstMes = '开场白\n<StatusPlaceHolderImpl/>'
    return saveCard({
      ...base,
      name,
      firstMes,
      rawData: {
        name,
        first_mes: firstMes,
        description: '{{char}}是师父。',
        extensions: {
          regex_scripts: [
            {
              scriptName: '状态栏',
              findRegex: '<StatusPlaceHolderImpl/>',
              replaceString: '```html\n<div>状态页</div>\n```',
              markdownOnly: true
            }
          ]
        }
      }
    })
  }

  it('聊完一轮后占位符补到最后一条回复上，状态页不会消失', async () => {
    const id = panelCard('苏月珑')
    const chatId = call<{ chat: { id: string } }>('tavern:chat-open', {}, id)!.chat.id
    const sent: Sent[] = []
    call('tavern:chat-send', { sender: fakeTarget(sent) }, { chatId, text: '在吗', turn: 1 })
    await untilSettled(sent)

    const view = call<{ messages: Array<{ role: string; content: string }> }>(
      'tavern:chat-view',
      {},
      chatId
    )
    const last = view.messages[view.messages.length - 1]!
    expect(last.role).toBe('assistant')
    // 显示侧已经把占位符换成了页面
    expect(last.content).toContain('状态页')
    expect(last.content).not.toContain('<StatusPlaceHolderImpl/>')
  })
})

describe('会话级回复上限', () => {
  it('没选过用全局默认，选了之后这一轮就用新上限', async () => {
    const chatId = openChatId('苏月珑')
    const info = call<{ value: number; options: number[] }>('tavern:chat-max-tokens-get', {}, chatId)
    expect(info.options).toEqual([1200, 3000, 6000, 8192])
    expect(info.value).toBe(1200)

    call('tavern:chat-max-tokens-set', {}, { chatId, value: 6000 })
    call('tavern:chat-send', { sender: fakeTarget([]) }, { chatId, text: '在吗', turn: 1 })
    await until(1)
    expect(maxTokensSeen[0]).toBe(6000)
  })
})

describe('朗读', () => {
  it('只念正文：```html 状态栏和裸 HTML 页面都不念', async () => {
    saveAppearance({ ttsEnabled: true })
    const chatId = openChatId('苏月珑')
    ds.reply =
      '师父在。\n```html\n<div style="color:red">状态栏甲</div>\n```\n' +
      '<!DOCTYPE html>\n<html><body><div style="x">状态栏乙</div></body></html>\n早点睡吧。'
    const sent: Sent[] = []
    call('tavern:chat-send', { sender: fakeTarget(sent) }, { chatId, text: '师父在吗', turn: 1 })
    await untilSettled(sent)
    // 合成队列是异步的，等它把攒下的句子都送进假合成器
    for (let i = 0; i < 100 && spoken.join('').indexOf('早点睡吧') < 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const text = spoken.join('')
    expect(text).toContain('师父在')
    expect(text).toContain('早点睡吧')
    expect(text).not.toContain('状态栏')
    expect(text).not.toContain('div')
  })
})

describe('崩溃恢复：重发悬空的用户消息', () => {
  it('不重复追加用户消息，回复挂在原来那条用户消息下面', async () => {
    const chatId = openChatId('苏月珑')
    // 模拟崩溃：用户消息已经落库，回复一个字都没来
    const userId = appendMessage(chatId, activeLeafId(chatId), 'user', '师父在吗')
    expect(getChatView(chatId)!.messages.at(-1)!.resendable).toBe(true)

    const sent: Sent[] = []
    call('tavern:chat-resend', { sender: fakeTarget(sent) }, { chatId, messageId: userId, turn: 1 })
    await untilSettled(sent)

    const messages = prompts[0]!
    expect(messages.filter((item) => item.content.includes('师父在吗'))).toEqual([
      { role: 'user', content: '师父在吗' }
    ])
    const view = getChatView(chatId)!
    const last = view.messages.at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.parentId).toBe(userId)
    expect(last.resendable).toBe(false)
  })
})

describe('群聊打断', () => {
  it('流到一半又发一条：半句落成旧分支，新用户消息挂在它后面', async () => {
    const a = saveCard({ ...base, name: '阿蕾' })
    const b = saveCard({ ...base, name: '小满' })
    const group = call<{ chat: { id: string } }>(
      'tavern:group-create',
      {},
      { memberIds: [a, b], name: '海堤夜话' }
    )
    const chatId = group.chat.id

    const sent: Sent[] = []
    ds.hang = true
    call('tavern:chat-send', { sender: fakeTarget(sent) }, { chatId, text: '@阿蕾 你先说', turn: 1 })
    await until(1)

    // 这一轮一个字都不出：叶子只能靠 interrupt() 同步落库的那半句来定。
    // 半句晚一步（等 abort 的 rejection）落库就会把叶子顶回旧分支，新消息从界面消失
    ds.reply = ''
    call('tavern:chat-send', { sender: fakeTarget(sent) }, { chatId, text: '@小满 你说', turn: 2 })

    let view = getChatView(chatId)
    for (let i = 0; i < 200 && view!.messages.length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      view = getChatView(chatId)
    }
    expect(view!.messages.map((item) => item.content)).toEqual([
      '@阿蕾 你先说',
      '阿蕾：好。',
      '@小满 你说'
    ])
    // 半句要带「被打断」标记，界面才不会读成莫名其妙断在一半
    expect(view!.messages.map((item) => item.interrupted)).toEqual([false, true, false])
  })
})
