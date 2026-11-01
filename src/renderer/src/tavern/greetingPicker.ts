// 开场白选择：第一次进一张卡时先让人挑一条（ST 也是这样），
// 不然卡里写了 9 条备选开场白，用户永远只看得到随机抽中的那一条。
import { splitRich } from '../../../shared/richText'
import { h } from './ui'

/** null = 取消了（回角色库）；{ index: null } = 不要开场白，直接开始 */
export type GreetingChoice = { index: number | null } | null

/** 预览只留正文：状态栏那几万字代码不该塞进选择框 */
function preview(text: string): string {
  return splitRich(text)
    .filter((segment) => segment.kind === 'text')
    .map((segment) => segment.text)
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 当前挂着的选择框：离开聊天页时要主动关掉，否则它会盖在新页面上 */
let activeOverlay: HTMLElement | null = null
let activeCancel: (() => void) | null = null

/** 外部关闭（切换角色 / 重画页面时调用）：移除遮罩并让 Promise 以「取消」收尾 */
export function closeGreetingPicker(): void {
  const cancel = activeCancel
  activeOverlay?.remove()
  activeOverlay = null
  activeCancel = null
  cancel?.()
}

export function pickGreeting(
  root: HTMLElement,
  options: string[],
  title = '选一个开场白'
): Promise<GreetingChoice> {
  return new Promise((resolve) => {
    const overlay = h('div', 'modal-mask')
    const box = h('div', 'modal prompt-modal')
    const head = h('div', 'modal-head')
    const close = h('button', 'modal-close', '✕')
    head.append(h('div', 'modal-title', title), h('div', 'grow'), close)
    const body = h('div', 'modal-body')
    const list = h('div', 'pick-list')

    let done = false
    const finish = (choice: GreetingChoice): void => {
      if (done) return
      done = true
      if (activeOverlay === overlay) {
        activeOverlay = null
        activeCancel = null
      }
      overlay.remove()
      resolve(choice)
    }
    activeOverlay = overlay
    activeCancel = (): void => finish(null)
    close.onclick = (): void => finish(null)
    overlay.onclick = (event): void => {
      if (event.target === overlay) finish(null)
    }

    options.forEach((text, index) => {
      const item = h('button', 'pick-item')
      item.append(
        h('span', 'pick-title', index === 0 ? '主开场白' : `备选 ${index}`),
        document.createTextNode(
          preview(text).slice(0, 600) || '（这条开场白是整页画面，选定后才会渲染出来）'
        )
      )
      item.onclick = (): void => finish({ index })
      list.append(item)
    })

    const foot = h('div', 'panel-row')
    const empty = h('button', 'btn ghost', '不用开场白，直接开始')
    empty.onclick = (): void => finish({ index: null })
    const back = h('button', 'btn ghost', '返回角色库')
    back.onclick = (): void => finish(null)
    foot.append(h('div', 'grow'), empty, back)

    body.append(
      h('div', 'hintline', '开场白是这场对话的第一条消息，选定后才会真正开场。'),
      list,
      foot
    )
    box.append(head, body)
    overlay.append(box)
    root.append(overlay)
  })
}
