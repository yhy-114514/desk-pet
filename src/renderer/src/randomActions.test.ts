import { describe, expect, it } from 'vitest'
import { RandomActionPool } from './randomActions'

describe('RandomActionPool', () => {
  const actions = ['idle_blink', 'idle_yawn', 'idle_done']

  it('只从给定集合里取值', () => {
    const pool = new RandomActionPool(actions)
    for (let i = 0; i < 50; i++) {
      expect(actions).toContain(pool.pick())
    }
  })

  it('相邻两次取值不重复（会话内不连续重复）', () => {
    const pool = new RandomActionPool(actions)
    let previous = pool.pick()
    for (let i = 0; i < 200; i++) {
      const next = pool.pick()
      expect(next).not.toBe(previous)
      previous = next
    }
  })

  it('rng 返回边界值 1 时不越界', () => {
    const pool = new RandomActionPool(actions, () => 1)
    expect(actions).toContain(pool.pick())
    expect(actions).toContain(pool.pick())
  })

  it('单元素集合只能重复该动作', () => {
    const pool = new RandomActionPool(['idle_blink'])
    expect(pool.pick()).toBe('idle_blink')
    expect(pool.pick()).toBe('idle_blink')
  })

  it('空集合抛错', () => {
    const pool = new RandomActionPool([])
    expect(() => pool.pick()).toThrow()
  })

  it('lastAction 记录上一次结果', () => {
    const pool = new RandomActionPool(actions, () => 0)
    expect(pool.lastAction).toBeNull()
    const first = pool.pick()
    expect(pool.lastAction).toBe(first)
  })
})
