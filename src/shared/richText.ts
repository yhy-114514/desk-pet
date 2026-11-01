// 正文切段：卡里的「状态栏」正则会把占位符换成一整段 ```html，我们把它渲染成
// 沙箱 iframe（SillyTavern 的前端扩展也是这么做的），而不是把三万字代码摊在聊天里。
//
// 还有一种更常见的写法是**裸 HTML**（没有 ``` 围栏）：《为什么妹妹才是勇者？！》的
// 开场白用显示侧正则把「开场白」换成整页 `<!DOCTYPE html>…`，正文里还直接嵌了
// `<div style=…>` 面板。只认围栏的话，这些都会被当成文字摊在聊天里。

export type RichSegment =
  | { kind: 'text'; text: string }
  /** ```html 围栏或裸 HTML 里的状态栏页面 */
  | { kind: 'html'; html: string }
  /** 普通代码块（```json 之类）：还按代码显示 */
  | { kind: 'code'; lang: string; text: string }

const HTML_HINT = /<(?:!doctype|html|head|body|style)\b/i

export function isHtmlBlock(lang: string, content: string): boolean {
  if (lang.trim().toLowerCase() === 'html') return true
  return HTML_HINT.test(content.slice(0, 2000))
}

// ── 裸 HTML 的起点 ───────────────────────────────────────────────────
// 整页（正则替换出来的状态页 / 角色介绍页）只认这几种开头；
// 内联面板认「带属性的 <div」——不带属性的 `<div>` 更可能是正文里提到的标签。
const RAW_START = /<!doctype\s+html|<html\b|<head\b|<body\b|<style\b|<div\s+[^\s>]+/gi
// `</html>` 优先：`</body>` 在它前面，取先出现的会把 `</html>` 剩在正文里
const HTML_CLOSE = /<\/html\s*>/i
const BODY_CLOSE = /<\/body\s*>/i
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g

interface RawBlock {
  start: number
  /** 结束偏移（不含）；-1 = 标签还没配平（流式中途 / 正文里顺口提了一句） */
  end: number
}

/** 整页 HTML 到 `</html>`（没有就退到 `</body>`，再没有就到文末）。 */
function pageEnd(text: string, from: number): number {
  const tail = text.slice(from)
  const match = HTML_CLOSE.exec(tail) ?? BODY_CLOSE.exec(tail)
  return match ? from + match.index + match[0].length : text.length
}

/**
 * 从 `start` 处的开标签数到同名的闭标签，返回闭标签之后的偏移；配不平返回 -1。
 * 手动扫标签而不是用非贪婪正则：面板里套面板时，正则会在第一个 `</div>` 就收尾。
 */
function scanToClose(text: string, start: number, tag: string): number {
  TAG_RE.lastIndex = start
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = TAG_RE.exec(text)) !== null) {
    const name = match[2]!.toLowerCase()
    const closing = match[1] === '/'
    // 脚本 / 样式表里的 `<` 不是标签，整块跳过去（目标标签本身除外）
    if (!closing && name !== tag && (name === 'script' || name === 'style')) {
      const close = text.toLowerCase().indexOf(`</${name}`, TAG_RE.lastIndex)
      TAG_RE.lastIndex = close < 0 ? text.length : close
      continue
    }
    if (name !== tag) continue
    if (closing) {
      depth -= 1
      if (depth <= 0) return match.index + match[0].length
    } else if (!/\/\s*$/.test(match[3]!)) {
      depth += 1
    }
  }
  return -1
}

/**
 * 一段没配平的裸 HTML 到底是「被截断的状态栏页面」还是「正文里顺口提了个标签」。
 * 前者是成块的大段 HTML（被 max_tokens 从中间砍断），后者只有一两个标签。
 * 数标签最稳：截断的状态栏有几十个 `<div>` / `<span>`，正文提一句只有一个。
 */
function truncatedPanel(text: string, start: number): boolean {
  const rest = text.slice(start)
  return (rest.match(/<[a-zA-Z/]/g)?.length ?? 0) >= 5
}

/** 从 `from` 起找第一个裸 HTML 块的起点；`end` 为 -1 表示标签还没配平。 */
function findRawHtml(text: string, from: number): RawBlock | null {
  RAW_START.lastIndex = from
  let match: RegExpExecArray | null
  while ((match = RAW_START.exec(text)) !== null) {
    const start = match.index
    const token = match[0].toLowerCase()
    const page = !token.startsWith('<div') && !token.startsWith('<style')
    // 整页必须自成一行：正文里顺口提一句 `<html>`，不该把后半段全塞进 iframe
    if (page && start > 0 && text[start - 1] !== '\n') continue
    // `<!DOCTYPE` / `<html` / `<head` / `<body`：整页
    if (page) return { start, end: pageEnd(text, start) }
    const end = scanToClose(text, start, token.startsWith('<style') ? 'style' : 'div')
    return { start, end: end > start ? end : -1 }
  }
  return null
}

