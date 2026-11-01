// 提示词工具面板（T4）：世界书 / 正则 / 预设 / 文风 / 回复与状态栏。
//
// 五个页签共用同一个遮罩窗口——它们在酒馆里都是「配置提示词」这件事，
// 分成五个弹窗只会让用户找不到刚才改的是哪一项。改动即时落库（输入框失焦 / 点按钮），
// 只有预设的条目勾选需要点「保存」（一次改很多项，逐项写库既慢又容易写坏）。
import {
  area,
  button,
  entryEditor,
  input,
  label,
  renderCardLoreList,
  renderCardRegexList,
  row,
  ruleEditor,
  section,
  toggle,
  type EditorCtx
} from './loreRegexEditors'
import { h } from './ui'

export type PromptTab = 'lore' | 'regex' | 'preset' | 'style' | 'reply' | 'status'

export interface PromptPanelOptions {
  /** 挂载点（#tavern 根节点） */
  root: HTMLElement
  /** 打开时直接落在哪一页 */
  tab?: PromptTab
  /** 角色页签用：角色世界书 / 角色正则 / 会话预设 */
  characterId?: string | null
  chatId?: string | null
  onChanged?: () => void
}

type TavernApi = Window['tavern']
type Lorebook = Awaited<ReturnType<TavernApi['lorebooksList']>>[number]
type PresetSummary = Awaited<ReturnType<TavernApi['presetsList']>>['items'][number]
type PresetData = NonNullable<Awaited<ReturnType<TavernApi['presetsGet']>>>
type Style = Awaited<ReturnType<TavernApi['stylesList']>>[number]
type Settings = Awaited<ReturnType<TavernApi['promptSettings']>>

const TABS: { key: PromptTab; label: string }[] = [
  { key: 'lore', label: '世界书' },
  { key: 'regex', label: '正则' },
  { key: 'preset', label: '预设' },
  { key: 'style', label: '文风' },
  { key: 'reply', label: '回复' },
  { key: 'status', label: '状态栏' }
]

export function openPromptPanel(options: PromptPanelOptions): void {
  const overlay = h('div', 'modal-mask')
  const box = h('div', 'modal prompt-modal')
  const title = h('div', 'modal-title', '提示词工具')
  const close = h('button', 'modal-close', '✕')
  const dismiss = (): void => overlay.remove()
  close.onclick = dismiss
  overlay.onclick = (event): void => {
    if (event.target === overlay) dismiss()
  }
  const head = h('div', 'modal-head')
  head.append(title, h('div', 'grow'), close)

  const notice = h('div', 'notice', '')
  const say = (text: string, bad = false): void => {
    notice.textContent = text
    notice.classList.toggle('bad', bad)
  }

  const tabs = h('div', 'prompt-tabs')
  const body = h('div', 'modal-body')
  box.append(head, tabs, notice, body)
  overlay.append(box)
  options.root.append(overlay)

  let current: PromptTab = options.tab ?? 'lore'
  const paint = (): void => {
    for (const button of Array.from(tabs.querySelectorAll('button'))) {
      button.setAttribute('aria-pressed', String(button.dataset['key'] === current))
    }
    body.replaceChildren()
    say('')
    const ctx = {
      body,
      say,
      characterId: options.characterId ?? null,
      chatId: options.chatId ?? null,
      onChanged: options.onChanged,
      dismiss
    }
    if (current === 'lore') void renderLore(ctx)
    else if (current === 'regex') void renderRegex(ctx)
    else if (current === 'preset') void renderPreset(ctx)
    else if (current === 'style') void renderStyle(ctx)
    else if (current === 'reply') void renderReply(ctx)
    else void renderStatus(ctx)
  }
  for (const tab of TABS) {
    const button = h('button', '', tab.label)
    button.dataset['key'] = tab.key
    button.onclick = (): void => {
      current = tab.key
      paint()
    }
    tabs.append(button)
  }
  paint()
}

