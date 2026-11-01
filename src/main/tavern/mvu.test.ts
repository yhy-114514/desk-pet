// 变量系统（MVU）：更新块解析、JSON Patch 应用、流式半截标签、状态栏格式化。
import { describe, expect, it } from 'vitest'
import {
  applyJsonPatch,
  extractUpdates,
  formatStatus,
  holdPartialTag,
  parsePatch,
  stripUpdateTags
} from './mvu'

describe('extractUpdates', () => {
  it('抠出 <update><json_patch> 并洗掉整块', () => {
    const raw =
      '她抬眼看你。\n<update><json_patch>[{"op":"replace","path":"/修为","value":"筑基"}]</json_patch></update>'
    const result = extractUpdates(raw)
    expect(result.ops).toEqual([{ op: 'replace', path: '/修为', value: '筑基' }])
    expect(result.text).toBe('她抬眼看你。')
  })

  it('多角色卡的 <UpdateVariable> / <status_description> 也洗掉', () => {
    const raw =
      '战斗开始！\n<UpdateVariable><json_patch>[{"op":"add","path":"/敌方","value":"火箭队"}]</json_patch></UpdateVariable>' +
      '<status_description>精灵球 x5</status_description>'
    const result = extractUpdates(raw)
    expect(result.text).toBe('战斗开始！')
    expect(result.ops).toHaveLength(1)
  })

  it('模型被截断、只有开标签时，从标签处剥到结尾', () => {
    expect(extractUpdates('正文<update><json_patch>[{"op":"add"').text).toBe('正文')
    expect(extractUpdates('正文<StatusPlaceHolderImpl/>').text).toContain('StatusPlaceHolderImpl')
  })

  it('没有更新块时正文原样返回', () => {
    expect(extractUpdates('就一句普通台词。')).toEqual({ text: '就一句普通台词。', ops: [] })
  })

  it('stripUpdateTags 是 extractUpdates().text 的快捷写法', () => {
    expect(stripUpdateTags('啊<update><json_patch></json_patch></update>')).toBe('啊')
  })

  it('标签大小写、带空格 / 属性都认（写死小写会把半截正文一起吃掉）', () => {
    expect(
      extractUpdates('她点头。\n<UPDATE><json_patch>[{"op":"add","path":"/a","value":1}]</json_patch></UPDATE>')
    ).toEqual({ text: '她点头。', ops: [{ op: 'add', path: '/a', value: 1 }] })
    expect(
      extractUpdates('她点头。<update ><json_patch>[{"op":"add","path":"/b","value":2}]</json_patch></update >')
    ).toEqual({ text: '她点头。', ops: [{ op: 'add', path: '/b', value: 2 }] })
    expect(
      extractUpdates('她点头。<json_patch version="1">[{"op":"add","path":"/c","value":3}]</json_patch>')
    ).toEqual({ text: '她点头。', ops: [{ op: 'add', path: '/c', value: 3 }] })
  })
})

describe('parsePatch', () => {
  it('JSON 数组', () => {
    expect(parsePatch('[{"op":"add","path":"/a","value":1}]')).toEqual([
      { op: 'add', path: '/a', value: 1 }
    ])
  })

  it('容错：围栏代码块里夹着数组', () => {
    expect(
      parsePatch('```json\n[{"op":"remove","path":"/a"}]\n```')
    ).toEqual([{ op: 'remove', path: '/a', value: undefined }])
  })

  it('逐个对象的写法', () => {
    expect(
      parsePatch('{"op":"add","path":"/a","value":1}\n{"op":"replace","path":"/b","value":2}')
    ).toEqual([
      { op: 'add', path: '/a', value: 1 },
      { op: 'replace', path: '/b', value: 2 }
    ])
  })

  it('数组解析失败时，value 是嵌套对象的单条也能抠出来', () => {
    // 尾逗号让整个数组解析失败，落到逐条解析；非贪婪正则会在这里的 `}` 处截断
    expect(
      parsePatch('[{"op":"replace","path":"/角色","value":{"hp":10,"mp":5}},]')
    ).toEqual([{ op: 'replace', path: '/角色', value: { hp: 10, mp: 5 } }])
  })

  it('不认识的操作与坏 JSON 跳过', () => {
    expect(parsePatch('[{"op":"move","path":"/a"},{"path":"/b"}]')).toEqual([])
    expect(parsePatch('{not json}')).toEqual([])
    expect(parsePatch('')).toEqual([])
  })

  it('单条对象的 value 是数组时整条都要留下', () => {
    // 按 indexOf('[') 找数组起点的话会从 value 的方括号截起，
    // 截出来的 ["药"] 恰好合法 → 这条 ops 被当成一批空数组丢掉
    expect(parsePatch('{"op":"add","path":"/背包","value":["药"]}')).toEqual([
      { op: 'add', path: '/背包', value: ['药'] }
    ])
  })

  it('test 是合法操作（RFC 6902 的守卫）', () => {
    expect(parsePatch('[{"op":"test","path":"/a","value":1}]')).toEqual([
      { op: 'test', path: '/a', value: 1 }
    ])
  })
})

