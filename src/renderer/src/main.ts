import { Application, Container } from 'pixi.js'
import { Animator } from './animator'
import { FALLBACK_GROUP, PetCore } from './petCore'
import { GestureDetector } from './gestureDetector'
import { ParticleLayer } from './particleLayer'
import { RiceBowl } from './riceBowl'
import { ChatBubble } from './chatBubble'
import { VoicePlayer } from './voicePlayer'
import { renderChatInput } from './chatInput'
import { renderChatConfig } from './chatConfig'
import { renderHelpPage } from './helpPage'
import { renderMemoryPage } from './memoryPage'
import { renderReminderPage } from './reminderPage'
import { initPetTheme } from './petTheme'
import { renderTavernShell } from './tavern/shell'
import { Affection, localDateString } from './affection'
import hitmasks from '../../../assets/hitmask.json'
import manifest from '../../../assets/manifest.json'

// 动作预览面板的按钮文案（仅 UI 标签，动画组名仍以 manifest 为准）
const GROUP_LABELS: Record<string, string> = {
  idle_normal: '待机',
  idle_blink: '眨眼',
  idle_yawn: '打哈欠',
  idle_done: '翻白眼',
  idle_stretch: '伸懒腰',
  idle_scratch: '挠头',
  idle_zone: '发呆',
  idle_mumble: '嘀咕',
  talk_normal: '说话',
  happy_normal: '开心',
  happy_pet: '抚摸',
  swim_normal: '游动',
  swim_enter: '游动·进',
  swim_exit: '游动·出',
  sad_normal: '失落',
  drag_enter: '拖拽·起',
  drag_normal: '拖拽',
  drag_exit: '拖拽·放',
  eat_enter: '进食·进',
  eat_normal: '进食·期待',
  eat_exit: '进食·吃',
  sleep_enter: '睡觉·进',
  sleep_normal: '睡觉',
  sleep_exit: '睡觉·醒',
  awake_enter: '觉醒·起',
  awake_normal: '觉醒',
  awake_exit: '觉醒·退'
}

// 情绪 → 动画组。angry / surprised / shy / smug 的专属素材还没做，
// 先用神态最接近的现有组占位（翻白眼 = 不满/得意，发呆 = 愣住，挠头 = 不好意思），
// 素材落地后只改这张表，不用碰别处。
const EMOTION_GROUPS: Record<string, string> = {
  happy: 'happy_normal',
  sad: 'sad_normal',
  angry: 'angry_normal',
  surprised: 'surprised_normal',
  shy: 'shy_normal',
  smug: 'smug_normal'
}

const WIDTH = 300
// 窗口比角色高 120px，头顶留给气泡；角色仍贴底显示（与主进程 BrowserWindow 尺寸一致）
const HEIGHT = 420
const PET_SCALE = 0.56
const CANVAS = 512 // 素材画幅，pivot 用脚底中心

// 角色占位：素材角色高约 441 输出像素，缩放后约 247px
const PET_HEIGHT_PX = 441 * PET_SCALE
const PET_BOTTOM = HEIGHT - 8
const PET_CENTER_X = WIDTH / 2
// 视觉中心（拖拽对齐 / 游动目标点用），比窗口几何中心更贴近角色实体
const PET_CENTER_Y = PET_BOTTOM - PET_HEIGHT_PX / 2
const PET_HEAD_TOP = PET_BOTTOM - PET_HEIGHT_PX
// 嘴的高度（喂饭时饭落在这里）
const PET_MOUTH_Y = PET_HEAD_TOP + 85
// 气泡底边挂在头顶上方 24px（behavior.md 第六节）
const BUBBLE_ANCHOR_Y = PET_HEAD_TOP - 24

// 面向翻转的中线死区，防止光标在中线上左右抖动导致角色来回翻转
const FACING_DEADZONE = 8

// 右键单击/双击的确认窗口
const RIGHT_DOUBLE_MS = 300
const RIGHT_DOUBLE_DIST = 40

// 游动：每 16ms 的最大步长、到达判定、跟随停靠判定
const SWIM_STEP_PX = 10
const SWIM_ARRIVE_PX = 10
const FOLLOW_STOP_PX = 24

// 好感度增减（behavior.md 第二节）
const AFFECTION_ON_CLICK = 1
const AFFECTION_ON_PET = 2
const AFFECTION_ON_FEED = 3

// 投喂：饭落到嘴边；eat_enter 只有 0.4s，期待态（eat_normal 循环）自己掐 1.8s 再开吃，
// 收尾时播 eat_exit（饭筷入镜→进食→站姿，约 9.4s）
const FEED_EXPECT_MS = 1800
const FEED_LINE = '咕噜……好吃！我记住这个味道了，存进——啊不是，记在心里！'

