// Edge 朗读的 Sec-MS-GEC v2 token。
//
// 2026-10 微软改接口后，旧的 v1 token（纯 SHA-256）会被拒；v2 是 `<16 hex>-<64 hex>`：
// 前半段是魔改 SHA-256 摘要再喂给一段 CS64 混合，后半段是同一摘要本身。
// 算法移植自 rany2/edge-tts 的 PR #492（截至今日仍未合并）与 Edge 155 客户端的实际行为。
//
// 全程用 BigInt：原实现依赖 Python 的任意精度整数和 64 位无符号乘法，
// 换成 number 会在 `x * 0x100000001` 这类模拟右旋的运算上溢出。
// 这些常量不是普通 SHA-256 的初始值，别「优化」成标准实现。

const MASK = 0xFFFFFFFFn
const WIN_EPOCH = 11644473600
/** 100 纳秒为单位的时间片，用于把时间戳换成 Windows file time 的刻度。 */
const TICKS_PER_MS = 1e7

export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
export const SEC_MS_GEC_VERSION = '2-143.0.3650.75'

const SHA256_INITIAL: readonly bigint[] = [
  0x6a09e667n, 0xbb67ae85n, 0x3c6ef372n, 0xa54ff53an, 0x510e527fn, 0x9b05688cn, 0x1f83d9abn, 0x5be0cd19n
]

const SHA256_STATE: readonly bigint[] = [
  0xfd9fbea2n, 0x91243ce7n, 0xbe499094n, 0xcd2e1e0an, 0x6c006f49n, 0x04bd35abn, 0xfeb0a7e4n, 0x03effbd2n
]

const SHA256_SCHEDULE: readonly bigint[] = [
  0xeb24bf9en, 0x1558691fn, 0xa0c09ee2n, 0x0cfa32ban, 0xa622ee8cn, 0xd1dd9491n, 0xc0dd25a0n,
  0xf9e70ab6n, 0xf0c31573n, 0x7058ce4en, 0x7188e606n, 0x00e5ab33n, 0xd258b060n, 0x72766564n
]

const SHA256_ROUND_CONSTANTS: readonly bigint[] = [
  0x428a2f98n, 0x71374491n, 0xb5c0fbcfn, 0xe9b5dba5n, 0x3956c25bn, 0x59f111f1n, 0x923f82a4n, 0xab1c5ed5n,
  0xd807aa98n, 0x12835b01n, 0x243185ben, 0x550c7dc3n, 0x72be5d74n, 0x80deb1fen, 0x9bdc06a7n, 0xc19bf174n,
  0xe49b69c1n, 0xefbe4786n, 0x0fc19dc6n, 0x240ca1ccn, 0x2de92c6fn, 0x4a7484aan, 0x5cb0a9dcn, 0x76f988dan,
  0x983e5152n, 0xa831c66dn, 0xb00327c8n, 0xbf597fc7n, 0xc6e00bf3n, 0xd5a79147n, 0x06ca6351n, 0x14292967n,
  0x27b70a85n, 0x2e1b2138n, 0x4d2c6dfcn, 0x53380d13n, 0x650a7354n, 0x766a0abbn, 0x81c2c92en, 0x92722c85n,
  0xa2bfe8a1n, 0xa81a664bn, 0xc24b8b70n, 0xc76c51a3n, 0xd192e819n, 0xd6990624n, 0xf40e3585n, 0x106aa070n,
  0x19a4c116n, 0x1e376c08n, 0x2748774cn, 0x34b0bcb5n, 0x391c0cb3n, 0x4ed8aa4an, 0x5b9cca4fn, 0x682e6ff3n,
  0x748f82een, 0x78a5636fn, 0x84c87814n, 0x8cc70208n, 0x90befffan, 0xa4506cebn, 0xbef9a3f7n, 0xc67178f2n
]

const SHA256_ADJUSTMENT = 0xc9dc06a7n
const SHA256_BLOCK_CONSTANTS: readonly bigint[] = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15)
]
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80n
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0n