describe('applyJsonPatch', () => {
  it('add / replace / remove 都生效，且不动入参', () => {
    const state = { 时间: '第一天', 背包: ['药'] }
    const next = applyJsonPatch(state, [
      { op: 'replace', path: '/时间', value: '第二天' },
      { op: 'add', path: '/好感度', value: 5 },
      { op: 'remove', path: '/背包' }
    ])
    expect(next).toEqual({ 时间: '第二天', 好感度: 5 })
    expect(state).toEqual({ 时间: '第一天', 背包: ['药'] })
  })

  it('中间层不存在时自动建对象', () => {
    expect(
      applyJsonPatch({}, [{ op: 'add', path: '/角色/苏月珑/好感', value: 3 }])
    ).toEqual({ 角色: { 苏月珑: { 好感: 3 } } })
  })

  it('数组按索引改、remove、用 - 追加', () => {
    const state = { list: ['a', 'b'] }
    expect(applyJsonPatch(state, [{ op: 'add', path: '/list/-', value: 'c' }])).toEqual({
      list: ['a', 'b', 'c']
    })
    expect(applyJsonPatch(state, [{ op: 'replace', path: '/list/0', value: 'z' }])).toEqual({
      list: ['z', 'b']
    })
    expect(applyJsonPatch(state, [{ op: 'remove', path: '/list/1' }])).toEqual({ list: ['a'] })
  })

  it('remove 不存在的路径不报错也不产生副作用', () => {
    const state = { a: 1 }
    expect(applyJsonPatch(state, [{ op: 'remove', path: '/nope/deep' }])).toEqual({ a: 1 })
    expect(applyJsonPatch(state, [{ op: 'remove', path: '/a' }])).toEqual({})
  })

  it('路径里的 ~0 / ~1 反转义', () => {
    expect(
      applyJsonPatch({}, [{ op: 'add', path: '/a~1b/~0c', value: 1 }])
    ).toEqual({ 'a/b': { '~c': 1 } })
  })

  it('数组 replace 越界不撑长数组（不留空洞）', () => {
    const state = { list: ['a', 'b'] }
    expect(applyJsonPatch(state, [{ op: 'replace', path: '/list/5', value: 'x' }])).toEqual(state)
    expect(applyJsonPatch(state, [{ op: 'add', path: '/list/2', value: 'c' }])).toEqual({
      list: ['a', 'b', 'c']
    })
    expect(applyJsonPatch(state, [{ op: 'add', path: '/list/9', value: 'x' }])).toEqual(state)
  })

  it('test 通过时后面的 op 照常生效', () => {
    expect(
      applyJsonPatch({ 修为: '练气', 背包: ['药'] }, [
        { op: 'test', path: '/修为', value: '练气' },
        { op: 'replace', path: '/修为', value: '筑基' }
      ])
    ).toEqual({ 修为: '筑基', 背包: ['药'] })
  })

  it('test 不通过时整批 op 都不生效（守卫语义）', () => {
    const state = { 修为: '练气', 背包: ['药'] }
    expect(
      applyJsonPatch(state, [
        { op: 'test', path: '/修为', value: '筑基' },
        { op: 'remove', path: '/背包' }
      ])
    ).toEqual(state)
  })

  it('test 比较对象 / 数组按 JSON 语义（键顺序无关）', () => {
    expect(
      applyJsonPatch({ 角色: { hp: 10, mp: 5 } }, [
        { op: 'test', path: '/角色', value: { mp: 5, hp: 10 } }
      ])
    ).toEqual({ 角色: { hp: 10, mp: 5 } })
    expect(
      applyJsonPatch({ list: [1, 2] }, [
        { op: 'test', path: '/list', value: [1] },
        { op: 'add', path: '/x', value: 1 }
      ])
    ).toEqual({ list: [1, 2] })
  })
})

describe('holdPartialTag', () => {
  it('末尾是半个更新标签时先扣住', () => {
    expect(holdPartialTag('她笑了。<upd')).toBe('她笑了。')
    expect(holdPartialTag('她笑了。<')).toBe('她笑了。')
    expect(holdPartialTag('她笑了。<UpdateVa')).toBe('她笑了。')
    // 模型写成大写时半截标签也要扣住，否则界面上先闪一下 <UPD 再消失
    expect(holdPartialTag('她笑了。<UPD')).toBe('她笑了。')
  })

  it('普通文本与完整标签原样放过', () => {
    expect(holdPartialTag('她笑了。')).toBe('她笑了。')
    // 不是更新标签开头：自己就是正文
    expect(holdPartialTag('她笑了。<b')).toBe('她笑了。<b')
    expect(holdPartialTag('a < b')).toBe('a < b')
  })
})

describe('formatStatus', () => {
  it('嵌套压成 父/子 行，数组用顿号连接', () => {
    expect(
      formatStatus({
        时间: '第三天',
        角色: { 苏月珑: { 好感: 20, 状态: '平静' } },
        背包: ['药', '剑']
      })
    ).toEqual(['时间: 第三天', '角色/苏月珑/好感: 20', '角色/苏月珑/状态: 平静', '背包: 药、剑'])
  })

  it('超过深度上限的对象压成 JSON，不显示 [object Object]', () => {
    const lines = formatStatus({
      角色: { 属性: { 装备: { 武器: '剑', 护甲: '甲' } } },
      背包: [{ 名称: '药', 数量: 2 }]
    })
    expect(lines.join('\n')).not.toContain('[object Object]')
    expect(lines).toEqual([
      '角色/属性/装备: {"武器":"剑","护甲":"甲"}',
      '背包: {"名称":"药","数量":2}'
    ])
  })

  it('空值 / 空对象也给出可读占位', () => {
    expect(formatStatus({ a: null, b: {}, c: [] })).toEqual([
      'a: —',
      'b: （空）',
      'c: （空）'
    ])
  })
})
