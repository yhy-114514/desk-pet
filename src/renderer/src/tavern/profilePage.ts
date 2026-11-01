// 「我的人设」（中栏）：全局一份，替代被砍掉的账号系统。
// T2 的 PromptBuilder 会把它当 {{user}} 注入，所以这里写清楚它是给谁看的。
import { h } from './ui'

export function renderProfilePage(mount: HTMLElement, onBack: () => void): Promise<void> {
  mount.replaceChildren()

  const page = h('div', 'page')
  const toolbar = h('div', 'toolbar')
  const backBtn = h('button', 'btn ghost', '← 返回')
  backBtn.onclick = (): void => onBack()
  toolbar.append(backBtn, h('div', 'grow'), h('div', 'left-tag', '我的人设'))

  const editor = h('div', 'editor')
  const nameInput = h('input')
  nameInput.type = 'text'
  nameInput.placeholder = '旅人'
  const descBox = document.createElement('textarea')
  descBox.rows = 6
  descBox.placeholder = '你怎么称呼、是什么样的人。角色会照这里来理解你。'

  const nameField = h('div', 'field')
  nameField.append(h('label', '', '名字'), nameInput)
  const descField = h('div', 'field')
  descField.append(h('label', '', '描述'), descBox)
  editor.append(
    h('div', 'section-title', '你是谁'),
    nameField,
    descField,
    h(
      'div',
      'hintline',
      '这份人设对所有角色卡生效。留空就用默认的「旅人」——不会影响鲸鱼娘对你的称呼。'
    )
  )

  const foot = h('div', 'foot')
  const msg = h('div', 'msg')
  const saveBtn = h('button', 'btn primary', '保存')
  foot.append(msg, saveBtn)

  page.append(toolbar, editor, foot)
  mount.append(page)

  return window.tavern.profileGet().then((profile) => {
    nameInput.value = profile.name
    descBox.value = profile.description

    saveBtn.onclick = async (): Promise<void> => {
      await window.tavern.profileSet({ name: nameInput.value.trim() || '旅人', description: descBox.value })
      msg.textContent = '已保存。'
    }
  })
}
