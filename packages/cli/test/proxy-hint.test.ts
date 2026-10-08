import { describe, expect, it } from 'vitest';

import { proxyHint } from '../src/proxy-hint.ts';

describe('代理诊断提示（task 1.1）', () => {
  it('有代理但未启用 NODE_USE_ENV_PROXY 时给出提示，且不回显变量值', () => {
    const hint = proxyHint({
      HTTP_PROXY: 'http://127.0.0.1:7897',
      NODE_USE_ENV_PROXY: undefined,
    });

    expect(hint).not.toBeNull();
    expect(hint).toContain('NODE_USE_ENV_PROXY');
    // 只出现变量名与修法，不回显代理地址等值。
    expect(hint).not.toContain('127.0.0.1');
    expect(hint).not.toContain('7897');
  });

  it('HTTPS_PROXY 同样触发提示', () => {
    const hint = proxyHint({ HTTPS_PROXY: 'http://proxy.internal:8080' });

    expect(hint).not.toBeNull();
    expect(hint).toContain('NODE_USE_ENV_PROXY');
    expect(hint).not.toContain('proxy.internal');
    expect(hint).not.toContain('8080');
  });

  it('已启用 NODE_USE_ENV_PROXY 时不提示', () => {
    expect(
      proxyHint({ HTTP_PROXY: 'http://127.0.0.1:7897', NODE_USE_ENV_PROXY: '1' }),
    ).toBeNull();
  });

  it('只有精确的 "1" 算启用（与 Node 实际行为一致）', () => {
    for (const value of ['true', '0', 'yes']) {
      expect(proxyHint({ HTTP_PROXY: 'http://127.0.0.1:7897', NODE_USE_ENV_PROXY: value })).not.toBeNull();
    }
  });

  it('没有代理时不提示', () => {
    expect(proxyHint({})).toBeNull();
  });

  it('代理变量为空串时视为未配置', () => {
    expect(proxyHint({ HTTP_PROXY: '', HTTPS_PROXY: '' })).toBeNull();
    expect(proxyHint({ HTTP_PROXY: '   ' })).toBeNull();
  });

  it('提示里不含任何 token 字样', () => {
    const hint = proxyHint({ HTTP_PROXY: 'http://user:secret@proxy:8080' });

    expect(hint).not.toBeNull();
    expect(hint).not.toContain('secret');
    expect(hint).not.toContain('user');
  });
});
