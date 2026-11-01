import { describe, expect, it } from 'vitest'
import { PetCore } from './petCore'
import type { Animator } from './animator'

// 用最小替身观察 PetCore 播放了哪些动画组，不加载 PixiJS / 素材
class FakeAnimator {
  readonly played: string[] = []
  readonly preloaded: string[] = []
  /** 模拟「图集还没加载完」的组：play 只记挂起，等 start() 才真开播 */
  readonly deferred = new Set<string>()
  /** 模拟「加载确实在进行中」；从 deferred 里删掉但没 start，就等于加载失败 */
  readonly preparing = new Set<string>()
  onComplete?: () => void
  onGroupStart?: (group: string) => void
  current = ''
  private readonly groups: Set<string>

  constructor(groups: string[], private readonly durations: Record<string, number> = {}) {
    this.groups = new Set(groups)
  }

  get groupNames(): string[] {
    return [...this.groups]
  }

  get currentGroup(): string {
    return this.current
  }

  get currentFrameIndex(): number {
    return 0
  }

  groupDuration(group: string): number {
    return this.durations[group] ?? 1000
  }

  play(group: string): void {
    if (!this.groups.has(group)) return
    if (this.deferred.has(group)) return // 图集没加载完：什么都不播，等着
    this.current = group
    this.played.push(group)
    this.onGroupStart?.(group)
  }

  /** 只记录预热请求，不影响当前播放 */
  preload(group: string): void {
    if (!this.groups.has(group)) return
    this.preloaded.push(group)
  }

  isLoading(group: string): boolean {
    return this.preparing.has(group)
  }

  /** 模拟图集加载完成后的补播 */
  start(group: string): void {
    this.deferred.delete(group)
    this.preparing.delete(group)
    this.play(group)
  }

  update(): void {}

  /** 模拟 one-shot 组播到末帧触发 onComplete */
  complete(): void {
    this.onComplete?.()
  }
}

const GROUPS = [
  'idle_normal',
  'idle_blink',
  'idle_yawn',
  'idle_done',
  'swim_enter',
  'swim_normal',
  'swim_exit',
  'sleep_enter',
  'sleep_normal',
  'sleep_exit',
  'eat_enter',
  'eat_normal',
  'eat_exit',
  'drag_enter',
  'drag_normal',
  'drag_exit',
  'happy_normal',
  'happy_pet',
  'sad_normal',
  'talk_normal',
  'awake_enter',
  'awake_normal',
  'awake_exit'
]

function createCore(durations: Record<string, number> = {}): {
  core: PetCore
  animator: FakeAnimator
} {
  const animator = new FakeAnimator(GROUPS, durations)
  const core = new PetCore(animator as unknown as Animator, ['idle_blink', 'idle_yawn'])
  return { core, animator }
}

