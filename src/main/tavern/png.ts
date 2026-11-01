// PNG 里的角色卡数据：SillyTavern 把卡 JSON 以 base64 塞进 tEXt 块，关键字是 `chara`
// （v3 卡放 `ccv3`）。导入时要把它抠出来，导出时要能塞回去。
// 只处理 tEXt，不碰 zTXt / iTXt——ST 自己写的都是 tEXt，别的工具少见。
import { crc32, deflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// chara 是 v2 卡，优先；ccv3 是 v3 卡，它的 data 结构与 v2 兼容，当兜底
const CARD_KEYS = ['chara', 'ccv3']

interface Chunk {
  type: string
  data: Buffer
  /** 原始字节（含长度 / 类型 / CRC），回写时直接拼回去，不用重算 */
  raw: Buffer
}

function readChunks(png: Buffer): Chunk[] {
  if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('不是有效的 PNG')
  }
  const chunks: Chunk[] = []
  let offset = 8
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > png.length) throw new Error('PNG 数据被截断了')
    const type = png.toString('latin1', offset + 4, offset + 8)
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length), raw: png.subarray(offset, end) })
    offset = end
    if (type === 'IEND') break
  }
  return chunks
}

function textKeyword(data: Buffer): string {
  const end = data.indexOf(0)
  return data.toString('latin1', 0, end === -1 ? data.length : end)
}

function textValue(data: Buffer): string {
  const end = data.indexOf(0)
  return end === -1 ? '' : data.toString('latin1', end + 1)
}

function makeChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** 取出卡 JSON 文本；这张 PNG 里没有卡数据时返回 null（不是所有 PNG 都是角色卡）。 */
export function readCardJson(png: Buffer): string | null {
  const chunks = readChunks(png)
  for (const key of CARD_KEYS) {
    const chunk = chunks.find((item) => item.type === 'tEXt' && textKeyword(item.data) === key)
    if (!chunk) continue
    const base64 = textValue(chunk.data).trim()
    if (!base64) continue
    return Buffer.from(base64, 'base64').toString('utf8')
  }
  return null
}

/** 把卡 JSON 塞进 `chara` 块。已有的旧块先剔掉，免得一张图里躺两份卡。 */
export function writeCardJson(png: Buffer, json: string): Buffer {
  const chunks = readChunks(png)
  const text = Buffer.concat([
    Buffer.from('chara\0', 'latin1'),
    Buffer.from(Buffer.from(json, 'utf8').toString('base64'), 'latin1')
  ])
  const parts: Buffer[] = []
  let inserted = false
  for (const chunk of chunks) {
    if (chunk.type === 'tEXt' && CARD_KEYS.includes(textKeyword(chunk.data))) continue
    parts.push(chunk.raw)
    // 塞在 IHDR 后面：ST 只按块名找，位置无所谓，但排在图像数据前面更符合习惯
    if (!inserted && chunk.type === 'IHDR') {
      parts.push(makeChunk('tEXt', text))
      inserted = true
    }
  }
  if (!inserted) throw new Error('PNG 缺少 IHDR')
  return Buffer.concat([SIGNATURE, ...parts])
}

/** 生成一张纯色 PNG：导出没有立绘的卡时当底板，否则「导出 PNG」这条路走不通。 */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 2 // 颜色类型 2 = 真彩 RGB
  // 每行开头一个 filter 字节（0 = 不过滤），后面是 RGB
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = rgb[0]
    row[2 + x * 3] = rgb[1]
    row[3 + x * 3] = rgb[2]
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', deflateSync(raw)),
    makeChunk('IEND', Buffer.alloc(0))
  ])
}
