// T4 的数据层：世界书 CRUD 与三层合并、正则存取、预设导入导出与绑定、文风设置、会话变量。
// 四个 store 共用一份临时库，放在一个文件里省一次建库开销。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoreEntry } from './worldbook'

let dir = ''
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  protocol: { handle: (): void => {} }
}))

const { closeTavernDb } = await import('./db')
const { getCardData, saveCard } = await import('./cards')
const {
  createLorebook,
  deleteEntry,
  deleteLorebook,
  exportLorebook,
  importLorebook,
  listEntries,
  listLorebooks,
  resolveLoreEntries,
  saveEntriesAsBook,
  saveEntry,
  setLorebookEnabled
} = await import('./lorebookStore')
const { deleteRegex, listRegexes, resolveRegexes, saveRegex } = await import('./regexStore')
const {
  activePresetId,
  deletePreset,
  exportPreset,
  getPreset,
  importPreset,
  listPresets,
  presetForChat,
  savePreset,
  setActivePresetId,
  setChatPreset
} = await import('./presetStore')
const { addStyle, deleteStyle, listStyles, loadPromptSettings, resolveStyleText, savePromptSettings } =
  await import('./promptSettings')
const { clearVariables, consumeUpdates, loadOrInitVariables, loadVariables, saveVariables } =
  await import('./variableStore')
const { createChat } = await import('./chatStore')
const { readCardEntries } = await import('./worldbook')

const cardInput = {
  name: '测试角色',
  description: '描述',
  personality: '',
  scenario: '',
  firstMes: '你来了。',
  alternateGreetings: [],
  mesExample: '',
  systemPrompt: '',
  postHistoryInstructions: '',
  creator: '',
  creatorNotes: '',
  tags: [],
  avatarPath: null
}

function sampleEntry(over: Partial<LoreEntry> = {}): LoreEntry {
  return {
    id: 'x',
    name: '条目',
    keys: ['触发'],
    secondaryKeys: [],
    content: '内容',
    constant: false,
    selective: false,
    position: 'before_char',
    depth: 4,
    order: 100,
    caseSensitive: false,
    source: 'global',
    readonly: false,
    ...over
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tavern-t4-'))
})

