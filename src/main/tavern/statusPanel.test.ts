// 状态栏面板补齐：最新回复漏了面板时沿用上一次的原块。
import { describe, expect, it } from 'vitest'
import type { RegexRule } from './regexEngine'
import {
  appendPanelPlaceholder,
  carryPanels,
  hasStatusPage,
  mvuPlaceholder,
  type DisplayMessage
} from './statusPanel'

function rule(over: Partial<RegexRule>): RegexRule {
  return {
    id: 'r',
    name: '规则',
    pattern: 'x',
    flags: 'g',
    replacement: '',
    target: 'display',
    enabled: true,
    order: 0,
    source: 'card',
    readonly: true,
    ...over
  }
}

/** 单角色卡：MVU 用字面量占位符，正则把它换成整页 HTML */
const placeholder = rule({
  id: 'status',
  pattern: '<StatusPlaceHolderImpl/>',
  replacement: '```html\n<div>状态栏</div>\n```'
})

/** 多角色卡：模型输出的块里带数据，替换串用 $1 把数据塞进页面 */
const pokemon = rule({
  id: 'bar',
  pattern: '\\[宝可梦状态栏_始\\]([\\s\\S]*?)\\[宝可梦状态栏_末\\]',
  flags: 's',
  replacement: '```html\n<div>$1</div>\n```'
})

const forum = rule({
  id: 'forum',
  pattern: '\\[宝可梦论坛_始\\]([\\s\\S]*?)\\[宝可梦论坛_末\\]',
  flags: 's',
  replacement: '```html\n<div>$1</div>\n```'
})

function message(id: string, role: 'user' | 'assistant', content: string): DisplayMessage {
  return { id, role, content }
}

/** 《为什么妹妹才是勇者？！》：普通词 → 整页 HTML，没有 $1、也不是占位标签 */
const opening = rule({
  id: 'opening',
  pattern: '开场白',
  replacement: `<!DOCTYPE html>\n<html><body><div>${'<p>手帐</p>'.repeat(60)}</div></body></html>`
})

describe('hasStatusPage', () => {
  it('显示侧规则产出 html 围栏 = 卡自带状态页', () => {
    expect(hasStatusPage([placeholder, forum])).toBe(true)
    expect(hasStatusPage([pokemon])).toBe(true)
  })

  it('只认裸 HTML 页面的卡也算有状态页（不是围栏写法）', () => {
    expect(hasStatusPage([opening])).toBe(true)
  })

  it('只会洗字的规则 / 提示词侧页面都不算', () => {
    expect(hasStatusPage([rule({ id: 'hide', pattern: '（[^）]*）', replacement: '' })])).toBe(false)
    // 提示词侧的替换用户看不到，不能拿它当「有状态页」
    expect(hasStatusPage([rule({ id: 'p', pattern: 'x', replacement: '```html\ny\n```', target: 'prompt' })])).toBe(
      false
    )
    expect(hasStatusPage([rule({ id: 'off', pattern: 'x', replacement: '```html\ny\n```', enabled: false })])).toBe(
      false
    )
    // 把某个词包成标签的小规则不是状态页
    expect(
      hasStatusPage([rule({ id: 'span', pattern: '关键词', replacement: '<span class="k">关键词</span>' })])
    ).toBe(false)
  })
})

describe('mvuPlaceholder', () => {
  it('显示侧把占位符换成 HTML 时返回占位符本身', () => {
    expect(mvuPlaceholder([placeholder])).toBe('<StatusPlaceHolderImpl/>')
  })

  it('只有「把占位符洗成空串」的提示词侧规则时返回 null（别把字面量塞进正文）', () => {
    const hideOnly = rule({
      id: 'hide',
      pattern: '<StatusPlaceHolderImpl/>',
      replacement: '',
      target: 'prompt'
    })
    expect(mvuPlaceholder([hideOnly])).toBeNull()
  })

  it('$1 那种数据块规则不算占位符（它靠模型自己输出）', () => {
    expect(mvuPlaceholder([pokemon])).toBeNull()
  })
})

