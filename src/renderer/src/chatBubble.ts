// 聊天气泡：鱼头顶的圆角白底气泡，流式逐字追加，空闲 3s 后淡出（behavior.md 第六节）。
// PixiJS 的 wordWrap 按空格断词对中文无效，这里用离屏 canvas 逐字测量后手动折行。
import { Container, Graphics, Text, TextStyle } from 'pixi.js'

export const BUBBLE_MAX_WIDTH = 240
const PADDING_X = 10
const PADDING_Y = 7
const FONT_SIZE = 13
const LINE_HEIGHT = 19
const RADIUS = 10
const BG_COLOR = 0xffffff
const BORDER_COLOR = 0x9fc2e8
const TEXT_COLOR = 0x1b3a6b
const FONT_FAMILY = '"Microsoft YaHei", "PingFang SC", sans-serif'

/** 空闲多久开始淡出（ms） */
const FADE_DELAY_MS = 3000
const FADE_MS = 400

/** 打字机：逐字显示的基础速度（ms/字）与积压较多时的加速档 */
const TYPING_MS = 40
const TYPING_FAST_MS = 20
const TYPING_BACKLOG = 15

/** 气泡最多显示几行，超出后滚动保留最新（避免挡住角色的脸） */
const MAX_LINES = 6

/**
 * 按最大宽度逐字折行（中文没有空格，必须按字符断）。
 * measure 注入便于单测；measure 接收一行文本、返回像素宽度。
 */
export function wrapCJK(
  text: string,
  maxWidth: number,
  measure: (line: string) => number
): string[] {
  const lines: string[] = []
  for (const rawLine of text.split('\n')) {
    let line = ''
    for (const char of rawLine) {
      const next = line + char
      if (line !== '' && measure(next) > maxWidth) {
        lines.push(line)
        // 换行处若是空格直接丢弃，避免行首缩进
        line = char === ' ' ? '' : char
      } else {
        line = next
      }
    }
    lines.push(line)
  }
  return lines
}

export class ChatBubble {
  /** 原点在气泡底边中心，方便锚定到鱼头顶 */
  readonly view = new Container()

  private readonly bg = new Graphics()
  private readonly label: Text
  private readonly measure: (line: string) => number

  private content = ''
  /** 已收到但还没打出来的增量（打字机队列） */
  private pending = ''
  private revealAcc = 0
  private idleMs = 0
  private readonly anchorX: number
  private readonly anchorY: number

  constructor(anchorX: number, anchorY: number) {
    this.anchorX = anchorX
    this.anchorY = anchorY
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (context) context.font = `${FONT_SIZE}px ${FONT_FAMILY}`
    this.measure = (line: string): number =>
      context ? context.measureText(line).width : line.length * FONT_SIZE

    this.label = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_FAMILY,
        fontSize: FONT_SIZE,
        fill: TEXT_COLOR,
        lineHeight: LINE_HEIGHT,
        wordWrap: false
      })
    })

    this.view.visible = false
    this.view.addChild(this.bg, this.label)
  }

  /** 追加流式增量：先进队列，由 update 按打字机节奏逐字放出 */
  append(delta: string): void {
    this.pending += delta
  }

  /** 整段展示（错误提示等），不做打字机 */
  show(text: string): void {
    this.pending = ''
    this.revealAcc = 0
    this.content = text
    this.layout()
  }

  /** 打字机是否还在输出（talk 状态以此判断何时结束） */
  get isTyping(): boolean {
    return this.pending.length > 0
  }

  clear(): void {
    this.content = ''
    this.pending = ''
    this.revealAcc = 0
    this.label.text = ''
    this.bg.clear()
    this.view.visible = false
    this.idleMs = 0
    this.view.alpha = 1
  }

  update(deltaMs: number): void {
    this.typeTick(deltaMs)
    if (!this.view.visible) return
    this.idleMs += deltaMs
    if (this.idleMs < FADE_DELAY_MS) {
      this.view.alpha = 1
      return
    }
    const fade = Math.min(1, (this.idleMs - FADE_DELAY_MS) / FADE_MS)
    this.view.alpha = 1 - fade
    if (fade >= 1) this.view.visible = false
  }

  /** 按固定间隔把队列里的字逐个放进气泡；积压较多时加快，避免落后太多 */
  private typeTick(deltaMs: number): void {
    if (this.pending === '') return
    this.revealAcc += deltaMs
    const interval = this.pending.length > TYPING_BACKLOG ? TYPING_FAST_MS : TYPING_MS
    let revealed = false
    while (this.revealAcc >= interval && this.pending !== '') {
      this.revealAcc -= interval
      this.content += this.pending[0]
      this.pending = this.pending.slice(1)
      revealed = true
    }
    if (revealed) this.layout()
  }

  private layout(): void {
    if (this.content === '') {
      this.view.visible = false
      return
    }

    const allLines = wrapCJK(this.content, BUBBLE_MAX_WIDTH - PADDING_X * 2, this.measure)
    // 行数过多时只保留最新的几行，气泡不会一路长到盖住角色的脸
    const lines = allLines.length > MAX_LINES ? allLines.slice(-MAX_LINES) : allLines
    this.label.text = lines.join('\n')

    const textWidth = lines.reduce((max, line) => Math.max(max, this.measure(line)), 0)
    const width = Math.min(BUBBLE_MAX_WIDTH, textWidth + PADDING_X * 2)
    const height = lines.length * LINE_HEIGHT + PADDING_Y * 2

    this.label.position.set(-width / 2 + PADDING_X, -height + PADDING_Y)

    this.bg.clear()
    this.bg.roundRect(-width / 2, -height, width, height, RADIUS).fill({ color: BG_COLOR, alpha: 0.95 })
    this.bg
      .roundRect(-width / 2, -height, width, height, RADIUS)
      .stroke({ color: BORDER_COLOR, width: 1, alpha: 0.9 })
    // 指向鱼头顶的小尾巴
    this.bg.poly([-5, -1, 5, -1, 0, 8]).fill({ color: BG_COLOR, alpha: 0.95 })

    this.view.position.set(this.anchorX, this.anchorY)
    this.view.visible = true
    this.view.alpha = 1
    this.idleMs = 0
  }
}
