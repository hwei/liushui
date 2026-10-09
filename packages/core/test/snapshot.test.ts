import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ValidationError } from '../src/errors.ts';
import { exportSnapshot, readSnapshot, type SnapshotWriter } from '../src/storage/index.ts';
import { loadMigrations } from '../src/storage/load-migrations.ts';
import { runMigrations } from '../src/storage/migrate.ts';
import { createTempDb, type TempDb } from './helpers.ts';

describe('快照读写 (task 3.2)', () => {
  let db: TempDb;
  const tempFiles: string[] = [];

  const createTempFile = (content = ''): string => {
    const p = join(tmpdir(), `test-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(p, content, 'utf8');
    tempFiles.push(p);
    return p;
  };

  beforeEach(async () => {
    db = createTempDb();
    await runMigrations(db.client, loadMigrations());
  });

  afterEach(async () => {
    await db.cleanup();
    for (const f of tempFiles) {
      try {
        unlinkSync(f);
      } catch {
        // ignore
      }
    }
  });

  it('单测用本地文件库写入含中文、多行内容、嵌套 meta 的记录，导出再读回后逐字段相等（meta 原文相等）', async () => {
    const rawMeta = JSON.stringify({
      author: { name: '张三', role: 'admin' },
      env: 'dev',
      tags: { level: 1, active: true },
    });
    const multiLineContent = '第一行内容\n第二行内容\r\n第三行带有"双引号"和\'单引号\'以及\t制表符';

    await db.client.execute({
      sql: `INSERT INTO memories (id, ts, author, kind, content, meta, received_at, schema_v)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        'SNAPSHOT000000000000000001',
        '2026-10-08T07:47:08.479Z',
        'will',
        'note',
        multiLineContent,
        rawMeta,
        '2026-10-08T07:47:09.000Z',
        1,
      ],
    });

    await db.client.execute({
      sql: `INSERT INTO memories (id, ts, author, kind, content, meta, received_at, schema_v)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        'SNAPSHOT000000000000000002',
        '2026-10-08T08:00:00.000Z',
        'alice',
        'retrieval_feedback',
        '{"v":1,"intent":"测试"}',
        '{}',
        '2026-10-08T08:00:01.000Z',
        1,
      ],
    });

    const lines: string[] = [];
    const writer: SnapshotWriter = {
      writeLine: (l) => {
        lines.push(l);
      },
    };

    const header = await exportSnapshot(db.client, writer);
    expect(header.liushui_snapshot).toBe(1);
    expect(header.rows).toBe(2);
    expect(header.schema_versions).toContain(1);
    expect(lines).toHaveLength(3); // 1 header + 2 rows

    const filePath = createTempFile(lines.join('\n') + '\n');
    const readResult = readSnapshot(filePath);

    expect(readResult.header).toEqual(header);
    expect(readResult.rows).toHaveLength(2);

    const first = readResult.rows[0]!;
    expect(first.id).toBe('SNAPSHOT000000000000000001');
    expect(first.ts).toBe('2026-10-08T07:47:08.479Z');
    expect(first.author).toBe('will');
    expect(first.kind).toBe('note');
    expect(first.content).toBe(multiLineContent);
    expect(first.meta).toBe(rawMeta); // meta 原文严格相等
    expect(first.received_at).toBe('2026-10-08T07:47:09.000Z');
    expect(first.schema_v).toBe(1);

    const second = readResult.rows[1]!;
    expect(second.id).toBe('SNAPSHOT000000000000000002');
  });

  it('截断的快照文件被拒绝', async () => {
    // 头部声明 rows: 2，但只提供 1 行
    const invalidLines = [
      JSON.stringify({
        liushui_snapshot: 1,
        taken_at: '2026-10-08T08:00:00.000Z',
        rows: 2,
        schema_versions: [1],
      }),
      JSON.stringify({
        id: 'SNAPSHOT000000000000000001',
        ts: '2026-10-08T07:47:08.479Z',
        author: 'will',
        kind: 'note',
        content: 'content',
        meta: '{}',
        received_at: '2026-10-08T07:47:09.000Z',
        schema_v: 1,
      }),
    ];

    const file = createTempFile(invalidLines.join('\n'));
    expect(() => readSnapshot(file)).toThrowError(ValidationError);
    expect(() => readSnapshot(file)).toThrowError(/截断/);
  });

  it('空文件或头部非法的快照被拒绝', () => {
    const emptyFile = createTempFile('');
    expect(() => readSnapshot(emptyFile)).toThrowError(ValidationError);

    const badHeaderFile = createTempFile('not json\n');
    expect(() => readSnapshot(badHeaderFile)).toThrowError(ValidationError);
  });
});
