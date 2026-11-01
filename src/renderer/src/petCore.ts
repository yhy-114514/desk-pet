import type { Animator } from './animator'
import {
  type PetEvent,
  type PetState,
  type SegmentPhase,
  ONE_SHOT_STATES,
  SEGMENTED_STATES,
  advanceSegment,
  transition
} from './stateMachine'
import { RandomActionPool } from './randomActions'

// idle 闲置多久进入睡觉（behavior.md：3 分钟）
const IDLE_SLEEP_MS = 3 * 60 * 1000
// 待机时随机动作的插播间隔（30–60s，让待机更像真的在发呆，而不是按节拍表演）
const ACTION_MIN_MS = 30 * 1000
const ACTION_MAX_MS = 60 * 1000
// 组缺失时的兜底组（也是启动时唯一预加载的组）
export const FALLBACK_GROUP = 'idle_normal'
// 允许插播反应动画的状态（这些状态下没有进行中的一次性动作）
const REACTION_STATES = new Set<PetState>(['idle', 'swim', 'happy', 'talk'])

const randomBetween = (min: number, max: number): number => min + Math.random() * (max - min)

/**
 * 状态机 → Animator 的胶水层。
 * - 纯状态迁移委托给 stateMachine.transition；
 * - 分段状态（drag/eat/sleep/awake）负责 enter→normal→exit 三段衔接；
 * - idle 下驱动随机动作池与闲置计时。
 * 真实鼠标 / 聊天输入由 P3/P4 通过 handle(event) 接入。
 */
export class PetCore {
  private readonly animator: Animator
  private readonly pool: RandomActionPool

  private state: PetState = 'idle'
  private active = true

  // 游动模式：由渲染层按右键事件设置，PetCore 只持有、不驱动窗口
  private swimMode: 'idle' | 'goto' | 'follow' = 'idle'
  private swimTarget: { x: number; y: number } | null = null

  // 翻白眼等反应动画播放中：期间忽略输入，保证完整播完
  private reactionActive = false
  /** 反应动画播完回调（渲染层据此重置连击计数） */
  onReactionComplete?: () => void

  // happy 的两个变体：抚摸播 happy_pet（专属），单击播 happy_normal
  private happyGroup = 'happy_normal'

  private idleElapsed = 0
  private actionElapsed = 0
  private nextActionDelay = randomBetween(ACTION_MIN_MS, ACTION_MAX_MS)
  private insertingAction = false

  private phase: SegmentPhase = 'normal'
  private pendingState: PetState | null = null
  private oneShotRemaining = 0
  // awake 收尾请求早于进入段播完时挂起，等进入持续态再生效
  private endAwakeRequested = false
  // 收到的 CHAT_END 但此刻切不过去（反应未播完 / 分段退出段中），挂起等能切时再生效
  private pendingChatEnd = false
  // 反应的剩余时长（ms），归零即收尾
  private reactionRemaining = 0
  // 正按「整组时长」计时的组。首次播放要等图集按需加载，计时起点得等动画真的开播
  // （onGroupStart）再对齐，否则加载耗时会白吃一段表演
  private timedGroup: { name: string; kind: 'reaction' | 'oneShot' } | null = null
  /** timedGroup 是否已经真正开播；没开播之前不许倒数（图集可能还在解码） */
  private timedStarted = false

  constructor(animator: Animator, actionGroups: readonly string[]) {
    this.animator = animator
    this.pool = new RandomActionPool(actionGroups)
    animator.onComplete = () => this.onAnimComplete()
    animator.onGroupStart = (groupName) => this.onGroupStart(groupName)
    this.enterState('idle')
  }

  get currentState(): PetState {
    return this.state
  }

  /** 分段动作当前所处阶段（enter / normal / exit），供外部判断能否安全触发 WAKE 等事件。 */
  get segmentPhase(): SegmentPhase {
    return this.phase
  }

  get isSwimming(): boolean {
    return this.state === 'swim'
  }

  /** 翻白眼等反应动画播放中（期间忽略输入，保证完整播完） */
  get isReacting(): boolean {
    return this.reactionActive
  }

  /** 游动模式：idle 原地 / goto 游到目标点 / follow 跟随鼠标 */
  get currentSwimMode(): 'idle' | 'goto' | 'follow' {
    return this.swimMode
  }

