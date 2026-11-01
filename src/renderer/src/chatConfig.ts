// API Key 配置窗（#config）：首次启动无 Key 时由主进程弹出，保存后关闭。
// Key 只在窗口与主进程之间传递，不会进入桌宠渲染进程。
const MODELS = [
  { value: 'deepseek-flash', label: 'deepseek-flash（日常聊天）' },
  { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro（复杂推理）' }
]

export async function renderChatConfig(): Promise<void> {
  document.body.style.cssText =
    'margin:0;background:var(--pet-bg);color:var(--pet-fg);font:14px var(--pet-font)'

  const stored = await window.chat.getConfig()

  const wrap = document.createElement('div')
  wrap.style.cssText =
    'box-sizing:border-box;height:100vh;padding:22px 24px;display:flex;flex-direction:column;gap:12px;overflow-y:auto'

  const title = document.createElement('div')
  title.textContent = '配置 DeepSeek'
  title.style.cssText = 'font-size:16px;font-weight:600'

  const desc = document.createElement('div')
  desc.textContent = 'Key 只保存在本机 userData/config.json，不会发给渲染进程或第三方。'
  desc.style.cssText = 'font-size:12px;color:var(--pet-muted);line-height:1.5'

  const keyLabel = document.createElement('label')
  keyLabel.textContent = 'API Key'
  keyLabel.style.cssText = 'font-size:12px;color:var(--pet-label)'

  const keyInput = document.createElement('input')
  keyInput.type = 'password'
  keyInput.placeholder = stored.hasKey ? '已配置（留空则保持不变）' : 'sk-...'
  keyInput.style.cssText = inputStyle()

  const modelLabel = document.createElement('label')
  modelLabel.textContent = '模型'
  modelLabel.style.cssText = 'font-size:12px;color:var(--pet-label);margin-top:2px'

  const modelSelect = document.createElement('select')
  modelSelect.style.cssText = inputStyle()
  for (const model of MODELS) {
    const option = document.createElement('option')
    option.value = model.value
    option.textContent = model.label
    modelSelect.appendChild(option)
  }
  modelSelect.value = stored.model

  const voiceLabel = document.createElement('label')
  voiceLabel.textContent = '音色'
  voiceLabel.style.cssText = 'font-size:12px;color:var(--pet-label);margin-top:2px'

  const voiceSelect = document.createElement('select')
  voiceSelect.style.cssText = inputStyle()

  const voiceHint = document.createElement('div')
  voiceHint.style.cssText = 'font-size:12px;color:var(--pet-muted);line-height:1.5'

  const qwenLabel = document.createElement('label')
  qwenLabel.textContent = '百炼 API Key（可选，情绪朗读与记忆语义检索都用它）'
  qwenLabel.style.cssText = 'font-size:12px;color:var(--pet-label);margin-top:2px'

  const qwenKeyInput = document.createElement('input')
  qwenKeyInput.type = 'password'
  qwenKeyInput.placeholder = stored.hasQwenKey ? '已配置（留空则保持不变）' : 'sk-...'
  qwenKeyInput.style.cssText = inputStyle()

  const qwenHint = document.createElement('div')
  qwenHint.textContent =
    '免费的 Edge 朗读只能普通语气；填了阿里云百炼（DashScope）的 Key 后，她会按情绪调整语调、语速和气息，' +
    '记忆检索也会从关键词升级成语义（换个说法也认得出你在说什么）。'
  qwenHint.style.cssText = 'font-size:12px;color:var(--pet-muted);line-height:1.5'

  /**
   * 两套音色全部列出来（分组显示），想切哪套就切哪套——
   * 走哪条通道由所选音色决定：Edge 音色 = 免费普通朗读，千问音色 = 按情绪读（需百炼 Key）。
   */
  const buildVoiceOptions = (): void => {
    const groups = [
      { label: '免费 Edge（普通语气）', provider: 'edge' as const },
      { label: '千问 · 需百炼 Key（能按情绪读）', provider: 'qwen' as const }
    ]
    voiceSelect.replaceChildren()
    for (const group of groups) {
      const optgroup = document.createElement('optgroup')
      optgroup.label = group.label
      for (const voice of stored.voices.filter((v) => v.provider === group.provider)) {
        const option = document.createElement('option')
        option.value = voice.name
        option.textContent = voice.label
        optgroup.appendChild(option)
      }
      voiceSelect.appendChild(optgroup)
    }
    // 配置里存过的音色不在名单里时，浏览器会落到第一项（不会被选中为空）
    voiceSelect.value = stored.voice
  }

  /** 说明当前所选音色会不会按情绪读——选了 Edge 音色却以为情绪坏了，是最容易踩的坑。 */
  const updateVoiceHint = (): void => {
    const provider = stored.voices.find((v) => v.name === voiceSelect.value)?.provider
    const hasQwenKey = qwenKeyInput.value.trim().length > 0 || stored.hasQwenKey
    if (provider !== 'qwen') {
      voiceHint.textContent = hasQwenKey
        ? 'Edge 音色免费但有固定语气；想听情绪就选下面那组的千问音色。'
        : 'Edge 音色免费但有固定语气，不会随情绪变化。'
    } else if (!hasQwenKey) {
      voiceHint.textContent = '千问音色需要上面的百炼 Key；没填会自动退回晓伊的普通语气。'
    } else {
      voiceHint.textContent = '千问音色会按情绪朗读：语调、语速、气息一起变。'
    }
  }

  voiceSelect.addEventListener('change', updateVoiceHint)
  qwenKeyInput.addEventListener('input', updateVoiceHint)
  buildVoiceOptions()
  updateVoiceHint()

  const ttsRow = document.createElement('label')
  ttsRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;color:var(--pet-label);margin-top:2px'

  const ttsToggle = document.createElement('input')
  ttsToggle.type = 'checkbox'
  ttsToggle.checked = stored.ttsEnabled
  ttsToggle.style.cssText = 'accent-color:var(--pet-accent);width:15px;height:15px;margin:0;cursor:pointer'

  ttsRow.append(ttsToggle, document.createTextNode('朗读她的回复（语音）'))

  const proactiveRow = document.createElement('label')
  proactiveRow.style.cssText =
    'display:flex;align-items:center;gap:8px;font-size:13px;color:var(--pet-label)'

  const proactiveToggle = document.createElement('input')
  proactiveToggle.type = 'checkbox'
  proactiveToggle.checked = stored.proactiveEnabled
  proactiveToggle.style.cssText =
    'accent-color:var(--pet-accent);width:15px;height:15px;margin:0;cursor:pointer'

  proactiveRow.append(proactiveToggle, document.createTextNode('允许她主动找我说话'))

  const footer = document.createElement('div')
  footer.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:auto'

  const status = document.createElement('span')
  status.style.cssText = 'font-size:12px;color:var(--pet-danger);flex:1'

  const help = document.createElement('button')
  help.textContent = '使用说明'
  help.title = '看看这个软件都能做什么'
  help.style.cssText =
    'background:transparent;color:var(--pet-label);border:1px solid var(--pet-border);border-radius:8px;' +
    'padding:8px 14px;font:13px var(--pet-font);cursor:pointer'
  help.onclick = (): void => window.chat.openHelp()

  const save = document.createElement('button')
  save.textContent = '保存'
  save.style.cssText =
    'background:var(--pet-accent);color:var(--pet-on-accent);border:0;border-radius:8px;padding:9px 22px;' +
    'font:14px var(--pet-font);cursor:pointer'

  save.onclick = (): void => {
    const apiKey = keyInput.value.trim()
    if (!apiKey && !stored.hasKey) {
      status.textContent = 'Key 不能为空'
      return
    }
    // 已配置时留空表示「保留原 Key」，只更新模型、音色与语音开关
    const model = modelSelect.value
    const voice = voiceSelect.value
    const qwenKey = qwenKeyInput.value.trim()
    const ttsEnabled = ttsToggle.checked
    const proactiveEnabled = proactiveToggle.checked
    window.chat.setConfig({
      model,
      voice,
      ttsEnabled,
      proactiveEnabled,
      ...(apiKey ? { apiKey } : {}),
      ...(qwenKey ? { qwenKey } : {})
    })
    window.chat.closeConfig()
  }

  keyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save.click()
  })

  footer.append(help, status, save)
  wrap.append(
    title,
    desc,
    keyLabel,
    keyInput,
    modelLabel,
    modelSelect,
    voiceLabel,
    voiceSelect,
    voiceHint,
    qwenLabel,
    qwenKeyInput,
    qwenHint,
    ttsRow,
    proactiveRow,
    footer
  )
  document.body.appendChild(wrap)

  keyInput.focus()
}

function inputStyle(): string {
  return (
    'background:var(--pet-input-bg);color:var(--pet-text);border:1px solid var(--pet-border);border-radius:8px;' +
    'padding:8px 11px;font:13px var(--pet-font);outline:none;width:100%;box-sizing:border-box'
  )
}
