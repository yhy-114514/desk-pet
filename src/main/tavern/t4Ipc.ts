// T4 的 IPC：世界书 / 正则 / 预设 / 文风 / 回复设置 / 状态栏 / 变量 / 调试。
// 通道一律 tavern: 前缀；文件对话框挂在酒馆窗口上，避免弹到桌宠后面。
import { ipcMain } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { pickOpenFiles, pickSaveFile, safeName } from './dialogFiles'
import { getCard, getCardData, updateCardData } from './cards'
import {
  createLorebook,
  deleteEntry,
  deleteLorebook,
  exportLorebook,
  importLorebook,
  listEntries,
  listLorebooks,
  saveEntriesAsBook,
  saveEntry,
  setLorebookEnabled,
  type LorebookEntryInput
} from './lorebookStore'
import { applyRegexRules, readCardRegexes, testRegex, type RegexRule } from './regexEngine'
import {
  removeCardLore,
  removeCardRegex,
  upsertCardLore,
  upsertCardRegex,
  type CardLoreInput
} from './cardEdit'
import { deleteRegex, listRegexes, resolveRegexes, saveRegex, type RegexInput } from './regexStore'
import { hasStatusPage } from './statusPanel'
import { getRuntimeSnapshot } from './runtime'
import {
  activePresetId,
  deletePreset,
  exportPreset,
  getPreset,
  importPreset,
  listPresets,
  savePreset,
  setActivePresetId
} from './presetStore'
import type { PresetData } from './preset'
import {
  addStyle,
  deleteStyle,
  listStyles,
  loadPromptSettings,
  savePromptSettings,
  type PromptSettings
} from './promptSettings'
import { formatStatus } from './mvu'
import { getChat } from './chatStore'
import { clearVariables, loadOrInitVariables, loadVariables, saveVariables } from './variableStore'
import { readCardEntries } from './worldbook'

/** 卡内嵌的世界书 / 正则（只读视图，编辑面用「另存为独立世界书」） */
function cardLayer(characterId: string): {
  lore: ReturnType<typeof readCardEntries>
  regexes: RegexRule[]
} {
  const data = getCardData(characterId)
  // 编辑面要能看到刚加、还没填内容的条目
  return {
    lore: readCardEntries(data, { includeEmpty: true }),
    regexes: readCardRegexes(data, { forEditing: true })
  }
}

