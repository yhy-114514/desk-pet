// 大白饭占位图形（正式素材待生成后替换）。仅提供：粘在鼠标上、从天而降两个动作。
import { Container, Graphics } from 'pixi.js'

const DROP_MS = 320

export class RiceBowl {
  readonly view = new Container()
  private readonly g = new Graphics()

  /** 落碗动画播完时触发一次（渲染层据此让鱼吃掉：散射+消失） */
  onLanded?: () => void

  private dropT = -1
  private dropFrom = 0
  private dropTo = 0

  constructor() {
    // 碗身（浅灰梯形）
    this.g.moveTo(-14, 0).lineTo(14, 0).lineTo(9, 16).lineTo(-9, 16).closePath()
    this.g.fill({ color: 0xf2f4f8 })
    // 碗口 / 饭堆（白色）
    this.g.ellipse(0, -1, 14, 5).fill({ color: 0xffffff })
    this.g.ellipse(0, -5, 11, 7).fill({ color: 0xfffdf3 })
    this.g.ellipse(0, -8, 6, 4).fill({ color: 0xffffff })
    this.view.addChild(this.g)
    this.view.visible = false
  }

  get isVisible(): boolean {
    return this.view.visible
  }

  /** 粘在指定窗口内坐标处 */
  showAt(x: number, y: number): void {
    this.view.position.set(x, y)
    this.view.visible = true
    this.dropT = -1
  }

  /** 从上方掉落到窗口内坐标处 */
  dropAt(x: number, y: number): void {
    this.view.position.set(x, y - 70)
    this.view.visible = true
    this.dropFrom = y - 70
    this.dropTo = y
    this.dropT = 0
  }

  hide(): void {
    this.view.visible = false
    this.dropT = -1
  }

  update(deltaMs: number): void {
    if (this.dropT < 0) return
    this.dropT += deltaMs
    const k = Math.min(1, this.dropT / DROP_MS)
    // easeOutQuad，落得自然一点
    const e = 1 - (1 - k) * (1 - k)
    this.view.y = this.dropFrom + (this.dropTo - this.dropFrom) * e
    if (k >= 1) {
      this.dropT = -1
      this.onLanded?.()
    }
  }
}
