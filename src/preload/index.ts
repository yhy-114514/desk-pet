import { contextBridge, ipcRenderer } from 'electron'
import type { CardFix, CardIssue } from '../shared/cardFix'

// 渲染进程通过这个窄接口与主进程通信，不直接暴露 ipcRenderer / Node。
contextBridge.exposeInMainWorld('petWindow', {
  moveBy: (dx: number, dy: number): void => {
    ipcRenderer.send('window:move-by', { dx, dy })
  },
  setIgnoreMouse: (ignore: boolean): void => {
    ipcRenderer.send('window:set-ignore-mouse', ignore)
  },
  // 拖拽起期间锁定 / 释放光标
  lockCursor: (x: number, y: number): void => {
    ipcRenderer.send('window:lock-cursor', { x, y })
  },
  unlockCursor: (): void => {
    ipcRenderer.send('window:unlock-cursor')
  },
  // 开发预览面板：切换桌宠动画组 / 恢复自动轮播
  playGroup: (group: string): void => {
    ipcRenderer.send('pet:play-group', group)
  },
  setAutoPlay: (enabled: boolean): void => {
    ipcRenderer.send('pet:set-auto', enabled)
  },
  // 投喂大白饭：托盘菜单与输入栏的「喂饭」都走这一条
  feed: (): void => {
    ipcRenderer.send('pet:feed')
  },
  onFeed: (callback: () => void): void => {
    ipcRenderer.on('pet:feed', () => callback())
  },
  onPlayGroup: (callback: (group: string) => void): void => {
    ipcRenderer.on('pet:play-group', (_event, group: string) => callback(group))
  },
  onSetAutoPlay: (callback: (enabled: boolean) => void): void => {
    ipcRenderer.on('pet:set-auto', (_event, enabled: boolean) => callback(enabled))
  }
})

// 好感度等本地数据：读走 invoke，写走单向 send（主进程负责落盘）
contextBridge.exposeInMainWorld('petStore', {
  getAffection: (): Promise<{ version: number; affection: number; lastActiveDate: string }> =>
    ipcRenderer.invoke('pet:affection-get'),
  setAffection: (data: { affection: number; lastActiveDate: string }): void => {
    ipcRenderer.send('pet:affection-set', data)
  }
})

// 聊天：发消息 / 打断 / 接收流式 token。网络请求全部在主进程，渲染层只收发文本。
contextBridge.exposeInMainWorld('chat', {
  send: (text: string): void => {
    ipcRenderer.send('chat:send', { text })
  },
  stop: (): void => {
    ipcRenderer.send('chat:stop')
  },
  hideInput: (): void => {
    ipcRenderer.send('chat:input-hide')
  },
  onToken: (callback: (data: { delta: string }) => void): void => {
    ipcRenderer.on('chat:token', (_event, data: { delta: string }) => callback(data))
  },
  // tts：这一轮是否还会下发语音（决定 talk 要不要一直撑到念完）
  // replaced：这一轮是被新发言顶掉的，不是真的说完了
  onDone: (callback: (data?: { tts?: boolean; replaced?: boolean }) => void): void => {
    ipcRenderer.on('chat:done', (_event, data?: { tts?: boolean; replaced?: boolean }) => callback(data))
  },
  onError: (callback: (data: { message: string }) => void): void => {
    ipcRenderer.on('chat:error', (_event, data: { message: string }) => callback(data))
  },
  onMeta: (callback: () => void): void => {
    ipcRenderer.on('chat:meta', () => callback())
  },
  // 情绪标记：主进程从回复开头剥出来单独下发，气泡里只留正文
  onEmotion: (callback: (data: { emotion: string }) => void): void => {
    ipcRenderer.on('chat:emotion', (_event, data: { emotion: string }) => callback(data))
  },
  // 语音：主进程边生成边念，一轮回复可能分好几段下发。
  // more 表示「后面还有语音」（所以第一段播完还不能收尾）；
  // tts-end 表示「不会再有新的了」，之后只需等排队的声音播完。
  onTts: (callback: (data: { audio: string; mime: string; more?: boolean }) => void): void => {
    ipcRenderer.on('chat:tts', (_event, data: { audio: string; mime: string; more?: boolean }) =>
      callback(data)
    )
  },
  onTtsEnd: (callback: () => void): void => {
    ipcRenderer.on('chat:tts-end', () => callback())
  },
  onTtsStop: (callback: () => void): void => {
    ipcRenderer.on('chat:tts-stop', () => callback())
  },
  getConfig: (): Promise<{
    hasKey: boolean
    model: string
    voice: string
    provider: 'edge' | 'qwen'
    voices: { name: string; label: string; provider: 'edge' | 'qwen' }[]
    hasQwenKey: boolean
    ttsEnabled: boolean
    proactiveEnabled: boolean
  }> => ipcRenderer.invoke('chat:config-get'),
  setConfig: (config: {
    apiKey?: string
    model: string
    voice?: string
    qwenKey?: string
    ttsEnabled?: boolean
    proactiveEnabled?: boolean
  }): void => {
    ipcRenderer.send('chat:config-set', config)
  },
  closeConfig: (): void => {
    ipcRenderer.send('chat:config-saved')
  },
  openConfig: (): void => {
    ipcRenderer.send('chat:config-open')
  },
  openMemory: (): void => {
    ipcRenderer.send('chat:memory-open')
  },
  openReminders: (): void => {
    ipcRenderer.send('chat:reminders-open')
  },
  openHelp: (): void => {
    ipcRenderer.send('chat:help-open')
  }
})