// 觉醒彩蛋：流结束后保持凝视多久再退回 idle
const AWAKE_HOLD_MS = 6000
// talk 最短展示时长：回复很短时也至少说这一会儿，否则 1-2 帧就回待机，肉眼看不到
const MIN_TALK_MS = 1200

// 待机随机动作池（behavior.md 的 6 项）。翻白眼 idle_done 是独立反应，不放进随机池。
const IDLE_ACTIONS = ['idle_blink', 'idle_yawn', 'idle_stretch', 'idle_scratch', 'idle_zone', 'idle_mumble']

// 点击命中掩码：每组逐帧一张 MASK_SIZE×MASK_SIZE 位图（1 bit/像素），数组下标与 manifest 帧序一致。
// 掩码比素材画幅小（128 vs 512）：这里只判「点在不在鱼身上」，精度够了，
// 按画幅存是 820 帧 × 32KB ≈ 35MB，配置窗这类根本不用掩码的窗口也得跟着解析一遍。
const MASK_SIZE = 128
const MASK_SCALE = CANVAS / MASK_SIZE
const MASKS: Record<string, Uint8Array[]> = Object.fromEntries(
  Object.entries(hitmasks as Record<string, string[]>).map(([group, frames]) => [
    group,
    frames.map((base64) => {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes
    })
  ])
)

function hitTest(pet: Container, animator: Animator, x: number, y: number): boolean {
  const mask = MASKS[animator.currentGroup]?.[animator.currentFrameIndex]
  if (!mask) return true // 无掩码的组退化为整窗可点，避免完全点不到
  const point = pet.toLocal({ x, y })
  const px = Math.floor(point.x / MASK_SCALE)
  const py = Math.floor(point.y / MASK_SCALE)
  if (px < 0 || py < 0 || px >= MASK_SIZE || py >= MASK_SIZE) return false
  const bit = py * MASK_SIZE + px
  return (mask[bit >> 3] & (1 << (7 - (bit & 7)))) !== 0
}

interface InteractionContext {
  pet: Container
  animator: Animator
  petCore: PetCore
  particles: ParticleLayer
  riceBowl: RiceBowl
  affection: Affection
  /** 好感度变化后落盘 */
  persistAffection: () => void
  /** 她说话（投喂台词）：渲染层负责别顶掉正在进行的一轮回复 */
  say: (text: string) => void
}

/**
 * 统一交互接线：
 * - 左键（窗口 pointer + hitmask）：单击 / 20 连击翻白眼 / 按住 1s 拖拽 / 划动抚摸；
 * - 右键（主进程全局钩子）：单击鱼切换游动，屏幕单击跟随、双击游到该点；
 * - swim 移动：goto 游到目标点、follow 跟随鼠标。
 * 判定逻辑在 GestureDetector（纯逻辑可单测），这里只做 DOM/PixiJS 适配。
 */
