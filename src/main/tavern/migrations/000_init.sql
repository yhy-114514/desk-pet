-- 酒馆初始 schema（T0）。
-- 之后的结构变更一律新增 001_xxx.sql，不要再改这个文件——已发出的版本可能已经执行过。

-- 角色卡（SillyTavern v2 字段映射）
CREATE TABLE IF NOT EXISTS characters (
  id                        TEXT PRIMARY KEY,
  name                      TEXT    NOT NULL,
  description               TEXT    NOT NULL DEFAULT '',
  personality               TEXT    NOT NULL DEFAULT '',
  scenario                  TEXT    NOT NULL DEFAULT '',
  first_mes                 TEXT    NOT NULL DEFAULT '',
  alternate_greetings       TEXT    NOT NULL DEFAULT '[]', -- JSON 字符串数组
  mes_example               TEXT    NOT NULL DEFAULT '',
  system_prompt             TEXT    NOT NULL DEFAULT '',
  post_history_instructions TEXT    NOT NULL DEFAULT '',
  creator                   TEXT    NOT NULL DEFAULT '',
  creator_notes             TEXT    NOT NULL DEFAULT '',
  tags                      TEXT    NOT NULL DEFAULT '[]', -- JSON 字符串数组
  avatar_path               TEXT,                          -- userData/tavern/avatars/ 下的文件名
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  deleted_at                INTEGER                          -- 非空 = 软删（清空后可恢复）
);

-- 预设（生成参数 + 提示词顺序）
CREATE TABLE IF NOT EXISTS presets (
  id         TEXT PRIMARY KEY,
  name       TEXT    NOT NULL,
  data       TEXT    NOT NULL DEFAULT '{}', -- JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS preset_entries (
  id          TEXT PRIMARY KEY,
  preset_id   TEXT    NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  role        TEXT    NOT NULL DEFAULT 'system',
  content     TEXT    NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  order_index INTEGER NOT NULL DEFAULT 0
);

-- 会话。messages 从第一天就是消息树，parent_id 是分支的根
CREATE TABLE IF NOT EXISTS chats (
  id           TEXT PRIMARY KEY,
  character_id TEXT    NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL DEFAULT '',
  preset_id    TEXT REFERENCES presets(id),
  is_group     INTEGER NOT NULL DEFAULT 0,
  settings     TEXT    NOT NULL DEFAULT '{}', -- JSON（会话级外观 / 回复设置覆盖）
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT    NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  parent_id    TEXT REFERENCES messages(id) ON DELETE CASCADE,
  branch_index INTEGER NOT NULL DEFAULT 0, -- 同父多分支时的排序（重生成 / 编辑后分叉）
  role         TEXT    NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content      TEXT    NOT NULL DEFAULT '',
  is_deleted   INTEGER NOT NULL DEFAULT 0,
  token_count  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages (parent_id, branch_index);

-- 摘要 / 忆境典藏（鲸鱼娘侧叫「观测档案」，同一张表）
CREATE TABLE IF NOT EXISTS chat_summaries (
  id              TEXT PRIMARY KEY,
  chat_id         TEXT    NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  from_message_id TEXT,
  to_message_id   TEXT,
  dossier         TEXT    NOT NULL DEFAULT '{}', -- JSON
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_summaries_chat ON chat_summaries (chat_id, created_at);

-- per-角色 / per-会话的永久记忆（鲸鱼娘自己的 memory.json 不动，这是另一套）
CREATE TABLE IF NOT EXISTS memories (
  id           TEXT PRIMARY KEY,
  scope        TEXT    NOT NULL CHECK (scope IN ('global', 'character', 'chat')),
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  chat_id      TEXT REFERENCES chats(id) ON DELETE CASCADE,
  type         TEXT    NOT NULL DEFAULT 'other',
  content      TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope, character_id, chat_id);

-- 记忆向量：h = 内容指纹（换模型 / 改文本即失效），v = float32 小端字节序
CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  h         TEXT NOT NULL,
  v         BLOB NOT NULL
);

-- 世界书：三层（global / character / chat）
CREATE TABLE IF NOT EXISTS lorebooks (
  id           TEXT PRIMARY KEY,
  scope        TEXT    NOT NULL CHECK (scope IN ('global', 'character', 'chat')),
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  chat_id      TEXT REFERENCES chats(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL DEFAULT '',
  description  TEXT    NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lorebook_entries (
  id              TEXT PRIMARY KEY,
  lorebook_id     TEXT    NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
  keys            TEXT    NOT NULL DEFAULT '[]', -- JSON 字符串数组
  secondary_keys  TEXT    NOT NULL DEFAULT '[]', -- JSON 字符串数组
  content         TEXT    NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  constant        INTEGER NOT NULL DEFAULT 0, -- 1 = 常驻，不靠关键词触发
  position        TEXT    NOT NULL DEFAULT 'before_char',
  depth           INTEGER NOT NULL DEFAULT 4,
  order_index     INTEGER NOT NULL DEFAULT 0,
  case_sensitive  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lorebook_entries_book ON lorebook_entries (lorebook_id, order_index);

-- 正则清洗（显示 / 提示词两条链路各一套）
CREATE TABLE IF NOT EXISTS regexes (
  id           TEXT PRIMARY KEY,
  scope        TEXT    NOT NULL CHECK (scope IN ('global', 'character')),
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL DEFAULT '',
  pattern      TEXT    NOT NULL,
  replacement  TEXT    NOT NULL DEFAULT '',
  flags        TEXT    NOT NULL DEFAULT 'g',
  target       TEXT    NOT NULL DEFAULT 'display', -- display / prompt
  enabled      INTEGER NOT NULL DEFAULT 1,
  order_index  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- 状态栏（角色卡上的动态数值）
CREATE TABLE IF NOT EXISTS status_bars (
  id           TEXT PRIMARY KEY,
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS status_items (
  id          TEXT PRIMARY KEY,
  bar_id      TEXT    NOT NULL REFERENCES status_bars(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL DEFAULT '',
  value       INTEGER NOT NULL DEFAULT 0,
  max_value   INTEGER NOT NULL DEFAULT 100,
  order_index INTEGER NOT NULL DEFAULT 0
);

-- 全局设置（外观 / 通用 / 回复参数），值是 JSON
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
