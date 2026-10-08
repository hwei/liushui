import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countMemories, getMemory } from '@liushui/core/storage';

import { FIXED_RECEIVED_AT, FIXED_TS, PERSONAL_TOKEN, appendRequest, callAppend, createTestContext, makeAppendBody, type TestContext } from './helpers.ts';
import { handleRequest } from '../src/app.ts';

describe('追加端点（task 4.2）', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('新记录写入成功，返回 id 与 created=true', async () => {
    const body = await makeAppendBody();
    const { status, body: response } = await callAppend(ctx, body, PERSONAL_TOKEN);
    expect(status).toBe(201);
    expect(response).toEqual({ id: body['id'], created: true });

    const stored = await getMemory(ctx.vaults['personal']!.client, String(body['id']));
    expect(stored).toMatchObject({
      id: body['id'],
      ts: FIXED_TS,
      author: 'will',
      kind: 'note',
      content: '一条记忆',
      meta: { git: { branch: 'main' } },
      received_at: FIXED_RECEIVED_AT,
      schema_v: 1,
    });
  });

  it('重复记录幂等返回，库内不新增且不覆盖既有 meta 与 received_at', async () => {
    const body = await makeAppendBody();
    const first = await callAppend(ctx, body, PERSONAL_TOKEN);
    expect(first.status).toBe(201);

    ctx.setNow('2030-01-01T00:00:00.000Z');
    const second = await callAppend(
      ctx,
      { ...body, meta: { git: { branch: 'other' }, cwd: '/somewhere' } },
      PERSONAL_TOKEN,
    );

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ id: body['id'], created: false });
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(1);

    const stored = await getMemory(ctx.vaults['personal']!.client, String(body['id']));
    expect(stored?.meta).toEqual({ git: { branch: 'main' } });
    expect(stored?.received_at).toBe(FIXED_RECEIVED_AT);
  });

  it('id 与核心字段不一致被拒绝且不写入', async () => {
    const body = await makeAppendBody({ id: 'AAAAAAAAAAAAAAAAAAAAAAAAAA' });
    const { status, body: response } = await callAppend(ctx, body, PERSONAL_TOKEN);
    expect(status).toBe(400);
    expect(response).toMatchObject({ error: { code: 'id_mismatch', details: { field: 'id' } } });
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(0);
  });

  it('content 超过大小上限返回 413 且不写入', async () => {
    const env = { ...ctx.env, MEM_MAX_CONTENT_BYTES: '16' };
    const body = await makeAppendBody({ content: 'x'.repeat(17) });
    const response = await handleRequest(appendRequest(body, PERSONAL_TOKEN), env, ctx.deps);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: 'content_too_large', details: { field: 'content' } },
    });
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(0);
  });

  it('缺少必填字段返回 400 并指出字段', async () => {
    const body = await makeAppendBody();
    delete body['author'];
    const { status, body: response } = await callAppend(ctx, body, PERSONAL_TOKEN);
    expect(status).toBe(400);
    expect(response).toMatchObject({ error: { code: 'missing_field', details: { field: 'author' } } });
  });

  it('非法 meta 被拒绝', async () => {
    const body = await makeAppendBody({ meta: { bad: [1, 2] } });
    const { status, body: response } = await callAppend(ctx, body, PERSONAL_TOKEN);
    expect(status).toBe(400);
    expect(response).toMatchObject({ error: { code: 'invalid_meta' } });
  });

  it('请求体不是合法 JSON 返回 400', async () => {
    const { status, body: response } = await callAppend(ctx, '{ not json', PERSONAL_TOKEN);
    expect(status).toBe(400);
    expect(response).toMatchObject({ error: { code: 'invalid_json' } });
  });

  it('空请求体返回 400', async () => {
    const { status, body: response } = await callAppend(ctx, '', PERSONAL_TOKEN);
    expect(status).toBe(400);
    expect(response).toMatchObject({ error: { code: 'invalid_json' } });
  });

  it('时间表示等价时命中同一条记录', async () => {
    const body = await makeAppendBody();
    await callAppend(ctx, body, PERSONAL_TOKEN);
    const equivalent = await makeAppendBody({ ts: '2026-10-08T15:47:08.479+08:00' });
    const { body: response } = await callAppend(ctx, equivalent, PERSONAL_TOKEN);
    expect(response).toEqual({ id: body['id'], created: false });
  });

  it('升级 schema 版本后旧记录仍可读且不被改写（memory-ledger: 旧记录在新版本下可读）', async () => {
    const oldBody = await makeAppendBody();
    await callAppend(ctx, oldBody, PERSONAL_TOKEN);

    const upgradedEnv = { ...ctx.env, MEM_SCHEMA_V: '2' };
    const newBody = await makeAppendBody({ content: '新 schema 版本写入' });
    const response = await handleRequest(
      appendRequest(newBody, PERSONAL_TOKEN),
      upgradedEnv,
      ctx.deps,
    );
    expect(response.status).toBe(201);

    const oldRecord = await getMemory(ctx.vaults['personal']!.client, String(oldBody['id']));
    const newRecord = await getMemory(ctx.vaults['personal']!.client, String(newBody['id']));
    expect(oldRecord?.schema_v).toBe(1);
    expect(oldRecord?.content).toBe('一条记忆');
    expect(newRecord?.schema_v).toBe(2);
  });
});
