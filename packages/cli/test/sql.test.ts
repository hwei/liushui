import { describe, expect, it } from 'vitest';

import { main } from '../src/main.ts';
import { createFetchStub, createIo, jsonResponse, writeTempConfig } from './utils.ts';
import { startLocalWorker } from './worker-harness.ts';

const configFor = (url: string, token = 'cli-secret-token-1234567890') => ({
  env: 'dev',
  environments: {
    dev: {
      defaultVault: 'personal',
      vaults: {
        personal: { url, token },
        work: { url, token: 'work-secret-token-0987654321' },
      },
    },
  },
});

function queryResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vault: 'personal',
    columns: ['id'],
    rows: [['a']],
    truncated: { rows: false, cells: 0 },
    stats: { duration_ms: 1 },
    ...overrides,
  };
}

describe('查询命令（memory-cli 查询命令）', () => {
  it('查询默认库并输出 TSV', async () => {
    const file = writeTempConfig(configFor('https://mem.test'));
    try {
      const stub = createFetchStub(() => jsonResponse(queryResponse(), 200));
      const io = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: stub.fetchImpl });
      const code = await main(['sql', 'SELECT id FROM memories'], io);

      expect(code).toBe(0);
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]!.url).toBe('https://mem.test/sql');
      expect(stub.calls[0]!.body).toMatchObject({ sql: 'SELECT id FROM memories', limit: 50 });
      expect(io.stdoutText()).toBe('id\na\n');
      expect(io.stderrText()).toBe('');
    } finally {
      file.remove();
    }
  });

  it('--arg 作为位置参数发送', async () => {
    const file = writeTempConfig(configFor('https://mem.test'));
    try {
      const stub = createFetchStub(() => jsonResponse(queryResponse(), 200));
      const io = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: stub.fetchImpl });
      const code = await main(['sql', '--arg', 'note', 'SELECT id FROM memories WHERE kind = ?'], io);
      expect(code).toBe(0);
      expect(stub.calls[0]!.body['args']).toEqual(['note']);
    } finally {
      file.remove();
    }
  });

  it('多个 --vault 是用法错误且不发出请求', async () => {
    const file = writeTempConfig(configFor('https://mem.test'));
    try {
      const stub = createFetchStub(() => jsonResponse(queryResponse(), 200));
      const io = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: stub.fetchImpl });
      const code = await main(
        ['sql', '--vault', 'personal', '--vault', 'work', 'SELECT 1'],
        io,
      );
      expect(code).toBe(2);
      expect(stub.calls).toHaveLength(0);
      expect(io.stderrText()).toContain('至多一个');
    } finally {
      file.remove();
    }
  });

  it('从标准输入读取 SQL', async () => {
    const file = writeTempConfig(configFor('https://mem.test'));
    try {
      const stub = createFetchStub(() => jsonResponse(queryResponse(), 200));
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        fetchImpl: stub.fetchImpl,
        readStdin: async () => 'SELECT 42',
      });
      const code = await main(['sql', '-'], io);
      expect(code).toBe(0);
      expect(stub.calls[0]!.body['sql']).toBe('SELECT 42');
    } finally {
      file.remove();
    }
  });

  it('空 SQL 是用法错误且不发出请求', async () => {
    const file = writeTempConfig(configFor('https://mem.test'));
    try {
      const stub = createFetchStub(() => jsonResponse(queryResponse(), 200));
      const io = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: stub.fetchImpl });
      const code = await main(['sql', ''], io);
      expect(code).toBe(2);
      expect(stub.calls).toHaveLength(0);
    } finally {
      file.remove();
    }
  });

  it('未知选项是用法错误', async () => {
    const io = createIo({ env: {} });
    const code = await main(['sql', '--nope', 'SELECT 1'], io);
    expect(code).toBe(2);
    expect(io.stderrText()).toContain('未知选项');
  });
});

