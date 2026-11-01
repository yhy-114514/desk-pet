// 卡自带的状态栏页面（```html 整页）不是自给自足的：它假定自己跑在酒馆页面里，
// 直接用 `$`（jQuery）、`_`（lodash）、`getAllVariables()`、`getChatMessages()`、
// `Mvu.getMvuData()`、`eventOn()`、`triggerSlash()` 这些全局。
// 我们把它放进沙箱 iframe，那些全局一个都不存在，脚本第一句就抛错——
// 表现是页面停在静态模板上（`---` / `N/A`），按钮点了也没反应。
//
// 这里给一套等价物。数据来自主进程注入的快照（消息楼层 / 变量 / 世界书），
// 所以这些 API 可以是**同步**的（跨 iframe 通信做不到同步返回）。
// 要写回（变量修改、发送消息）的走 postMessage 回父页，由父页落实。
//
// 注入的脚本排在卡页面之前，所以卡里的 `<script type="module">` 执行时它们已经就位。

/** lodash 的 `_.get(obj, '世界.当前时间', 'N/A')`：点路径取值 */
export function lodashGet(source: unknown, path: string, fallback?: unknown): unknown {
  const parts = String(path ?? '')
    .split('.')
    .filter((part) => part !== '')
  let cursor: unknown = source
  for (const key of parts) {
    if (cursor === null || cursor === undefined) return fallback
    if (typeof cursor !== 'object') return fallback
    const holder = cursor as Record<string, unknown>
    if (!(key in holder)) return fallback
    cursor = holder[key]
  }
  return cursor === undefined ? fallback : cursor
}

/** lodash 的 `_.kebabCase('苏月珑')` → 标签页 DOM id 用的那种短横线名 */
export function kebabCase(text: string): string {
  return String(text ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/[^\w一-龥-]+/g, '')
    .toLowerCase()
}

/**
 * `getChatMessages('0-12', { role: 'assistant' })` 的选取逻辑。
 * 写成独立函数再 `toString()` 内联进注入脚本——单测跑的就是 iframe 里那份。
 */
export function selectMessages<T extends { message_id: number; role: string }>(
  messages: T[],
  spec: unknown
): T[] {
  if (!Array.isArray(messages) || messages.length === 0) return []
  if (Array.isArray(spec)) {
    const ids = spec.map((item) => Number(item))
    return messages.filter((item) => ids.indexOf(item.message_id) >= 0)
  }
  const first = messages[0]!.message_id
  const last = messages[messages.length - 1]!.message_id
  // 楼层号是 message_id，不是数组下标：快照截断后 message_id 从窗口起点数起
  // （100 条只带最后 80 条时从 20 开始），拿 `length + value` 当楼层会让 `-1`
  // 取到倒数第 21 条、`-2--1` 整段错位。负数先按下标找到那条，再取它的楼层号。
  const resolve = (value: number): number => {
    if (value >= 0) {
      // 比窗口起点还早的楼层（整场 100 条时的 `0-3`）按窗口内的位置近似：
      // 卡要的是「最开头几条」，一直给空数组等于状态页整块读不到数据
      return value >= first ? value : first + value
    }
    const node = messages[messages.length + value]
    return node ? node.message_id : Number.NaN
  }
  let lo = first
  let hi = last
  if (typeof spec === 'number') {
    lo = hi = resolve(spec)
  } else if (typeof spec === 'string') {
    const text = spec.trim()
    const range = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(text)
    if (range) {
      lo = resolve(Number(range[1]))
      hi = resolve(Number(range[2]))
    } else if (/^-?\d+$/.test(text)) {
      lo = hi = resolve(Number(text))
    }
  }
  if (!Number.isFinite(lo)) lo = first
  if (!Number.isFinite(hi)) hi = last
  const from = Math.min(lo, hi)
  const to = Math.max(lo, hi)
  return messages.filter((item) => item.message_id >= from && item.message_id <= to)
}

/**
 * 酒馆的 `insertOrAssignVariables` 是**深合并**：`{世界:{当前时间:'子时'}}` 只改那一个字段，
 * `世界` 下的地点 / 季节照旧。对象逐层递归、数组整个替换（与 ST 一致）。
 * 同样写成独立函数再 `toString()` 内联——单测跑的就是 iframe 里那份。
 */
export function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    if (value === undefined) continue
    const isObject = value !== null && typeof value === 'object' && !Array.isArray(value)
    const base = target[key]
    if (isObject && base !== null && typeof base === 'object' && !Array.isArray(base)) {
      deepMerge(base as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      target[key] = isObject ? deepMerge({}, value as Record<string, unknown>) : value
    }
  }
  return target
}

/** `/send 你好` → `{ name: 'send', args: '你好' }`；不以 `/` 开头时 name 为空 */
export function parseSlash(command: unknown): { name: string; args: string } {
  const text = String(command ?? '').trim()
  if (!text.startsWith('/')) return { name: '', args: text }
  const body = text.slice(1)
  const space = body.search(/\s/)
  if (space < 0) return { name: body.toLowerCase(), args: '' }
  return { name: body.slice(0, space).toLowerCase(), args: body.slice(space + 1).trim() }
}

