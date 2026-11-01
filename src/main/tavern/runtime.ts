// 卡自带的状态栏页面（```html / <StatusPlaceHolderImpl/> 换出来的整页）不是自给自足的：
// 它假定自己跑在酒馆里，直接调 `getChatMessages` / `getLastMessageId` / `Mvu.getMvuData`
// / `eventOn(Mvu.events.VARIABLE_UPDATE_ENDED)` / `triggerSlash` 这些全局。
//
// 我们把它们放在沙箱 iframe 里跑，跨进程/跨源只能靠一次性注入的快照喂数据。
// 这里负责把「这场会话的现状」打成一份快照：当前分支的消息（楼层号从 0 起）、
// MVU 变量、世界书条目、角色/玩家名字。渲染层的 statusBridge 用它拼出那套运行时。
//
// 为什么不由渲染层自己拼：世界书要走三层合并（全局 → 角色 → 卡内嵌 → 会话），
// 那套逻辑在主进程，复制一份到渲染层迟早对不上。
import type { RuntimeLoreEntry, RuntimeMessage, RuntimeSnapshot } from '../../shared/tavernRuntime'
import { getCard, getCardData, loadProfile } from './cards'
import { activePath, getChat } from './chatStore'
import { resolveLoreEntries } from './lorebookStore'
import { loadOrInitVariables } from './variableStore'
import { readCardEntries } from './worldbook'

export type { RuntimeLoreEntry, RuntimeMessage, RuntimeSnapshot }

/** 状态栏只会回溯最近几楼，整条分支全塞进去会把每个 iframe 撑到几 MB */
const MAX_MESSAGES = 80
/**
 * 每条世界书正文在快照里截到这么长。
 * 多角色卡的世界书动辄几十上百条、单条几千字，整份塞进每个状态页 iframe
 * 实测一张卡就是 570KB——一屏十几个面板时，光这些 srcdoc 字符串就上百兆。
 * 状态页拿 `getLorebookEntries()` 主要是列条目名和做关键词匹配，正文只做展示，
 * 截断比让每个面板都背一份全文划算得多。
 */
const MAX_LORE_CHARS = 2000

const POSITION: Record<string, number> = { before_char: 0, after_char: 1, depth: 4 }

export function getRuntimeSnapshot(chatId: string): RuntimeSnapshot | null {
  const chat = getChat(chatId)
  if (!chat) return null
  const charName = chat.isGroup ? chat.title : (getCard(chat.characterId)?.name ?? chat.title)
  const userName = loadProfile().name || '旅人'

  const full = activePath(chatId)
  const offset = Math.max(0, full.length - MAX_MESSAGES)
  const messages: RuntimeMessage[] = full.slice(offset).map((node, index) => ({
    // 楼层号跟着「截断后的窗口」走：卡拿 getLastMessageId() 再按范围取，
    // 只要窗口内连续就够用，不需要和真实高度一致
    message_id: offset + index,
    role: node.role,
    message: node.content,
    name: node.role === 'user' ? userName : charName
  }))

  const merged = resolveLoreEntries({
    characterId: chat.characterId,
    chatId,
    cardEntries: readCardEntries(getCardData(chat.characterId))
  })
  const entries: RuntimeLoreEntry[] = merged.map((entry) => ({
    uid: entry.id,
    name: entry.name,
    keys: entry.keys,
    keysecondary: entry.secondaryKeys,
    content:
      entry.content.length > MAX_LORE_CHARS
        ? `${entry.content.slice(0, MAX_LORE_CHARS)}…`
        : entry.content,
    enabled: true,
    constant: entry.constant,
    order: entry.order,
    position: POSITION[entry.position] ?? 0
  }))

  return {
    charName,
    userName,
    messages,
    statData: loadOrInitVariables(chatId, chat.characterId),
    lorebook: { name: charName, entries }
  }
}
