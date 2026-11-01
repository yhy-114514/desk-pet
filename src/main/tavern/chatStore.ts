// 会话与消息树。消息从第一天就是树：重生成 / 编辑都会在同一起点长出新分支。
//
// 当前看到的是哪一条分支，记在 chats.settings 的 activeLeafId 里（不另建表），
// 没记过就取最新建的一条消息当叶子——新建 -> 往后聊，天然就是最新那条。
import { randomUUID } from 'node:crypto'
import { MODEL_OPTIONS } from '../chat/persona'
import { estimateTokens } from '../chat/session'
import { pickGreeting } from './cardFormat'
import { getCard, getCardData } from './cards'
import { openTavernDb } from './db'
import { readCardEntries, isWorldCard } from './worldbook'

type Row = Record<string, unknown>

export interface ChatSummary {
  id: string
  characterId: string
  title: string
  /** T8 群聊：成员记在 settings.members，character_id 只是「第一个成员」（外键非要一个值） */
  isGroup: boolean
  createdAt: number
  updatedAt: number
}

/** 群聊成员（给界面显示名字 / 立绘，也给提示词装配用设定） */
export interface GroupMemberInfo {
  id: string
  name: string
  avatarPath: string | null
  description: string
  personality: string
  scenario: string
}

export interface GroupChatSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  memberIds: string[]
  memberNames: string[]
}

export interface ChatMessageNode {
  id: string
  parentId: string | null
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  /** 同父分支里的第几条（0 起）与总数，界面上的「‹ 2/3 ›」 */
  branchIndex: number
  branchCount: number
  /** 同一父节点下的全部分支 id，按分支顺序（切分支用） */
  branchIds: string[]
  /** 这条是「生成到一半被打断」留下的半句（界面挂一个小标记，免得读起来像断在一半） */
  interrupted: boolean
  /**
   * 悬空的用户消息：当前分支的最后一个节点是 user、底下没有任何回复。
   * 正常流式回复会被它接上，出现这种状态多半是崩溃 / 强退留下的，界面据此给「重发」。
   */
  resendable: boolean
}

export interface ChatView {
  chat: ChatSummary
  character: {
    id: string
    name: string
    avatarPath: string | null
  }
  /** 群聊成员（单角色会话就是它自己一个）：界面按它认「谁在说话」 */
  members: GroupMemberInfo[]
  /** 当前分支上的消息（软删的跳过） */
  messages: ChatMessageNode[]
  /** 「世界卡」：描述很短、世界书条目极多，AI 更像跑团 GM（T8 群聊共用这套判断） */
  worldCard: boolean
}

function toChat(row: Row): ChatSummary {
  return {
    id: String(row['id']),
    characterId: String(row['character_id']),
    title: String(row['title']),
    isGroup: Number(row['is_group']) === 1,
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at'])
  }
}

function toNode(row: Row): {
  id: string
  chatId: string
  parentId: string | null
  branchIndex: number
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  deleted: boolean
} {
  return {
    id: String(row['id']),
    chatId: String(row['chat_id']),
    parentId: row['parent_id'] === null ? null : String(row['parent_id']),
    branchIndex: Number(row['branch_index']),
    role: row['role'] as 'user' | 'assistant' | 'system',
    content: String(row['content']),
    createdAt: Number(row['created_at']),
    deleted: Number(row['is_deleted']) === 1
  }
}

