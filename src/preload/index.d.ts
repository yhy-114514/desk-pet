import type { CardFix, CardIssue } from '../shared/cardFix'
import type { RuntimeSnapshot as TavernRuntimeSnapshot } from '../shared/tavernRuntime'

export interface PetWindowApi {
  moveBy: (dx: number, dy: number) => void
  setIgnoreMouse: (ignore: boolean) => void
  lockCursor: (x: number, y: number) => void
  unlockCursor: () => void
  playGroup: (group: string) => void
  setAutoPlay: (enabled: boolean) => void
  feed: () => void
  onPlayGroup: (callback: (group: string) => void) => void
  onSetAutoPlay: (callback: (enabled: boolean) => void) => void
  onFeed: (callback: () => void) => void
}

export interface AffectionStoreData {
  version: number
  affection: number
  lastActiveDate: string
}

export interface PetStoreApi {
  getAffection: () => Promise<AffectionStoreData>
  setAffection: (data: { affection: number; lastActiveDate: string }) => void
}

export interface ChatApi {
  send: (text: string) => void
  stop: () => void
  hideInput: () => void
  onToken: (callback: (data: { delta: string }) => void) => void
  onDone: (callback: (data?: { tts?: boolean; replaced?: boolean }) => void) => void
  onError: (callback: (data: { message: string }) => void) => void
  onMeta: (callback: () => void) => void
  onEmotion: (callback: (data: { emotion: string }) => void) => void
  onTts: (callback: (data: { audio: string; mime: string; more?: boolean }) => void) => void
  onTtsEnd: (callback: () => void) => void
  onTtsStop: (callback: () => void) => void
  getConfig: () => Promise<{
    hasKey: boolean
    model: string
    voice: string
    provider: 'edge' | 'qwen'
    voices: { name: string; label: string; provider: 'edge' | 'qwen' }[]
    hasQwenKey: boolean
    ttsEnabled: boolean
    proactiveEnabled: boolean
  }>
  setConfig: (config: {
    apiKey?: string
    model: string
    voice?: string
    qwenKey?: string
    ttsEnabled?: boolean
    proactiveEnabled?: boolean
  }) => void
  closeConfig: () => void
  openConfig: () => void
  openMemory: () => void
  openReminders: () => void
  openHelp: () => void
}

export interface HelpApi {
  close: () => void
}

export interface VoiceApi {
  transcribe: (
    audio: string,
    mime: string
  ) => Promise<{ ok: boolean; text?: string; error?: string }>
}

export interface ReminderEntry {
  at: number
  text: string
}

export interface ReminderApi {
  list: () => Promise<ReminderEntry[]>
  edit: (from: ReminderEntry, to: ReminderEntry) => void
  remove: (target: ReminderEntry) => void
  close: () => void
}

export interface MemoryEntry {
  id: string
  type: 'preference' | 'event' | 'promise' | 'identity' | 'fact' | 'other'
  content: string
  createdAt: number
  updatedAt: number
}

export interface MemoryApi {
  list: () => Promise<MemoryEntry[]>
  edit: (id: string, content: string) => void
  remove: (id: string) => void
  close: () => void
}

export interface TavernStatus {
  ok: boolean
  tables: string[]
  error?: string
}

