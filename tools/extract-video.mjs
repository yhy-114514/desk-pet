/**
 * 视频抽帧：把动作循环视频按固定 fps 抽成逐帧白底 PNG。
 * 输出命名: {group}_{两位序号}.png（如 happy_normal_01.png）
 *
 * 用法: node tools/extract-video.mjs <video> <out_dir> <fps> <group> [--trim-frames=a:b] [--speed=2]
 * 例:   node tools/extract-video.mjs assets/p1-happy/happy.mp4 assets/p1-happy/frames 8 happy_normal
 *
 * --trim-frames=a:b  只取源视频第 a..b-1 帧（源视频 24fps，AI 生成常超出目标时长，需裁剪）
 * --speed=2          抽帧前把片段加速 2 倍（配合裁剪把过长的过渡压回 1–1.5s）
 */

import { spawn } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'

function run(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: 'inherit' })
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))))
  })
}

async function main() {
  const [video, outDir, fpsArg, group, ...flags] = process.argv.slice(2)
  if (!video || !outDir || !fpsArg || !group) {
    console.error(
      '用法: node tools/extract-video.mjs <video> <out_dir> <fps> <group> [--trim-frames=a:b] [--speed=2]'
    )
    process.exit(1)
  }
  const fps = Number(fpsArg)
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`fps 非法: ${fpsArg}`)

  const trimArg = flags.find((f) => f.startsWith('--trim-frames='))?.split('=')[1]
  const speedArg = flags.find((f) => f.startsWith('--speed='))?.split('=')[1]
  const speed = speedArg === undefined ? 1 : Number(speedArg)
  if (!Number.isFinite(speed) || speed <= 0) throw new Error(`speed 非法: ${speedArg}`)

  const filters = []
  if (trimArg) {
    const [start, end] = trimArg.split(':').map(Number)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
      throw new Error(`trim-frames 非法: ${trimArg}（应为 a:b，且 0 ≤ a < b）`)
    }
    filters.push(`trim=start_frame=${start}:end_frame=${end}`)
  }
  if (trimArg || speed !== 1) filters.push(`setpts=(PTS-STARTPTS)/${speed}`)
  filters.push(`fps=${fps}`)

  await mkdir(outDir, { recursive: true })
  await run([
    '-y',
    '-i', video,
    '-an', // 抽帧不需要音轨
    '-vf', filters.join(','),
    '-start_number', '1',
    path.join(outDir, `${group}_%02d.png`)
  ])

  const count = (await readdir(outDir)).filter((f) => f.startsWith(`${group}_`) && f.endsWith('.png')).length
  console.log(`抽帧完成: ${count} 帧 @ ${fps}fps -> ${outDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
