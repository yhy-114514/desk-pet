// 首次启动引导（T9）：空库 + 没走过引导时，先带用户导入第一张角色卡。
// 只是一层遮罩，不新建窗口；跳过 / 导入成功都会写一次性记号，不再打扰。
import { h } from './ui'

let openOverlay: HTMLElement | null = null

export interface GuideOptions {
  root: HTMLElement
  /** 导入成功后刷新左栏角色列表 */
  onImported: () => Promise<void> | void
}

export async function maybeShowGuide(options: GuideOptions): Promise<void> {
  const state = await window.tavern.onboardingGet().catch(() => null)
  // 已经有卡 / 已经走过引导：都不弹
  if (!state || state.firstRunDone || state.cardCount > 0) return

  openOverlay?.remove()
  const overlay = h('div', 'modal-mask')
  const box = h('div', 'modal guide-modal')
  const head = h('div', 'modal-head')
  head.append(h('div', 'modal-title', '欢迎来到酒馆'))
  const body = h('div', 'modal-body')
  body.append(
    h(
      'div',
      'guide-text',
      '这里可以和任意角色卡聊天：世界书、预设、状态栏、群聊都在里面。\n先导入一张角色卡（ST 的 PNG / JSON 都认），或者直接跳过自己新建。'
    )
  )
  const hint = h('div', 'set-note', '')
  const actions = h('div', 'set-actions')
  const importBtn = h('button', 'btn primary', '导入我的第一张角色卡…')
  const skipBtn = h('button', 'btn ghost', '跳过')

  const finish = (): void => {
    if (openOverlay === overlay) openOverlay = null
    overlay.remove()
  }

  importBtn.onclick = async (): Promise<void> => {
    importBtn.disabled = true
    hint.textContent = '正在导入…'
    hint.classList.remove('bad')
    try {
      const results = await window.tavern.cardsImport()
      if (results.length === 0) {
        // 用户取消了选择：留在引导里，让他决定导入还是跳过
        hint.textContent = ''
        importBtn.disabled = false
        return
      }
      const ok = results.filter((item) => item.ok).length
      if (ok === 0) {
        hint.textContent = `导入失败：${results.map((item) => item.error).join('；')}`
        hint.classList.add('bad')
        importBtn.disabled = false
        return
      }
      await window.tavern.onboardingSet({ firstRunDone: true })
      await options.onImported()
      finish()
    } catch (error) {
      hint.textContent = `导入失败：${String(error)}`
      hint.classList.add('bad')
      importBtn.disabled = false
    }
  }

  skipBtn.onclick = async (): Promise<void> => {
    await window.tavern.onboardingSet({ firstRunDone: true }).catch(() => {})
    finish()
  }

  actions.append(importBtn, skipBtn)
  body.append(actions, hint)
  box.append(head, body)
  overlay.append(box)
  options.root.append(overlay)
  openOverlay = overlay
}
