/**
 * 待机随机动作池：从动作组集合里随机挑一个，保证与上一次不同。
 * 对应 behavior.md「同一次会话内不连续重复同一动作」；只依赖注入的随机源，便于单测。
 */
export class RandomActionPool {
  private readonly actions: readonly string[]
  private readonly rng: () => number
  private last: string | null = null

  constructor(actions: readonly string[], rng: () => number = Math.random) {
    this.actions = actions
    this.rng = rng
  }

  /** 随机挑一个动作组名，且不会与上一次相同（集合只有 1 项时只能重复）。 */
  pick(): string {
    if (this.actions.length === 0) throw new Error('随机动作池为空')
    const candidates = this.last
      ? this.actions.filter((action) => action !== this.last)
      : this.actions
    // 集合只有 1 项时过滤后为空，只能重复；否则从「排除上次」的候选里选
    const pool = candidates.length > 0 ? candidates : this.actions
    // rng 理论上可返回 1（自定义源），夹一下下标避免越界
    const index = Math.min(pool.length - 1, Math.floor(this.rng() * pool.length))
    const action = pool[Math.max(0, index)]
    this.last = action
    return action
  }

  get lastAction(): string | null {
    return this.last
  }
}
