/**
 * 后处理：rembg 透明 PNG -> 512x512 规范化帧。
 *
 * 处理内容：
 *  1. 去白边：rembg 的边缘像素仍是「白底混合色」，按 F = (C - 255*(1-a)) / a 反混合
 *  2. 连通域去噪：删除面积极小的孤立分量（残留文字/杂点）
 *  3. 统一缩放：全批帧共用同一 scale（按最高头顶→最低脚底的总跨度），
 *     既避免跨组大小跳变，也保证腾空帧头顶不溢出画幅
 *  4. 定位：水平用「组内统一锚点」（各帧头部中心 x 的中位数）对齐到画幅中心，垂直按
 *     「组内最低帧贴画幅底边」对齐，保留跳起帧的离地高度。用头部而非脚部：鲸尾常垂到
 *     bbox 底部，脚部中心会被尾巴带偏，导致跨组切换时角色左右跳。
 *     素材自身逐帧有整体漂移时（AI 生成的短片段常见），用 ANCHOR_X=drift 拿剪影做互相关
 *     逐帧抵消；组内统一锚点抹不掉帧与帧之间的相对平移，播放时就是左右晃。
 *  5. 颜色匹配：各组视频颜色有偏差，在 Lab 空间把本组角色像素均值平移到基准组
 *     （默认 happy_normal，可用 COLOR_REF_GROUP 覆盖），消除跨组跳色。
 *
 * 用法: node tools/process-frames.mjs <cut_dir> <out_dir> [prefix]
 */

import { readdir, mkdir } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const CANVAS = 512
const TOP_MARGIN = 8 // 画幅顶部留白（腾空帧头顶也要放得下）
const BOTTOM_MARGIN = 4 // 组内最低帧距画幅底边的留白
const ALPHA_THRESHOLD = 8 // 低于此 alpha 视为透明，参与 bbox / 连通域判断
const NOISE_RATIO = 0.05 // 面积小于最大分量的 5% 则视为噪点
// 顶边被裁的帧（源视频里从画外伸入的道具，如抚摸的手）只用于输出，不计入组内统计：
// 它们的 bbox 顶边贴在源图边缘，会把「最高→最低」跨度与头部锚点一起污染。
// 实测 happy_pet 的手贴顶：角色被缩小 11%、整体左移约 70px。
const TOP_CLIP_PX = 2
// 可选：按「角色中位高度」统一缩放（跨组一致）。不同来源分辨率/动作幅度下，
// 仅按本组跨度算 scale 会让角色在切换动画时忽大忽小。
const TARGET_HEIGHT = Number(process.env.TARGET_HEIGHT ?? 0)
// 可选：同一动作的 enter / normal / exit 三段一起处理时，用 SEGMENT_STATE=<state> 让三组
// 共享「缩放、水平锚点、垂直基线」。分段各自归一化时，姿势变化会改变 bbox 高度（例如
// 拖拽悬空时腿收起、睡觉蜷缩），导致切换瞬间角色忽大忽小、上下跳。
const SEGMENT_STATE = process.env.SEGMENT_STATE ?? ''
// 水平锚定方式：
//  head（默认）——整组共用一个锚点（各帧头心 x 的中位数）。动作幅度大、相机固定的素材够用。
//  drift——逐帧按「整体平移」对齐（给 AI 生成的短片段用）。这类素材里模型逐帧重画会把整个人
//  物横移十几像素，不是动作而是漂移：组内统一锚点抹不掉（播放时肉眼可见地左右晃），
//  按脚/按肤色质心也不行——脚被垂到底部的鲸尾带偏、脸被手和刘海带偏，实测把一个 33px 的
//  摆动「校正」进去反而更晃。这里改成拿每帧的 alpha 剪影跟组内首帧做归一化互相关，
//  直接测整体平移量再反向抵消：剪影是整段动作里最稳定的部分，比任何质心都靠得住。
const ANCHOR_X = process.env.ANCHOR_X ?? 'head'
const DRIFT_SEARCH_RATIO = 0.12 // 搜索窗：组内 bbox 宽度的 ±12%
const DRIFT_SAMPLE_STEP = 3 // 互相关采样步长（源像素），只为提速
const DRIFT_MIN_SCORE = 0.5 // 相关系数低于此值视为没锁上，交给相邻帧插值

