// 卡的 [initvar] 初始变量：YAML 子集解析 + 从角色卡里取。
import { describe, expect, it } from 'vitest'
import { parseInitVars, readInitVars } from './mvuInit'

describe('parseInitVars', () => {
  it('按缩进还原嵌套对象，数字 / 布尔 / {} 都还原成类型', () => {
    const state = parseInitVars(
      [
        '世界:',
        '  当前时间: 仙洲历1024年七月初一 秋季 卯时(06:30)',
        '  好感度: 10',
        '',
        '玩家:',
        '  修为: 练气初期',
        '  当前阶段修炼进度: 0',
        '  背包: {}',
        '  已穿越: true',
        '当前角色:',
        '  苏月珑:',
        '    当前想法: 期待',
        '    当前穿着: 淡紫色长裙'
      ].join('\n')
    )
    expect(state).toEqual({
      世界: { 当前时间: '仙洲历1024年七月初一 秋季 卯时(06:30)', 好感度: 10 },
      玩家: { 修为: '练气初期', 当前阶段修炼进度: 0, 背包: {}, 已穿越: true },
      当前角色: { 苏月珑: { 当前想法: '期待', 当前穿着: '淡紫色长裙' } }
    })
  })

  it('数字样的字符串保住引号里的原样，注释与坏行跳过', () => {
    const state = parseInitVars(
      ['# 变量初始化', '编号: "007"', '这不是键值对', '名字: 旅人'].join('\n')
    )
    expect(state).toEqual({ 编号: '007', 名字: '旅人' })
  })
})

describe('readInitVars', () => {
  const card = {
    character_book: {
      entries: [
        {
          comment: '[initvar]变量初始化',
          // 卡里这条正是 disabled 的（怕它进提示词），照读不误
          enabled: false,
          content: '世界:\n  当前地点: 青云宗-{{user}}的房间\n'
        },
        { comment: '背景设定', content: '别的条目: 不该被当成初始值' }
      ]
    }
  }

  it('只认 [initvar] 条目，并替换 {{user}}', () => {
    expect(readInitVars(card as never, { char: '苏月珑', user: '旅人' })).toEqual({
      世界: { 当前地点: '青云宗-旅人的房间' }
    })
  })

  it('没有初始值条目时返回 null', () => {
    expect(readInitVars({ character_book: { entries: [{ comment: '背景设定', content: 'a: b' }] } })).toBeNull()
    expect(readInitVars(null)).toBeNull()
  })
})
