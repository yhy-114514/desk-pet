// 卡内嵌世界书 / 正则的编辑控件（共用）。
//
// 两处用到它：聊天页的提示词面板（promptPanel）和角色卡编辑页（cardEditor）。
// 这里的每个改动都是「直接写回这张卡」——`cardLoreEntrySave` / `cardRegexSave` 走的是
// 主进程 `updateCardData`，导出卡时一并带走。
import { h } from './ui'

type TavernApi = Window['tavern']
type LoreEntry = Awaited<ReturnType<TavernApi['lorebookEntries']>>[number]
type RegexRule = Awaited<ReturnType<TavernApi['regexList']>>[number]

/** 编辑器里能改的字段（id 有 = 改旧的，没有 = 新建） */
export type LoreDraft = {
  id?: string
  name: string
  keys: string[]
  secondaryKeys: string[]
  content: string
  constant: boolean
  selective: boolean
  position: LoreEntry['position']
  depth: number
  order: number
  caseSensitive: boolean
}

export type RegexDraft = {
  id?: string
  name: string
  pattern: string
  flags: string
  replacement: string
  target: RegexRule['target']
  enabled: boolean
  order: number
}

export interface EditorCtx {
  say: (text: string, bad?: boolean) => void
  onChanged?: () => void
  /** 「另存为独立世界书」之后刷新独立世界书列表（只有提示词面板需要） */
  refreshBooks?: () => void | Promise<void>
}

// ── 基础控件（提示词面板也用，一并导出）────────────────────────────────

export function row(...nodes: HTMLElement[]): HTMLElement {
  const line = h('div', 'panel-row')
  line.append(...nodes)
  return line
}

export function button(label: string, className: string, action: () => void): HTMLButtonElement {
  const node = h('button', `btn ${className}`.trim(), label)
  node.onclick = action
  return node
}

export function section(text: string): HTMLElement {
  return h('div', 'section-title', text)
}

export function input(value: string, placeholder = ''): HTMLInputElement {
  const node = document.createElement('input')
  node.type = 'text'
  node.value = value
  node.placeholder = placeholder
  return node
}

export function area(value: string, rows = 3): HTMLTextAreaElement {
  const node = document.createElement('textarea')
  node.value = value
  node.rows = rows
  return node
}

export function toggle(value: boolean, onChange: (next: boolean) => void): HTMLButtonElement {
  const node = h('button', `switch${value ? ' on' : ''}`, value ? '开' : '关')
  node.onclick = (): void => {
    const next = node.textContent !== '开'
    node.textContent = next ? '开' : '关'
    node.classList.toggle('on', next)
    onChange(next)
  }
  return node
}

export function label(text: string): HTMLElement {
  return h('div', 'set-label', text)
}

/** 条目一多（多角色卡 153 条）就得折叠，否则编辑页是一堵墙 */
export function collapsible(title: string, hint: string, body: HTMLElement): HTMLElement {
  const details = document.createElement('details')
  details.className = 'panel-item'
  const summary = document.createElement('summary')
  summary.style.cursor = 'pointer'
  summary.append(h('span', 'panel-name', title), h('span', 'hintline', `　${hint}`))
  details.append(summary, body)
  return details
}

// ── 世界书 / 正则条目编辑器 ───────────────────────────────────────────

const POSITIONS: { key: LoreEntry['position']; label: string }[] = [
  { key: 'before_char', label: '角色设定前' },
  { key: 'after_char', label: '角色设定后' },
  { key: 'depth', label: '按深度注入' }
]

