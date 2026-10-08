import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadMigrations } from '../src/storage/load-migrations.ts';
import { appendMemory, countMemories, getMemory } from '../src/storage/append.ts';
import { appliedVersions, runMigrations } from '../src/storage/migrate.ts';
import type { MemoryRecord } from '../src/record.ts';
import { SCHEMA_VERSION } from '../src/record.ts';
import { createTempDb, type TempDb } from './helpers.ts';

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'AAAABBBBCCCCDDDDEEEEFFFFGG',
    ts: '2026-10-08T07:47:08.479Z',
    author: 'will',
    kind: 'note',
    content: '内容',
    meta: {},
    received_at: '2026-10-08T07:47:09.000Z',
    schema_v: SCHEMA_VERSION,
    ...overrides,
  };
}

describe('存储：schema 与迁移（task 3.1）', () => {
  let db: TempDb;
  beforeEach(() => {
    db = createTempDb();
  });
  afterEach(async () => {
    await db.cleanup();
  });

  it('迁移文件可加载且版本有序', () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]?.version).toBe(1);
    expect(migrations[0]?.sql).toContain('CREATE TABLE IF NOT EXISTS memories');
  });

  it('首次执行应用全部迁移，重复执行不再应用', async () => {
    const migrations = loadMigrations();
    const first = await runMigrations(db.client, migrations);
    expect(first).toEqual(migrations.map((m) => m.version));

    const second = await runMigrations(db.client, migrations);
    expect(second).toEqual([]);
    expect(await appliedVersions(db.client)).toEqual(migrations.map((m) => m.version));
  });

  it('重复执行后 schema 完全一致', async () => {
    const migrations = loadMigrations();
    await runMigrations(db.client, migrations);
    const before = await db.client.execute(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    await runMigrations(db.client, migrations);
    const after = await db.client.execute(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    expect(after.rows).toEqual(before.rows);
    expect(before.rows.map((row) => row['name'])).toEqual(
      expect.arrayContaining(['memories', 'idx_memories_ts', 'schema_migrations']),
    );
  });

  it('memories 表包含全部核心列且 id 为主键', async () => {
    await runMigrations(db.client, loadMigrations());
    const info = await db.client.execute('PRAGMA table_info(memories)');
    const columns = info.rows.map((row) => String(row['name']));
    expect(columns).toEqual([
      'id',
      'ts',
      'author',
      'kind',
      'content',
      'meta',
      'received_at',
      'schema_v',
    ]);
    const idColumn = info.rows.find((row) => row['name'] === 'id');
    expect(Number(idColumn?.['pk'])).toBe(1);
  });
});

describe('存储：幂等追加（task 3.2）', () => {
  let db: TempDb;
  beforeEach(async () => {
    db = createTempDb();
    await runMigrations(db.client, loadMigrations());
  });
  afterEach(async () => {
    await db.cleanup();
  });

  it('新记录写入成功并返回 created=true', async () => {
    const result = await appendMemory(db.client, record());
    expect(result).toEqual({ id: record().id, created: true });
    expect(await countMemories(db.client)).toBe(1);
  });

  it('重复 id 不新增记录，返回 created=false', async () => {
    await appendMemory(db.client, record());
    const second = await appendMemory(db.client, record({ content: '不同的内容也不该覆盖' }));
    expect(second.created).toBe(false);
    expect(await countMemories(db.client)).toBe(1);
  });

  it('重复 id 不覆盖既有 meta 与 received_at', async () => {
    await appendMemory(
      db.client,
      record({ meta: { git: { branch: 'main' } }, received_at: '2026-01-01T00:00:00.000Z' }),
    );
    await appendMemory(
      db.client,
      record({ meta: { git: { branch: 'other' }, cwd: '/x' }, received_at: '2030-01-01T00:00:00.000Z' }),
    );
    const stored = await getMemory(db.client, record().id);
    expect(stored?.meta).toEqual({ git: { branch: 'main' } });
    expect(stored?.received_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('读回完整字段', async () => {
    const rec = record({ meta: { git: { branch: 'main', dirty: false }, cwd: '/repo' } });
    await appendMemory(db.client, rec);
    expect(await getMemory(db.client, rec.id)).toEqual(rec);
  });

  it('不存在的 id 返回 null', async () => {
    expect(await getMemory(db.client, 'NOPE')).toBeNull();
  });
});

describe('存储：meta 过滤与可扩展性（task 3.3）', () => {
  let db: TempDb;
  beforeEach(async () => {
    db = createTempDb();
    await runMigrations(db.client, loadMigrations());
    await appendMemory(
      db.client,
      record({ id: 'ID0000000000000000000000A', meta: { git: { branch: 'main' } } }),
    );
    await appendMemory(
      db.client,
      record({ id: 'ID0000000000000000000000B', meta: { git: { branch: 'dev' } } }),
    );
    await appendMemory(db.client, record({ id: 'ID0000000000000000000000C', meta: {} }));
  });
  afterEach(async () => {
    await db.cleanup();
  });

  it('按 json_extract(meta, $.git.branch) 过滤可用', async () => {
    const result = await db.client.execute({
      sql: "SELECT id FROM memories WHERE json_extract(meta, '$.git.branch') = ? ORDER BY id",
      args: ['main'],
    });
    expect(result.rows.map((row) => String(row['id']))).toEqual(['ID0000000000000000000000A']);
  });

  it('新的 meta 键无需迁移即可写入与查询', async () => {
    const before = await appliedVersions(db.client);
    await appendMemory(
      db.client,
      record({ id: 'ID0000000000000000000000D', meta: { weather: { temp_c: 21 }, novel: 'x' } }),
    );
    const result = await db.client.execute({
      sql: "SELECT id FROM memories WHERE json_extract(meta, '$.weather.temp_c') = ?",
      args: [21],
    });
    expect(result.rows.map((row) => String(row['id']))).toEqual(['ID0000000000000000000000D']);
    expect(await appliedVersions(db.client)).toEqual(before);
  });
});
