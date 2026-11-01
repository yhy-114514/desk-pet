// 记忆三层（T3）的面板：永久记忆 / 忆境典藏 / 回忆视界。
// 三层各有独立开关；改设置立刻生效（下一轮请求就用新值），不用点保存。
// 下半截是她「记得的事」与历史档案的清单，条目可直接改、可删。
import { h } from './ui'

export interface MemoryPanelOptions {
  /** 挂载点（#tavern 根节点），面板以遮罩形式盖在窗口上 */
  root: HTMLElement
  characterId: string
  chatId: string
  /** 档案被改 / 删之后，聊天页顶栏的「忆境」指示可能要跟着变 */
  onChanged?: () => void
}

/** 面板开着时收到摘要事件要重画清单。监听只挂一次，转发给当前开着的那一个。 */
let openPanel: { chatId: string; refresh: () => void } | null = null
let summaryBound = false

export function openMemoryPanel(options: MemoryPanelOptions): void {
  const { root } = options
  const overlay = h('div', 'modal-mask')
  const box = h('div', 'modal')
  const title = h('div', 'modal-title', '记忆')
  const close = h('button', 'modal-close', '✕')
  const dismiss = (): void => {
    if (openPanel?.chatId === options.chatId) openPanel = null
    overlay.remove()
  }
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

  const body = h('div', 'modal-body')
  box.append(head, notice, body)
  overlay.append(box)
  root.append(overlay)

  /** 带数值的滑块行：label + range + 当前值 */
  const slider = (
    label: string,
    min: number,
    max: number,
    value: number,
    unit: string,
    onInput: (value: number) => void
  ): HTMLElement => {
    const row = h('div', 'set-row')
    const name = h('div', 'set-label', label)
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.value = String(value)
    input.className = 'slider'
    const now = h('div', 'set-value', `${value}${unit}`)
    input.oninput = (): void => {
      now.textContent = `${input.value}${unit}`
    }
    input.onchange = (): void => onInput(Number(input.value))
    row.append(name, input, now)
    return row
  }

  const toggle = (label: string, value: boolean, onChange: (value: boolean) => void): HTMLElement => {
    const row = h('div', 'set-row')
    const name = h('div', 'set-label', label)
    const button = h('button', `switch${value ? ' on' : ''}`, value ? '开' : '关')
    button.onclick = (): void => {
      const next = button.textContent !== '开'
      button.textContent = next ? '开' : '关'
      button.classList.toggle('on', next)
      onChange(next)
    }
    row.append(name, h('div', 'grow'), button)
    return row
  }

  const sectionTitle = (text: string): HTMLElement => h('div', 'section-title', text)

  const save = (patch: Record<string, unknown>): void => {
    void window.tavern.memorySettingsSet(patch).catch((error: unknown) => {
      say(`设置没存上：${String(error)}`, true)
    })
  }

  void (async () => {
    let settings
    try {
      settings = await window.tavern.memorySettings()
    } catch (error) {
      say(`读取记忆设置失败：${String(error)}`, true)
      return
    }

    // ── 一、永久记忆 ──
    body.append(sectionTitle('永久记忆'))
    body.append(
      toggle('启用永久记忆', settings.permanentEnabled, (value) => {
        save({ permanentEnabled: value })
        void refreshLists()
      })
    )
    body.append(
      slider('记忆强度', 5, 50, settings.memoryStrength, ' 条', (value) =>
        save({ memoryStrength: value })
      )
    )
    body.append(
      slider('检索范围', 1, 3, settings.memoryRange, ' 条', (value) => save({ memoryRange: value }))
    )
    const memList = h('div', 'mem-list')
    body.append(memList)

    // ── 二、忆境典藏 ──
    body.append(sectionTitle('忆境典藏'))
    body.append(
      toggle('启用忆境典藏', settings.archiveEnabled, (value) => {
        save({ archiveEnabled: value })
        void refreshLists()
      })
    )
    body.append(
      slider('总结间隔', 20, 100, settings.summaryInterval, ' 层', (value) =>
        save({ summaryInterval: value })
      )
    )
    const summarizeRow = h('div', 'set-row')
    const summarizeBtn = h('button', 'btn', '立即总结一次')
    summarizeBtn.onclick = (): void => {
      summarizeBtn.disabled = true
      summarizeBtn.textContent = '总结中…'
      void window.tavern
        .summaryRefresh(options.chatId)
        .then((result) => {
          if (!result.ok) say(result.error ?? '总结失败', true)
          else say('档案已刷新。')
        })
        .catch((error: unknown) => say(`总结失败：${String(error)}`, true))
        .finally(() => {
          summarizeBtn.disabled = false
          summarizeBtn.textContent = '立即总结一次'
          void refreshLists()
        })
    }
    summarizeRow.append(h('div', 'set-label', '整理档案'), h('div', 'grow'), summarizeBtn)
    body.append(summarizeRow)
    const sumList = h('div', 'mem-list')
    body.append(sumList)

    // ── 三、回忆视界 ──
    body.append(sectionTitle('回忆视界'))
    body.append(
      toggle('启用回忆视界', settings.visionEnabled, (value) => save({ visionEnabled: value }))
    )
    body.append(
      slider('视界深度', 20, 120, settings.visionDepth, ' 条', (value) =>
        save({ visionDepth: value })
      )
    )
    body.append(
      toggle('完整视界（不裁剪，消耗更高）', settings.fullVision, (value) =>
        save({ fullVision: value })
      )
    )

    // 读设置的这几毫秒里面板可能已经被关掉了：关掉就别再登记，否则事件会去画一棵摘下来的树
    if (!overlay.isConnected) return
    openPanel = { chatId: options.chatId, refresh: () => void refreshLists() }
    if (!summaryBound) {
      summaryBound = true
      window.tavern.onSummary((data) => {
        if (openPanel?.chatId === data.chatId) openPanel.refresh()
      })
    }
    void refreshLists()

    /** 记忆条目与历次档案：每次改动后整体重画，省掉逐条的局部同步 */
    async function refreshLists(): Promise<void> {
      const [memories, summary] = await Promise.all([
        window.tavern.memoriesList(options.characterId).catch(() => []),
        window.tavern.summaryGet(options.chatId).catch(() => null)
      ])

      memList.replaceChildren()
      const head = h('div', 'set-label', `她记得的事 · ${memories.length}`)
      memList.append(head)
      if (memories.length === 0) {
        memList.append(h('div', 'hintline', '还没有。聊几轮之后，她会自己记下值得记的事。'))
      }
      for (const item of memories) {
        const row = h('div', 'mem-row')
        const box = document.createElement('textarea')
        box.value = item.content
        box.rows = 2
        box.onblur = (): void => {
          const text = box.value.trim()
          if (!text || text === item.content) {
            box.value = item.content
            return
          }
          void window.tavern.memoriesUpdate(item.id, text).then((ok) => {
            if (!ok) {
              box.value = item.content
              say('这条没存上。', true)
            } else {
              options.onChanged?.()
            }
          })
        }
        const remove = h('button', 'btn ghost danger', '删')
        remove.onclick = (): void => {
          void window.tavern.memoriesDelete(item.id).then(() => {
            row.remove()
            options.onChanged?.()
          })
        }
        row.append(box, remove)
        memList.append(row)
      }

      sumList.replaceChildren()
      const sumHead = h('div', 'set-label', `忆境典藏 · ${summary?.items.length ?? 0}`)
      sumList.append(sumHead)
      if (summary?.summarizing) sumList.append(h('div', 'hintline', '正在总结这一场…'))
      if (summary && summary.text) {
        const text = h('div', 'dossier-view', summary.text)
        sumList.append(text)
      } else if (summary && summary.items.length === 0) {
        sumList.append(h('div', 'hintline', '还没有档案。到总结间隔后会自己整理，也可以点上面的「立即总结一次」。'))
      }
      for (const item of summary?.items ?? []) {
        const row = h('div', 'mem-row')
        const stamp = new Date(item.createdAt)
        const line = h(
          'div',
          'hintline',
          `${stamp.getMonth() + 1}/${stamp.getDate()} ${String(stamp.getHours()).padStart(2, '0')}:${String(
            stamp.getMinutes()
          ).padStart(2, '0')}`
        )
        const editBtn = h('button', 'btn ghost', '改')
        const remove = h('button', 'btn ghost danger', '删')
        const editor = document.createElement('textarea')
        editor.value = item.raw
        editor.rows = 8
        editor.hidden = true
        const saveBtn = h('button', 'btn primary', '保存')
        saveBtn.hidden = true
        saveBtn.onclick = (): void => {
          void window.tavern.summaryUpdate(item.id, editor.value).then((ok) => {
            if (!ok) {
              say('不是合法的档案 JSON，没存。', true)
              return
            }
            say('档案已更新。')
            options.onChanged?.()
            void refreshLists()
          })
        }
        editBtn.onclick = (): void => {
          editor.hidden = !editor.hidden
          saveBtn.hidden = editor.hidden
        }
        remove.onclick = (): void => {
          void window.tavern.summaryDelete(item.id).then(() => {
            options.onChanged?.()
            void refreshLists()
          })
        }
        const ops = h('div', 'mem-ops')
        ops.append(editBtn, saveBtn, remove)
        row.append(line, ops, editor)
        sumList.append(row)
      }
    }
  })()
}
