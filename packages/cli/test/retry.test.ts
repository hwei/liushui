import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main } from '../src/main.ts';
import { createIo, writeTempConfig, type TempConfigFile } from './utils.ts';
import { startLocalWorker, type LocalWorker } from './worker-harness.ts';

const configFor = (url: string, token: string, extraVaults: Record<string, unknown> = {}) => ({
  env: 'dev',
  environments: {
    dev: {
      defaultVault: 'personal',
      vaults: {
        personal: { url, token },
        ...extraVaults,
      },
    },
  },
});

describe('可靠重试与多库报告（task 5.6）', () => {
  let worker: LocalWorker;
  beforeEach(async () => {
    worker = await startLocalWorker();
  });
  afterEach(async () => {
    await worker.cleanup();
  });

  it('服务端临时故障后重试成功，库中只有一条记录', async () => {
    const file: TempConfigFile = writeTempConfig(configFor(worker.url, worker.token));
    try {
      worker.failNextRequests(1);
      const io = createIo({
        env: { MEM_CONFIG: file.path },
        fetchImpl: fetch,
        baseDelayMs: 1,
      });

      const code = await main(['append', '故障后重试的记忆'], io);

      expect(code).toBe(0);
      expect(io.stdoutText()).toMatch(/^[A-Z2-7]{26}\n$/);
      expect(worker.requestCount()).toBe(2);
      expect(await worker.count()).toBe(1);
    } finally {
      file.remove();
    }
  });

  it('网络错误同样重试并复用同一个 id', async () => {
    const file = writeTempConfig(configFor(worker.url, worker.token));
    try {
      const realFetch = globalThis.fetch;
      let calls = 0;
      const flaky: typeof fetch = async (input, init) => {
        calls += 1;
        if (calls === 1) throw new TypeError('network down');
        return realFetch(input, init);
      };

      const io = createIo({
        env: { MEM_CONFIG: file.path },
        fetchImpl: flaky,
        baseDelayMs: 1,
      });
      const code = await main(['append', '网络抖动'], io);

      expect(code).toBe(0);
      expect(calls).toBe(2);
      expect(await worker.count()).toBe(1);
      expect(worker.requestCount()).toBe(1); // 只有第二次真正到达 Worker
    } finally {
      file.remove();
    }
  });

  it('未授权不重试，立即失败', async () => {
    const file = writeTempConfig(configFor(worker.url, 'wrong-token'));
    try {
      const io = createIo({
        env: { MEM_CONFIG: file.path },
        fetchImpl: fetch,
        baseDelayMs: 1,
      });
      const code = await main(['append', '错误的 token'], io);

      expect(code).toBe(1);
      expect(worker.requestCount()).toBe(1);
      expect(await worker.count()).toBe(0);
      expect(io.stderrText()).toContain('401');
      expect(io.stderrText()).not.toContain('wrong-token');
    } finally {
      file.remove();
    }
  });

  it('格式错误不重试', async () => {
    const file = writeTempConfig(configFor(worker.url, worker.token));
    try {
      const io = createIo({
        env: { MEM_CONFIG: file.path },
        fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'bad' } }), { status: 400 }),
        baseDelayMs: 1,
      });
      const code = await main(['append', '客户端错误'], io);
      expect(code).toBe(1);
      expect(io.stderrText()).toContain('400');
    } finally {
      file.remove();
    }
  });

  it('服务端持续故障时重试到上限后失败，库中无记录', async () => {
    const file = writeTempConfig(configFor(worker.url, worker.token));
    try {
      worker.failNextRequests(10);
      const io = createIo({
        env: { MEM_CONFIG: file.path },
        fetchImpl: fetch,
        baseDelayMs: 1,
        maxAttempts: 3,
      });
      const code = await main(['append', '持续故障'], io);

      expect(code).toBe(1);
      expect(worker.requestCount()).toBe(3);
      expect(await worker.count()).toBe(0);
      expect(io.stderrText()).toContain('503');
    } finally {
      file.remove();
    }
  });

  it('多库部分失败：逐库报告、已成功的库不回滚、退出码非 0', async () => {
    // work 指向一个必然拒绝连接的端口。
    const file = writeTempConfig(
      configFor(worker.url, worker.token, {
        work: { url: 'http://127.0.0.1:1', token: 'work-token' },
      }),
    );
    try {
      const io = createIo({
        env: { MEM_CONFIG: file.path },
        fetchImpl: fetch,
        baseDelayMs: 1,
        maxAttempts: 2,
      });

      const code = await main(
        ['append', '--vault', 'personal', '--vault', 'work', '部分失败'],
        io,
      );

      expect(code).toBe(1);

      const lines = io.stdoutText().trim().split('\n').map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      const personal = lines.find((line) => line.vault === 'personal');
      const work = lines.find((line) => line.vault === 'work');
      expect(personal).toMatchObject({ ok: true, created: true });
      expect(work).toMatchObject({ ok: false, failure: 'network' });
      expect(personal.id).toBeTruthy();

      // 已成功的库不回滚。
      expect(await worker.count()).toBe(1);
      const stored = await worker.client.execute('SELECT id FROM memories');
      expect(String(stored.rows[0]?.['id'])).toBe(personal.id);
    } finally {
      file.remove();
    }
  });
});