/** [系数, 偏移] 对，CS64 混合用的固定表。 */
const CS64_COEFFICIENTS: readonly (readonly [bigint, bigint])[] = [
  [0xe82e91b1n, 0xb32700d0n],
  [0x44de24c6n, 0x88dff51dn],
  [0x3beb65bcn, 0x29514038n],
  [0xc89c5933n, 0xb328cbdfn],
  [0x8d1ec211n, 0xd405b4d5n],
  [0x314ef5d5n, 0x26e55f3cn],
  [0xe92491b1n, 0x607801c6n],
  [0xf0a5b9d5n, 0x82b2c1fbn],
  [0x06064cf3n, 0xfa51a3dan],
  [0xda79fa60n, 0x207cc464n],
  [0xbed20560n, 0x3c3c74f3n],
  [0x89f9c9f8n, 0xd2d14b61n],
  [0x35fa38c6n, 0xbb04a2c1n],
  [0xcb49e3c6n, 0xc5626167n]
]
const CS64_FACTOR = 0x82893933n
const CS64_ADJUSTMENT0 = 0xf2f90b1an
const CS64_ADJUSTMENT1 = 0x0b1a0000n

function rol16(value: bigint): bigint {
  const masked = value & MASK
  return ((masked << 16n) | (masked >> 16n)) & MASK
}

/** 小端 32 位字数组，长度补齐成偶数（CS64 成对处理）。 */
function wordsLe4Even(data: Uint8Array): bigint[] {
  const size = Math.ceil(data.length / 4) * 4
  const padded = new Uint8Array(size)
  padded.set(data)
  const view = new DataView(padded.buffer)
  const words: bigint[] = []
  for (let offset = 0; offset === 0 || offset < size; offset += 4) {
    if (size === 0) break
    words.push(BigInt(view.getUint32(offset, true)))
  }
  if (words.length % 2 === 1) words.push(0n)
  return words
}

function sigma0(value: bigint): bigint {
  return ((value >> 7n) ^ (value << 25n) ^ (value >> 18n) ^ (value << 14n) ^ (value >> 3n)) & MASK
}

function sigma1(value: bigint): bigint {
  return ((value >> 17n) ^ (value << 15n) ^ (value >> 19n) ^ (value << 13n) ^ (value >> 10n)) & MASK
}

/** 64 个压缩轮。`firstRound` 用于从第 15 轮接着算（首块的魔改状态）。 */
function sha256Rounds(state: readonly bigint[], words: readonly bigint[], firstRound = 0): bigint[] {
  let [a, b, c, d, e, f, g, h] = state
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS
  // 8 轮一组的展开里寄存器会换角色，先按 8 对齐再展开
  const aligned = Math.min(64, Math.floor((firstRound + 7) / 8) * 8)

  for (let index = firstRound; index < aligned; index++) {
    // 乘 2^32+1 把 32 位字在 64 位里重复一遍，右移就等效于 ROTR，省掉一次左移
    const rotE = e * 0x100000001n
    const rotA = a * 0x100000001n
    const t1 =
      h +
      ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) +
      (g ^ (e & (f ^ g))) +
      constants[index] +
      words[index]
    const t2 =
      ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((a & b) | (c & (a | b)))
    ;[a, b, c, d, e, f, g, h] = [(t1 + t2) & MASK, a, b, c, (d + t1) & MASK, e, f, g]
  }

  for (let index = aligned; index < 64; index += 8) {
    const k = (i: number): bigint => constants[i]
    const w = (i: number): bigint => words[i]

    let rotE = e * 0x100000001n
    let rotA = a * 0x100000001n
    let t1 = h + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (g ^ (e & (f ^ g))) + k(index) + w(index)
    d = (d + t1) & MASK
    h = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((a & b) | (c & (a | b)))) & MASK

    rotE = d * 0x100000001n
    rotA = h * 0x100000001n
    t1 = g + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (f ^ (d & (e ^ f))) + k(index + 1) + w(index + 1)
    c = (c + t1) & MASK
    g = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((h & a) | (b & (h | a)))) & MASK

    rotE = c * 0x100000001n
    rotA = g * 0x100000001n
    t1 = f + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (e ^ (c & (d ^ e))) + k(index + 2) + w(index + 2)
    b = (b + t1) & MASK
    f = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((g & h) | (a & (g | h)))) & MASK

    rotE = b * 0x100000001n
    rotA = f * 0x100000001n
    t1 = e + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (d ^ (b & (c ^ d))) + k(index + 3) + w(index + 3)
    a = (a + t1) & MASK
    e = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((f & g) | (h & (f | g)))) & MASK

    rotE = a * 0x100000001n
    rotA = e * 0x100000001n
    t1 = d + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (c ^ (a & (b ^ c))) + k(index + 4) + w(index + 4)
    h = (h + t1) & MASK
    d = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((e & f) | (g & (e | f)))) & MASK

    rotE = h * 0x100000001n
    rotA = d * 0x100000001n
    t1 = c + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (b ^ (h & (a ^ b))) + k(index + 5) + w(index + 5)
    g = (g + t1) & MASK
    c = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((d & e) | (f & (d | e)))) & MASK

    rotE = g * 0x100000001n
    rotA = c * 0x100000001n
    t1 = b + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (a ^ (g & (h ^ a))) + k(index + 6) + w(index + 6)
    f = (f + t1) & MASK
    b = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((c & d) | (e & (c | d)))) & MASK

    rotE = f * 0x100000001n
    rotA = b * 0x100000001n
    t1 = a + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (h ^ (f & (g ^ h))) + k(index + 7) + w(index + 7)
    e = (e + t1) & MASK
    a = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((b & c) | (d & (b | c)))) & MASK
  }

  return [a, b, c, d, e, f, g, h]
}