interface Ctx {
  body: HTMLElement
  say: (text: string, bad?: boolean) => void
  characterId: string | null
  chatId: string | null
  onChanged?: () => void
  dismiss: () => void
}

/** 交给共用编辑器的上下文 */
function editorCtx(ctx: Ctx, refreshBooks?: () => void | Promise<void>): EditorCtx {
  return { say: ctx.say, onChanged: ctx.onChanged, refreshBooks }
}

// ── 世界书 ────────────────────────────────────────────────────────────

async function renderLore(ctx: Ctx): Promise<void> {
  const { body, say } = ctx
  const scope = ctx.characterId ? 'character' : 'global'
  const books = h('div', 'panel-list')
  body.append(
    section(ctx.characterId ? '这个角色的世界书' : '全局世界书'),
    h(
      'div',
      'hintline',
      '关键词条目命中最近几条对话才注入；常驻条目每轮都在（不占预算）。\n下面「卡内嵌」那一栏改的就是这张卡本身，导出卡时一并带走。'
    ),
    row(
      button('新建一本', 'primary', () => void createBook()),
      button('导入 ST 世界书', '', () => void importBook())
    ),
    books,
    section('卡内嵌世界书（改这里就是改卡）'),
    (() => {
      const card = h('div', 'panel-list')
      if (!ctx.characterId) {
        card.append(h('div', 'hintline', '从角色页打开时才能看到卡内嵌的世界书。'))
      }
      return card
    })()
  )
  const cardList = body.lastElementChild as HTMLElement

  async function createBook(): Promise<void> {
    const name = window.prompt('世界书名字？', '新的世界书')
    if (!name?.trim()) return
    await window.tavern.lorebooksCreate({
      name: name.trim(),
      scope,
      characterId: ctx.characterId
    })
    await refreshBooks()
  }

  async function importBook(): Promise<void> {
    const results = await window.tavern.lorebookImport({ scope, characterId: ctx.characterId })
    if (results.length === 0) return
    const failed = results.filter((item) => !item.ok)
    if (failed.length > 0) say(`有 ${failed.length} 个没导进来：${failed[0]!.error ?? ''}`, true)
    else say(`导入了 ${results.length} 本。`)
    await refreshBooks()
  }

  async function refreshBooks(): Promise<void> {
    const items = await window.tavern.lorebooksList(scope, ctx.characterId ?? undefined)
    books.replaceChildren()
    if (items.length === 0) {
      books.append(h('div', 'hintline', '还没有世界书。'))
    }
    for (const book of items) {
      books.append(bookRow(book))
    }
    if (ctx.characterId) await refreshCardLore()
  }

  async function refreshCardLore(): Promise<void> {
    if (!ctx.characterId) return
    await renderCardLoreList(cardList, ctx.characterId, editorCtx(ctx, refreshBooks))
  }

  function bookRow(book: Lorebook): HTMLElement {
    const wrap = h('div', 'panel-item')
    const head = row(
      h('div', 'panel-name', book.name),
      h('div', 'hintline', `${book.entryCount} 条`),
      h('div', 'grow'),
      toggle(book.enabled, (next) => {
        void window.tavern.lorebooksEnable(book.id, next)
      }),
      button('条目', '', () => void openBook(book)),
      button('导出', 'ghost', () => {
        void window.tavern.lorebookExport(book.id, book.name).then((result) => {
          if (!result.ok) say(result.error ?? '导出失败', true)
        })
      }),
      button('删', 'ghost danger', () => {
        if (!window.confirm(`删除世界书「${book.name}」？条目也会一起没。`)) return
        void window.tavern.lorebooksDelete(book.id).then(() => void refreshBooks())
      })
    )
    wrap.append(head)
    return wrap
  }

  async function openBook(book: Lorebook): Promise<void> {
    body.replaceChildren(
      row(
        button('← 返回列表', 'ghost', () => {
          // 整页重画而不是把旧节点挂回去：卡内嵌那一块在进条目页时已被清掉，
          // 挂回旧节点会少一段
          body.replaceChildren()
          void renderLore(ctx)
        }),
        h('div', 'panel-name', book.name)
      ),
      button('加一条', 'primary', () => void addEntry()),
      (() => {
        const list = h('div', 'panel-list')
        return list
      })()
    )
    const list = body.lastElementChild as HTMLElement
    const entries = await window.tavern.lorebookEntries(book.id)
    if (entries.length === 0) list.append(h('div', 'hintline', '还没有条目。'))
    for (const entry of entries) {
      list.append(
        entryEditor(
          entry,
          (input) => window.tavern.lorebookEntrySave(book.id, input),
          () => window.tavern.lorebookEntryDelete(entry.id),
          editorCtx(ctx)
        )
      )
    }

    async function addEntry(): Promise<void> {
      await window.tavern.lorebookEntrySave(book.id, {
        name: '新条目',
        keys: [],
        secondaryKeys: [],
        content: '',
        constant: false,
        selective: false,
        position: 'before_char',
        depth: 4,
        order: 100,
        caseSensitive: false
      })
      await openBook(book)
    }
  }

  await refreshBooks()
}

