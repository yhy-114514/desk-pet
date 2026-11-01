import { describe, expect, it } from 'vitest'
import {
  type PetEvent,
  type PetState,
  advanceSegment,
  statePriority,
  transition
} from './stateMachine'

// 迁移矩阵：state → event → 期望目标（behavior.md 第一节 + 第二节优先级）
const MATRIX: Array<[PetState, PetEvent, PetState]> = [
  // idle 的自身迁移
  ['idle', 'SWIM_START', 'swim'],
  ['idle', 'IDLE_TIMEOUT', 'sleep'],
  ['idle', 'NIGHT', 'sleep'],
  ['idle', 'IGNORED', 'sad'],
  // 各状态自身结束 / 条件迁移
  ['swim', 'SWIM_STOP', 'idle'],
  ['sleep', 'WAKE', 'idle'],
  ['sad', 'IGNORED', 'sleep'],
  ['happy', 'ANIM_COMPLETE', 'idle'],
  ['talk', 'CHAT_END', 'idle'],
  ['talk', 'META_TRIGGER', 'awake'],
  ['drag', 'DRAG_END', 'idle'],
  ['eat', 'ANIM_COMPLETE', 'idle'],
  ['awake', 'ANIM_COMPLETE', 'idle']
]

describe('transition 迁移矩阵', () => {
  it.each(MATRIX)('%s + %s → %s', (state, event, expected) => {
    expect(transition(state, event)).toBe(expected)
  })

  it('未命中迁移时保持原状态', () => {
    expect(transition('idle', 'ANIM_COMPLETE')).toBe('idle')
    expect(transition('idle', 'DRAG_END')).toBe('idle')
    expect(transition('swim', 'ANIM_COMPLETE')).toBe('swim')
  })
})

describe('打断类事件与优先级', () => {
  it('低优先级状态可被高优先级动作打断', () => {
    expect(transition('idle', 'CLICK')).toBe('happy')
    expect(transition('idle', 'PET')).toBe('happy')
    expect(transition('idle', 'FEED')).toBe('eat')
    expect(transition('idle', 'CHAT_START')).toBe('talk')
    expect(transition('idle', 'DRAG_START')).toBe('drag')
    expect(transition('swim', 'CHAT_START')).toBe('talk')
  })

  it('高优先级状态不被低优先级动作打断', () => {
    expect(transition('talk', 'CLICK')).toBe('talk')
    expect(transition('talk', 'PET')).toBe('talk')
    expect(transition('drag', 'CLICK')).toBe('drag')
    expect(transition('awake', 'CLICK')).toBe('awake')
  })

  it('同级后到者覆盖', () => {
    // sleep / eat / sad / idle 同为优先级 0
    expect(transition('sleep', 'FEED')).toBe('eat')
    expect(transition('sad', 'CLICK')).toBe('happy')
  })

  it('自身迁移优先于打断判定', () => {
    // talk(5) 命中彩蛋进 awake(4)，不能因优先级被阻挡
    expect(transition('talk', 'META_TRIGGER')).toBe('awake')
  })

  it('游动中左键单击/抚摸不打断游动（只能右键停止）', () => {
    expect(transition('swim', 'CLICK')).toBe('swim')
    expect(transition('swim', 'PET')).toBe('swim')
  })
})

describe('优先级表', () => {
  it('对应 behavior.md：talk > awake > drag > happy > swim > idle', () => {
    expect(statePriority('talk')).toBeGreaterThan(statePriority('awake'))
    expect(statePriority('awake')).toBeGreaterThan(statePriority('drag'))
    expect(statePriority('drag')).toBeGreaterThan(statePriority('happy'))
    expect(statePriority('happy')).toBeGreaterThan(statePriority('swim'))
    expect(statePriority('swim')).toBeGreaterThan(statePriority('idle'))
  })
})

describe('advanceSegment 分段推进', () => {
  it('enter 播完推进到 normal', () => {
    expect(advanceSegment('enter')).toBe('normal')
  })

  it('exit 播完结束（返回 null）', () => {
    expect(advanceSegment('exit')).toBeNull()
  })

  it('normal 是循环段，不推进', () => {
    expect(advanceSegment('normal')).toBeNull()
  })
})