function readSettings(chatId: string): Record<string, unknown> {
  const row = openTavernDb().prepare('SELECT settings FROM chats WHERE id = ?').get(chatId) as
    | Row
    | undefined
  if (!row) return {}
  try {
    const parsed: unknown = JSON.parse(String(row['settings']))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeSettings(chatId: string, settings: Record<string, unknown>): void {
  openTavernDb()
    .prepare('UPDATE chats SET settings = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(settings), Date.now(), chatId)
}

export function getChat(id: string): ChatSummary | null {
  const row = openTavernDb().prepare('SELECT * FROM chats WHERE id = ?').get(id) as Row | undefined
  return row ? toChat(row) : null
}

/** 这场会话选的模型；没选过（或存的是别的值）返回 null，
 * 由调用方回退到全局 `config.model`——回退留在调用方，这里不去碰鲸鱼娘的配置。
 */
export function chatModel(chatId: string): string | null {
  const row = openTavernDb().prepare('SELECT model FROM chats WHERE id = ?').get(chatId) as
    | Row
    | undefined
  const saved = row?.['model']
  if (typeof saved !== 'string') return null
  return (MODEL_OPTIONS as readonly string[]).includes(saved) ? saved : null
}

/** 改这场会话的模型；传 null 就是「跟随全局」。不碰 updated_at——选模型不算聊过天。 */
export function setChatModel(chatId: string, model: string | null): void {
  const value = model && (MODEL_OPTIONS as readonly string[]).includes(model) ? model : null
  const result = openTavernDb().prepare('UPDATE chats SET model = ? WHERE id = ?').run(value, chatId)
  // 0 行说明没对上这场会话；静默当成功会让上层误以为切了模型、实际仍走全局
  if (result.changes === 0) throw new Error('会话不存在，模型切换没生效')
}

/** 回复上限的候选档位（令牌数）。第一档是默认，复杂卡手动调高。 */
export const MAX_TOKENS_OPTIONS = [1200, 3000, 6000, 8192] as const

/** 这场会话的回复上限；没选过返回 null，由调用方回退全局默认。 */
export function chatMaxTokens(chatId: string): number | null {
  const row = openTavernDb().prepare('SELECT max_tokens FROM chats WHERE id = ?').get(chatId) as
    | Row
    | undefined
  const saved = row?.['max_tokens']
  if (typeof saved !== 'number') return null
  return (MAX_TOKENS_OPTIONS as readonly number[]).includes(saved) ? saved : null
}

/** 改这场会话的回复上限；传 null 就是「跟随全局默认」。 */
export function setChatMaxTokens(chatId: string, value: number | null): void {
  const valid = value !== null && (MAX_TOKENS_OPTIONS as readonly number[]).includes(value)
  const result = openTavernDb()
    .prepare('UPDATE chats SET max_tokens = ? WHERE id = ?')
    .run(valid ? value : null, chatId)
  if (result.changes === 0) throw new Error('会话不存在，回复上限没生效')
}

/**
 * 某个角色最近一场未删除的**单角色**会话；没有就是 null。
 * 必须排除群聊：群聊的 character_id 是「第一个成员」，不排除的话，
 * 点这个名字会一头钻进那个群。
 */
export function latestChat(characterId: string): ChatSummary | null {
  const row = openTavernDb()
    .prepare(
      'SELECT * FROM chats WHERE character_id = ? AND is_group = 0 AND deleted_at IS NULL' +
        ' ORDER BY updated_at DESC LIMIT 1'
    )
    .get(characterId) as Row | undefined
  return row ? toChat(row) : null
}

// ── 群聊（T8） ──────────────────────────────────────────────────────
// 成员记在 chats.settings.members（与 activeLeafId / spectate 同一套做法，不加表），
// character_id 借用第一个成员——它是 NOT NULL 且有外键。

// 人数上下限定义在 shared，建群弹窗和这里的校验用的是同一个数
import { GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS } from '../../shared/groupChat'
export { GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS }

export function groupMemberIds(chatId: string): string[] {
  const raw = readSettings(chatId)['members']
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string')
}

/** 群聊成员（角色被删掉的自动跳过）；单角色会话也可以调，得到的就是它自己。 */
export function groupMembers(chatId: string): GroupMemberInfo[] {
  return groupMemberIds(chatId)
    .map((id) => getCard(id))
    .filter((card): card is NonNullable<typeof card> => card !== null)
    .map((card) => ({
      id: card.id,
      name: card.name,
      avatarPath: card.avatarPath,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario
    }))
}

/** 建群：选 2~5 个角色，名字默认用角色名拼起来。 */
export function createGroupChat(memberIds: string[], title = ''): ChatSummary {
  const cards = memberIds
    .map((id) => getCard(id))
    .filter((card): card is NonNullable<typeof card> => card !== null)
    .filter((card, index, list) => list.findIndex((item) => item.id === card.id) === index)
  if (cards.length < GROUP_MIN_MEMBERS) throw new Error('群聊至少要选两个角色')
  if (cards.length > GROUP_MAX_MEMBERS) throw new Error('群聊最多五个人，再多就听不清了')
  const id = randomUUID()
  const now = Date.now()
  const name = title.trim() || cards.map((card) => card.name).join('、').slice(0, 40)
  openTavernDb()
    .prepare(
      'INSERT INTO chats (id, character_id, title, is_group, settings, created_at, updated_at)' +
        ' VALUES (?, ?, ?, 1, ?, ?, ?)'
    )
    .run(id, cards[0]!.id, name, JSON.stringify({ members: cards.map((card) => card.id) }), now, now)
  return getChat(id)!
}

/** 左栏「群聊」列表，按最近聊过排序。 */
export function listGroupChats(): GroupChatSummary[] {
  const rows = openTavernDb()
    .prepare(
      // updated_at 只到秒：同一秒建的两个群要有确定的先后，否则列表顺序随机
      'SELECT * FROM chats WHERE is_group = 1 AND deleted_at IS NULL ORDER BY updated_at DESC, rowid DESC'
    )
    .all() as Row[]
  return rows.map((row) => {
    const chat = toChat(row)
    const members = groupMembers(chat.id)
    return {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      memberIds: members.map((member) => member.id),
      memberNames: members.map((member) => member.name)
    }
  })
}

/**
 * 这张卡能选的开场白：主开场白 + 备选，顺序与 pickGreeting 一致。
 * 返回原文（`{{user}}` 之类没替换）——选哪条是按序号的，文案由调用方替换给界面看。
 */
export function greetingOptions(characterId: string): string[] {
  const card = getCard(characterId)
  if (!card) return []
  return [card.firstMes, ...card.alternateGreetings].map((line) => line.trim()).filter(Boolean)
}

/**
 * 新建一场会话：把开场白写成第一条 assistant 消息（卡没写开场白就不写）。
 * `greetingIndex`：不传 = 随机挑一条（老的打开方式）；`null` = 不要开场白；数字 = 用户选的那条。
 */
export function createChat(
  characterId: string,
  random: () => number = Math.random,
  greetingIndex?: number | null
): ChatSummary {
  const card = getCard(characterId)
  if (!card) throw new Error('角色不存在')
  const db = openTavernDb()
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    'INSERT INTO chats (id, character_id, title, is_group, settings, created_at, updated_at)' +
      " VALUES (?, ?, ?, 0, '{}', ?, ?)"
  ).run(id, characterId, card.name, now, now)
  const greeting =
    greetingIndex === null
      ? ''
      : greetingIndex === undefined
        ? pickGreeting(card, random)
        : (greetingOptions(characterId)[greetingIndex] ?? '')
  if (greeting) appendMessage(id, null, 'assistant', greeting)
  return getChat(id)!
}

/** 已有会话就用最近那场，没有就开一场。界面上「点角色进聊天」走这里。 */
export function openChat(characterId: string): ChatSummary {
  return latestChat(characterId) ?? createChat(characterId)
}

/** 追加一条消息；parent 相同的就是一组分支，branch_index 往后排。返回新消息 id。 */
export function appendMessage(
  chatId: string,
  parentId: string | null,
  role: ChatMessageNode['role'],
  content: string
): string {
  const db = openTavernDb()
  const siblings = db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND parent_id IS ?')
    .get(chatId, parentId) as Row
  const branchIndex = Number(siblings['n'] ?? 0)
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    'INSERT INTO messages (id, chat_id, parent_id, branch_index, role, content, is_deleted,' +
      ' token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)'
  ).run(id, chatId, parentId, branchIndex, role, content, estimateTokens(content), now)
  db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, chatId)
  // 新消息一定是当前分支的终点
  writeSettings(chatId, { ...readSettings(chatId), activeLeafId: id })
  return id
}

