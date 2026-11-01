/**
 * 生成点击命中掩码：assets/hitmask.json
 *
 * 透明窗口默认不拦截鼠标，渲染进程用「当前帧的实际像素掩码」判断指针是否在角色身上：
 * 在角色上 → 关闭穿透（可拖动），在透明区（含发丝/尾巴间空隙）→ 开启穿透（点击落到桌面）。
 *
 * 每组逐帧生成 MASK_SIZE×MASK_SIZE 掩码（缩放后 alpha > 阈值即命中），1 bit/像素按行优先位打包，
 * base64 编码后按 manifest 的帧顺序输出数组。
 *
 * 掩码只用于「指针是否落在角色身上」，角色在屏上约 287px，128 的精度绰绰有余；
 * 按 512 存是 820 帧 × 32KB ≈ 35MB，每个窗口（含配置窗）都要解析一遍，纯属浪费。
 *
 * 用法: node tools/build-hitmask.mjs [sprites_dir] [out_file]
 */

import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const DEFAULT_SPRITES = 'assets/sprites'
const DEFAULT_OUT = 'assets/hitmask.json'
const CANVAS = 512
/** 掩码边长；渲染端按 CANVAS / MASK_SIZE 换算坐标 */
const MASK_SIZE = 128
/** 缩放后像素是 4×4 块的平均 alpha，阈值取低一些，免得发丝/尾巴尖缩没了 */
const ALPHA_THRESHOLD = 48
const BYTES = Math.ceil((MASK_SIZE * MASK_SIZE) / 8)

async function main() {
  const spritesDir = process.argv[2] ?? DEFAULT_SPRITES
  const outFile = process.argv[3] ?? DEFAULT_OUT

  const dirs = (await readdir(spritesDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

  const groups = {}
  for (const dir of dirs) {
    // 与 scan-frames 一致的两位序号排序，保证掩码数组下标 == manifest 帧下标
    const frames = (await readdir(path.join(spritesDir, dir)))
      .filter((f) => f.toLowerCase().endsWith('.png'))
      .sort((a, b) => {
        const na = Number(a.match(/_(\d{2})\.png$/)?.[1] ?? 0)
        const nb = Number(b.match(/_(\d{2})\.png$/)?.[1] ?? 0)
        return na - nb
      })
    if (frames.length === 0) continue

    const masks = []
    for (const frame of frames) {
      const image = sharp(path.join(spritesDir, dir, frame))
      // 先校验原始帧尺寸：resize 用的是 fit:'fill'，非 512 的帧会被拉变形，掩码就错位了
      const meta = await image.metadata()
      if (meta.width !== CANVAS || meta.height !== CANVAS) {
        throw new Error(`${dir}/${frame}: 尺寸 ${meta.width}x${meta.height}，应为 ${CANVAS}x${CANVAS}`)
      }
      const { data } = await image
        .ensureAlpha()
        .resize(MASK_SIZE, MASK_SIZE, { fit: 'fill', kernel: 'lanczos3' })
        .raw()
        .toBuffer({ resolveWithObject: true })
      const mask = new Uint8Array(BYTES)
      for (let p = 0; p < MASK_SIZE * MASK_SIZE; p++) {
        if (data[p * 4 + 3] > ALPHA_THRESHOLD) mask[p >> 3] |= 1 << (7 - (p & 7))
      }
      masks.push(Buffer.from(mask).toString('base64'))
    }
    groups[dir] = masks
    console.log(`${dir}: ${frames.length} 帧掩码`)
  }

  await writeFile(outFile, `${JSON.stringify(groups)}\n`)
  console.log(`已写入 ${outFile}（${Object.keys(groups).length} 组）`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
