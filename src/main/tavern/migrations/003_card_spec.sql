-- 记住导入的卡是 v2 还是 v3（spec / spec_version 那两行）。
-- 导出时原来固定写 chara_card_v2：v3 卡导回去就成了降级标注，
-- v3 才有的能力（assets 立绘资源、nickname 之类）在 ST 那边不再生效。
-- 空 = 没记过（新建的卡），导出仍按 v2 写。
ALTER TABLE characters ADD COLUMN spec TEXT;
ALTER TABLE characters ADD COLUMN spec_version TEXT;
