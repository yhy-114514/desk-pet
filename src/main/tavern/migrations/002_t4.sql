-- T4：世界书条目补齐「选择性」与展示名两列。
-- 000_init.sql 里 lorebook_entries 只建了 keys / secondary_keys / content 等，
-- 少了 ST 的 selective 开关与条目的 comment（展示名）；已发出的迁移不能改，只能追加。

ALTER TABLE lorebook_entries ADD COLUMN selective INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lorebook_entries ADD COLUMN name TEXT NOT NULL DEFAULT '';