describe('查询失败与重试（memory-cli 查询失败与重试）', () => {
  it('SQL 错误不重试，stderr 带出数据库描述，退出码 1', async () => {
    const file = writeTempConfig(configFor('https://mem.test'));
    try {
      const stub = createFetchStub(
        () => jsonResponse({ error: { code: 'sql_error', message: 'no such column: nope' } }, 400),
      );
      const io = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: stub.fetchImpl });
      const code = await main(['sql', 'SELECT nope FROM memories'], io);
      expect(code).toBe(1);
      expect(stub.calls).toHaveLength(1);
      expect(io.stderrText()).toContain('no such column: nope');
      expect(io.stdoutText()).toBe('');
    } finally {
      file.remove();
    }
  });

  it('超时不重试', async () => {
    const file = writeTempConfig(configFor('https://mem.test'));
    try {
      const stub = createFetchStub(
        () => jsonResponse({ error: { code: 'query_timeout', message: '查询超时' } }, 504),
      );
      const io = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: stub.fetchImpl });
      const code = await main(['sql', 'SELECT 1'], io);
      expect(code).toBe(1);
      expect(stub.calls).toHaveLength(1);
    } finally {
      file.remove();
    }
  });

  it('未授权与语句不允许不重试', async () => {
    const file = writeTempConfig(configFor('https://mem.test'));
    try {
      for (const [status, code_] of [
        [401, 'unauthorized'],
        [403, 'vault_mismatch'],
        [400, 'statement_not_allowed'],
      ] as const) {
        const stub = createFetchStub(() =>
          jsonResponse({ error: { code: code_, message: code_ } }, status),
        );
        const io = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: stub.fetchImpl });
        const code = await main(['sql', 'SELECT 1'], io);
        expect(code).toBe(1);
        expect(stub.calls).toHaveLength(1);
      }
    } finally {
      file.remove();
    }
  });

  it('存储暂时不可用后重试成功', async () => {
    const file = writeTempConfig(configFor('https://mem.test'));
    try {
      let n = 0;
      const stub = createFetchStub(() => {
        n += 1;
        if (n === 1) {
          return jsonResponse({ error: { code: 'storage_unavailable', message: 'down' } }, 503);
        }
        return jsonResponse(queryResponse(), 200);
      });
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        fetchImpl: stub.fetchImpl,
        baseDelayMs: 1,
      });
      const code = await main(['sql', 'SELECT id FROM memories'], io);
      expect(code).toBe(0);
      expect(stub.calls).toHaveLength(2);
      expect(io.stdoutText()).toBe('id\na\n');
    } finally {
      file.remove();
    }
  });

  it('网络失败带代理提示，且不泄漏 token', async () => {
    const file = writeTempConfig(configFor('https://mem.test', 'cli-secret-token-1234567890'));
    try {
      const io = createIo({
        env: {
          LIUSHUI_CONFIG: file.path,
          HTTP_PROXY: 'http://proxy.example:8080',
        },
        fetchImpl: async () => {
          throw new TypeError('fetch failed');
        },
        maxAttempts: 1,
        baseDelayMs: 1,
      });
      const code = await main(['sql', 'SELECT 1'], io);
      expect(code).toBe(1);
      expect(io.stderrText()).toContain('NODE_USE_ENV_PROXY');
      expect(io.stderrText()).not.toContain('cli-secret-token-1234567890');
    } finally {
      file.remove();
    }
  });
});

