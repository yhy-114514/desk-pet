// 使用说明（#help 窗口）：把整个软件的功能摊开讲一遍。
// 新手第一个接触点是托盘，所以它是一份「随时能回来查」的说明书，不自动弹、没有已读记号。
// 内容与渲染分开：改文案只动 SECTIONS，不动下面的绘制逻辑。

// macOS 上托盘叫「菜单栏」、修饰键是 Command 不是 Ctrl，照着 Windows 写会让人找不到东西
const IS_MAC = /Mac OS X|Macintosh/.test(navigator.userAgent)
const MENU_BAR = IS_MAC ? '菜单栏' : '托盘'
const HOTKEY = IS_MAC ? '⌘ + Shift + Space' : 'Ctrl + Shift + Space'

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'note'; text: string }
  | { kind: 'pre'; text: string }
  | { kind: 'columns'; items: { label: string; flex: number }[] }

interface Section {
  id: string
  icon: string
  title: string
  blocks: Block[]
}

const SECTIONS: Section[] = [
  {
    id: 'meet',
    icon: '🐳',
    title: '认识鲸鱼娘',
    blocks: [
      {
        kind: 'p',
        text: `蓝色大肥鱼会一直待在桌面角落陪你。她住在系统${MENU_BAR}里——桌面上没有任务栏图标，窗口也不会挡住你：鼠标从她身上划过时会直接穿透到下面的窗口。`
      },
      {
        kind: 'list',
        items: [
          `找不到她了：${IS_MAC ? '点一下' : '左键单击'}${MENU_BAR}里的小鲸鱼图标，她会立刻回到屏幕右下角。`,
          '她不见了：可能是被「把她藏起来」收起来了，再点一次「让她出来」。',
          '换屏幕了：把她拖到哪块屏幕，下次启动就还在那；拔掉副屏她会自动回到主屏。'
        ]
      },
      {
        kind: 'note',
        text: `几乎所有功能都能在${MENU_BAR}菜单里找到，没事${IS_MAC ? '点' : '右键点'}一下${MENU_BAR}图标看看。`
      }
    ]
  },
  {
    id: 'play',
    icon: '🖱️',
    title: '和她玩',
    blocks: [
      {
        kind: 'p',
        text: '她不只是站着：会眨眼、打哈欠、伸懒腰；不理她太久，她会有点失落，然后打瞌睡。'
      },
      {
        kind: 'list',
        items: [
          '左键单击：她开心一下（好感度 +1）。',
          '左键连续快速点 20 下：她会翻个白眼吐槽你。',
          '按住左键 1 秒：把她拖起来，挪到别的角落。',
          '按住左键划动：摸她，她会舒服得冒音符（好感度 +2）。',
          '右键单击她：进入 / 退出「游动」状态。',
          '游动中单击桌面：她跟着鼠标游；双击桌面：她游过去。',
          '喂饭：托盘「喂她一顿大白饭」或输入栏「喂饭」，好感度 +3。'
        ]
      },
      { kind: 'note', text: '好感度越高，她解锁的台词和小彩蛋越多。' }
    ]
  },
  {
    id: 'chat',
    icon: '💬',
    title: '和她聊天',
    blocks: [
      {
        kind: 'p',
        text: `按 ${HOTKEY} 唤出浮动输入栏（${MENU_BAR}「打开输入栏」也一样）。输入后回车发送，Esc 收起。`
      },
      {
        kind: 'list',
        items: [
          '她的话会一个字一个字打出来，边上还带表情和语音（语音可关）。',
          '想让她换话题，直接再发一条——上一句会被打断。',
          '第一次用要先在配置窗填 DeepSeek 的 API Key；之后从输入栏「设置」或托盘「设置…」随时能改。',
          '日常聊天用 deepseek-flash（快、省）；更复杂的可以切 deepseek-v4-pro。'
        ]
      },
      { kind: 'note', text: 'Key 只保存在本机，不会发给别的软件。' }
    ]
  },
  {
    id: 'voice',
    icon: '🔊',
    title: '语音',
    blocks: [
      {
        kind: 'list',
        items: [
          '朗读她的回复：配置窗里的开关（默认开）；酒馆「外观 → 通用」里也有同一个开关。',
          '想听她按情绪读（开心就轻快、难过就低沉），要在配置窗填阿里云百炼的 Key，然后选千问那组音色。',
          '语音输入：输入栏那个 🎤——点一下开始录、再点一下结束，识别出来的字会填进输入框（不会自动发出去），确认没问题再回车。'
        ]
      },
      {
        kind: 'note',
        text: '语音输入和情绪朗读都要百炼 Key；不填就用免费的普通朗读（固定语气）。'
      }
    ]
  },
  {
    id: 'memory',
    icon: '⏰',
    title: '记忆和提醒',
    blocks: [
      { kind: 'p', text: '她会自己记住你聊过的事，下次提起时能想起来。' },
      {
        kind: 'list',
        items: [
          '记忆手账：托盘「记忆手账…」或输入栏「记忆」，能看到她记住了什么，还能搜、改、删。',
          '提醒：直接跟她说「两分钟后提醒我喝水」，到点她就开口叫你。',
          '提醒事项：托盘「提醒事项…」或输入栏「提醒」，能改时间、改内容、撤掉。'
        ]
      },
      { kind: 'note', text: '记忆有偏差就改掉她，之后她会按你说的来。' }
    ]
  },
  {
    id: 'proactive',
    icon: '💌',
    title: '主动消息',
    blocks: [
      {
        kind: 'p',
        text: '她会在早上、中午、晚上问候你；你安静太久（半小时以上），她也会主动找你说说话。'
      },
      {
        kind: 'list',
        items: [
          '深夜 23:00–07:00 她不会打扰你。',
          '不想被打扰时，托盘「允许她主动找我说话」取消勾选即可（配置窗里是同一个开关）。'
        ]
      }
    ]
  },
  {
    id: 'tray',
    icon: '⚙️',
    title: `${MENU_BAR}和设置`,
    blocks: [
      { kind: 'p', text: `${IS_MAC ? '点' : '右键'}${MENU_BAR}里的鲸鱼娘图标，就是她的全部开关：` },
      {
        kind: 'pre',
        text: [
          `打开输入栏          ${HOTKEY}`,
          '把她藏起来 / 让她出来',
          '喂她一顿大白饭',
          '允许她主动找我说话    ☑',
          '开机自动醒来          ☑',
          '记忆手账…',
          '提醒事项…',
          '打开酒馆…',
          '设置…',
          '使用说明…',
          '关于鲸鱼娘…',
          '退出'
        ].join('\n')
      },
      {
        kind: 'list',
        items: [
          '开机自启：勾上「开机自动醒来」，开机后她自动出现（默认关）。',
          '设置：配置 API Key、模型、音色、朗读开关、主动消息开关。'
        ]
      }
    ]
  },
  {
    id: 'tavern',
    icon: '🏮',
    title: '酒馆是什么',
    blocks: [
      {
        kind: 'p',
        text: '酒馆是和角色卡聊天的地方——一张卡就是一个角色，能导入现成的卡，也能自己新建。从托盘「打开酒馆…」进入。'
      },
      { kind: 'p', text: '酒馆是个三栏窗口：' },
      {
        kind: 'columns',
        items: [
          { label: '角色列表', flex: 1 },
          { label: '角色库 / 聊天正文', flex: 2 },
          { label: '鲸鱼娘旁观', flex: 1 }
        ]
      },
      {
        kind: 'list',
        items: [
          '左栏：你的角色和群聊，点一下就进去聊。',
          '中栏：角色库（导入 / 新建 / 群聊 / 我的人设 / 回收站），或者进入某张卡后的聊天。',
          '右栏：鲸鱼娘陪你旁观的抽屉（只在单聊里有）。'
        ]
      },
      {
        kind: 'list',
        items: [
          '导入角色卡：支持 SillyTavern 的 PNG / JSON 卡（角色库「导入」）。',
          '进卡开聊：第一次进会先问用哪段开场白，也可以不用开场白直接开始。',
          '群聊：角色库「群聊」，挑 2–5 个角色一起聊；想点谁就 @名字，被点到的一定接话。'
        ]
      }
    ]
  },
  {
    id: 'advanced',
    icon: '🧙',
    title: '酒馆进阶',
    blocks: [
      {
        kind: 'p',
        text: '聊天页右上角的「⋯」和「⚙」里，是她更专业的那一面。新手可以先不管，需要时再回来看：'
      },
      {
        kind: 'list',
        items: [
          '世界书：给角色补充背景设定，说到关键词才生效。',
          '正则：自动清理或替换回复里的文字和代码。',
          '预设：一整套提示词和采样参数，可以从别处导入。',
          '文风 / 回复：调整她的说话风格和篇幅。',
          '状态栏 / 变量：卡里带的状态页会跟着剧情更新（时间、地点、任务之类）。',
          '忆境：把很长的对话压缩成剧情档案，她就不会忘了前情。',
          '外观：换主题（深海夜航 / 浅海晨光）、背景、气泡颜色、字体、背景音乐。',
          '备份与恢复：⚙ → 备份与恢复，导出 / 导入一份 .zip；换电脑或重装前记得先备份。'
        ]
      },
      { kind: 'note', text: '群聊里 @名字 一定有人接话；不 @ 时她们会自己判断该谁接。' }
    ]
  }
]

