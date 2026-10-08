import { describe, expect, it } from 'vitest';

import { main } from '../src/main.ts';
import { createFetchStub, createIo, jsonResponse, makeTempDir, writeTempConfig } from './utils.ts';

const CONFIG = {
  env: 'dev',
  environments: {
    dev: {
      defaultVault: 'personal',
      vaults: {
        personal: { url: 'http://worker.test', token: 'personal-token' },
      },
    },
  },
};

const MULTI_CONFIG = {
  env: 'dev',
  environments: {
    dev: {
      defaultVault: 'personal',
      vaults: {
        personal: { url: 'http://personal.test', token: 'personal-token' },
        work: { url: 'http://work.test', token: 'work-token', redact: ['cwd', 'git.repo'] },
      },
    },
  },
};

describe('liushui append（task 5.5）', () => {
  const fakeGit = (args: readonly string[]): string | null => {
    const key = args.join(' ');
    if (key === 'rev-parse --show-toplevel') return '/repo';
    if (key === 'rev-parse --abbrev-ref HEAD') return 'main';
    if (key === 'rev-parse HEAD') return 'a'.repeat(40);
    if (key === 'status --porcelain') return '';
    if (key === 'remote get-url origin') return 'https://user:ghp_x@github.com/org/repo.git';
    return null;
  };

  it('追加一条文本：输出 id、退出码 0、默认 kind=note', async () => {
    const file = writeTempConfig(CONFIG);
    try {
      const stub = createFetchStub((call) =>
        jsonResponse({ id: call.body['id'], created: true }, 201),
      );
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path, LIUSHUI_AUTHOR: 'will', USER: 'ignored' },
        cwd: '/repo',
        fetchImpl: stub.fetchImpl,
        now: () => new Date('2026-10-08T07:47:08.479Z'),
        runGit: () => null,
      });

      const code = await main(['append', '修复了 iOS 渲染问题'], io);

      expect(code).toBe(0);
      expect(io.stdoutText()).toMatch(/^[A-Z2-7]{26}\n$/);
      expect(io.stderrText()).toBe('');
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]?.body).toMatchObject({
        ts: '2026-10-08T07:47:08.479Z',
        author: 'will',
        kind: 'note',
        content: '修复了 iOS 渲染问题',
      });
      expect(stub.calls[0]?.body['meta']).toMatchObject({ cwd: '/repo', src: 'cli' });
      expect(stub.calls[0]?.body['id']).toBe(io.stdoutText().trim());
    } finally {
      file.remove();
    }
  });

  it('内容为空时以非 0 退出且不发出请求', async () => {
    const file = writeTempConfig(CONFIG);
    try {
      const stub = createFetchStub(() => jsonResponse({ id: 'x', created: true }));
      const io = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: stub.fetchImpl });

      expect(await main(['append', ''], io)).not.toBe(0);
      expect(io.stderrText()).toContain('内容不能为空');
      expect(stub.calls).toHaveLength(0);

      const io2 = createIo({ env: { LIUSHUI_CONFIG: file.path }, fetchImpl: stub.fetchImpl });
      expect(await main(['append', '   '], io2)).not.toBe(0);
      expect(stub.calls).toHaveLength(0);
    } finally {
      file.remove();
    }
  });

  it('--kind 覆盖默认值，内容可由多个位置参数拼接', async () => {
    const file = writeTempConfig(CONFIG);
    try {
      const stub = createFetchStub((call) =>
        jsonResponse({ id: call.body['id'], created: true }, 201),
      );
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        fetchImpl: stub.fetchImpl,
        now: () => new Date('2026-10-08T07:47:08.479Z'),
      });
      const code = await main(['append', '--kind', 'retrieval_feedback', '两段', '文本'], io);
      expect(code).toBe(0);
      expect(stub.calls[0]?.body['kind']).toBe('retrieval_feedback');
      expect(stub.calls[0]?.body['content']).toBe('两段 文本');
    } finally {
      file.remove();
    }
  });

  it('多库提交：id 相同、meta 按库脱敏、输出 JSONL', async () => {
    const file = writeTempConfig(MULTI_CONFIG);
    try {
      const stub = createFetchStub((call) =>
        jsonResponse({ id: call.body['id'], created: true }, 201),
      );
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        cwd: '/repo',
        fetchImpl: stub.fetchImpl,
        now: () => new Date('2026-10-08T07:47:08.479Z'),
        runGit: fakeGit,
      });

      const code = await main(
        ['append', '--vault', 'personal,work', '同一记忆'],
        io,
      );

      expect(code).toBe(0);
      expect(stub.calls).toHaveLength(2);

      const personalBody = stub.calls[0]!.body;
      const workBody = stub.calls[1]!.body;
      expect(personalBody['id']).toBe(workBody['id']);
      expect((personalBody['meta'] as Record<string, unknown>)['cwd']).toBe('/repo');
      expect((workBody['meta'] as Record<string, unknown>)['cwd']).toBeUndefined();
      expect((personalBody['meta'] as { git: Record<string, unknown> }).git['repo']).toBe(
        'github.com/org/repo.git',
      );
      expect((workBody['meta'] as { git: Record<string, unknown> }).git['repo']).toBeUndefined();
      expect((workBody['meta'] as { git: Record<string, unknown> }).git['branch']).toBe('main');
      expect(JSON.stringify(stub.calls)).not.toContain('ghp_x');

      const lines = io.stdoutText().trim().split('\n').map((line) => JSON.parse(line));
      expect(lines).toEqual([
        { vault: 'personal', ok: true, id: personalBody['id'], created: true },
        { vault: 'work', ok: true, id: workBody['id'], created: true },
      ]);
    } finally {
      file.remove();
    }
  });

  it('重复提交同一记忆时服务端返回 created=false，命令仍成功', async () => {
    const file = writeTempConfig(CONFIG);
    try {
      const stub = createFetchStub((call) =>
        jsonResponse({ id: call.body['id'], created: false }, 200),
      );
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        fetchImpl: stub.fetchImpl,
        now: () => new Date('2026-10-08T07:47:08.479Z'),
      });
      expect(await main(['append', '重复内容'], io)).toBe(0);
      expect(io.stdoutText().trim()).toHaveLength(26);
    } finally {
      file.remove();
    }
  });

  it('--version 与 --help 不发出请求', async () => {
    const io = createIo({});
    expect(await main(['--version'], io)).toBe(0);
    expect(io.stdoutText().trim()).toMatch(/^\d+\.\d+\.\d+$/);

    const help = createIo({});
    expect(await main(['--help'], help)).toBe(0);
    expect(help.stdoutText()).toContain('liushui append');
  });

  it('非 git 目录追加仍成功，且 meta 不含任何 git.*（memory-cli: 不在 git 仓库内追加）', async () => {
    const file = writeTempConfig(CONFIG);
    const dir = makeTempDir();
    try {
      const stub = createFetchStub((call) =>
        jsonResponse({ id: call.body['id'], created: true }, 201),
      );
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        cwd: dir.dir,
        fetchImpl: stub.fetchImpl,
        now: () => new Date('2026-10-08T07:47:08.479Z'),
      });

      const code = await main(['append', '非 git 目录里的记忆'], io);

      expect(code).toBe(0);
      expect(stub.calls).toHaveLength(1);
      const meta = stub.calls[0]!.body['meta'] as Record<string, unknown>;
      expect(meta['git']).toBeUndefined();
      expect(Object.keys(meta).some((key) => key.startsWith('git'))).toBe(false);
      expect(meta['cwd']).toBe(dir.dir);
    } finally {
      file.remove();
      dir.remove();
    }
  });

  it('未知子命令与未知选项以退出码 2 结束', async () => {
    const io = createIo({});
    expect(await main(['frobnicate'], io)).toBe(2);
    expect(io.stderrText()).toContain('未知子命令');

    const file = writeTempConfig(CONFIG);
    try {
      const io2 = createIo({ env: { LIUSHUI_CONFIG: file.path } });
      expect(await main(['append', '--nope', 'x'], io2)).toBe(2);
      expect(io2.stderrText()).toContain('未知选项');
    } finally {
      file.remove();
    }
  });
});

