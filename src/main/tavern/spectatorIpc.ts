// 鲸鱼娘旁观（T7）的 IPC：观战开关、问答 / 灵感、角色卡编辑器助手。
// 全部走 tavern: 前缀；流式事件带代次号，新的问题一开口就让上一次的结果作废。
import { ipcMain, type WebContents } from 'electron'
import { activePath, getChat, spectateEnabled, setSpectate } from './chatStore'
import { applyCardFix, askCardAssistant, askSpectator, diagnoseCard, type AskMode } from './spectator'
import { latestSummary, summarizeNow } from './summaryStore'

/** 每场会话 / 每张卡当前的代次：旧请求迟到的结果不许画回界面 */
const gens = new Map<string, number>()
const aborts = new Map<string, AbortController>()

function begin(key: string): { gen: number; controller: AbortController } {
  aborts.get(key)?.abort()
  const gen = (gens.get(key) ?? 0) + 1
  gens.set(key, gen)
  const controller = new AbortController()
  aborts.set(key, controller)
  return { gen, controller }
}

function end(key: string, controller: AbortController): void {
  if (aborts.get(key) === controller) aborts.delete(key)
}

function send(target: WebContents, channel: string, payload: unknown): void {
  if (!target.isDestroyed()) target.send(channel, payload)
}

function message(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return ''
    return error.message
  }
  return String(error)
}

export function registerTavernSpectatorIpc(): void {
  ipcMain.handle('tavern:spectator-get', (_event, chatId: string) => {
    if (!getChat(chatId)) return { enabled: false, hasArchive: false, messageCount: 0 }
    // 群聊里她看不过来（几个人的档案 / 立场是分开的），界面上直接说清楚
    if (getChat(chatId)!.isGroup) {
      return { enabled: false, hasArchive: false, messageCount: 0, group: true }
    }
    return {
      enabled: spectateEnabled(chatId),
      hasArchive: latestSummary(chatId) !== null,
      messageCount: activePath(chatId).length
    }
  })

  // 开 / 关观战。开启时顺手刷新一次观测档案（T3 的摘要在同一个时点跑），
  // 不然刚开的会话要等聊够几十条才有档案可看。
  ipcMain.handle(
    'tavern:spectator-set',
    (event, payload: { chatId: string; enabled: boolean }) => {
      const chat = getChat(payload.chatId)
      if (!chat) throw new Error('这场对话不在了。')
      if (chat.isGroup) throw new Error('群聊里人太多，她看不明白谁在说话。')
      setSpectate(payload.chatId, payload.enabled)
      if (payload.enabled) {
        void summarizeNow(payload.chatId, (active) =>
          send(event.sender, 'tavern:summary', { chatId: payload.chatId, active })
        )
      }
      return payload.enabled
    }
  )

  ipcMain.handle(
    'tavern:spectator-ask',
    async (
      event,
      payload: { chatId: string; question: string; mode?: AskMode }
    ): Promise<{ ok: boolean; text?: string; error?: string }> => {
      const chat = getChat(payload.chatId)
      if (!chat) return { ok: false, error: '这场对话不在了。' }
      if (chat.isGroup) return { ok: false, error: '群聊里人太多，她看不明白谁在说话。' }
      if (!spectateEnabled(payload.chatId)) return { ok: false, error: '她还没开始观战。' }
      const key = `chat:${payload.chatId}`
      const { gen, controller } = begin(key)
      try {
        const text = await askSpectator({
          chatId: payload.chatId,
          question: payload.question,
          mode: payload.mode,
          signal: controller.signal,
          onToken: (delta) =>
            send(event.sender, 'tavern:spectator-token', {
              chatId: payload.chatId,
              gen,
              delta
            })
        })
        if (gens.get(key) === gen) {
          send(event.sender, 'tavern:spectator-done', { chatId: payload.chatId, gen, text })
        }
        return { ok: true, text }
      } catch (error) {
        const detail = message(error)
        // 被新问题顶掉的请求不报错（用户看到的是新那一轮的答案）
        if (detail && gens.get(key) === gen) {
          send(event.sender, 'tavern:spectator-error', {
            chatId: payload.chatId,
            gen,
            error: detail
          })
        }
        return { ok: false, error: detail }
      } finally {
        end(key, controller)
      }
    }
  )

  ipcMain.handle(
    'tavern:card-assistant-ask',
    async (
      event,
      payload: { characterId: string; question: string }
    ): Promise<{ ok: boolean; text?: string; error?: string }> => {
      const key = `card:${payload.characterId}`
      const { gen, controller } = begin(key)
      try {
        const text = await askCardAssistant({
          characterId: payload.characterId,
          question: payload.question,
          signal: controller.signal,
          onToken: (delta) =>
            send(event.sender, 'tavern:card-assistant-token', {
              characterId: payload.characterId,
              gen,
              delta
            })
        })
        if (gens.get(key) === gen) {
          send(event.sender, 'tavern:card-assistant-done', {
            characterId: payload.characterId,
            gen,
            text
          })
        }
        return { ok: true, text }
      } catch (error) {
        const detail = message(error)
        if (detail && gens.get(key) === gen) {
          send(event.sender, 'tavern:card-assistant-error', {
            characterId: payload.characterId,
            gen,
            error: detail
          })
        }
        return { ok: false, error: detail }
      } finally {
        end(key, controller)
      }
    }
  )

  // 体检：读全量卡数据，让模型给出一份问题清单（含可执行的 fix）
  ipcMain.handle(
    'tavern:card-assistant-diagnose',
    async (
      event,
      payload: { characterId: string }
    ): Promise<{ ok: boolean; issues?: unknown[]; error?: string }> => {
      const key = `card:${payload.characterId}`
      const { controller } = begin(key)
      try {
        const issues = await diagnoseCard(payload.characterId, { signal: controller.signal })
        return { ok: true, issues }
      } catch (error) {
        const detail = message(error)
        return { ok: false, error: detail || '她被中断了。' }
      } finally {
        end(key, controller)
      }
    }
  )

  // 应用一条修复：先校验（applyCardFix 内部做），再写回 data_json / 平铺字段
  ipcMain.handle(
    'tavern:card-assistant-fix',
    (
      _event,
      payload: { characterId: string; fix: unknown }
    ): { ok: boolean; applied?: unknown; error?: string } => {
      try {
        const applied = applyCardFix(payload.characterId, payload.fix)
        return { ok: true, applied }
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
    }
  )
}
