import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { countMemories } from '@liushui/core/storage';
import { QUERY_MAX_LIMIT } from '@liushui/core';

import { handleRequest } from '../src/app.ts';
import type { HandlerDeps } from '../src/app.ts';
import { ConfigError, parseVaultReadCreds, parseVaultTokens, type VaultEntry } from '../src/env.ts';
import { QueryError } from '../src/errors.ts';
import { createHranaQueryExecutor, pipelineEndpoint } from '../src/query-executor.ts';
import {
  PERSONAL_TOKEN,
  callAppend,
  callSql,
  createTestContext,
  makeAppendBody,
  seedMemories,
  sqlRequest,
  unusedQueryExecutor,
  type TestContext,
} from './helpers.ts';

const personalBinding = (ctx: TestContext): VaultEntry => ({
  token: PERSONAL_TOKEN,
  vault: 'personal',
  url: ctx.vaults['personal']!.url,
  authToken: '',
});

async function insertRow(
  ctx: TestContext,
  id: string,
  kind: string,
  content: string,
  ts: string,
): Promise<void> {
  await ctx.vaults['personal']!.client.execute({
    sql: 'INSERT INTO memories (id, ts, author, kind, content, meta, received_at, schema_v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [id, ts, 'seed', kind, content, '{}', '2026-01-01T00:00:00.000Z', 1],
  });
}

describe('parseVaultReadCreds（task 3.1）', () => {
  it('缺失与空串返回空表（不报错）', () => {
    expect(parseVaultReadCreds(undefined)).toEqual({});
    expect(parseVaultReadCreds('')).toEqual({});
    expect(parseVaultReadCreds('   ')).toEqual({});
  });

  it('按库名索引，允许空 authToken（本地 sqld）', () => {
    expect(parseVaultReadCreds(JSON.stringify({ personal: { authToken: '' }, work: { authToken: 'x' } }))).toEqual({
      personal: { authToken: '' },
      work: { authToken: 'x' },
    });
  });

  it('非法结构一律抛 ConfigError', () => {
    expect(() => parseVaultReadCreds('{ broken')).toThrowError(ConfigError);
    expect(() => parseVaultReadCreds('[]')).toThrowError(ConfigError);
    expect(() => parseVaultReadCreds(JSON.stringify({ personal: 'x' }))).toThrowError(ConfigError);
    expect(() => parseVaultReadCreds(JSON.stringify({ personal: { url: 'libsql://x' } }))).toThrowError(
      /不允许出现字段 url/,
    );
    expect(() => parseVaultReadCreds(JSON.stringify({ personal: {} }))).toThrowError(ConfigError);
    expect(() => parseVaultReadCreds(JSON.stringify({ personal: { authToken: 1 } }))).toThrowError(
      ConfigError,
    );
  });

  it('同一库名对应多个 url 抛 ConfigError', () => {
    const tokens = JSON.stringify({
      t1: { vault: 'personal', url: 'libsql://a' },
      t2: { vault: 'personal', url: 'libsql://b' },
    });
    expect(() => parseVaultTokens(tokens)).toThrowError(/多个 url/);
  });
});

