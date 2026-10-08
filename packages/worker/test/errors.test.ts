import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Client } from '@libsql/client';
import { countMemories } from '@liushui/core/storage';

import { handleRequest } from '../src/app.ts';
import type { HandlerDeps } from '../src/app.ts';
import {
  PERSONAL_TOKEN,
  appendRequest,
  callAppend,
  createTestContext,
  makeAppendBody,
  type TestContext,
} from './helpers.ts';

describe('错误语义（task 4.3）', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('后端不可用时返回服务端错误，可与客户端错误区分', async () => {
    const deps: HandlerDeps = {
      createClient: () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8080 — turso-token-do-not-leak');
      },
      now: () => new Date(),
    };
    const body = await makeAppendBody();
    const { status, body: response } = await callAppend(ctx, body, PERSONAL_TOKEN, deps);
    expect(status).toBe(503);
    expect(response).toMatchObject({ error: { code: 'storage_unavailable' } });

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('ECONNREFUSED');
    expect(serialized).not.toContain('do-not-leak');
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('Error');
  });

  it('数据库执行失败也折叠为 storage_unavailable', async () => {
    const brokenClient = {
      execute: () => Promise.reject(new Error('rows written quota exceeded')),
      executeMultiple: () => Promise.reject(new Error('nope')),
      batch: () => Promise.reject(new Error('nope')),
      transaction: () => Promise.reject(new Error('nope')),
      close: () => undefined,
      closed: false,
      protocol: 'file',
    } as unknown as Client;
    const deps: HandlerDeps = {
      createClient: () => brokenClient,
      now: () => new Date(),
    };
    const body = await makeAppendBody();
    const { status, body: response } = await callAppend(ctx, body, PERSONAL_TOKEN, deps);
    expect(status).toBe(503);
    expect(response).toMatchObject({ error: { code: 'storage_unavailable' } });
    expect(JSON.stringify(response)).not.toContain('quota');
  });

  it('服务端错误与客户端错误的状态码和 code 都不同', async () => {
    const ok = await makeAppendBody();
    const badId = await makeAppendBody({ id: 'AAAAAAAAAAAAAAAAAAAAAAAAAA' });
    const clientError = await callAppend(ctx, badId, PERSONAL_TOKEN);
    expect(clientError.status).toBe(400);
    expect(clientError.body).toMatchObject({ error: { code: 'id_mismatch' } });

    const deps: HandlerDeps = {
      createClient: () => {
        throw new Error('down');
      },
      now: () => new Date(),
    };
    const serverError = await callAppend(ctx, ok, PERSONAL_TOKEN, deps);
    expect(serverError.status).toBe(503);
    expect((serverError.body['error'] as { code: string }).code).not.toBe('id_mismatch');
  });

  it('配置损坏返回服务端错误且不泄漏配置内容', async () => {
    const env = { ...ctx.env, LIUSHUI_VAULT_TOKENS: '{ broken json with secret-token' };
    const body = await makeAppendBody();
    const response = await handleRequest(appendRequest(body, PERSONAL_TOKEN), env, ctx.deps);
    expect(response.status).toBe(500);
    const parsed = (await response.json()) as Record<string, unknown>;
    expect(parsed).toMatchObject({ error: { code: 'server_misconfigured' } });
    expect(JSON.stringify(parsed)).not.toContain('secret-token');
  });

  it('未配置任何库时也是服务端错误', async () => {
    const env = { ...ctx.env, LIUSHUI_VAULT_TOKENS: '' };
    const body = await makeAppendBody();
    const response = await handleRequest(appendRequest(body, PERSONAL_TOKEN), env, ctx.deps);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'server_misconfigured' } });
  });

  it('未知端点返回 404', async () => {
    const response = await handleRequest(new Request('https://mem.test/nope'), ctx.env, ctx.deps);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('追加端点只接受 POST', async () => {
    const response = await handleRequest(
      new Request('https://mem.test/append', { method: 'GET' }),
      ctx.env,
      ctx.deps,
    );
    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({ error: { code: 'method_not_allowed' } });
  });

  it('错误响应是机器可读的 JSON，且不含堆栈', async () => {
    const response = await handleRequest(
      new Request('https://mem.test/nope'),
      ctx.env,
      ctx.deps,
    );
    expect(response.headers.get('content-type')).toContain('application/json');
    const parsed = (await response.json()) as Record<string, unknown>;
    expect(parsed['error']).toMatchObject({ code: 'not_found', message: expect.any(String) });
    expect(JSON.stringify(parsed)).not.toContain('stack');
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(0);
  });
});