afterEach(() => {
  closeTavernDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('世界书数据层', () => {
  it('建书 / 加条目 / 改条目 / 删条目 / 删书', () => {
    const bookId = createLorebook({ name: '设定集', scope: 'global' })
    const entryId = saveEntry(bookId, {
      name: '剑',
      keys: ['长剑'],
      secondaryKeys: ['锋'],
      content: '剑设定',
      constant: false,
      selective: true,
      position: 'after_char',
      depth: 4,
      order: 10,
      caseSensitive: true
    })
    const [entry] = listEntries(bookId)
    expect(entry).toMatchObject({
      name: '剑',
      keys: ['长剑'],
      secondaryKeys: ['锋'],
      selective: true,
      position: 'after_char',
      order: 10,
      caseSensitive: true
    })
    expect(listLorebooks()[0]).toMatchObject({ name: '设定集', entryCount: 1, enabled: true })

    saveEntry(bookId, { ...entry!, id: entryId, content: '改过的设定' })
    expect(listEntries(bookId)[0]!.content).toBe('改过的设定')

    deleteEntry(entryId)
    expect(listEntries(bookId)).toHaveLength(0)
    deleteLorebook(bookId)
    expect(listLorebooks()).toHaveLength(0)
  })

  it('导入 ST 世界书、导出再导入条目数一致', () => {
    const raw = JSON.stringify({
      name: '导入书',
      entries: [
        { keys: ['甲'], content: '一' },
        { keys: ['乙'], content: '二' }
      ]
    })
    const result = importLorebook(raw, { scope: 'global' })
    expect(result).toMatchObject({ name: '导入书', entries: 2 })
    const exported = exportLorebook(result.id)
    expect(exported).toContain('导入书')
    expect(JSON.parse(exported).entries).toHaveLength(2)
  })

  it('三层合并：全局 + 角色 + 卡内嵌 + 会话，关掉的书不参与', () => {
    const characterId = saveCard(cardInput)
    const chatId = createChat(characterId).id
    const globalBook = createLorebook({ name: '全局', scope: 'global' })
    saveEntry(globalBook, entryInput('全局条目'))
    const charBook = createLorebook({ name: '角色书', scope: 'character', characterId })
    saveEntry(charBook, entryInput('角色条目'))
    const chatBook = createLorebook({ name: '会话书', scope: 'chat', characterId, chatId })
    saveEntry(chatBook, entryInput('会话条目'))
    const offBook = createLorebook({ name: '关掉的书', scope: 'global' })
    saveEntry(offBook, entryInput('不该出现'))
    setLorebookEnabled(offBook, false)

    const merged = resolveLoreEntries({
      characterId,
      chatId,
      cardEntries: [sampleEntry({ id: 'card:1', name: '卡内嵌', content: '卡条目', readonly: true })]
    })
    expect(merged.map((item) => item.content)).toEqual(['全局条目', '角色条目', '卡条目', '会话条目'])
  })

  it('卡内嵌世界书可以另存为独立书', () => {
    const characterId = saveCard(cardInput)
    const id = saveEntriesAsBook(
      '苏月珑的世界书',
      [sampleEntry({ id: 'card:1', content: '一' }), sampleEntry({ id: 'card:2', content: '二' })],
      { scope: 'character', characterId }
    )
    expect(listEntries(id)).toHaveLength(2)
    expect(listLorebooks('character', characterId)[0]!.name).toBe('苏月珑的世界书')
  })
})

function entryInput(content: string) {
  return {
    name: content,
    keys: [`关键词${content}`],
    secondaryKeys: [],
    content,
    constant: false,
    selective: false,
    position: 'before_char' as const,
    depth: 4,
    order: 100,
    caseSensitive: false
  }
}

describe('正则数据层', () => {
  it('全局 / 角色分开存，更新时归属不变', () => {
    const characterId = saveCard(cardInput)
    const globalId = saveRegex({
      name: '全局规则',
      pattern: 'a',
      flags: 'g',
      replacement: 'b',
      target: 'both',
      enabled: true,
      order: 0
    })
    const charId = saveRegex(
      {
        name: '角色规则',
        pattern: 'c',
        flags: 'g',
        replacement: 'd',
        target: 'display',
        enabled: true,
        order: 1
      },
      characterId
    )
    expect(listRegexes('global').map((item) => item.id)).toEqual([globalId])
    expect(listRegexes('character', characterId).map((item) => item.id)).toEqual([charId])

    // 改角色规则时也传 characterId：scope 仍按库里的原值走
    saveRegex(
      {
        id: charId,
        name: '角色规则',
        pattern: 'c',
        flags: 'g',
        replacement: 'z',
        target: 'display',
        enabled: false,
        order: 1
      },
      characterId
    )
    const updated = listRegexes('character', characterId)[0]!
    expect(updated).toMatchObject({ replacement: 'z', enabled: false })

    deleteRegex(charId)
    expect(listRegexes('character', characterId)).toHaveLength(0)
  })

  it('resolveRegexes 合入卡内嵌规则并按作用面过滤', () => {
    const characterId = saveCard({
      ...cardInput,
      rawData: {
        extensions: {
          regex_scripts: [
            { id: 'hide', scriptName: '隐藏', findRegex: '/<s>/g', replaceString: '', markdownOnly: true }
          ]
        }
      }
    })
    saveRegex({
      name: '提示词规则',
      pattern: 'p',
      flags: 'g',
      replacement: '',
      target: 'prompt',
      enabled: true,
      order: 0
    })
    const cardData = getCardData(characterId)
    const display = resolveRegexes({ characterId, target: 'display', cardData })
    expect(display.some((item) => item.source === 'card')).toBe(true)
    expect(display.every((item) => item.target !== 'prompt')).toBe(true)
    const prompt = resolveRegexes({ characterId, target: 'prompt', cardData })
    expect(prompt.some((item) => item.target === 'prompt')).toBe(true)
    expect(prompt.some((item) => item.source === 'card')).toBe(false)
  })
})

describe('预设数据层', () => {
  const stPreset = JSON.stringify({
    name: '双人成行',
    temperature: 1.1,
    prompts: [
      { identifier: 'main', name: '主提示', content: '', marker: true },
      { identifier: 'cot', name: '思维链', content: '先想再写' }
    ],
    prompt_order: [{ character_id: 1, order: [{ identifier: 'main', enabled: true }, { identifier: 'cot', enabled: true }] }]
  })

  it('导入 / 列出 / 取整份 / 导出回 ST 形状', () => {
    const { id, name, prompts } = importPreset(stPreset)
    expect(name).toBe('双人成行')
    expect(prompts).toBe(2)
    expect(listPresets()[0]).toMatchObject({ name: '双人成行', promptCount: 2, enabledCount: 2 })
    expect(getPreset(id)!.sampling.temperature).toBe(1.1)
    expect(exportPreset(id)).toContain('prompt_order')
    deletePreset(id)
    expect(getPreset(id)).toBeNull()
  })

  it('整份改完写回；全局激活与会话绑定优先于全局', () => {
    const first = importPreset(stPreset).id
    const second = importPreset(stPreset).id
    const data = getPreset(first)!
    savePreset({ id: first, name: '改过名', data: { ...data, prompts: data.prompts.slice(0, 1) } })
    expect(listPresets().find((item) => item.id === first)).toMatchObject({
      name: '改过名',
      promptCount: 1
    })

    setActivePresetId(second)
    expect(activePresetId()).toBe(second)

    const characterId = saveCard(cardInput)
    const chatId = createChat(characterId).id
    expect(presetForChat(chatId)!.name).toBe('双人成行')
    setChatPreset(chatId, first)
    expect(presetForChat(chatId)!.name).toBe('改过名')

    // 删掉会话绑的那份：会话退回全局
    deletePreset(first)
    expect(presetForChat(chatId)!.name).toBe('双人成行')
  })
})

describe('设置与文风', () => {
  it('默认值可读，写入后夹回合法区间', () => {
    expect(loadPromptSettings()).toMatchObject({
      styleId: '',
      loreBudget: 1500,
      scanDepth: 6,
      // 成品卡的状态栏就是照变量画的，默认打开
      mvuEnabled: true
    })
    const saved = savePromptSettings({ loreBudget: 99999, scanDepth: 0, altCount: 9, mvuEnabled: false })
    expect(saved).toMatchObject({ loreBudget: 30000, scanDepth: 1, altCount: 5, mvuEnabled: false })
    expect(loadPromptSettings().loreBudget).toBe(30000)
  })

  it('最小篇幅比最大还大时以最小为准', () => {
    const saved = savePromptSettings({ replyMinChars: 500, replyMaxChars: 100 })
    expect(saved.replyMaxChars).toBe(500)
  })

  it('文风：内置三段 + 自定义增删，删当前选中会退回不选', () => {
    expect(listStyles().map((item) => item.id)).toEqual(['classical', 'light', 'literary'])
    const id = addStyle('白话', '像朋友聊天一样。')
    savePromptSettings({ styleId: id })
    expect(resolveStyleText(loadPromptSettings())).toBe('像朋友聊天一样。')
    expect(listStyles()).toHaveLength(4)

    deleteStyle(id)
    expect(listStyles()).toHaveLength(3)
    expect(loadPromptSettings().styleId).toBe('')
  })
})

describe('会话变量', () => {
  it('consumeUpdates 洗掉更新块并把 patch 落到会话状态', () => {
    const characterId = saveCard(cardInput)
    const chatId = createChat(characterId).id
    const result = consumeUpdates(
      chatId,
      '她点头。\n<update><json_patch>[{"op":"add","path":"/好感度","value":3}]</json_patch></update>'
    )
    expect(result.text).toBe('她点头。')
    expect(result.ops).toHaveLength(1)
    expect(loadVariables(chatId)).toEqual({ 好感度: 3 })

    // 第二条继续改同一个值
    consumeUpdates(
      chatId,
      '<update><json_patch>[{"op":"replace","path":"/好感度","value":5}]</json_patch></update>'
    )
    expect(loadVariables(chatId)).toEqual({ 好感度: 5 })
  })

  it('没有更新块时正文照常返回且状态不变', () => {
    const characterId = saveCard(cardInput)
    const chatId = createChat(characterId).id
    saveVariables(chatId, { 时间: '第一天' })
    const result = consumeUpdates(chatId, '普通回复')
    expect(result.ops).toHaveLength(0)
    expect(loadVariables(chatId)).toEqual({ 时间: '第一天' })
  })

  it('变量按会话隔离', () => {
    const characterId = saveCard(cardInput)
    const first = createChat(characterId).id
    const second = createChat(characterId).id
    saveVariables(first, { a: 1 })
    expect(loadVariables(second)).toEqual({})
  })

  it('清空状态后卡的 [initvar] 不会被填回来', () => {
    const characterId = saveCard({
      ...cardInput,
      rawData: {
        character_book: {
          entries: [
            { id: 1, comment: '[initvar]变量初始化', enabled: false, content: '时间: 第一天' }
          ]
        }
      }
    })
    const chatId = createChat(characterId).id
    expect(loadOrInitVariables(chatId, characterId)).toEqual({ 时间: '第一天' })

    clearVariables(chatId)
    // 「已清空」和「还没初始化」在库里都是空对象，得靠 variablesInit 记号分开
    expect(loadOrInitVariables(chatId, characterId)).toEqual({})

    // 模型把顶层键逐个删空（patch 之后落盘成交集里的空对象）同样不能复活
    saveVariables(chatId, {})
    expect(loadOrInitVariables(chatId, characterId)).toEqual({})
  })
})

// 卡内嵌世界书读取在 cards 的 rawData 上：这里确认它确实流进了三层合并
describe('卡内嵌世界书与 cards.rawData 的衔接', () => {
  it('rawData.character_book 能被 readCardEntries 读到', () => {
    saveCard({
      ...cardInput,
      rawData: { character_book: { entries: [{ keys: ['甲'], content: '卡里的世界书' }] } }
    })
    const entries = readCardEntries({
      character_book: { entries: [{ keys: ['甲'], content: '卡里的世界书' }] }
    })
    expect(entries[0]!.content).toBe('卡里的世界书')
  })
})
