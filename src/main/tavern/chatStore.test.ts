// 消息树：分支、切分支、编辑分叉、软删、到某节点为止的历史。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir = ''
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  protocol: { handle: (): void => {} }
}))

const { closeTavernDb } = await import('./db')
const { saveCard } = await import('./cards')
const {
  activePath,
  activeLeafId,
  appendMessage,
  chatMaxTokens,
  chatModel,
  createChat,
  createGroupChat,
  groupMemberIds,
  listGroupChats,
  deleteMessage,
  editMessage,
  getChatView,
  greetingOptions,
  historyUpTo,
  latestChat,
  markInterrupted,
  openChat,
  setActiveLeaf,
  setChatMaxTokens,
  setChatModel
} = await import('./chatStore')

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tavern-chat-'))
})

afterEach(() => {
  closeTavernDb()
  rmSync(dir, { recursive: true, force: true })
})

function newCard(name = '阿蕾', firstMes = '你来了。'): string {
  return saveCard({ ...base, name, firstMes })
}

describe('会话', () => {
  it('新会话把开场白写成第一条消息', () => {
    const id = newCard()
    const chat = createChat(id, () => 0)
    const view = getChatView(chat.id)!
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]!.role).toBe('assistant')
    expect(view.messages[0]!.content).toBe('你来了。')
  })

  it('没有开场白就不写空消息', () => {
    const id = newCard('阿蕾', '')
    const view = getChatView(createChat(id).id)!
    expect(view.messages).toHaveLength(0)
  })

  it('openChat 接着最近一场，不会每次新开', () => {
    const id = newCard()
    const first = openChat(id)
    const second = openChat(id)
    expect(second.id).toBe(first.id)
    expect(latestChat(id)!.id).toBe(first.id)
  })

  it('角色不存在时报错', () => {
    expect(() => createChat('nope')).toThrow('角色不存在')
  })

  it('开场白可选项 = 主开场白 + 备选，空字符串不占号', () => {
    const id = saveCard({
      ...base,
      name: '阿蕾',
      firstMes: '你来了。',
      alternateGreetings: ['雨夜。', '  ', '清晨。']
    })
    expect(greetingOptions(id)).toEqual(['你来了。', '雨夜。', '清晨。'])
  })

  it('选了第几条就开场第几条，不随机', () => {
    const id = saveCard({
      ...base,
      name: '阿蕾',
      firstMes: '你来了。',
      alternateGreetings: ['雨夜。', '清晨。']
    })
    // random 恒为 0 会选中主开场白，这里要的正是「用户选的 2」压过随机
    const view = getChatView(createChat(id, () => 0, 2).id)!
    expect(view.messages[0]!.content).toBe('清晨。')
  })

  it('选「不要开场白」就不写第一条消息', () => {
    const id = newCard()
    expect(getChatView(createChat(id, () => 0, null).id)!.messages).toHaveLength(0)
  })
})

