// 窗口位置持久化（userData/window.json）+ 屏幕变化时把鱼捞回来。
// 与 pet-store.json 同款 tmp/rename 原子写；文件损坏就当没有记录，回默认落点。
import { app, screen, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cornerPosition, isVisibleOn, resolvePosition, type Point, type Rect } from './windowPlacement'

const VERSION = 1
/** 拖动会连续触发 moved，攒一下再写盘 */
const SAVE_DEBOUNCE_MS = 400

interface WindowState {
  version: number
  position: Point | null
}

function statePath(): string {
  return join(app.getPath('userData'), 'window.json')
}

function loadState(): WindowState {
  const file = statePath()
  try {
    if (!existsSync(file)) return { version: VERSION, position: null }
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<WindowState>
    const p = raw.position
    const position =
      p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: Math.round(p.x), y: Math.round(p.y) } : null
    return { version: VERSION, position }
  } catch {
    return { version: VERSION, position: null }
  }
}

function saveState(position: Point): void {
  const file = statePath()
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify({ version: VERSION, position }, null, 2), 'utf-8')
    renameSync(tmp, file)
  } catch (error) {
    console.error('[windowState] 写入失败', error)
  }
}

/** 所有屏幕的工作区（排除任务栏区域，免得鱼被任务栏压住） */
function workAreas(): Rect[] {
  return screen.getAllDisplays().map((display) => display.workArea)
}

function primaryWorkArea(): Rect {
  return screen.getPrimaryDisplay().workArea
}

/** 建窗时调用：把窗口摆到上次的位置（或主屏右下角）。 */
export function restoreWindowPosition(win: BrowserWindow): void {
  const { width, height } = win.getBounds()
  const pos = resolvePosition(loadState().position, { width, height }, workAreas(), primaryWorkArea())
  win.setPosition(pos.x, pos.y)
}

/** 记下用户拖到哪了。 */
export function trackWindowPosition(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const save = (): void => {
    timer = null
    const [x, y] = win.getPosition()
    saveState({ x, y })
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, SAVE_DEBOUNCE_MS)
  }
  // 两个都听：Windows 拖拽过程中只发 move，程序 setPosition 也走 move；
  // macOS 的 moved 是「拖完了」那一下。去抖负责把重复的合并成一次写入。
  win.on('move', schedule)
  win.on('moved', schedule)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    if (!win.isDestroyed()) save()
  })
}

/**
 * 显示器被拔掉 / 主屏换了：窗口可能整个落在那块已经不存在的屏幕上。
 * Electron 不会自动搬，只能自己检查一次。
 */
export function watchDisplays(getWindow: () => BrowserWindow | null): void {
  screen.on('display-removed', () => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    const bounds = win.getBounds()
    if (isVisibleOn(bounds, workAreas())) return
    const pos = cornerPosition(bounds, primaryWorkArea())
    win.setPosition(pos.x, pos.y)
  })
}
