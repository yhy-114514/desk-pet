-- 每场会话可以单独选模型：简单卡用 flash，几百条世界书 + 变量系统的复杂卡用 pro。
-- 空 = 没选过，跟随全局 config.model。
ALTER TABLE chats ADD COLUMN model TEXT;