describe('只读凭据与独立配置（memory-query）', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('缺少某库条目时返回 server_misconfigured，且执行器工厂从未被调用', async () => {
    const env = {
      ...ctx.env,
      LIUSHUI_VAULT_READ_CREDS: JSON.stringify({ work: { authToken: '' } }),
    };
    const factory = vi.fn<HandlerDeps['createQueryExecutor']>(() => ({
      execute: async () => ({ columns: [], rows: [] }),
    }));
    const { status, body } = await callSql(
      ctx,
      { sql: 'SELECT 1' },
      PERSONAL_TOKEN,
      { ...ctx.deps, createQueryExecutor: factory },
      env,
    );
    expect(status).toBe(500);
    expect(body).toMatchObject({ error: { code: 'server_misconfigured' } });
    expect(factory).not.toHaveBeenCalled();
  });

  it('secret 损坏时 /append 仍返回 201', async () => {
    const env = { ...ctx.env, LIUSHUI_VAULT_READ_CREDS: '{ broken json' };
    const body = await makeAppendBody();
    const response = await handleRequest(sqlRequest({ sql: 'SELECT 1' }, PERSONAL_TOKEN), env, ctx.deps);
    // /sql 因损坏的 secret 失败……
    expect(response.status).toBe(500);

    // ……但 /append 完全不受影响。
    const appended = await callAppend(ctx, body, PERSONAL_TOKEN, ctx.deps, env);
    expect(appended.status).toBe(201);
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(1);
  });

  it('secret 整体缺失时 /sql 失败、/append 仍 201', async () => {
    const env = { ...ctx.env };
    delete env.LIUSHUI_VAULT_READ_CREDS;

    const query = await callSql(ctx, { sql: 'SELECT 1' }, PERSONAL_TOKEN, ctx.deps, env);
    expect(query.status).toBe(500);
    expect(query.body).toMatchObject({ error: { code: 'server_misconfigured' } });

    const body = await makeAppendBody({ content: '缺少只读 secret 仍可追加' });
    const appended = await callAppend(ctx, body, PERSONAL_TOKEN, ctx.deps, env);
    expect(appended.status).toBe(201);
  });
});

describe('查询端点（memory-query）', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('成功返回列与按 ts 倒序的行', async () => {
    await seedMemories(ctx.vaults['personal']!.client, 3);
    const { status, body } = await callSql(
      ctx,
      { sql: 'SELECT id, kind FROM memories ORDER BY ts DESC' },
      PERSONAL_TOKEN,
    );
    expect(status).toBe(200);
    expect(body.vault).toBe('personal');
    expect(body.columns).toEqual(['id', 'kind']);
    expect(body.rows).toHaveLength(3);
    expect(body.rows?.[0]?.[0]).toBe('seed-002');
    expect(body.truncated).toEqual({ rows: false, cells: 0 });
  });

  it('位置参数生效', async () => {
    await seedMemories(ctx.vaults['personal']!.client, 2);
    await insertRow(ctx, 'other-1', 'other', '别的', '2027-01-01T00:00:00.000Z');
    const { status, body } = await callSql(
      ctx,
      { sql: 'SELECT id FROM memories WHERE kind = ? ORDER BY ts', args: ['note'] },
      PERSONAL_TOKEN,
    );
    expect(status).toBe(200);
    expect(body.rows?.map((row) => row[0])).toEqual(['seed-000', 'seed-001']);
  });

  it('无 token 被拒绝且不访问数据库', async () => {
    const deps: HandlerDeps = {
      createClient: () => {
        throw new Error('未授权不应访问数据库');
      },
      createQueryExecutor: unusedQueryExecutor,
      now: () => new Date(),
    };
    const { status, body } = await callSql(ctx, { sql: 'SELECT 1' }, null, deps);
    expect(status).toBe(401);
    expect(body).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('只支持 POST', async () => {
    const response = await handleRequest(
      new Request('https://mem.test/sql', { method: 'GET' }),
      ctx.env,
      ctx.deps,
    );
    expect(response.status).toBe(405);
  });
});

describe('单库范围与隔离（task 3.5）', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('个人库 token 只看到个人库记录', async () => {
    await seedMemories(ctx.vaults['personal']!.client, 2, 'personal');
    await seedMemories(ctx.vaults['work']!.client, 3, 'work');
    const { body } = await callSql(ctx, { sql: 'SELECT id FROM memories' }, PERSONAL_TOKEN);
    expect(body.rows).toHaveLength(2);
    expect(body.rows?.every((row) => String(row[0]).startsWith('personal-'))).toBe(true);
  });

  it('显式指定其它库被拒且不执行 SQL', async () => {
    const factory = vi.fn<HandlerDeps['createQueryExecutor']>(() => ({
      execute: async () => ({ columns: [], rows: [] }),
    }));
    const { status, body } = await callSql(
      ctx,
      { sql: 'SELECT 1', vault: 'work' },
      PERSONAL_TOKEN,
      { ...ctx.deps, createQueryExecutor: factory },
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: { code: 'vault_mismatch' } });
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('只接受只读语句（memory-query）', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('写语句被拒绝且记录数不变', async () => {
    await seedMemories(ctx.vaults['personal']!.client, 1);
    const { status, body } = await callSql(ctx, { sql: 'DELETE FROM memories' }, PERSONAL_TOKEN);
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'statement_not_allowed' } });
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(1);
  });

  it('多条语句被拒绝且都不执行', async () => {
    await seedMemories(ctx.vaults['personal']!.client, 1);
    const { status, body } = await callSql(
      ctx,
      { sql: 'SELECT 1; DELETE FROM memories' },
      PERSONAL_TOKEN,
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'statement_not_allowed' } });
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(1);
  });

  it('执行层兜底阻止写入（绕过语句检查，直接调用执行器）', async () => {
    await seedMemories(ctx.vaults['personal']!.client, 1);
    const executor = ctx.deps.createQueryExecutor(personalBinding(ctx), { authToken: '' });
    await expect(
      executor.execute(
        "INSERT INTO memories (id, ts, author, kind, content, meta, received_at, schema_v) VALUES ('x','2026-01-01T00:00:00.000Z','a','note','c','{}','2026-01-01T00:00:00.000Z',1)",
        [],
        { timeoutMs: 1000 },
      ),
    ).rejects.toThrow();
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(1);
  });

  it('EXPLAIN QUERY PLAN 可用', async () => {
    await seedMemories(ctx.vaults['personal']!.client, 1);
    const { status, body } = await callSql(
      ctx,
      { sql: "EXPLAIN QUERY PLAN SELECT * FROM memories WHERE ts > '2026-01-01'" },
      PERSONAL_TOKEN,
    );
    expect(status).toBe(200);
    expect(body.rows && body.rows.length).toBeGreaterThan(0);
  });
});