  get currentSwimTarget(): { x: number; y: number } | null {
    return this.swimTarget
  }

  /** 类型一：游到指定目标点（仅游动状态生效） */
  swimGoto(x: number, y: number): void {
    if (this.state !== 'swim') return
    this.swimMode = 'goto'
    this.swimTarget = { x, y }
  }

  /** 类型二：跟随鼠标（仅游动状态生效） */
  swimFollow(): void {
    if (this.state !== 'swim') return
    this.swimMode = 'follow'
    this.swimTarget = null
  }

  /** 游到目标/追上鼠标后回到原地游动 */
  swimArrived(): void {
    if (this.state !== 'swim') return
    this.swimMode = 'idle'
    this.swimTarget = null
  }

  /** 外部输入入口（P3/P4 接鼠标、聊天等） */
  handle(event: PetEvent): void {
    // 新一轮对话开始了：上一轮挂起的收尾作废，避免旧 CHAT_END 把新一轮踢出 talk
    if (event === 'CHAT_START') this.pendingChatEnd = false
    // 收尾事件可能此刻切不过去：表情还没播完，或正处于分段退出段（state 仍是 sleep/swim/awake，
    // 拿 CHAT_END 去查迁移表查不到，直接丢掉就永久卡在 talk）。统一挂起，等状态允许时再补。
    if (event === 'CHAT_END') {
      this.pendingChatEnd = true
      this.tryChatEnd()
      return
    }
    // 翻白眼等反应播放期间不接受其它输入（唤醒除外），保证动作完整播完。
    // 但聊天开始必须放行：用户已经在说话了，翻白眼该让位——否则这一轮回复全程没有说话动画。
    if (this.reactionActive && event !== 'WAKE' && event !== 'CHAT_START') return
    // 抚摸优先播专属动画 happy_pet（素材未落地时回落 happy_normal）；单击用 happy_normal
    if (event === 'PET' && this.animator.groupNames.includes('happy_pet')) {
      this.happyGroup = 'happy_pet'
    } else if (event === 'CLICK') {
      this.happyGroup = 'happy_normal'
    }
    this.applyEvent(event)
  }

  /**
   * 插播一个反应动画（如双击吐槽的翻白眼），播完自动回到当前状态的循环组。
   * 只在待机/游动/说话这类「无进行中动作」的状态生效，避免与状态机自身的动作打架。
   * 注意：光标落在角色身上时通常处于 swim，因此必须允许 swim；
   * talk 也要允许——聊天时按回复情绪插一个表情，播完自动接回 talk_normal。
   */
  playReaction(groupName: string): void {
    if (!this.active || this.reactionActive) return
    if (!REACTION_STATES.has(this.state)) return
    // 分段状态的退出段播到一半时插播，收尾会 playStateLoop 从第 0 帧重播退出段（明显跳帧），不接
    if (SEGMENTED_STATES.has(this.state) && this.phase !== 'normal') return
    if (!this.animator.groupNames.includes(groupName)) return
    // 连击翻白眼：happy 一次性动画未播完即顶掉，取消其计时并归位 idle，
    // 避免 ANIM_COMPLETE 打断反应，也避免反应播完再回到 happy
    if (this.state === 'happy') {
      this.state = 'idle'
      this.oneShotRemaining = 0
    }
    this.insertingAction = true
    this.reactionActive = true
    // 整组时长计时收尾，不截断：循环组（happy_normal 6s / sad_normal 4s）永远等不到
    // onComplete，只靠 onAnimComplete 会让 reactionActive 永久为真，之后所有输入和说话全被吃掉；
    // 聊天里的情绪表情要完整演一遍再回到 talk，所以也不能像以前那样砍到 1.6s。
    // one-shot 组若先播完，走 onAnimComplete 的同一条收尾路径。
    this.reactionRemaining = this.animator.groupDuration(groupName)
    // 图集可能要现加载：真正开播时 onGroupStart 会把计时重置成整组时长
    this.trackTimed(groupName, 'reaction')
    this.animator.play(groupName)
  }

