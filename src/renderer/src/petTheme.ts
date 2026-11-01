// 鲸鱼娘的小窗（配置 / 记忆 / 提醒 / 输入栏）跟随酒馆的深浅主题与字体。
// 颜色一律走 --pet-* 变量：这些窗子里全是内联样式，只有变量能一次改全。
// 变量的默认值就是原来的深色配色，所以没读到设置时画面与改动前完全一致。

interface PetThemeSource {
  theme?: string
  font?: string
}

const FONT_STACKS: Record<string, string> = {
  system: 'system-ui, "Microsoft YaHei", sans-serif',
  round: '"YouYuan", "幼圆", "Yuanti SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif'
}

const DARK: Record<string, string> = {
  '--pet-bg': '#1e1e24',
  '--pet-fg': '#e8e8ee',
  '--pet-text': '#e8eef8',
  '--pet-muted': '#8d93a6',
  '--pet-faint': '#7b869c',
  '--pet-dim': '#6f7a90',
  '--pet-label': '#b6bccb',
  '--pet-label-alt': '#b6c0d4',
  '--pet-input-bg': '#151821',
  '--pet-border': '#3a4560',
  '--pet-border-focus': '#5b8ae0',
  '--pet-accent': '#4a7dff',
  '--pet-on-accent': '#fff',
  '--pet-divider': '#2b2f3a',
  '--pet-card': '#252a35',
  '--pet-chip-bg': '#2f3a52',
  '--pet-chip-fg': '#9db8e6',
  '--pet-toggle-bg': '#2b3346',
  '--pet-scrollbar': '#3a4256',
  '--pet-scrollbar-hover': '#4a5470',
  '--pet-danger': '#e88',
  '--pet-danger-soft': '#ff9f9f',
  '--pet-recording': '#ff6b6b',
  '--pet-link': '#7ea6e0',
  '--pet-warn': '#e0a35b',
  '--pet-bar-bg': 'rgba(30,34,44,.96)',
  '--pet-bar-border': 'rgba(120,170,230,.45)'
}

const LIGHT: Record<string, string> = {
  '--pet-bg': '#f4f6fa',
  '--pet-fg': '#1f2a38',
  '--pet-text': '#1f2a38',
  '--pet-muted': '#5f6b7f',
  '--pet-faint': '#6b7688',
  '--pet-dim': '#7a8496',
  '--pet-label': '#43506a',
  '--pet-label-alt': '#5a6880',
  '--pet-input-bg': '#ffffff',
  '--pet-border': '#ccd6e6',
  '--pet-border-focus': '#3f6fe0',
  '--pet-accent': '#3f6fe0',
  '--pet-on-accent': '#fff',
  '--pet-divider': '#dde3ee',
  '--pet-card': '#ffffff',
  '--pet-chip-bg': '#e3eaf6',
  '--pet-chip-fg': '#2f5da8',
  '--pet-toggle-bg': '#e3eaf6',
  '--pet-scrollbar': '#c6d0de',
  '--pet-scrollbar-hover': '#b2bccd',
  '--pet-danger': '#d24a4a',
  '--pet-danger-soft': '#d24a4a',
  '--pet-recording': '#d24a4a',
  '--pet-link': '#2f6cc4',
  '--pet-warn': '#b9742a',
  '--pet-bar-bg': 'rgba(255,255,255,.96)',
  '--pet-bar-border': 'rgba(90,130,200,.45)'
}

export function applyPetTheme(theme: string, font: string): void {
  const palette = theme === 'light' ? LIGHT : DARK
  const style = document.documentElement.style
  for (const [key, value] of Object.entries(palette)) style.setProperty(key, value)
  style.setProperty('--pet-font', FONT_STACKS[font === 'round' ? 'round' : 'system'])
  document.documentElement.dataset['theme'] = theme === 'light' ? 'light' : 'dark'
}

/** 拉一次外观并应用，之后跟着酒馆里的改动走；读不到就保持深色 */
export async function initPetTheme(): Promise<void> {
  const apply = (settings: PetThemeSource | null): void => {
    applyPetTheme(settings?.theme ?? 'dark', settings?.font ?? 'system')
  }
  try {
    apply((await window.tavern.appearanceGet()) as PetThemeSource | null)
  } catch {
    apply(null)
  }
  try {
    window.tavern.onAppearance((settings) => apply(settings as PetThemeSource))
  } catch {
    // 老窗口不该因为没有这个通道就打不开
  }
}
