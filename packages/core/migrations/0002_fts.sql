-- 派生全文索引：内容是 core 的 segment() 切分后的文本，按 id 关联 memories。
-- 整表可随时删除重建（npm run fts:rebuild），流水账本身不受影响。
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- 派生数据的状态登记（重建时所用的切分版本、时间、行数）。
CREATE TABLE IF NOT EXISTS derived_state (
  name     TEXT    PRIMARY KEY NOT NULL,
  version  INTEGER NOT NULL,
  built_at TEXT    NOT NULL,
  rows     INTEGER NOT NULL
);