/** 角色卡（SillyTavern v2 字段映射，字段名已 camelCase 化） */
export interface TavernCard {
  id: string
  name: string
  description: string
  personality: string
  scenario: string
  firstMes: string
  alternateGreetings: string[]
  mesExample: string
  systemPrompt: string
  postHistoryInstructions: string
  creator: string
  creatorNotes: string
  tags: string[]
  /** avatars/ 下的文件名；用 tavernAvatarUrl() 换成可访问的地址 */
  avatarPath: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

/** 可编辑字段（id / 时间戳由主进程补） */
export type CardInput = Omit<TavernCard, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>

export interface CardSummary {
  id: string
  name: string
  tags: string[]
  avatarPath: string | null
  tagline: string
  updatedAt: number
  deleted: boolean
}

export interface CardQuery {
  keyword?: string
  tag?: string
  includeDeleted?: boolean
  onlyDeleted?: boolean
  limit?: number
  offset?: number
}

export interface ImportOutcome {
  file: string
  ok: boolean
  name?: string
  updated?: boolean
  error?: string
}

export interface UserProfile {
  name: string
  description: string
}

/** 会话（一场对话） */
export interface TavernChat {
  id: string
  characterId: string
  title: string
  /** 群聊：成员在 settings.members，characterId 只是第一个成员 */
  isGroup: boolean
  createdAt: number
  updatedAt: number
}

/** 群聊成员（单角色会话里就是它自己） */
export interface TavernGroupMember {
  id: string
  name: string
  avatarPath: string | null
  description: string
  personality: string
  scenario: string
}

export interface TavernGroupSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  memberIds: string[]
  memberNames: string[]
}

/** 当前分支上的一条消息；branchCount > 1 时界面显示分支切换 */
export interface TavernChatMessage {
  id: string
  parentId: string | null
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  branchIndex: number
  branchCount: number
  branchIds: string[]
  /** 生成到一半被打断留下的半句：界面挂一个小标记 */
  interrupted: boolean
  /** 悬空的用户消息（分支末尾、底下没有回复）：多半是崩溃留下的，界面给「重发」 */
  resendable: boolean
}

export interface TavernChatView {
  chat: TavernChat
  character: { id: string; name: string; avatarPath: string | null }
  /** 群聊成员（单角色会话就是它自己一个）：界面按它认「谁在说话」 */
  members: TavernGroupMember[]
  messages: TavernChatMessage[]
  /** 世界卡（描述很短、世界书极多）：AI 更像跑团 GM */
  worldCard: boolean
}

/** T4：全局提示词设置（文风 / 世界书预算 / 回复篇幅 / 状态栏 / 变量） */
export interface TavernPromptSettings {
  styleId: string
  loreBudget: number
  scanDepth: number
  replyMinChars: number
  replyMaxChars: number
  altCount: number
  statusEnabled: boolean
  statusInPrompt: boolean
  mvuEnabled: boolean
}

export interface TavernStyle {
  id: string
  name: string
  content: string
  builtin: boolean
}

export type TavernLoreSource = 'card' | 'global' | 'character' | 'chat'

export interface TavernLoreEntry {
  id: string
  name: string
  keys: string[]
  secondaryKeys: string[]
  content: string
  constant: boolean
  selective: boolean
  position: 'before_char' | 'after_char' | 'depth'
  depth: number
  order: number
  caseSensitive: boolean
  source: TavernLoreSource
  readonly: boolean
}

export interface TavernLorebook {
  id: string
  name: string
  description: string
  scope: string
  characterId: string | null
  chatId: string | null
  enabled: boolean
  entryCount: number
  updatedAt: number
}

export interface TavernRegexRule {
  id: string
  name: string
  pattern: string
  flags: string
  replacement: string
  target: 'display' | 'prompt' | 'both'
  enabled: boolean
  order: number
  source: 'card' | 'global' | 'character'
  readonly: boolean
}

export interface TavernPresetPrompt {
  identifier: string
  name: string
  content: string
  role: 'system' | 'user' | 'assistant'
  enabled: boolean
  marker: boolean
  injectionPosition: 0 | 1
  injectionDepth: number
}

export interface TavernPresetData {
  name: string
  sampling: {
    temperature: number
    topP: number
    topK: number
    minP: number
    frequencyPenalty: number
    presencePenalty: number
    maxTokens: number
  }
  prompts: TavernPresetPrompt[]
  order: { identifier: string; enabled: boolean }[]
}

export interface TavernPresetSummary {
  id: string
  name: string
  promptCount: number
  enabledCount: number
  updatedAt: number
}