describe('PetCore 自动状态与分段衔接', () => {
  it('启动进入 idle 并播放待机循环', () => {
    const { core, animator } = createCore()
    expect(core.currentState).toBe('idle')
    expect(animator.current).toBe('idle_normal')
  })

  it('sleep 分段：enter → normal → exit → idle', () => {
    const { core, animator } = createCore()

    core.handle('IDLE_TIMEOUT')
    expect(core.currentState).toBe('sleep')
    expect(animator.current).toBe('sleep_enter')

    animator.complete() // 进入段播完
    expect(animator.current).toBe('sleep_normal')

    core.handle('WAKE') // 离开条件命中
    expect(animator.current).toBe('sleep_exit')

    animator.complete() // 退出段播完
    expect(core.currentState).toBe('idle')
    expect(animator.current).toBe('idle_normal')
  })

  it('投喂分段：enter → 期待 → 收尾播 eat_exit（进食）→ idle', () => {
    const { core, animator } = createCore()

    core.handle('FEED')
    expect(core.currentState).toBe('eat')
    expect(animator.current).toBe('eat_enter')

    animator.complete() // 进入段播完 → 期待
    expect(animator.current).toBe('eat_normal')
    expect(animator.preloaded).toContain('eat_exit')

    // 期待时长由渲染层掐（eat_normal 是循环段，不会自己播完）
    core.handle('ANIM_COMPLETE')
    expect(animator.current).toBe('eat_exit')

    animator.complete() // 进食播完 → 站姿
    expect(core.currentState).toBe('idle')
    expect(animator.current).toBe('idle_normal')
  })

  it('睡着时投喂：先播 sleep_exit 揉眼醒来，再进 eat', () => {
    const { core, animator } = createCore()

    core.handle('IDLE_TIMEOUT')
    animator.complete() // 睡下
    expect(animator.current).toBe('sleep_normal')

    core.handle('FEED')
    expect(core.currentState).toBe('sleep')
    expect(animator.current).toBe('sleep_exit')

    animator.complete()
    expect(core.currentState).toBe('eat')
    expect(animator.current).toBe('eat_enter')
  })

  it('happy 播完一遍后自动回 idle', () => {
    const { core, animator } = createCore()

    core.handle('CLICK')
    expect(core.currentState).toBe('happy')
    expect(animator.current).toBe('happy_normal')

    core.update(1000) // 一次性状态计时到点
    expect(core.currentState).toBe('idle')
    expect(animator.current).toBe('idle_normal')
  })

  it('反应动画首播要等图集加载：计时从真正开播那刻起算，不做无用功', () => {
    const { core, animator } = createCore({ happy_normal: 6000 })
    animator.deferred.add('happy_normal')
    animator.preparing.add('happy_normal')

    core.playReaction('happy_normal')
    expect(animator.current).toBe('idle_normal') // 还在加载，画面没切

    core.update(500) // 加载耗时 500ms，不该从表演时长里扣
    animator.start('happy_normal')
    expect(animator.current).toBe('happy_normal')

    core.update(5900)
    expect(animator.current).toBe('happy_normal') // 差 100ms 才满整组
    core.update(200)
    expect(animator.current).toBe('idle_normal')
  })

  it('一次性动作首播要等图集加载：不会在加载耗时里被提前判完', () => {
    const { core, animator } = createCore({ happy_normal: 6000 })
    animator.deferred.add('happy_normal')
    animator.preparing.add('happy_normal')

    core.handle('CLICK')
    expect(core.currentState).toBe('happy')
    expect(animator.current).toBe('idle_normal')

    core.update(500)
    animator.start('happy_normal')
    core.update(5900)
    expect(core.currentState).toBe('happy')
    core.update(200)
    expect(core.currentState).toBe('idle')
  })

  it('图集加载慢过整组时长时计时暂停，不会在动画上屏前就收尾', () => {
    // idle_done 只有 3s：加载/解码慢一点就会顶穿整组时长
    const { core, animator } = createCore({ idle_done: 3000 })
    animator.deferred.add('idle_done')
    animator.preparing.add('idle_done')

    core.playReaction('idle_done')
    expect(animator.current).toBe('idle_normal')

    core.update(5000) // 加载 5s，已经超过整组时长；不该判它结束
    expect(core.isReacting).toBe(true)

    animator.start('idle_done')
    core.update(2900)
    expect(core.isReacting).toBe(true) // 从真正开播那刻起算，整组演满
    core.update(200)
    expect(core.isReacting).toBe(false)
    expect(animator.current).toBe('idle_normal')
  })

  it('图集加载失败（不再「正在加载」）时不无限等，计时照常收尾', () => {
    const { core, animator } = createCore({ idle_done: 3000 })
    animator.deferred.add('idle_done') // play 挂起，但不在 preparing：等同加载失败、永远不会补播
    core.playReaction('idle_done')

    core.update(3100)
    expect(core.isReacting).toBe(false) // 否则 reactionActive 永久为真，之后输入全被吃掉
    expect(core.currentState).toBe('idle')
  })

  it('抚摸（PET）优先播 happy_pet，单击（CLICK）仍播 happy_normal', () => {
    const { core, animator } = createCore()

    core.handle('PET')
    expect(core.currentState).toBe('happy')
    expect(animator.current).toBe('happy_pet')

    core.update(1000) // 播完回 idle
    expect(core.currentState).toBe('idle')

    core.handle('CLICK')
    expect(animator.current).toBe('happy_normal')
  })

  it('drag 分段：进入持续态后可被高优先级打断', () => {
    const { core, animator } = createCore()

    core.handle('DRAG_START')
    expect(animator.current).toBe('drag_enter')
    animator.complete()
    expect(animator.current).toBe('drag_normal')

    core.handle('CHAT_START') // talk 优先级高于 drag
    // 退出段播放期间仍停留在原状态，播完才切到新状态
    expect(animator.current).toBe('drag_exit')
    animator.complete()
    expect(core.currentState).toBe('talk')
    expect(animator.current).toBe('talk_normal')
  })

  it('drag 中低优先级点击不打断', () => {
    const { core, animator } = createCore()
    core.handle('DRAG_START')
    animator.complete()

    core.handle('CLICK')
    expect(core.currentState).toBe('drag')
    expect(animator.current).toBe('drag_normal')
  })

  it('sleep 持续态不会自动醒来，需外部 WAKE 驱动', () => {
    const { core, animator } = createCore()
    core.handle('IDLE_TIMEOUT')
    animator.complete() // sleep_enter → sleep_normal

    core.update(60_000) // P2 曾在这里 30s 自动醒，P3 已移除
    expect(core.currentState).toBe('sleep')
    expect(animator.current).toBe('sleep_normal')
    expect(core.segmentPhase).toBe('normal')

    core.handle('WAKE')
    expect(animator.current).toBe('sleep_exit')
  })

  it('playReaction 插播反应动画，播完回到当前循环组', () => {
    const { core, animator } = createCore()
    core.playReaction('idle_done')
    expect(animator.current).toBe('idle_done')

    animator.complete()
    expect(animator.current).toBe('idle_normal')
    expect(core.currentState).toBe('idle')
  })

  it('分段动作预热下一段：进进入段预热持续段，进持续态预热退出段', () => {
    const { core, animator } = createCore()

    core.handle('SWIM_START')
    expect(animator.current).toBe('swim_enter')
    expect(animator.preloaded).toEqual(['swim_normal']) // 进入段播的 2s 里把持续段解码好

    animator.complete() // swim_enter 播完
    expect(animator.current).toBe('swim_normal')
    expect(animator.preloaded).toEqual(['swim_normal', 'swim_exit'])
  })

  it('swim 分段：enter → normal → stop → exit → idle', () => {
    const { core, animator } = createCore()

    core.handle('SWIM_START')
    expect(core.currentState).toBe('swim')
    expect(animator.current).toBe('swim_enter')

    animator.complete() // 进入段播完
    expect(animator.current).toBe('swim_normal')

    core.handle('SWIM_STOP')
    expect(animator.current).toBe('swim_exit')

    animator.complete() // 退出段播完
    expect(core.currentState).toBe('idle')
    expect(animator.current).toBe('idle_normal')
  })

  it('swim 状态下也能插播反应动画', () => {
    const { core, animator } = createCore()
    core.handle('SWIM_START')
    animator.complete() // swim_enter → swim_normal
    expect(animator.current).toBe('swim_normal')

    core.playReaction('idle_done')
    expect(animator.current).toBe('idle_done')
    animator.complete()
    expect(animator.current).toBe('swim_normal')
  })

  it('翻白眼播放期间忽略其它输入，播完触发回调', () => {
    const { core, animator } = createCore()
    let completed = false
    core.onReactionComplete = () => {
      completed = true
    }

    core.playReaction('idle_done')
    core.handle('CLICK') // 反应中，被忽略
    expect(core.currentState).toBe('idle')
    expect(animator.current).toBe('idle_done')

    animator.complete()
    expect(completed).toBe(true)
    expect(animator.current).toBe('idle_normal')
  })

  it('反应播放中来消息：直接进 talk，别把整轮回复的说话动画吞掉', () => {
    const { core, animator } = createCore()
    core.playReaction('idle_done') // 比如 20 连击的翻白眼，2s 才播完
    expect(core.isReacting).toBe(true)

    core.handle('CHAT_START') // 以前这里会被「反应中忽略输入」丢掉，整轮回复都没有 talk
    expect(core.currentState).toBe('talk')

    core.update(1100) // 反应计时到点收尾
    expect(core.isReacting).toBe(false)
    expect(core.currentState).toBe('talk')
    expect(animator.current).toBe('talk_normal')
  })

  it('连击时 happy 未播完也能触发翻白眼，播完回 idle 而不是 happy', () => {
    const { core, animator } = createCore()
    let completed = false
    core.onReactionComplete = () => {
      completed = true
    }

    core.handle('CLICK') // 前 19 次单击：进入 happy 一次性动画
    expect(core.currentState).toBe('happy')
    expect(animator.current).toBe('happy_normal')

    core.playReaction('idle_done') // 第 20 次：翻白眼顶掉 happy
    expect(animator.current).toBe('idle_done')
    expect(core.currentState).toBe('idle')

    animator.complete()
    expect(completed).toBe(true)
    expect(core.currentState).toBe('idle')
    expect(animator.current).toBe('idle_normal')
  })

  it('预览（setActive）后恢复自动逻辑会清掉反应锁', () => {
    const { core, animator } = createCore()
    core.playReaction('idle_done')
    expect(core.isReacting).toBe(true)

    core.setActive(false) // 预览面板切到单个动作组
    core.setActive(true) // 点「自动」恢复状态机

    expect(core.isReacting).toBe(false)
    expect(animator.current).toBe('idle_normal')
    core.handle('CLICK') // 输入恢复可用
    expect(core.currentState).toBe('happy')
  })

  it('swimGoto / swimFollow 只在游动状态生效，swimArrived 回原地', () => {
    const { core, animator } = createCore()

    core.swimGoto(10, 20) // idle 时无效
    expect(core.currentSwimMode).toBe('idle')

    core.handle('SWIM_START')
    animator.complete() // 进入 swim_normal

    core.swimGoto(100, 200)
    expect(core.currentSwimMode).toBe('goto')
    expect(core.currentSwimTarget).toEqual({ x: 100, y: 200 })

    core.swimFollow()
    expect(core.currentSwimMode).toBe('follow')
    expect(core.currentSwimTarget).toBeNull()

    core.swimGoto(1, 2)
    core.swimArrived()
    expect(core.currentSwimMode).toBe('idle')
    expect(core.currentSwimTarget).toBeNull()
  })

  it('talk 中插播情绪表情：循环组不会「播完」，靠计时收尾并接回 talk', () => {
    const { core, animator } = createCore()

    core.handle('CHAT_START')
    expect(core.currentState).toBe('talk')
    core.playReaction('happy_normal') // 真实素材里 happy_normal 是 loop:true，永远不会触发 onComplete
    expect(animator.current).toBe('happy_normal')
    expect(core.isReacting).toBe(true)

    core.update(1100) // 只推进时间，不模拟 complete
    expect(core.isReacting).toBe(false)
    expect(core.currentState).toBe('talk')
    expect(animator.current).toBe('talk_normal')
  })

  it('情绪表情按组的完整时长播完，不再截断到 1.6s', () => {
    // 真实素材 happy_normal 是 48 帧 / 8fps = 6s；旧实现 min(组时长, 1600ms) 会演到一半就被切走
    const { core, animator } = createCore({ happy_normal: 6000 })

    core.handle('CHAT_START')
    core.playReaction('happy_normal')

    core.update(5000) // 已经超过旧的 1.6s 上限，仍应停在表情上
    expect(core.isReacting).toBe(true)
    expect(animator.current).toBe('happy_normal')

    core.update(1100)
    expect(core.isReacting).toBe(false)
    expect(animator.current).toBe('talk_normal')
    expect(core.currentState).toBe('talk')
  })

  it('表情播放期间收到 CHAT_END：挂起到表情播完再生效', () => {
    const { core, animator } = createCore()

    core.handle('CHAT_START')
    core.playReaction('sad_normal')
    core.handle('CHAT_END') // 反应中，不能直接丢，否则永远停在 talk
    expect(core.currentState).toBe('talk')

    core.update(1100)
    expect(core.currentState).toBe('idle')
    expect(animator.current).toBe('idle_normal')
  })

  it('挂起的 CHAT_END 会被新一句 CHAT_START 作废', () => {
    const { core, animator } = createCore()

    core.handle('CHAT_START')
    core.playReaction('happy_normal')
    core.handle('CHAT_END')
    core.handle('CHAT_START') // 用户又发了一条

    core.update(1100)
    expect(core.currentState).toBe('talk')
    expect(animator.current).toBe('talk_normal')
  })

  it('分段退出段播放期间收到的 CHAT_END 不丢：进入 talk 后立刻收尾', () => {
    const { core, animator } = createCore()

    core.handle('IDLE_TIMEOUT') // sleep_enter
    animator.complete() // → sleep_normal
    core.handle('CHAT_START') // 只起播 sleep_exit，state 仍是 sleep
    expect(core.currentState).toBe('sleep')

    core.handle('CHAT_END') // 此刻迁移表里查不到，以前会直接丢掉 → 永久卡 talk
    expect(core.currentState).toBe('sleep')

    animator.complete() // sleep_exit 播完 → talk
    expect(core.currentState).toBe('talk')
    core.update(16) // 下一帧补上收尾
    expect(core.currentState).toBe('idle')
  })

  it('分段退出段播放中不接反应插播（否则退出段会从头重播）', () => {
    const { core, animator } = createCore()

    core.handle('SWIM_START')
    animator.complete()
    core.handle('SWIM_STOP') // swim_exit
    core.playReaction('idle_done')
    expect(animator.current).toBe('swim_exit')
  })

  it('awake 持续态可由 endAwake 收尾：exit → idle', () => {
    const { core, animator } = createCore()

    core.handle('META_TRIGGER')
    expect(animator.current).toBe('awake_enter')
    animator.complete() // 进入段播完 → 持续凝视
    expect(animator.current).toBe('awake_normal')

    core.endAwake()
    expect(animator.current).toBe('awake_exit')
    animator.complete()
    expect(core.currentState).toBe('idle')
  })

  it('awake 进入段还没播完时收尾请求会挂起，进入持续态后立刻退出', () => {
    const { core, animator } = createCore()

    core.handle('META_TRIGGER')
    core.endAwake() // 还是 awake_enter，先挂起
    expect(animator.current).toBe('awake_enter')

    animator.complete() // enter → normal
    expect(animator.current).toBe('awake_normal')
    core.update(16) // 挂起的收尾在下一帧生效
    expect(animator.current).toBe('awake_exit')
  })

  it('setActive(false) 时状态逻辑暂停，恢复后回到 idle', () => {
    const { core, animator } = createCore()
    core.setActive(false)
    core.update(999_999)
    expect(animator.current).toBe('idle_normal')

    core.setActive(true)
    expect(core.currentState).toBe('idle')
  })
})