/** 序列化进 <script> 的 JSON：`<` 转义，免得变量文本里出现 </script> 把脚本截断 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value ?? {})
    .replace(/</g, '\\u003c')
}

// 卡里的状态栏页面只用到 jQuery 的一小撮：取元素、改 html/text/css、挂点击、after/remove。
// 写成字符串而不是引第三方库：整个 jQuery 会让每个面板的 iframe 多背 90KB。
const MINI_JQUERY = String.raw`
  function toNodes(content) {
    if (content instanceof JQ) return content.nodes
    if (typeof content === 'string') {
      var tpl = document.createElement('template')
      tpl.innerHTML = content
      return Array.prototype.slice.call(tpl.content.childNodes)
    }
    if (content && content.nodeType) return [content]
    return []
  }
  function JQ(nodes) {
    this.nodes = nodes || []
    this.length = this.nodes.length
    for (var i = 0; i < this.nodes.length; i++) this[i] = this.nodes[i]
  }
  var proto = JQ.prototype
  proto.each = function (fn) {
    for (var i = 0; i < this.nodes.length; i++) fn.call(this.nodes[i], i, this.nodes[i])
    return this
  }
  proto.get = function (index) { return this.nodes[index < 0 ? this.nodes.length + index : index] }
  proto.first = function () { return new JQ(this.nodes.slice(0, 1)) }
  proto.eq = function (index) { var node = this.get(index); return new JQ(node ? [node] : []) }
  proto.find = function (selector) {
    var out = []
    this.each(function () {
      var found = this.querySelectorAll ? this.querySelectorAll(selector) : []
      out = out.concat(Array.prototype.slice.call(found))
    })
    return new JQ(out)
  }
  proto.html = function (value) {
    if (value === undefined) return this.nodes[0] ? this.nodes[0].innerHTML : undefined
    return this.each(function () { this.innerHTML = value })
  }
  proto.text = function (value) {
    if (value === undefined) return this.nodes[0] ? this.nodes[0].textContent : undefined
    return this.each(function () { this.textContent = value })
  }
  proto.val = function (value) {
    if (value === undefined) return this.nodes[0] ? this.nodes[0].value : undefined
    return this.each(function () { this.value = value })
  }
  proto.attr = function (name, value) {
    if (value === undefined) return this.nodes[0] ? this.nodes[0].getAttribute(name) : undefined
    return this.each(function () { this.setAttribute(name, value) })
  }
  proto.prop = function (name, value) {
    if (value === undefined) return this.nodes[0] ? this.nodes[0][name] : undefined
    return this.each(function () { this[name] = value })
  }
  proto.data = function (name) {
    var node = this.nodes[0]
    if (!node) return undefined
    var key = String(name).replace(/-([a-z])/g, function (_, c) { return c.toUpperCase() })
    var raw = node.dataset && node.dataset[key] !== undefined
      ? node.dataset[key]
      : node.getAttribute('data-' + name)
    if (raw === undefined || raw === null) return undefined
    // jQuery 会把 data-* 解析成真值：data-open="false" 是布尔 false，
    // 不解析的话卡里的 if ($el.data('open')) 永远判真
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (raw === 'null') return null
    if (raw !== '' && !isNaN(Number(raw))) return Number(raw)
    return raw
  }
  proto.css = function (name, value) {
    if (name && typeof name === 'object') {
      var self = this
      for (var key in name) self.css(key, name[key])
      return this
    }
    if (value === undefined) {
      var node = this.nodes[0]
      if (!node || !node.style) return undefined
      // 连字符属性用 style 下标取不到，得走 getPropertyValue
      return node.style.getPropertyValue(name) || node.style[name]
    }
    return this.each(function () {
      // 连字符写法用 style 下标赋值是空操作，必须 setProperty
      if (String(name).indexOf('-') >= 0) this.style.setProperty(name, value)
      else this.style[name] = value
    })
  }
  proto.ready = function (fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn)
    else setTimeout(fn, 0)
    return this
  }
  proto.addClass = function (name) {
    return this.each(function () { this.classList.add(name) })
  }
  proto.removeClass = function (name) {
    return this.each(function () { this.classList.remove(name) })
  }
  proto.toggleClass = function (name) {
    return this.each(function () { this.classList.toggle(name) })
  }
  proto.hasClass = function (name) { return !!(this.nodes[0] && this.nodes[0].classList.contains(name)) }
  proto.append = function (content) {
    var nodes = toNodes(content)
    return this.each(function () { for (var i = 0; i < nodes.length; i++) this.appendChild(nodes[i]) })
  }
  // 目标是选择器 / DOM 节点 / JQ，走 query 的判定：toNodes 把所有字符串都当 HTML 模板，
  // $('<div>…').appendTo('#statGrid') 会把 '#statGrid' 拼成一个游离文本节点，网格永远空着
  proto.appendTo = function (target) { return query(target).append(this) }
  proto.prepend = function (content) {
    var nodes = toNodes(content)
    return this.each(function () { for (var i = nodes.length - 1; i >= 0; i--) this.insertBefore(nodes[i], this.firstChild) })
  }
  proto.after = function (content) {
    var nodes = toNodes(content)
    return this.each(function () {
      var ref = this
      for (var i = 0; i < nodes.length; i++) ref.parentNode.insertBefore(nodes[i], ref.nextSibling)
    })
  }
  proto.before = function (content) {
    var nodes = toNodes(content)
    return this.each(function () {
      var ref = this
      for (var i = 0; i < nodes.length; i++) ref.parentNode.insertBefore(nodes[i], ref)
    })
  }
  proto.remove = function () { return this.each(function () { if (this.parentNode) this.parentNode.removeChild(this) }) }
  proto.empty = function () { return this.each(function () { this.innerHTML = '' }) }
  proto.show = function () { return this.each(function () { this.style.display = '' }) }
  proto.hide = function () { return this.each(function () { this.style.display = 'none' }) }
  proto.on = function (type, selector, handler) {
    // 三参数的 on(type, selector, fn) 是 jQuery 的委托写法，卡里很常见。
    // 只认两个参数时第三位就是 handler；把字符串当 handler 交给 addEventListener
    // 会直接抛 TypeError，后面整段脚本都不再执行
    if (typeof selector === 'function') { handler = selector; selector = null }
    if (!selector) {
      return this.each(function () {
        this.__tavernHandlers = this.__tavernHandlers || {}
        this.__tavernHandlers[type] = this.__tavernHandlers[type] || []
        this.__tavernHandlers[type].push(handler)
        this.addEventListener(type, handler)
      })
    }
    return this.each(function () {
      var root = this
      var wrapped = function (event) {
        var target = event.target
        var matched = target && target.closest ? target.closest(selector) : null
        if (matched && root.contains(matched)) handler.call(matched, event)
      }
      this.__tavernHandlers = this.__tavernHandlers || {}
      this.__tavernHandlers[type] = this.__tavernHandlers[type] || []
      this.__tavernHandlers[type].push(wrapped)
      this.addEventListener(type, wrapped)
    })
  }
  proto.off = function (type) {
    return this.each(function () {
      var list = (this.__tavernHandlers || {})[type] || []
      for (var i = 0; i < list.length; i++) this.removeEventListener(type, list[i])
      if (this.__tavernHandlers) this.__tavernHandlers[type] = []
    })
  }
  proto.click = function (handler) { return handler ? this.on('click', handler) : this.each(function () { this.click() }) }
  function query(arg) {
    if (typeof arg === 'function') {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arg)
      else setTimeout(arg, 0)
      return new JQ([])
    }
    if (arg instanceof JQ) return arg
    if (typeof arg === 'string') {
      var text = arg.trim()
      if (text.charAt(0) === '<') return new JQ(toNodes(text))
      var found = []
      var groups = text.split(',')
      for (var i = 0; i < groups.length; i++) {
        var one = groups[i].trim()
        if (!one) continue
        found = found.concat(Array.prototype.slice.call(document.querySelectorAll(one)))
      }
      return new JQ(found)
    }
    if (arg === window || arg === document) return new JQ([arg])
    if (arg && arg.nodeType) return new JQ([arg])
    if (arg && arg.length) return new JQ(Array.prototype.slice.call(arg))
    return new JQ([])
  }
`

/**
 * 拼出要注进状态栏 iframe 的运行时脚本。
 * `snapshot` 是这场会话的当前状态（消息楼层 / MVU 变量 / 世界书）。
 */