// 使用说明窗口：整个软件的功能都在这一页，随时能回来查
contextBridge.exposeInMainWorld('help', {
  close: (): void => {
    ipcRenderer.send('chat:help-close')
  }
})

// 语音输入：渲染层录好整段音频（base64），主进程调百炼识别并回文字。
// 音频不进主进程的磁盘、Key 不出主进程，识别结果交给用户确认后再发送。
contextBridge.exposeInMainWorld('voice', {
  transcribe: (
    audio: string,
    mime: string
  ): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('chat:transcribe', { audio, mime })
})

// 提醒列表：列出 / 改时间改内容 / 删。队列始终在主进程，渲染层只看得到「时刻 + 内容」。
contextBridge.exposeInMainWorld('reminders', {
  list: (): Promise<{ at: number; text: string }[]> => ipcRenderer.invoke('chat:reminders-list'),
  edit: (from: { at: number; text: string }, to: { at: number; text: string }): void => {
    ipcRenderer.send('chat:reminders-edit', { from, to })
  },
  remove: (target: { at: number; text: string }): void => {
    ipcRenderer.send('chat:reminders-delete', target)
  },
  close: (): void => {
    ipcRenderer.send('chat:reminders-close')
  }
})

// 记忆手账：列出 / 改写 / 删除她记住的事。数据始终在主进程，渲染层只收发文本。
contextBridge.exposeInMainWorld('memory', {
  list: (): Promise<
    { id: string; type: string; content: string; createdAt: number; updatedAt: number }[]
  > => ipcRenderer.invoke('chat:memory-list'),
  edit: (id: string, content: string): void => {
    ipcRenderer.send('chat:memory-edit', { id, content })
  },
  remove: (id: string): void => {
    ipcRenderer.send('chat:memory-delete', id)
  },
  close: (): void => {
    ipcRenderer.send('chat:memory-close')
  }
})