/**
 * 记下「这条是被打断时落库的半句」，界面据此挂一个小标记。
 * 与 activeLeafId / members 同一套做法：记在 chats.settings 里，不加表。
 */
export function markInterrupted(chatId: string, messageId: string): void {
  const settings = readSettings(chatId)
  const raw = settings['interruptedIds']
  const list = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string')
    : []
  if (list.includes(messageId)) return
  // 只留最近 200 条，删掉的消息留下的 id 查不到，无所谓
  writeSettings(chatId, { ...settings, interruptedIds: [...list, messageId].slice(-200) })
}

/** 改写一条消息：不原地覆盖，而是从同一个父节点长出一条新分支（旧内容还能切回去看）。 */
export function editMessage(messageId: string, content: string): string | null {
  const row = openTavernDb().prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
    | Row
    | undefined
  if (!row) return null
  const node = toNode(row)
  const text = content.trim()
  if (!text) return null
  return appendMessage(node.chatId, node.parentId, node.role, text)
}

/** 软删。删掉的如果是当前叶子，把活动叶子退回它的父节点，免得整条分支都看不见。 */
export function deleteMessage(messageId: string): void {
  const row = openTavernDb().prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
    | Row
    | undefined
  if (!row) return
  const node = toNode(row)
  openTavernDb()
    .prepare('UPDATE messages SET is_deleted = 1 WHERE id = ?')
    .run(messageId)
  const settings = readSettings(node.chatId)
  if (settings['activeLeafId'] === messageId) {
    writeSettings(node.chatId, { ...settings, activeLeafId: node.parentId })
  }
}

