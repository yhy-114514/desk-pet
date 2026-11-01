import { describe, expect, it } from 'vitest'
import { GestureDetector, type GestureCallbacks } from './gestureDetector'

function create() {
  const log: string[] = []
  const cb: GestureCallbacks = {
    onClick: () => log.push('click'),
    onRapidClicks: () => log.push('rapid'),
    onDragStart: () => log.push('dragStart'),
    onDragMove: (dx, dy) => log.push(`dragMove:${dx},${dy}`),
    onDragEnd: () => log.push('dragEnd'),
    onPetStart: () => log.push('petStart'),
    onPetTick: () => log.push('petTick'),
    onPetEnd: () => log.push('petEnd')
  }
  return { detector: new GestureDetector(cb), log }
}

describe('GestureDetector 左键手势', () => {
  it('快速点按立即触发单击', () => {
    const { detector, log } = create()
    detector.pointerDown(0)
    detector.pointerUp(80)
    expect(log).toEqual(['click'])
  })

  it('连续点击 20 次触发翻白眼，前 19 次为单击', () => {
    const { detector, log } = create()
    for (let i = 0; i < 20; i++) {
      detector.pointerDown(i * 100)
      detector.pointerUp(i * 100 + 50)
    }
    expect(log.filter((e) => e === 'click')).toHaveLength(19)
    expect(log.filter((e) => e === 'rapid')).toHaveLength(1)
    expect(log[log.length - 1]).toBe('rapid')
  })

  it('连击间隔超过窗口则计数清零', () => {
    const { detector, log } = create()
    detector.pointerDown(0)
    detector.pointerUp(50) // 1
    detector.pointerDown(100)
    detector.pointerUp(150) // 2
    detector.update(150 + 700) // 超过 600ms，计数清零
    detector.pointerDown(900)
    detector.pointerUp(950) // 从 1 重新开始

    expect(detector.rapidClickProgress).toBe(1)
    expect(log.filter((e) => e === 'rapid')).toHaveLength(0)
  })

  it('resetRapidClicks 清零计数（翻白眼播完调用）', () => {
    const { detector } = create()
    for (let i = 0; i < 5; i++) {
      detector.pointerDown(i * 100)
      detector.pointerUp(i * 100 + 50)
    }
    expect(detector.rapidClickProgress).toBe(5)
    detector.resetRapidClicks()
    expect(detector.rapidClickProgress).toBe(0)
  })

  it('按住不动 1s → 拖拽链', () => {
    const { detector, log } = create()
    detector.pointerDown(0)
    detector.update(1000) // 到时进入拖拽
    expect(log).toEqual(['dragStart', 'dragMove:0,0'])

    detector.pointerMove(1010, 100, 100)
    detector.pointerMove(1020, 130, 100)
    detector.pointerUp(1030)
    expect(log).toContain('dragEnd')
    expect(detector.isDragging).toBe(false)
    expect(detector.isPressed).toBe(false)
  })

  it('按住后划动路程超阈值 → 抚摸（不误判拖拽）', () => {
    const { detector, log } = create()
    detector.pointerDown(0)
    detector.pointerMove(10, 100, 100) // 建立基准
    detector.pointerMove(20, 140, 100) // 路程 40
    expect(log).toEqual([])
    detector.pointerMove(30, 180, 100) // 路程累计 80 ≥ 60
    expect(log).toEqual(['petStart'])
    expect(detector.isPetting).toBe(true)

    detector.pointerUp(40)
    expect(log).toEqual(['petStart', 'petEnd'])
  })

  it('划动不足阈值就松手 → 单击', () => {
    const { detector, log } = create()
    detector.pointerDown(0)
    detector.pointerMove(10, 100, 100)
    detector.pointerMove(20, 120, 100) // 路程 20 < 60
    detector.pointerUp(30)
    expect(log).toEqual(['click'])
  })

  it('抚摸期间按 250ms 节流触发音符', () => {
    const { detector, log } = create()
    detector.pointerDown(0)
    detector.pointerMove(10, 100, 100)
    detector.pointerMove(20, 180, 100) // 进入抚摸，nextTick = t+250
    detector.update(270) // 270 >= 250 第一次
    detector.update(300) // 未到 520
    detector.update(530) // 第二次
    detector.pointerUp(600)

    expect(log).toEqual(['petStart', 'petTick', 'petTick', 'petEnd'])
  })

  it('pointerCancel 在抚摸中正确收尾', () => {
    const { detector, log } = create()
    detector.pointerDown(0)
    detector.pointerMove(10, 100, 100)
    detector.pointerMove(20, 180, 100)
    detector.pointerCancel()
    expect(log).toEqual(['petStart', 'petEnd'])
    expect(detector.isPressed).toBe(false)
  })
})
