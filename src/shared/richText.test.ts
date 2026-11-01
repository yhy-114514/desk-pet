import { describe, expect, it } from 'vitest'
import { isHtmlBlock, splitRich, streamText } from './richText'

describe('正文切段', () => {
  it('没有围栏就是一段正文', () => {
    expect(splitRich('就这样看着你。')).toEqual([{ kind: 'text', text: '就这样看着你。' }])
  })

  it('正文 + html 状态栏 + 普通代码块各自成段', () => {
    const text = [
      '开场白正文。',
      '```html',
      '<div class="statusbar">HP</div>',
      '```',
      '中间的正文。',
      '```json',
      '{"a":1}',
      '```'
    ].join('\n')

    const segments = splitRich(text)
    expect(segments.map((segment) => segment.kind)).toEqual(['text', 'html', 'text', 'code'])
    expect(segments[1]).toEqual({ kind: 'html', html: '<div class="statusbar">HP</div>' })
    expect(segments[3]).toEqual({ kind: 'code', lang: 'json', text: '{"a":1}\n' })
  })

  it('没写语言但内容是 html 的围栏也当状态栏', () => {
    const segments = splitRich('x\n```\n<!DOCTYPE html><p>hi</p>\n```\n')
    expect(segments[1]!.kind).toBe('html')
  })

  it('围栏没闭合时整段原样留下，不吞正文', () => {
    const text = '前文。\n```html\n<div>没写完'
    const segments = splitRich(text)
    expect(segments).toEqual([{ kind: 'text', text }])
  })

  it('裸 HTML 整页（显示侧正则的产物）也切出来，不再当文字摊着', () => {
    const page = '<!DOCTYPE html>\n<html lang="zh-CN"><body><p>冒险手帐</p></body></html>'
    const segments = splitRich(`开场白\n${page}\n收尾。`)
    expect(segments.map((segment) => segment.kind)).toEqual(['text', 'html', 'text'])
    expect(segments[1]).toEqual({ kind: 'html', html: page.trim() })
    expect(segments[2]).toEqual({ kind: 'text', text: '\n收尾。' })
  })

  it('内联 <div style> 面板按嵌套层级配平，不会被内层 </div> 截断', () => {
    const panel = '<div style="border:1px solid"><div class="row"><span>HP</span></div>尾巴</div>'
    const segments = splitRich(`来了。\n${panel}`)
    expect(segments).toEqual([
      { kind: 'text', text: '来了。\n' },
      { kind: 'html', html: panel }
    ])
  })

  it('正文 + 整页 + 面板混排：三段 html 各自成段', () => {
    const page = '<html><body>页</body></html>'
    const panel = '<div class="p">板</div>'
    const segments = splitRich(`甲\n${page}\n乙\n${panel}\n丙`)
    expect(segments.map((segment) => segment.kind)).toEqual([
      'text',
      'html',
      'text',
      'html',
      'text'
    ])
    expect(segments.filter((segment) => segment.kind === 'html')).toHaveLength(2)
  })

  it('正文里提一句 <html> 不会被当成整页', () => {
    const segments = splitRich('她说 `<html>` 是根标签，还说 <body> 也一样。')
    expect(segments.map((segment) => segment.kind)).toEqual(['text'])
  })

  it('没配平的 <div style> 和裸 <div> 都当正文，不吞后面的话', () => {
    // 面板还没写完：这一版按文字显示，等落库重绘
    expect(splitRich('她说<div style="x">半截')).toEqual([
      { kind: 'text', text: '她说<div style="x">半截' }
    ])
    // 没有属性的 <div> 更可能是正文里提到的标签
    expect(splitRich('用 <div> 包一层').map((segment) => segment.kind)).toEqual(['text'])
  })

  it('被截断的长面板（状态栏写到一半）整段藏起来，只留前面的正文', () => {
    // 模型每轮输出整页状态栏，被 max_tokens 从中间砍断——不能再把十几 KB 标签摊在聊天里
    const truncated =
      '<div style="margin:20px 0;border:1px solid #ccc">' +
      '<div class="row"><span class="k">姓名</span><span class="v">苏月珑</span></div>' +
      '<div class="row"><span class="k">修为</span><span class="v">练气</span></div>' +
      '<div class="choice-item" data-choice="1"><span>① 出手</span></div>' +
      '<div class="choice-item" data-choice="2"><span>② 观望</span></div>' +
      '<div class="row"><span class="k">时间</span>'
    const segments = splitRich(`她抬头看你。\n${truncated}`)
    expect(segments).toEqual([{ kind: 'text', text: '她抬头看你。\n' }])
  })

  it('正文里顺口提一句带属性的标签，即使没有闭合也照常当正文', () => {
    const text = '她说<div style="color:red">是红色，然后又聊了很久别的。'
    expect(splitRich(text)).toEqual([{ kind: 'text', text }])
  })

  it('isHtmlBlock 认语言名，也认内容特征', () => {
    expect(isHtmlBlock('html', '随便')).toBe(true)
    expect(isHtmlBlock('HTML ', '随便')).toBe(true)
    expect(isHtmlBlock('', '<style>body{}</style>')).toBe(true)
    expect(isHtmlBlock('js', 'console.log(1)')).toBe(false)
  })
})