/** 注入调试面板：上一轮都注入了什么、各占多少 token */
export interface TavernPromptDebug {
  pieces: { label: string; source: string; tokens: number }[]
  loreActive: { name: string; source: TavernLoreSource; position: string; tokens: number }[]
  loreDropped: { name: string; source: TavernLoreSource; tokens: number }[]
  historyCount: number
  historyTokens: number
  totalTokens: number
  presetName: string | null
}

export interface TavernApi {
  open: () => void
  close: () => void
  ping: () => Promise<TavernStatus>
  cardsList: (query?: CardQuery) => Promise<{ items: CardSummary[]; total: number }>
  cardsTags: () => Promise<string[]>
  cardsGet: (id: string) => Promise<TavernCard | null>
  /** rawData 是导入时卡里的原始 data（世界书/正则/扩展），编辑页不用传；传了就以它为准 */
  cardsSave: (
    card: CardInput & { id?: string; rawData?: Record<string, unknown> }
  ) => Promise<string>
  cardsDelete: (id: string) => Promise<void>
  cardsRestore: (id: string) => Promise<void>
  cardsClear: () => Promise<number>
  cardsImport: () => Promise<ImportOutcome[]>
  cardsExport: (id: string, format: 'json' | 'png') => Promise<{ ok: boolean; error?: string }>
  avatarPick: () => Promise<{ path: string } | null>
  profileGet: () => Promise<UserProfile>
  profileSet: (profile: UserProfile) => Promise<void>

  /** 点角色进聊天：有会话就接着上次，没有就开一场 */
  chatOpen: (characterId: string) => Promise<TavernChatView | null>
  chatNew: (characterId: string) => Promise<TavernChatView | null>
  /** 第一次进卡时用：有没有旧会话 + 可选开场白（占位符已替换） */
  chatGreetings: (
    characterId: string
  ) => Promise<{ hasChat: boolean; options: string[] } | null>
  /** 用户选完开场白再开场；greetingIndex = null 表示不要开场白 */
  chatStart: (characterId: string, greetingIndex: number | null) => Promise<TavernChatView | null>
  chatView: (chatId: string) => Promise<TavernChatView | null>
  /** turn 是渲染层给的轮次号，会原样带回每一个流式事件（区分「上一轮被顶掉」与「本轮结束」） */
  chatSend: (chatId: string, text: string, turn: number) => void
  chatStop: () => void
  chatRegenerate: (chatId: string, messageId: string, turn: number) => void
  /** 重发一条悬空的用户消息（崩溃 / 强退后这一轮没有回复） */
  chatResend: (chatId: string, messageId: string, turn: number) => void
  chatEdit: (messageId: string, content: string) => Promise<string | null>
  chatDelete: (messageId: string) => Promise<void>
  chatBranch: (chatId: string, messageId: string) => Promise<TavernChatView | null>
  /** 群聊（T8）：选 2~5 个角色建群；返回的视图和单角色会话同一个形状 */
  groupCreate: (memberIds: string[], name?: string) => Promise<TavernChatView | null>
  groupsList: () => Promise<TavernGroupSummary[]>
  /** 群聊每换一个发言人发一次：token 之前到，界面据此另起一条消息并标上名字 */
  onSpeaker: (
    callback: (data: { chatId: string; turn: number; index: number; name: string }) => void
  ) => void
  onToken: (callback: (data: { chatId: string; delta: string; turn: number }) => void) => void
  onDone: (
    callback: (data: { chatId: string; messageId: string | null; turn: number }) => void
  ) => void
  onError: (callback: (data: { chatId: string; message: string; turn: number }) => void) => void

