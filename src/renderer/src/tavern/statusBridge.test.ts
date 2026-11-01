// 沙箱 iframe 里给卡自带状态栏页面的那套运行时。
import { describe, expect, it } from 'vitest'
import {
  buildStatusBridgeScript,
  deepMerge,
  kebabCase,
  lodashGet,
  parseSlash,
  selectMessages
} from './statusBridge'

describe('deepMerge', () => {
  // 卡常用 `insertOrAssignVariables({stat_data:{世界:{当前时间:'子时'}}})` 只改一个字段：
  // 浅合并会把整棵「世界」换掉，地点 / 季节一起没了
  it('对象逐层合并，同名字段只改被点到的', () => {
    const state = { 世界: { 当前时间: '卯时', 当前地点: '山门', 季节: '春' }, 好感度: 1 }
    expect(deepMerge(state, { 世界: { 当前时间: '子时' } })).toEqual({
      世界: { 当前时间: '子时', 当前地点: '山门', 季节: '春' },
      好感度: 1
    })
  })

  it('数组整个替换，新子树是拷贝出来的', () => {
    const state = { 背包: ['药', '剑'], 角色: { 苏月珑: { 好感: 3 } } }
    const patch = { 背包: ['丹'], 角色: { 苏月珑: { 好感: 5 } } }
    // 先拷一份再合，跟 iframe 里的用法一致（deepMerge(deepMerge({}, statData), patch)）
    const out = deepMerge(deepMerge({}, state), patch) as {
      背包: string[]
      角色: { 苏月珑: { 好感: number } }
    }
    expect(out).toEqual({ 背包: ['丹'], 角色: { 苏月珑: { 好感: 5 } } })
    out.角色.苏月珑.好感 = 9
    expect(state).toEqual({ 背包: ['药', '剑'], 角色: { 苏月珑: { 好感: 3 } } })
    expect(patch.角色.苏月珑.好感).toBe(5)
  })
})

describe('lodashGet', () => {
  const state = { 世界: { 当前时间: '仙洲历1024年', 好感度: 0 }, 当前角色: { 苏月珑: { 当前想法: '' } } }

  it('点路径逐层取值', () => {
    expect(lodashGet(state, '世界.当前时间')).toBe('仙洲历1024年')
    expect(lodashGet(state, '当前角色.苏月珑.当前想法')).toBe('')
  })

  it('取不到时返回兜底值（空字符串与 0 算取到了）', () => {
    expect(lodashGet(state, '世界.当前地点', 'N/A')).toBe('N/A')
    expect(lodashGet(state, '世界.好感度', 'N/A')).toBe(0)
    expect(lodashGet(null, '世界', 'N/A')).toBe('N/A')
    expect(lodashGet(state, '', 'N/A')).toBe(state)
  })
})

describe('kebabCase', () => {
  it('中文原样、空格与驼峰转短横线', () => {
    expect(kebabCase('苏月珑')).toBe('苏月珑')
    expect(kebabCase('Current Time')).toBe('current-time')
    expect(kebabCase('currentTime')).toBe('current-time')
  })
})