describe('流式正文', () => {
  it('已闭合的围栏整段看不见', () => {
    const text = '正文一。\n```html\n<div>三万字</div>\n```\n正文二。'
    expect(streamText(text)).toBe('正文一。\n\n正文二。')
  })

  it('没闭合的围栏也不让代码滚过去', () => {
    expect(streamText('正文。\n```html\n<div>还没写完')).toBe('正文。\n')
  })

  it('裸 HTML 也整段看不见（流式中途不滚三万字标签）', () => {
    const text = '正文一。\n<html><body>整页</body></html>\n正文二。'
    expect(streamText(text)).toBe('正文一。\n\n正文二。')
  })

  it('还没配平的面板把后面全藏住', () => {
    expect(streamText('正文。<div style="x"><span>半截')).toBe('正文。')
  })

  it('没有围栏时原样返回', () => {
    expect(streamText('只是说话。')).toBe('只是说话。')
  })
})

describe('整条消息就是一个页面', () => {
  // 沙盒卡（《末日丧尸》《太玄寰宇》《镇魔司》）用 ^ 规则把 <style> / <script> 注到消息最前面。
  // 逐段切的话 JS 字符串里的 `<div class="…">` 也会被切走：一条消息碎成十几个 iframe，
  // 残留的 '; 碎片当正文显示，那段脚本从来没被执行过——画面是坏的，按钮也点不动。
  const page = '<style>body{}</style>\n<div class="a">面板</div>\n<script>var s = \'<div class="b">\';</script>'

  it('整条当一个 html 段，不再被逐段切开', () => {
    const segments = splitRich(page)
    expect(segments).toHaveLength(1)
    expect(segments[0]!.kind).toBe('html')
    expect((segments[0] as { html: string }).html).toBe(page.trim())
  })

  it('带 ``` 围栏的消息仍走逐段切（围栏本身就是分界）', () => {
    const segments = splitRich('正文。\n```html\n<div>页</div>\n```')
    expect(segments.map((s) => s.kind)).toEqual(['text', 'html'])
  })

  it('流式时脚本 / 样式整段藏起来，正文照常先滚出来', () => {
    expect(streamText('<style>body{}</style>\n你醒了。\n<script>var x = 1</script>')).toBe('\n你醒了。\n')
  })

  it('流式中途只到半截 <script> 时从开标签起整段藏住', () => {
    expect(streamText('你醒了。\n<script>var x = 1')).toBe('你醒了。\n')
  })

  // 整页消息剥掉脚本 / 样式后，剩下的面板仍是几十 KB 裸 HTML：直接返回等于把标签
  // 当正文画在气泡里，朗读（chatService 的 streamText → stripForSpeech）也会念出来
  it('整页消息剥完脚本后，剩下的裸 HTML 照旧整段藏起来', () => {
    const out = streamText(
      '<style>body{}</style><div class="panel">状态</div>\n你醒了。\n<script>var x = 1</script>'
    )
    expect(out).not.toContain('<div')
    expect(out.trim()).toBe('你醒了。')
  })
})
