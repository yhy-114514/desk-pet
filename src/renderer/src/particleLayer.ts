// 轻量粒子层：点击星屑 / 抚摸音符 / 投喂爱心（投喂 P3 暂缓，仅预留入口）。
// 用普通 Container + Graphics 池而非 ParticleContainer：后者不支持 Graphics、
// 需先生成纹理，而 P3 同屏粒子 ≤60，Graphics 池完全够用。
import { Container, Graphics } from 'pixi.js'

export type ParticleKind = 'star' | 'note' | 'heart' | 'rice'

const COLORS: Record<ParticleKind, number> = {
  star: 0xffd45e,
  note: 0x8fd3ff,
  heart: 0xff8fb8,
  rice: 0xfffdf3
}

const POOL_SIZE = 60
const LIFE_MS = 800
const GRAVITY = 120 // px/s²

interface Particle {
  g: Graphics
  vx: number
  vy: number
  life: number
  maxLife: number
  spin: number
}

export class ParticleLayer {
  readonly view = new Container()
  private readonly free: Graphics[] = []
  private readonly active: Particle[] = []

  constructor() {
    for (let i = 0; i < POOL_SIZE; i++) {
      const g = new Graphics()
      g.visible = false
      this.view.addChild(g)
      this.free.push(g)
    }
  }

  /** 在 (x, y) 爆发一簇粒子。坐标与 app.stage 一致（窗口像素）。 */
  burst(kind: ParticleKind, x: number, y: number, count = 6): void {
    for (let i = 0; i < count; i++) {
      const g = this.free.pop()
      if (!g) break
      drawShape(g, kind)
      const angle = Math.random() * Math.PI * 2
      const speed = 40 + Math.random() * 60
      g.position.set(x, y)
      g.alpha = 1
      g.scale.set(0.8)
      g.rotation = 0
      g.visible = true
      this.active.push({
        g,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 40, // 略微向上抛出
        life: LIFE_MS,
        maxLife: LIFE_MS,
        spin: (Math.random() - 0.5) * 6
      })
    }
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1000
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i]
      p.life -= deltaMs
      if (p.life <= 0) {
        p.g.visible = false
        this.free.push(p.g)
        this.active.splice(i, 1)
        continue
      }
      p.vy += GRAVITY * dt
      p.g.x += p.vx * dt
      p.g.y += p.vy * dt
      p.g.rotation += p.spin * dt
      const ratio = p.life / p.maxLife
      p.g.alpha = ratio
      p.g.scale.set(0.6 + 0.4 * ratio)
    }
  }
}

/** 每个粒子只在取出时绘制一次几何，播放期间只改 transform，避免逐帧重绘。 */
function drawShape(g: Graphics, kind: ParticleKind): void {
  const color = COLORS[kind]
  g.clear()
  if (kind === 'star') {
    g.star(0, 0, 5, 5, 2.2)
    g.fill({ color })
  } else if (kind === 'note') {
    g.circle(0, 0, 3)
    g.fill({ color })
    g.rect(2.4, -10, 1.8, 10)
    g.fill({ color })
    g.roundRect(2.4, -12, 6, 3.6, 1.8)
    g.fill({ color })
  } else if (kind === 'rice') {
    // 米粒：小椭圆，散射时像饭粒四溅
    g.ellipse(0, 0, 3.2, 1.8)
    g.fill({ color })
  } else {
    g.circle(-3, -2, 3.2)
    g.fill({ color })
    g.circle(3, -2, 3.2)
    g.fill({ color })
    g.poly([-6.2, -1, 6.2, -1, 0, 7])
    g.fill({ color })
  }
}
