import { describe, expect, it } from 'vitest';
import { getServiceVersion } from '../src/client.ts';
import type { ResolvedVault } from '../src/config.ts';

const mockVault: ResolvedVault = {
  name: 'personal',
  url: 'https://example.com/api',
  token: 'secret-token-12345',
  redact: [],
};

describe('getServiceVersion (task 2.1)', () => {
  it('成功返回 version 字符串', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe('https://example.com/api/health');
      return new Response(JSON.stringify({ ok: true, version: '0.3.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const version = await getServiceVersion(mockVault, { fetchImpl });
    expect(version).toBe('0.3.0');
  });

  it('网络错误返回 null，不抛错', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError('Failed to fetch');
    };

    const version = await getServiceVersion(mockVault, { fetchImpl });
    expect(version).toBeNull();
  });

  it('超时返回 null，不抛错', async () => {
    const fetchImpl: typeof fetch = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      throw err;
    };

    const version = await getServiceVersion(mockVault, { fetchImpl, timeoutMs: 10 });
    expect(version).toBeNull();
  });

  it('非 200 状态码返回 null', async () => {
    const fetchImpl: typeof fetch = async () => {
      return new Response('Internal Server Error', { status: 500 });
    };

    const version = await getServiceVersion(mockVault, { fetchImpl });
    expect(version).toBeNull();
  });

  it('响应体不是 JSON 或缺少 version 字段返回 null', async () => {
    const fetchImpl1: typeof fetch = async () => {
      return new Response('Not JSON', { status: 200 });
    };
    expect(await getServiceVersion(mockVault, { fetchImpl: fetchImpl1 })).toBeNull();

    const fetchImpl2: typeof fetch = async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    expect(await getServiceVersion(mockVault, { fetchImpl: fetchImpl2 })).toBeNull();

    const fetchImpl3: typeof fetch = async () => {
      return new Response(JSON.stringify({ ok: true, version: '  ' }), { status: 200 });
    };
    expect(await getServiceVersion(mockVault, { fetchImpl: fetchImpl3 })).toBeNull();
  });
});