/** 切到另一条分支：直接把活动叶子设到那条消息上（它可能是叶子，也可能是分叉点）。 */
export function setActiveLeaf(chatId: string, messageId: string): void {
  writeSettings(chatId, { ...readSettings(chatId), activeLeafId: messageId })
}

/** 这场会话让不让鲸鱼娘观战（默认关）。跟会话走，换个角色就是另一份决定。 */
export function spectateEnabled(chatId: string): boolean {
  return readSettings(chatId)['spectate'] === true
}

export function setSpectate(chatId: string, enabled: boolean): void {
  // 不走 writeSettings：0 行等于「这场会话不在了」，静默当成功会让界面显示已开、实际没存
  const result = openTavernDb()
    .prepare('UPDATE chats SET settings = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify({ ...readSettings(chatId), spectate: enabled }), Date.now(), chatId)
  if (result.changes === 0) throw new Error('会话不存在，观战开关没生效')
}

/** 当前分支的叶子节点 id；会话还没有消息时为 null。 */
export function activeLeafId(chatId: string): string | null {
  const rows = allRows(chatId)
  return resolveLeaf(chatId, rows)?.id ?? null
}

function allRows(chatId: string): ReturnType<typeof toNode>[] {
  const rows = openTavernDb()
    .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC')
    .all(chatId) as Row[]
  return rows.map(toNode)
}

/**
 * 找当前叶子：settings 里记着的那条优先；它被删了或根本不存在时，
 * 退回「最后创建的、没有子节点的那条」——新建分支总是后建，所以这就是最新分支。
 */
function resolveLeaf(
  chatId: string,
  rows: ReturnType<typeof toNode>[]
): ReturnType<typeof toNode> | null {
  if (rows.length === 0) return null
  const remembered = readSettings(chatId)['activeLeafId']
  if (typeof remembered === 'string') {
    const found = rows.find((row) => row.id === remembered && !row.deleted)
    // 分支按钮记的是被点的那条消息，它可能是个分叉点（内部节点）。
    // 直接把它当叶子会让它**后面**的几轮从界面上消失，而且下一条消息
    // 会挂在它下面另开一条分支——所以要下潜到最深的那个子节点
    if (found) return deepestLeaf(rows, found)
  }
  // 只数没删的子节点：被删掉的那条不该让它的父节点失去「叶子」资格
  const hasChild = new Set(
    rows
      .filter((row) => !row.deleted)
      .map((row) => row.parentId)
      .filter(Boolean)
  )
  const leaves = rows.filter((row) => !hasChild.has(row.id) && !row.deleted)
  const pool = leaves.length > 0 ? leaves : rows.filter((row) => !row.deleted)
  if (pool.length === 0) return null
  return pool.reduce((best, row) => (row.createdAt >= best.createdAt ? row : best))
}

/** 沿着未删的子节点一路往下（同层取最后创建的那条），回到最深的叶子。 */
function deepestLeaf(
  rows: ReturnType<typeof toNode>[],
  start: ReturnType<typeof toNode>
): ReturnType<typeof toNode> {
  const children = new Map<string, ReturnType<typeof toNode>[]>()
  for (const row of rows) {
    if (row.deleted || !row.parentId) continue
    const list = children.get(row.parentId) ?? []
    list.push(row)
    children.set(row.parentId, list)
  }
  let current = start
  const seen = new Set<string>()
  while (!seen.has(current.id)) {
    seen.add(current.id)
    const list = children.get(current.id) ?? []
    if (list.length === 0) break
    current = list.reduce((best, row) => (row.createdAt >= best.createdAt ? row : best))
  }
  return current
}

/**
 * 从某条消息沿 parent 一路回溯到根，顺序从早到晚（含起点）。
 * 分支回溯的规则只写在这一处：`activePath` 与 `historyUpTo` 都靠它。
 */
function chainTo(rows: ReturnType<typeof toNode>[], startId: string | null): ReturnType<typeof toNode>[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const chain: ReturnType<typeof toNode>[] = []
  const seen = new Set<string>()
  let cursor = startId ? (byId.get(startId) ?? null) : null
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    chain.push(cursor)
    cursor = cursor.parentId ? (byId.get(cursor.parentId) ?? null) : null
  }
  return chain.reverse()
}

