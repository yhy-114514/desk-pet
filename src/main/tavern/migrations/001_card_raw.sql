-- T1 补：保留整份 ST 卡的 data 对象。
-- characters 表里的 12 个类型化字段只是「摘要视图」，供列表与编辑用；
-- 世界书（character_book）、正则与脚本（extensions）、群聊开场白（group_only_greetings）
-- 这些编辑页不管的部分全在这个 JSON 里，导出时原样写回，否则导出的是一张残卡。
ALTER TABLE characters ADD COLUMN data_json TEXT;