export function registerTavernT4Ipc(): void {
  // ── 设置（文风 / 预算 / 回复篇幅 / 状态栏 / 变量）──
  ipcMain.handle('tavern:prompt-settings', () => loadPromptSettings())
  ipcMain.handle('tavern:prompt-settings-set', (_event, patch: Partial<PromptSettings>) =>
    savePromptSettings(patch)
  )
  ipcMain.handle('tavern:styles-list', () => listStyles())
  ipcMain.handle('tavern:styles-add', (_event, input: { name: string; content: string }) =>
    addStyle(input.name, input.content)
  )
  ipcMain.handle('tavern:styles-delete', (_event, id: string) => deleteStyle(id))

  // ── 世界书 ──
  ipcMain.handle('tavern:lorebooks-list', (_event, scope?: string, ownerId?: string) =>
    listLorebooks(scope, ownerId)
  )
  ipcMain.handle(
    'tavern:lorebooks-create',
    (
      _event,
      input: {
        name: string
        description?: string
        scope: 'global' | 'character' | 'chat'
        characterId?: string | null
        chatId?: string | null
      }
    ) => createLorebook(input)
  )
  ipcMain.handle('tavern:lorebooks-delete', (_event, id: string) => deleteLorebook(id))
  ipcMain.handle('tavern:lorebooks-enable', (_event, id: string, enabled: boolean) =>
    setLorebookEnabled(id, enabled)
  )
  ipcMain.handle('tavern:lorebook-entries', (_event, bookId: string) => listEntries(bookId))
  ipcMain.handle(
    'tavern:lorebook-entry-save',
    (_event, payload: { bookId: string; entry: LorebookEntryInput }) =>
      saveEntry(payload.bookId, payload.entry)
  )
  ipcMain.handle('tavern:lorebook-entry-delete', (_event, id: string) => deleteEntry(id))

  ipcMain.handle(
    'tavern:lorebook-import',
    async (
      event,
      target: {
        scope: 'global' | 'character' | 'chat'
        characterId?: string | null
        chatId?: string | null
      }
    ) => {
      const files = await pickOpenFiles(event, '导入世界书', ['json'])
      const results: { file: string; ok: boolean; name?: string; entries?: number; error?: string }[] = []
      for (const file of files) {
        try {
          const raw = readFileSync(file, 'utf8')
          const result = importLorebook(raw, target)
          results.push({ file, ok: true, name: result.name, entries: result.entries })
        } catch (error) {
          results.push({ file, ok: false, error: (error as Error).message })
        }
      }
      return results
    }
  )

  ipcMain.handle('tavern:lorebook-export', async (event, id: string, name: string) => {
    const dest = await pickSaveFile(event, '导出世界书', `${safeName(name)}.json`, ['json'])
    if (!dest) return { ok: false }
    try {
      writeFileSync(dest, exportLorebook(id), 'utf8')
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  })

  // 卡内嵌世界书 → 独立世界书（编辑面不该要求用户重抄一遍）
  ipcMain.handle(
    'tavern:card-lore',
    (_event, characterId: string): { lore: ReturnType<typeof readCardEntries>; regexes: RegexRule[] } =>
      cardLayer(characterId)
  )
  ipcMain.handle(
    'tavern:card-lore-save-as',
    (
      _event,
      payload: {
        characterId: string
        name: string
        scope: 'global' | 'character' | 'chat'
        chatId?: string | null
      }
    ) => {
      const card = getCard(payload.characterId)
      if (!card) throw new Error('角色不存在')
      const entries = readCardEntries(getCardData(payload.characterId))
      return saveEntriesAsBook(payload.name || `${card.name}的世界书`, entries, {
        scope: payload.scope,
        characterId: payload.characterId,
        chatId: payload.chatId ?? null
      })
    }
  )

  // 卡内嵌世界书 / 正则：直接改在卡上（写回 data_json，导出时跟着走）
  ipcMain.handle(
    'tavern:card-lore-entry-save',
    (_event, payload: { characterId: string; entry: CardLoreInput }) => {
      let id = payload.entry.id ?? ''
      const ok = updateCardData(payload.characterId, (data) => {
        id = upsertCardLore(data, payload.entry)
      })
      if (!ok) throw new Error('角色不存在，或者这张卡里没有可写的卡数据')
      return id
    }
  )
  ipcMain.handle(
    'tavern:card-lore-entry-delete',
    (_event, payload: { characterId: string; entryId: string }) =>
      updateCardData(payload.characterId, (data) => {
        removeCardLore(data, payload.entryId)
      })
  )
  ipcMain.handle(
    'tavern:card-regex-save',
    (_event, payload: { characterId: string; rule: RegexRule }) => {
      let id = payload.rule.id
      const ok = updateCardData(payload.characterId, (data) => {
        id = upsertCardRegex(data, payload.rule)
      })
      if (!ok) throw new Error('角色不存在，或者这张卡里没有可写的卡数据')
      return id
    }
  )
  ipcMain.handle(
    'tavern:card-regex-delete',
    (_event, payload: { characterId: string; ruleId: string }) =>
      updateCardData(payload.characterId, (data) => {
        removeCardRegex(data, payload.ruleId)
      })
  )

  // ── 正则 ──
  ipcMain.handle('tavern:regex-list', (_event, scope: 'global' | 'character', characterId?: string) =>
    listRegexes(scope, characterId)
  )
  ipcMain.handle(
    'tavern:regex-save',
    (_event, payload: { input: RegexInput; characterId?: string | null }) =>
      saveRegex(payload.input, payload.characterId)
  )
  ipcMain.handle('tavern:regex-delete', (_event, id: string) => deleteRegex(id))
  ipcMain.handle('tavern:regex-test', (_event, payload: { rule: RegexRule; text: string }) =>
    testRegex(payload.rule, payload.text)
  )
  // 一次性把「全局 + 角色 + 卡内嵌」都列出来，界面按来源分组
  ipcMain.handle(
    'tavern:regex-all',
    (_event, payload: { characterId: string | null; cardData?: Record<string, unknown> | null }) => {
      const card = payload.characterId ? getCardData(payload.characterId) : null
      return {
        global: listRegexes('global'),
        character: payload.characterId ? listRegexes('character', payload.characterId) : [],
        // 编辑面必须看得见「刚加还没填正则」和「被禁用」的卡规则：不传 forEditing
        // 它们会被过滤掉，表现是「加一条」点了没反应、关掉的规则再也打不开
        card: readCardRegexes(card, { forEditing: true })
      }
    }
  )
  // 正则测试：拿一段样例文本依次过全局 + 角色的显示规则
  ipcMain.handle(
    'tavern:regex-preview',
    (_event, payload: { characterId: string | null; text: string; target: 'display' | 'prompt' }) => {
      const card = payload.characterId ? getCardData(payload.characterId) : null
      const rules = [
        ...listRegexes('global'),
        ...(payload.characterId ? listRegexes('character', payload.characterId) : []),
        ...readCardRegexes(card)
      ]
      const failures: { rule: string; error: string }[] = []
      const result = applyRegexRules(payload.text, rules, payload.target, failures as never)
      return { result, failures: failures.map((item) => item) }
    }
  )

  // ── 预设 ──
  ipcMain.handle('tavern:presets-list', () => ({
    items: listPresets(),
    activeId: activePresetId()
  }))
  ipcMain.handle('tavern:presets-get', (_event, id: string) => getPreset(id))
  ipcMain.handle('tavern:presets-save', (_event, payload: { id?: string; name: string; data: PresetData }) =>
    savePreset(payload)
  )
  ipcMain.handle('tavern:presets-delete', (_event, id: string) => deletePreset(id))
  ipcMain.handle('tavern:presets-active-set', (_event, id: string | null) => setActivePresetId(id))
  ipcMain.handle('tavern:presets-import', async (event) => {
    const files = await pickOpenFiles(event, '导入预设', ['json'])
    const results: { file: string; ok: boolean; name?: string; prompts?: number; error?: string }[] = []
    for (const file of files) {
      try {
        const result = importPreset(readFileSync(file, 'utf8'))
        results.push({ file, ok: true, name: result.name, prompts: result.prompts })
      } catch (error) {
        results.push({ file, ok: false, error: (error as Error).message })
      }
    }
    return results
  })
  ipcMain.handle('tavern:presets-export', async (event, id: string, name: string) => {
    const dest = await pickSaveFile(event, '导出预设', `${safeName(name)}.json`, ['json'])
    if (!dest) return { ok: false }
    try {
      writeFileSync(dest, exportPreset(id), 'utf8')
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  })

  // ── 变量 / 状态栏 ──
  ipcMain.handle('tavern:status-get', (_event, chatId: string) => {
    const chat = getChat(chatId)
    const state = chat ? loadOrInitVariables(chatId, chat.characterId) : loadVariables(chatId)
    // 卡自带状态页时别再把纯文本摘要摆在聊天页顶部（两份内容、后一份还是满屏 key: value）
    const rules = chat
      ? resolveRegexes({
          characterId: chat.characterId,
          target: 'display',
          cardData: getCardData(chat.characterId)
        })
      : []
    return { lines: formatStatus(state), state, ownPanel: hasStatusPage(rules) }
  })
  ipcMain.handle('tavern:variables-set', (_event, payload: { chatId: string; state: Record<string, unknown> }) =>
    saveVariables(payload.chatId, payload.state)
  )
  // 卡自带状态页需要的「酒馆运行时」快照：消息楼层 / 变量 / 世界书 / 名字。
  // 一次取全，注入沙箱 iframe 后页面才能同步地调 getChatMessages 这一套（见 runtime.ts）
  ipcMain.handle('tavern:runtime-get', (_event, chatId: string) => getRuntimeSnapshot(chatId))
  ipcMain.handle('tavern:variables-clear', (_event, chatId: string) => clearVariables(chatId))
}
