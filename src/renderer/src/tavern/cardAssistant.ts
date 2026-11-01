// 角色卡编辑页的「问问鲸鱼娘」（T7）：审卡 / 帮写 / 体检并修复。
// 前两个和观战抽屉同一套主进程逻辑，只是材料换成这张卡的字段与世界书条目名；
// 「体检并修复」读全量卡数据（世界书正文 + 正则脚本），返回问题清单，
// 每条可在确认后由她直接改回卡里（见 main/tavern/spectator.ts 的 diagnoseCard / applyCardFix）。
import { findCardItem, type CardFix, type CardIssue } from '../../../shared/cardFix'
import { h } from './ui'

export interface CardAssistantOptions {
  root: HTMLElement
  characterId: string
  name: string
  /** 修复写回卡之后叫一声：编辑页要重新载入，否则表单里是旧值 */
  onChanged?: () => void
}

interface Live {
  characterId: string
  pending: HTMLElement | null
  onToken: (delta: string) => void
  onDone: () => void
  onError: (message: string) => void
}

let live: Live | null = null
/** 当前开着的面板。同一时刻只留一层：overlay 挂在 #tavern 根上，
 *  换卡再开一层的话，旧那层的 token 全被新的 live 挡掉，气泡永远空着。 */
let openOverlay: HTMLElement | null = null
let bound = false

function bindListeners(): void {
  if (bound) return
  bound = true
  window.tavern.onCardAssistantToken((data) => {
    if (live?.characterId === data.characterId) live.onToken(data.delta)
  })
  window.tavern.onCardAssistantDone((data) => {
    if (live?.characterId === data.characterId) live.onDone()
  })
  window.tavern.onCardAssistantError((data) => {
    if (live?.characterId === data.characterId) live.onError(data.error)
  })
}

const SEVERITY_LABEL: Record<CardIssue['severity'], string> = {
  high: '严重',
  medium: '建议',
  low: '小问题'
}

/** 修复指令里改的是哪个字段 / 哪条，用来显示「改动前后」 */
async function describeFix(fix: CardFix, characterId: string): Promise<string[]> {
  const lines: string[] = []
  if (fix.type === 'field') {
    const card = await window.tavern.cardsGet(characterId)
    const map: Record<string, string> = {
      description: '角色描述',
      personality: '性格',
      scenario: '场景',
      firstMes: '主开场白',
      systemPrompt: '系统提示词',
      postHistoryInstructions: '历史后指令',
      mesExample: '对话示例'
    }
    const before = card ? String(card[fix.field] ?? '') : ''
    lines.push(`${map[fix.field] ?? fix.field}：`)
    lines.push(`  改前：${before.slice(0, 200) || '（空）'}`)
    lines.push(`  改后：${fix.value.slice(0, 200) || '（空）'}`)
    return lines
  }
  if (fix.type === 'regex') {
    const all = await window.tavern.regexAll(characterId)
    // 和主进程执行修复用同一个查找口径（他也容忍模型抄丢的 `card:` 前缀），
    // 否则会出现「预览说新增一条、点了却覆盖掉已有那条」
    const rule = findCardItem(all.card, fix.ruleId)
    if (fix.remove) {
      lines.push(`删除正则「${rule?.name ?? fix.ruleId}」`)
      return lines
    }
    if (rule) lines.push(`正则「${rule.name}」：`)
    else lines.push('新增一条正则：')
    const patch = fix.patch ?? {}
    // 只列真正变了的地方：模型常把整条规则原样带回来，全列一遍等于让人看一串「g → g」
    if (patch.pattern !== undefined && patch.pattern !== rule?.pattern) {
      lines.push(`  pattern：${rule?.pattern ?? '（无）'} → ${patch.pattern}`)
    }
    if (patch.flags !== undefined && patch.flags !== rule?.flags) {
      lines.push(`  flags：${rule?.flags ?? '（无）'} → ${patch.flags}`)
    }
    if (patch.replacement !== undefined && patch.replacement !== (rule?.replacement ?? '')) {
      lines.push(
        `  replacement：${(rule?.replacement ?? '').slice(0, 120) || '（空）'} → ${patch.replacement.slice(0, 120) || '（空）'}`
      )
    }
    if (patch.name !== undefined && patch.name !== rule?.name) {
      lines.push(`  名称：${rule?.name ?? '（无）'} → ${patch.name}`)
    }
    if (patch.target !== undefined && patch.target !== rule?.target) {
      lines.push(`  作用面：${rule?.target ?? '（无）'} → ${patch.target}`)
    }
    if (patch.enabled !== undefined && patch.enabled !== rule?.enabled) {
      lines.push(`  启用：${patch.enabled ? '开' : '关'}`)
    }
    if (lines.length === 1) lines.push('  （和现在一样，没有实际改动）')
    return lines
  }
  const { lore } = await window.tavern.cardLore(characterId)
  const entry = findCardItem(lore, fix.entryId)
  if (fix.remove) {
    lines.push(`删除世界书条目「${entry?.name ?? fix.entryId}」`)
    return lines
  }
  if (entry) lines.push(`世界书条目「${entry.name}」：`)
  else lines.push('新增一条世界书条目：')
  const patch = fix.patch ?? {}
  if (patch.content !== undefined && patch.content !== (entry?.content ?? '')) {
    lines.push(`  正文：${(entry?.content ?? '').slice(0, 160) || '（空）'} → ${patch.content.slice(0, 160) || '（空）'}`)
  }
  if (patch.keys !== undefined && patch.keys.join('|') !== (entry?.keys ?? []).join('|')) {
    lines.push(`  触发词：${(entry?.keys ?? []).join('、') || '（无）'} → ${patch.keys.join('、') || '（空）'}`)
  }
  if (patch.name !== undefined && patch.name !== entry?.name) {
    lines.push(`  名称：${entry?.name ?? '（无）'} → ${patch.name}`)
  }
  if (patch.constant !== undefined && patch.constant !== entry?.constant) {
    lines.push(`  常驻：${patch.constant ? '开' : '关'}`)
  }
  if (lines.length === 1) lines.push('  （和现在一样，没有实际改动）')
  return lines
}

