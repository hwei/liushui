import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countMemories, getMemory } from '@liushui/core/storage';

import {
  PERSONAL_TOKEN,
  WORK_TOKEN,
  appendRequest,
  callAppend,
  createTestContext,
  makeAppendBody,
  type TestContext,
} from './helpers.ts';
import { handleRequest } from '../src/app.ts';

describe('按库路由与隔离（task 4.5）', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('个人库 token 只写入个人库，公司库无记录', async () => {
    const body = await makeAppendBody();
    const { status, body: response } = await callAppend(ctx, body, PERSONAL_TOKEN);
    expect(status).toBe(201);
    expect(response['created']).toBe(true);

    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(1);
    expect(await countMemories(ctx.vaults['work']!.client)).toBe(0);
    expect(await getMemory(ctx.vaults['work']!.client, String(body['id']))).toBeNull();
  });

  it('公司库 token 只写入公司库', async () => {
    const body = await makeAppendBody();
    await callAppend(ctx, body, WORK_TOKEN);
    expect(await countMemories(ctx.vaults['work']!.client)).toBe(1);
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(0);
  });

  it('个人库 token 显式指定公司库被拒绝，两个库都无变化', async () => {
    const body = await makeAppendBody({ vault: 'work' });
    const { status, body: response } = await callAppend(ctx, body, PERSONAL_TOKEN);
    expect(status).toBe(403);
    expect(response).toMatchObject({ error: { code: 'vault_mismatch' } });
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(0);
    expect(await countMemories(ctx.vaults['work']!.client)).toBe(0);
  });

  it('显式指定自己的库是允许的', async () => {
    const body = await makeAppendBody({ vault: 'personal' });
    const { status } = await callAppend(ctx, body, PERSONAL_TOKEN);
    expect(status).toBe(201);
  });

  it('vault 字段类型非法被拒绝', async () => {
    const body = await makeAppendBody({ vault: 42 });
    const { status, body: response } = await callAppend(ctx, body, PERSONAL_TOKEN);
    expect(status).toBe(400);
    expect(response).toMatchObject({ error: { code: 'invalid_field', details: { field: 'vault' } } });
  });

  it('两个库中的同一条记忆 id 相同', async () => {
    const body = await makeAppendBody();
    const personal = await callAppend(ctx, body, PERSONAL_TOKEN);
    const work = await callAppend(ctx, body, WORK_TOKEN);
    expect(personal.body['id']).toBe(work.body['id']);
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(1);
    expect(await countMemories(ctx.vaults['work']!.client)).toBe(1);
  });

  it('不提供任何修改或删除既有记录的接口（memory-ledger: 不存在改写路径）', async () => {
    const body = await makeAppendBody();
    await callAppend(ctx, body, PERSONAL_TOKEN);
    const before = await getMemory(ctx.vaults['personal']!.client, String(body['id']));

    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const onAppend = await handleRequest(
        new Request('https://mem.test/append', { method, headers: { authorization: `Bearer ${PERSONAL_TOKEN}` } }),
        ctx.env,
        ctx.deps,
      );
      expect([404, 405]).toContain(onAppend.status);
    }
    const onRecords = await handleRequest(
      new Request(`https://mem.test/memories/${String(body['id'])}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${PERSONAL_TOKEN}` },
      }),
      ctx.env,
      ctx.deps,
    );
    expect(onRecords.status).toBe(404);

    expect(await getMemory(ctx.vaults['personal']!.client, String(body['id']))).toEqual(before);
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(1);
  });

  it('环境隔离：dev token 无法访问 prod，prod 数据不变（memory-api: dev token 不能访问 prod）', async () => {
    const prodEnv = {
      SERVICE_VERSION: '1.0.0-prod',
      LIUSHUI_VAULT_TOKENS: JSON.stringify({
        'prod-personal-token': { vault: 'prod-personal', url: ctx.vaults['personal']!.url, authToken: '' },
      }),
    };
    const body = await makeAppendBody();

    const denied = await handleRequest(appendRequest(body, PERSONAL_TOKEN), prodEnv, ctx.deps);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(0);

    const allowed = await handleRequest(appendRequest(body, 'prod-personal-token'), prodEnv, ctx.deps);
    expect(allowed.status).toBe(201);
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(1);
  });
});