describe('结果上限（memory-query）', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('超过上限被截断并标记，排序保持', async () => {
    await seedMemories(ctx.vaults['personal']!.client, 30);
    const { body } = await callSql(
      ctx,
      { sql: 'SELECT id FROM memories ORDER BY ts', limit: 10 },
      PERSONAL_TOKEN,
    );
    expect(body.rows).toHaveLength(10);
    expect(body.truncated).toEqual({ rows: true, cells: 0 });
    expect(body.rows?.[0]?.[0]).toBe('seed-000');
    expect(body.rows?.[9]?.[0]).toBe('seed-009');
  });

  it('未超过上限不标记', async () => {
    await seedMemories(ctx.vaults['personal']!.client, 3);
    const { body } = await callSql(ctx, { sql: 'SELECT id FROM memories', limit: 10 }, PERSONAL_TOKEN);
    expect(body.rows).toHaveLength(3);
    expect(body.truncated?.rows).toBe(false);
  });

  it('请求上限超过服务端最大值返回参数错误且不执行', async () => {
    const factory = vi.fn<HandlerDeps['createQueryExecutor']>(() => ({
      execute: async () => ({ columns: [], rows: [] }),
    }));
    const { status, body } = await callSql(
      ctx,
      { sql: 'SELECT 1', limit: QUERY_MAX_LIMIT + 1 },
      PERSONAL_TOKEN,
      { ...ctx.deps, createQueryExecutor: factory },
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'invalid_field', details: { field: 'limit' } } });
    expect(factory).not.toHaveBeenCalled();
  });

  it('长文本单元格被截断并标记个数', async () => {
    await insertRow(ctx, 'long-1', 'note', 'x'.repeat(2500), '2026-06-01T00:00:00.000Z');
    const { body } = await callSql(ctx, { sql: 'SELECT content FROM memories' }, PERSONAL_TOKEN);
    expect(body.rows).toHaveLength(1);
    expect(Array.from(String(body.rows?.[0]?.[0])).length).toBe(2000);
    expect(body.truncated?.cells).toBe(1);
  });
});