// ── 正则 ──────────────────────────────────────────────────────────────

async function renderRegex(ctx: Ctx): Promise<void> {
  const { body } = ctx
  const scope = ctx.characterId ? 'character' : 'global'
  const list = h('div', 'panel-list')
  const sample = area(
    '（把一段正文贴进来，这里会显示每条规则命中几次、最终长什么样）',
    4
  )
  const result = h('div', 'dossier-view', '')
  sample.oninput = (): void => void preview()
  body.append(
    section(ctx.characterId ? '这个角色的正则' : '全局正则'),
    h(
      'div',
      'hintline',
      '显示：只改界面上的样子；提示词：只改发给模型的内容；两边：都改。\n卡里自带的正则只搬运、不执行脚本（TavernHelper 脚本不在这一类）。'
    ),
    row(button('加一条', 'primary', () => void addRule())),
    list,
    section('实时测试'),
    sample,
    row(button('跑一遍', '', () => void preview())),
    result,
    section('卡内嵌正则（改这里就是改卡）'),
    (() => {
      const card = h('div', 'panel-list')
      if (!ctx.characterId) card.append(h('div', 'hintline', '从角色页打开时才能看到卡内嵌的正则。'))
      return card
    })()
  )
  const cardList = body.lastElementChild as HTMLElement

  async function preview(): Promise<void> {
    const text = sample.value.trim()
    if (!text) {
      result.textContent = ''
      return
    }
    const out = await window.tavern.regexPreview(ctx.characterId, text, 'display')
    const failures = out.failures.map((item) => `${item.rule.name}: ${item.error}`).join('；')
    result.textContent = `${out.result}${failures ? `\n\n⚠ ${failures}` : ''}`
  }

  async function addRule(): Promise<void> {
    await window.tavern.regexSave(
      {
        name: '新规则',
        pattern: '',
        flags: 'g',
        replacement: '',
        target: 'both',
        enabled: true,
        order: 100
      },
      ctx.characterId
    )
    await refresh()
  }

  async function refresh(): Promise<void> {
    const all = await window.tavern.regexAll(ctx.characterId)
    const rules = scope === 'character' ? all.character : all.global
    list.replaceChildren()
    if (rules.length === 0) list.append(h('div', 'hintline', '还没有规则。'))
    for (const rule of rules) {
      list.append(
        ruleEditor(
          rule,
          (input) => window.tavern.regexSave(input, ctx.characterId).then(() => undefined),
          () => window.tavern.regexDelete(rule.id),
          editorCtx(ctx),
          sample
        )
      )
    }
    if (!ctx.characterId) {
      cardList.replaceChildren()
      return
    }
    await renderCardRegexList(cardList, ctx.characterId, editorCtx(ctx), sample)
  }

  await refresh()
}

// ── 预设 ──────────────────────────────────────────────────────────────