function expandSchedule(words: bigint[], firstWord = 16): void {
  for (let index = firstWord; index < 64; index++) {
    const x = words[index - 2]
    const y = words[index - 15]
    // 旋转的高位留到最后一起截断，省一次掩码
    const s1 = (x >> 17n) ^ (x << 15n) ^ (x >> 19n) ^ (x << 13n) ^ (x >> 10n)
    const s0 = (y >> 7n) ^ (y << 25n) ^ (y >> 18n) ^ (y << 14n) ^ (y >> 3n)
    words.push((s1 + words[index - 7] + s0 + words[index - 16]) & MASK)
  }
}

function sha256Init(data: Uint8Array): bigint[] {
  const words: bigint[] = new Array<bigint>(14).fill(0n)
  words.push(bytesToBigInt(data.subarray(0, 3)))
  words.push(bytesToBigInt(data.subarray(3, 7)))

  for (let index = 16; index < 30; index++) {
    let value = SHA256_SCHEDULE[index - 16]
    if (index - 2 >= 14) {
      value += index === 16 ? sigma1(words[index - 2]) ^ SHA256_SIGMA1_ADJUSTMENT : sigma1(words[index - 2])
    }
    if (index - 7 >= 14) value += words[index - 7]
    if (index - 15 >= 14) {
      value += index === 29 ? sigma0(words[index - 15]) ^ SHA256_SIGMA0_ADJUSTMENT : sigma0(words[index - 15])
    }
    words.push(value & MASK)
  }

  words.push(
    (sigma1(words[28]) +
      words[23] +
      sigma0(words[15]) +
      words[14] +
      SHA256_ADJUSTMENT -
      SHA256_ROUND_CONSTANTS[14]) &
      MASK
  )

  expandSchedule(words, 31)
  const working = sha256Rounds(SHA256_STATE, words, 14)
  return SHA256_INITIAL.map((value, index) => (value + working[index]) & MASK)
}