  /** 记忆三层（T3） */
  memorySettings: () => Promise<TavernMemorySettings>
  memorySettingsSet: (patch: Partial<TavernMemorySettings>) => Promise<TavernMemorySettings>
  memoriesList: (characterId: string) => Promise<TavernMemoryItem[]>
  memoriesUpdate: (id: string, content: string) => Promise<boolean>
  memoriesDelete: (id: string) => Promise<void>
  summaryGet: (chatId: string) => Promise<TavernSummaryView>
  /** 立即总结一次（不看间隔） */
  summaryRefresh: (chatId: string) => Promise<{ ok: boolean; error?: string }>
  summaryUpdate: (id: string, raw: string) => Promise<boolean>
  summaryDelete: (id: string) => Promise<void>
  onSummary: (callback: (data: { chatId: string; active: boolean }) => void) => void

  /** T4：提示词工具 */
  promptSettings: () => Promise<TavernPromptSettings>
  promptSettingsSet: (patch: Partial<TavernPromptSettings>) => Promise<TavernPromptSettings>
  stylesList: () => Promise<TavernStyle[]>
  stylesAdd: (input: { name: string; content: string }) => Promise<string>
  stylesDelete: (id: string) => Promise<void>

  lorebooksList: (scope?: string, ownerId?: string) => Promise<TavernLorebook[]>
  lorebooksCreate: (input: {
    name: string
    description?: string
    scope: 'global' | 'character' | 'chat'
    characterId?: string | null
    chatId?: string | null
  }) => Promise<string>
  lorebooksDelete: (id: string) => Promise<void>
  lorebooksEnable: (id: string, enabled: boolean) => Promise<void>
  lorebookEntries: (bookId: string) => Promise<TavernLoreEntry[]>
  lorebookEntrySave: (
    bookId: string,
    entry: Omit<TavernLoreEntry, 'source' | 'readonly' | 'id'> & { id?: string }
  ) => Promise<string>
  lorebookEntryDelete: (id: string) => Promise<void>
  lorebookImport: (target: {
    scope: 'global' | 'character' | 'chat'
    characterId?: string | null
    chatId?: string | null
  }) => Promise<{ file: string; ok: boolean; name?: string; entries?: number; error?: string }[]>
  lorebookExport: (id: string, name: string) => Promise<{ ok: boolean; error?: string }>
  cardLore: (characterId: string) => Promise<{ lore: TavernLoreEntry[]; regexes: TavernRegexRule[] }>
  cardLoreSaveAs: (payload: {
    characterId: string
    name: string
    scope: 'global' | 'character' | 'chat'
    chatId?: string | null
  }) => Promise<string>
  /** 卡内嵌世界书 / 正则：直接改在卡上（data_json），导出时跟着走 */
  cardLoreEntrySave: (
    characterId: string,
    entry: Omit<TavernLoreEntry, 'source' | 'readonly' | 'id'> & { id?: string }
  ) => Promise<string>
  cardLoreEntryDelete: (characterId: string, entryId: string) => Promise<boolean>
  cardRegexSave: (characterId: string, rule: TavernRegexRule) => Promise<string>
  cardRegexDelete: (characterId: string, ruleId: string) => Promise<boolean>

  regexList: (scope: 'global' | 'character', characterId?: string) => Promise<TavernRegexRule[]>
  regexSave: (
    input: Omit<TavernRegexRule, 'source' | 'readonly' | 'id'> & { id?: string },
    characterId?: string | null
  ) => Promise<string>
  regexDelete: (id: string) => Promise<void>
  regexTest: (
    rule: TavernRegexRule,
    text: string
  ) => Promise<{ ok: boolean; error?: string; hits: number; result: string }>
  regexAll: (characterId: string | null) => Promise<{
    global: TavernRegexRule[]
    character: TavernRegexRule[]
    card: TavernRegexRule[]
  }>
  regexPreview: (
    characterId: string | null,
    text: string,
    target: 'display' | 'prompt'
  ) => Promise<{ result: string; failures: { rule: TavernRegexRule; error: string }[] }>

