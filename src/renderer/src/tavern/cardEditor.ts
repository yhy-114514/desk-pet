// 角色卡编辑页（中栏）：新建 / 修改一张卡。
// 字段顺序照 ST v2 的习惯排，写得多的（描述、开场白、示例）放中间，元信息放最后。
import { openCardAssistant } from './cardAssistant'
import { renderCardLoreList, renderCardRegexList } from './loreRegexEditors'
import { avatarUrl, h, type CardInput } from './ui'

export interface EditorHandlers {
  onBack: () => void
  onSaved: (id: string) => void
  onDeleted: () => void
  onChanged: () => void | Promise<void>
}

function blankCard(): CardInput {
  return {
    name: '',
    description: '',
    personality: '',
    scenario: '',
    firstMes: '',
    alternateGreetings: [],
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creator: '',
    creatorNotes: '',
    tags: [],
    avatarPath: null
  }
}

// 连点两张卡（或双击同一张）时，先发出的 cardsGet 可能后回来：两次调用都在
// replaceChildren 之后才 append，先回来的那张会被后回来的那张叠在上面，中栏出两个 .page。
// 用代次号让早先那次直接放弃——后点的卡赢，与 resolve 先后无关。
let editorSeq = 0

export async function renderCardEditor(
  mount: HTMLElement,
  id: string | null,
  handlers: EditorHandlers
): Promise<void> {
  const seq = ++editorSeq
  mount.replaceChildren()
  const existing = id ? await window.tavern.cardsGet(id) : null
  if (seq !== editorSeq) return
  if (id && !existing) {
    mount.append(h('div', 'empty', '这张角色卡不在了。'))
    return
  }

  const draft: CardInput = existing ? { ...existing } : blankCard()
  let greetings = [...draft.alternateGreetings]

  const page = h('div', 'page')
  const toolbar = h('div', 'toolbar')
  const backBtn = h('button', 'btn ghost', '← 返回')
  backBtn.onclick = (): void => handlers.onBack()
  const title = h('div', 'grow')
  title.style.cssText = 'font-size:13px;letter-spacing:.12em;color:#cfe6ff'
  title.textContent = existing ? '编辑角色' : '新建角色'
  toolbar.append(backBtn, title)
  // 问问鲸鱼娘（T7）：审卡 / 帮写 / 建议。新卡还没入库，没有材料可读
  if (existing) {
    const ask = h('button', 'btn ghost', '问问鲸鱼娘')
    ask.title = '审卡 / 帮写 / 体检（体检出的问题可以让她直接改进卡里）'
    ask.onclick = (): void =>
      openCardAssistant({
        root: document.getElementById('tavern') ?? document.body,
        characterId: existing.id,
        name: existing.name,
        // 修复写回的是卡里的原始数据，表单里还是改之前的值：整页重载一次，
        // 否则用户接着点「保存」会用陈旧草稿把修复覆盖回去
        onChanged: (): void => {
          void handlers.onChanged()
          void renderCardEditor(mount, existing.id, handlers)
        }
      })
    toolbar.append(ask)
  }

  const editor = h('div', 'editor')

  // ── 立绘 ──
  const avatarRow = h('div', 'avatar-row')
  const preview = h('div', 'avatar-preview')
  const paintPreview = (): void => {
    preview.replaceChildren()
    if (draft.avatarPath) {
      const image = h('img')
      image.src = avatarUrl(draft.avatarPath)
      image.draggable = false
      preview.append(image)
    } else {
      preview.textContent = '无图'
    }
  }
  const pickAvatar = h('button', 'btn', '选择立绘')
  pickAvatar.onclick = async (): Promise<void> => {
    try {
      const picked = await window.tavern.avatarPick()
      if (!picked) return
      draft.avatarPath = picked.path
      paintPreview()
    } catch (error) {
      window.alert((error as Error).message)
    }
  }
  const dropAvatar = h('button', 'btn ghost danger', '移除')
  dropAvatar.onclick = (): void => {
    draft.avatarPath = null
    paintPreview()
  }
  const avatarOps = h('div', 'field')
  avatarOps.append(
    h('label', '', '立绘'),
    pickAvatar,
    dropAvatar,
    h('div', 'hintline', 'PNG，存进 userData/tavern/avatars/')
  )
  avatarRow.append(preview, avatarOps)
  paintPreview()

  // ── 基本 ──
  const nameInput = h('input')
  nameInput.type = 'text'
  nameInput.value = draft.name
  nameInput.placeholder = '她的名字'
  nameInput.addEventListener('input', () => (draft.name = nameInput.value))

  const tagsInput = h('input')
  tagsInput.type = 'text'
  tagsInput.value = draft.tags.join(', ')
  tagsInput.placeholder = '奇幻, 温柔, 海盗（用逗号分隔）'
  tagsInput.addEventListener('input', () => {
    draft.tags = tagsInput.value
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
  })

  const nameField = h('div', 'field')
  nameField.append(h('label', '', '名字'), nameInput)
  const tagsField = h('div', 'field')
  tagsField.append(h('label', '', '标签'), tagsInput)

  const half = h('div', 'half')
  half.append(nameField, tagsField)

  // ── 角色设定 ──
  const description = area(draft.description, (value) => (draft.description = value), 5)
  const personality = area(draft.personality, (value) => (draft.personality = value), 3)
  const scenario = area(draft.scenario, (value) => (draft.scenario = value), 3)

  // ── 开场白 ──
  const firstMes = area(draft.firstMes, (value) => (draft.firstMes = value), 4)
  const greetList = h('div')
  const paintGreetings = (): void => {
    greetList.replaceChildren()
    greetings.forEach((text, index) => {
      const row = h('div', 'greet')
      const box = document.createElement('textarea')
      box.value = text
      box.placeholder = '一条备选开场白'
      box.addEventListener('input', () => (greetings[index] = box.value))

      const order = h('div', 'order')
      const up = h('button', '', '▲')
      up.title = '上移'
      up.disabled = index === 0
      up.onclick = (): void => {
        ;[greetings[index - 1], greetings[index]] = [greetings[index]!, greetings[index - 1]!]
        paintGreetings()
      }
      const down = h('button', '', '▼')
      down.title = '下移'
      down.disabled = index === greetings.length - 1
      down.onclick = (): void => {
        ;[greetings[index + 1], greetings[index]] = [greetings[index]!, greetings[index + 1]!]
        paintGreetings()
      }
      const remove = h('button', '', '×')
      remove.title = '删掉这条'
      remove.onclick = (): void => {
        greetings.splice(index, 1)
        paintGreetings()
      }
      order.append(up, down, remove)
      row.append(order, box)
      greetList.append(row)
    })
    const add = h('button', 'btn ghost', '＋ 加一条备选开场白')
    add.onclick = (): void => {
      greetings.push('')
      paintGreetings()
    }
    greetList.append(add)
  }
  paintGreetings()

  const greetingHint = h('div', 'hintline', '进聊天时从主开场白和这些备选里随机挑一条。')

  // ── 示例 / 提示词 / 元信息 ──
  const mesExample = area(draft.mesExample, (value) => (draft.mesExample = value), 5)
  const systemPrompt = area(draft.systemPrompt, (value) => (draft.systemPrompt = value), 4)
  const postHistory = area(
    draft.postHistoryInstructions,
    (value) => (draft.postHistoryInstructions = value),
    3
  )
  const creatorInput = h('input')
  creatorInput.type = 'text'
  creatorInput.value = draft.creator
  creatorInput.addEventListener('input', () => (draft.creator = creatorInput.value))
  const creatorNotes = area(draft.creatorNotes, (value) => (draft.creatorNotes = value), 3)

  const creatorField = h('div', 'field')
  creatorField.append(h('label', '', '创作者'), creatorInput)

  // ── 卡内嵌世界书 / 正则 ──
  // 这两样只活在 data_json 里，新卡还没有 id 就写不进去，所以先存一次再编辑。
  const cardNotice = h('div', 'hintline', '')
  const loreHolder = h('div', '')
  const regexHolder = h('div', '')

  editor.append(
    avatarRow,
    half,
    h('div', 'section-title', '角色设定'),
    block('角色描述', description, '她是怎样的人、长什么样、经历过什么。'),
    block('性格', personality, ''),
    block('场景', scenario, '对话开始时的情境。'),
    h('div', 'section-title', '开场白'),
    block('主开场白', firstMes, ''),
    labelled('备选开场白', greetList, greetingHint),
    h('div', 'section-title', '示例与提示词'),
    block('对话示例', mesExample, '{{user}}: …\n{{char}}: …'),
    block('系统提示词', systemPrompt, '留空则用默认模板（T2 接入）。'),
    block('历史后指令', postHistory, ''),
    h('div', 'section-title', '其他'),
    creatorField,
    block('创作者备注', creatorNotes, ''),
    h('div', 'section-title', '卡内嵌世界书'),
    loreHolder,
    h('div', 'section-title', '卡内嵌正则'),
    regexHolder,
    cardNotice
  )
  if (existing) {
    const cardCtx = {
      say: (text: string, bad = false): void => {
        cardNotice.textContent = text
        cardNotice.classList.toggle('bad', bad)
      },
      onChanged: (): void => void handlers.onChanged()
    }
    void renderCardLoreList(loreHolder, existing.id, cardCtx)
    void renderCardRegexList(regexHolder, existing.id, cardCtx)
  } else {
    loreHolder.append(
      h('div', 'hintline', '新建的角色先「保存」一次，就能在这里加世界书了。')
    )
    regexHolder.append(
      h('div', 'hintline', '新建的角色先「保存」一次，就能在这里加正则了。')
    )
  }

  // ── 底部操作栏 ──
  const foot = h('div', 'foot')
  const msg = h('div', 'msg')
  const deleteBtn = h('button', 'btn danger', '删除')
  const saveBtn = h('button', 'btn primary', '保存')
  foot.append(msg)
  if (existing) foot.append(deleteBtn)
  foot.append(saveBtn)

  const say = (text: string, bad = false): void => {
    msg.textContent = text
    msg.classList.toggle('bad', bad)
  }

  saveBtn.onclick = async (): Promise<void> => {
    if (!draft.name.trim()) {
      say('名字不能空着。', true)
      nameInput.focus()
      return
    }
    draft.alternateGreetings = greetings.map((line) => line.trim()).filter(Boolean)
    saveBtn.disabled = true
    try {
      const savedId = await window.tavern.cardsSave(existing ? { ...draft, id: existing.id } : draft)
      await handlers.onChanged()
      if (existing) {
        handlers.onSaved(savedId)
        return
      }
      // 新建卡：保存后就地转成「编辑角色」，世界书 / 正则立刻可编辑，
      // 不用回角色库再点进来一次（新卡没 id 时这两块是写不进去的）
      await renderCardEditor(mount, savedId, handlers)
    } catch (error) {
      say(`保存失败：${(error as Error).message}`, true)
    } finally {
      saveBtn.disabled = false
    }
  }

  deleteBtn.onclick = async (): Promise<void> => {
    if (!existing) return
    if (!window.confirm(`删除「${existing.name}」？\n会放进回收站，之后还能捡回来。`)) return
    await window.tavern.cardsDelete(existing.id)
    await handlers.onChanged()
    handlers.onDeleted()
  }

  page.append(toolbar, editor, foot)
  mount.append(page)
}

function area(value: string, onInput: (value: string) => void, rows: number): HTMLTextAreaElement {
  const box = document.createElement('textarea')
  box.value = value
  box.rows = rows
  box.addEventListener('input', () => onInput(box.value))
  return box
}

function block(label: string, control: HTMLElement, hint: string): HTMLElement {
  return labelled(label, control, hint ? hintLine(hint) : null)
}

function labelled(label: string, control: HTMLElement, hint: HTMLElement | null): HTMLElement {
  const field = h('div', 'field')
  field.append(h('label', '', label), control)
  if (hint) field.append(hint)
  return field
}

function hintLine(text: string): HTMLElement {
  return h('div', 'hintline', text)
}