async function renderPreset(ctx: Ctx): Promise<void> {
  const { body, say } = ctx
  const list = h('div', 'panel-list')
  body.append(
    section('预设（Prompt Manager）'),
    h(
      'div',
      'hintline',
      '预设决定提示词的骨架：采样参数 + 条目顺序 + 哪些条目启用。\nST 的预设 JSON 可以直接导入，markers 与勾选状态都保留。'
    ),
    row(
      button('导入预设', 'primary', () => void importOne()),
      h('div', 'hintline', ctx.chatId ? '点「本场用」只改这一场对话，其余会话仍用全局那份。' : '这里选的是全局默认。')
    ),
    list
  )

  async function importOne(): Promise<void> {
    const results = await window.tavern.presetsImport()
    if (results.length === 0) return
    const failed = results.filter((item) => !item.ok)
    if (failed.length > 0) say(`有 ${failed.length} 个没导进来：${failed[0]!.error ?? ''}`, true)
    else say(`导入了 ${results.length} 份。`)
    await refresh()
  }

  async function refresh(): Promise<void> {
    const { items, activeId } = await window.tavern.presetsList()
    list.replaceChildren()
    if (items.length === 0) list.append(h('div', 'hintline', '还没有预设。导入一份 ST 预设试试？'))
    for (const preset of items) list.append(presetRow(preset, activeId))
  }

  function presetRow(preset: PresetSummary, activeId: string | null): HTMLElement {
    const wrap = h('div', 'panel-item')
    const active = preset.id === activeId
    wrap.append(
      row(
        h('div', 'panel-name', preset.name),
        h('div', 'hintline', `${preset.enabledCount}/${preset.promptCount} 条启用`),
        h('div', 'grow'),
        button(active ? '全局：当前' : '设为全局', active ? 'ghost' : '', () => {
          void window.tavern.presetsActiveSet(preset.id).then(() => void refresh())
        }),
        ctx.chatId
          ? button('本场用', 'ghost', () => {
              void window.tavern.chatPresetSet(ctx.chatId!, preset.id).then(() => {
                say('这场对话改用这份预设，下一轮生效。')
                ctx.onChanged?.()
              })
            })
          : h('span'),
        button('编辑', '', () => void edit(preset)),
        button('导出', 'ghost', () => {
          void window.tavern.presetsExport(preset.id, preset.name).then((result) => {
            if (!result.ok) say(result.error ?? '导出失败', true)
          })
        }),
        button('删', 'ghost danger', () => {
          if (!window.confirm(`删除预设「${preset.name}」？`)) return
          void window.tavern.presetsDelete(preset.id).then(() => void refresh())
        })
      )
    )
    return wrap
  }

  async function edit(preset: PresetSummary): Promise<void> {
    const data = await window.tavern.presetsGet(preset.id)
    if (!data) return
    body.replaceChildren(
      row(
        button('← 返回', 'ghost', () => {
          body.replaceChildren()
          body.append(section('预设（Prompt Manager）'), list)
          void refresh()
        }),
        h('div', 'panel-name', data.name)
      )
    )
    const draft: PresetData = {
      ...data,
      sampling: { ...data.sampling },
      prompts: data.prompts.map((item) => ({ ...item })),
      order: data.order.map((item) => ({ ...item }))
    }

    // 采样参数
    body.append(section('采样'))
    const sampling = h('div', 'panel-grid')
    const numbers: [keyof PresetData['sampling'], string][] = [
      ['temperature', 'temperature'],
      ['topP', 'top_p'],
      ['topK', 'top_k'],
      ['maxTokens', 'max_tokens']
    ]
    for (const [key, text] of numbers) {
      const box = document.createElement('input')
      box.type = 'number'
      box.step = key === 'maxTokens' || key === 'topK' ? '1' : '0.05'
      box.value = String(draft.sampling[key])
      box.onchange = (): void => {
        draft.sampling[key] = Number(box.value) || 0
      }
      sampling.append(h('div', 'panel-cell'), label(text), box)
    }
    body.append(sampling)
    body.append(
      h('div', 'hintline', '接口只收 temperature / top_p / max_tokens，top_k 等会存着但不发。')
    )

    // 条目：按 order 排（order 里没提到的接在尾部）
    body.append(section('条目顺序与启用'))
    if (draft.order.length === 0) {
      draft.order = draft.prompts.map((item) => ({ identifier: item.identifier, enabled: item.enabled }))
    }
    const known = new Set(draft.order.map((item) => item.identifier))
    for (const item of draft.prompts) {
      if (!known.has(item.identifier)) draft.order.push({ identifier: item.identifier, enabled: item.enabled })
    }
    const byId = new Map(draft.prompts.map((item) => [item.identifier, item]))
    const rows = h('div', 'panel-list')
    const paintRows = (): void => {
      rows.replaceChildren()
      draft.order.forEach((item, index) => {
        const prompt = byId.get(item.identifier)
        if (!prompt) return
        const tag = prompt.marker ? '◇ 占位点' : prompt.injectionPosition === 1 ? '↓ 深度注入' : '普通条目'
        rows.append(
          row(
            toggle(item.enabled, (next) => {
              item.enabled = next
            }),
            h('div', 'panel-name', prompt.name),
            h('div', 'hintline', tag),
            h('div', 'grow'),
            button('↑', 'ghost', () => {
              if (index === 0) return
              const [moved] = draft.order.splice(index, 1)
              draft.order.splice(index - 1, 0, moved!)
              paintRows()
            }),
            button('↓', 'ghost', () => {
              if (index === draft.order.length - 1) return
              const [moved] = draft.order.splice(index, 1)
              draft.order.splice(index + 1, 0, moved!)
              paintRows()
            })
          )
        )
      })
    }
    paintRows()
    body.append(rows)
    body.append(
      row(
        button('保存预设', 'primary', () => {
          // order 里的勾选状态同步回条目本身（导出 / 装配都看它）
          for (const item of draft.order) {
            const prompt = byId.get(item.identifier)
            if (prompt) prompt.enabled = item.enabled
          }
          void window.tavern
            .presetsSave({ id: preset.id, name: draft.name, data: draft })
            .then(() => {
              say('预设已保存，下一轮生效。')
              ctx.onChanged?.()
            })
        })
      )
    )
  }

  await refresh()
}

