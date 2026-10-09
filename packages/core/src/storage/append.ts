/**
 * 幂等追加：以 `id` 为主键，"若不存在则插入"。
 *
 * 既有记录永不被覆盖：重复请求不会改写首次写入的 `meta` 与 `received_at`。
 */

import type { Client } from '@libsql/client';
import { segment } from '../fts.ts';
import type { MemoryRecord } from '../record.ts';

/** 追加结果。`created` 为 false 表示该 `id` 已存在（幂等命中）。 */
export interface AppendResult {
  id: string;
  created: boolean;
}

const INSERT_SQL = `INSERT INTO memories (id, ts, author, kind, content, meta, received_at, schema_v)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO NOTHING`;

/** 仅当上一条语句真的新增了记录时才写索引（幂等命中时 `changes()` 为 0）。 */
const INSERT_FTS_SQL = 'INSERT INTO memories_fts (id, body) SELECT ?, ? WHERE changes() = 1';

/**
 * 追加一条记录，返回是否为新写入。
 * 记录与它的全文索引条目在同一个写事务里写入：要么都写入，要么都不写入。
 */
export async function appendMemory(client: Client, record: MemoryRecord): Promise<AppendResult> {
  const [inserted] = await client.batch(
    [
      {
        sql: INSERT_SQL,
        args: [
          record.id,
          record.ts,
          record.author,
          record.kind,
          record.content,
          JSON.stringify(record.meta),
          record.received_at,
          record.schema_v,
        ],
      },
      { sql: INSERT_FTS_SQL, args: [record.id, segment(record.content)] },
    ],
    'write',
  );
  return { id: record.id, created: (inserted?.rowsAffected ?? 0) > 0 };
}

/** 按 `id` 读取一条记录；不存在时返回 null。 */
export async function getMemory(client: Client, id: string): Promise<MemoryRecord | null> {
  const result = await client.execute({
    sql: 'SELECT id, ts, author, kind, content, meta, received_at, schema_v FROM memories WHERE id = ?',
    args: [id],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row['id']),
    ts: String(row['ts']),
    author: String(row['author']),
    kind: String(row['kind']),
    content: String(row['content']),
    meta: JSON.parse(String(row['meta'])) as MemoryRecord['meta'],
    received_at: String(row['received_at']),
    schema_v: Number(row['schema_v']),
  };
}

/** 统计记录条数（测试与冒烟验证用）。 */
export async function countMemories(client: Client): Promise<number> {
  const result = await client.execute('SELECT COUNT(*) AS n FROM memories');
  return Number(result.rows[0]?.['n'] ?? 0);
}