describe('网络错误的诊断提示（task 1.2）', () => {
  const alwaysNetworkError = createFetchStub(() => {
    throw new TypeError('network down');
  });

  it('单库网络失败时 stderr 带上代理提示', async () => {
    const file = writeTempConfig(CONFIG);
    try {
      const io = createIo({
        env: {
          LIUSHUI_CONFIG: file.path,
          HTTPS_PROXY: 'http://127.0.0.1:7897',
        },
        fetchImpl: alwaysNetworkError.fetchImpl,
        maxAttempts: 1,
        baseDelayMs: 1,
      });

      const code = await main(['append', '代理未启用的记忆'], io);

      expect(code).toBe(1);
      expect(io.stderrText()).toContain('网络错误');
      expect(io.stderrText()).toContain('NODE_USE_ENV_PROXY');
      expect(io.stderrText()).not.toContain('127.0.0.1');
    } finally {
      file.remove();
    }
  });

  it('多库提交时失败库的 JSONL message 也带上提示', async () => {
    const file = writeTempConfig(MULTI_CONFIG);
    try {
      const stub = createFetchStub((call) => {
        if (call.url.startsWith('http://work.test')) throw new TypeError('network down');
        return jsonResponse({ id: call.body['id'], created: true }, 201);
      });
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path, HTTPS_PROXY: 'http://127.0.0.1:7897' },
        fetchImpl: stub.fetchImpl,
        maxAttempts: 1,
        baseDelayMs: 1,
      });

      const code = await main(['append', '--vault', 'personal,work', '一库失败'], io);

      expect(code).toBe(1);
      const lines = io.stdoutText().trim().split('\n').map((line) => JSON.parse(line));
      const personal = lines.find((line) => line.vault === 'personal');
      const work = lines.find((line) => line.vault === 'work');
      expect(personal).toMatchObject({ ok: true });
      expect(work).toMatchObject({ ok: false, failure: 'network' });
      expect(work.message).toContain('NODE_USE_ENV_PROXY');
    } finally {
      file.remove();
    }
  });

  it('客户端错误（4xx）不附加提示', async () => {
    const file = writeTempConfig(CONFIG);
    try {
      const stub = createFetchStub(() =>
        jsonResponse({ error: { code: 'invalid' } }, 400),
      );
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path, HTTPS_PROXY: 'http://127.0.0.1:7897' },
        fetchImpl: stub.fetchImpl,
        maxAttempts: 1,
        baseDelayMs: 1,
      });

      expect(await main(['append', '客户端错误'], io)).toBe(1);
      expect(io.stderrText()).toContain('400');
      expect(io.stderrText()).not.toContain('NODE_USE_ENV_PROXY');
    } finally {
      file.remove();
    }
  });

  it('服务端错误（5xx）不附加提示', async () => {
    const file = writeTempConfig(CONFIG);
    try {
      const stub = createFetchStub(() =>
        jsonResponse({ error: { code: 'storage' } }, 503),
      );
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path, HTTPS_PROXY: 'http://127.0.0.1:7897' },
        fetchImpl: stub.fetchImpl,
        maxAttempts: 1,
        baseDelayMs: 1,
      });

      expect(await main(['append', '服务端错误'], io)).toBe(1);
      expect(io.stderrText()).toContain('503');
      expect(io.stderrText()).not.toContain('NODE_USE_ENV_PROXY');
    } finally {
      file.remove();
    }
  });

  it('未配置代理时网络失败不加提示', async () => {
    const file = writeTempConfig(CONFIG);
    try {
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        fetchImpl: alwaysNetworkError.fetchImpl,
        maxAttempts: 1,
        baseDelayMs: 1,
      });

      expect(await main(['append', '无代理'], io)).toBe(1);
      expect(io.stderrText()).toContain('网络错误');
      expect(io.stderrText()).not.toContain('NODE_USE_ENV_PROXY');
    } finally {
      file.remove();
    }
  });
});