// ── 文风 ──────────────────────────────────────────────────────────────

async function renderStyle(ctx: Ctx): Promise<void> {
  const { body, say } = ctx
  const list = h('div', 'panel-list')
  const nameBox = input('', '文风名字')
  const contentBox = area('', 4)

  const paint = async (): Promise<void> => {
    const [styles, settings] = await Promise.all([
      window.tavern.stylesList(),
      window.tavern.promptSettings()
    ])
    list.replaceChildren()
    const pick = (id: string): void => {
      void window.tavern.promptSettingsSet({ styleId: id }).then(() => {
        ctx.onChanged?.()
        void paint()
      })
    }
    list.append(
      row(
        h('div', 'panel-name', '不加文风'),
        h('div', 'grow'),
        button(settings.styleId === '' ? '已选' : '选用', 'ghost', () => pick(''))
      )
    )
    for (const style of styles as Style[]) {
      const picked = settings.styleId === style.id
      list.append(
        row(
          h('div', 'panel-name', style.name),
          h('div', 'hintline', style.content.slice(0, 28) + (style.content.length > 28 ? '…' : '')),
          h('div', 'grow'),
          button(picked ? '已选' : '选用', picked ? 'ghost' : '', () => pick(style.id)),
          style.builtin
            ? h('span')
            : button('删', 'ghost danger', () => {
                void window.tavern.stylesDelete(style.id).then(() => void paint())
              })
        )
      )
    }
  }

  body.append(
    section('文风'),
    h('div', 'hintline', '只影响「怎么写」，不改剧情。选「不加」就是保持模型自己的笔法。'),
    list,
    section('加一个自定义文风'),
    row(nameBox),
    contentBox,
    row(
      button('添加并选用', 'primary', () => {
        if (!contentBox.value.trim()) {
          say('先写点内容。', true)
          return
        }
        void window.tavern
          .stylesAdd({ name: nameBox.value, content: contentBox.value })
          .then((id) => window.tavern.promptSettingsSet({ styleId: id }))
          .then(() => {
            say('已添加并选用。')
            contentBox.value = ''
            nameBox.value = ''
            void paint()
          })
      })
    )
  )
  await paint()
}

