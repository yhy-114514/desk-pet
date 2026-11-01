/**
 * 扫描 assets/sprites/ 生成 assets/manifest.json。
 * 帧命名: {state}_{expression}/{state}_{expression}_{seq}.png
 *
 * 用法: node tools/scan-frames.mjs [sprites_dir] [out_file]
 */

import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_SPRITES = 'assets/sprites'
const DEFAULT_OUT = 'assets/manifest.json'

// 帧率按状态约定（assets-spec 第三节），未列出的用 8
const FPS_BY_STATE = { talk: 12, idle: 8, swim: 8, sleep: 6, drag: 10, eat: 10, happy: 8 }

// 优先级（behavior.md：talk > awake > drag > happy > swim > idle）
const PRIORITY = { talk: 5, awake: 4, drag: 3, happy: 2, swim: 1, idle: 0 }

// 循环接缝淡化比例（末帧→首帧）。视频抽帧组首尾并不严格一致，
// 直接循环会跳；给一个占比抹平接缝，不裁帧。缺省 0（硬切）。
const GROUP_LOOP_FADE = {
  happy_normal: 0.75,
  happy_pet: 0.75,
  idle_normal: 0.75,
  talk_normal: 0.75,
  swim_normal: 0.75,
  sad_normal: 0.75,
  // 四段情绪表演：源视频是「站姿→表情→保持→回站姿」的完整回环，首尾一致
  angry_normal: 0.75,
  surprised_normal: 0.75,
  shy_normal: 0.75,
  smug_normal: 0.75,
  // 四段「持续态」：各自视频里是设计好可自然循环的中段
  drag_normal: 0.75,
  eat_normal: 0.75,
  sleep_normal: 0.75,
  awake_normal: 0.75
}
// 一次性组：播完停在末帧，不循环（进出场过渡、单次眨眼/哈欠/翻白眼）。
const GROUP_LOOP = {
  swim_enter: false,
  swim_exit: false,
  idle_blink: false,
  idle_yawn: false,
  idle_done: false,
  idle_stretch: false,
  idle_scratch: false,
  idle_zone: false,
  idle_mumble: false,
  drag_enter: false,
  drag_exit: false,
  eat_enter: false,
  eat_exit: false,
  sleep_enter: false,
  sleep_exit: false,
  awake_enter: false,
  awake_exit: false
}
// 组级 fps 覆盖：eat_normal 的期待循环源素材仅 6 帧（0.25s），
// 抽帧时已用 --speed=0.5 放慢到 0.5s，按 12fps 取满 6 帧，循环更自然。
// swim_enter 源视频 4s 过渡，抽帧时已 --speed=2 压到 2s，按 16fps 播满 32 帧保持顺滑。
const GROUP_FPS = {
  eat_normal: 12,
  swim_enter: 16
}
// 逐帧停留时长（ms），用于覆盖按 fps 的匀速播放。真人眨眼是非对称的：
// 闭眼快（帧2–6，约 310ms）→ 全睁回升稍慢（帧7–8），总约 700ms。
// 数组长度必须等于帧数，否则跳过（回退到 fps）。
const GROUP_DURATIONS = {
  idle_blink: [90, 80, 60, 60, 60, 70, 120, 160]
}

const FRAME_RE = /^(.+)_(\d{2})$/

async function main() {
  const spritesDir = process.argv[2] ?? DEFAULT_SPRITES
  const outFile = process.argv[3] ?? DEFAULT_OUT

  const groups = {}
  const dirs = (await readdir(spritesDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

  for (const dir of dirs) {
    const files = (await readdir(path.join(spritesDir, dir)))
      .filter((f) => f.endsWith('.png'))
      .sort((a, b) => {
        // 按两位序号数字排序，而不是字母序
        const na = Number(a.match(FRAME_RE)?.[2] ?? 0)
        const nb = Number(b.match(FRAME_RE)?.[2] ?? 0)
        return na - nb
      })

    if (files.length < 2) {
      console.warn(`跳过 ${dir}: 帧数 ${files.length} < 2`)
      continue
    }
    for (const f of files) {
      if (!FRAME_RE.test(path.basename(f, '.png'))) {
        throw new Error(`帧命名不合规: ${dir}/${f}（应为 {group}_{两位序号}.png）`)
      }
    }

    const state = dir.split('_')[0]
    const group = {
      frames: files,
      fps: GROUP_FPS[dir] ?? FPS_BY_STATE[state] ?? 8,
      loop: GROUP_LOOP[dir] ?? true,
      priority: PRIORITY[state] ?? 0
    }
    const loopFade = GROUP_LOOP_FADE[dir]
    if (loopFade) group.loopFade = loopFade
    const durations = GROUP_DURATIONS[dir]
    if (durations) {
      if (durations.length !== files.length) {
        throw new Error(
          `${dir}: durations 长度 ${durations.length} ≠ 帧数 ${files.length}，请同步 GROUP_DURATIONS`
        )
      }
      group.durations = durations
    }
    groups[dir] = group
    console.log(`${dir}: ${files.length} 帧, ${groups[dir].fps}fps, priority=${groups[dir].priority}`)
  }

  const manifest = {
    version: 1,
    canvas: { width: 512, height: 512, anchor: 'foot-center' },
    groups
  }
  await writeFile(outFile, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`已写入 ${outFile}（${Object.keys(groups).length} 组）`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