/** 小工具：造元素 + 一段内联样式 */
function el(tag: string, css: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.style.cssText = css
  if (text !== undefined) node.textContent = text
  return node
}

function renderBlock(block: Block): HTMLElement {
  switch (block.kind) {
    case 'p':
      return el('div', 'font-size:13px;line-height:1.75;color:var(--pet-text)', block.text)
    case 'list': {
      const list = el(
        'div',
        'display:flex;flex-direction:column;gap:7px;font-size:13px;line-height:1.7;color:var(--pet-label)'
      )
      for (const item of block.items) {
        const row = el('div', 'display:flex;gap:8px')
        row.append(
          el('span', 'flex:none;color:var(--pet-accent)', '·'),
          el('span', 'flex:1;min-width:0', item)
        )
        list.append(row)
      }
      return list
    }
    case 'note': {
      const note = el(
        'div',
        'font-size:12.5px;line-height:1.65;color:var(--pet-muted);background:var(--pet-card);' +
          'border-left:3px solid var(--pet-accent);border-radius:0 8px 8px 0;padding:9px 12px',
        block.text
      )
      return note
    }
    case 'pre': {
      const pre = el(
        'pre',
        'margin:0;font:12.5px/1.7 ui-monospace,Consolas,monospace;color:var(--pet-text);' +
          'background:var(--pet-input-bg);border:1px solid var(--pet-border);border-radius:8px;' +
          'padding:11px 13px;overflow-x:auto;white-space:pre',
        block.text
      )
      return pre
    }
    case 'columns': {
      // 三栏示意：中文是双宽字符，用等宽字符画框永远对不齐，直接画三个真框
      const row = el('div', 'display:flex;gap:6px')
      for (const item of block.items) {
        const box = el(
          'div',
          `flex:${item.flex};min-width:0;display:flex;align-items:center;justify-content:center;` +
            'text-align:center;padding:16px 8px;font-size:12.5px;line-height:1.5;color:var(--pet-label);' +
            'background:var(--pet-input-bg);border:1px solid var(--pet-border);border-radius:8px',
          item.label
        )
        row.append(box)
      }
      return row
    }
  }
}