describe('buildStatusBridgeScript', () => {
  const script = buildStatusBridgeScript({
    charName: '鲸鱼娘',
    userName: '旅人',
    statData: { 世界: { 当前时间: '</script><b>x' } }
  })
  const body = script.slice(script.indexOf('>') + 1, script.lastIndexOf('</script>'))

  it('注入的脚本语法正确', () => {
    expect(() => new Function(body)).not.toThrow()
  })

  it('补齐卡页面依赖的全局', () => {
    for (const name of ['window._', 'window.$', 'window.jQuery', 'window.getAllVariables', 'waitGlobalInitialized', 'errorCatched']) {
      expect(body).toContain(name)
    }
  })

  it('变量里的 </script> 被转义，不会截断注入脚本', () => {
    expect(body).not.toContain('</script>')
    expect(body).toContain('\\u003c/script>')
  })

  // 沙箱 iframe 没有 allow-same-origin，卡页面里第一句读 localStorage 就抛 SecurityError，
  // 整段脚本当场中断——页面只剩下骨架，数据区全是 `---`。这是最常见的「状态栏不成功」。
  it('补上 localStorage / sessionStorage（沙箱里原生的会抛异常）', () => {
    expect(body).toContain('Object.defineProperty(window, "localStorage"')
    expect(body).toContain('Object.defineProperty(window, "sessionStorage"')
    expect(body).toContain('makeStorage()')
  })

  // 卡按酒馆写法传 `{stat_data: {…}}`：不解包的话整个 stat_data 会变成变量树里的一个键，
  // 真实字段一个都不更新（页面看起来「点了没反应」）
  it('insertOrAssignVariables 也解包 stat_data 外壳', () => {
    expect(body).toContain('vars && vars.stat_data ? vars.stat_data : vars')
  })

  it('insertOrAssignVariables 走深合并，不会整棵子树替换', () => {
    expect(body).toContain('deepMerge(deepMerge({}, snapshot.statData), patch || {})')
  })

  // 名字里带 `$&` / `$1` 时，字符串形式的替换值会被当成替换模式展开（项目已知坑）
  it('用户名 / 角色名的宏替换用函数式 replace', () => {
    expect(body).toContain('function () { return snapshot.userName }')
    expect(body).toContain('function () { return snapshot.charName }')
  })

  it('脚本报错要报回父页，不能安静地停在半成品上', () => {
    expect(body).toContain('tavern_error')
    expect(body).toContain('unhandledrejection')
  })

  // 卡页面的错几乎全是脚本错；图片 / 字体加载失败在 capture 阶段也会派发 error 事件，
  // 但它们 message 为空，报上去就是一片「这个状态页的脚本报错了」的假警报
  it('只报真正的脚本错误，资源加载失败不算', () => {
    expect(body).toContain('if (!event || !event.message) return')
  })

  // 卡页面偶尔会摸 parent.document 找酒馆宿主；沙箱 iframe 跨源，直接读就是 SecurityError
  it('给 parent 一个桩（并保留转发 postMessage 的能力）', () => {
    expect(body).toContain('Object.defineProperty(window, "parent"')
    expect(body).toContain('realPost')
  })

  // appendTo 的目标是选择器 / DOM 节点，不是要拼的 HTML：toNodes 把所有字符串都当模板，
  // $('<div>…').appendTo('#statGrid') 会把 '#statGrid' 变成一个游离文本节点，网格永远空着
  it('appendTo 的目标走 query 判定，选择器不会再被当成 HTML 模板', () => {
    expect(body).toContain('query(target).append(this)')
  })

  it('补齐酒馆助手的常用全局', () => {
    for (const name of ['window.getChatMessages', 'window.getLastMessageId', 'window.Mvu', 'window.eventOn', 'window.triggerSlash', 'window.SillyTavern', 'window.TavernHelper', 'window.toastr']) {
      expect(body).toContain(name)
    }
  })
})

describe('selectMessages', () => {
  const messages = [
    { message_id: 0, role: 'assistant' },
    { message_id: 1, role: 'user' },
    { message_id: 2, role: 'assistant' },
    { message_id: 3, role: 'assistant' }
  ]

  it('`0-2` 取闭区间', () => {
    expect(selectMessages(messages, '0-2').map((item) => item.message_id)).toEqual([0, 1, 2])
  })

  it('单个数字只取那一楼', () => {
    expect(selectMessages(messages, 3).map((item) => item.message_id)).toEqual([3])
  })

  it('数组按下标挑楼层', () => {
    expect(selectMessages(messages, [0, 2]).map((item) => item.message_id)).toEqual([0, 2])
  })

  it('负数取倒数第几楼', () => {
    expect(selectMessages(messages, '-2--1').map((item) => item.message_id)).toEqual([2, 3])
  })

  // 快照截断后 message_id 从窗口起点数起（runtime.ts 的 `offset + index`）：
  // 拿数组下标当楼层的话，100 条只带最后 80 条时 `-1` 会取到倒数第 21 条
  it('楼层按 message_id 算，负数不会取错', () => {
    const window = Array.from({ length: 80 }, (_, index) => ({
      message_id: 20 + index,
      role: index % 2 === 0 ? 'assistant' : 'user'
    }))
    expect(selectMessages(window, '-1').map((item) => item.message_id)).toEqual([99])
    expect(selectMessages(window, '-2--1').map((item) => item.message_id)).toEqual([98, 99])
    // 比窗口起点还早的楼层（整场 100 条时的 `0-3`）按窗口内位置近似，不是空数组
    expect(selectMessages(window, '0-3').map((item) => item.message_id)).toEqual([20, 21, 22, 23])
  })

  it('空列表不炸', () => {
    expect(selectMessages([], '0-3')).toEqual([])
  })
})

describe('parseSlash', () => {
  it('切成命令名与小写化的参数', () => {
    expect(parseSlash('/send 你好')).toEqual({ name: 'send', args: '你好' })
    expect(parseSlash('  /Send  你好  ')).toEqual({ name: 'send', args: '你好' })
  })

  it('没有参数的命令', () => {
    expect(parseSlash('/trigger')).toEqual({ name: 'trigger', args: '' })
  })

  it('不以斜杠开头时整句当玩家发言', () => {
    expect(parseSlash('我推开门')).toEqual({ name: '', args: '我推开门' })
    expect(parseSlash(null)).toEqual({ name: '', args: '' })
  })
})
