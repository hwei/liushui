import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, type Client } from '@libsql/client';
import { computeId } from '@liushui/core';
import { loadMigrations } from '@liushui/core/migrations';
import { runMigrations } from '@liushui/core/storage';

import type { HandlerDeps } from '../src/app.ts';
import { handleRequest } from '../src/app.ts';
import type { Env } from '../src/env.ts';
import { QueryError } from '../src/errors.ts';
import type { QueryExecutor } from '../src/query-executor.ts';

export const FIXED_TS = '2026-10-08T07:47:08.479Z';
export const FIXED_RECEIVED_AT = '2026-10-08T07:47:09.000Z';
export const PERSONAL_TOKEN = 'personal-token';
export const WORK_TOKEN = 'work-token';

/** 不应被调用的查询执行器，用于只关心其它路径的测试。 */
export const unusedQueryExecutor: HandlerDeps['createQueryExecutor'] = () => ({
  async execute() {
    throw new Error('该测试不应执行查询');
  },
});

export interface TestVault {
  name: string;
  token: string;
  url: string;
  client: Client;
}

export interface TestContext {
  env: Env;
  vaults: Record<string, TestVault>;
  deps: HandlerDeps;
  /** 推进注入的时钟，用于验证 received_at 不被覆盖。 */
  setNow(iso: string): void;
  cleanup(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function removeDirBestEffort(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(50);
    }
  }
}

function fileUrl(dir: string, name: string): string {
  return `file:${join(dir, name).replaceAll('\\', '/')}`;
}

/**
 * 用两个本地 libSQL 文件库搭起一个测试用 Worker：
 * 注入的 `createClient` 直接返回对应的文件库连接。
 */
export async function createTestContext(): Promise<TestContext> {
  const dir = mkdtempSync(join(tmpdir(), 'liushui-worker-'));
  const migrations = loadMigrations();

  const vaultNames = ['personal', 'work'] as const;
  const vaults: Record<string, TestVault> = {};
  const clientsByUrl = new Map<string, Client>();

  for (const name of vaultNames) {
    const url = fileUrl(dir, `${name}.db`);
    const client = createClient({ url });
    await runMigrations(client, migrations);
    clientsByUrl.set(url, client);
    vaults[name] = {
      name,
      token: name === 'personal' ? PERSONAL_TOKEN : WORK_TOKEN,
      url,
      client,
    };
  }

  let nowIso = FIXED_RECEIVED_AT;
  const deps: HandlerDeps = {
    createClient: (binding) => {
      const client = clientsByUrl.get(binding.url);
      if (!client) throw new Error(`测试未配置库连接：${binding.vault}`);
      return client;
    },
    createQueryExecutor: (binding): QueryExecutor => ({
      // 本地文件库执行器（design 的方案 B）：连接级 PRAGMA query_only，写语句直接报错。
      async execute(sql, args) {
        const client = createClient({ url: binding.url });
        try {
          await client.execute('PRAGMA query_only = ON');
          const result = await client.execute({ sql, args: [...args] });
          const columns = result.columns;
          const rows = result.rows.map((row) =>
            columns.map((name) => (row as unknown as Record<string, unknown>)[name]),
          );
          return { columns, rows };
        } catch (error) {
          // 与真实执行器一样按 libSQL 错误码分类（design Decision 5）。
          const code = String((error as { code?: unknown })?.code ?? '');
          const message = error instanceof Error ? error.message : 'SQL 执行失败';
          if (code === 'SQLITE_READONLY' || /readonly/iu.test(message)) {
            throw new QueryError('statement_not_allowed', 400, 'client', message);
          }
          if (code.startsWith('SQL_') || code.startsWith('SQLITE_')) {
            throw new QueryError('sql_error', 400, 'client', message);
          }
          throw error;
        } finally {
          client.close();
        }
      },
    }),
    now: () => new Date(nowIso),
  };

  const tokens: Record<string, { vault: string; url: string; authToken: string }> = {};
  for (const vault of Object.values(vaults)) {
    tokens[vault.token] = { vault: vault.name, url: vault.url, authToken: '' };
  }

  const readCreds: Record<string, { authToken: string }> = {};
  for (const vault of Object.values(vaults)) readCreds[vault.name] = { authToken: '' };

  const env: Env = {
    SERVICE_VERSION: '0.1.0-test',
    LIUSHUI_VAULT_TOKENS: JSON.stringify(tokens),
    LIUSHUI_VAULT_READ_CREDS: JSON.stringify(readCreds),
  };

  return {
    env,
    vaults,
    deps,
    setNow: (iso: string) => {
      nowIso = iso;
    },
    async cleanup(): Promise<void> {
      for (const client of clientsByUrl.values()) client.close();
      await sleep(20);
      await removeDirBestEffort(dir);
    },
  };
}

/** 直接向库里插入 n 条记录（绕过 append，便于快速造数据）。ts 按插入顺序递增。 */
export async function seedMemories(client: Client, count: number, prefix = 'seed'): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    await client.execute({
      sql: 'INSERT INTO memories (id, ts, author, kind, content, meta, received_at, schema_v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [
        `${prefix}-${String(i).padStart(3, '0')}`,
        ts,
        'seed',
        'note',
        `内容 ${i}`,
        '{}',
        '2026-01-01T00:00:00.000Z',
        1,
      ],
    });
  }
}

/** 构造一个合法的追加请求体（id 由核心字段算出，可用 overrides 覆盖）。 */
export async function makeAppendBody(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const merged: Record<string, unknown> = {
    ts: FIXED_TS,
    author: 'will',
    kind: 'note',
    content: '一条记忆',
    meta: { git: { branch: 'main' } },
    ...overrides,
  };
  const id =
    typeof overrides['id'] === 'string'
      ? overrides['id']
      : await computeId({
          ts: String(merged['ts']),
          author: String(merged['author']),
          kind: String(merged['kind']),
          content: String(merged['content']),
        });
  return { ...merged, id };
}

/** 构造 POST /append 请求。token 为 null/undefined 时不带 Authorization 头。 */
export function appendRequest(body: unknown, token?: string | null): Request {
  return postRequest('/append', body, token);
}

/** 构造 POST /sql 请求。 */
export function sqlRequest(body: unknown, token?: string | null): Request {
  return postRequest('/sql', body, token);
}

function postRequest(path: string, body: unknown, token?: string | null): Request {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (typeof body === 'string') {
    headers.set('content-type', 'application/json');
    return new Request(`https://mem.test${path}`, { method: 'POST', headers, body });
  }
  headers.set('content-type', 'application/json');
  return new Request(`https://mem.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/** 调用 Worker 并解析 JSON 响应（可覆盖 deps / env，便于测试轮换与隔离）。 */
export async function callAppend(
  ctx: TestContext,
  body: unknown,
  token?: string | null,
  deps: HandlerDeps = ctx.deps,
  env: Env = ctx.env,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handleRequest(appendRequest(body, token), env, deps);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** 调用 `/sql` 并解析 JSON 响应。 */
export async function callSql(
  ctx: TestContext,
  body: unknown,
  token?: string | null,
  deps: HandlerDeps = ctx.deps,
  env: Env = ctx.env,
): Promise<{ status: number; body: SqlResponse }> {
  const response = await handleRequest(sqlRequest(body, token), env, deps);
  return { status: response.status, body: (await response.json()) as SqlResponse };
}

export interface SqlResponse {
  vault?: string;
  columns?: string[];
  rows?: Array<Array<string | number | null>>;
  truncated?: { rows: boolean; cells: number };
  stats?: { rows_read?: number; duration_ms: number };
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}
