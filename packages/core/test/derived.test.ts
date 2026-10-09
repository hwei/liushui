import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FTS_SEGMENTER_V } from '../src/fts.ts';
import { checkFts, rebuildDerived } from '../src/storage/index.ts';
import { loadMigrations } from '../src/storage/load-migrations.ts';
import { runMigrations } from '../src/storage/migrate.ts';
import { createTempDb, type TempDb } from './helpers.ts';

describe('rebuildDerived (task 3.1)', () => {
  let db: TempDb;
  beforeEach(async () => {
    db = createTempDb();
    await runMigrations(db.client, loadMigrations());
  });
  afterEach(async () => {
    await db.cleanup();
  });

  it('对载入的 memories 调用后 checkFts 全部通过，返回值含 memories_fts 与 FTS_SEGMENTER_V', async () => {
    // 写入测试数据（绕过索引维护直接插入 memories）
    await db.client.execute({
      sql: `INSERT INTO memories (id, ts, author, kind, content, meta, received_at, schema_v)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        'TESTMEM111111111111111111',
        '2026-10-08T07:47:08.479Z',
        'will',
        'note',
        'iOS 渲染故障排查记录',
        '{}',
        '2026-10-08T07:47:09.000Z',
        1,
      ],
    });
    await db.client.execute({
      sql: `INSERT INTO memories (id, ts, author, kind, content, meta, received_at, schema_v)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        'TESTMEM222222222222222222',
        '2026-10-08T07:47:18.479Z',
        'will',
        'note',
        '关于 Metal 着色器的优化建议',
        '{}',
        '2026-10-08T07:47:19.000Z',
        1,
      ],
    });

    // 此时尚未建立索引，checkFts 应报告缺失
    const beforeCheck = await checkFts(db.client);
    expect(beforeCheck.ok).toBe(false);
    expect(beforeCheck.missing).toBe(2);

    // 调用 rebuildDerived
    const reports = await rebuildDerived(db.client);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      name: 'memories_fts',
      version: FTS_SEGMENTER_V,
      rows: 2,
    });

    // checkFts 全部通过
    const afterCheck = await checkFts(db.client);
    expect(afterCheck.ok).toBe(true);
    expect(afterCheck.memories).toBe(2);
    expect(afterCheck.indexed).toBe(2);
    expect(afterCheck.missing).toBe(0);
    expect(afterCheck.extra).toBe(0);
    expect(afterCheck.duplicates).toBe(0);
    expect(afterCheck.version.ok).toBe(true);
    expect(afterCheck.version.current).toBe(FTS_SEGMENTER_V);
  });
});
