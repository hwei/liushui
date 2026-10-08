import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countMemories } from '@liushui/core/storage';

import { extractBearerToken, findVaultForToken } from '../src/auth.ts';
import { parseVaultTokens } from '../src/env.ts';
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

describe('token 鉴权（task 4.1）', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('extractBearerToken 解析规则', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('bearer  abc ')).toBe('abc');
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('Bearer')).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
  });

  it('无 token 被拒绝且不写入', async () => {
    const body = await makeAppendBody();
    const { status, body: response } = await callAppend(ctx, body, null);
    expect(status).toBe(401);
    expect(response).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(0);
  });

  it('无效 token 被拒绝，响应不透露库信息', async () => {
    const body = await makeAppendBody();
    const { status, body: response } = await callAppend(ctx, body, 'not-a-real-token');
    expect(status).toBe(401);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('personal');
    expect(serialized).not.toContain('work');
    expect(serialized).not.toContain('libsql');
    expect(serialized).not.toContain('.db');
  });

  it('无 token 与无效 token 的响应完全一致', async () => {
    const body = await makeAppendBody();
    const missing = await callAppend(ctx, body, null);
    const invalid = await callAppend(ctx, body, 'another-wrong-token');
    expect(invalid.status).toBe(missing.status);
    expect(invalid.body).toEqual(missing.body);
  });

  it('格式不正确的 Authorization 头按无 token 处理', async () => {
    const body = await makeAppendBody();
    const request = appendRequest(body, null);
    request.headers.set('authorization', 'Token abc');
    const response = await handleRequest(request, ctx.env, ctx.deps);
    expect(response.status).toBe(401);
  });

  it('有效 token 通过鉴权', async () => {
    const body = await makeAppendBody();
    const { status } = await callAppend(ctx, body, PERSONAL_TOKEN);
    expect(status).toBe(201);
  });

  it('findVaultForToken 扫描全部条目且只命中绑定项', async () => {
    const entries = parseVaultTokens(ctx.env.MEM_VAULT_TOKENS);
    expect(await findVaultForToken(entries, PERSONAL_TOKEN)).toMatchObject({ vault: 'personal' });
    expect(await findVaultForToken(entries, WORK_TOKEN)).toMatchObject({ vault: 'work' });
    expect(await findVaultForToken(entries, 'personal')).toBeNull();
    expect(await findVaultForToken(entries, 'personal-token ')).toBeNull();
  });

  it('token 轮换的重叠窗口：两个 token 绑定同一库时都能写入，移除旧 token 后立即失效（docs/deploy.md 8.1）', async () => {
    const oldToken = 'rotating-old-token';
    const newToken = 'rotating-new-token';
    const url = ctx.vaults['personal']!.url;
    const shared = { vault: 'personal', url, authToken: '' };

    const overlapEnv = {
      SERVICE_VERSION: '0.1.0-test',
      MEM_VAULT_TOKENS: JSON.stringify({ [oldToken]: shared, [newToken]: shared }),
    };

    const viaOld = await callAppend(ctx, await makeAppendBody(), oldToken, ctx.deps, overlapEnv);
    const viaNew = await callAppend(
      ctx,
      await makeAppendBody({ content: '轮换期间用新 token 写入' }),
      newToken,
      ctx.deps,
      overlapEnv,
    );
    expect(viaOld.status).toBe(201);
    expect(viaNew.status).toBe(201);
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(2);

    const afterRotationEnv = {
      SERVICE_VERSION: '0.1.0-test',
      MEM_VAULT_TOKENS: JSON.stringify({ [newToken]: shared }),
    };
    const oldTokenAfter = await callAppend(
      ctx,
      await makeAppendBody({ content: '旧 token 应已失效' }),
      oldToken,
      ctx.deps,
      afterRotationEnv,
    );
    expect(oldTokenAfter.status).toBe(401);
    expect(await countMemories(ctx.vaults['personal']!.client)).toBe(2);
  });
});