export function entryEditor(
  entry: LoreEntry,
  saveTo: (input: LoreDraft) => Promise<unknown>,
  remove: () => Promise<unknown>,
  ctx: EditorCtx
): HTMLElement {
  const wrap = h('div', 'panel-item')
  const name = input(entry.name, '条目名')
  const keys = input(entry.keys.join(', '), '触发词，逗号分隔')
  const secondary = input(entry.secondaryKeys.join(', '), '二级触发词（选择性条目才用）')
  const content = area(entry.content, 5)
  const position = document.createElement('select')
  for (const option of POSITIONS) {
    const node = document.createElement('option')
    node.value = option.key
    node.textContent = option.label
    if (option.key === entry.position) node.selected = true
    position.append(node)
  }
  const depth = document.createElement('input')
  depth.type = 'number'
  depth.value = String(entry.depth)
  depth.min = '1'
  depth.style.width = '70px'
  const order = document.createElement('input')
  order.type = 'number'
  order.value = String(entry.order)
  order.style.width = '70px'
  let constant = entry.constant
  let selective = entry.selective
  let caseSensitive = entry.caseSensitive

  const save = (): void => {
    const split = (text: string): string[] =>
      text
        .split(/[,，、]/)
        .map((item) => item.trim())
        .filter(Boolean)
    void saveTo({
      id: entry.id,
      name: name.value,
      keys: split(keys.value),
      secondaryKeys: split(secondary.value),
      content: content.value,
      constant,
      selective,
      position: position.value as LoreEntry['position'],
      depth: Number(depth.value) || 4,
      // `|| 100` 会把合法的 0 改成 100（读取侧是保留 0 的），
      // 用户只改别的字段也会把这条悄悄挪到后面
      order: order.value.trim() === '' ? 100 : Number(order.value) || 0,
      caseSensitive
    }).then(
      () => {
        ctx.say('条目已保存。')
        ctx.onChanged?.()
      },
      (error: unknown) => ctx.say(`没存上：${String(error)}`, true)
    )
  }

  // 开关跟其它控件一样，点一下立刻落库（只改本地变量的话，看到「关」但库里还开着）
  const flags = h('div', 'panel-row')
  flags.append(
    label('常驻'),
    toggle(constant, (next) => {
      constant = next
      save()
    }),
    label('二级命中'),
    toggle(selective, (next) => {
      selective = next
      save()
    }),
    label('区分大小写'),
    toggle(caseSensitive, (next) => {
      caseSensitive = next
      save()
    })
  )
  const hint = h('div', 'hintline', '触发词为空且不是常驻 → 永远不注入。')
  content.onchange = save
  name.onchange = save
  keys.onchange = save
  secondary.onchange = save
  position.onchange = save
  depth.onchange = save
  order.onchange = save
  wrap.append(
    row(name, position, depth, order),
    row(keys, secondary),
    content,
    flags,
    hint,
    row(
      button('保存', 'primary', save),
      button('删除', 'ghost danger', () => {
        if (!window.confirm('删掉这条？')) return
        void remove().then(() => {
          const holder = wrap.closest('details')
          if (holder) holder.remove()
          else wrap.remove()
          ctx.onChanged?.()
        })
      })
    )
  )
  return wrap
}

export function ruleEditor(
  rule: RegexRule,
  saveTo: (input: RegexDraft) => Promise<unknown>,
  remove: () => Promise<unknown>,
  ctx: EditorCtx,
  sample?: HTMLTextAreaElement
): HTMLElement {
  const wrap = h('div', 'panel-item')
  const name = input(rule.name, '规则名')
  const pattern = input(rule.pattern, '正则（不含两侧斜杠）')
  const flags = input(rule.flags, 'g')
  flags.style.width = '70px'
  const replacement = input(rule.replacement, '替换成（可空）')
  const target = document.createElement('select')
  for (const item of [
    ['both', '两边'],
    ['display', '只显示'],
    ['prompt', '只提示词']
  ]) {
    const option = document.createElement('option')
    option.value = item[0]!
    option.textContent = item[1]!
    if (item[0] === rule.target) option.selected = true
    target.append(option)
  }
  let enabled = rule.enabled
  const hits = h('div', 'hintline', '')

  const save = (): void => {
    void saveTo({
      id: rule.id,
      name: name.value,
      pattern: pattern.value,
      flags: flags.value || 'g',
      replacement: replacement.value,
      target: target.value as RegexRule['target'],
      enabled,
      order: rule.order
    }).then(
      () => {
        ctx.say('规则已保存。')
        ctx.onChanged?.()
      },
      (error: unknown) => ctx.say(`没存上：${String(error)}`, true)
    )
  }
  // 没有样例文本（角色卡编辑页）时不给「试一下」，避免点出空结果
  const test = (): void => {
    if (!sample) return
    void window.tavern
      .regexTest({ ...rule, pattern: pattern.value, flags: flags.value || 'g', replacement: replacement.value }, sample.value)
      .then((out) => {
        hits.textContent = out.ok ? `命中 ${out.hits} 处` : `⚠ ${out.error}`
        hits.classList.toggle('bad', !out.ok)
      })
  }
  for (const node of [name, pattern, flags, replacement]) node.onchange = save
  target.onchange = save
  const replaceRow = h('div', 'panel-row')
  replaceRow.append(replacement)
  if (sample) replaceRow.append(button('试一下', '', test))
  wrap.append(
    row(
      name,
      toggle(enabled, (next) => {
        enabled = next
        save()
      }),
      target
    ),
    row(pattern, flags),
    replaceRow,
    hits,
    row(
      button('保存', 'primary', save),
      button('删除', 'ghost danger', () => {
        if (!window.confirm('删掉这条规则？')) return
        void remove().then(() => {
          const holder = wrap.closest('details')
          if (holder) holder.remove()
          else wrap.remove()
          ctx.onChanged?.()
        })
      })
    )
  )
  return wrap
}

