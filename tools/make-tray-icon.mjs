// 从精灵帧裁出应用/托盘图标：去透明边 → 等比缩到 SIZE 内接 → 居中留 PAD 边距。
// 用法：node tools/make-tray-icon.mjs [源帧] [输出] [尺寸]（安装包图标用 256）
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const src = process.argv[2] ?? 'assets/sprites/idle_normal/idle_normal_01.png'
const out = process.argv[3] ?? 'resources/tray.png'
const SIZE = Number(process.argv[4] ?? 32)
const PAD = Math.max(1, Math.round(SIZE / 32))

// trim 去掉四周透明边，角色才占满图标（否则鲸鱼娘会在 32px 里缩成一个小点）
const trimmed = await sharp(src).trim({ threshold: 1 }).toBuffer()
const scaled = await sharp(trimmed)
  .resize(SIZE - PAD * 2, SIZE - PAD * 2, { fit: 'inside' })
  .toBuffer()
const { width = SIZE, height = SIZE } = await sharp(scaled).metadata()

await mkdirSync(dirname(out), { recursive: true })
await sharp({
  create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
})
  .composite([
    {
      input: scaled,
      left: Math.round((SIZE - width) / 2),
      top: Math.round((SIZE - height) / 2)
    }
  ])
  .png()
  .toFile(out)

console.log(`托盘图标已生成：${out}（${width}×${height} 内容，${SIZE}×${SIZE} 画布）`)