  presetsList: () => Promise<{ items: TavernPresetSummary[]; activeId: string | null }>
  presetsGet: (id: string) => Promise<TavernPresetData | null>
  presetsSave: (payload: { id?: string; name: string; data: TavernPresetData }) => Promise<string>
  presetsDelete: (id: string) => Promise<void>
  presetsActiveSet: (id: string | null) => Promise<void>
  presetsImport: () => Promise<{ file: string; ok: boolean; name?: string; prompts?: number; error?: string }[]>
  presetsExport: (id: string, name: string) => Promise<{ ok: boolean; error?: string }>
  chatPresetSet: (chatId: string, presetId: string | null) => Promise<void>
  /** 这场会话用的模型（`deepseek-flash` / `deepseek-v4-pro`）与可选列表 */
  chatModelGet: (chatId: string) => Promise<{ model: string; options: string[] }>
  /** 切换本场模型，返回切换后实际生效的那个（下一轮生效） */
  chatModelSet: (chatId: string, model: string | null) => Promise<string>
  /** 本场回复上限（令牌数）与可选档位 */
  chatMaxTokensGet: (chatId: string) => Promise<{ value: number; options: number[] }>
  /** 切换本场回复上限，返回切换后实际生效的值（下一轮生效） */
  chatMaxTokensSet: (chatId: string, value: number | null) => Promise<number>

  debugGet: (chatId: string) => Promise<TavernPromptDebug | null>
  alternativesGet: (chatId: string) => Promise<string[]>
  variablesGet: (chatId: string) => Promise<{ state: Record<string, unknown>; lines: string[] }>
  statusGet: (
    chatId: string
  ) => Promise<{ state: Record<string, unknown>; lines: string[]; ownPanel: boolean }>
  runtimeGet: (chatId: string) => Promise<TavernRuntimeSnapshot | null>
  variablesSet: (chatId: string, state: Record<string, unknown>) => Promise<void>
  variablesClear: (chatId: string) => Promise<void>
  /** 状态页里的「复制选项」按钮：写剪贴板必须走主进程（iframe / 非焦点文档都写不了） */
  clipboardWrite: (text: string) => Promise<void>
  onVariables: (callback: (data: { chatId: string; lines: string[] }) => void) => void
  onAlternatives: (callback: (data: { chatId: string; items: string[] }) => void) => void

  /** T5：外观与通用设置 */
  appearanceGet: () => Promise<TavernAppearance>
  appearanceSet: (patch: Partial<TavernAppearance>) => Promise<TavernAppearance>
  /** 选图片 / 音频并拷进 media/，返回文件名；取消返回 null */
  appearanceMediaPick: (kind: 'image' | 'audio') => Promise<string | null>
  appearanceMediaRemove: (name: string) => Promise<void>
  onAppearance: (callback: (settings: TavernAppearance) => void) => void
  /** 酒馆回复朗读：more = 后面还有语音，tts-end = 不会再有新的 */
  onTts: (
    callback: (data: { chatId: string; audio: string; mime: string; more: boolean }) => void
  ) => void
  onTtsEnd: (callback: (data: { chatId: string }) => void) => void
  onTtsStop: (callback: (data: { chatId: string }) => void) => void

  /** T7：鲸鱼娘旁观 */
  spectatorGet: (chatId: string) => Promise<TavernSpectatorState>
  /** 开 / 关这场会话的观战；开启时顺手刷新一次观测档案 */
  spectatorSet: (chatId: string, enabled: boolean) => Promise<boolean>
  spectatorAsk: (payload: {
    chatId: string
    question: string
    mode?: 'ask' | 'idea'
  }) => Promise<{ ok: boolean; text?: string; error?: string }>
  onSpectatorToken: (
    callback: (data: { chatId: string; gen: number; delta: string }) => void
  ) => void
  onSpectatorDone: (
    callback: (data: { chatId: string; gen: number; text: string }) => void
  ) => void
  onSpectatorError: (
    callback: (data: { chatId: string; gen: number; error: string }) => void
  ) => void
  cardAssistantAsk: (payload: {
    characterId: string
    question: string
  }) => Promise<{ ok: boolean; text?: string; error?: string }>
  onCardAssistantToken: (
    callback: (data: { characterId: string; gen: number; delta: string }) => void
  ) => void
  onCardAssistantDone: (
    callback: (data: { characterId: string; gen: number; text: string }) => void
  ) => void
  onCardAssistantError: (
    callback: (data: { characterId: string; gen: number; error: string }) => void
  ) => void
  cardAssistantDiagnose: (
    characterId: string
  ) => Promise<{ ok: boolean; issues?: CardIssue[]; error?: string }>
  cardAssistantFix: (
    characterId: string,
    fix: CardFix
  ) => Promise<{ ok: boolean; applied?: CardFix; error?: string }>

