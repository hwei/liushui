-- 0001_init：记忆流水账的初始 schema。
--
-- 只追加：迁移只允许新增列或表，不允许改写既有记录。
-- meta 存为 JSON 文本（嵌套对象），因此 json_extract(meta, '$.git.branch') 可直接使用，
-- 且新增 meta 键无需迁移。

CREATE TABLE IF NOT EXISTS memories (
  id          TEXT    PRIMARY KEY NOT NULL,
  ts          TEXT    NOT NULL,
  author      TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  meta        TEXT    NOT NULL DEFAULT '{}',
  received_at TEXT    NOT NULL,
  schema_v    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_ts ON memories (ts);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories (kind);
