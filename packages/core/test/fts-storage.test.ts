import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FTS_SEGMENTER_V, expandFtsMacros } from '../src/fts.ts';
import type { MemoryRecord } from '../src/record.ts';
import { SCHEMA_VERSION } from '../src/record.ts';
import { appendMemory, countMemories } from '../src/storage/append.ts';
import { checkFts, rebuildFts } from '../src/storage/fts.ts';
import { loadMigrations } from '../src/storage/load-migrations.ts';
import { appliedVersions, runMigrations } from '../src/storage/migrate.ts';
import { createTempDb, type TempDb } from './helpers.ts';

let counter = 0;
function record(content: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  counter += 1;
  return {
    id: `FTSTEST${String(counter).padStart(19, '0')}`,
    ts: '2026-10-08T07:47:08.479Z',
    author: 'will',
    kind: 'note',
    content,
    meta: {},
    received_at: '2026-10-08T07:47:09.000Z',
    schema_v: SCHEMA_VERSION,
    ...overrides,
  };
}

/** 绕过 append 直接写 memories（不写索引），用来造“缺失”。 */
async function seed(db: TempDb, rec: MemoryRecord): Promise<void> {
  await db.client.execute({
    sql: 'INSERT INTO memories (id, ts, author, kind, content, meta, received_at, schema_v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [rec.id, rec.ts, rec.author, rec.kind, rec.content, '{}', rec.received_at, rec.schema_v],
  });
}

/** 用 fts() 宏检索，返回命中的 id（升序）。 */
async function search(db: TempDb, text: string): Promise<string[]> {
  const sql = expandFtsMacros(
    `SELECT m.id FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH fts('${text.replaceAll("'", "''")}') ORDER BY m.id`,
  );
  const result = await db.client.execute(sql);
  return result.rows.map((row) => String(row['id']));
}

async function indexRows(db: TempDb): Promise<number> {
  const result = await db.client.execute('SELECT COUNT(*) AS n FROM memories_fts');
  return Number(result.rows[0]?.['n']);
}

describe('迁移 0002_fts（task 3.1）', () => {
  let db: TempDb;
  beforeEach(() => {
    db = createTempDb();
  });
  afterEach(async () => {
    await db.cleanup();
  });

  it('重复执行幂等，schema_migrations 含版本 2，memories 数据不变', async () => {
    const migrations = loadMigrations();
    expect(migrations.map((m) => m.version)).toContain(2);

    await runMigrations(
      db.client,
      migrations.filter((m) => m.version === 1),
    );
    await seed(db, record('迁移前已有的记忆'));
    const before = await db.client.execute('SELECT * FROM memories');

    expect(await runMigrations(db.client, migrations)).toEqual([2]);
    expect(await runMigrations(db.client, migrations)).toEqual([]);
    expect(await appliedVersions(db.client)).toEqual(migrations.map((m) => m.version));

    const after = await db.client.execute('SELECT * FROM memories');
    expect(after.rows).toEqual(before.rows);
  });
});

describe('追加时同事务维护索引（task 3.2）', () => {
  let db: TempDb;
  beforeEach(async () => {
    db = createTempDb();
    await runMigrations(db.client, loadMigrations());
  });
  afterEach(async () => {
    await db.cleanup();
  });

  it('新记录立即可检索', async () => {
    const rec = record('渲染管线切换到 URP 后阴影变糊');
    await appendMemory(db.client, rec);
    expect(await search(db, '渲染')).toEqual([rec.id]);
    expect(await search(db, 'urp')).toEqual([rec.id]);
  });

  it('重复追加不产生重复索引', async () => {
    const rec = record('重复追加的记忆');
    expect((await appendMemory(db.client, rec)).created).toBe(true);
    expect((await appendMemory(db.client, rec)).created).toBe(false);
    expect(await indexRows(db)).toBe(1);
    expect(await search(db, '追加')).toEqual([rec.id]);
  });

  it('索引表不存在时追加整体失败，memories 无新增', async () => {
    await db.client.execute('DROP TABLE memories_fts');
    await expect(appendMemory(db.client, record('不会写入'))).rejects.toThrow();
    expect(await countMemories(db.client)).toBe(0);
  });
});