describe('查询输出格式（memory-cli 查询输出格式）', () => {
  it('默认 TSV 转义换行与制表符，NULL 为 \\N', async () => {
    const file = writeTempConfig(configFor('https://mem.test'));
    try {
      const stub = createFetchStub(() =>
        jsonResponse(
          queryResponse({
            columns: ['a', 'b'],
            rows: [
              ['x\ny', 'z\tw'],
              ['back\\slash', null],
            ],
          }),
          200,
        ),
      );
      const io = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: stub.fetchImpl });
      const code = await main(['sql', 'SELECT a, b FROM memories'], io);
      expect(code).toBe(0);
      expect(io.stdoutText()).toBe('a\tb\nx\\ny\tz\\tw\nback\\\\slash\t\\N\n');
    } finally {
      file.remove();
    }
  });

  it('--json 输出 JSONL', async () => {
    const file = writeTempConfig(configFor('https://mem.test'));
    try {
      const stub = createFetchStub(() =>
        jsonResponse(
          queryResponse({ columns: ['id', 'n'], rows: [['a', 1], ['b', 2]] }),
          200,
        ),
      );
      const io = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: stub.fetchImpl });
      const code = await main(['sql', '--json', 'SELECT id, n FROM memories'], io);
      expect(code).toBe(0);
      expect(io.stdoutText()).toBe('{"id":"a","n":1}\n{"id":"b","n":2}\n');
    } finally {
      file.remove();
    }
  });

  it('截断提示只写 stderr，stdout 仍可解析', async () => {
    const file = writeTempConfig(configFor('https://mem.test'));
    try {
      const stub = createFetchStub(() =>
        jsonResponse(
          queryResponse({ columns: ['id'], rows: [['a']], truncated: { rows: true, cells: 2 } }),
          200,
        ),
      );
      const io = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: stub.fetchImpl });
      const code = await main(['sql', '--limit', '10', 'SELECT id FROM memories'], io);
      expect(code).toBe(0);
      expect(io.stdoutText()).toBe('id\na\n');
      expect(io.stderrText()).toContain('结果已截断（行数上限 10）');
      expect(io.stderrText()).toContain('2 个单元格被截断');
    } finally {
      file.remove();
    }
  });

  it('--max-width 按码点截断并加省略号', async () => {
    const file = writeTempConfig(configFor('https://mem.test'));
    try {
      const stub = createFetchStub(() =>
        jsonResponse(queryResponse({ columns: ['c'], rows: [['abcdefghij']] }), 200),
      );
      const io = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: stub.fetchImpl });
      const code = await main(['sql', '--max-width', '5', 'SELECT c FROM memories'], io);
      expect(code).toBe(0);
      expect(io.stdoutText()).toBe('c\nabcd…\n');
      expect(io.stderrText()).toContain('1 个单元格被截断');
    } finally {
      file.remove();
    }
  });

  it('空结果：TSV 只输出表头，JSONL 不输出', async () => {
    const file = writeTempConfig(configFor('https://mem.test'));
    try {
      const empty = queryResponse({ columns: ['id'], rows: [] });
      const tsvStub = createFetchStub(() => jsonResponse(empty, 200));
      const tsvIo = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: tsvStub.fetchImpl });
      expect(await main(['sql', 'SELECT id FROM memories'], tsvIo)).toBe(0);
      expect(tsvIo.stdoutText()).toBe('id\n');

      const jsonStub = createFetchStub(() => jsonResponse(empty, 200));
      const jsonIo = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: jsonStub.fetchImpl });
      expect(await main(['sql', '--json', 'SELECT id FROM memories'], jsonIo)).toBe(0);
      expect(jsonIo.stdoutText()).toBe('');
    } finally {
      file.remove();
    }
  });

  it('查询输出不泄露 token', async () => {
    const file = writeTempConfig(configFor('https://mem.test', 'cli-secret-token-1234567890'));
    try {
      const stub = createFetchStub(() =>
        jsonResponse(
          queryResponse({ columns: ['id'], rows: [['cli-secret-token-1234567890']] }),
          200,
        ),
      );
      const io = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: stub.fetchImpl });
      const code = await main(['sql', 'SELECT id FROM memories'], io);
      expect(code).toBe(0);
      expect(io.stdoutText()).not.toContain('cli-secret-token-1234567890');
      expect(io.stderrText()).not.toContain('cli-secret-token-1234567890');
    } finally {
      file.remove();
    }
  });

  it('worker-harness 端到端：对真实 HTTP Worker 查询本地库', async () => {
    const worker = await startLocalWorker();
    try {
      await worker.client.execute({
        sql: 'INSERT INTO memories (id, ts, author, kind, content, meta, received_at, schema_v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        args: ['harness-1', '2026-06-01T00:00:00.000Z', 'will', 'note', '端到端', '{}', '2026-06-01T00:00:00.000Z', 1],
      });
      const file = writeTempConfig(configFor(worker.url, worker.token));
      try {
        const io = createIo({
          env: { LIUSHUI_CONFIG: file.path },
          fetchImpl: fetch,
          baseDelayMs: 1,
        });
        const code = await main(['sql', 'SELECT id, kind FROM memories ORDER BY ts'], io);
        expect(code).toBe(0);
        expect(io.stdoutText()).toBe('id\tkind\nharness-1\tnote\n');
        expect(io.stderrText()).toBe('');
      } finally {
        file.remove();
      }
    } finally {
      await worker.cleanup();
    }
  });
});