  /** T9：打磨与发布 —— 备份 / 恢复、首次引导、关于 */
  backupExport: () => Promise<{ ok: boolean; path?: string; error?: string }>
  /** 导入成功后应用会自己重启（旧连接里的数据不能热替换）；开发模式下只能手动重跑 */
  backupImport: () => Promise<{ ok: boolean; restart?: 'auto' | 'manual'; error?: string }>
  onboardingGet: () => Promise<TavernOnboardingState>
  onboardingSet: (
    patch: Partial<Pick<TavernOnboardingState, 'firstRunDone' | 'greetShown'>>
  ) => Promise<TavernOnboardingState>
  aboutGet: () => Promise<{ version: string; electron: string }>
  /** 打开「使用说明」窗口（和桌宠侧是同一页） */
  openHelp: () => void
}

/** T9：首次启动引导的记号 */
export interface TavernOnboardingState {
  /** 引导弹窗已经走过了（导入过卡或点了跳过） */
  firstRunDone: boolean
  /** 「聊完第一轮」的小提示已经出现过了 */
  greetShown: boolean
  /** 现有角色卡数量：有卡就不必弹引导 */
  cardCount: number
}

/** T7：某场会话的观战状态 */
export interface TavernSpectatorState {
  enabled: boolean
  /** 已经有观测档案了（没有的话她会只能看最近剧情） */
  hasArchive: boolean
  /** 这场对话已有多少条消息（判断「还太短」） */
  messageCount: number
}

/** T5：外观与通用设置（settings 表的 appearance 键） */
export interface TavernAppearance {
  theme: 'dark' | 'light'
  /** 系统默认 / 圆体（系统字体栈） */
  font: 'system' | 'round'
  background: {
    mode: 'default' | 'cover' | 'custom'
    /** media/ 下的文件名 */
    image: string | null
    /** 遮罩浓度 0–90 */
    dim: number
  }
  bubble: {
    opacity: number
    fontSize: number
    narrationColor: string
    dialogueColor: string
    actionColor: string
  }
  ttsEnabled: boolean
  bgm: {
    enabled: boolean
    volume: number
    track: string | null
  }
}

export interface TavernMemorySettings {
  permanentEnabled: boolean
  memoryStrength: number
  memoryRange: number
  archiveEnabled: boolean
  summaryInterval: number
  visionEnabled: boolean
  visionDepth: number
  fullVision: boolean
}

export interface TavernMemoryItem {
  id: string
  type: string
  content: string
  createdAt: number
  updatedAt: number
}

export interface TavernSummaryView {
  /** 正在摘要（界面显示「总结中」） */
  summarizing: boolean
  /** 最新一份档案，已拼成可读文本；没有档案时为空串 */
  text: string
  items: { id: string; raw: string; createdAt: number }[]
}

export interface PetMouseApi {
  onGlobalDown: (callback: (p: { x: number; y: number }) => void) => void
  onGlobalUp: (callback: (p: { x: number; y: number }) => void) => void
  onGlobalMove: (callback: (p: { x: number; y: number }) => void) => void
}

declare global {
  interface Window {
    petWindow: PetWindowApi
    petStore: PetStoreApi
    petMouse: PetMouseApi
    chat: ChatApi
    memory: MemoryApi
    reminders: ReminderApi
    help: HelpApi
    voice: VoiceApi
    tavern: TavernApi
  }
}

export {}
