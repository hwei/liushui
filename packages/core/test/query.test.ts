import { afterEach, describe, expect, it } from 'vitest';

import {
  QUERY_MAX_CELL_CHARS,
  QUERY_MAX_LIMIT,
  checkReadOnlyStatement,
  isExplainQueryPlan,
  shapeResult,
  wrapLimit,
} from '../src/query.ts';
import { createTempDb, type TempDb } from './helpers.ts';

describe('只读语句检查（task 2.1）', () => {
  it('去掉末尾分号并保留语句本身', () => {
    expect(checkReadOnlyStatement('SELECT id FROM memories;')).toBe('SELECT id FROM memories');
    expect(checkReadOnlyStatement('  SELECT 1 ;;  ')).toBe('SELECT 1');
  });

  it('接受大小写混合与前导注释', () => {
    expect(checkReadOnlyStatement('/* hi */ select 1 AS x')).toBe('/* hi */ select 1 AS x');
    expect(checkReadOnlyStatement('-- lead\nSELECT 1')).toBe('-- lead\nSELECT 1');
  });

  it('接受 WITH … SELECT 与 EXPLAIN QUERY PLAN', () => {
    expect(checkReadOnlyStatement('WITH x AS (SELECT 1) SELECT * FROM x')).toContain('WITH x');
    expect(checkReadOnlyStatement('EXPLAIN QUERY PLAN SELECT * FROM memories')).toContain(
      'EXPLAIN QUERY PLAN',
    );
    expect(isExplainQueryPlan('explain query plan SELECT 1')).toBe(true);
    expect(isExplainQueryPlan('EXPLAIN SELECT 1')).toBe(false);
  });

  it('引号或注释里的分号不切分语句', () => {
    expect(checkReadOnlyStatement("SELECT 'a;b' AS x")).toBe("SELECT 'a;b' AS x");
    expect(checkReadOnlyStatement('SELECT ";" AS x')).toBe('SELECT ";" AS x');
    expect(checkReadOnlyStatement('SELECT 1 -- ; still one\n')).toBe('SELECT 1 -- ; still one');
    expect(checkReadOnlyStatement('SELECT 1 /* ; */')).toBe('SELECT 1 /* ; */');
  });

  it('拒绝写语句、DDL、PRAGMA 与事务控制', () => {
    for (const sql of [
      'DELETE FROM memories',
      'INSERT INTO memories (id) VALUES (1)',
      'UPDATE memories SET id = 1',
      'DROP TABLE memories',
      'CREATE TABLE x (a)',
      'PRAGMA query_only = ON',
      'PRAGMA table_info(memories)',
      'BEGIN',
      'COMMIT',
      'ATTACH DATABASE \'x\' AS y',
      'EXPLAIN SELECT 1',
      '/* hidden */ DELETE FROM memories',
      '-- lead\nDELETE FROM memories',
      '/* c */ PRAGMA x = 1',
    ]) {
      expect(() => checkReadOnlyStatement(sql), sql).toThrowError(/只允许只读语句|单条语句/);
    }
  });

  it('拒绝多条语句（哪怕第一条是 SELECT）', () => {
    expect(() => checkReadOnlyStatement('SELECT 1; DELETE FROM memories')).toThrowError(
      /单条语句/,
    );
    expect(() => checkReadOnlyStatement("SELECT ';'; DELETE FROM memories")).toThrowError(
      /单条语句/,
    );
  });

  it('空 SQL 被拒绝', () => {
    expect(() => checkReadOnlyStatement('')).toThrowError(/不能为空/);
    expect(() => checkReadOnlyStatement('   ;  ')).toThrowError(/不能为空/);
  });

  it('文档化：WITH 后接写语句能通过第 3 层（由执行层负责拦）', () => {
    expect(checkReadOnlyStatement('WITH x AS (SELECT 1) DELETE FROM memories')).toContain('DELETE');
    expect(checkReadOnlyStatement('WITH x AS (SELECT 1) INSERT INTO memories (id) VALUES (1)')).toContain(
      'INSERT',
    );
  });
});