  /** 反应结束：回到当前状态的循环组（挂起的 CHAT_END 由 update 里的 tryChatEnd 补上）。 */
  private endReaction(): void {
    if (!this.reactionActive) return
    this.reactionActive = false
    this.insertingAction = false
    this.reactionRemaining = 0
    this.clearTimed()
    this.playStateLoop()
    this.onReactionComplete?.()
  }

  /** 挂起的 CHAT_END：等状态真的能切到 idle 时才生效（反应中 / 退出段播放中都先等）。 */
  private tryChatEnd(): void {
    if (!this.pendingChatEnd || this.reactionActive) return
    if (transition(this.state, 'CHAT_END') === this.state) return
    this.pendingChatEnd = false
    this.applyEvent('CHAT_END')
  }

  /**
   * 觉醒彩蛋收尾：awake_normal 是循环段，不会自己播完，
   * 由聊天流结束后的定时器调用，触发 exitState 播 awake_exit → idle。
   * 若定时器到点时还停在 awake_enter，先记一笔，进入持续态后立刻收尾。
   */
  endAwake(): void {
    if (this.state !== 'awake') return
    if (this.phase !== 'normal') {
      this.endAwakeRequested = true
      return
    }
    this.applyEvent('ANIM_COMPLETE')
  }

  /** 预览面板手动播放单组时暂停自动状态逻辑；恢复时回到 idle。 */
  setActive(active: boolean): void {
    this.active = active
    if (active) {
      // 预览期间反应动画可能没播完（onAnimComplete 在 inactive 时直接返回），
      // 恢复自动逻辑时清掉反应锁，否则输入会被永久忽略
      this.reactionActive = false
      this.enterState('idle')
    }
  }

  update(deltaMs: number): void {
    this.animator.update(deltaMs)
    if (!this.active) return

    // 图集还没到位时动画没上屏，这时候倒数等于白吃表演时长（加载慢过整组时长就会在动画出现前收尾）。
    // 加载失败后 Animator 不再报「正在加载」，照常倒数，免得把输入永久锁死
    const timed = this.timedGroup
    const waitingStart =
      timed !== null && !this.timedStarted && this.animator.isLoading(timed.name)

    // 反应按计时收尾（循环组不会自己播完）
    if (this.reactionActive && !waitingStart) {
      this.reactionRemaining -= deltaMs
      if (this.reactionRemaining <= 0) {
        this.endReaction()
      }
    }

    // 一次性状态（happy）：主循环组播一遍后结束
    if (this.oneShotRemaining > 0) {
      if (waitingStart) return
      this.oneShotRemaining -= deltaMs
      if (this.oneShotRemaining <= 0) {
        this.oneShotRemaining = 0
        this.clearTimed()
        this.applyEvent('ANIM_COMPLETE')
      }
      return
    }

    // 进入段期间收到的 awake 收尾请求：进入持续态后立刻补上
    if (this.endAwakeRequested && this.state === 'awake' && this.phase === 'normal') {
      this.endAwakeRequested = false
      this.applyEvent('ANIM_COMPLETE')
    }

    // 挂起的收尾：等状态迁移表允许（通常是退出段播完、真的进了 talk）再执行
    this.tryChatEnd()

    if (this.state === 'idle' && !this.insertingAction) {
      this.tickIdle(deltaMs)
    }
    // sleep 的唤醒由外部真实输入驱动（P3 起由渲染层在鼠标活动时发送 WAKE）
  }

  private tickIdle(deltaMs: number): void {
    this.idleElapsed += deltaMs
    this.actionElapsed += deltaMs

    if (this.idleElapsed >= IDLE_SLEEP_MS) {
      this.applyEvent('IDLE_TIMEOUT')
      return
    }

    if (this.actionElapsed >= this.nextActionDelay) {
      this.actionElapsed = 0
      this.nextActionDelay = randomBetween(ACTION_MIN_MS, ACTION_MAX_MS)
      const group = this.pool.pick()
      if (this.animator.groupNames.includes(group)) {
        this.insertingAction = true
        this.animator.play(group)
      }
    }
  }

  private applyEvent(event: PetEvent): void {
    const next = transition(this.state, event)
    if (next === this.state) return
    this.exitState(next)
  }