export function buildStatusBridgeScript(snapshot: {
  charName?: string
  userName?: string
  messages?: unknown[]
  statData?: Record<string, unknown>
  lorebook?: unknown
}): string {
  const initial = {
    charName: snapshot.charName ?? '',
    userName: snapshot.userName ?? '',
    messages: snapshot.messages ?? [],
    statData: snapshot.statData ?? {},
    lorebook: snapshot.lorebook ?? { name: '', entries: [] }
  }
  return (
    '<script>(function(){\n' +
    `var snapshot = ${scriptJson(initial)};\n` +
    `function lodashGet(source, path, fallback) { return (${lodashGet.toString()})(source, path, fallback) }\n` +
    `function kebabCase(text) { return (${kebabCase.toString()})(text) }\n` +
    `function selectMessages(messages, spec) { return (${selectMessages.toString()})(messages, spec) }\n` +
    `function parseSlash(command) { return (${parseSlash.toString()})(command) }\n` +
    'var eachItem = function (collection, iteratee) {\n' +
    '  if (!collection) return collection\n' +
    '  if (Array.isArray(collection)) {\n' +
    '    for (var i = 0; i < collection.length; i++) iteratee(collection[i], i, collection)\n' +
    '  } else if (typeof collection === "object") {\n' +
    '    for (var key in collection) if (Object.prototype.hasOwnProperty.call(collection, key)) iteratee(collection[key], key, collection)\n' +
    '  }\n' +
    '  return collection\n' +
    '}\n' +
    // 变量 / 消息的回写与通知都要先落到父页，再由父页推回来。
    'function post(type, data) {\n' +
    '  try { parent.postMessage(Object.assign({ type: type }, data || {}), "*") } catch (error) {}\n' +
    '}\n' +
    'var bus = {}\n' +
    'function emit(name, payload) {\n' +
    '  var list = (bus[name] || []).slice()\n' +
    '  for (var i = 0; i < list.length; i++) {\n' +
    '    try { list[i](payload) } catch (error) { console.error("[状态栏] 事件回调出错:", name, error) }\n' +
    '  }\n' +
    '  return payload\n' +
    '}\n' +
    'function eventOn(name, handler) { if (typeof handler === "function") (bus[name] = bus[name] || []).push(handler) }\n' +
    'function eventOnce(name, handler) {\n' +
    '  if (typeof handler !== "function") return\n' +
    '  var wrapped = function (payload) { eventRemoveListener(name, wrapped); handler(payload) }\n' +
    '  eventOn(name, wrapped)\n' +
    '}\n' +
    'function eventRemoveListener(name, handler) {\n' +
    '  var list = bus[name]\n' +
    '  if (!list) return\n' +
    '  var index = list.indexOf(handler)\n' +
    '  if (index >= 0) list.splice(index, 1)\n' +
    '}\n' +
    'function eventRemoveAllListeners(name) { if (name) delete bus[name]; else bus = {} }\n' +
    // ── 存储 ──
    // 沙箱 iframe（没有 allow-same-origin）读 localStorage 会直接抛 SecurityError，
    // 而卡里的状态页几乎都用它记「界面风格」「上次开的是哪个页签」。
    // 抛错的位置通常在脚本最前面的一句读取上，整段脚本当场中断——
    // 表现就是页面骨架画出来了、数据区全空（`---` / `0/100`），按钮也全都点不动。
    // 这里换成一个内存实现：值在同一个 iframe 的生命期间有效，重开会回到默认。
    'function makeStorage() {\n' +
    '  var data = {}\n' +
    '  return {\n' +
    '    getItem: function (key) { key = String(key); return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null },\n' +
    '    setItem: function (key, value) { data[String(key)] = String(value) },\n' +
    '    removeItem: function (key) { delete data[String(key)] },\n' +
    '    clear: function () { data = {} },\n' +
    '    key: function (index) { var keys = Object.keys(data); return index >= 0 && index < keys.length ? keys[index] : null },\n' +
    '    get length() { return Object.keys(data).length }\n' +
    '  }\n' +
    '}\n' +
    'try { Object.defineProperty(window, "localStorage", { value: makeStorage(), configurable: true }) } catch (error) {}\n' +
    'try { Object.defineProperty(window, "sessionStorage", { value: makeStorage(), configurable: true }) } catch (error) {}\n' +
    // ── 变量 ──
    'function variablesOf(opts) { return { stat_data: snapshot.statData } }\n' +
    'function applyState(next) {\n' +
    '  snapshot.statData = next && typeof next === "object" ? next : {}\n' +
    '  post("tavern_vars", { state: snapshot.statData })\n' +
    '  emit(Mvu.events.VARIABLE_UPDATE_ENDED, variablesOf())\n' +
    '  return snapshot.statData\n' +
    '}\n' +
    'function getAllVariables() { return variablesOf() }\n' +
    'function getVariables(opts) { return variablesOf(opts) }\n' +
    'function getVariable(key, opts) { return lodashGet(snapshot.statData, String(key), undefined) }\n' +
    'function setVariables(vars) { return applyState(vars && vars.stat_data ? vars.stat_data : vars) }\n' +
    // 酒馆的 insertOrAssignVariables 是**深合并**：`{世界:{当前时间:"子时"}}` 只改那一个字段，
    // `世界` 下的地点 / 季节照旧。只做顶层浅合并的话，整棵 `世界` 子树会被替换掉
    `function deepMerge(target, patch) { return (${deepMerge.toString()})(target, patch) }\n` +
    'function insertOrAssignVariables(vars) {\n' +
    // 卡按酒馆写法传进来的是 `{stat_data: {…}}`：不先解包的话，整个 stat_data
    // 会被当成一个名叫 stat_data 的键塞进变量树，真实字段一个都不更新
    '  var patch = vars && vars.stat_data ? vars.stat_data : vars\n' +
    '  return applyState(deepMerge(deepMerge({}, snapshot.statData), patch || {}))\n' +
    '}\n' +
    'function updateVariablesWith(updater) {\n' +
    '  var next = { stat_data: snapshot.statData }\n' +
    '  try { var result = updater(next); if (result && typeof result === "object") next = result } catch (error) { console.error("[状态栏] 变量更新回调出错:", error) }\n' +
    '  return applyState(next && next.stat_data ? next.stat_data : next)\n' +
    '}\n' +
    'function deleteVariable(key) {\n' +
    '  var parts = String(key).split(".").filter(function (part) { return part !== "" })\n' +
    '  var state = JSON.parse(JSON.stringify(snapshot.statData))\n' +
    '  var cursor = state\n' +
    '  for (var i = 0; i < parts.length - 1; i++) { if (!cursor || typeof cursor !== "object") return; cursor = cursor[parts[i]] }\n' +
    '  if (cursor && typeof cursor === "object") delete cursor[parts[parts.length - 1]]\n' +
    '  return applyState(state)\n' +
    '}\n' +
    // 酒馆助手的 replaceVariables 是「宏替换」，不是写变量
    'function substituteMacros(text) {\n' +
    '  return String(text == null ? "" : text)\n' +
    // 替换值必须写成函数：名字里带 `$&` / `$1` 时，字符串替换值会被当成替换模式展开
    '    .replace(/\\{\\{user\\}\\}/gi, function () { return snapshot.userName })\n' +
    '    .replace(/\\{\\{char\\}\\}/gi, function () { return snapshot.charName })\n' +
    '    .replace(/\\{\\{getvar::([^}]+)\\}\\}/gi, function (_, key) {\n' +
    '      var value = lodashGet(snapshot.statData, String(key).trim(), "")\n' +
    '      return value == null ? "" : String(value)\n' +
    '    })\n' +
    '}\n' +
    // ── 消息 ──
    'function getLastMessageId() {\n' +
    '  return snapshot.messages.length ? snapshot.messages[snapshot.messages.length - 1].message_id : -1\n' +
    '}\n' +
    'function getChatMessages(spec, opts) {\n' +
    '  var picked = selectMessages(snapshot.messages, spec)\n' +
    '  var role = opts && opts.role\n' +
    '  if (role) picked = picked.filter(function (item) { return item.role === role })\n' +
    "  return picked.map(function (item) {\n" +
    '    return { message_id: item.message_id, role: item.role, name: item.name, message: item.message, is_hidden: false, swipe_id: 0, swipes: [item.message] }\n' +
    '  })\n' +
    '}\n' +
    'function getChatWorldbookName() { return snapshot.lorebook.name }\n' +
    // ── 世界书 ──
    'function loreEntries() { return (snapshot.lorebook && snapshot.lorebook.entries) || [] }\n' +
    'function getLorebookEntries() { return loreEntries() }\n' +
    'function getLorebookSettings() { return { selected_global_lorebooks: [], charLore: [] } }\n' +
    'function getWorldbook() { return loreEntries().map(function (entry) { return { name: entry.name, uid: entry.uid, content: entry.content, keys: entry.keys } }) }\n' +
    'function getCharLorebooks() { return { primary: snapshot.lorebook.name, additional: [] } }\n' +
    'function getCharWorldbookNames() { return { primary: snapshot.lorebook.name, additional: [] } }\n' +
    'function getCurrentCharPrimaryLorebook() { return snapshot.lorebook.name }\n' +
    'function getCharData() { return { name: snapshot.charName } }\n' +
    'function getCharacter() { return { name: snapshot.charName, avatar: "" } }\n' +
    'function getCurrentCharName() { return snapshot.charName }\n' +
    // 卡用 getPreset 读预设里的条目：我们没把那套镜像进来，返回空数组让它走兜底
    'function getPreset() { return [] }\n' +
    // ── 交互 ──
    'function triggerSlash(command) {\n' +
    '  var parsed = parseSlash(command)\n' +
    '  var args = parsed.args\n' +
    '  if (!parsed.name) {\n' +
    // 不以 / 开头的整句当玩家发言（酒馆的 triggerSlash 也是这个语义）
    '    if (args) post("tavern_send", { text: args })\n' +
    '    return Promise.resolve("")\n' +
    '  }\n' +
    '  if (parsed.name === "send" || parsed.name === "sendas" || parsed.name === "sys" || parsed.name === "sysname") {\n' +
    '    post("tavern_send", { text: args })\n' +
    '    return Promise.resolve("")\n' +
    '  }\n' +
    '  if (parsed.name === "trigger") { post("tavern_trigger", {}); return Promise.resolve("") }\n' +
    '  if (parsed.name === "echo" || parsed.name === "comment") { post("tavern_toast", { message: args }); return Promise.resolve("") }\n' +
    '  if (parsed.name === "setvar" || parsed.name === "setglobalvar") {\n' +
    '    var equal = args.indexOf("=")\n' +
    '    if (equal > 0) {\n' +
    '      var key = args.slice(0, equal).trim()\n' +
    '      var value = args.slice(equal + 1).trim()\n' +
    '      var state = JSON.parse(JSON.stringify(snapshot.statData))\n' +
    '      var parts = key.split(".").filter(function (part) { return part !== "" })\n' +
    '      var cursor = state\n' +
    '      for (var i = 0; i < parts.length - 1; i++) {\n' +
    '        if (!cursor[parts[i]] || typeof cursor[parts[i]] !== "object") cursor[parts[i]] = {}\n' +
    '        cursor = cursor[parts[i]]\n' +
    '      }\n' +
    '      cursor[parts[parts.length - 1]] = value\n' +
    '      applyState(state)\n' +
    '    }\n' +
    '    return Promise.resolve("")\n' +
    '  }\n' +
    '  if (parsed.name === "getvar") {\n' +
    '    var found = lodashGet(snapshot.statData, args, "")\n' +
    '    return Promise.resolve(found == null ? "" : String(found))\n' +
    '  }\n' +
    // 其余斜杠命令交给父页记一行日志，免得按钮点了完全没反应
    '  post("tavern_slash", { command: String(command) })\n' +
    '  return Promise.resolve("")\n' +
    '}\n' +
    'function triggerSlashWithResult(command) { return triggerSlash(command) }\n' +
    // ── 事件常量 ──
    'var tavern_events = {\n' +
    '  MESSAGE_SENT: "message_sent",\n' +
    '  MESSAGE_RECEIVED: "message_received",\n' +
    '  MESSAGE_UPDATED: "message_updated",\n' +
    '  MESSAGE_DELETED: "message_deleted",\n' +
    '  MESSAGE_SWIPED: "message_swiped",\n' +
    '  GENERATION_STARTED: "generation_started",\n' +
    '  GENERATION_ENDED: "generation_ended",\n' +
    '  CHARACTER_MESSAGE_RENDERED: "character_message_rendered",\n' +
    '  USER_MESSAGE_RENDERED: "user_message_rendered"\n' +
    '}\n' +
    'var Mvu = {\n' +
    '  events: {\n' +
    '    VARIABLE_UPDATE_STARTED: "mag_variable_update_started",\n' +
    '    VARIABLE_UPDATE_ENDED: "mag_variable_update_ended",\n' +
    '    VARIABLE_UPDATED: "mag_variable_updated",\n' +
    '    VARIABLE_UPDATE_AFFECTED: "mag_variable_update_affected"\n' +
    '  },\n' +
    '  getMvuData: function () { return { stat_data: snapshot.statData } },\n' +
    '  replaceMvuData: function (data) { return { stat_data: applyState(data && data.stat_data ? data.stat_data : data) } },\n' +
    '  parseMessage: function () { return { stat_data: snapshot.statData } },\n' +
    '  isDuringExtraAnalysis: function () { return false },\n' +
    '  getMvuVariable: function (data, path) { return lodashGet(data && data.stat_data ? data.stat_data : data, String(path), undefined) },\n' +
    '  setMvuVariable: function (data, path, value) {\n' +
    '    var state = JSON.parse(JSON.stringify(snapshot.statData))\n' +
    '    var parts = String(path).split(".").filter(function (part) { return part !== "" })\n' +
    '    var cursor = state\n' +
    '    for (var i = 0; i < parts.length - 1; i++) {\n' +
    '      if (!cursor[parts[i]] || typeof cursor[parts[i]] !== "object") cursor[parts[i]] = {}\n' +
    '      cursor = cursor[parts[i]]\n' +
    '    }\n' +
    '    cursor[parts[parts.length - 1]] = value\n' +
    '    data.stat_data = applyState(state)\n' +
    '    return data\n' +
    '  }\n' +
    '}\n' +
    // ── 提示 ──
    'function toast(level) {\n' +
    '  return function (message) { post("tavern_toast", { level: level, message: String(message == null ? "" : message) }) }\n' +
    '}\n' +
    'var toastr = { success: toast("success"), info: toast("info"), warning: toast("warning"), error: toast("error"), clear: function () {} }\n' +
    // ── 报错上报 ──
    // 卡里的脚本抛了未捕获错误时，页面就安静地停在半成品状态（骨架在、数据全空），
    // 父页看不出发生了什么。这里把第一条错误送回父页，由它在消息下面写一行说明。
    // 只报第一条：一个崩掉的初始化函数往往会连着一串连锁错误，全铺出来反而盖住有用的那条。
    // **必须是真正的脚本错误**（ErrorEvent）：capture 阶段还会收到 img / audio / link
    // 加载失败的 error 事件，那些既没有 message 也没有堆栈，报出来只是一句
    // 「脚本出错」——卡里引用了一张外链头像 404，用户却以为整张卡坏了。
    'var errorReported = false\n' +
    'function reportError(message) {\n' +
    '  if (errorReported) return\n' +
    '  errorReported = true\n' +
    '  post("tavern_error", { message: String(message == null ? "" : message) })\n' +
    '}\n' +
    'window.addEventListener("error", function (event) {\n' +
    '  if (!event || !event.message) return\n' +
    '  reportError(event.message)\n' +
    '}, true)\n' +
    'window.addEventListener("unhandledrejection", function (event) {\n' +
    '  var reason = event && event.reason\n' +
    '  reportError((reason && reason.message) || reason || "Promise 出错")\n' +
    '})\n' +
    // ── 父窗口 ──
    // 状态页里有一堆 `window.parent.document.querySelector(...)`（取玩家头像、找消息容器）。
    // 沙箱 iframe 是 opaque origin，碰一下就抛 SecurityError；抛在顶层时整段初始化当场中断，
    // 后面的标签页 / 按钮一个都绑不上。这里换成一个只会返回空结果的替身，
    // postMessage 照旧转给真正的父页（高度上报、tavern_* 消息都靠它）。
    'var realPost = window.parent.postMessage.bind(window.parent)\n' +
    'var parentStub = {\n' +
    '  document: {\n' +
    '    querySelector: function () { return null },\n' +
    '    querySelectorAll: function () { return [] },\n' +
    '    getElementById: function () { return null },\n' +
    '    createElement: function (tag) { return document.createElement(tag) },\n' +
    '    addEventListener: function () {},\n' +
    // 卡把新节点挂到「父页 body」时落到它自己页面上即可：总比抛错中断整段脚本强
    '    get body() { return document.body }\n' +
    '  },\n' +
    '  postMessage: function (message, origin) { try { realPost(message, origin || "*") } catch (error) {} },\n' +
    '  addEventListener: function () {},\n' +
    '  location: { href: "" }\n' +
    '}\n' +
    'try { Object.defineProperty(window, "parent", { configurable: true, value: parentStub }) } catch (error) {}\n' +
    // ── 父页推送（变量更新 / 新消息）──
    'window.addEventListener("message", function (event) {\n' +
    '  var data = event.data\n' +
    '  if (!data || !data.__tavernPush) return\n' +
    '  var next = data.__tavernPush\n' +
    '  if (next.messages) snapshot.messages = next.messages\n' +
    '  if (next.statData) snapshot.statData = next.statData\n' +
    '  if (next.charName) snapshot.charName = next.charName\n' +
    '  if (next.userName) snapshot.userName = next.userName\n' +
    '  if (next.lorebook) snapshot.lorebook = next.lorebook\n' +
    '  emit(Mvu.events.VARIABLE_UPDATE_ENDED, variablesOf())\n' +
    '  if (next.messages) emit(tavern_events.MESSAGE_UPDATED, { messages: next.messages })\n' +
    '})\n' +
    MINI_JQUERY +
    'window._ = {\n' +
    '  get: lodashGet,\n' +
    '  forEach: eachItem,\n' +
    '  each: eachItem,\n' +
    '  kebabCase: kebabCase,\n' +
    '  keys: function (value) { return value && typeof value === "object" ? Object.keys(value) : [] },\n' +
    '  values: function (value) { return value && typeof value === "object" ? Object.keys(value).map(function (k) { return value[k] }) : [] },\n' +
    '  isEmpty: function (value) { return !value || (typeof value === "object" && Object.keys(value).length === 0) },\n' +
    '  isEqual: function (a, b) { try { return JSON.stringify(a) === JSON.stringify(b) } catch (error) { return a === b } },\n' +
    '  map: function (collection, iteratee) { var out = []; eachItem(collection, function (item, key, all) { out.push(iteratee(item, key, all)) }); return out }\n' +
    '}\n' +
    'window.$ = window.jQuery = query\n' +
    // 变量 / 消息 / 事件 / 世界书 / 斜杠命令：卡里裸调的就是这些全局
    'window.getAllVariables = getAllVariables\n' +
    'window.getVariables = getVariables\n' +
    'window.getVariable = getVariable\n' +
    'window.setVariables = setVariables\n' +
    'window.insertOrAssignVariables = insertOrAssignVariables\n' +
    'window.updateVariablesWith = updateVariablesWith\n' +
    'window.deleteVariable = deleteVariable\n' +
    'window.replaceVariables = substituteMacros\n' +
    'window.substitudeMacros = substituteMacros\n' +
    'window.getLastMessageId = getLastMessageId\n' +
    'window.getChatMessages = getChatMessages\n' +
    'window.getChatWorldbookName = getChatWorldbookName\n' +
    'window.getLorebookEntries = getLorebookEntries\n' +
    'window.getLorebookSettings = getLorebookSettings\n' +
    'window.getWorldbook = getWorldbook\n' +
    'window.getCharLorebooks = getCharLorebooks\n' +
    'window.getCharWorldbookNames = getCharWorldbookNames\n' +
    'window.getCurrentCharPrimaryLorebook = getCurrentCharPrimaryLorebook\n' +
    'window.getCharData = getCharData\n' +
    'window.getCharacter = getCharacter\n' +
    'window.getCurrentCharName = getCurrentCharName\n' +
    'window.getPreset = getPreset\n' +
    'window.triggerSlash = triggerSlash\n' +
    'window.triggerSlashWithResult = triggerSlashWithResult\n' +
    'window.eventOn = eventOn\n' +
    'window.eventOnce = eventOnce\n' +
    'window.eventEmit = emit\n' +
    'window.eventRemoveListener = eventRemoveListener\n' +
    'window.eventRemoveAllListeners = eventRemoveAllListeners\n' +
    'window.tavern_events = tavern_events\n' +
    'window.Mvu = Mvu\n' +
    'window.toastr = toastr\n' +
    // 酒馆助手（TavernHelper）是上面这些的门面，卡里两种写法都用
    'window.TavernHelper = {\n' +
    '  getLastMessageId: getLastMessageId,\n' +
    '  getChatMessages: getChatMessages,\n' +
    '  getChatWorldbookName: getChatWorldbookName,\n' +
    '  getVariables: getVariables,\n' +
    '  getAllVariables: getAllVariables,\n' +
    '  getVariable: getVariable,\n' +
    '  setVariables: setVariables,\n' +
    '  insertOrAssignVariables: insertOrAssignVariables,\n' +
    '  updateVariablesWith: updateVariablesWith,\n' +
    '  deleteVariable: deleteVariable,\n' +
    '  replaceVariables: substituteMacros,\n' +
    '  substitudeMacros: substituteMacros,\n' +
    '  getLorebookEntries: getLorebookEntries,\n' +
    '  getLorebookSettings: getLorebookSettings,\n' +
    '  getWorldbook: getWorldbook,\n' +
    '  getCharLorebooks: getCharLorebooks,\n' +
    '  getCharWorldbookNames: getCharWorldbookNames,\n' +
    '  getCurrentCharPrimaryLorebook: getCurrentCharPrimaryLorebook,\n' +
    '  getCharData: getCharData,\n' +
    '  getCharacter: getCharacter,\n' +
    '  getCurrentCharName: getCurrentCharName,\n' +
    '  getPreset: getPreset,\n' +
    '  triggerSlash: triggerSlash,\n' +
    '  triggerSlashWithResult: triggerSlashWithResult,\n' +
    '  eventOn: eventOn,\n' +
    '  eventOnce: eventOnce,\n' +
    '  eventEmit: emit,\n' +
    '  eventRemoveListener: eventRemoveListener,\n' +
    '  eventRemoveAllListeners: eventRemoveAllListeners,\n' +
    '  tavern_events: tavern_events,\n' +
    '  getTavernHelperVersion: function () { return "4.0.0" }\n' +
    '}\n' +
    // SillyTavern 本体：卡用它读消息 / 名字 / 变量元数据
    'window.SillyTavern = {\n' +
    '  libs: {},\n' +
    '  getRequestHeaders: function () { return {} },\n' +
    '  getContext: function () {\n' +
    '    return {\n' +
    '      chat: snapshot.messages.map(function (item) { return { name: item.name, is_user: item.role === "user", is_system: item.role === "system", mes: item.message } }),\n' +
    '      characters: [{ name: snapshot.charName }],\n' +
    '      name1: snapshot.userName,\n' +
    '      name2: snapshot.charName,\n' +
    '      chatMetadata: { variables: { stat_data: snapshot.statData } },\n' +
    '      extensionSettings: {},\n' +
    '      powerUserSettings: {},\n' +
    '      eventSource: { on: eventOn, once: eventOnce, emit: emit, removeListener: eventRemoveListener },\n' +
    '      eventTypes: tavern_events\n' +
    '    }\n' +
    '  }\n' +
    '}\n' +
    // 酒馆里这些是酒馆助手注入的：等某个扩展初始化 / 给回调兜错
    'window.waitGlobalInitialized = function () { return Promise.resolve() }\n' +
    'window.errorCatched = function (fn) {\n' +
    '  return function () { try { return fn.apply(this, arguments) } catch (error) { console.error("[状态栏]", error) } }\n' +
    '}\n' +
    // 沙箱 iframe（无 allow-same-origin）不是安全上下文，卡里的「复制选项」按钮会静默失败。
    // 这里**无条件**把 writeText 接到 postMessage：不能只在 `!navigator.clipboard` 时才接，
    // 有的环境里 clipboard 存在但 writeText 必定 reject（非安全上下文 / 文档没焦点），
    // 卡里的 then 链拿不到值就又走它自己的 execCommand 兜底——那在沙箱里同样是空操作。
    // 真正写剪贴板的是主进程（见 chatPage 的 tavern_copy 分支 + tavern:clipboard-write）。
    'try {\n' +
    '  var copyText = function (text) {\n' +
    '    parent.postMessage({ type: "tavern_copy", text: String(text) }, "*");\n' +
    '    return Promise.resolve()\n' +
    '  };\n' +
    '  Object.defineProperty(navigator, "clipboard", {\n' +
    '    value: { writeText: copyText, write: copyText },\n' +
    '    configurable: true\n' +
    '  })\n' +
    '} catch (error) { console.error("[状态栏] 剪贴板桥装不上", error) }\n' +
    '})()</script>'
  )
}