// 酒馆：独立主窗口（多角色卡聊天）。数据层在主进程的 SQLite，渲染层只发请求。
contextBridge.exposeInMainWorld('tavern', {
  open: (): void => {
    ipcRenderer.send('tavern:open')
  },
  close: (): void => {
    ipcRenderer.send('tavern:close')
  },
  // 自检：返回建库结果与已有表名，T0 用它确认 schema 真的建出来了
  ping: (): Promise<{ ok: boolean; tables: string[]; error?: string }> =>
    ipcRenderer.invoke('tavern:ping'),

  // 角色卡：列表 / 读写 / 软删恢复 / 导入导出 / 立绘 / 用户人设
  cardsList: (query: unknown): Promise<unknown> => ipcRenderer.invoke('tavern:cards-list', query),
  cardsTags: (): Promise<unknown> => ipcRenderer.invoke('tavern:cards-tags'),
  cardsGet: (id: string): Promise<unknown> => ipcRenderer.invoke('tavern:cards-get', id),
  cardsSave: (card: unknown): Promise<string> => ipcRenderer.invoke('tavern:cards-save', card),
  cardsDelete: (id: string): Promise<void> => ipcRenderer.invoke('tavern:cards-delete', id),
  cardsRestore: (id: string): Promise<void> => ipcRenderer.invoke('tavern:cards-restore', id),
  cardsClear: (): Promise<number> => ipcRenderer.invoke('tavern:cards-clear'),
  cardsImport: (): Promise<unknown> => ipcRenderer.invoke('tavern:cards-import'),
  cardsExport: (id: string, format: 'json' | 'png'): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('tavern:cards-export', id, format),
  avatarPick: (): Promise<{ path: string } | null> => ipcRenderer.invoke('tavern:avatar-pick'),
  profileGet: (): Promise<unknown> => ipcRenderer.invoke('tavern:profile-get'),
  profileSet: (profile: unknown): Promise<void> => ipcRenderer.invoke('tavern:profile-set', profile),

  // 聊天（T2）：会话 / 消息树 / 流式。token 走事件推送，其余走 invoke。
  chatOpen: (characterId: string): Promise<unknown> =>
    ipcRenderer.invoke('tavern:chat-open', characterId),
  chatNew: (characterId: string): Promise<unknown> =>
    ipcRenderer.invoke('tavern:chat-new', characterId),
  chatGreetings: (characterId: string): Promise<unknown> =>
    ipcRenderer.invoke('tavern:chat-greetings', characterId),
  chatStart: (characterId: string, greetingIndex: number | null): Promise<unknown> =>
    ipcRenderer.invoke('tavern:chat-start', { characterId, greetingIndex }),
  chatView: (chatId: string): Promise<unknown> => ipcRenderer.invoke('tavern:chat-view', chatId),
  chatSend: (chatId: string, text: string, turn: number): void => {
    ipcRenderer.send('tavern:chat-send', { chatId, text, turn })
  },
  chatStop: (): void => {
    ipcRenderer.send('tavern:chat-stop')
  },
  chatRegenerate: (chatId: string, messageId: string, turn: number): void => {
    ipcRenderer.send('tavern:chat-regenerate', { chatId, messageId, turn })
  },
  /** 重发一条悬空的用户消息（崩溃 / 强退后这一轮没有回复） */
  chatResend: (chatId: string, messageId: string, turn: number): void => {
    ipcRenderer.send('tavern:chat-resend', { chatId, messageId, turn })
  },
  chatEdit: (messageId: string, content: string): Promise<unknown> =>
    ipcRenderer.invoke('tavern:chat-edit', { messageId, content }),
  chatDelete: (messageId: string): Promise<void> =>
    ipcRenderer.invoke('tavern:chat-delete', messageId),
  chatBranch: (chatId: string, messageId: string): Promise<unknown> =>
    ipcRenderer.invoke('tavern:chat-branch', { chatId, messageId }),
  // 群聊（T8）：建群 / 左栏列表；发言人事件在正文 token 之前到，界面据此另起一条
  groupCreate: (memberIds: string[], name = ''): Promise<unknown> =>
    ipcRenderer.invoke('tavern:group-create', { memberIds, name }),
  groupsList: (): Promise<unknown> => ipcRenderer.invoke('tavern:groups-list'),
  onSpeaker: (
    callback: (data: { chatId: string; turn: number; index: number; name: string }) => void
  ): void => {
    ipcRenderer.on(
      'tavern:speaker',
      (_event, data: { chatId: string; turn: number; index: number; name: string }) =>
        callback(data)
    )
  },
  onToken: (callback: (data: { chatId: string; delta: string; turn: number }) => void): void => {
    ipcRenderer.on('tavern:token', (_event, data: { chatId: string; delta: string; turn: number }) =>
      callback(data)
    )
  },
  onDone: (
    callback: (data: { chatId: string; messageId: string | null; turn: number }) => void
  ): void => {
    ipcRenderer.on(
      'tavern:done',
      (_event, data: { chatId: string; messageId: string | null; turn: number }) => callback(data)
    )
  },
  onError: (callback: (data: { chatId: string; message: string; turn: number }) => void): void => {
    ipcRenderer.on(
      'tavern:error',
      (_event, data: { chatId: string; message: string; turn: number }) => callback(data)
    )
  },

  // 记忆三层（T3）：永久记忆 / 忆境典藏 / 记忆设置
  memorySettings: (): Promise<unknown> => ipcRenderer.invoke('tavern:memory-settings'),
  memorySettingsSet: (patch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('tavern:memory-settings-set', patch),
  memoriesList: (characterId: string): Promise<unknown> =>
    ipcRenderer.invoke('tavern:memories-list', characterId),
  memoriesUpdate: (id: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke('tavern:memories-update', { id, content }),
  memoriesDelete: (id: string): Promise<void> => ipcRenderer.invoke('tavern:memories-delete', id),
  summaryGet: (chatId: string): Promise<unknown> => ipcRenderer.invoke('tavern:summary-get', chatId),
  summaryRefresh: (chatId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('tavern:summary-refresh', chatId),
  summaryUpdate: (id: string, raw: string): Promise<boolean> =>
    ipcRenderer.invoke('tavern:summary-update', { id, raw }),
  summaryDelete: (id: string): Promise<void> => ipcRenderer.invoke('tavern:summary-delete', id),
  onSummary: (callback: (data: { chatId: string; active: boolean }) => void): void => {
    ipcRenderer.on('tavern:summary', (_event, data: { chatId: string; active: boolean }) =>
      callback(data)
    )
  },

  // 提示词工具（T4）：世界书 / 正则 / 预设 / 文风 / 回复设置 / 状态栏 / 变量
  promptSettings: (): Promise<unknown> => ipcRenderer.invoke('tavern:prompt-settings'),
  promptSettingsSet: (patch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('tavern:prompt-settings-set', patch),
  stylesList: (): Promise<unknown> => ipcRenderer.invoke('tavern:styles-list'),
  stylesAdd: (input: { name: string; content: string }): Promise<string> =>
    ipcRenderer.invoke('tavern:styles-add', input),
  stylesDelete: (id: string): Promise<void> => ipcRenderer.invoke('tavern:styles-delete', id),

  lorebooksList: (scope?: string, ownerId?: string): Promise<unknown> =>
    ipcRenderer.invoke('tavern:lorebooks-list', scope, ownerId),
  lorebooksCreate: (input: unknown): Promise<string> =>
    ipcRenderer.invoke('tavern:lorebooks-create', input),
  lorebooksDelete: (id: string): Promise<void> => ipcRenderer.invoke('tavern:lorebooks-delete', id),
  lorebooksEnable: (id: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('tavern:lorebooks-enable', id, enabled),
  lorebookEntries: (bookId: string): Promise<unknown> =>
    ipcRenderer.invoke('tavern:lorebook-entries', bookId),
  lorebookEntrySave: (bookId: string, entry: unknown): Promise<string> =>
    ipcRenderer.invoke('tavern:lorebook-entry-save', { bookId, entry }),
  lorebookEntryDelete: (id: string): Promise<void> =>
    ipcRenderer.invoke('tavern:lorebook-entry-delete', id),
  lorebookImport: (target: unknown): Promise<unknown> =>
    ipcRenderer.invoke('tavern:lorebook-import', target),
  lorebookExport: (id: string, name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('tavern:lorebook-export', id, name),
  cardLore: (characterId: string): Promise<unknown> =>
    ipcRenderer.invoke('tavern:card-lore', characterId),
  cardLoreSaveAs: (payload: unknown): Promise<string> =>
    ipcRenderer.invoke('tavern:card-lore-save-as', payload),
  cardLoreEntrySave: (characterId: string, entry: unknown): Promise<string> =>
    ipcRenderer.invoke('tavern:card-lore-entry-save', { characterId, entry }),
  cardLoreEntryDelete: (characterId: string, entryId: string): Promise<boolean> =>
    ipcRenderer.invoke('tavern:card-lore-entry-delete', { characterId, entryId }),
  cardRegexSave: (characterId: string, rule: unknown): Promise<string> =>
    ipcRenderer.invoke('tavern:card-regex-save', { characterId, rule }),
  cardRegexDelete: (characterId: string, ruleId: string): Promise<boolean> =>
    ipcRenderer.invoke('tavern:card-regex-delete', { characterId, ruleId }),

  regexList: (scope: 'global' | 'character', characterId?: string): Promise<unknown> =>
    ipcRenderer.invoke('tavern:regex-list', scope, characterId),
  regexSave: (input: unknown, characterId?: string | null): Promise<string> =>
    ipcRenderer.invoke('tavern:regex-save', { input, characterId }),
  regexDelete: (id: string): Promise<void> => ipcRenderer.invoke('tavern:regex-delete', id),
  regexTest: (rule: unknown, text: string): Promise<unknown> =>
    ipcRenderer.invoke('tavern:regex-test', { rule, text }),
  regexAll: (characterId: string | null): Promise<unknown> =>
    ipcRenderer.invoke('tavern:regex-all', { characterId }),
  regexPreview: (
    characterId: string | null,
    text: string,
    target: 'display' | 'prompt'
  ): Promise<unknown> => ipcRenderer.invoke('tavern:regex-preview', { characterId, text, target }),

  presetsList: (): Promise<unknown> => ipcRenderer.invoke('tavern:presets-list'),
  presetsGet: (id: string): Promise<unknown> => ipcRenderer.invoke('tavern:presets-get', id),
  presetsSave: (payload: unknown): Promise<string> =>
    ipcRenderer.invoke('tavern:presets-save', payload),
  presetsDelete: (id: string): Promise<void> => ipcRenderer.invoke('tavern:presets-delete', id),
  presetsActiveSet: (id: string | null): Promise<void> =>
    ipcRenderer.invoke('tavern:presets-active-set', id),
  presetsImport: (): Promise<unknown> => ipcRenderer.invoke('tavern:presets-import'),
  presetsExport: (id: string, name: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('tavern:presets-export', id, name),
  chatPresetSet: (chatId: string, presetId: string | null): Promise<void> =>
    ipcRenderer.invoke('tavern:chat-preset-set', { chatId, presetId }),
  // 这场会话用哪个模型（flash / pro）：简单卡用 flash，复杂卡（几百条世界书 + 变量系统）用 pro
  chatModelGet: (chatId: string): Promise<{ model: string; options: string[] }> =>
    ipcRenderer.invoke('tavern:chat-model-get', chatId),
  chatModelSet: (chatId: string, model: string | null): Promise<string> =>
    ipcRenderer.invoke('tavern:chat-model-set', { chatId, model }),
  // 这场会话的回复上限：复杂卡（模型每轮输出整页 HTML 状态栏）要调高才写得完
  chatMaxTokensGet: (chatId: string): Promise<{ value: number; options: number[] }> =>
    ipcRenderer.invoke('tavern:chat-max-tokens-get', chatId),
  chatMaxTokensSet: (chatId: string, value: number | null): Promise<number> =>
    ipcRenderer.invoke('tavern:chat-max-tokens-set', { chatId, value }),

  debugGet: (chatId: string): Promise<unknown> => ipcRenderer.invoke('tavern:debug-get', chatId),
  alternativesGet: (chatId: string): Promise<string[]> =>
    ipcRenderer.invoke('tavern:alternatives-get', chatId),
  variablesGet: (chatId: string): Promise<unknown> =>
    ipcRenderer.invoke('tavern:variables-get', chatId),
  statusGet: (chatId: string): Promise<unknown> => ipcRenderer.invoke('tavern:status-get', chatId),
  /** 卡自带状态栏页面要的数据包：消息楼层 / 变量 / 世界书（见 main/tavern/runtime.ts） */
  runtimeGet: (chatId: string): Promise<unknown> => ipcRenderer.invoke('tavern:runtime-get', chatId),
  variablesSet: (chatId: string, state: unknown): Promise<void> =>
    ipcRenderer.invoke('tavern:variables-set', { chatId, state }),
  variablesClear: (chatId: string): Promise<void> =>
    ipcRenderer.invoke('tavern:variables-clear', chatId),
  // 卡里的状态页按钮要复制文本：沙箱 iframe 与非焦点文档都写不了剪贴板，
  // 统一转到主进程（不受焦点 / 安全上下文限制）
  clipboardWrite: (text: string): Promise<void> =>
    ipcRenderer.invoke('tavern:clipboard-write', text),
  onVariables: (callback: (data: { chatId: string; lines: string[] }) => void): void => {
    ipcRenderer.on('tavern:variables', (_event, data: { chatId: string; lines: string[] }) =>
      callback(data)
    )
  },
  onAlternatives: (callback: (data: { chatId: string; items: string[] }) => void): void => {
    ipcRenderer.on('tavern:alternatives', (_event, data: { chatId: string; items: string[] }) =>
      callback(data)
    )
  },

  // 外观与通用设置（T5）：主题 / 字体 / 背景 / 三色 / 朗读 / 背景音乐
  appearanceGet: (): Promise<unknown> => ipcRenderer.invoke('tavern:appearance-get'),
  appearanceSet: (patch: unknown): Promise<unknown> =>
    ipcRenderer.invoke('tavern:appearance-set', patch),
  appearanceMediaPick: (kind: 'image' | 'audio'): Promise<string | null> =>
    ipcRenderer.invoke('tavern:appearance-media-pick', kind),
  appearanceMediaRemove: (name: string): Promise<void> =>
    ipcRenderer.invoke('tavern:appearance-media-remove', name),
  /** 其它窗口改了外观：鲸鱼娘的小窗靠它即时换主题 / 字体 */
  onAppearance: (callback: (settings: unknown) => void): void => {
    ipcRenderer.on('tavern:appearance', (_event, settings: unknown) => callback(settings))
  },
  // 酒馆回复朗读（T5）：与桌宠同一套 TTS，通道独立，避免和鲸鱼娘那条流串声
  onTts: (
    callback: (data: { chatId: string; audio: string; mime: string; more: boolean }) => void
  ): void => {
    ipcRenderer.on(
      'tavern:tts',
      (_event, data: { chatId: string; audio: string; mime: string; more: boolean }) =>
        callback(data)
    )
  },
  onTtsEnd: (callback: (data: { chatId: string }) => void): void => {
    ipcRenderer.on('tavern:tts-end', (_event, data: { chatId: string }) => callback(data))
  },
  onTtsStop: (callback: (data: { chatId: string }) => void): void => {
    ipcRenderer.on('tavern:tts-stop', (_event, data: { chatId: string }) => callback(data))
  },

  // 鲸鱼娘旁观（T7）：观战开关 / 问答 / 灵感 / 角色卡助手
  spectatorGet: (chatId: string): Promise<unknown> =>
    ipcRenderer.invoke('tavern:spectator-get', chatId),
  spectatorSet: (chatId: string, enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('tavern:spectator-set', { chatId, enabled }),
  spectatorAsk: (payload: {
    chatId: string
    question: string
    mode?: 'ask' | 'idea'
  }): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('tavern:spectator-ask', payload),
  onSpectatorToken: (
    callback: (data: { chatId: string; gen: number; delta: string }) => void
  ): void => {
    ipcRenderer.on(
      'tavern:spectator-token',
      (_event, data: { chatId: string; gen: number; delta: string }) => callback(data)
    )
  },
  onSpectatorDone: (
    callback: (data: { chatId: string; gen: number; text: string }) => void
  ): void => {
    ipcRenderer.on(
      'tavern:spectator-done',
      (_event, data: { chatId: string; gen: number; text: string }) => callback(data)
    )
  },
  onSpectatorError: (
    callback: (data: { chatId: string; gen: number; error: string }) => void
  ): void => {
    ipcRenderer.on(
      'tavern:spectator-error',
      (_event, data: { chatId: string; gen: number; error: string }) => callback(data)
    )
  },
  cardAssistantAsk: (payload: {
    characterId: string
    question: string
  }): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('tavern:card-assistant-ask', payload),
  onCardAssistantToken: (
    callback: (data: { characterId: string; gen: number; delta: string }) => void
  ): void => {
    ipcRenderer.on(
      'tavern:card-assistant-token',
      (_event, data: { characterId: string; gen: number; delta: string }) => callback(data)
    )
  },
  onCardAssistantDone: (
    callback: (data: { characterId: string; gen: number; text: string }) => void
  ): void => {
    ipcRenderer.on(
      'tavern:card-assistant-done',
      (_event, data: { characterId: string; gen: number; text: string }) => callback(data)
    )
  },
  onCardAssistantError: (
    callback: (data: { characterId: string; gen: number; error: string }) => void
  ): void => {
    ipcRenderer.on(
      'tavern:card-assistant-error',
      (_event, data: { characterId: string; gen: number; error: string }) => callback(data)
    )
  },
  /** 体检：读全量卡数据，返回问题清单（每条可能带可执行的 fix） */
  cardAssistantDiagnose: (
    characterId: string
  ): Promise<{ ok: boolean; issues?: CardIssue[]; error?: string }> =>
    ipcRenderer.invoke('tavern:card-assistant-diagnose', { characterId }),
  /** 应用一条修复：主进程会先校验再写回卡 */
  cardAssistantFix: (
    characterId: string,
    fix: CardFix
  ): Promise<{ ok: boolean; applied?: CardFix; error?: string }> =>
    ipcRenderer.invoke('tavern:card-assistant-fix', { characterId, fix }),

  // 打磨与发布（T9）：备份 / 恢复、首次引导记号、关于
  backupExport: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('tavern:backup-export'),
  /** 导入成功后应用会自己重启（旧连接里的数据不能热替换）；开发模式下只能手动重跑 */
  backupImport: (): Promise<{ ok: boolean; restart?: 'auto' | 'manual'; error?: string }> =>
    ipcRenderer.invoke('tavern:backup-import'),
  onboardingGet: (): Promise<{
    firstRunDone: boolean
    greetShown: boolean
    cardCount: number
  }> => ipcRenderer.invoke('tavern:onboarding-get'),
  onboardingSet: (patch: {
    firstRunDone?: boolean
    greetShown?: boolean
  }): Promise<{ firstRunDone: boolean; greetShown: boolean; cardCount: number }> =>
    ipcRenderer.invoke('tavern:onboarding-set', patch),
  aboutGet: (): Promise<{ version: string; electron: string }> =>
    ipcRenderer.invoke('tavern:about-get'),

  // 使用说明窗口与桌宠侧是同一页
  openHelp: (): void => {
    ipcRenderer.send('tavern:help-open')
  }
})

// 全局鼠标事件（主进程 uiohook 转发）：右键与全局移动，坐标为 DIP
contextBridge.exposeInMainWorld('petMouse', {
  onGlobalDown: (callback: (p: { x: number; y: number }) => void): void => {
    ipcRenderer.on('mouse:global-down', (_event, p: { x: number; y: number }) => callback(p))
  },
  onGlobalUp: (callback: (p: { x: number; y: number }) => void): void => {
    ipcRenderer.on('mouse:global-up', (_event, p: { x: number; y: number }) => callback(p))
  },
  onGlobalMove: (callback: (p: { x: number; y: number }) => void): void => {
    ipcRenderer.on('mouse:global-move', (_event, p: { x: number; y: number }) => callback(p))
  }
})