  private enterState(next: PetState): void {
    this.state = next
    this.idleElapsed = 0
    this.pendingState = null
    this.oneShotRemaining = 0
    this.clearTimed()
    this.insertingAction = false
    this.endAwakeRequested = false
    // 注意：不清 pendingChatEnd——它正是用来跨「退出段 → talk」这段迁移的
    // 进入任何新状态都清空游动模式/目标，避免残留到下一次游动
    this.swimMode = 'idle'
    this.swimTarget = null

    if (SEGMENTED_STATES.has(next)) {
      this.phase = 'enter'
      this.playGroup(`${next}_enter`)
      // 进入段有 1–2s，顺手把持续段预热好：否则 enter 播完会卡在末帧等图集解码
      this.animator.preload(`${next}_normal`)
      return
    }

    this.phase = 'normal'

    // happy 有两个变体：抚摸用 happy_pet，其余用 happy_normal
    if (next === 'happy') {
      this.playGroup(this.happyGroup)
      this.oneShotRemaining = this.animator.groupDuration(this.happyGroup)
      this.trackTimed(this.happyGroup, 'oneShot')
      this.happyGroup = 'happy_normal'
      return
    }

    this.playGroup(`${next}_normal`)

    if (ONE_SHOT_STATES.has(next)) {
      this.oneShotRemaining = this.animator.groupDuration(`${next}_normal`)
      this.trackTimed(`${next}_normal`, 'oneShot')
    }
  }

  private exitState(next: PetState): void {
    // 分段状态处于持续态时先播退出段，播完再进 next；进入中被打断则直接切
    if (SEGMENTED_STATES.has(this.state) && this.phase === 'normal') {
      this.pendingState = next
      this.phase = 'exit'
      this.playGroup(`${this.state}_exit`)
      return
    }
    this.enterState(next)
  }

  /**
   * 动画真正开播的回调：按整组时长计时的组（反应 / 一次性动作）在这里把计时起点对齐到此刻。
   * 图集按需加载时，play() 可能比真正开播早几十到几百毫秒返回。
   */
  private onGroupStart(groupName: string): void {
    const timed = this.timedGroup
    if (!timed || timed.name !== groupName) return
    this.timedStarted = true
    const duration = this.animator.groupDuration(groupName)
    if (timed.kind === 'reaction') this.reactionRemaining = duration
    else this.oneShotRemaining = duration
  }

  /** 标记一组「按整组时长计时」，计时从真正开播（onGroupStart）那一刻起算 */
  private trackTimed(name: string, kind: 'reaction' | 'oneShot'): void {
    this.timedGroup = { name, kind }
    this.timedStarted = false
  }

  private clearTimed(): void {
    this.timedGroup = null
    this.timedStarted = false
  }

  private onAnimComplete(): void {
    if (!this.active) return

    // 1) 插播的动画播完 → 回到当前状态的循环组
    if (this.insertingAction) {
      // one-shot 的反应组先播完也走同一条收尾（循环组则靠 update 的计时）
      if (this.reactionActive) {
        this.endReaction()
        return
      }
      this.insertingAction = false
      this.playStateLoop()
      return
    }

    // 2) 分段状态：enter 播完 → normal；exit 播完 → 进入 pending 状态
    if (SEGMENTED_STATES.has(this.state)) {
      const nextPhase = advanceSegment(this.phase)
      if (nextPhase) {
        this.phase = nextPhase
        this.playGroup(`${this.state}_${this.phase}`)
        // 到了持续态就把退出段备好（swim_exit / drag_exit 都要播，现加载会卡一帧）
        if (nextPhase === 'normal') this.animator.preload(`${this.state}_exit`)
        return
      }
      this.enterState(this.pendingState ?? 'idle')
      return
    }

    // 3) 其余 one-shot 组由状态机收尾
    this.applyEvent('ANIM_COMPLETE')
  }

  /** 回到当前状态的循环动画（插播动作结束后用）。 */
  private playStateLoop(): void {
    if (SEGMENTED_STATES.has(this.state)) {
      this.playGroup(`${this.state}_${this.phase}`)
    } else {
      this.playGroup(`${this.state}_normal`)
    }
  }

  private playGroup(groupName: string): void {
    // 组名按 manifest 命名约定拼出；缺失时退回待机，避免切空画面
    if (this.animator.groupNames.includes(groupName)) {
      this.animator.play(groupName)
      return
    }
    this.animator.play(FALLBACK_GROUP)
  }
}