// ── 回复设置 ──────────────────────────────────────────────────────────

function numberRow(
  text: string,
  value: number,
  min: number,
  max: number,
  step: number,
  save: (value: number) => void
): HTMLElement {
  const box = document.createElement('input')
  box.type = 'number'
  box.min = String(min)
  box.max = String(max)
  box.step = String(step)
  box.value = String(value)
  box.style.width = '90px'
  box.onchange = (): void => save(Number(box.value) || 0)
  return row(label(text), box)
}

function settingsSaver(ctx: Ctx, prefix = ''): (patch: Partial<Settings>) => void {
  return (patch): void => {
    void window.tavern.promptSettingsSet(patch).then(
      () => {
        if (prefix) ctx.say(`${prefix}已保存。`)
        ctx.onChanged?.()
      },
      (error: unknown) => ctx.say(`没存上：${String(error)}`, true)
    )
  }
}

async function renderReply(ctx: Ctx): Promise<void> {
  const { body } = ctx
  const settings: Settings = await window.tavern.promptSettings()
  const save = settingsSaver(ctx)
  body.append(
    section('御言篇幅'),
    h('div', 'hintline', '0 表示不限制。写得短一点更像聊天，长一点更像小说。'),
    numberRow('最少字数', settings.replyMinChars, 0, 5000, 50, (value) =>
      save({ replyMinChars: value })
    ),
    numberRow('最多字数', settings.replyMaxChars, 0, 20000, 50, (value) =>
      save({ replyMaxChars: value })
    ),
    section('心动接话'),
    numberRow('每轮生成', settings.altCount, 0, 5, 1, (value) => save({ altCount: value })),
    h('div', 'hintline', '生成几句「你可以接的话」摆在输入框上方，点一下填进去。0 = 关。'),
    section('世界书'),
    numberRow('关键词条目预算', settings.loreBudget, 200, 30000, 100, (value) =>
      save({ loreBudget: value })
    ),
    numberRow('扫描最近条数', settings.scanDepth, 1, 40, 1, (value) => save({ scanDepth: value })),
    h(
      'div',
      'hintline',
      '预算只管关键词命中的条目；常驻条目每轮都在、不占预算。\n扫描深度 = 拿最近几条消息去撞关键词。'
    )
  )
}

// ── 状态栏与变量 ──────────────────────────────────────────────────────