describe('重建与一致性检查（task 3.3）', () => {
  let db: TempDb;
  beforeEach(async () => {
    db = createTempDb();
    await runMigrations(db.client, loadMigrations());
  });
  afterEach(async () => {
    await db.cleanup();
  });

  it('为启用索引前的记录补建索引，并报告缺失', async () => {
    const a = record('启用索引之前的渲染问题');
    const b = record('另一条阴影记录');
    await seed(db, a);
    await seed(db, b);
    const before = await checkFts(db.client);
    expect(before).toMatchObject({ memories: 2, indexed: 0, missing: 2, extra: 0, ok: false });
    expect(before.version.recorded).toBeNull();

    expect(await rebuildFts(db.client)).toEqual({ rows: 2, version: FTS_SEGMENTER_V });
    expect(await search(db, '渲染')).toEqual([a.id]);
    expect(await checkFts(db.client)).toMatchObject({
      missing: 0,
      extra: 0,
      duplicates: 0,
      ok: true,
    });
  });

  it('重复重建结果相同，且 memories 不变', async () => {
    for (let i = 0; i < 3; i += 1) await seed(db, record(`第${i}条 渲染记录`));
    const memoriesBefore = await db.client.execute('SELECT * FROM memories ORDER BY id');
    await rebuildFts(db.client);
    const first = await search(db, '渲染');
    await rebuildFts(db.client);
    expect(await search(db, '渲染')).toEqual(first);
    expect(await indexRows(db)).toBe(3);
    const memoriesAfter = await db.client.execute('SELECT * FROM memories ORDER BY id');
    expect(memoriesAfter.rows).toEqual(memoriesBefore.rows);
  });

  it('跨页（超过 500 条）也能完整重建', async () => {
    for (let i = 0; i < 520; i += 1) await seed(db, record(`批量记录 ${i}`));
    expect((await rebuildFts(db.client)).rows).toBe(520);
    expect(await checkFts(db.client)).toMatchObject({ indexed: 520, missing: 0, ok: true });
  });

  it('发现多余与重复条目', async () => {
    const rec = record('正常记录');
    await appendMemory(db.client, rec);
    await rebuildFts(db.client); // 先登记版本，隔离出另外两项
    await db.client.execute("INSERT INTO memories_fts (id, body) VALUES ('GHOST', 'x')");
    await db.client.execute({
      sql: "INSERT INTO memories_fts (id, body) VALUES (?, 'dup')",
      args: [rec.id],
    });
    expect(await checkFts(db.client)).toMatchObject({ extra: 1, duplicates: 1, ok: false });
  });

  it('切分版本过期时报告不一致，重建后恢复', async () => {
    await appendMemory(db.client, record('版本测试'));
    await rebuildFts(db.client);
    await db.client.execute("UPDATE derived_state SET version = 0 WHERE name = 'memories_fts'");
    const stale = await checkFts(db.client);
    expect(stale.version).toEqual({ recorded: 0, current: FTS_SEGMENTER_V, ok: false });
    expect(stale.ok).toBe(false);
    await rebuildFts(db.client);
    expect((await checkFts(db.client)).ok).toBe(true);
  });

  it('检查是只读的', async () => {
    await seed(db, record('只读检查'));
    await checkFts(db.client);
    expect(await indexRows(db)).toBe(0);
    const state = await db.client.execute('SELECT COUNT(*) AS n FROM derived_state');
    expect(Number(state.rows[0]?.['n'])).toBe(0);
  });
});

describe('切分一致性（task 2.3）', () => {
  const docs = [
    '渲染管线切换到 URP 后阴影变糊，iOS渲染问题还在',
    '打包时 IL2CPP 报错，link.xml 缺条目导致裁剪',
    'ログを確認したがサーバーの再起動が必要だった',
    'Metal shader 编译很慢，数据库迁移之后才恢复正常',
    '日本語のドキュメントとEnglish mixed 文本：测试用例',
  ];
  const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu;
  let db: TempDb;
  let ids: string[];
  beforeEach(async () => {
    db = createTempDb();
    await runMigrations(db.client, loadMigrations());
    ids = [];
    for (const content of docs) {
      const rec = record(content);
      ids.push(rec.id);
      await appendMemory(db.client, rec);
    }
  });
  afterEach(async () => {
    await db.cleanup();
  });

  it('文档里每个 ≥2 字的纯中日文连续子串都能命中所在文档', async () => {
    let checked = 0;
    for (const [index, content] of docs.entries()) {
      for (const run of content.match(CJK_RUN) ?? []) {
        const chars = Array.from(run);
        for (let start = 0; start < chars.length; start += 1) {
          for (let len = 2; len <= 6 && start + len <= chars.length; len += 1) {
            const sub = chars.slice(start, start + len).join('');
            const hits = await search(db, sub);
            expect(hits, `子串「${sub}」应命中文档 ${index}`).toContain(ids[index]);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('spec 场景：两字词、中英混写、日文、AND、OR', async () => {
    expect(await search(db, '渲染')).toEqual([ids[0]]);
    expect(await search(db, 'ios渲染')).toEqual([ids[0]]);
    expect(await search(db, '確認')).toEqual([ids[2]]);
    expect(await search(db, '打包 报错')).toEqual([ids[1]]);
    expect(await search(db, '阴影 OR 数据库')).toEqual([ids[0], ids[3]].sort());
  });

  it('短语按连续出现匹配', async () => {
    const a = record('上次渲染问题是 shader 导致的');
    const b = record('渲染很慢，问题在别处');
    await appendMemory(db.client, a);
    await appendMemory(db.client, b);
    const hits = await search(db, '渲染问题');
    expect(hits).toContain(a.id);
    expect(hits).not.toContain(b.id);
  });

  it('同时出现优先于 OR', async () => {
    expect(await search(db, '打包 报错 OR 阴影')).toEqual([ids[0], ids[1]].sort());
  });

  it('引号与运算符不会触发 FTS 语法错误', async () => {
    await expect(search(db, '"NEAR" link.xml*')).resolves.toBeDefined();
  });
});