// ── 卡内嵌列表（写回卡本身）─────────────────────────────────────────

/** 画「卡内嵌世界书」列表到 container。改这里就是改这张卡。 */
export async function renderCardLoreList(
  container: HTMLElement,
  characterId: string,
  ctx: EditorCtx
): Promise<void> {
  const { lore } = await window.tavern.cardLore(characterId)
  container.replaceChildren()
  container.append(
    row(
      h('div', 'hintline', `卡里有 ${lore.length} 条，随卡导入、随卡导出；改动直接写回卡里。`),
      h('div', 'grow'),
      button('加一条', '', () => void addEntry()),
      button('另存为独立世界书', 'ghost', () => void saveAs())
    )
  )
  if (lore.length === 0) container.append(h('div', 'hintline', '这张卡没写世界书。'))
  for (const entry of lore) {
    container.append(
      collapsible(
        entry.name,
        entry.keys.length > 0 ? `触发：${entry.keys.join('、')}` : '常驻',
        entryEditor(
          entry,
          (draft) => window.tavern.cardLoreEntrySave(characterId, draft),
          () => window.tavern.cardLoreEntryDelete(characterId, entry.id),
          ctx
        )
      )
    )
  }

  async function addEntry(): Promise<void> {
    await window.tavern.cardLoreEntrySave(characterId, {
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
    await renderCardLoreList(container, characterId, ctx)
  }

  async function saveAs(): Promise<void> {
    const name = window.prompt('另存为世界书，起个名字：', '卡内世界书')
    if (!name?.trim()) return
    await window.tavern.cardLoreSaveAs({
      characterId,
      name: name.trim(),
      scope: 'character'
    })
    ctx.say('已另存为这个角色的世界书。')
    await ctx.refreshBooks?.()
  }
}

/** 画「卡内嵌正则」列表到 container。 */
export async function renderCardRegexList(
  container: HTMLElement,
  characterId: string,
  ctx: EditorCtx,
  sample?: HTMLTextAreaElement
): Promise<void> {
  const all = await window.tavern.regexAll(characterId)
  container.replaceChildren()
  container.append(
    row(
      h('div', 'hintline', '卡里的正则是显示侧的主力（状态栏 / 论坛都是它换出来的），改动直接写回卡里。'),
      h('div', 'grow'),
      button('加一条', '', () => void addRule())
    )
  )
  if (all.card.length === 0) {
    container.append(h('div', 'hintline', '这张卡没写正则。'))
  }
  for (const rule of all.card) {
    container.append(
      collapsible(
        rule.name,
        `/${rule.pattern}/${rule.flags}`,
        ruleEditor(
          rule,
          (draft) => window.tavern.cardRegexSave(characterId, { ...rule, ...draft, id: draft.id ?? rule.id }),
          () => window.tavern.cardRegexDelete(characterId, rule.id),
          ctx,
          sample
        )
      )
    )
  }

  async function addRule(): Promise<void> {
    await window.tavern.cardRegexSave(characterId, {
      id: '',
      name: '新规则',
      pattern: '',
      flags: 'g',
      replacement: '',
      target: 'display',
      enabled: true,
      order: 100,
      source: 'card',
      readonly: false
    })
    await renderCardRegexList(container, characterId, ctx, sample)
  }
}