describe('消息树', () => {
  it('被打断的半句带 interrupted 标记，完整的回复没有', () => {
    const id = newCard()
    const chat = createChat(id, () => 0)
    const full = appendMessage(chat.id, activeLeafId(chat.id), 'assistant', '说完了')
    const cut = appendMessage(chat.id, full, 'assistant', '说一半')
    markInterrupted(chat.id, cut)
    const view = getChatView(chat.id)!
    expect(view.messages.find((item) => item.id === full)!.interrupted).toBe(false)
    expect(view.messages.find((item) => item.id === cut)!.interrupted).toBe(true)
  })

  it('分支末尾悬空的用户消息标 resendable，回复补上后不再标', () => {
    const id = newCard()
    const chat = createChat(id, () => 0)
    // 模拟崩溃：用户消息落库了，回复一个 token 都没来
    const user = appendMessage(chat.id, activeLeafId(chat.id), 'user', '师父在吗')
    let path = activePath(chat.id)
    expect(path[path.length - 1]!.resendable).toBe(true)

    const reply = appendMessage(chat.id, user, 'assistant', '在。')
    path = activePath(chat.id)
    expect(path.find((item) => item.id === user)!.resendable).toBe(false)
    expect(path[path.length - 1]!.id).toBe(reply)
    expect(path[path.length - 1]!.resendable).toBe(false)
  })

  it('追加消息后当前分支就是整条链', () => {
    const id = newCard()
    const chat = createChat(id, () => 0)
    const userId = appendMessage(chat.id, activeLeafId(chat.id), 'user', '你好')
    appendMessage(chat.id, userId, 'assistant', '你好呀')

    const path = activePath(chat.id)
    expect(path.map((item) => item.content)).toEqual(['你来了。', '你好', '你好呀'])
    expect(path[2]!.branchCount).toBe(1)
  })

  it('重生成：同父再长一条分支，两条都能切', () => {
    const id = newCard()
    const chat = createChat(id, () => 0)
    const userId = appendMessage(chat.id, activeLeafId(chat.id), 'user', '你好')
    const first = appendMessage(chat.id, userId, 'assistant', '第一版')
    const second = appendMessage(chat.id, userId, 'assistant', '第二版')

    let path = activePath(chat.id)
    expect(path[path.length - 1]!.content).toBe('第二版')
    expect(path[path.length - 1]!.branchCount).toBe(2)
    expect(path[path.length - 1]!.branchIds).toEqual([first, second])

    // 切回第一条分支
    setActiveLeaf(chat.id, first)
    path = activePath(chat.id)
    expect(path[path.length - 1]!.content).toBe('第一版')
    expect(path[path.length - 1]!.branchIndex).toBe(0)
  })

  it('编辑不是原地覆盖：长出新分支，旧内容还在树里', () => {
    const id = newCard()
    const chat = createChat(id, () => 0)
    const userId = appendMessage(chat.id, activeLeafId(chat.id), 'user', '原来的话')
    const edited = editMessage(userId, '改过的话')

    expect(edited).not.toBeNull()
    const path = activePath(chat.id)
    expect(path.map((item) => item.content)).toEqual(['你来了。', '改过的话'])
    expect(path[1]!.branchCount).toBe(2)

    setActiveLeaf(chat.id, userId)
    expect(activePath(chat.id).map((item) => item.content)).toEqual(['你来了。', '原来的话'])
  })

  it('软删：当前叶子退回父节点，删掉的不再出现在分支里', () => {
    const id = newCard()
    const chat = createChat(id, () => 0)
    const userId = appendMessage(chat.id, activeLeafId(chat.id), 'user', '你好')
    const reply = appendMessage(chat.id, userId, 'assistant', '你好呀')

    deleteMessage(reply)
    expect(activeLeafId(chat.id)).toBe(userId)
    expect(activePath(chat.id).map((item) => item.content)).toEqual(['你来了。', '你好'])
  })

  it('删掉一条分支后，分支计数里不再包含它', () => {
    const id = newCard()
    const chat = createChat(id, () => 0)
    const userId = appendMessage(chat.id, activeLeafId(chat.id), 'user', '你好')
    const first = appendMessage(chat.id, userId, 'assistant', '第一版')
    const second = appendMessage(chat.id, userId, 'assistant', '第二版')

    deleteMessage(first)
    const path = activePath(chat.id)
    const reply = path[path.length - 1]!
    expect(reply.content).toBe('第二版')
    // 只剩一条可见分支：界面上不该再摆一个点不动「›」
    expect(reply.branchCount).toBe(1)
    expect(reply.branchIds).toEqual([second])
  })

  it('historyUpTo 只回溯到指定节点，不带后面的消息', () => {
    const id = newCard()
    const chat = createChat(id, () => 0)
    const userId = appendMessage(chat.id, activeLeafId(chat.id), 'user', '第一句')
    appendMessage(chat.id, userId, 'assistant', '第二句')

    const history = historyUpTo(chat.id, userId)
    expect(history.map((item) => item.content)).toEqual(['你来了。', '第一句'])
    expect(historyUpTo(chat.id, null)).toEqual([])
  })

  it('切到一个内部的节点时下潜到最深的子节点，后面的几轮不会消失', () => {
    const id = newCard()
    const chat = createChat(id, () => 0)
    const userId = appendMessage(chat.id, activeLeafId(chat.id), 'user', '你好')
    const reply = appendMessage(chat.id, userId, 'assistant', '你好呀')
    const again = appendMessage(chat.id, reply, 'user', '再说一句')
    appendMessage(chat.id, again, 'assistant', '好的')

    // 分支按钮记的是被点的那条消息，它可能是个分叉点
    setActiveLeaf(chat.id, userId)
    expect(activePath(chat.id).map((item) => item.content)).toEqual([
      '你来了。',
      '你好',
      '你好呀',
      '再说一句',
      '好的'
    ])
  })

  it('活动叶子记在会话设置里，重开连接也还在', () => {
    const id = newCard()
    const chat = createChat(id, () => 0)
    const first = appendMessage(chat.id, null, 'assistant', 'A')
    appendMessage(chat.id, null, 'assistant', 'B')
    setActiveLeaf(chat.id, first)
    closeTavernDb() // 模拟重启：连接重开，数据从磁盘读
    expect(activeLeafId(chat.id)).toBe(first)
  })
})

