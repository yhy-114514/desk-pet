// 聊天配置持久化：API Key 与模型写入 userData/config.json。
// 与 petStore.ts 同样的手写 JSON + tmp/rename 原子写；Key 只在主进程出现，
// chat:config-get 只回「是否已配置 + 模型」，明文 Key 绝不下发任何渲染进程。
import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_MODEL, MODEL_OPTIONS } from './persona'
import { EDGE_VOICES, QWEN_VOICES, TTS_VOICE, providerFor, providerOfVoice, voicesFor } from './speech'

const VERSION = 1

export interface ChatConfig {
  version: number
  apiKey: string
  model: string
  /** 朗读音色：含义随通道变（edge 是 zh-CN-*，千问是 Cherry 这类名字），见 speech.ts */
  voice: string
  /** 阿里云百炼（千问语音）的 Key；配了才有情绪朗读，空 = 只用免费的 Edge 普通朗读 */
  qwenKey: string
  /** 是否朗读她的回复（默认开，可在配置窗关掉） */
  ttsEnabled: boolean
  /** 是否允许她主动找我说话（默认开，可在配置窗关掉） */
  proactiveEnabled: boolean
}

const DEFAULT_CONFIG: ChatConfig = {
  version: VERSION,
  apiKey: '',
  model: DEFAULT_MODEL,
  voice: TTS_VOICE,
  qwenKey: '',
  ttsEnabled: true,
  proactiveEnabled: true
}

let cached: ChatConfig | null = null

/** 配置变化通知（托盘菜单要跟着勾选状态走）。配置只从主进程改，这里足够。 */
const saveListeners: Array<() => void> = []

export function onConfigSaved(listener: () => void): void {
  saveListeners.push(listener)
}

export function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function loadConfig(): ChatConfig {
  if (cached) return cached
  const file = configPath()
  try {
    if (!existsSync(file)) {
      cached = { ...DEFAULT_CONFIG }
      return cached
    }
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ChatConfig>
    cached = sanitize(raw)
  } catch {
    cached = { ...DEFAULT_CONFIG }
  }
  return cached
}

export function saveConfig(data: Partial<ChatConfig>): ChatConfig {
  cached = sanitize({ ...loadConfig(), ...data })
  const file = configPath()
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(cached, null, 2), 'utf-8')
    renameSync(tmp, file)
  } catch (error) {
    console.error('[chatConfig] 写入失败', error)
  }
  for (const listener of saveListeners) listener()
  return cached
}

export function hasKey(): boolean {
  return loadConfig().apiKey.trim().length > 0
}

function sanitize(raw: Partial<ChatConfig>): ChatConfig {
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
  const model =
    typeof raw.model === 'string' && (MODEL_OPTIONS as readonly string[]).includes(raw.model)
      ? raw.model
      : DEFAULT_MODEL
  const qwenKey = typeof raw.qwenKey === 'string' ? raw.qwenKey.trim() : ''
  // 两套音色名（Edge 的 zh-CN-* 与千问的 longan*）互不通用。只要在任意一套里就保留——
  // 用哪套由音色本身决定，不再跟着「有没有 Key」走，否则配了 Key 就切不回晓伊。
  // 完全不认识（旧配置 / 手改）才回落到默认通道的第一个音色。
  const voice =
    typeof raw.voice === 'string' && providerOfVoice(raw.voice) !== null
      ? raw.voice
      : voicesFor(providerFor(qwenKey.length > 0))[0].name
  const ttsEnabled = typeof raw.ttsEnabled === 'boolean' ? raw.ttsEnabled : DEFAULT_CONFIG.ttsEnabled
  const proactiveEnabled =
    typeof raw.proactiveEnabled === 'boolean'
      ? raw.proactiveEnabled
      : DEFAULT_CONFIG.proactiveEnabled
  return { version: VERSION, apiKey, model, voice, qwenKey, ttsEnabled, proactiveEnabled }
}

/**
 * 配置窗口读写通道（chat:config-get / chat:config-set）。
 * get 只回「是否已配置 + 模型」，不回明文 Key —— Key 始终留在主进程。
 */
export function registerConfigIpc(): void {
  ipcMain.handle('chat:config-get', () => {
    const config = loadConfig()
    // 当前音色属于哪套通道（不是「有没有 Key」）；配置窗据此显示「这条通道能不能带情绪」
    const provider = providerOfVoice(config.voice) ?? providerFor(config.qwenKey.length > 0)
    return {
      hasKey: hasKey(),
      model: config.model,
      voice: config.voice,
      // 音色名单由主进程给，配置窗不硬编码，加音色只改 speech.ts
      provider,
      // 两套音色都下发：配置窗里一填 Key 就要立刻切到千问音色，不该等保存重开才更新
      voices: [
        ...EDGE_VOICES.map((v) => ({ ...v, provider: 'edge' as const })),
        ...QWEN_VOICES.map((v) => ({ ...v, provider: 'qwen' as const }))
      ],
      // 千问 Key 也只回「有没有配」，明文同样不出主进程
      hasQwenKey: config.qwenKey.length > 0,
      ttsEnabled: config.ttsEnabled,
      proactiveEnabled: config.proactiveEnabled
    }
  })
  ipcMain.on('chat:config-set', (_event, data: Partial<ChatConfig>) => {
    saveConfig(data)
  })
}
