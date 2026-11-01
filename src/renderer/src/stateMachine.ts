// 纯函数状态机：不依赖 PixiJS / DOM，可直接被 vitest 单测。
// 行为基准是根目录 behavior.md 第一节（状态表 / 迁移规则）与第二节第 62 行（优先级）。
// 本模块不出现任何帧名；动画组由 PetCore 按「状态名 + 段后缀」查 manifest。

export type PetState = 'idle' | 'swim' | 'sleep' | 'sad' | 'happy' | 'drag' | 'eat' | 'talk' | 'awake'

export type PetEvent =
  | 'SWIM_START' // 右键单击鱼：进入游动
  | 'SWIM_STOP' // 右键单击鱼（游动中）：退出游动
  | 'IDLE_TIMEOUT' // 闲置满 3 分钟
  | 'NIGHT' // 夜间 23:00–07:00
  | 'WAKE' // 睡眠中被鼠标移动 / 用户说话唤醒
  | 'DRAG_START'
  | 'DRAG_END'
  | 'CLICK'
  | 'PET' // 抚摸
  | 'FEED' // 投喂
  | 'CHAT_START'
  | 'CHAT_END'
  | 'META_TRIGGER' // persona 的第四面墙触发器
  | 'ANIM_COMPLETE' // 一次性动画播完
  | 'IGNORED' // 长时间未被理会

/** 动作帧优先级：高可打断低，同级后到者覆盖（对应 manifest 各组 priority）。 */
const PRIORITY: Record<PetState, number> = {
  idle: 0,
  sleep: 0,
  sad: 0,
  eat: 0,
  swim: 1,
  happy: 2,
  drag: 3,
  awake: 4,
  talk: 5
}

/** 当前状态自身触发的条件迁移 / 结束迁移，不受优先级约束。 */
const SELF_TRANSITIONS: Partial<Record<PetState, Partial<Record<PetEvent, PetState>>>> = {
  idle: {
    SWIM_START: 'swim',
    IDLE_TIMEOUT: 'sleep',
    NIGHT: 'sleep',
    IGNORED: 'sad'
  },
  // 游动只能由右键单击鱼终止；左键的单击/抚摸不打断游动（自迁移即无变化）
  swim: { SWIM_STOP: 'idle', CLICK: 'swim', PET: 'swim' },
  sleep: { WAKE: 'idle' },
  sad: { IGNORED: 'sleep' },
  happy: { ANIM_COMPLETE: 'idle' },
  talk: { CHAT_END: 'idle', META_TRIGGER: 'awake' },
  drag: { DRAG_END: 'idle' },
  eat: { ANIM_COMPLETE: 'idle' },
  awake: { ANIM_COMPLETE: 'idle' }
}

/** 打断类事件：可从任意状态触发，目标优先级须 ≥ 当前（同级后到者胜）。 */
const INTERRUPTS: Partial<Record<PetEvent, PetState>> = {
  DRAG_START: 'drag',
  CLICK: 'happy',
  PET: 'happy',
  FEED: 'eat',
  CHAT_START: 'talk',
  META_TRIGGER: 'awake'
}

/** 分段状态：enter（one-shot）→ normal（循环）→ exit（one-shot），见 behavior.md 第 35–42 行。 */
export const SEGMENTED_STATES: ReadonlySet<PetState> = new Set<PetState>([
  'drag',
  'eat',
  'sleep',
  'awake',
  'swim'
])

/** 一次性状态：主循环组播一遍后自动回 idle。 */
export const ONE_SHOT_STATES: ReadonlySet<PetState> = new Set<PetState>(['happy'])

export type SegmentPhase = 'enter' | 'normal' | 'exit'

/**
 * 分段动画在一段 one-shot 播完后的推进：
 * enter 播完 → normal；exit 播完 → 结束（返回 null，由调用方切入 pending 状态）。
 * normal 是循环段，正常情况下不会收到 onComplete，返回 null 表示「无需推进」。
 */
export function advanceSegment(phase: SegmentPhase): SegmentPhase | null {
  return phase === 'enter' ? 'normal' : null
}

/**
 * 纯函数迁移：返回下一个状态；未命中任何迁移时原样返回当前状态。
 */
export function transition(state: PetState, event: PetEvent): PetState {
  // 1) 当前状态自身的迁移优先（如 talk 命中彩蛋进 awake，不受优先级阻挡）
  const self = SELF_TRANSITIONS[state]?.[event]
  if (self) return self

  // 2) 打断类事件：同级或更高优先级才生效，低优先级动作不能打断高优先级状态
  const target = INTERRUPTS[event]
  if (target && PRIORITY[target] >= PRIORITY[state]) return target

  return state
}

export function statePriority(state: PetState): number {
  return PRIORITY[state]
}
