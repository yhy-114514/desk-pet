// 新建群聊：从角色库里挑 2~5 个角色，起个名字（不填就按成员名拼）。
// 和开场白选择共用遮罩 / 列表样式，不另造一套弹窗。
import { cover, h, type CardSummary } from './ui'
import { GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS } from '../../../shared/groupChat'

export interface GroupChoice {
  memberIds: string[]
  name: string
}

/** null = 取消 */
export function pickGroupMembers(root: HTMLElement): Promise<GroupChoice | null> {
  return new Promise((resolve) => {
    const picked: string[] = []

    const overlay = h('div', 'modal-mask')
    const box = h('div', 'modal prompt-modal')
    const head = h('div', 'modal-head')
    const close = h('button', 'modal-close', '✕')
    head.append(h('div', 'modal-title', '新建群聊'), h('div', 'grow'), close)
    const body = h('div', 'modal-body')
    const list = h('div', 'pick-list')

    const hint = h('div', 'hintline', '挑 2~5 个角色。@谁，谁就一定会接话。')
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.className = 'search'
    nameInput.placeholder = '群名（不填就按成员名字拼）'
    nameInput.maxLength = 40
    const nameRow = h('div', 'panel-row')
    nameRow.append(nameInput)

    const count = h('span', '', '')
    const create = h('button', 'btn primary', '建群')
    const cancel = h('button', 'btn ghost', '取消')
    const foot = h('div', 'panel-row')
    foot.append(count, h('div', 'grow'), create, cancel)

    let done = false
    const finish = (choice: GroupChoice | null): void => {
      if (done) return
      done = true
      overlay.remove()
      resolve(choice)
    }

    const paint = (): void => {
      count.textContent = `已选 ${picked.length} / ${GROUP_MAX_MEMBERS}`
      create.disabled = picked.length < GROUP_MIN_MEMBERS
      for (const node of Array.from(list.children)) {
        node.setAttribute('data-picked', String(picked.includes((node as HTMLElement).dataset['id'] ?? '')))
      }
    }

    const toggle = (card: CardSummary): void => {
      const index = picked.indexOf(card.id)
      if (index >= 0) {
        picked.splice(index, 1)
      } else {
        if (picked.length >= GROUP_MAX_MEMBERS) {
          hint.textContent = `最多 ${GROUP_MAX_MEMBERS} 个——人再多了她根本插不上话。`
          hint.classList.add('bad')
          return
        }
        picked.push(card.id)
        hint.textContent = '挑 2~5 个角色。@谁，谁就一定会接话。'
        hint.classList.remove('bad')
      }
      paint()
    }

    const row = (card: CardSummary): HTMLElement => {
      const item = h('button', 'pick-item group-pick')
      item.dataset['id'] = card.id
      item.append(
        cover('pick-avatar', card.avatarPath, card.name),
        (() => {
          const text = h('div', 'pick-text')
          text.append(h('div', 'pick-name', card.name))
          if (card.tagline) text.append(h('div', 'pick-sub', card.tagline))
          return text
        })(),
        h('span', 'pick-check', '✓')
      )
      item.onclick = (): void => toggle(card)
      return item
    }

    create.onclick = (): void => {
      const name = nameInput.value.trim()
      finish({ memberIds: [...picked], name })
    }
    cancel.onclick = (): void => finish(null)
    close.onclick = (): void => finish(null)
    overlay.onclick = (event): void => {
      if (event.target === overlay) finish(null)
    }

    body.append(hint, list, nameRow, foot)
    box.append(head, body)
    overlay.append(box)
    root.append(overlay)
    paint()

    void window.tavern
      .cardsList({ limit: 200 })
      .then(({ items }) => {
        if (done) return
        if (items.length < GROUP_MIN_MEMBERS) {
          list.append(h('div', 'empty', '角色库里还不够两个角色，先导入几张卡吧。'))
          return
        }
        for (const card of items) list.append(row(card))
        paint()
      })
      .catch((error: unknown) => {
        if (!done) hint.textContent = `读不到角色库：${String(error)}`
      })
  })
}
