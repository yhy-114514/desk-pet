/**
 * 把 assets/sprites/ 下的帧打包成 PixiJS 可用的 sprite sheet。
 * 每组输出一张 atlas：assets/atlas/{group}.png + {group}.json（TexturePacker hash 格式）。
 *
 * 为什么每组一张：单张 4096×4096 最多放 7×7=49 帧，而视频抽帧后总帧数远超这个量。
 * 分组打包同时避免了一次性把所有帧塞进一张超大纹理（超过 WebGL 上限）。
 *
 * 用法: node tools/pack-atlas.mjs [sprites_dir] [atlas_dir]
 */

import { readdir, mkdir, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const DEFAULT_SPRITES = 'assets/sprites'
const DEFAULT_ATLAS = 'assets/atlas'
// 4096 是 WebGL2 保证支持的最小纹理上限。
const MAX_WIDTH = 4096
const PADDING = 2

async function packGroup(atlasDir, group, files, spritesDir) {
  const frames = []
  for (const file of files) {
    const filePath = path.join(spritesDir, group, file)
    const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    frames.push({ name: file, data, width: info.width, height: info.height })
  }

  // shelf packing：逐行摆放，行宽超限则换行
  const placed = []
  let x = 0
  let y = 0
  let rowHeight = 0
  let sheetWidth = 0
  for (const frame of frames) {
    if (x > 0 && x + frame.width + PADDING > MAX_WIDTH) {
      x = 0
      y += rowHeight + PADDING
      rowHeight = 0
    }
    placed.push({ ...frame, x, y })
    sheetWidth = Math.max(sheetWidth, x + frame.width)
    rowHeight = Math.max(rowHeight, frame.height)
    x += frame.width + PADDING
  }
  const sheetHeight = y + rowHeight

  const atlasJson = {
    frames: {},
    meta: {
      app: 'desk-pet',
      version: '1.0',
      image: `${group}.png`,
      format: 'RGBA8888',
      size: { w: sheetWidth, h: sheetHeight },
      scale: '1'
    }
  }
  for (const f of placed) {
    atlasJson.frames[f.name] = {
      frame: { x: f.x, y: f.y, w: f.width, h: f.height },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: f.width, h: f.height },
      sourceSize: { w: f.width, h: f.height }
    }
  }

  const sheet = await sharp({
    create: {
      width: sheetWidth,
      height: sheetHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite(
      placed.map((f) => ({
        input: f.data,
        raw: { width: f.width, height: f.height, channels: 4 },
        left: f.x,
        top: f.y
      }))
    )
    .png()
    .toBuffer()

  await sharp(sheet).toFile(path.join(atlasDir, `${group}.png`))
  await writeFile(path.join(atlasDir, `${group}.json`), `${JSON.stringify(atlasJson, null, 2)}\n`)
  console.log(`${group}: ${frames.length} 帧 -> ${sheetWidth}x${sheetHeight}`)
}

async function main() {
  const spritesDir = process.argv[2] ?? DEFAULT_SPRITES
  const atlasDir = process.argv[3] ?? DEFAULT_ATLAS
  await mkdir(atlasDir, { recursive: true })

  const dirs = (await readdir(spritesDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

  for (const dir of dirs) {
    const files = (await readdir(path.join(spritesDir, dir))).filter((f) => f.endsWith('.png')).sort()
    if (files.length === 0) continue
    await packGroup(atlasDir, dir, files, spritesDir)
  }

  // 清理旧版单张 atlas（已改为每组一张），避免渲染端误加载
  for (const legacy of ['pet.png', 'pet.json']) {
    await unlink(path.join(atlasDir, legacy)).catch(() => {})
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