describe('查询错误语义（memory-query）', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('SQL 错误可修正，且不泄漏 token / 凭据 / 地址', async () => {
    const env = {
      ...ctx.env,
      LIUSHUI_VAULT_READ_CREDS: JSON.stringify({
        personal: { authToken: 'super-secret-read-token' },
      }),
    };
    const { status, body } = await callSql(
      ctx,
      { sql: 'SELECT nope FROM memories' },
      PERSONAL_TOKEN,
      ctx.deps,
      env,
    );
    // 文件执行器给出的错误会被分类为 client 的 sql_error。
    expect(status).toBe(400);
    expect(body.error?.code).toBe('sql_error');
    expect(body.error?.message).toContain('no such column');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(PERSONAL_TOKEN);
    expect(serialized).not.toContain('super-secret-read-token');
  });

  it('执行器给出的 SQL 错误带出描述并清洗 URL 与凭据', async () => {
    const factory: HandlerDeps['createQueryExecutor'] = () => ({
      execute: async () => {
        throw new QueryError(
          'sql_error',
          400,
          'client',
          'no such column: nope near http://internal-host.test:1234 super-secret-read-token',
        );
      },
    });
    const env = {
      ...ctx.env,
      LIUSHUI_VAULT_READ_CREDS: JSON.stringify({
        personal: { authToken: 'super-secret-read-token' },
      }),
    };
    const { status, body } = await callSql(
      ctx,
      { sql: 'SELECT nope FROM memories' },
      PERSONAL_TOKEN,
      { ...ctx.deps, createQueryExecutor: factory },
      env,
    );
    expect(status).toBe(400);
    expect(body.error?.code).toBe('sql_error');
    expect(body.error?.message).toContain('no such column');
    expect(body.error?.message).toContain('<url>');
    expect(body.error?.message).not.toContain('internal-host.test');
    expect(body.error?.message).not.toContain('super-secret-read-token');
  });

  it('存储不可用与 SQL 错误区分', async () => {
    const factory: HandlerDeps['createQueryExecutor'] = () => ({
      execute: async () => {
        throw new QueryError('storage_unavailable', 503, 'server', 'backing store down');
      },
    });
    const { status, body } = await callSql(
      ctx,
      { sql: 'SELECT 1' },
      PERSONAL_TOKEN,
      { ...ctx.deps, createQueryExecutor: factory },
    );
    expect(status).toBe(503);
    expect(body.error?.code).toBe('storage_unavailable');
  });

  it('超时返回 504 且没有结果行', async () => {
    const factory: HandlerDeps['createQueryExecutor'] = () => ({
      execute: async () => {
        throw new QueryError('query_timeout', 504, 'server', '查询超时');
      },
    });
    const { status, body } = await callSql(
      ctx,
      { sql: 'SELECT 1' },
      PERSONAL_TOKEN,
      { ...ctx.deps, createQueryExecutor: factory },
    );
    expect(status).toBe(504);
    expect(body.error?.code).toBe('query_timeout');
    expect(body.rows).toBeUndefined();
  });
});