export function openCardAssistant(options: CardAssistantOptions): void {
  bindListeners()
  const { root } = options
  // 换一张卡再点「问问鲸鱼娘」：先把上一层的面板收掉，不然后面那层收不到 token
  openOverlay?.remove()
  openOverlay = null
  const overlay = h('div', 'modal-mask')
  const box = h('div', 'modal prompt-modal')
  const close = h('button', 'modal-close', '✕')
  const head = h('div', 'modal-head')
  head.append(h('div', 'modal-title', `问问鲸鱼娘 · ${options.name}`), h('div', 'grow'), close)
  const dismiss = (): void => {
    // 只认自己这一层：同一张卡可以开两次，关旧的那层别把新的摘掉
    if (live === panel) live = null
    if (openOverlay === overlay) openOverlay = null
    overlay.remove()
  }
  close.onclick = dismiss
  overlay.onclick = (event): void => {
    if (event.target === overlay) dismiss()
  }

  const chips = h('div', 'spec-chips')
  const review = h('button', '', '帮我审审这张卡')
  const write = h('button', '', '帮我想段开场白')
  const checkup = h('button', '', '帮我体检并修复')
  chips.append(review, write, checkup)

  const log = h('div', 'spec-log')
  const emptyHint = h(
    'div',
    'spec-empty',
    '她会读这张卡的描述 / 性格 / 场景 / 开场白和世界书条目名。\n' +
      '「体检并修复」会连世界书正文和正则脚本一起看，查出问题可以让她直接改回卡里。\n' +
      '卡里没写的她会直说，不会替你编。'
  )
  log.append(emptyHint)

  const hint = h('div', 'spec-hint', '')
  const say = (text: string, bad = false): void => {
    hint.textContent = text
    hint.classList.toggle('bad', bad)
  }

  const composer = h('div', 'spec-composer')
  const input = document.createElement('textarea')
  input.placeholder = '有什么想问的？比如「设定有没有矛盾」'
  input.rows = 1
  const askBtn = h('button', 'btn primary', '问')
  composer.append(input, askBtn)

  box.append(head, chips, log, hint, composer)
  overlay.append(box)
  root.append(overlay)
  openOverlay = overlay

  let busy = false
  // 这一层面板自己的身份：同一个 id 的卡可以关掉再开，旧请求的收尾不能动新面板
  const panel: Live = {
    characterId: options.characterId,
    pending: null,
    onToken: (delta) => {
      if (!panel.pending) return
      panel.pending.textContent = (panel.pending.textContent ?? '') + delta
      log.scrollTop = log.scrollHeight
    },
    onDone: () => {
      panel.pending = null
    },
    onError: (message) => say(message, true)
  }
  live = panel

  const push = (role: 'user' | 'bot', text: string): HTMLElement => {
    const node = h('div', `spec-msg ${role}`)
    if (role === 'bot') node.append(h('div', 'spec-who', '鲸鱼娘'))
    const body = h('div', 'spec-text', text)
    node.append(body)
    log.append(node)
    log.scrollTop = log.scrollHeight
    return body
  }

  const ask = async (question: string): Promise<void> => {
    const text = question.trim()
    if (!text || busy) return
    busy = true
    say('')
    input.value = ''
    emptyHint.remove()
    push('user', text)
    const body = push('bot', '')
    panel.pending = body
    askBtn.disabled = true
    let failed = false
    try {
      const result = await window.tavern.cardAssistantAsk({
        characterId: options.characterId,
        question: text
      })
      if (!result.ok) {
        failed = true
        say(result.error ?? '她没回上来，再问一次？', true)
      }
    } catch (error) {
      failed = true
      say(`她没回上来：${String(error)}`, true)
    } finally {
      busy = false
      // 面板已经关掉 / 换成了新的一次：这次的结果不再往界面里写
      if (live === panel) {
        // 失败且一个字都没收到：把空气泡收掉
        if (failed && !panel.pending?.textContent) {
          ;(panel.pending?.parentElement ?? body.parentElement)?.remove()
        }
        panel.pending = null
        askBtn.disabled = false
      }
    }
  }

  // ── 体检并修复 ──
  const runCheckup = async (): Promise<void> => {
    if (busy) return
    busy = true
    say('她正在逐条检查这张卡（世界书正文 + 正则脚本，可能要十几秒）…')
    emptyHint.remove()
    checkup.disabled = true
    push('user', '帮我体检一下这张卡，把有问题的地方都找出来，能修的直接给我修好。')
    const body = push('bot', '')
    panel.pending = body
    try {
      const result = await window.tavern.cardAssistantDiagnose(options.characterId)
      body.textContent = ''
      if (live !== panel) return
      if (!result.ok) {
        say(result.error ?? '这次没查成，再试一次？', true)
        body.parentElement?.remove()
        return
      }
      const issues = result.issues ?? []
      if (issues.length === 0) {
        body.textContent = '我仔细看了一遍，没发现明显会让它出问题的地方。'
        say('')
        return
      }
      body.textContent = `查出 ${issues.length} 处，能修的在下面点「应用修复」——我会直接改进卡里。`
      for (const issue of issues) log.append(issueCard(issue))
      say('')
      log.scrollTop = log.scrollHeight
    } catch (error) {
      body.textContent = ''
      say(`体检没跑成：${String(error)}`, true)
    } finally {
      busy = false
      checkup.disabled = false
      if (live === panel) panel.pending = null
    }
  }

  /** 一条问题：严重度 + 标题 + 说明，有 fix 就展开「改动前后」并给应用按钮 */
  const issueCard = (issue: CardIssue): HTMLElement => {
    const wrap = h('div', 'spec-msg bot')
    wrap.append(h('div', 'spec-who', `鲸鱼娘 · ${SEVERITY_LABEL[issue.severity] ?? issue.severity}`))
    wrap.append(h('div', 'spec-text', issue.title))
    if (issue.detail) wrap.append(h('div', 'hintline', issue.detail))
    if (!issue.fix) {
      wrap.append(h('div', 'hintline', '（这处她没法替你精确定改，看着办～）'))
      return wrap
    }
    const fix = issue.fix
    const detail = h('pre', 'dossier-view', '')
    detail.style.display = 'none'
    const toggleBtn = h('button', 'btn ghost', '看看怎么改')
    toggleBtn.onclick = (): void => {
      void (async () => {
        if (detail.style.display !== 'none') {
          detail.style.display = 'none'
          toggleBtn.textContent = '看看怎么改'
          return
        }
        if (!detail.textContent) {
          try {
            detail.textContent = (await describeFix(fix, options.characterId)).join('\n')
          } catch (error) {
            detail.textContent = `读不出当前值：${String(error)}`
          }
        }
        detail.style.display = ''
        toggleBtn.textContent = '收起'
      })()
    }
    const applyBtn = h('button', 'btn primary', '应用修复')
    const status = h('div', 'hintline', '')
    applyBtn.onclick = (): void => {
      void (async () => {
        if (!window.confirm('确认把这条修复写回角色卡？改完编辑页会重新载入。')) return
        applyBtn.disabled = true
        status.textContent = '正在写回…'
        status.classList.remove('bad')
        try {
          const res = await window.tavern.cardAssistantFix(options.characterId, fix)
          if (!res.ok) {
            status.textContent = `没修上：${res.error ?? '未知错误'}`
            status.classList.add('bad')
            applyBtn.disabled = false
            return
          }
          status.textContent = '✓ 已修复'
          wrap.classList.add('fixed')
          toggleBtn.remove()
          applyBtn.remove()
          options.onChanged?.()
        } catch (error) {
          status.textContent = `没修上：${String(error)}`
          status.classList.add('bad')
          applyBtn.disabled = false
        }
      })()
    }
    const actions = h('div', 'panel-row')
    actions.append(toggleBtn, applyBtn)
    wrap.append(actions, detail, status)
    return wrap
  }

  review.onclick = (): void => {
    void ask('帮我审一下这张卡：设定有没有自相矛盾、开场白和描述对不对得上、世界书条目有没有打架或缺失的地方？')
  }
  write.onclick = (): void => {
    void ask('按这张卡的设定，帮我想一段开场白，直接给我能粘贴进卡里的文字。')
  }
  checkup.onclick = (): void => {
    void runCheckup()
  }
  askBtn.onclick = (): void => {
    void ask(input.value)
  }
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.isComposing) return
    event.preventDefault()
    void ask(input.value)
  })
  input.focus()
}
