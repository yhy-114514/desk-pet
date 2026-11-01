// T5：把外观设置落到 DOM 上——主题、字体、三色、气泡、聊天背景、背景音乐。
// 只读写 CSS 变量与少量 class，改一处配色不会散落在各页面。
import { avatarUrl } from './ui'

export type Appearance = Awaited<ReturnType<Window['tavern']['appearanceGet']>>
export type AppearanceTab = 'background' | 'bubble' | 'general'

/** 字体只用系统栈：打包字体动辄十几 MB，还要处理授权 */
export const FONT_STACKS: Record<Appearance['font'], string> = {
  system: 'system-ui, "Microsoft YaHei", sans-serif',
  round: '"YouYuan", "幼圆", "Yuanti SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif'
}

/** media/ 下的文件 → 可访问地址（背景图 / 音乐） */
export function mediaUrl(fileName: string): string {
  return `tavern-media://local/${encodeURIComponent(fileName)}`
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'dark',
  font: 'system',
  background: { mode: 'default', image: null, dim: 45 },
  bubble: {
    opacity: 0.85,
    fontSize: 14,
    narrationColor: '#dce8f7',
    dialogueColor: '#ffc6ce',
    actionColor: '#9fd8e8'
  },
  ttsEnabled: false,
  bgm: { enabled: false, volume: 0.5, track: null }
}

/**
 * 主题 / 字体 / 三色 / 气泡统一挂在 html 上：
 * 酒馆与鲸鱼娘的小窗是不同窗口，但都用同一套 CSS 变量名（--pet-* 的小窗见 petTheme.ts）。
 */
/** 浅色主题下的默认三色：默认值是给深色底调的，浅底上直接看不见 */
const LIGHT_COLORS = { narration: '#1f2a38', dialogue: '#a8404f', action: '#1f6f85' }

export function applyAppearance(settings: Appearance): void {
  const root = document.documentElement
  root.dataset['theme'] = settings.theme
  root.dataset['tavernFont'] = settings.font
  const style = root.style
  style.setProperty('--font-stack', FONT_STACKS[settings.font])
  // 用户没改过颜色（仍是深色默认值）时，浅色主题换成对应的深字色；
  // 改过的颜色一律照用——那是用户自己的选择，不替他覆盖
  const adapt = (value: string, dark: string, light: string): string =>
    settings.theme === 'light' && value === dark ? light : value
  const bubble = settings.bubble
  style.setProperty(
    '--seg-narration',
    adapt(bubble.narrationColor, DEFAULT_APPEARANCE.bubble.narrationColor, LIGHT_COLORS.narration)
  )
  style.setProperty(
    '--seg-dialogue',
    adapt(bubble.dialogueColor, DEFAULT_APPEARANCE.bubble.dialogueColor, LIGHT_COLORS.dialogue)
  )
  style.setProperty(
    '--seg-action',
    adapt(bubble.actionColor, DEFAULT_APPEARANCE.bubble.actionColor, LIGHT_COLORS.action)
  )
  style.setProperty('--bubble-alpha', String(bubble.opacity))
  style.setProperty('--chat-font-size', `${bubble.fontSize}px`)
}

/**
 * 聊天正文区的背景。默认模式不设背景，露出 body 的深海渐变；
 * 跟随封面 / 自定义图片都用一层遮罩压下去，免得字压在图上看不清。
 */
export function applyFlowBackground(
  flow: HTMLElement,
  settings: Appearance,
  avatarPath: string | null
): void {
  const { mode, image, dim } = settings.background
  let url = ''
  if (mode === 'cover' && avatarPath) url = avatarUrl(avatarPath)
  else if (mode === 'custom' && image) url = mediaUrl(image)
  if (!url) {
    flow.style.backgroundImage = ''
    return
  }
  const alpha = Math.min(0.9, Math.max(0, dim / 100))
  const veil =
    settings.theme === 'light' ? `rgba(244,246,250,${alpha})` : `rgba(8,16,31,${alpha})`
  flow.style.backgroundImage = `linear-gradient(${veil}, ${veil}), url("${url}")`
  flow.style.backgroundSize = 'cover'
  flow.style.backgroundPosition = 'center'
}

/** 背景音乐：整窗一个 audio，循环播放；设置变了就换曲 / 调音量 */
export class BgmPlayer {
  private audio: HTMLAudioElement
  private track: string | null = null

  constructor() {
    this.audio = new Audio()
    this.audio.loop = true
  }

  apply(settings: Appearance): void {
    const track = settings.bgm.enabled ? settings.bgm.track : null
    if (track !== this.track) {
      this.track = track
      this.audio.pause()
      if (track) {
        this.audio.src = mediaUrl(track)
        this.audio.currentTime = 0
      } else {
        this.audio.removeAttribute('src')
      }
    }
    this.audio.volume = settings.bgm.volume
    if (track) {
      // 自动播放策略在主进程放开了（autoplay-policy），万一仍被拒就安静地不作声
      void this.audio.play().catch(() => {})
    }
  }

  pause(): void {
    this.audio.pause()
  }

  resume(): void {
    if (this.track) void this.audio.play().catch(() => {})
  }
}

/** 拉一次设置并应用；失败就按默认值渲染，不能让外观把页面搞崩 */
export async function loadAppearance(): Promise<Appearance> {
  try {
    const settings = await window.tavern.appearanceGet()
    return settings ?? DEFAULT_APPEARANCE
  } catch {
    return DEFAULT_APPEARANCE
  }
}
