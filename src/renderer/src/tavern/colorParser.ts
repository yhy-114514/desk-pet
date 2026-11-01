// 小说流三色解析：把一段回复切成「旁白 / 对话 / 动作」三种片段。
// 纯函数、无 DOM 依赖，流式时每来一段就整段重算一次（消息不长，够快）。
//
// 规则（与 ST 的对话高亮一致）：
// - 引号内是对话（""、“”「」『』）；
// - 括号内是动作（（） ()）；
// - 其余是旁白。
// 未闭合的引号 / 括号一直着色到段尾——流式过程中下一段会把它闭上，重算后自然修正。

export type SegmentKind = 'narration' | 'dialogue' | 'action'

export interface ColorSegment {
  kind: SegmentKind
  text: string
}

/** 开引号 → 闭引号。ASCII 双引号自己闭合（全靠奇偶切换）。 */
const QUOTE_PAIRS: Record<string, string> = {
  '“': '”',
  '「': '」',
  '『': '』',
  '"': '"'
}

const PAREN_PAIRS: Record<string, string> = {
  '（': '）',
  '(': ')'
}

export function parseColors(text: string): ColorSegment[] {
  const segments: ColorSegment[] = []
  let kind: SegmentKind = 'narration'
  let closer = ''
  let buffer = ''

  const flush = (): void => {
    if (buffer) segments.push({ kind, text: buffer })
    buffer = ''
  }

  for (const char of text) {
    if (kind === 'narration') {
      const quote = QUOTE_PAIRS[char]
      const paren = PAREN_PAIRS[char]
      if (quote) {
        flush()
        kind = 'dialogue'
        closer = quote
        buffer = char
      } else if (paren) {
        flush()
        kind = 'action'
        closer = paren
        buffer = char
      } else {
        buffer += char
      }
      continue
    }

    buffer += char
    // 对话里遇到括号、动作里遇到引号都不切换：括号里的引号仍是动作描写，
    // 引号里的括号仍是台词——切来切去只会把一段话打碎。
    if (char === closer) {
      flush()
      kind = 'narration'
      closer = ''
    }
  }
  flush()
  return segments
}
