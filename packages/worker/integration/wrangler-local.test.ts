/**
 * 在 wrangler 本地模式下、以本地 libSQL 文件库跑通 API 集成测试。
 *
 * 与 `npm test`（Node 内直接调用 handler）不同，这里验证的是真实链路：
 * workerd 运行时 + wrangler dev + @libsql/client/web + 本地 sqld（Docker）+ 两个独立库。
 *
 * 运行：npm run test:worker-integration
 * 依赖：本机有可用的 Docker（否则整组测试跳过）。
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createClient, type Client } from '@libsql/client';
import { computeId } from '@liushui/core';
import { loadMigrations } from '@liushui/core/migrations';
import { runMigrations } from '@liushui/core/storage';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = join(HERE, '..');
const SQDL_IMAGE = 'ghcr.io/tursodatabase/libsql-server:latest';

const PERSONAL_TOKEN = 'it-personal-token';
const WORK_TOKEN = 'it-work-token';
const SERVICE_VERSION = '0.1.0-it';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`${label} 在 ${timeoutMs}ms 内未就绪${lastError ? `: ${String(lastError)}` : ''}`);
}

interface VaultRuntime {
  name: string;
  token: string;
  port: number;
  container: string;
  client: Client;
}

interface AppendResponse {
  status: number;
  body: { id?: string; created?: boolean; error?: { code?: string } };
}

async function append(
  baseUrl: string,
  token: string | null,
  payload: Record<string, unknown>,
): Promise<AppendResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}/append`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as AppendResponse['body'] };
}

async function countRows(client: Client): Promise<number> {
  const result = await client.execute('SELECT COUNT(*) AS n FROM memories');
  return Number(result.rows[0]?.['n'] ?? 0);
}

test(
  'wrangler 本地模式 + 本地 libSQL：鉴权、幂等与两库隔离（task 4.5）',
  { timeout: 300_000, skip: dockerAvailable() ? false : '本机没有可用的 Docker' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'liushui-it-'));
    const workDir = join(WORKER_DIR, '.wrangler-it');
    const containers: string[] = [];
    let wrangler: ChildProcess | undefined;
    const clients: Client[] = [];

    try {
      // 1. 两个独立的本地 libSQL 服务，各挂一个文件库。
      const runtimes: VaultRuntime[] = [];
      for (const [name, token] of [
        ['personal', PERSONAL_TOKEN],
        ['work', WORK_TOKEN],
      ] as const) {
        const dbDir = join(root, `${name}-db`);
        mkdirSync(dbDir, { recursive: true });
        const port = await freePort();
        const container = `liushui-it-${name}-${process.pid}`;
        execFileSync(
          'docker',
          [
            'run',
            '-d',
            '--name',
            container,
            '-p',
            `127.0.0.1:${port}:8080`,
            '-e',
            'SQLD_DB_PATH=/var/lib/sqld',
            '-v',
            `${dbDir}:/var/lib/sqld`,
            SQDL_IMAGE,
          ],
          { stdio: 'ignore' },
        );
        containers.push(container);
        const client = createClient({ url: `http://127.0.0.1:${port}` });
        clients.push(client);
        runtimes.push({ name, token, port, container, client });
      }

      for (const runtime of runtimes) {
        await waitFor(`sqld(${runtime.name})`, async () => {
          await runtime.client.execute('SELECT 1');
          return true;
        });
        const applied = await runMigrations(runtime.client, loadMigrations());
        assert.deepEqual(applied, [1], `${runtime.name} 库应应用迁移 1`);
      }

      // 2. wrangler dev（本地模式）指向这两个库。
      const personal = runtimes[0]!;
      const work = runtimes[1]!;
      mkdirSync(workDir, { recursive: true });
      writeFileSync(
        join(workDir, 'wrangler.toml'),
        [
          'name = "liushui-mem-it"',
          `main = ${JSON.stringify(join(WORKER_DIR, 'src', 'index.ts'))}`,
          'compatibility_date = "2026-10-08"',
          '',
          '[vars]',
          `SERVICE_VERSION = ${JSON.stringify(SERVICE_VERSION)}`,
          '',
        ].join('\n'),
      );
      const tokens: Record<string, { vault: string; url: string; authToken: string }> = {};
      for (const runtime of runtimes) {
        tokens[runtime.token] = {
          vault: runtime.name,
          url: `http://127.0.0.1:${runtime.port}`,
          authToken: '',
        };
      }
      writeFileSync(
        join(workDir, '.dev.vars'),
        `MEM_VAULT_TOKENS=${JSON.stringify(tokens)}\n`,
      );

      const workerPort = await freePort();
      const baseUrl = `http://127.0.0.1:${workerPort}`;
      const wranglerCli = createRequire(import.meta.url).resolve('wrangler');
      wrangler = spawn(
        process.execPath,
        [
          wranglerCli,
          'dev',
          '--config',
          join(workDir, 'wrangler.toml'),
          '--ip',
          '127.0.0.1',
          '--port',
          String(workerPort),
          '--persist-to',
          join(root, 'wrangler-state'),
        ],
        {
          cwd: WORKER_DIR,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let wranglerLog = '';
      wrangler.stdout?.on('data', (chunk: Buffer) => {
        wranglerLog += chunk.toString();
      });
      wrangler.stderr?.on('data', (chunk: Buffer) => {
        wranglerLog += chunk.toString();
      });

      await waitFor(
        'wrangler dev',
        async () => {
          const response = await fetch(`${baseUrl}/health`);
          if (response.status !== 200) return false;
          const body = (await response.json()) as { version?: string };
          return body.version === SERVICE_VERSION;
        },
        120_000,
      ).catch((error: unknown) => {
        throw new Error(`${String(error)}\n--- wrangler 输出 ---\n${wranglerLog}`);
      });

      // 3. 健康检查。
      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true, version: SERVICE_VERSION });

      // 4. 新写入 + 幂等重试 + 只落在个人库。
      const core = {
        ts: '2026-10-08T07:47:08.479Z',
        author: 'will',
        kind: 'note',
        content: 'wrangler 本地模式集成测试',
      };
      const id = await computeId(core);
      const payload = { id, ...core, meta: { git: { branch: 'main' }, cwd: '/repo' } };

      const first = await append(baseUrl, PERSONAL_TOKEN, payload);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.deepEqual(first.body, { id, created: true });

      const retry = await append(baseUrl, PERSONAL_TOKEN, { ...payload, meta: { cwd: '/other' } });
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.deepEqual(retry.body, { id, created: false });

      assert.equal(await countRows(personal.client), 1, '个人库应只有一条记录');
      assert.equal(await countRows(work.client), 0, '公司库不应出现该记录');

      const stored = await personal.client.execute({
        sql: 'SELECT id, meta, received_at, schema_v FROM memories WHERE id = ?',
        args: [id],
      });
      assert.equal(stored.rows.length, 1);
      assert.equal(JSON.parse(String(stored.rows[0]!['meta']))['git']['branch'], 'main');
      assert.match(String(stored.rows[0]!['received_at']), /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(Number(stored.rows[0]!['schema_v']), 1);

      // 5. 跨库访问被拒绝，两个库都无变化。
      const cross = await append(baseUrl, PERSONAL_TOKEN, { ...payload, vault: 'work' });
      assert.equal(cross.status, 403);
      assert.equal(cross.body.error?.code, 'vault_mismatch');
      assert.equal(await countRows(personal.client), 1);
      assert.equal(await countRows(work.client), 0);

      // 6. 公司库 token 写入公司库，id 与个人库相同。
      const workWrite = await append(baseUrl, WORK_TOKEN, payload);
      assert.equal(workWrite.status, 201, JSON.stringify(workWrite.body));
      assert.equal(workWrite.body.id, id);
      assert.equal(await countRows(work.client), 1);
      assert.equal(await countRows(personal.client), 1);

      // 7. 未授权。
      const unauthorized = await append(baseUrl, null, payload);
      assert.equal(unauthorized.status, 401);
      assert.equal(unauthorized.body.error?.code, 'unauthorized');
    } finally {
      if (wrangler && wrangler.exitCode === null) {
        if (process.platform === 'win32' && wrangler.pid !== undefined) {
          try {
            execFileSync('taskkill', ['/PID', String(wrangler.pid), '/T', '/F'], { stdio: 'ignore' });
          } catch {
            wrangler.kill('SIGKILL');
          }
        } else {
          wrangler.kill('SIGKILL');
        }
      }
      for (const client of clients) client.close();
      for (const container of containers) {
        try {
          execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
        } catch {
          // 容器可能已不存在，忽略。
        }
      }
      rmSync(workDir, { recursive: true, force: true });
      await sleep(200);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
