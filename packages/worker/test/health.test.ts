import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleRequest } from '../src/app.ts';
import type { HandlerDeps } from '../src/app.ts';
import { createTestContext, unusedQueryExecutor, type TestContext } from './helpers.ts';

describe('健康检查（task 4.4）', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('无需鉴权返回版本', async () => {
    const response = await handleRequest(new Request('https://mem.test/health'), ctx.env, ctx.deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: '0.1.0-test' });
  });

  it('不访问数据库', async () => {
    const deps: HandlerDeps = {
      createClient: () => {
        throw new Error('健康检查不应访问数据库');
      },
      createQueryExecutor: unusedQueryExecutor,
      now: () => new Date(),
    };
    const response = await handleRequest(
      new Request('https://mem.test/health'),
      { ...ctx.env, LIUSHUI_VAULT_TOKENS: 'not-even-json' },
      deps,
    );
    expect(response.status).toBe(200);
  });

  it('缺少 SERVICE_VERSION 时给出兜底版本', async () => {
    const env = { ...ctx.env };
    delete env.SERVICE_VERSION;
    const response = await handleRequest(
      new Request('https://mem.test/health'),
      env,
      ctx.deps,
    );
    expect((await response.json()) as { version: string }).toMatchObject({
      version: '0.0.0-dev',
    });
  });

  it('非 GET 方法返回 405', async () => {
    const response = await handleRequest(
      new Request('https://mem.test/health', { method: 'POST' }),
      ctx.env,
      ctx.deps,
    );
    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({ error: { code: 'method_not_allowed' } });
  });
});