describe('用量报告与日志（task 3.4）', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('执行器报告 rows_read 时响应 stats 含该值', async () => {
    const factory: HandlerDeps['createQueryExecutor'] = () => ({
      execute: async () => ({ columns: ['n'], rows: [[7]], rowsRead: 7 }),
    });
    const { body } = await callSql(
      ctx,
      { sql: 'SELECT 1 AS n' },
      PERSONAL_TOKEN,
      { ...ctx.deps, createQueryExecutor: factory },
    );
    expect(body.stats?.rows_read).toBe(7);
    expect(typeof body.stats?.duration_ms).toBe('number');
  });

  it('用量日志不含私人文本与结果数据', async () => {
    await insertRow(ctx, 'secret-1', 'note', 'TOP-SECRET-PRIVATE', '2026-06-01T00:00:00.000Z');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { status } = await callSql(
        ctx,
        { sql: "SELECT content FROM memories WHERE content = 'TOP-SECRET-PRIVATE'" },
        PERSONAL_TOKEN,
      );
      expect(status).toBe(200);
      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      const usage = lines.filter((line) => line.includes('"event":"sql"'));
      expect(usage.length).toBeGreaterThan(0);
      const joined = usage.join('\n');
      expect(joined).not.toContain('TOP-SECRET-PRIVATE');
      expect(joined).not.toContain('content');
      expect(usage[0]).toContain('"vault":"personal"');
      expect(usage[0]).toContain('"status":200');
      expect(usage[0]).toContain('"duration_ms"');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('Hrana 方案 A 执行器（task 3.2）', () => {
  const binding: VaultEntry = {
    token: 'client-token',
    vault: 'personal',
    url: 'libsql://db-hwei.turso.io',
    authToken: 'write-token',
  };

  it('pipelineEndpoint 把 libsql:// 与 http:// 转成 /v2/pipeline', () => {
    expect(pipelineEndpoint('libsql://db-hwei.turso.io')).toBe('https://db-hwei.turso.io/v2/pipeline');
    expect(pipelineEndpoint('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/v2/pipeline');
  });

  it('解码文本/整数/blob 并带回 rows_read', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [], rows_read: 0 } } },
            {
              type: 'ok',
              response: {
                type: 'execute',
                result: {
                  cols: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
                  rows: [
                    [{ type: 'text', value: 'hi' }, { type: 'integer', value: '2' }, { type: 'blob', value: btoa('hi') }],
                    [{ type: 'integer', value: '9007199254740993' }, { type: 'null' }, { type: 'float', value: 1.5 }],
                  ],
                  rows_read: 2,
                  rows_written: 0,
                  query_duration_ms: 1,
                },
              },
            },
            { type: 'ok', response: { type: 'execute', result: {} } },
            { type: 'ok', response: { type: 'close' } },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      const executor = createHranaQueryExecutor(binding, { authToken: 'read-token' });
      const result = await executor.execute('SELECT 1', [], { timeoutMs: 5000 });
      expect(result.columns).toEqual(['a', 'b', 'c']);
      expect(result.rowsRead).toBe(2);
      expect(result.rows[0]?.[0]).toBe('hi');
      expect(result.rows[0]?.[1]).toBe(2);
      expect(result.rows[0]?.[2]).toBeInstanceOf(Uint8Array);
      expect(result.rows[1]?.[0]).toBe(9007199254740993n);
      expect(result.rows[1]?.[1]).toBeNull();
      expect(result.rows[1]?.[2]).toBe(1.5);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('语句报 SQL 错误时映射为 sql_error 并清洗凭据', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { type: 'ok', response: { type: 'execute', result: {} } },
            { type: 'error', error: { message: 'no such column: nope', code: 'SQL_INPUT_ERROR' } },
            { type: 'ok', response: { type: 'execute', result: {} } },
            { type: 'ok', response: { type: 'close' } },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      const executor = createHranaQueryExecutor(binding, { authToken: 'read-token' });
      await expect(executor.execute('SELECT nope', [], { timeoutMs: 5000 })).rejects.toMatchObject({
        apiCode: 'sql_error',
        status: 400,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rows_written > 0 判为只读违规', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { type: 'ok', response: { type: 'execute', result: {} } },
            { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [], rows_written: 4 } } },
            { type: 'ok', response: { type: 'execute', result: {} } },
            { type: 'ok', response: { type: 'close' } },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      const executor = createHranaQueryExecutor(binding, { authToken: 'read-token' });
      await expect(executor.execute('SELECT 1', [], { timeoutMs: 5000 })).rejects.toMatchObject({
        apiCode: 'statement_not_allowed',
        status: 400,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('顶层鉴权错误映射为 server_misconfigured', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'JWT error: InvalidToken' }), { status: 400 })) as typeof fetch;
    try {
      const executor = createHranaQueryExecutor(binding, { authToken: 'read-token' });
      await expect(executor.execute('SELECT 1', [], { timeoutMs: 5000 })).rejects.toMatchObject({
        apiCode: 'server_misconfigured',
        status: 500,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('超时映射为 query_timeout', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'TimeoutError'));
        });
      })) as typeof fetch;
    try {
      const executor = createHranaQueryExecutor(binding, { authToken: 'read-token' });
      await expect(executor.execute('SELECT 1', [], { timeoutMs: 20 })).rejects.toMatchObject({
        apiCode: 'query_timeout',
        status: 504,
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('全文检索宏（memory-query）', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  const SEARCH =
    "SELECT m.content FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH fts('%Q%') ORDER BY rank";

  async function appendContent(content: string): Promise<void> {
    const res = await callAppend(ctx, await makeAppendBody({ content }), PERSONAL_TOKEN);
    expect(res.status).toBe(201);
  }

  it('用宏做全文检索并按相关度返回', async () => {
    await appendContent('渲染管线切换到 URP 后阴影变糊');
    await appendContent('和渲染无关的记录：数据库迁移');
    await appendContent('完全不相关');
    const { status, body } = await callSql(ctx, { sql: SEARCH.replace('%Q%', '渲染') }, PERSONAL_TOKEN);
    expect(status).toBe(200);
    expect(body.rows).toHaveLength(2);
  });

  it('AND、OR 与同时出现优先于 OR', async () => {
    await appendContent('打包时 IL2CPP 报错');
    await appendContent('打包成功');
    await appendContent('阴影变糊');
    const run = async (q: string): Promise<string[]> => {
      const { body } = await callSql(ctx, { sql: SEARCH.replace('%Q%', q) }, PERSONAL_TOKEN);
      return (body.rows ?? []).map((row) => String(row[0])).sort();
    };
    expect(await run('打包 报错')).toEqual(['打包时 IL2CPP 报错']);
    expect(await run('阴影 OR 报错')).toEqual(['打包时 IL2CPP 报错', '阴影变糊']);
    expect(await run('打包 报错 OR 阴影')).toEqual(['打包时 IL2CPP 报错', '阴影变糊']);
  });

  it('EXPLAIN QUERY PLAN 中同样展开', async () => {
    const { status, body } = await callSql(
      ctx,
      { sql: 'EXPLAIN QUERY PLAN ' + SEARCH.replace('%Q%', '渲染') },
      PERSONAL_TOKEN,
    );
    expect(status).toBe(200);
    expect(body.rows && body.rows.length).toBeGreaterThan(0);
  });

  it('字符串和注释里的宏不展开', async () => {
    const { status, body } = await callSql(
      ctx,
      { sql: "SELECT 'fts(''x'')' AS s -- fts('y')" },
      PERSONAL_TOKEN,
    );
    expect(status).toBe(200);
    expect(body.rows).toEqual([["fts('x')"]]);
  });

  it('引号与运算符不会触发 FTS 语法错误', async () => {
    const { status } = await callSql(
      ctx,
      { sql: SEARCH.replace('%Q%', '"NEAR" link.xml*') },
      PERSONAL_TOKEN,
    );
    expect(status).toBe(200);
  });

  it.each([
    ['单个汉字', "SELECT id FROM memories_fts WHERE memories_fts MATCH fts('渲')", undefined, /LIKE/],
    ['词中夹带单字', "SELECT id FROM memories_fts WHERE memories_fts MATCH fts('iOS的')", undefined, /LIKE/],
    ['非字面量参数', 'SELECT id FROM memories_fts WHERE memories_fts MATCH fts(?)', ['渲染'], /字面量/],
    ['空文本', "SELECT id FROM memories_fts WHERE memories_fts MATCH fts('  ')", undefined, /不能为空/],
  ])('%s被拒绝且执行器从未被调用', async (_name, sql, args, pattern) => {
    const factory = vi.fn<HandlerDeps['createQueryExecutor']>(() => ({
      execute: async () => ({ columns: [], rows: [] }),
    }));
    const { status, body } = await callSql(
      ctx,
      args ? { sql, args } : { sql },
      PERSONAL_TOKEN,
      { ...ctx.deps, createQueryExecutor: factory },
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'invalid_field', details: { field: 'sql' } } });
    expect(body.error?.message).toMatch(pattern);
    expect(factory).not.toHaveBeenCalled();
  });
});