/** 反白底混合，去掉 rembg 残留的白色光晕 */
function despillWhite(data) {
  for (let i = 0; i < data.length; i += 4) {
    let a = data[i + 3] / 255
    if (a <= 0.08) {
      data[i + 3] = 0
      continue
    }
    for (let c = 0; c < 3; c++) {
      const v = (data[i + c] - 255 * (1 - a)) / a
      data[i + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
    }
  }
}

// ---- 颜色匹配（Lab 空间均值平移）----
// 各组视频由 AI 独立生成，白平衡/亮度有偏差（实测亮度差约 3、蓝色饱和度差约 3）。
// 在 Lab 空间把每组角色像素的平均色调平移到基准组，消除切换动作时的跳色。
// 只平移均值、不缩标准差：保留组内明暗对比，避免过曝/色带。
const SRGB_TO_LINEAR = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

const LAB_D = 6 / 29
const labF = (t) => (t > LAB_D ** 3 ? Math.cbrt(t) : t / (3 * LAB_D * LAB_D) + 4 / 29)
const labFInv = (t) => (t > LAB_D ? t ** 3 : 3 * LAB_D * LAB_D * (t - 4 / 29))

/** sRGB(0-255) -> Lab（D65） */
function rgbToLab(r, g, b) {
  const rl = SRGB_TO_LINEAR[r]
  const gl = SRGB_TO_LINEAR[g]
  const bl = SRGB_TO_LINEAR[b]
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl
  const z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / 1.08883
  const fx = labF(x)
  const fy = labF(y)
  const fz = labF(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** Lab -> sRGB(0-255)，超出色域时逐通道 clamp */
function labToRgb(L, a, b) {
  const fy = (L + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const x = 0.95047 * labFInv(fx)
  const y = labFInv(fy)
  const z = 1.08883 * labFInv(fz)
  const rl = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z
  const gl = -0.969266 * x + 1.8760108 * y + 0.041556 * z
  const bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z
  const toSrgb = (v) => {
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
    return Math.round(Math.min(1, Math.max(0, c)) * 255)
  }
  return [toSrgb(rl), toSrgb(gl), toSrgb(bl)]
}

/** 统计 bbox 内角色像素的 Lab 累加值（供按组求均值） */
function labAccumulate(data, width, bbox) {
  let sumL = 0
  let sumA = 0
  let sumB = 0
  let count = 0
  for (let y = bbox.minY; y <= bbox.maxY; y++) {
    for (let x = bbox.minX; x <= bbox.maxX; x++) {
      const i = (y * width + x) * 4
      if (data[i + 3] <= ALPHA_THRESHOLD) continue
      const [L, a, b] = rgbToLab(data[i], data[i + 1], data[i + 2])
      sumL += L
      sumA += a
      sumB += b
      count++
    }
  }
  return { sumL, sumA, sumB, count }
}

/** 把 bbox 内角色像素的 Lab 均值平移到目标（原地修改 RGB） */
function matchColor(data, width, bbox, src, target) {
  const dL = target.L - src.L
  const dA = target.a - src.a
  const dB = target.b - src.b
  if (Math.abs(dL) < 0.01 && Math.abs(dA) < 0.01 && Math.abs(dB) < 0.01) return
  for (let y = bbox.minY; y <= bbox.maxY; y++) {
    for (let x = bbox.minX; x <= bbox.maxX; x++) {
      const i = (y * width + x) * 4
      if (data[i + 3] <= ALPHA_THRESHOLD) continue
      const [L, a, b] = rgbToLab(data[i], data[i + 1], data[i + 2])
      const [r, g, bl] = labToRgb(Math.min(100, Math.max(0, L + dL)), a + dA, b + dB)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = bl
    }
  }
}

/** alpha > 阈值的像素包围盒 */
function alphaBBox(data, width, height) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > ALPHA_THRESHOLD) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * 头部区域（bbox 顶部 20%）的 alpha 加权中心 x，作为整组的水平锚点。
 * 不能用「脚部中心」：鲸尾会垂到 bbox 底部（浮动帧更是只有尾巴在最下方），
 * 脚部区域实际测到的是尾巴，会把角色整体锚偏（swim/sad 曾因此偏 40–70px）。
 * 头部是各动作里最稳定的身体轴线；取组内中位数可排除眨眼/跳跃时的瞬时偏移。
 */
function headCenterX(data, width, bbox) {
  const endY = bbox.minY + Math.max(1, Math.floor(bbox.height * 0.2))
  let sum = 0
  let weight = 0
  for (let y = bbox.minY; y < endY; y++) {
    for (let x = bbox.minX; x <= bbox.maxX; x++) {
      const a = data[(y * width + x) * 4 + 3]
      if (a > ALPHA_THRESHOLD) {
        sum += x * a
        weight += a
      }
    }
  }
  return weight > 0 ? sum / weight : (bbox.minX + bbox.maxX) / 2
}

/**
 * 逐帧整体平移量（ANCHOR_X=drift）：拿每帧 alpha 剪影跟组内首帧做归一化互相关，
 * 返回「把该帧往右移多少源像素才能跟首帧对齐」。统计区域只取躯干+头
 * （组内 bbox 的纵向 85%、以中心为轴左右各 30% 宽度），把摆动的鲸尾排除在外。
 * 相关系数太低（没锁上）的帧返回 null，由调用方按相邻帧插值。
 */
function estimateDrift(frames) {
  const w = frames[0].width
  const h = frames[0].height
  if (frames.some((f) => f.width !== w || f.height !== h)) {
    console.warn('  源帧尺寸不一致，跳过漂移对齐')
    return null
  }
  let minX = Infinity
  let maxX = -Infinity
  let top = Infinity
  let bottom = -Infinity
  for (const f of frames) {
    minX = Math.min(minX, f.bbox.minX)
    maxX = Math.max(maxX, f.bbox.maxX)
    top = Math.min(top, f.bbox.minY)
    bottom = Math.max(bottom, f.bbox.maxY)
  }
  const axis = (minX + maxX) / 2
  const bw = maxX - minX + 1
  const x0 = Math.max(0, Math.round(axis - bw * 0.3))
  const x1 = Math.min(w, Math.round(axis + bw * 0.3))
  const y0 = Math.max(0, top)
  const y1 = Math.min(h, Math.round(top + (bottom - top + 1) * 0.85))
  const maxD = Math.max(4, Math.round(bw * DRIFT_SEARCH_RATIO))

  const xs = []
  const ys = []
  for (let y = y0; y < y1; y += DRIFT_SAMPLE_STEP) {
    for (let x = x0; x < x1; x += DRIFT_SAMPLE_STEP) {
      xs.push(x)
      ys.push(y)
    }
  }
  const n = xs.length
  const ref = new Float32Array(n)
  for (let i = 0; i < n; i++) ref[i] = frames[0].data[(ys[i] * w + xs[i]) * 4 + 3]
  let sa = 0
  let sa2 = 0
  for (let i = 0; i < n; i++) {
    sa += ref[i]
    sa2 += ref[i] * ref[i]
  }
  const refMean = sa / n
  const refVar = sa2 / n - refMean * refMean
  if (refVar <= 1e-6) return null

  return frames.map((f, idx) => {
    if (idx === 0) return 0
    const data = f.data
    let best = { dx: 0, score: -2 }
    for (let dx = -maxD; dx <= maxD; dx++) {
      let sb = 0
      let sb2 = 0
      let sab = 0
      for (let i = 0; i < n; i++) {
        const x = xs[i] - dx // dx 取正 = 该帧内容偏左，需要往右挪 dx 才对得上首帧
        if (x < 0 || x >= w) continue
        const v = data[(ys[i] * w + x) * 4 + 3]
        sb += v
        sb2 += v * v
        sab += ref[i] * v
      }
      const mean = sb / n
      const variance = sb2 / n - mean * mean
      if (variance <= 1e-6) continue
      const score = (sab / n - refMean * mean) / Math.sqrt(refVar * variance)
      if (score > best.score) best = { dx, score }
    }
    if (best.score < DRIFT_MIN_SCORE) return null
    return best.dx
  })
}

/** 8 连通域标记，删除小面积分量（原地修改 alpha） */
function removeSpecks(data, width, height) {
  const labels = new Int32Array(width * height).fill(-1)
  const sizes = []
  const stack = []
  for (let start = 0; start < width * height; start++) {
    if (labels[start] !== -1 || data[start * 4 + 3] <= ALPHA_THRESHOLD) continue
    const label = sizes.length
    let size = 0
    labels[start] = label
    stack.push(start)
    while (stack.length) {
      const p = stack.pop()
      size++
      const px = p % width
      const py = (p / width) | 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx
          const ny = py + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const q = ny * width + nx
          if (labels[q] !== -1 || data[q * 4 + 3] <= ALPHA_THRESHOLD) continue
          labels[q] = label
          stack.push(q)
        }
      }
    }
    sizes.push(size)
  }
  if (sizes.length === 0) return 0
  const maxSize = Math.max(...sizes)
  let removed = 0
  for (let p = 0; p < width * height; p++) {
    const label = labels[p]
    if (label !== -1 && sizes[label] < maxSize * NOISE_RATIO) {
      data[p * 4 + 3] = 0
      removed++
    }
  }
  return removed
}

async function loadFrame(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  despillWhite(data)
  const bbox = alphaBBox(data, info.width, info.height)
  if (!bbox) throw new Error(`帧全透明: ${file}`)
  const headX = headCenterX(data, info.width, bbox)
  const lab = labAccumulate(data, info.width, bbox)
  const clipped = bbox.minY <= TOP_CLIP_PX
  return { file, data, width: info.width, height: info.height, bbox, headX, lab, clipped }
}

async function main() {
  // filter 可选：只处理文件名以该前缀开头的帧（如 happy_），用于单组迭代，
  // 避免不同来源分辨率的遗留帧混入统一缩放。
  const [cutDir, outDir, filter] = process.argv.slice(2)
  if (!cutDir || !outDir) {
    console.error('用法: node tools/process-frames.mjs <cut_dir> <out_dir> [prefix]')
    process.exit(1)
  }

  const files = (await readdir(cutDir))
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .filter((f) => !filter || f.startsWith(filter))
    .sort()
  const frames = []
  for (const f of files) frames.push(await loadFrame(path.join(cutDir, f)))
  // 尺寸 / 锚点统计只看未被画外道具污染的帧；可靠帧过少时回退到全部帧
  const clean = frames.filter((f) => !f.clipped)
  const statFrames = clean.length >= 3 && clean.length >= frames.length * 0.2 ? clean : frames
  if (clean.length !== frames.length) {
    console.log(`统计剔除 ${frames.length - clean.length} 帧顶边被裁（道具入镜），仅用于输出`)
  }

  // 统一 scale：按整组「最高头顶 → 最低脚底」的总跨度归一化。
  // 不能用中位高度——它会忽略跳跃离地量，导致腾空帧头顶溢出画幅。
  const minTop = Math.min(...statFrames.map((f) => f.bbox.minY))
  const maxBottom = Math.max(...statFrames.map((f) => f.bbox.maxY))
  const span = maxBottom - minTop + 1
  const spanScale = (CANVAS - TOP_MARGIN - BOTTOM_MARGIN) / span
  // 有 TARGET_HEIGHT 时按角色中位高度归一，并用本组跨度兜底防溢出：
  // 中位 bbox 高度代表角色自身大小（不受起跳/漂浮位移影响），跨组切换才不会变大小。
  const heights = statFrames.map((f) => f.bbox.height).sort((a, b) => a - b)
  const medianHeight = heights[Math.floor(heights.length / 2)]
  // 分段共享缩放时以「进入段首帧」（参考站姿）为基准，避免姿势变化污染中位高度。
  const standing = SEGMENT_STATE
    ? frames.find((f) => path.basename(f.file) === `${SEGMENT_STATE}_enter_01.png`)
    : null
  const refHeight = standing ? standing.bbox.height : medianHeight
  const targetScale = TARGET_HEIGHT > 0 ? TARGET_HEIGHT / refHeight : spanScale
  const scale = Math.min(targetScale, spanScale)
  console.log(
    `统一缩放: span=${span} medianHeight=${medianHeight}` +
      (standing ? ` 站姿高度=${refHeight}` : '') +
      ` scale=${scale.toFixed(4)}` +
      (TARGET_HEIGHT > 0 ? `（目标高度 ${TARGET_HEIGHT}px）` : '')
  )

  // 组内基线：bbox 底边最低（最接地）的帧决定画幅底边。
  // 水平锚点：组内各帧头心 x 的中位数（不被个别眨眼/跳跃帧带偏）。
  const groupBottom = new Map()
  const groupHeadXs = new Map()
  // 分段共享时整批用同一个锚点 key（见 SEGMENT_STATE），输出目录仍按原组名。
  for (const f of frames) {
    const group = SEGMENT_STATE || path.basename(f.file, '.png').replace(/_\d+$/, '')
    groupBottom.set(group, Math.max(groupBottom.get(group) ?? 0, f.bbox.maxY))
  }
  for (const f of statFrames) {
    const group = SEGMENT_STATE || path.basename(f.file, '.png').replace(/_\d+$/, '')
    if (!groupHeadXs.has(group)) groupHeadXs.set(group, [])
    groupHeadXs.get(group).push(f.headX)
  }
  const groupAnchorX = new Map()
  for (const [group, xs] of groupHeadXs) {
    xs.sort((a, b) => a - b)
    const mid = xs.length >> 1
    groupAnchorX.set(group, xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2)
  }

  // 逐帧漂移（ANCHOR_X=drift）：每帧相对组内首帧的整体平移量，输出到一半时把位移加回去。
  // 没锁上的帧（null）用左右最近的可靠帧线性插值，避免一帧不动、周围都在动的突兀跳变。
  const frameDriftX = new Map()
  if (ANCHOR_X === 'drift') {
    const byGroup = new Map()
    for (const f of frames) {
      const group = SEGMENT_STATE || path.basename(f.file, '.png').replace(/_\d+$/, '')
      if (!byGroup.has(group)) byGroup.set(group, [])
      byGroup.get(group).push(f)
    }
    for (const [group, groupFrames] of byGroup) {
      const raw = estimateDrift(groupFrames)
      if (!raw) {
        console.warn(`${group}: 漂移对齐不可用，回退组内统一锚点`)
        continue
      }
      const known = raw.map((v, i) => (v === null ? null : i)).filter((i) => i !== null)
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== null) continue
        const prev = [...known].reverse().find((k) => k < i)
        const next = known.find((k) => k > i)
        const value =
          prev !== undefined && next !== undefined
            ? raw[prev] + ((raw[next] - raw[prev]) * (i - prev)) / (next - prev)
            : prev !== undefined
              ? raw[prev]
              : next !== undefined
                ? raw[next]
                : 0
        console.warn(`  ${path.basename(groupFrames[i].file)}: 互相关没锁上，按相邻帧插值 ${value}px`)
        raw[i] = value
      }
      groupFrames.forEach((f, i) => frameDriftX.set(f.file, raw[i]))
      const spread = Math.max(...raw) - Math.min(...raw)
      console.log(`drift 对齐 ${group}: 整体平移 ${spread.toFixed(0)}px（相对首帧）-> 已抵消`)
    }
  }

  // 颜色匹配目标：默认把各组角色像素的 Lab 均值对齐到 happy_normal（已验收组），
  // 可用 COLOR_REF_GROUP 改为其它组。基准组缺失时跳过匹配，不阻断管线。
  const groupLabSum = new Map()
  for (const f of frames) {
    const group = path.basename(f.file, '.png').replace(/_\d+$/, '')
    if (!groupLabSum.has(group)) groupLabSum.set(group, { sumL: 0, sumA: 0, sumB: 0, count: 0 })
    const acc = groupLabSum.get(group)
    acc.sumL += f.lab.sumL
    acc.sumA += f.lab.sumA
    acc.sumB += f.lab.sumB
    acc.count += f.lab.count
  }
  const groupLab = new Map()
  for (const [group, acc] of groupLabSum) {
    groupLab.set(group, {
      L: acc.sumL / acc.count,
      a: acc.sumA / acc.count,
      b: acc.sumB / acc.count
    })
  }
  const refGroup = process.env.COLOR_REF_GROUP ?? 'happy_normal'
  let targetLab = groupLab.get(refGroup) ?? null
  if (!targetLab) {
    // 逐组处理（prefix 过滤）时当前批次不含基准组：单独扫描 cutDir 里的基准帧统计
    const refFiles = (await readdir(cutDir))
      .filter((f) => f.toLowerCase().endsWith('.png') && f.startsWith(`${refGroup}_`))
      .sort()
    if (refFiles.length > 0) {
      let sumL = 0
      let sumA = 0
      let sumB = 0
      let count = 0
      for (const f of refFiles) {
        const frame = await loadFrame(path.join(cutDir, f))
        sumL += frame.lab.sumL
        sumA += frame.lab.sumA
        sumB += frame.lab.sumB
        count += frame.lab.count
      }
      if (count > 0) targetLab = { L: sumL / count, a: sumA / count, b: sumB / count }
    }
  }
  if (targetLab) {
    console.log(
      `颜色基准 ${refGroup}: L=${targetLab.L.toFixed(1)} a=${targetLab.a.toFixed(1)} b=${targetLab.b.toFixed(1)}`
    )
  } else {
    console.warn(`未找到颜色基准组 ${refGroup}，跳过颜色匹配`)
  }

  for (const f of frames) {
    const name = path.basename(f.file, '.png')
    const group = name.replace(/_\d+$/, '')
    const anchorKey = SEGMENT_STATE || group
    const { minX, minY, width: bw, height: bh, maxY } = f.bbox

    // 颜色匹配在 resize 前、原始分辨率上做；resize 后颜色自然继承
    const srcLab = groupLab.get(group)
    if (targetLab && srcLab) matchColor(f.data, f.width, f.bbox, srcLab, targetLab)

    const outW = Math.max(1, Math.round(bw * scale))
    const outH = Math.max(1, Math.round(bh * scale))

    // 裁到 bbox 后缩放
    const { data: resized, info: rInfo } = await sharp(f.data, {
      raw: { width: f.width, height: f.height, channels: 4 }
    })
      .extract({ left: minX, top: minY, width: bw, height: bh })
      .resize(outW, outH, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer({ resolveWithObject: true })

    const removed = removeSpecks(resized, rInfo.width, rInfo.height)

    // 锚点始终用组内统一值；drift 模式额外叠加该帧相对首帧的整体平移（反向抵消）
    const anchorX = groupAnchorX.get(anchorKey)
    const drift = frameDriftX.get(f.file) ?? 0
    let left = Math.round(CANVAS / 2 - (anchorX - minX) * scale + drift * scale)
    const rise = Math.round((groupBottom.get(anchorKey) - maxY) * scale) // 相对组内最低帧上移
    const top = CANVAS - BOTTOM_MARGIN - outH - rise
    // 左侧越界：通常是道具从画外入镜（如进食组的饭碗与手）。裁掉画外部分而不是整帧
    // 右移，否则该帧角色会横跳；裁掉后角色头部仍对齐画幅中心，道具自然从画外伸进来。
    let srcLeft = 0
    let drawW = outW
    if (left < 0) {
      console.warn(`  ${name}: 左侧越界 ${-left}px，已裁掉画外部分`)
      srcLeft = -left
      drawW = outW - srcLeft
      left = 0
    }
    // 头部对齐后，个别「尾巴甩到最右」的帧可能越界。裁掉画外部分，不整帧左移：
    // drift 对齐后角色位置已经钉死，左移会把她重新推歪（少则十几像素，肉眼就是一次横跳）。
    // 裁掉的只是甩到画幅外的尾尖，画幅边缘本来就是透明画布的边界。
    let rightCut = 0
    if (left + drawW > CANVAS) {
      rightCut = left + drawW - CANVAS
      drawW -= rightCut
      console.warn(`  ${name}: 右侧越界 ${rightCut}px，已裁掉画外部分`)
    }
    if (top < 0 || left < 0) throw new Error(`${name}: 超出画幅 (left=${left}, top=${top})`)

    // 需要裁边时再生成一次裁剪后的图像数据
    let drawData = resized
    if (srcLeft > 0 || rightCut > 0) {
      drawData = (
        await sharp(resized, { raw: { width: outW, height: outH, channels: 4 } })
          .extract({ left: srcLeft, top: 0, width: drawW, height: outH })
          .raw()
          .toBuffer()
      )
    }

    const outFile = path.join(outDir, `${group}`, `${name}.png`)
    await mkdir(path.dirname(outFile), { recursive: true })
    await sharp({
      create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    })
      .composite([{ input: drawData, raw: { width: drawW, height: outH, channels: 4 }, left, top }])
      .png()
      .toFile(outFile)

    console.log(
      `${name}: bbox=${bw}x${bh} -> ${outW}x${outH} @(${left},${top}) 去噪=${removed}px`
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