// ── 整条消息就是一个页面 ─────────────────────────────────────────────
// 沙盒卡（《末日丧尸》《太玄寰宇》《镇魔司》这类）用 `^` 规则把 <style> / <script>
// 注到每条消息最前面，后面散着一堆 <ui-xxx> 换出来的面板。按裸标签逐段切的话，
// JS 字符串里的 `<div class="…">` 也会被切走：一条消息碎成十几个 iframe，
// 残留的 `';` 碎片当正文显示，那段脚本从来没被执行过——画面是坏的，按钮自然也点不动。
const SCRIPT_OR_STYLE = /<(?:script|style)[\s>]/i

function looksLikePage(text: string): boolean {
  // 有 ``` 围栏的消息走老路（围栏本身就是分界，不能整条塞进 iframe）
  return SCRIPT_OR_STYLE.test(text) && !text.includes('```')
}

/** 流式 / 朗读用：把 <script> / <style> 块整段拿掉，只留下看得懂的正文 */
function stripScriptBlocks(text: string): string {
  let out = text
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
  // 还没闭合的那半段（流式中途）：从开标签起整段藏住，等这一轮结束再说
  const half = out.search(/<script\b|<style\b/i)
  if (half >= 0) out = out.slice(0, half)
  return out
}

/**
 * 切成「正文 / html 页面 / 普通代码块」。
 * 没有闭合的围栏按原文返回——模型被截断时不能把后半段吞掉。
 */
export function splitRich(text: string): RichSegment[] {
  if (looksLikePage(text)) {
    const html = text.trim()
    return html ? [{ kind: 'html', html }] : []
  }
  const segments: RichSegment[] = []
  let cursor = 0
  while (cursor < text.length) {
    const fence = text.indexOf('```', cursor)
    const raw = findRawHtml(text, cursor)
    // 谁先出现先切谁
    if (fence >= 0 && (!raw || fence <= raw.start)) {
      const lineEnd = text.indexOf('\n', fence + 3)
      const close = lineEnd < 0 ? -1 : text.indexOf('```', lineEnd + 1)
      if (lineEnd < 0 || close < 0) break
      const lang = text.slice(fence + 3, lineEnd).trim()
      const content = text.slice(lineEnd + 1, close)
      if (fence > cursor) segments.push({ kind: 'text', text: text.slice(cursor, fence) })
      segments.push(
        isHtmlBlock(lang, content)
          ? { kind: 'html', html: content.trim() }
          : { kind: 'code', lang, text: content }
      )
      cursor = close + 3
      continue
    }
    if (!raw) break
    if (raw.end < 0) {
      // 没配平的裸 HTML：成块的多半是被 max_tokens 砍断的状态栏，整段藏起来；
      // 只有孤零零一两个标签的才是正文里顺口提了一句，照常当正文
      if (truncatedPanel(text, raw.start)) {
        if (raw.start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, raw.start) })
        return segments
      }
      break
    }
    if (raw.start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, raw.start) })
    segments.push({ kind: 'html', html: text.slice(raw.start, raw.end).trim() })
    cursor = raw.end
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}

/**
 * 流式显示的正文：把围栏块和裸 HTML 整段藏起来（状态栏要等正文落库后才渲染），
 * 没闭合的那半段也一并藏住，免得屏幕上先滚过一片代码。
 */
export function streamText(text: string): string {
  // 整条就是一个页面的消息：先把 <script> / <style> 整段拿掉，页面里的正文才能先滚出来。
  // 但**剥完之后不能直接返回**：剩下的面板 / 表格还是几十 KB 裸 HTML，当正文画出去就是
  // 满屏 `<div class="…">`，朗读也会把标签名和属性一句句念出来。所以照旧走下面的逐段规则。
  const body = looksLikePage(text) ? stripScriptBlocks(text) : text
  const keep: string[] = []
  let cursor = 0
  while (cursor < body.length) {
    const fence = body.indexOf('```', cursor)
    const raw = findRawHtml(body, cursor)
    if (fence >= 0 && (!raw || fence <= raw.start)) {
      keep.push(body.slice(cursor, fence))
      const lineEnd = body.indexOf('\n', fence + 3)
      if (lineEnd < 0) return keep.join('')
      const close = body.indexOf('```', lineEnd + 1)
      // 还没闭合：围栏本身就是半截状态栏，别让它在屏幕上滚过去
      if (close < 0) return keep.join('')
      cursor = close + 3
      continue
    }
    if (!raw) {
      keep.push(body.slice(cursor))
      return keep.join('')
    }
    keep.push(body.slice(cursor, raw.start))
    // 面板还没配平：后面全藏着，等这一轮结束整页重绘
    if (raw.end < 0) return keep.join('')
    cursor = raw.end
  }
  return keep.join('')
}
