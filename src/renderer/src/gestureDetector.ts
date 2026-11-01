// 左键手势判定（右键走全局钩子，不在这里）：
//   快速点按 → 单击；连续点击达阈值 → 翻白眼；
//   按住不动达阈值 → 拖拽起；按住后划动路程超阈值 → 抚摸。
// 纯逻辑，不依赖 DOM / PixiJS，时间参数用单调毫秒（performance.now()），可直接单测。

export interface GestureOptions {
  /** 按住多久进入拖拽起（ms），默认 1000 */
  dragHoldMs: number
  /** 按住后累计划动多少路程算抚摸（px），默认 60 */
  petPathThreshold: number
  /** 连续点击多少次触发翻白眼，默认 20 */
  rapidClickCount: number
  /** 连击间隔窗口（ms），超过则计数清零，默认 600 */
  rapidClickMs: number
  /** 抚摸期间音符粒子的触发间隔（ms），默认 250 */
  petTickMs: number
}

const DEFAULT_OPTIONS: GestureOptions = {
  dragHoldMs: 1000,
  petPathThreshold: 60,
  rapidClickCount: 20,
  rapidClickMs: 600,
  petTickMs: 250
}

export interface GestureCallbacks {
  /** 单击（未达连击阈值时每次点击触发） */
  onClick?: () => void
  /** 连续点击达到阈值（翻白眼） */
  onRapidClicks?: () => void
  onDragStart?: () => void
  /** 拖动中的相对位移（screen px），由调用方合并后发送 */
  onDragMove?: (dx: number, dy: number) => void
  onDragEnd?: () => void
  onPetStart?: () => void
  /** 抚摸期间按 petTickMs 节流触发 */
  onPetTick?: () => void
  onPetEnd?: () => void
}

type Phase = 'idle' | 'pressed' | 'drag' | 'pet'

/**
 * 判定依据「路径长度」而非净位移：
 * - 按住不动 1s → 拖拽；
 * - 按住后划动累计路程超阈值 → 抚摸（净位移可能很小，来回划也能触发）。
 */
export class GestureDetector {
  private readonly cb: GestureCallbacks
  private readonly opt: GestureOptions

  private phase: Phase = 'idle'
  private startT = 0
  private hasStart = false
  private baseX = 0
  private baseY = 0
  private lastX = 0
  private lastY = 0

  private pathLen = 0
  private nextPetTickAt = 0

  private clickCount = 0
  private lastClickT = 0

  constructor(callbacks: GestureCallbacks, options: Partial<GestureOptions> = {}) {
    this.cb = callbacks
    this.opt = { ...DEFAULT_OPTIONS, ...options }
  }

  get isDragging(): boolean {
    return this.phase === 'drag'
  }

  get isPetting(): boolean {
    return this.phase === 'pet'
  }

  get isPressed(): boolean {
    return this.phase !== 'idle'
  }

  /** 当前连续点击计数（调试/展示用） */
  get rapidClickProgress(): number {
    return this.clickCount
  }

  pointerDown(t: number): void {
    this.phase = 'pressed'
    this.startT = t
    this.hasStart = false
    this.pathLen = 0
    this.nextPetTickAt = 0
  }

  pointerMove(t: number, x: number, y: number): void {
    if (this.phase === 'idle') return

    if (!this.hasStart) {
      // 首次移动建立基准点（与按下时的窗口位置对齐，避免首帧跳变）
      this.baseX = x
      this.baseY = y
      this.lastX = x
      this.lastY = y
      this.hasStart = true
      return
    }

    const dx = x - this.lastX
    const dy = y - this.lastY
    this.lastX = x
    this.lastY = y

    if (this.phase === 'drag') {
      this.cb.onDragMove?.(dx, dy)
      return
    }
    if (this.phase === 'pet') return

    // phase === 'pressed'：累计路径长度，按路程/时长分类
    this.pathLen += Math.hypot(dx, dy)
    if (this.pathLen >= this.opt.petPathThreshold) {
      this.enterPet(t)
      return
    }
    if (t - this.startT >= this.opt.dragHoldMs) {
      this.enterDrag(dx, dy)
    }
  }

  pointerUp(t: number): void {
    if (this.phase === 'drag') {
      this.endDrag()
      return
    }
    if (this.phase === 'pet') {
      this.endPet()
      return
    }
    if (this.phase !== 'pressed') return

    this.phase = 'idle'

    // 按住够久且几乎没划动（没有 update/move 驱动到时）也按拖拽处理
    if (t - this.startT >= this.opt.dragHoldMs && this.pathLen < this.opt.petPathThreshold) {
      this.cb.onDragStart?.()
      this.cb.onDragEnd?.()
      return
    }

    this.registerClick(t)
  }

  pointerCancel(): void {
    if (this.phase === 'drag') this.endDrag()
    else if (this.phase === 'pet') this.endPet()
    else this.phase = 'idle'
  }

  /** 每帧调用：驱动按住不动判定、抚摸节流、连击超时清零。 */
  update(t: number): void {
    if (
      this.phase === 'pressed' &&
      t - this.startT >= this.opt.dragHoldMs &&
      this.pathLen < this.opt.petPathThreshold
    ) {
      this.enterDrag(0, 0)
    }

    if (this.phase === 'pet' && t >= this.nextPetTickAt) {
      this.cb.onPetTick?.()
      this.nextPetTickAt = t + this.opt.petTickMs
    }

    if (this.clickCount > 0 && t - this.lastClickT > this.opt.rapidClickMs) {
      this.clickCount = 0
    }
  }

  /** 翻白眼播完后重置连击计数（由渲染层调用） */
  resetRapidClicks(): void {
    this.clickCount = 0
    this.lastClickT = 0
  }

  private registerClick(t: number): void {
    if (t - this.lastClickT > this.opt.rapidClickMs) this.clickCount = 0
    this.clickCount++
    this.lastClickT = t

    if (this.clickCount >= this.opt.rapidClickCount) {
      this.clickCount = 0
      this.lastClickT = 0
      this.cb.onRapidClicks?.()
      return
    }
    this.cb.onClick?.()
  }

  private enterDrag(dx: number, dy: number): void {
    this.phase = 'drag'
    this.cb.onDragStart?.()
    this.cb.onDragMove?.(dx, dy)
  }

  private enterPet(t: number): void {
    this.phase = 'pet'
    this.nextPetTickAt = t + this.opt.petTickMs
    this.cb.onPetStart?.()
  }

  private endDrag(): void {
    this.phase = 'idle'
    this.cb.onDragEnd?.()
  }

  private endPet(): void {
    this.phase = 'idle'
    this.cb.onPetEnd?.()
  }
}