function setupInteraction(ctx: InteractionContext): {
  tick: (deltaMs: number) => void
  tickSwim: (deltaMs: number) => void
  getFacing: () => number
  feed: () => void
} {
  const { pet, animator, petCore, particles, riceBowl, affection } = ctx

  let cursorX = PET_CENTER_X
  let cursorY = PET_CENTER_Y
  let globalX = 0
  let globalY = 0
  let facing = 1
  // drag_enter 期间是否已锁定光标（播完 / 拖拽结束 / 被打断时解锁）
  let dragCursorLocked = false

  // ---- 点击穿透：指针落在角色像素上时关闭穿透，否则整窗穿透 ----
  let interactive = false
  const setInteractive = (next: boolean): void => {
    if (next === interactive) return
    interactive = next
    window.petWindow.setIgnoreMouse(!next)
  }

  // ---- 拖动位移：每帧最多发一次 IPC，合并一帧内的多次 pointermove ----
  let pendingDx = 0
  let pendingDy = 0
  let rafId: number | null = null

  const flush = (): void => {
    rafId = null
    if (pendingDx !== 0 || pendingDy !== 0) {
      window.petWindow.moveBy(pendingDx, pendingDy)
      pendingDx = 0
      pendingDy = 0
    }
  }
  const flushNow = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    flush()
  }

  const addAffection = (delta: number): void => {
    const changed = affection.add(delta, localDateString(new Date()))
    if (changed !== 0) ctx.persistAffection()
  }

  // ---- 大白饭：每次中间游动状态只出现一碗，碰到鱼后散射消失 ----
  let bowlEaten = false
  const spawnBowl = (): void => {
    bowlEaten = false
  }
  const eatBowl = (x: number, y: number): void => {
    if (bowlEaten) return
    bowlEaten = true
    riceBowl.hide()
    particles.burst('rice', x, y, 16)
  }
  // ---- 投喂：饭从头顶落到嘴边 → 她期待一会儿 → 开吃 ----
  // eat 的优先级是 0（最低），只有她闲着或睡着时才喂得进去；游动、说话、被拖时她顾不上
  let feeding = false
  let feedElapsed = 0

  const startFeeding = (): void => {
    if (feeding || petCore.isReacting) return
    const state = petCore.currentState
    if (state !== 'idle' && state !== 'sad' && state !== 'sleep') return
    feeding = true
    feedElapsed = 0
    riceBowl.dropAt(PET_CENTER_X, PET_MOUTH_Y)
  }

  const stopFeeding = (): void => {
    feeding = false
    feedElapsed = 0
    riceBowl.hide()
  }

  // 落碗：投喂时开吃（接着由 tickFeed 推进），游动中则落地即被吃掉（散射 + 消失）
  riceBowl.onLanded = () => {
    if (!feeding) {
      eatBowl(PET_CENTER_X, PET_CENTER_Y)
      return
    }
    petCore.handle('FEED')
  }

  /**
   * 投喂推进：等真正进入 eat 持续态才开始倒计时——睡着时喂她，FEED 会先播 sleep_exit
   * （揉眼→站姿）再进 eat，按固定时长掐会在她还没张嘴时就收尾。
   */
  const tickFeed = (deltaMs: number): void => {
    if (!feeding) return
    const state = petCore.currentState
    const eating = state === 'eat'
    // 饭还在往下掉时她本来就还是 idle/sad/sleep，不能把它们当成「她走开了」——
    // 第一帧就撤掉，碗根本来不及出现（实测「点喂饭毫无反应」就是这么来的）
    const stillThere = state === 'idle' || state === 'sad' || state === 'sleep'
    // 被点（happy）、被拖、被搭话（talk）或游走了：这顿饭作废，饭留在桌上更奇怪
    if (!eating && !stillThere) {
      stopFeeding()
      return
    }
    if (!eating || petCore.segmentPhase !== 'normal') return
    feedElapsed += deltaMs
    if (feedElapsed < FEED_EXPECT_MS) return
    // 吃下去：饭消失 + 米粒 / 爱心 + 好感度，再收尾播 eat_exit（饭筷入镜→进食→站姿）
    stopFeeding()
    particles.burst('rice', PET_CENTER_X, PET_MOUTH_Y, 12)
    particles.burst('heart', PET_CENTER_X, PET_MOUTH_Y - 20, 8)
    addAffection(AFFECTION_ON_FEED)
    petCore.handle('ANIM_COMPLETE')
    ctx.say(FEED_LINE)
  }

  const detector = new GestureDetector({
    onClick: () => {
      petCore.handle('CLICK')
      addAffection(AFFECTION_ON_CLICK)
      particles.burst('star', cursorX, cursorY, 8)
    },
    onRapidClicks: () => {
      // 连续点击：翻白眼吐槽（反应期间锁定，播完计数重置）
      petCore.playReaction('idle_done')
      particles.burst('star', cursorX, cursorY, 12)
    },
    onDragStart: () => {
      // 抓起：窗口瞬间对齐鼠标，让鱼“套住”光标；drag_enter 播完后才跟手
      const winX = window.screenX
      const winY = window.screenY
      window.petWindow.moveBy(globalX - (winX + PET_CENTER_X), globalY - (winY + PET_CENTER_Y))
      // drag_enter 期间把光标也锁在原位，播完（drag_normal）才解锁跟手
      window.petWindow.lockCursor(globalX, globalY)
      dragCursorLocked = true
      pet.cursor = 'grabbing'
      petCore.handle('DRAG_START')
    },
    onDragMove: (dx, dy) => {
      // 只有 drag_normal（持续态）才跟手：drag_enter 期间锁定，且从 sleep/swim 起拖时
      // 退出段（sleep_exit 可达 4s）里也不动窗口，否则鱼还在播睡觉退出就跟着鼠标跑
      if (petCore.currentState !== 'drag' || petCore.segmentPhase !== 'normal') return
      pendingDx += dx
      pendingDy += dy
      if (rafId === null) rafId = requestAnimationFrame(flush)
    },
    onDragEnd: () => {
      pet.cursor = 'grab'
      petCore.handle('DRAG_END')
      flushNow()
    },
    onPetStart: () => {
      petCore.handle('PET')
      addAffection(AFFECTION_ON_PET)
      particles.burst('note', cursorX, cursorY, 6)
    },
    onPetTick: () => {
      // 持续抚摸期间保持开心状态
      petCore.handle('PET')
      particles.burst('note', cursorX, cursorY, 3)
    }
  })

  // 翻白眼播完 → 连击计数重置
  petCore.onReactionComplete = () => detector.resetRapidClicks()

  // ---- 左键指针事件（只收左键；右键交给全局钩子） ----
  pet.on('pointerdown', (event) => {
    if (event.button !== 0) return
    if (petCore.isReacting) return // 反应期间锁定输入：不启动任何手势
    detector.pointerDown(performance.now())
  })

  window.addEventListener('pointermove', (event) => {
    if (!detector.isPressed) return
    // 自愈：鼠标已松开却没收到 pointerup（如松手时指针在窗口外）
    if (event.buttons === 0) {
      detector.pointerCancel()
      return
    }
    // 用 screenX/screenY（DIP 绝对坐标）：拖动时窗口随鼠标移动，
    // client 坐标会被窗口位移抵消，算不出真实位移
    detector.pointerMove(performance.now(), event.screenX, event.screenY)
  })

  window.addEventListener('pointerup', (event) => {
    // 与 pointerdown 对齐：只收左键，避免右键释放误结束手势 / 误报点击
    if (event.button !== 0) return
    detector.pointerUp(performance.now())
  })
  window.addEventListener('pointercancel', () => detector.pointerCancel())
  window.addEventListener('blur', () => detector.pointerCancel())

  // ---- 窗口内光标移动：穿透判定 + 面向 + 抚摸离开鱼身即结束 ----
  window.addEventListener('mousemove', (event) => {
    cursorX = event.clientX
    cursorY = event.clientY

    const onPet = hitTest(pet, animator, event.clientX, event.clientY)
    // 手势进行中（含按住未达阈值）始终可交互：否则按住后划到透明区会开启穿透，
    // 窗口收不到 pointerup，手势卡死——1s 后还会误触发拖拽起，窗口瞬移到光标。
    if (detector.isPressed) setInteractive(true)
    else setInteractive(onPet)

    // 抚摸要求鼠标不离开鱼身：一旦落在透明区域就取消
    if (detector.isPetting && !onPet) detector.pointerCancel()

    // 睡眠中鼠标一动就醒；只在持续态触发，避免 sleep_exit 播放期间被快进
    if (petCore.currentState === 'sleep' && petCore.segmentPhase === 'normal') {
      petCore.handle('WAKE')
    }

    if (!petCore.isSwimming) {
      const dx = event.clientX - PET_CENTER_X
      if (dx < -FACING_DEADZONE) facing = 1
      else if (dx > FACING_DEADZONE) facing = -1
    }
  })

  window.addEventListener('mouseleave', () => {
    // 同上：手势未结束时不能开穿透，否则松手事件会丢
    if (!detector.isPressed) setInteractive(false)
  })

  // ---- 右键：全局钩子转发（DIP 屏幕坐标） ----
  let pendingRight: { x: number; y: number; t: number } | null = null
  let pendingRightTimer: number | null = null

  const clearPendingRight = (): void => {
    if (pendingRightTimer !== null) {
      window.clearTimeout(pendingRightTimer)
      pendingRightTimer = null
    }
    pendingRight = null
  }

  const ensureSwimming = (): void => {
    if (petCore.currentState === 'idle') {
      petCore.handle('SWIM_START')
      bowlEaten = false
      riceBowl.hide()
    }
  }

  // 屏幕右键只在已进入初始游动（swim_normal 持续态）后才响应
  const canScreenSwim = (): boolean =>
    petCore.currentState === 'swim' && petCore.segmentPhase === 'normal'

  const onRightClickAt = (gx: number, gy: number): void => {
    const localX = gx - window.screenX
    const localY = gy - window.screenY
    const onPet = hitTest(pet, animator, localX, localY)

    if (onPet) {
      clearPendingRight()
      // 鱼身上：进入 / 终止游动（终止优先级最高，随时可用）
      if (petCore.currentState === 'swim') {
        petCore.handle('SWIM_STOP')
        bowlEaten = false
        riceBowl.hide()
      } else {
        ensureSwimming()
      }
      return
    }

    // 屏幕其它位置（除鱼）：必须先右键单击鱼进入初始游动，否则无任何反应
    if (!canScreenSwim()) {
      clearPendingRight()
      return
    }

    const now = performance.now()
    if (
      pendingRight !== null &&
      now - pendingRight.t <= RIGHT_DOUBLE_MS &&
      Math.hypot(gx - pendingRight.x, gy - pendingRight.y) <= RIGHT_DOUBLE_DIST
    ) {
      // 类型一：游到该点（双击）
      clearPendingRight()
      spawnBowl()
      petCore.swimGoto(gx, gy)
      return
    }

    clearPendingRight()
    pendingRight = { x: gx, y: gy, t: now }
    pendingRightTimer = window.setTimeout(() => {
      pendingRightTimer = null
      pendingRight = null
      // 等待双击确认期间可能已退出游动，复检
      if (!canScreenSwim()) return
      // 类型二：跟随鼠标（单击）
      spawnBowl()
      petCore.swimFollow()
    }, RIGHT_DOUBLE_MS)
  }

  window.petMouse.onGlobalDown((p) => {
    globalX = p.x
    globalY = p.y
  })
  window.petMouse.onGlobalUp((p) => {
    globalX = p.x
    globalY = p.y
    onRightClickAt(p.x, p.y)
  })
  window.petMouse.onGlobalMove((p) => {
    globalX = p.x
    globalY = p.y
  })

  // ---- 游动移动：goto 游到目标、follow 跟随鼠标 ----
  const tickSwim = (deltaMs: number): void => {
    if (!petCore.isSwimming || petCore.segmentPhase !== 'normal') return
    const mode = petCore.currentSwimMode
    if (mode === 'idle') return

    const cx = window.screenX + PET_CENTER_X
    const cy = window.screenY + PET_CENTER_Y

    let tx: number
    let ty: number
    let stopPx: number

    if (mode === 'goto') {
      const target = petCore.currentSwimTarget
      if (!target) return
      tx = target.x
      ty = target.y
      stopPx = SWIM_ARRIVE_PX
    } else {
      tx = globalX
      ty = globalY
      stopPx = FOLLOW_STOP_PX
    }

    const dist = Math.hypot(tx - cx, ty - cy)

    if (dist <= stopPx) {
      if (mode === 'goto') {
        // 到达目标点：原地游动 + 大白饭落地（落碗后由 onLanded 吃掉：散射 + 消失）
        petCore.swimArrived()
        riceBowl.dropAt(PET_CENTER_X, PET_CENTER_Y)
      } else {
        // 追上鼠标：停在原地（保持 follow，鼠标离开会自动继续）；吃掉大白饭
        eatBowl(PET_CENTER_X, PET_CENTER_Y)
      }
      return
    }

    const step = Math.min((SWIM_STEP_PX * deltaMs) / 16, dist)
    const dx = ((tx - cx) / dist) * step
    const dy = ((ty - cy) / dist) * step
    window.petWindow.moveBy(dx, dy)

    if (dx < -0.5) facing = 1
    else if (dx > 0.5) facing = -1

    // 类型二：大白饭粘在鼠标上（窗口内坐标；鼠标在窗口外时暂不显示）
    // 一碗只出现一次：被吃掉后不再复现
    if (mode === 'follow' && !bowlEaten) {
      const mx = globalX - window.screenX
      const my = globalY - window.screenY
      if (mx >= 0 && mx <= WIDTH && my >= 0 && my <= HEIGHT) {
        riceBowl.showAt(mx, my)
      } else if (riceBowl.isVisible) {
        riceBowl.hide()
      }
    }
  }

  return {
    tick: (deltaMs: number): void => {
      detector.update(performance.now())
      tickFeed(deltaMs)
      // drag_enter 播完 / 拖拽结束 / 被打断 → 解锁光标
      if (
        dragCursorLocked &&
        !(petCore.currentState === 'drag' && petCore.segmentPhase === 'enter')
      ) {
        window.petWindow.unlockCursor()
        dragCursorLocked = false
      }
    },
    tickSwim,
    getFacing: (): number => facing,
    feed: startFeeding
  }
}

