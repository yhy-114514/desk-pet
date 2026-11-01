// 酒馆窗口的共用件：主题样式表、DOM 小工具、立绘地址。
// 几个页面（角色库 / 编辑页 / 人设页）共用一套配色，样式集中在这里，改主题只动一处。

export const TAVERN_CSS = `
:root {
  --abyss: #08101f;
  --panel: #0e1a2e;
  --panel-hi: #14253d;
  --line: #1e3450;
  --cyan: #5fe0d4;
  --coral: #ff8f9c;
  --text: #dce8f7;
  --muted: #7b90ad;
  /* T5 外观：字体 / 三色 / 气泡，运行时由 appearance.ts 写值 */
  --font-stack: system-ui, "Microsoft YaHei", sans-serif;
  --seg-narration: #dce8f7;
  --seg-dialogue: #ffc6ce;
  --seg-action: #9fd8e8;
  --bubble-alpha: .85;
  --chat-font-size: 14px;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; }
body {
  background:
    radial-gradient(1200px 700px at 15% -10%, #142c46 0%, transparent 60%),
    radial-gradient(900px 600px at 95% 110%, #1b2038 0%, transparent 55%),
    var(--abyss);
  color: var(--text);
  font-size: 14px;
  font-family: var(--font-stack);
  user-select: none;
}
#tavern { display: flex; flex-direction: column; height: 100vh; }

/* 顶栏：无边框窗口，靠这条自己拖 */
.titlebar {
  height: 40px; flex: none; display: flex; align-items: center; gap: 10px;
  padding: 0 8px 0 16px; border-bottom: 1px solid var(--line);
  -webkit-app-region: drag;
}
.mark {
  width: 9px; height: 9px; border-radius: 50%; background: var(--cyan);
  box-shadow: 0 0 10px var(--cyan);
}
.name { font-size: 13px; letter-spacing: .12em; }
.sub { font-size: 11px; color: var(--muted); letter-spacing: .18em; }
.grow { flex: 1; }
.status { font-size: 11px; color: var(--muted); -webkit-app-region: no-drag; }
.status.bad { color: var(--coral); }
.close {
  -webkit-app-region: no-drag; width: 28px; height: 28px; border: 0; border-radius: 6px;
  background: transparent; color: var(--muted); font-size: 15px; cursor: pointer;
}
.close:hover { background: #ff5f6d33; color: var(--coral); }
/* 顶栏的非关闭类按钮（⚙）：悬停不该泛红，那是「危险操作」的语义 */
.tool {
  -webkit-app-region: no-drag; width: 28px; height: 28px; border: 0; border-radius: 6px;
  background: transparent; color: var(--muted); font-size: 14px; cursor: pointer;
}
.tool:hover { background: var(--panel-hi); color: var(--text); }

/* 三栏 */
.body { flex: 1; min-height: 0; display: grid; grid-template-columns: 260px 1fr 300px; }
.col { min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.col-left { border-right: 1px solid var(--line); background: #0b1526cc; }
.col-right { border-left: 1px solid var(--line); background: #0b1526cc; }
.col-head {
  flex: none; padding: 14px 16px 10px; font-size: 11px; letter-spacing: .18em; color: var(--muted);
}
.hint {
  margin: auto; padding: 0 22px 28px; text-align: center; font-size: 12px;
  line-height: 1.9; color: var(--muted); white-space: pre-line;
}
.dot {
  width: 26px; height: 26px; flex: none; border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #8ff6ec, #2a7fa8);
  box-shadow: 0 0 14px #5fe0d466;
}

/* ── 右栏：鲸鱼娘观战抽屉（T7）── */
.spec-state { display: flex; align-items: center; gap: 9px; padding: 0 16px 10px; }
.spec-state .dot { width: 9px; height: 9px; box-shadow: 0 0 8px #5fe0d466; opacity: .35; }
.spec-state .dot.on { opacity: 1; }
.spec-state-text { font-size: 12px; color: var(--muted); line-height: 1.5; }
.spec-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 10px; }
.spec-chips button {
  padding: 5px 9px; border: 1px solid var(--line); border-radius: 8px;
  background: #101f36; color: #9fc0e0; font-size: 11.5px; cursor: pointer;
}
.spec-chips button:hover { border-color: #2f7f86; color: var(--cyan); }
.spec-chips button:disabled { opacity: .45; cursor: default; }
.spec-log {
  flex: 1; min-height: 0; overflow-y: auto; padding: 0 14px 10px;
  display: flex; flex-direction: column; gap: 10px;
}
.spec-msg { font-size: 12.5px; line-height: 1.75; word-break: break-word; }
.spec-msg.user {
  align-self: flex-end; max-width: 92%; padding: 7px 10px; border-radius: 10px;
  background: var(--panel-hi); color: var(--text);
}
.spec-msg.bot .spec-text { white-space: pre-wrap; }
.spec-msg.bot.bad .spec-text { color: var(--coral); }
.spec-who { font-size: 10px; letter-spacing: .14em; color: var(--muted); margin-bottom: 2px; }
.spec-empty {
  padding: 12px; border: 1px dashed var(--line); border-radius: 10px;
  font-size: 12px; line-height: 1.85; color: var(--muted); white-space: pre-line;
}
.spec-composer {
  display: flex; gap: 8px; align-items: flex-end;
  padding: 10px 14px 14px; border-top: 1px solid var(--line);
}
.spec-composer textarea {
  flex: 1; min-height: 34px; max-height: 90px; resize: none;
  background: #0b1526; border: 1px solid var(--line); border-radius: 9px;
  color: var(--text); font: inherit; font-size: 12.5px; padding: 7px 9px;
}
.spec-composer textarea:focus { outline: 0; border-color: #2f7f86; }
.spec-hint { padding: 0 16px 8px; font-size: 11px; line-height: 1.6; color: var(--muted); }
.spec-hint.bad { color: var(--coral); }

/* ── 左栏：角色列表 ── */
.left-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 10px 12px; }
.left-item {
  display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 9px;
  cursor: pointer; border: 1px solid transparent;
}
.left-item:hover { background: #14253d; border-color: var(--line); }
.left-item[aria-current="true"] { background: #122e38; border-color: #2f6f7a; }
.left-avatar {
  width: 30px; height: 30px; flex: none; border-radius: 8px; overflow: hidden;
  background: linear-gradient(160deg, #1d3350, #10203a);
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; color: #6f93bd;
}
.left-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.left-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.left-name { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.left-tag { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.left-sub { padding: 10px 8px 4px; font-size: 11px; color: var(--muted); letter-spacing: .08em; }
.left-avatar.group-avatar { font-size: 11px; color: #7fd4c8; }

/* ── 通用控件 ── */
.page { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 0 22px 24px; }
.toolbar {
  flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 14px 22px 10px;
}
.btn {
  flex: none; border: 1px solid var(--line); background: var(--panel); color: var(--text);
  border-radius: 8px; padding: 7px 12px; font-size: 12px; cursor: pointer;
  font-family: inherit; transition: background .12s, border-color .12s, color .12s;
}
.btn:hover { background: var(--panel-hi); border-color: #2b4a6b; }
.btn.primary { background: #10333c; border-color: #2f7f86; color: #8ef0e6; }
.btn.primary:hover { background: #14414c; }
.btn.ghost { background: transparent; }
.btn.danger:hover { background: #3a1c26; border-color: #7a3040; color: var(--coral); }
.btn:disabled { opacity: .45; cursor: default; }
.search {
  flex: 1; min-width: 140px; background: var(--panel); border: 1px solid var(--line);
  border-radius: 8px; color: var(--text); padding: 7px 11px; font-size: 13px; font-family: inherit; outline: none;
}
.search:focus { border-color: #2f7f86; }
.search::placeholder { color: #5f7593; }
.notice { flex: none; padding: 0 22px 10px; font-size: 12px; color: #8fb4c9; line-height: 1.6; }
.notice.bad { color: var(--coral); }
.chips { flex: none; display: flex; flex-wrap: wrap; gap: 6px; padding: 0 22px 12px; }
.chip {
  border: 0; border-radius: 999px; padding: 4px 11px; cursor: pointer;
  font-size: 12px; font-family: inherit; background: #16263c; color: #9fb3cd;
}
.chip[aria-pressed="true"] { background: #1d5a63; color: #a8f3ea; }

/* ── 角色库网格 ── */
/* 列宽有上限：卡少的时候 1fr 会把两张卡拉成两张大脸 */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 180px)); gap: 12px; }
.card {
  position: relative; border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
  background: var(--panel); cursor: pointer; transition: border-color .14s, transform .14s;
}
.card:hover { border-color: #2f6f7a; transform: translateY(-2px); }
.cover {
  aspect-ratio: 3 / 4; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(160deg, #1b3452, #0f1d33); color: #6488b3; font-size: 34px;
}
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.card-name {
  padding: 8px 10px 2px; font-size: 13px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.card-tag {
  padding: 0 10px 9px; font-size: 11px; color: var(--muted); line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden;
}
.acts { position: absolute; top: 6px; right: 6px; display: none; gap: 4px; }
.card:hover .acts { display: flex; }
.acts button {
  border: 0; border-radius: 6px; padding: 3px 6px; font-size: 11px; font-family: inherit;
  background: #0a1526cc; color: #cfe0f4; cursor: pointer; backdrop-filter: blur(2px);
}
.acts button:hover { background: #1d4a5a; color: #a8f3ea; }
.empty { color: var(--muted); font-size: 13px; text-align: center; padding: 48px 10px; line-height: 1.9; }

/* ── 编辑页 / 人设页 ── */
.editor { flex: 1; min-height: 0; overflow-y: auto; padding: 0 22px 16px; }
.field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
.field > label { font-size: 11px; letter-spacing: .12em; color: var(--muted); }
.field input[type="text"], .field textarea, .greet textarea {
  width: 100%; background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  color: var(--text); padding: 8px 10px; font-size: 13px; line-height: 1.7; font-family: inherit;
  outline: none; resize: vertical;
}
.field input[type="text"]:focus, .field textarea:focus, .greet textarea:focus { border-color: #2f7f86; }
.field textarea { min-height: 72px; }
.hintline { font-size: 11px; color: var(--muted); line-height: 1.6; white-space: pre-line; }
.half { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.avatar-row { display: flex; gap: 14px; align-items: flex-start; }
.avatar-preview {
  width: 96px; height: 128px; flex: none; border-radius: 10px; overflow: hidden;
  border: 1px solid var(--line); background: linear-gradient(160deg, #1b3452, #0f1d33);
  display: flex; align-items: center; justify-content: center; color: #6488b3; font-size: 26px;
}
.avatar-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
.greet {
  display: flex; gap: 8px; align-items: flex-start; margin-bottom: 8px;
}
.greet textarea { flex: 1; min-height: 56px; }
.greet .order { display: flex; flex-direction: column; gap: 3px; }
.greet .order button {
  border: 1px solid var(--line); background: var(--panel); color: var(--muted);
  border-radius: 6px; width: 24px; height: 20px; font-size: 10px; cursor: pointer; padding: 0;
}
.greet .order button:hover { color: var(--cyan); border-color: #2f6f7a; }
.foot {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 12px 22px; border-top: 1px solid var(--line); background: #0b1526e6;
}
.foot .msg { flex: 1; font-size: 12px; color: var(--muted); }
.foot .msg.bad { color: var(--coral); }
.section-title {
  font-size: 11px; letter-spacing: .16em; color: var(--muted);
  margin: 20px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line);
}
.section-title:first-child { margin-top: 4px; }

/* ── 聊天页：小说流 ── */
.chat-page { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.chat-head {
  flex: none; display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-bottom: 1px solid var(--line); position: relative;
}
.chat-head .back {
  border: 0; background: transparent; color: var(--muted); cursor: pointer;
  font-size: 16px; padding: 2px 6px; border-radius: 6px;
}
.chat-head .back:hover { background: var(--panel-hi); color: var(--text); }
.chat-head .face {
  width: 32px; height: 32px; flex: none; border-radius: 9px; overflow: hidden;
  background: linear-gradient(160deg, #1d3350, #10203a); display: flex;
  align-items: center; justify-content: center; font-size: 14px; color: #6f93bd;
}
.chat-head .face img { width: 100%; height: 100%; object-fit: cover; display: block; }
.chat-head .who { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.chat-head .who .n { font-size: 14px; }
.chat-head .who .s { font-size: 11px; color: var(--muted); display: flex; align-items: center; gap: 5px; }
.online-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 6px var(--cyan); }
.chat-head .more {
  border: 0; background: transparent; color: var(--muted); cursor: pointer;
  font-size: 16px; padding: 2px 8px; border-radius: 6px;
}
.chat-head .more:hover { background: var(--panel-hi); color: var(--text); }
.menu {
  position: absolute; top: 46px; right: 10px; z-index: 5; width: 272px;
  background: var(--panel-hi); border: 1px solid var(--line); border-radius: 12px;
  padding: 8px 10px 12px; box-shadow: 0 14px 34px #0009;
}
.menu-title {
  font-size: 10px; letter-spacing: .16em; color: var(--muted);
  padding: 8px 2px 6px;
}
.menu-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.menu .cell {
  border: 1px solid var(--line); background: var(--panel); color: var(--text);
  font: inherit; font-size: 12px; padding: 8px 4px; border-radius: 8px; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.menu .cell:hover { background: #1d4a5a; border-color: #2f6f7a; color: #a8f3ea; }

.flow { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 26px 6px; }
.msg {
  margin-bottom: 18px; line-height: 1.95; font-size: var(--chat-font-size);
  word-break: break-word;
}
.msg .text { white-space: pre-wrap; color: var(--seg-narration); }
.msg .seg-dialogue { color: var(--seg-dialogue); }
.msg .seg-action { color: var(--seg-action); }
.msg.user { display: flex; justify-content: flex-end; }
.msg.user .bubble {
  max-width: 78%; white-space: pre-wrap;
  background: rgba(19, 42, 66, var(--bubble-alpha));
  border: 1px solid var(--line);
  padding: 9px 13px; border-radius: 12px 12px 3px 12px;
}
/* 群聊：每条回复开头的发言人（小立绘 + 名字） */
.msg-speaker { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
.msg-avatar {
  width: 22px; height: 22px; flex: none; border-radius: 50%; overflow: hidden;
  background: linear-gradient(160deg, #1d3350, #10203a);
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: #6f93bd;
}
.msg-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.msg-speaker-name { font-size: 12px; color: #7fd4c8; letter-spacing: .04em; }

.msg-cut { margin-top: 4px; font-size: 11px; color: var(--muted); opacity: .65; }
.msg .ops { display: none; gap: 6px; margin-top: 6px; }
.msg:hover .ops, .msg:focus-within .ops { display: flex; }
.msg.user .ops { justify-content: flex-end; }
.msg .ops button {
  border: 0; background: #16263c; color: #9fb3cd; border-radius: 6px;
  padding: 3px 8px; font-size: 11px; font-family: inherit; cursor: pointer;
}
.msg .ops button:hover { background: #1d4a5a; color: #a8f3ea; }
.msg .editor { display: flex; flex-direction: column; gap: 6px; }
.msg.user .editor { width: 78%; }
.msg .edit-ops { display: flex; gap: 6px; }
.msg .editor textarea {
  width: 100%; min-height: 90px; background: var(--panel); border: 1px solid var(--line);
  border-radius: 8px; color: var(--text); padding: 8px 10px; font: inherit; line-height: 1.7;
  resize: vertical; outline: none;
}
.msg .editor textarea:focus { border-color: #2f7f86; }
.branch-bar { display: flex; gap: 8px; align-items: center; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
.branch-bar button {
  border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; padding: 0 3px;
}
.branch-bar button:hover { color: var(--cyan); }
.typing::after { content: '▌'; color: var(--cyan); animation: tavern-blink 1s steps(2) infinite; }
@keyframes tavern-blink { 50% { opacity: 0; } }

.composer {
  flex: none; display: flex; gap: 8px; align-items: flex-end;
  padding: 10px 16px 14px; border-top: 1px solid var(--line); background: #0b1526e6;
}
.composer textarea {
  flex: 1; min-height: 44px; max-height: 150px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 10px; color: var(--text);
  padding: 10px 12px; font: inherit; line-height: 1.6; resize: none; outline: none;
}
.composer textarea:focus { border-color: #2f7f86; }
.composer .hint { flex: none; font-size: 11px; color: var(--muted); align-self: center; max-width: 42%; line-height: 1.5; }
.composer .hint.bad { color: var(--coral); }

/* ── 记忆面板（T3）── */
.chat-head .memory {
  border: 0; background: transparent; color: var(--muted); cursor: pointer;
  font-size: 12px; padding: 4px 8px; border-radius: 6px; letter-spacing: .06em;
}
.chat-head .memory:hover { background: var(--panel-hi); color: var(--cyan); }
.chat-head .memory.working { color: var(--cyan); animation: tavern-glow 1.6s ease-in-out infinite; }
@keyframes tavern-glow { 50% { opacity: .45; } }

.modal-mask {
  position: fixed; inset: 0; z-index: 40; background: #040a14cc;
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.modal {
  width: min(560px, 100%); max-height: 100%; display: flex; flex-direction: column;
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 24px 60px #000a;
}
.modal-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; }
.modal-title { font-size: 13px; letter-spacing: .16em; color: var(--text); }
.modal-close {
  border: 0; background: transparent; color: var(--muted); cursor: pointer;
  font-size: 14px; width: 26px; height: 26px; border-radius: 6px;
}
.modal-close:hover { background: var(--panel-hi); color: var(--text); }
.modal .notice { padding: 0 16px 8px; min-height: 0; }
.modal-body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 16px 20px; }
.settings-modal, .guide-modal { width: min(520px, 100%); }
.set-section {
  margin: 18px 0 6px; font-size: 11px; letter-spacing: .18em; color: var(--cyan);
}
.set-note { font-size: 12px; color: var(--muted); line-height: 1.7; margin: 6px 0; }
.set-note.bad { color: var(--coral); }
.set-actions { display: flex; gap: 8px; margin: 10px 0 4px; flex-wrap: wrap; }
.guide-text { font-size: 13px; color: var(--text); line-height: 1.9; white-space: pre-line; margin: 8px 0 4px; }
.about-help { font-size: 12px; color: var(--muted); line-height: 1.8; white-space: pre-line; margin: 6px 0; }
.toast {
  position: fixed; left: 50%; bottom: 64px; transform: translateX(-50%); z-index: 30;
  max-width: min(520px, calc(100% - 48px)); padding: 9px 16px; border-radius: 999px;
  background: var(--panel-hi); border: 1px solid var(--line); color: var(--text);
  font-size: 12px; line-height: 1.6; box-shadow: 0 10px 30px #0007;
}
html[data-theme="light"] .toast { box-shadow: 0 10px 30px #7d8ca344; }
.set-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.set-label { font-size: 12px; color: #9fb3cd; min-width: 92px; }
.set-value { font-size: 12px; color: var(--muted); width: 52px; text-align: right; }
.slider { flex: 1; accent-color: var(--cyan); height: 3px; }
.switch {
  border: 1px solid var(--line); background: var(--panel-hi); color: var(--muted);
  border-radius: 999px; padding: 3px 12px; font-size: 11px; font-family: inherit; cursor: pointer;
}
.switch.on { background: #10333c; border-color: #2f7f86; color: #8ef0e6; }
.mem-list { margin: 8px 0 4px; display: flex; flex-direction: column; gap: 6px; }
.mem-row { display: flex; gap: 6px; align-items: flex-start; flex-wrap: wrap; }
.mem-row textarea {
  flex: 1; min-width: 200px; background: #0b1526; border: 1px solid var(--line); border-radius: 8px;
  color: var(--text); padding: 7px 9px; font: inherit; font-size: 12px; line-height: 1.6;
  resize: vertical; outline: none;
}
.mem-row textarea:focus { border-color: #2f7f86; }
.mem-ops { display: flex; gap: 4px; }
.dossier-view {
  white-space: pre-wrap; font-size: 12px; line-height: 1.8; color: #b9cde3;
  background: #0b1526; border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px;
}

/* ── 提示词工具（T4）：世界书 / 正则 / 预设 / 文风 / 回复 / 状态栏 ── */
.prompt-modal { width: min(760px, 100%); }
.prompt-tabs { display: flex; gap: 6px; padding: 0 16px 10px; flex-wrap: wrap; }
.prompt-tabs button {
  border: 1px solid var(--line); background: transparent; color: var(--muted);
  border-radius: 999px; padding: 4px 12px; font: inherit; font-size: 12px; cursor: pointer;
}
.prompt-tabs button:hover { background: var(--panel-hi); color: var(--text); }
.prompt-tabs button[aria-pressed="true"] { background: #10333c; border-color: #2f7f86; color: #8ef0e6; }
.panel-list { display: flex; flex-direction: column; gap: 6px; margin: 6px 0 10px; }
.panel-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 4px 0; }
.panel-item {
  border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px;
  display: flex; flex-direction: column; gap: 6px; background: #0b1526;
}
.panel-name { font-size: 12px; color: var(--text); }
.panel-row input[type="text"],
.panel-row select {
  background: #0b1526; border: 1px solid var(--line); border-radius: 6px;
  color: var(--text); padding: 4px 7px; font: inherit; font-size: 12px;
  outline: none; min-width: 0; flex: 1;
}
.panel-row input[type="number"] {
  background: #0b1526; border: 1px solid var(--line); border-radius: 6px;
  color: var(--text); padding: 4px 7px; font: inherit; font-size: 12px; outline: none;
}
.panel-item textarea {
  background: #0b1526; border: 1px solid var(--line); border-radius: 6px;
  color: var(--text); padding: 6px 8px; font: inherit; font-size: 12px;
  line-height: 1.6; resize: vertical; outline: none;
}
.panel-row input:focus,
.panel-row select:focus,
.panel-item textarea:focus { border-color: #2f7f86; }
.panel-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 6px 14px; align-items: center; }
.panel-cell { display: none; }
.hintline.bad { color: var(--coral); }
.notice.bad { color: var(--coral); }

/* 聊天页顶部状态条（世界书 / 变量系统给的状态） */
.chat-status {
  flex: none; display: flex; gap: 12px; flex-wrap: wrap; padding: 6px 14px;
  border-bottom: 1px solid var(--line); background: #0a1424;
  font-size: 11px; color: var(--cyan); letter-spacing: .04em;
  /* 变量多的卡别把这条撑成半屏：超了就在条里滚 */
  max-height: 66px; overflow-y: auto;
}
.chat-status:empty { display: none; }
.world-card {
  font-size: 10px; color: var(--cyan); border: 1px solid #2f5f6a;
  border-radius: 999px; padding: 1px 7px; margin-left: 6px;
}
/* 本场模型：flash（默认）与 pro（复杂卡） */
.model-badge {
  font-size: 10px; color: var(--muted); border: 1px solid #2c4460;
  border-radius: 999px; padding: 1px 7px; margin-left: 6px; letter-spacing: .5px;
}
.model-badge.pro { color: #ffd28a; border-color: #6a5230; }

/* 心动接话：输入框上方的可选回复 */
.alts { flex: none; display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 14px 0; }
.alts:empty { display: none; }
.alts button {
  border: 1px solid var(--line); background: #0b1526; color: #b9cde3;
  border-radius: 999px; padding: 4px 12px; font: inherit; font-size: 12px;
  cursor: pointer; text-align: left; max-width: 100%;
}
.alts button:hover { border-color: #2f7f86; color: #a8f3ea; }

/* 卡里的状态栏页面（html 围栏）：沙箱 iframe，高度由页面自己报上来 */
.rich-frame { margin: 8px 0; border-radius: 12px; overflow: hidden; background: #0b1526; }
.rich-frame iframe { display: block; width: 100%; border: 0; background: transparent; }
.frame-error {
  margin: 6px 0 0; padding: 6px 9px; border-radius: 8px; font-size: 11px; line-height: 1.7;
  color: #e6b273; background: #2a1c0e; border: 1px solid #6b4a22; word-break: break-all;
}
.rich-code {
  margin: 8px 0; padding: 9px 11px; background: #081020; border: 1px solid var(--line);
  border-radius: 8px; font-size: 11px; line-height: 1.6; overflow-x: auto; white-space: pre;
  color: #9fb3cd;
}

/* 开场白选择：第一次进卡、以及「重开一场」 */
.pick-list { display: flex; flex-direction: column; gap: 8px; }
.pick-item {
  text-align: left; border: 1px solid var(--line); background: #0b1526; color: #b9cde3;
  border-radius: 10px; padding: 10px 12px; font: inherit; font-size: 12px; line-height: 1.8;
  cursor: pointer; white-space: pre-wrap; max-height: 190px; overflow-y: auto;
}
.pick-item:hover { border-color: #2f7f86; color: #dff7f3; }
.pick-item .pick-title { font-size: 11px; color: var(--cyan); letter-spacing: .1em; display: block; margin-bottom: 4px; }

/* 新建群聊：多选列表（复用 pick-item，改成一行一个角色的横排） */
.group-pick { display: flex; align-items: center; gap: 9px; max-height: none; overflow: visible; }
.group-pick .pick-avatar {
  width: 30px; height: 30px; flex: none; border-radius: 8px; overflow: hidden;
  background: linear-gradient(160deg, #1d3350, #10203a);
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; color: #6f93bd;
}
.group-pick .pick-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.group-pick .pick-text { min-width: 0; flex: 1; }
.group-pick .pick-name { font-size: 13px; color: #dff7f3; }
.group-pick .pick-sub { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.group-pick .pick-check { opacity: 0; color: var(--cyan); font-size: 13px; }
.group-pick[data-picked="true"] { border-color: #2f6f7a; background: #122e38; }
.group-pick[data-picked="true"] .pick-check { opacity: 1; }

/* 深色细滚动条：原生白条在深底上太扎眼 */
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #24374f; border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: #31506f; }

/* ── 浅色主题：深海夜航 → 浅海晨光 ── */
/* 只覆盖颜色，不动布局；深色主题的原规则一行没改 */
html[data-theme="light"] {
  --abyss: #eef2f7;
  --panel: #ffffff;
  --panel-hi: #f1f5fa;
  --line: #d7e0ec;
  --cyan: #0f8b80;
  --coral: #c9435a;
  --text: #1f2a38;
  --muted: #66788c;
}
html[data-theme="light"] body {
  background:
    radial-gradient(1200px 700px at 15% -10%, #dbe7f5 0%, transparent 60%),
    radial-gradient(900px 600px at 95% 110%, #e7e3f2 0%, transparent 55%),
    var(--abyss);
}
html[data-theme="light"] .close:hover { background: #ff5f6d22; }
html[data-theme="light"] .col-left,
html[data-theme="light"] .col-right { background: #ffffffcc; }
html[data-theme="light"] .left-item:hover { background: #eef3fa; }
html[data-theme="light"] .left-item[aria-current="true"] { background: #dff2f0; border-color: #8fc9c3; }
html[data-theme="light"] .left-avatar,
html[data-theme="light"] .cover,
html[data-theme="light"] .avatar-preview,
html[data-theme="light"] .chat-head .face {
  background: linear-gradient(160deg, #e3ebf6, #f3f6fb); color: #7d8ca3;
}
html[data-theme="light"] .btn:hover { border-color: #b9c8dc; }
html[data-theme="light"] .btn.primary { background: #d9f2ef; border-color: #8fc9c3; color: #0d6f66; }
html[data-theme="light"] .btn.primary:hover { background: #c9ebe7; }
html[data-theme="light"] .btn.danger:hover { background: #fde8ec; border-color: #e3a6b2; }
html[data-theme="light"] .search::placeholder { color: #9aa8ba; }
html[data-theme="light"] .chip { background: #e8eef7; color: #4a5c72; }
html[data-theme="light"] .chip[aria-pressed="true"] { background: #c9ebe7; color: #0d6f66; }
html[data-theme="light"] .acts button { background: #ffffffdd; color: #3a4a5e; }
html[data-theme="light"] .acts button:hover { background: #d9f2ef; color: #0d6f66; }
html[data-theme="light"] .foot,
html[data-theme="light"] .composer { background: #f6f9fce6; }
html[data-theme="light"] .notice { color: var(--muted); }
html[data-theme="light"] .menu .cell:hover,
html[data-theme="light"] .msg .ops button:hover {
  background: #d9f2ef; border-color: #8fc9c3; color: #0d6f66;
}
html[data-theme="light"] .msg .ops button { background: #e8eef7; color: #4a5c72; }
html[data-theme="light"] .msg.user .bubble { background: rgba(210, 228, 246, var(--bubble-alpha)); }
html[data-theme="light"] .chat-status { background: #f2f6fb; }
html[data-theme="light"] .world-card { border-color: #8fc9c3; }
html[data-theme="light"] .model-badge { border-color: #c3cfdf; color: #66788c; }
html[data-theme="light"] .model-badge.pro { color: #a06a12; border-color: #e0c48a; }
html[data-theme="light"] .alts button { background: #ffffff; color: #3a4a5e; }
html[data-theme="light"] .alts button:hover { border-color: #8fc9c3; color: #0d6f66; }
html[data-theme="light"] .spec-chips button,
html[data-theme="light"] .spec-msg.user { background: #ffffff; color: #3a4a5e; }
html[data-theme="light"] .spec-chips button:hover { border-color: #8fc9c3; color: #0d6f66; }
html[data-theme="light"] .spec-composer textarea { background: #f7fafd; }
html[data-theme="light"] .rich-frame { background: #f6f9fc; }
html[data-theme="light"] .rich-code { background: #f2f6fb; color: #4a5c72; }
html[data-theme="light"] .pick-item { background: #ffffff; color: #3a4a5e; }
html[data-theme="light"] .pick-item:hover { border-color: #8fc9c3; color: #1f2a38; }
html[data-theme="light"] .group-pick .pick-name { color: #1f2a38; }
html[data-theme="light"] .group-pick[data-picked="true"] { background: #dff2f0; border-color: #8fc9c3; }
html[data-theme="light"] .group-pick .pick-avatar,
html[data-theme="light"] .msg-avatar { background: linear-gradient(160deg, #e3ebf6, #f3f6fb); color: #7d8ca3; }
html[data-theme="light"] .left-avatar.group-avatar { color: #0d6f66; }
html[data-theme="light"] .msg-speaker-name { color: #0f8b80; }
html[data-theme="light"] .modal-mask { background: #1f2a3840; }
html[data-theme="light"] .modal { box-shadow: 0 24px 60px #7d8ca344; }
html[data-theme="light"] .mem-row textarea,
html[data-theme="light"] .dossier-view,
html[data-theme="light"] .panel-item,
html[data-theme="light"] .panel-row input[type="text"],
html[data-theme="light"] .panel-row input[type="number"],
html[data-theme="light"] .panel-row select,
html[data-theme="light"] .panel-item textarea { background: #f7fafd; }
html[data-theme="light"] .dossier-view { color: #3a4a5e; }
html[data-theme="light"] .set-label { color: #4a5c72; }
html[data-theme="light"] .mem-row textarea:focus,
html[data-theme="light"] .panel-row input:focus,
html[data-theme="light"] .panel-row select:focus,
html[data-theme="light"] .panel-item textarea:focus { border-color: #8fc9c3; }
html[data-theme="light"] .switch { background: #eef3fa; }
html[data-theme="light"] .switch.on,
html[data-theme="light"] .prompt-tabs button[aria-pressed="true"] {
  background: #d9f2ef; border-color: #8fc9c3; color: #0d6f66;
}
html[data-theme="light"] .tabs { background: #f6f9fc; }
html[data-theme="light"] ::-webkit-scrollbar-thumb { background: #c8d4e3; }
html[data-theme="light"] ::-webkit-scrollbar-thumb:hover { background: #aebdd0; }

/* 窄屏：右栏先收起，再窄就变单栏 + 底部切换 */
@media (max-width: 1080px) {
  .body { grid-template-columns: 240px 1fr; }
  .col-right { display: none; }
}
.tabs { display: none; }
@media (max-width: 720px) {
  .body { grid-template-columns: 1fr; }
  .col-left { display: none; }
  #tavern[data-view="list"] .col-left { display: flex; }
  #tavern[data-view="list"] .col-main { display: none; }
  .tabs {
    display: flex; flex: none; border-top: 1px solid var(--line); background: #0b1526;
  }
  .tabs button {
    flex: 1; padding: 11px 0; border: 0; background: transparent; cursor: pointer;
    font-size: 12px; color: var(--muted); letter-spacing: .1em;
  }
  .tabs button[aria-selected="true"] { color: var(--cyan); }
}
`

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// 类型直接从 preload 暴露的 window.tavern 反推，免得和主进程的定义各写一份、迟早走样
export type TavernApi = Window['tavern']
export type CardSummary = Awaited<ReturnType<TavernApi['cardsList']>>['items'][number]
export type TavernCard = NonNullable<Awaited<ReturnType<TavernApi['cardsGet']>>>
export type CardInput = Parameters<TavernApi['cardsSave']>[0]
export type ImportOutcome = Awaited<ReturnType<TavernApi['cardsImport']>>[number]
export type UserProfile = Awaited<ReturnType<TavernApi['profileGet']>>
export type ChatView = NonNullable<Awaited<ReturnType<TavernApi['chatOpen']>>>
export type ChatMessageNode = ChatView['messages'][number]

/** 立绘文件名 → <img src>。主进程按 uuid 文件名放行 avatars/ 下的文件。 */
export function avatarUrl(fileName: string): string {
  return `tavern-avatar://local/${encodeURIComponent(fileName)}`
}

/** 卡片的封面元素：有立绘就显示图，没有就用名字首字占位 */
export function cover(className: string, avatarPath: string | null, name: string): HTMLElement {
  const node = h('div', className)
  if (avatarPath) {
    const image = h('img')
    image.src = avatarUrl(avatarPath)
    image.draggable = false
    node.append(image)
  } else {
    node.textContent = name.trim().slice(0, 1) || '·'
  }
  return node
}
