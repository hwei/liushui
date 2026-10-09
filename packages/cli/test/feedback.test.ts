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

const VALID_ID_1 = 'RYRP4645Q2VOLZ4DOVYPLUKVA4';
const VALID_ID_2 = 'BCDEFGHJKMNPQRSTVWXYZ23456';

describe('liushui feedback (task 2.2)', () => {
  let worker: LocalWorker;
  beforeEach(async () => {
    worker = await startLocalWorker();
  });
  afterEach(async () => {
    await worker.cleanup();
  });

  it('Scenario: 写入一条反馈 (包含自动获取 service_version 并规范化 JSON)', async () => {
    const file: TempConfigFile = writeTempConfig(configFor(worker.url, worker.token));
    try {
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        fetchImpl: fetch,
      });

      const feedbackPayload = {
        v: 1,
        intent: '上次 iOS 渲染问题怎么查的',
        queries: [
          {
            sql: "SELECT id FROM memories WHERE content LIKE '%渲染%'",
            outcome: '0 行',
          },
        ],
      };

      const code = await main(['feedback', JSON.stringify(feedbackPayload)], io);
      expect(code).toBe(0);

      const returnedId = io.stdoutText().trim();
      expect(returnedId).toMatch(/^[A-Z2-7]{26}$/);

      // 验证写入数据库的记录
      expect(await worker.count()).toBe(1);
      const row = (
        await worker.client.execute({
          sql: 'SELECT id, kind, content FROM memories WHERE id = ?',
          args: [returnedId],
        })
      ).rows[0];

      expect(row).toBeDefined();
      expect(row?.['kind']).toBe('retrieval_feedback');

      const parsedContent = JSON.parse(String(row?.['content']));
      expect(parsedContent.intent).toBe('上次 iOS 渲染问题怎么查的');
      // harness 中 env.SERVICE_VERSION 是 '0.1.0-local'
      expect(parsedContent.service_version).toBe('0.1.0-local');
      expect(parsedContent.v).toBe(1);

      // 键排序与紧凑 JSON 格式检查
      const contentStr = String(row?.['content']);
      expect(contentStr).not.toContain('\n');
      expect(contentStr).not.toContain('  ');
    } finally {
      file.remove();
    }
  });

  it('Scenario: 从标准输入读取反馈 JSON', async () => {
    const file = writeTempConfig(configFor(worker.url, worker.token));
    try {
      const feedbackPayload = {
        v: 1,
        intent: '通过 stdin 输入的反馈',
        queries: [{ sql: 'SELECT 1' }],
      };

      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        fetchImpl: fetch,
        readStdin: async () => JSON.stringify(feedbackPayload),
      });

      const code = await main(['feedback', '-'], io);
      expect(code).toBe(0);
      expect(io.stdoutText().trim()).toMatch(/^[A-Z2-7]{26}$/);
      expect(await worker.count()).toBe(1);
    } finally {
      file.remove();
    }
  });

  it('Scenario: 多库被拒绝', async () => {
    const file = writeTempConfig(
      configFor(worker.url, worker.token, {
        work: { url: worker.url, token: 'work-token' },
      }),
    );
    try {
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        fetchImpl: fetch,
      });

      const feedbackJson = JSON.stringify({
        v: 1,
        intent: '多库测试',
        queries: [{ sql: 'SELECT 1' }],
      });

      const code = await main(['feedback', '--vault', 'personal', '--vault', 'work', feedbackJson], io);
      expect(code).toBe(2);
      expect(io.stderrText()).toContain('至多只能指定一个库');
      expect(worker.requestCount()).toBe(0);
    } finally {
      file.remove();
    }
  });

  it('Scenario: 不是 JSON', async () => {
    const file = writeTempConfig(configFor(worker.url, worker.token));
    try {
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        fetchImpl: fetch,
      });

      const code = await main(['feedback', '搜不到渲染相关的记忆'], io);
      expect(code).toBe(2);
      expect(io.stderrText()).toContain('合法的 JSON');
      expect(io.stderrText()).toContain('skills/liushui/SKILL.md');
      expect(worker.requestCount()).toBe(0);
    } finally {
      file.remove();
    }
  });

  it('Scenario: 字段不合规', async () => {
    const file = writeTempConfig(configFor(worker.url, worker.token));
    try {
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        fetchImpl: fetch,
      });

      const badFeedback = JSON.stringify({
        v: 1,
        intent: '缺少 queries 的反馈',
      });

      const code = await main(['feedback', badFeedback], io);
      expect(code).toBe(2);
      expect(io.stderrText()).toContain('queries');
      expect(worker.requestCount()).toBe(0);
    } finally {
      file.remove();
    }
  });

  it('Scenario: 键顺序不影响写入内容', async () => {
    const file = writeTempConfig(configFor(worker.url, worker.token));
    try {
      const jsonA = `{
        "service_version": "1.0.0",
        "queries": [{"sql": "SELECT 1"}],
        "v": 1,
        "intent": "幂等测试"
      }`;

      const jsonB = `{
        "intent": "幂等测试",
        "v": 1,
        "queries": [{"sql": "SELECT 1"}],
        "service_version": "1.0.0"
      }`;

      const ioA = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: fetch });
      const codeA = await main(['feedback', jsonA], ioA);
      expect(codeA).toBe(0);

      const ioB = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: fetch });
      const codeB = await main(['feedback', jsonB], ioB);
      expect(codeB).toBe(0);

      const rows = (await worker.client.execute('SELECT content FROM memories')).rows;
      expect(rows).toHaveLength(2);
      expect(rows[0]?.['content']).toBe(rows[1]?.['content']);
    } finally {
      file.remove();
    }
  });

  it('Scenario: 输入已提供 service_version 时原样保留', async () => {
    const file = writeTempConfig(configFor(worker.url, worker.token));
    try {
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        fetchImpl: fetch,
      });

      const feedback = JSON.stringify({
        v: 1,
        intent: '自带版本号',
        queries: [{ sql: 'SELECT 1' }],
        service_version: '9.9.9-custom',
      });

      const code = await main(['feedback', feedback], io);
      expect(code).toBe(0);

      const row = (await worker.client.execute('SELECT content FROM memories')).rows[0];
      const parsed = JSON.parse(String(row?.['content']));
      expect(parsed.service_version).toBe('9.9.9-custom');
    } finally {
      file.remove();
    }
  });

  it('Scenario: 读不到版本时仍然写入且不含 service_version，stderr 有一行提示', async () => {
    const file = writeTempConfig(configFor(worker.url, worker.token));
    try {
      // 拦截 /health 请求让其失败
      const realFetch = globalThis.fetch;
      const mockFetch: typeof fetch = async (input, init) => {
        if (String(input).includes('/health')) {
          return new Response('Unavailable', { status: 503 });
        }
        return realFetch(input, init);
      };

      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        fetchImpl: mockFetch,
      });

      const feedback = JSON.stringify({
        v: 1,
        intent: '读不到版本测试',
        queries: [{ sql: 'SELECT 1' }],
      });

      const code = await main(['feedback', feedback], io);
      expect(code).toBe(0);
      expect(io.stderrText()).toContain('无法从 personal 对应服务获取版本号');

      const row = (await worker.client.execute('SELECT content FROM memories')).rows[0];
      const parsed = JSON.parse(String(row?.['content']));
      expect(parsed.service_version).toBeUndefined();
    } finally {
      file.remove();
    }
  });

  it('写入补充记录', async () => {
    const file = writeTempConfig(configFor(worker.url, worker.token));
    try {
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        fetchImpl: fetch,
      });

      const refine = JSON.stringify({
        v: 1,
        refines: VALID_ID_1,
        expected_ids: [VALID_ID_2],
        note: '补充的期望记录',
      });

      const code = await main(['feedback', refine], io);
      expect(code).toBe(0);

      const row = (await worker.client.execute('SELECT kind, content FROM memories')).rows[0];
      expect(row?.['kind']).toBe('retrieval_feedback');
      const parsed = JSON.parse(String(row?.['content']));
      expect(parsed.refines).toBe(VALID_ID_1);
      expect(parsed.expected_ids).toEqual([VALID_ID_2]);
      expect(parsed.note).toBe('补充的期望记录');
    } finally {
      file.remove();
    }
  });

  it('输出与诊断不含 token', async () => {
    const file = writeTempConfig(configFor(worker.url, worker.token));
    try {
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        fetchImpl: fetch,
      });

      await main(
        [
          'feedback',
          JSON.stringify({
            v: 1,
            intent: 'token 测试',
            queries: [{ sql: 'SELECT 1' }],
          }),
        ],
        io,
      );

      expect(io.stdoutText()).not.toContain(worker.token);
      expect(io.stderrText()).not.toContain(worker.token);
    } finally {
      file.remove();
    }
  });
});