describe('会话级模型', () => {
  it('没选过是 null（由调用方回退到全局配置），选过就读回来', () => {
    const chat = createChat(newCard(), () => 0)
    expect(chatModel(chat.id)).toBeNull()

    setChatModel(chat.id, 'deepseek-v4-pro')
    expect(chatModel(chat.id)).toBe('deepseek-v4-pro')

    // 存了别的值（手改库 / 老数据）不能把请求打到不存在的模型上
    setChatModel(chat.id, '不存在的模型')
    expect(chatModel(chat.id)).toBeNull()

    closeTavernDb() // 重启后仍然记得
    expect(chatModel(chat.id)).toBeNull()
  })

  it('传 null 就是「跟随全局」', () => {
    const chat = createChat(newCard(), () => 0)
    setChatModel(chat.id, 'deepseek-flash')
    setChatModel(chat.id, null)
    expect(chatModel(chat.id)).toBeNull()
  })
})

describe('会话级回复上限', () => {
  it('没选过是 null（回退全局默认），选过就读回来', () => {
    const chat = createChat(newCard(), () => 0)
    expect(chatMaxTokens(chat.id)).toBeNull()

    setChatMaxTokens(chat.id, 6000)
    expect(chatMaxTokens(chat.id)).toBe(6000)

    // 不在候选档位里的值（手改库 / 老数据）当没选过，别把上限设成奇怪的数
    setChatMaxTokens(chat.id, 9999)
    expect(chatMaxTokens(chat.id)).toBeNull()
  })

  it('会话不存在时抛错，不让上层以为切成功了', () => {
    expect(() => setChatMaxTokens('没有这场会话', 3000)).toThrow()
  })
})

describe('群聊', () => {
  it('建群记住成员，标题默认按名字拼', () => {
    const a = newCard('阿蕾')
    const b = newCard('小满')
    const chat = createGroupChat([a, b])
    expect(chat.isGroup).toBe(true)
    expect(chat.title).toBe('阿蕾、小满')
    expect(groupMemberIds(chat.id)).toEqual([a, b])
  })

  it('少于两个、或者挑重复了，都算人数不够', () => {
    const a = newCard('阿蕾')
    expect(() => createGroupChat([a])).toThrow()
    expect(() => createGroupChat([a, a])).toThrow()
  })

  it('群聊不会顶掉「这张卡最近一场」：点角色还是进单聊', () => {
    const a = newCard('阿蕾')
    const b = newCard('小满')
    const single = openChat(a)
    createGroupChat([a, b])
    expect(latestChat(a)!.id).toBe(single.id)
    expect(openChat(a).id).toBe(single.id)
  })

  it('左栏列表按最近聊过排序，带成员名', () => {
    const a = newCard('阿蕾')
    const b = newCard('小满')
    const c = newCard('海边')
    createGroupChat([a, b], '海堤夜话')
    createGroupChat([a, c], '清晨')
    const list = listGroupChats()
    expect(list).toHaveLength(2)
    expect(list[0]!.title).toBe('清晨')
    expect(list[0]!.memberNames).toEqual(['阿蕾', '海边'])
  })

  it('getChatView 群聊返回全部成员，character 用一个占位', () => {
    const a = newCard('阿蕾')
    const b = newCard('小满')
    const chat = createGroupChat([a, b], '海堤夜话')
    const view = getChatView(chat.id)!
    expect(view.chat.isGroup).toBe(true)
    expect(view.members.map((member) => member.name)).toEqual(['阿蕾', '小满'])
    expect(view.character.id).toBe(a)
    expect(view.messages).toHaveLength(0)
  })
})