/**
 * 开发期动作预览面板：与桌宠共用同一渲染入口（hash=#dashboard），
 * 只渲染按钮，不初始化 PixiJS。点击按钮经主进程转发给桌宠窗口。
 */
function renderDashboard(): void {
  const app = document.querySelector<HTMLDivElement>('#app')
  if (!app) return
  document.body.style.cssText = 'background:#1e1e24;color:#e8e8ee'
  app.style.cssText =
    'display:flex;flex-wrap:wrap;align-items:center;align-content:center;' +
    'gap:6px;height:100%;padding:0 12px;box-sizing:border-box;' +
    'font:13px system-ui,sans-serif;-webkit-app-region:drag'

  const title = document.createElement('span')
  title.textContent = '动作预览'
  title.style.cssText = 'opacity:.7;margin-right:6px;white-space:nowrap'
  app.appendChild(title)

  const buttons: HTMLButtonElement[] = []
  const paint = (active: HTMLButtonElement | null): void => {
    for (const b of buttons) {
      b.style.background = b === active ? '#4a7dff' : '#33333d'
      b.style.color = b === active ? '#fff' : '#c9c9d4'
    }
  }
  const addButton = (label: string, onClick: () => void): HTMLButtonElement => {
    const button = document.createElement('button')
    button.textContent = label
    button.style.cssText =
      'background:#33333d;color:#c9c9d4;border:0;border-radius:6px;padding:7px 12px;' +
      'font:13px system-ui,sans-serif;cursor:pointer;white-space:nowrap;-webkit-app-region:no-drag;' +
      'transition:background .15s'
    button.onclick = (): void => onClick()
    app.appendChild(button)
    buttons.push(button)
    return button
  }

  // 「自动」放最前：恢复状态机自动运行（idle / 随机动作 / 闲置睡觉）
  const autoButton = addButton('自动', () => {
    window.petWindow.setAutoPlay(true)
    paint(autoButton)
  })

  for (const group of Object.keys(manifest.groups)) {
    const button = addButton(GROUP_LABELS[group] ?? group, () => {
      window.petWindow.playGroup(group)
      paint(button)
    })
  }

  paint(autoButton)
}

