// 生成 macOS 需要的两种图标。
//
// 1. `build/icon.png`（1024×1024）：electron-builder 在 macOS 上靠它自动生成 .icns。
//    原来 256×256 是给 Windows 的，macOS 要求至少 512，否则打包时报
//    "image size must be at least 512x512"。
//
// 2. `resources/trayTemplate.png` + `@2x`（16 / 32，纯黑剪影）：
//    macOS 菜单栏图标走 Template 规则——系统按 alpha 拿这张图当蒙版，
//    深色菜单栏自动反白、浅色菜单栏保持黑。给彩色 PNG 的话，
//    浅色菜单栏下蓝色鲸鱼娘会糊成一片，看不出来是什么。
//
// 用法：node tools/make-mac-icons.mjs [源帧]
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const src = process.argv[2] ?? 'assets/sprites/idle_normal/idle_normal_01.png'

const trimmed = await sharp(src).trim({ threshold: 1 }).toBuffer()

/** 等比缩进画布中央，四周留透明边。 */
async function centered(size, pad) {
  const inner = size - pad * 2
  const scaled = await sharp(trimmed).resize(inner, inner, { fit: 'inside' }).toBuffer()
  const { width = inner, height = inner } = await sharp(scaled).metadata()
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([
      { input: scaled, left: Math.round((size - width) / 2), top: Math.round((size - height) / 2) }
    ])
    .png()
}

/** Template 图：保留轮廓 alpha，RGB 一律压成纯黑，交给系统当蒙版。 */
async function template(size, pad) {
  const png = await centered(size - pad * 2, 0).then((pipe) => pipe.toBuffer())
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]
    data[i] = 0
    data[i + 1] = 0
    data[i + 2] = 0
    // 半透明边缘压成「有 / 无」，16px 下灰边只会让剪影发虚
    data[i + 3] = alpha > 96 ? 255 : 0
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .resize(size, size, { kernel: 'nearest' })
    .png()
}

mkdirSync(dirname('build/icon.png'), { recursive: true })

// 应用图标：1024 是 macOS 要求的基准尺寸，四周留 4% 呼吸空间（macOS 图标规范）
await (await centered(1024, 40)).toFile('build/icon.png')
console.log('应用图标已生成：build/icon.png（1024×1024）')

// 菜单栏：@1x 16、@2x 32，PAD=1 让剪影尽量占满格子
await (await template(16, 1)).toFile('resources/trayTemplate.png')
await (await template(32, 2)).toFile('resources/trayTemplate@2x.png')
console.log('菜单栏模板图已生成：resources/trayTemplate.png（16）/ @2x.png（32）')
