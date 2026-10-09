/**
 * 派生全文索引 `memories_fts` 的整体重建与一致性检查。
 *
 * 索引是 `memories` 的派生数据：可随时整表重建，重建不改动流水账。
 * 追加时的同事务维护见 `append.ts`。
 */

import type { Client, InStatement } from '@libsql/client';

import { FTS_SEGMENTER_V, segment } from '../fts.ts';

/** `derived_state` 中登记全文索引用的名字。 */
export const FTS_STATE_NAME = 'memories_fts';

const PAGE_SIZE = 500;

/** 重建结果。 */
export interface RebuildFtsResult {
  rows: number;
  version: number;
}

/** 一致性检查结果；`ok` 表示缺失、多余、重复都为 0 且切分版本一致。 */
export interface FtsCheckResult {
  memories: number;
  indexed: number;
  missing: number;
  extra: number;
  duplicates: number;
  /** `recorded` 为 null 表示从未重建。 */
  version: { recorded: number | null; current: number; ok: boolean };
  ok: boolean;
}

/**
 * 在一个写事务里整体重建索引：清空 → 按 `id` 分页重新切分写入 → 登记 `derived_state`。
 * 事务期间并发的追加会等待，不会产生重复或遗漏。
 */
export async function rebuildFts(client: Client): Promise<RebuildFtsResult> {
  const tx = await client.transaction('write');
  try {
    await tx.execute('DELETE FROM memories_fts');
    let rows = 0;
    let after = '';
    for (;;) {
      const page = await tx.execute({
        sql: 'SELECT id, content FROM memories WHERE id > ? ORDER BY id LIMIT ?',
        args: [after, PAGE_SIZE],
      });
      if (page.rows.length === 0) break;
      const statements: InStatement[] = page.rows.map((row) => ({
        sql: 'INSERT INTO memories_fts (id, body) VALUES (?, ?)',
        args: [String(row['id']), segment(String(row['content']))],
      }));
      await tx.batch(statements);
      rows += page.rows.length;
      after = String(page.rows[page.rows.length - 1]!['id']);
    }
    await tx.execute({
      sql: `INSERT INTO derived_state (name, version, built_at, rows) VALUES (?, ?, ?, ?)
ON CONFLICT(name) DO UPDATE SET version = excluded.version, built_at = excluded.built_at, rows = excluded.rows`,
      args: [FTS_STATE_NAME, FTS_SEGMENTER_V, new Date().toISOString(), rows],
    });
    await tx.commit();
    return { rows, version: FTS_SEGMENTER_V };
  } catch (error) {
    await tx.rollback().catch(() => undefined);
    throw error;
  } finally {
    tx.close();
  }
}

async function count(client: Client, sql: string): Promise<number> {
  const result = await client.execute(sql);
  return Number(result.rows[0]?.['n'] ?? 0);
}

/** 只读检查索引与 `memories` 是否一致。 */
export async function checkFts(client: Client): Promise<FtsCheckResult> {
  const memories = await count(client, 'SELECT COUNT(*) AS n FROM memories');
  const indexed = await count(client, 'SELECT COUNT(*) AS n FROM memories_fts');
  const missing = await count(
    client,
    'SELECT COUNT(*) AS n FROM (SELECT id FROM memories EXCEPT SELECT id FROM memories_fts)',
  );
  const extra = await count(
    client,
    'SELECT COUNT(*) AS n FROM (SELECT id FROM memories_fts EXCEPT SELECT id FROM memories)',
  );
  const duplicates = await count(
    client,
    'SELECT COUNT(*) - COUNT(DISTINCT id) AS n FROM memories_fts',
  );
  const state = await client.execute({
    sql: 'SELECT version FROM derived_state WHERE name = ?',
    args: [FTS_STATE_NAME],
  });
  const recordedRaw = state.rows[0]?.['version'];
  const recorded = recordedRaw === undefined ? null : Number(recordedRaw);
  const versionOk = recorded === FTS_SEGMENTER_V;
  return {
    memories,
    indexed,
    missing,
    extra,
    duplicates,
    version: { recorded, current: FTS_SEGMENTER_V, ok: versionOk },
    ok: missing === 0 && extra === 0 && duplicates === 0 && versionOk,
  };
}