async function main(): Promise<void> {
  if (location.hash === '#dashboard') {
    renderDashboard()
    return
  }
  // 独立小窗不用桌宠那个画布容器。它占满一屏高，留着会把后面追加的 UI 整个挤出窗口
  // （配置窗 / 输入栏之所以看起来正常，只是因为里面的输入框自动聚焦、浏览器把页面滚下去了；
  // 手账没有输入框抢焦点，于是整页停在窗口下方，一片空白）
  if (
    location.hash === '#chat-input' ||
    location.hash === '#config' ||
    location.hash === '#memory' ||
    location.hash === '#reminders' ||
    location.hash === '#help' ||
    location.hash === '#tavern'
  ) {
    document.getElementById('app')?.remove()
  }
  // 小窗跟随酒馆的深浅主题 / 字体（酒馆窗口自己在 shell 里应用）
  const smallWindow =
    location.hash === '#chat-input' ||
    location.hash === '#config' ||
    location.hash === '#memory' ||
    location.hash === '#reminders' ||
    location.hash === '#help'
  if (smallWindow) await initPetTheme()
  if (location.hash === '#chat-input') {
    renderChatInput()
    return
  }
  if (location.hash === '#config') {
    await renderChatConfig()
    return
  }
  if (location.hash === '#memory') {
    await renderMemoryPage()
    return
  }
  if (location.hash === '#reminders') {
    await renderReminderPage()
    return
  }
  if (location.hash === '#help') {
    renderHelpPage()
    return
  }
  if (location.hash === '#tavern') {
    await renderTavernShell()
    return
  }

  const app = new Application()
  // backgroundAlpha: 0 → WebGL 画布透明，露出桌面
  await app.init({
    width: WIDTH,
    height: HEIGHT,
    backgroundAlpha: 0,
    antialias: true
  })

  const container = document.querySelector<HTMLDivElement>('#app')
  if (!container) throw new Error('#app 容器不存在')
  container.appendChild(app.canvas)

  // 只预加载待机组：其余 26 组按需加载、超预算回收（全量常驻约 820MB 纹理）
  const animator = await Animator.create([FALLBACK_GROUP])
  const pet = animator.view
  pet.pivot.set(CANVAS / 2, CANVAS) // 锚点：画幅中心 + 底边（脚底）
  pet.scale.set(PET_SCALE)
  pet.position.set(WIDTH / 2, PET_BOTTOM)
  pet.eventMode = 'static' // 让宠物参与命中测试，接收 pointerdown
  pet.cursor = 'grab'
  app.stage.addChild(pet)

  // 粒子层与大白饭占位挂在角色之上
  const particles = new ParticleLayer()
  app.stage.addChild(particles.view)
  const riceBowl = new RiceBowl()
  app.stage.addChild(riceBowl.view)

  // 聊天气泡在最上层，原点在底边中心，挂在鱼头顶上方
  const chatBubble = new ChatBubble(PET_CENTER_X, BUBBLE_ANCHOR_Y)
  app.stage.addChild(chatBubble.view)

  // 好感度：读本地存档 + 启动时结算每日冷落
  const stored = await window.petStore.getAffection()
  const affection = new Affection(stored.affection, stored.lastActiveDate)
  const today = localDateString(new Date())
  const decay = affection.applyDailyDecay(today)
  const persistAffection = (): void => window.petStore.setAffection(affection.storeData)
  if (decay !== 0 || stored.lastActiveDate !== affection.storeData.lastActiveDate) persistAffection()

  const petCore = new PetCore(animator, IDLE_ACTIONS)

  // ---- 聊天接线：流式 token → 气泡 + talk；彩蛋 → awake ----
  // 彩蛋信号先于首个 token 到达，此时不能切 talk（talk 优先级更高会顶掉觉醒），
  // 等流结束后让 awake 保持一小段时间再收尾。
  // talk 的生命周期跟「气泡打完字」而不是网络流结束：DeepSeek 常在几百毫秒内
  // 就把整段回复推完，若按流结束立刻 CHAT_END，talk 只播 1-2 帧，肉眼看不到。
  let replyStarted = false
  let metaPending = false
  let awaitingChatEnd = false
  let talkStartedAt = 0
  let awakeExitTimer: number | null = null

  const scheduleAwakeExit = (): void => {
    if (awakeExitTimer !== null) window.clearTimeout(awakeExitTimer)
    awakeExitTimer = window.setTimeout(() => {
      awakeExitTimer = null
      petCore.endAwake()
    }, AWAKE_HOLD_MS)
  }

  // 语音：主进程边生成边念，一轮回复会分几段陆续下发；打断 / 新发言时整队清空。
  // talk 要一直撑到全部念完，所以还要记「后面还会不会有语音」和「语音到了但表情没演完」两种状态。
  const voice = new VoicePlayer()
  let ttsPending = false // 后面还有语音会来（合成中）
  let pendingAudio: { audio: string; mime: string }[] = [] // 语音先到了，但表情还没演完，攒着
  window.chat.onTts(({ audio, mime, more }) => {
    // more 是主进程算出来的「后面还有没有」：不能只看 isPlaying——
    // 第一段播完时后面那几段还在合成，直接收尾会让说话动作中途断掉
    ttsPending = more === true
    // 表情要完整演一遍，演完再开口：语音到得早也不抢它的戏
    if (petCore.isReacting) pendingAudio.push({ audio, mime })
    else voice.enqueue(audio, mime)
  })
  window.chat.onTtsEnd(() => {
    // 「不会再有语音了」：后面剩下的交给 voice.isPlaying 判断
    ttsPending = false
  })
  window.chat.onTtsStop(() => {
    // 「别等了」的唯一信号：新发言 / 打断 / 关朗读 / 这一轮出错
    ttsPending = false
    pendingAudio = []
    voice.stop()
  })

  // 情绪：比首个 token 先到，先存着，等开口那一刻再插表情——此刻她还在 idle/swim，
  // 立刻播会被紧接着的 CHAT_START 顶掉。表情播完自动接回 talk_normal，气泡照常打字。
  let pendingEmotion: string | null = null
  window.chat.onEmotion(({ emotion }) => {
    pendingEmotion = EMOTION_GROUPS[emotion] ?? null
  })

  window.chat.onMeta(() => {
    metaPending = true
    petCore.handle('META_TRIGGER')
  })

  window.chat.onToken(({ delta }) => {
    if (!replyStarted) {
      replyStarted = true
      awaitingChatEnd = false
      ttsPending = false // 新一轮：上一轮的语音等待作废
      chatBubble.clear()
      if (!metaPending) {
        petCore.handle('CHAT_START')
        talkStartedAt = performance.now()
      } else {
        // 觉醒不需要表情（整段都在凝视）
        pendingEmotion = null
      }
    }
    chatBubble.append(delta)
  })

  window.chat.onDone((data) => {
    const started = replyStarted
    replyStarted = false
    if (metaPending) {
      metaPending = false
      ttsPending = false
      scheduleAwakeExit()
      return
    }
    // 这一轮一个 token 都没到（主动消息失败 / 空回复）：清掉可能残留的情绪并直接收手。
    // 她其实从没开口，不该进入「等收尾」状态——否则会在睡眠里被当成有一轮话要说。
    if (!started) {
      pendingEmotion = null
      return
    }
    // 被新一条发言顶掉：新一轮的首个 token 紧接着就到，此刻收尾会让说话动作闪一下 idle。
    // 把最短展示时长重新起算，用 1.2s 当交接窗口；新 token 到了会更早取消这次等待，
    // 万一新请求迟迟不响应，也只是退回「到点照常收尾」，不会卡死在 talk。
    if (data?.replaced) {
      awaitingChatEnd = true
      ttsPending = false
      talkStartedAt = performance.now()
      return
    }
    // 网络流结束不代表话说完了：等打字机打完、满足最短展示时长、且语音念完后回 idle
    awaitingChatEnd = true
    ttsPending = data?.tts === true
  })

  window.chat.onError(({ message }) => {
    replyStarted = false
    metaPending = false
    awaitingChatEnd = false
    pendingEmotion = null
    ttsPending = false
    pendingAudio = []
    petCore.handle('CHAT_END')
    // 彩蛋触发后请求失败时，awake 不会收到 CHAT_END，必须靠定时器收尾，否则会一直凝视
    scheduleAwakeExit()
    chatBubble.show(message)
  })

  // 投喂台词：正在聊天的这一轮别被顶掉（气泡只有一份）
  const say = (text: string): void => {
    if (replyStarted || awaitingChatEnd) return
    chatBubble.show(text)
  }

  const interaction = setupInteraction({
    pet,
    animator,
    petCore,
    particles,
    riceBowl,
    affection,
    persistAffection,
    say
  })

  // 托盘 / 输入栏的「喂饭」：主进程转发到桌宠窗口
  window.petWindow.onFeed(() => interaction.feed())

  app.ticker.add((ticker) => {
    const deltaMs = ticker.deltaMS
    const talkBefore = petCore.currentState
    const wasReacting = petCore.isReacting
    petCore.update(deltaMs)
    particles.update(deltaMs)
    riceBowl.update(deltaMs)
    chatBubble.update(deltaMs)
    interaction.tick(deltaMs)

    // 情绪表情：等真的进了 talk 再插。CHAT_START 遇到 sleep/swim/awake 时只起播退出段，
    // 这一刻 state 还没变，直接插会被状态机拒绝，表情就白白丢了。
    if (pendingEmotion && petCore.currentState === 'talk' && !petCore.isReacting) {
      const group = pendingEmotion
      pendingEmotion = null
      petCore.playReaction(group)
    }

    // 表情演完了、攒着的语音可以开口了（顺序在 CHAT_END 判断之前：
    // 表情结束这一帧就得让声音接上，否则会被判成「没在念」直接回 idle）
    if (pendingAudio.length > 0 && !petCore.isReacting) {
      for (const { audio, mime } of pendingAudio) voice.enqueue(audio, mime)
      pendingAudio = []
    }

    // 刚真正进入 talk：最短展示时长从这一刻起算。
    // 不能沿用 CHAT_START 的时刻——从睡眠/游动醒来要先播退出段（sleep_exit 可达 4 秒），
    // 等真正开口时 MIN_TALK_MS 早就到点了，talk 会在第一帧就被收尾。
    if (talkBefore !== 'talk' && petCore.currentState === 'talk') {
      talkStartedAt = performance.now()
    }

    // 表情刚演完：说话动作这才真正露面，最短展示时长同样要从此刻重新起算。
    // playReaction 不改变 currentState（全程都是 talk），上面那条「进入 talk」捕捉不到这一刻，
    // 于是 6s 的表情把时间占满，表情一结束 talk 就被判成「早该结束了」——说话动画一帧都不露。
    if (wasReacting && !petCore.isReacting && petCore.currentState === 'talk') {
      talkStartedAt = performance.now()
    }

    // 话打完了 + 真的在 talk + 表情演完 + 达到最短展示时长 + 语音念完 → 结束 talk
    if (
      awaitingChatEnd &&
      petCore.currentState === 'talk' &&
      !chatBubble.isTyping &&
      !petCore.isReacting && // 表情没演完不许收尾：收尾会在表情结束那一帧把 talk 抹掉
      !ttsPending &&
      pendingAudio.length === 0 &&
      !voice.isPlaying &&
      performance.now() - talkStartedAt >= MIN_TALK_MS
    ) {
      awaitingChatEnd = false
      petCore.handle('CHAT_END')
    }

    // 缩放单一写入点：游动时按朝向翻转，其余保持基准（呼吸由素材本身承担）
    if (petCore.currentState === 'swim') {
      pet.scale.set(interaction.getFacing() * PET_SCALE, PET_SCALE)
    } else {
      pet.scale.set(PET_SCALE)
    }

    interaction.tickSwim(deltaMs)
  })

  // 预览面板选择动作时暂停状态机、直接播放单组；点「自动」恢复状态机
  window.petWindow.onPlayGroup((group) => {
    petCore.setActive(false)
    animator.play(group)
  })
  window.petWindow.onSetAutoPlay((enabled) => petCore.setActive(enabled))
}

void main()