async function renderStatus(ctx: Ctx): Promise<void> {
  const { body, say } = ctx
  const settings: Settings = await window.tavern.promptSettings()
  const save = settingsSaver(ctx, '开关')

  body.append(
    section('状态栏'),
    row(
      label('聊天页顶部显示状态'),
      h('div', 'grow'),
      toggle(settings.statusEnabled, (next) => save({ statusEnabled: next }))
    ),
    h(
      'div',
      'hintline',
      '纯文本摘要，只给「只有变量、没有状态页」的卡兜底。\n' +
        '卡里自带 html 状态页（正则把占位符换成整页）时不显示——那份会画在回复下方。'
    ),
    row(
      label('状态写进提示词'),
      h('div', 'grow'),
      toggle(settings.statusInPrompt, (next) => save({ statusInPrompt: next }))
    ),
    h('div', 'hintline', '把当前变量（时间 / 修为 / 好感度…）每轮附在提示词末尾，提醒模型别忘设定。'),
    section('变量系统（MVU）'),
    row(
      label('解析卡里的 <update> 更新块'),
      h('div', 'grow'),
      toggle(settings.mvuEnabled, (next) => save({ mvuEnabled: next }))
    ),
    h(
      'div',
      'hintline',
      '卡在回复末尾写 <update><json_patch>…</json_patch></update>，打开后解析成状态；\n' +
        '这些标签永远从正文里洗掉（不管开关），只有打开时才会真的记下状态。默认开——\n' +
        '关掉的话，卡自带的状态页会一直停在开场那一份数值。'
    ),
    (() => {
      if (!ctx.chatId) return h('div', 'hintline', '从聊天页打开时能看这场对话的当前状态。')
      return h('div', '', '')
    })()
  )
  const holder = body.lastElementChild as HTMLElement
  if (!ctx.chatId) return

  const paint = async (): Promise<void> => {
    const { state, lines } = await window.tavern.statusGet(ctx.chatId!)
    holder.replaceChildren()
    holder.append(section('这场对话的当前状态'))
    holder.append(h('div', 'dossier-view', lines.length > 0 ? lines.join('\n') : '（还是空的）'))
    holder.append(
      row(
        h('div', 'hintline', `${Object.keys(state).length} 个变量`),
        h('div', 'grow'),
        button('清空状态', 'ghost danger', () => {
          if (!window.confirm('清空这场对话的全部变量？')) return
          void window.tavern.variablesClear(ctx.chatId!).then(() => {
            say('已清空。')
            void paint()
          })
        })
      )
    )
  }
  await paint()
}

// ── 注入调试 ──────────────────────────────────────────────────────────

/** 上一轮到底给模型喂了什么。调提示词时这是唯一能解释「为什么她那样答」的入口。 */
export async function openDebugPanel(root: HTMLElement, chatId: string): Promise<void> {
  const overlay = h('div', 'modal-mask')
  const box = h('div', 'modal prompt-modal')
  const head = h('div', 'modal-head')
  const close = h('button', 'modal-close', '✕')
  close.onclick = (): void => overlay.remove()
  overlay.onclick = (event): void => {
    if (event.target === overlay) overlay.remove()
  }
  head.append(h('div', 'modal-title', '这一轮注入了什么'), h('div', 'grow'), close)
  const body = h('div', 'modal-body', '')
  box.append(head, body)
  overlay.append(box)
  root.append(overlay)

  const debug = await window.tavern.debugGet(chatId)
  if (!debug) {
    body.append(h('div', 'hintline', '还没有发过消息。'))
    return
  }
  body.append(
    h(
      'div',
      'hintline',
      `预设：${debug.presetName ?? '（无）'}　历史 ${debug.historyCount} 条 / 约 ${debug.historyTokens} token\n` +
        `合计约 ${debug.totalTokens} token`
    ),
    section('分段'),
    (() => {
      const list = h('div', 'panel-list')
      for (const piece of debug.pieces) {
        list.append(
          row(
            h('div', 'panel-name', piece.label),
            h('div', 'hintline', piece.source),
            h('div', 'grow'),
            h('div', 'hintline', `${piece.tokens} token`)
          )
        )
      }
      return list
    })(),
    section('命中的世界书条目'),
    (() => {
      const list = h('div', 'panel-list')
      if (debug.loreActive.length === 0) list.append(h('div', 'hintline', '这条没命中任何条目。'))
      for (const entry of debug.loreActive) {
        list.append(
          row(
            h('div', 'panel-name', entry.name),
            h('div', 'hintline', `${entry.source} · ${entry.position}`),
            h('div', 'grow'),
            h('div', 'hintline', `${entry.tokens} token`)
          )
        )
      }
      return list
    })(),
    section('被预算挤掉的条目'),
    (() => {
      const list = h('div', 'panel-list')
      if (debug.loreDropped.length === 0) list.append(h('div', 'hintline', '没有。'))
      for (const entry of debug.loreDropped) {
        list.append(
          row(h('div', 'panel-name', entry.name), h('div', 'hintline', entry.source))
        )
      }
      return list
    })()
  )
}