/** 当前分支：从叶子沿 parent 一路回溯到根。软删的节点跳过（子节点照常接上）。 */
export function activePath(chatId: string): ChatMessageNode[] {
  const rows = allRows(chatId)
  const chain = chainTo(rows, resolveLeaf(chatId, rows)?.id ?? null)
  const interruptedRaw = readSettings(chatId)['interruptedIds']
  const interrupted = new Set(
    Array.isArray(interruptedRaw)
      ? interruptedRaw.filter((item): item is string => typeof item === 'string')
      : []
  )

  const siblings = new Map<string, ReturnType<typeof toNode>[]>()
  for (const row of rows) {
    // 软删的分支不参与计数：界面上的「‹ n/N ›」指的是还能切过去的那些，
    // 把删掉的算进去会留下一个点下去没反应的空按钮
    if (row.deleted) continue
    const key = row.parentId ?? ''
    const list = siblings.get(key) ?? []
    list.push(row)
    siblings.set(key, list)
  }
  for (const list of siblings.values()) list.sort((a, b) => a.branchIndex - b.branchIndex)

  const visible = chain.filter((row) => !row.deleted)
  const lastId = visible[visible.length - 1]?.id ?? null
  return visible.map((row) => {
    const group = siblings.get(row.parentId ?? '') ?? []
    return {
      id: row.id,
      parentId: row.parentId,
      role: row.role,
      content: row.content,
      createdAt: row.createdAt,
      branchIndex: Math.max(0, group.findIndex((item) => item.id === row.id)),
      branchCount: group.length,
      branchIds: group.map((item) => item.id),
      interrupted: interrupted.has(row.id),
      // 分支末尾悬着一条没有回复的用户消息 = 这一轮没说完（崩溃 / 强退留下的）
      resendable:
        row.id === lastId && row.role === 'user' && (siblings.get(row.id)?.length ?? 0) === 0
    }
  })
}

/** 聊天页要的整包数据：会话 + 角色摘要 + 当前分支。 */
export function getChatView(chatId: string): ChatView | null {
  const chat = getChat(chatId)
  if (!chat) return null
  if (chat.isGroup) {
    const members = groupMembers(chatId)
    if (members.length === 0) return null
    return {
      chat,
      // 「头像 / 标题」借第一个成员；群名在 chat.title 里
      character: { id: members[0]!.id, name: chat.title, avatarPath: members[0]!.avatarPath },
      members,
      messages: activePath(chatId),
      worldCard: false
    }
  }
  const card = getCard(chat.characterId)
  if (!card) return null
  return {
    chat,
    character: { id: card.id, name: card.name, avatarPath: card.avatarPath },
    members: [
      {
        id: card.id,
        name: card.name,
        avatarPath: card.avatarPath,
        description: card.description,
        personality: card.personality,
        scenario: card.scenario
      }
    ],
    messages: activePath(chatId),
    worldCard: isWorldCard(card.description, readCardEntries(getCardData(card.id)).length)
  }
}

/**
 * 到某条消息（含）为止的整条链，顺序从早到晚。
 * 发送 / 重生成都要「到父节点为止」的历史：重生成一条中间消息时，
 * 当前活动分支后面的那些消息不该混进上下文。
 */
export function historyUpTo(
  chatId: string,
  upToId: string | null
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  return chainTo(allRows(chatId), upToId)
    .filter((row) => !row.deleted)
    .map((row) => ({ role: row.role, content: row.content }))
}