describe('LIMIT 包裹（task 2.2）', () => {
  it('包裹 SELECT 并多取一行', () => {
    const wrapped = wrapLimit('SELECT id FROM memories', 10);
    expect(wrapped).toContain('SELECT id FROM memories');
    expect(wrapped.endsWith(') LIMIT 11')).toBe(true);
  });

  it('不改变用户的关键字面参数个数', () => {
    const sql = 'SELECT id FROM memories WHERE kind = ? AND author = ?';
    const before = (sql.match(/\?/g) ?? []).length;
    const after = (wrapLimit(sql, 5).match(/\?/g) ?? []).length;
    expect(after).toBe(before);
  });

  it('EXPLAIN QUERY PLAN 不包裹', () => {
    const sql = 'EXPLAIN QUERY PLAN SELECT * FROM memories';
    expect(wrapLimit(sql, 10)).toBe(sql);
  });

  it('limit 必须是 1..最大值 的整数', () => {
    expect(wrapLimit('SELECT 1', QUERY_MAX_LIMIT)).toContain(`LIMIT ${QUERY_MAX_LIMIT + 1}`);
    for (const bad of [0, -1, 1.5, QUERY_MAX_LIMIT + 1]) {
      expect(() => wrapLimit('SELECT 1', bad), String(bad)).toThrowError(/limit/);
    }
  });
});

describe('结果整形（task 2.2）', () => {
  it('超过行数上限时只返回上限行并标记', () => {
    const rows = Array.from({ length: 11 }, (_, i) => [i]);
    const shaped = shapeResult(['n'], rows, { limit: 10 });
    expect(shaped.rows).toHaveLength(10);
    expect(shaped.truncated.rows).toBe(true);
  });

  it('未超过上限不标记截断', () => {
    const shaped = shapeResult(['n'], [[1], [2]], { limit: 10 });
    expect(shaped.rows).toHaveLength(2);
    expect(shaped.truncated).toEqual({ rows: false, cells: 0 });
  });

  it('长文本按码点截断并计数', () => {
    const long = '😀'.repeat(QUERY_MAX_CELL_CHARS + 5);
    const shaped = shapeResult(['content'], [[long]], { limit: 10 });
    expect(Array.from(String(shaped.rows[0]![0])).length).toBe(QUERY_MAX_CELL_CHARS);
    expect(shaped.truncated.cells).toBe(1);
  });

  it('blob 转 base64，大整数转字符串', () => {
    const shaped = shapeResult(['b', 'n'], [[new Uint8Array([104, 105]), 9007199254740993n]], {
      limit: 10,
    });
    expect(shaped.rows[0]).toEqual(['aGk=', '9007199254740993']);
  });

  it('超过响应字节上限时按行截断', () => {
    const rows = Array.from({ length: 50 }, () => ['x'.repeat(1000)]);
    const shaped = shapeResult(['c'], rows, { limit: 50, maxResponseBytes: 4096 });
    expect(shaped.rows.length).toBeLessThan(50);
    expect(shaped.truncated.rows).toBe(true);
  });
});

describe('LIMIT 包裹在本地文件库上保持排序（task 2.2）', () => {
  let db: TempDb | undefined;
  afterEach(async () => {
    await db?.cleanup();
    db = undefined;
  });

  it('带 ORDER BY ts 的子查询包裹后顺序保持，且多取的一行用于判断截断', async () => {
    db = createTempDb();
    await db.client.execute('CREATE TABLE memories (id TEXT PRIMARY KEY, ts TEXT NOT NULL)');
    for (let i = 0; i < 30; i += 1) {
      await db.client.execute({
        sql: 'INSERT INTO memories (id, ts) VALUES (?, ?)',
        args: [`id-${String(i).padStart(2, '0')}`, `2026-01-${String(i + 1).padStart(2, '0')}`],
      });
    }
    const wrapped = wrapLimit('SELECT id FROM memories ORDER BY ts', 10);
    const result = await db.client.execute(wrapped);
    const ids = result.rows.map((row) => String(row['id']));
    expect(ids).toHaveLength(11);
    expect(ids.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, (_, i) => `id-${String(i).padStart(2, '0')}`),
    );
  });
});