describe('appendPanelPlaceholder', () => {
  it('补到最后一条 assistant 消息末尾，用户消息不动', () => {
    const next = appendPanelPlaceholder(
      [message('m1', 'assistant', '开场白'), message('m2', 'user', '你好'), message('m3', 'assistant', '聊完一轮')],
      '<StatusPlaceHolderImpl/>'
    )
    expect(next[2]!.content).toBe('聊完一轮\n<StatusPlaceHolderImpl/>')
    expect(next[1]!.content).toBe('你好')
  })

  it('没有开场白（只有一条用户消息）也能补，这就是不再依赖 carryPanels 的理由', () => {
    const next = appendPanelPlaceholder([message('m1', 'user', '你好')], '<StatusPlaceHolderImpl/>')
    expect(next).toEqual([message('m1', 'user', '你好')])
    const withReply = appendPanelPlaceholder(
      [message('m1', 'user', '你好'), message('m2', 'assistant', '嗯')],
      '<StatusPlaceHolderImpl/>'
    )
    expect(withReply[1]!.content).toContain('<StatusPlaceHolderImpl/>')
  })

  it('已经有占位符时不重复补（否则状态页会被画两遍）', () => {
    const messages = [message('m1', 'assistant', '正文\n<StatusPlaceHolderImpl/>')]
    expect(appendPanelPlaceholder(messages, '<StatusPlaceHolderImpl/>')).toBe(messages)
  })
})

describe('carryPanels', () => {
  it('字面量占位符：开场白里有，最新回复漏了就补上', () => {
    const extra = carryPanels(
      [
        message('m1', 'assistant', '开场白\n<StatusPlaceHolderImpl/>'),
        message('m2', 'user', '你好'),
        message('m3', 'assistant', '聊完一轮')
      ],
      [placeholder]
    )
    expect(extra.get('m3')).toBe('\n<StatusPlaceHolderImpl/>')
    expect(extra.has('m1')).toBe(false)
  })

  it('$1 面板：补的是原块（数据也一起沿用），不是替换后的 HTML', () => {
    const extra = carryPanels(
      [
        message('m1', 'assistant', '[宝可梦状态栏_始]训练家: 旅人[宝可梦状态栏_末]'),
        message('m2', 'user', '走吧'),
        message('m3', 'assistant', '继续前进')
      ],
      [pokemon, forum]
    )
    expect(extra.get('m3')).toBe('\n[宝可梦状态栏_始]训练家: 旅人[宝可梦状态栏_末]')
  })

  it('开场白里没有的面板（论坛 / 手机）不补——那是按需弹出来的', () => {
    const extra = carryPanels(
      [
        message('m1', 'assistant', '开场白\n[宝可梦状态栏_始]训练家: 旅人[宝可梦状态栏_末]'),
        message('m2', 'assistant', '中间某轮弹过论坛\n[宝可梦论坛_始]帖子[宝可梦论坛_末]'),
        message('m3', 'assistant', '最新一轮')
      ],
      [pokemon, forum]
    )
    const extra3 = extra.get('m3') ?? ''
    expect(extra3).toContain('[宝可梦状态栏_始]')
    expect(extra3).not.toContain('[宝可梦论坛_始]')
  })

  it('最新回复自己带着面板时不补；只有一条回复时也不补', () => {
    expect(
      carryPanels(
        [
          message('m1', 'assistant', '<StatusPlaceHolderImpl/>'),
          message('m2', 'assistant', '正常\n<StatusPlaceHolderImpl/>')
        ],
        [placeholder]
      ).size
    ).toBe(0)
    expect(carryPanels([message('m1', 'assistant', '<StatusPlaceHolderImpl/>')], [placeholder]).size).toBe(0)
  })

  it('普通词 → 整页 HTML 的面板也能补（「开场白」这种）', () => {
    const extra = carryPanels(
      [
        message('m1', 'assistant', '开场白\n<div style="x">手帐</div>'),
        message('m2', 'user', '走吧'),
        message('m3', 'assistant', '继续前进')
      ],
      [opening]
    )
    // 补的是「原块」（也就是那个词本身），替换后的 HTML 由显示侧正则现算
    expect(extra.get('m3')).toBe('\n开场白')
  })

  it('提示词侧规则 / 普通删除式规则不参与（别把旧正文抄回来）', () => {
    const hide = rule({ id: 'hide', pattern: '（[^）]*）', replacement: '' })
    const promptOnly = rule({
      id: 'p',
      pattern: '<StatusPlaceHolderImpl/>',
      replacement: '',
      target: 'prompt'
    })
    expect(
      carryPanels(
        [
          message('m1', 'assistant', '（小声）开场白<StatusPlaceHolderImpl/>'),
          message('m2', 'assistant', '只有正文')
        ],
        [hide, promptOnly]
      ).size
    ).toBe(0)
  })
})