export function renderHelpPage(): void {
  document.body.style.cssText =
    'margin:0;background:var(--pet-bg);color:var(--pet-fg);font:14px var(--pet-font);overflow:hidden'

  // 深色细滚动条：原生白色滚动条在深底上太扎眼
  const style = document.createElement('style')
  style.textContent =
    '::-webkit-scrollbar{width:8px}' +
    '::-webkit-scrollbar-track{background:transparent}' +
    '::-webkit-scrollbar-thumb{background:var(--pet-scrollbar);border-radius:4px}' +
    '::-webkit-scrollbar-thumb:hover{background:var(--pet-scrollbar-hover)}' +
    '#help-content{scroll-behavior:smooth}'
  document.head.appendChild(style)

  const wrap = el(
    'div',
    'box-sizing:border-box;height:100vh;padding:20px 22px;display:flex;flex-direction:column;gap:12px'
  )

  // ── 标题 ──
  const header = el('div', 'display:flex;align-items:baseline;gap:10px;flex:none')
  header.append(
    el('div', 'font-size:17px;font-weight:600', '使用说明'),
    el('div', 'font-size:12px;color:var(--pet-muted)', '鲸鱼娘 · 桌宠和酒馆')
  )

  // ── 目录：点一下跳到对应小节 ──
  const nav = el('div', 'display:flex;flex-wrap:wrap;gap:6px;flex:none')
  const content = el(
    'div',
    'flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:20px;' +
      'padding:2px 4px 8px 0;border-top:1px solid var(--pet-divider);padding-top:16px'
  )
  content.id = 'help-content'

  for (const section of SECTIONS) {
    const chip = el(
      'button',
      'border:0;border-radius:999px;padding:4px 11px;cursor:pointer;font:12px var(--pet-font);' +
        'background:var(--pet-toggle-bg);color:var(--pet-label-alt)',
      `${section.icon} ${section.title}`
    )
    chip.onclick = (): void => {
      document.getElementById(`help-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    nav.append(chip)

    const article = el('section', 'display:flex;flex-direction:column;gap:11px;scroll-margin-top:8px')
    article.id = `help-${section.id}`
    const heading = el('div', 'display:flex;align-items:center;gap:8px')
    heading.append(
      el('span', 'font-size:17px;line-height:1', section.icon),
      el('span', 'font-size:15px;font-weight:600;color:var(--pet-fg)', section.title)
    )
    article.append(heading)
    for (const block of section.blocks) article.append(renderBlock(block))
    content.append(article)
  }

  // ── 底部 ──
  const footer = el('div', 'display:flex;justify-content:flex-end;flex:none')
  const close = el(
    'button',
    'background:var(--pet-accent);color:var(--pet-on-accent);border:0;border-radius:8px;' +
      'padding:8px 20px;font:13px var(--pet-font);cursor:pointer',
    '关闭'
  )
  close.onclick = (): void => window.help.close()
  footer.append(close)

  wrap.append(header, nav, content, footer)
  document.body.appendChild(wrap)
}