function sha256Digest(data: Uint8Array): Uint8Array {
  if (data.length < 7) throw new Error('token 原文至少要有 7 字节')
  const length = 57 + data.length
  const tail = data.subarray(7)
  const padLength = (((55 - length) % 64) + 64) % 64

  const padded = new Uint8Array(tail.length + 1 + padLength + 8)
  padded.set(tail, 0)
  padded[tail.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setBigUint64(padded.length - 8, BigInt(length * 8))

  let state = sha256Init(data.subarray(0, 7))
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words: bigint[] = []
    for (let index = 0; index < 16; index++) words.push(BigInt(view.getUint32(offset + index * 4)))
    expandSchedule(words)
    const working = sha256Rounds(state, words)
    state = state.map((value, index) => (value + working[index]) & MASK)
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  state.forEach((value, index) => outView.setUint32(index * 4, Number(value)))
  return out
}

function cs64Digest(data: Uint8Array, digest: Uint8Array): [bigint, bigint] {
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength)
  const keyA = BigInt(view.getUint32(0, true)) | 1n
  const keyB = BigInt(view.getUint32(4, true)) | 1n
  const factors: [bigint, bigint] = [(keyA * CS64_FACTOR) & MASK, (keyB * CS64_FACTOR) & MASK]

  const terms = CS64_COEFFICIENTS.map(([coefficient], index) => (coefficient * factors[index % 2]) & MASK)
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset)

  // 前面补一个 0 字节，让数据整体错开，与原实现一致
  const body = new Uint8Array(data.length + 1)
  body.set(data, 1)
  wordsLe4Even(body).forEach((word, index) => {
    let term = word * (index % 2 === 0 ? keyA : keyB)
    let offset = rol16(word) * (index % 2 === 0 ? 0xef0569fbn : 0xc31713dbn)
    if (index === 0) {
      term += CS64_ADJUSTMENT0 * factors[0]
      offset += CS64_ADJUSTMENT1
    }
    terms.push(term & MASK)
    offsets.push(offset & MASK)
  })

  let swapAcc = 0n
  let swapLast = 0n
  let state = 0n
  let acc = 0n

  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index]
    const y = terms[index + 1]

    let t = rol16((offsets[index] + x) & MASK)
    let q = (t * 0x76f50f34n) & MASK
    swapAcc += (rol16(q) * 0xc3efea97n + q) & MASK

    t = rol16((offsets[index + 1] + y) & MASK)
    q = (t * 0x1881ce3cn) & MASK
    swapLast = (rol16(q) * 0x35bd1ec9n + q) & MASK
    swapAcc = (swapAcc + swapLast) & MASK

    state = (state * keyA + x) & MASK
    state = (rol16(state) * 0xcf98b111n) & MASK
    state = (rol16(state) * 0x87085b9fn) & MASK
    state = (rol16(state) * 0x12ceb96dn) & MASK
    state = (rol16(state) * 0x257e1d83n) & MASK
    acc += state

    t = (state * keyB + y) & MASK
    t = (rol16(t) * 0xa27416f5n) & MASK
    t = (rol16(t) * 0xd38396ffn) & MASK
    state = (rol16((rol16(t) * 0x7c932b89n) & MASK) * 0xbfa49f69n) & MASK
    acc = (acc + state) & MASK
  }

  return [swapLast ^ state, swapAcc ^ acc]
}

function bytesToBigInt(data: Uint8Array): bigint {
  let value = 0n
  for (const byte of data) value = (value << 8n) | BigInt(byte)
  return value
}

function bytesToHex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

/** 32 位按小端展开成 8 个 hex 字符。 */
function leHex32(value: bigint): string {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, Number(value), true)
  return bytesToHex(bytes)
}

/**
 * 生成 v2 token。`nowMs` 仅用于测试，正常调用不用传。
 * 时间按 5 分钟取整——服务端也只认这个粒度。
 */
export function generateSecMsGecV2(nowMs: number = Date.now()): string {
  let ticks = nowMs / 1000 + WIN_EPOCH
  ticks -= ticks % 300
  ticks *= TICKS_PER_MS

  const data = new TextEncoder().encode(`${Math.round(ticks)}${TRUSTED_CLIENT_TOKEN}`)
  const digest = sha256Digest(data)
  const [cs64A, cs64B] = cs64Digest(data, digest)
  return `${leHex32(cs64A)}${leHex32(cs64B)}-${bytesToHex(digest)}`
}
