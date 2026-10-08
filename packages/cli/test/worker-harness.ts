/**
 * 测试用本地 Worker + 本地 libSQL 文件库，跑在真实 HTTP 上。
 *
 * 与 `npm test` 里直接调用 handler 不同，这里经由 HTTP，因此可以：
 * - 用 `mem` CLI 端到端跑通；
 * - 注入故障（返回 503），验证 CLI 的重试与幂等。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, type Client } from '@libsql/client';
import { loadMigrations } from '@liushui/core/migrations';
import { countMemories, runMigrations } from '@liushui/core/storage';
import { handleRequest } from '@liushui/worker';
import type { Env } from '@liushui/worker';

export interface LocalWorker {
  url: string;
  token: string;
  client: Client;
  /** 已收到的请求数（含注入故障的那些）。 */
  requestCount(): number;
  /** 让接下来的 n 个请求返回注入的服务端错误。 */
  failNextRequests(count: number): void;
  count(): Promise<number>;
  cleanup(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

export async function startLocalWorker(): Promise<LocalWorker> {
  const dir = mkdtempSync(join(tmpdir(), 'liushui-local-worker-'));
  const file = join(dir, 'mem.db');
  const dbUrl = `file:${file.replaceAll('\\', '/')}`;
  const client = createClient({ url: dbUrl });
  await runMigrations(client, loadMigrations());

  const token = 'local-test-token';
  const env: Env = {
    SERVICE_VERSION: '0.1.0-local',
    LIUSHUI_VAULT_TOKENS: JSON.stringify({
      [token]: { vault: 'personal', url: dbUrl, authToken: '' },
    }),
  };

  let failures = 0;
  let requests = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      requests += 1;

      if (failures > 0) {
        failures -= 1;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: { code: 'storage_unavailable', message: '注入的故障' } }),
        );
        return;
      }

      const body = await readBody(req);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(','));
      }
      const request = new Request(`http://127.0.0.1${req.url ?? '/'}`, {
        method: req.method ?? 'GET',
        headers,
        ...(body ? { body } : {}),
      });

      const response = await handleRequest(request, env, {
        createClient: () => client,
        now: () => new Date('2026-10-08T07:47:09.000Z'),
      });

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      res.writeHead(response.status, responseHeaders);
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'internal_error', message: String(error) } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('无法获取本地端口');
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    token,
    client,
    requestCount: () => requests,
    failNextRequests: (count: number) => {
      failures = count;
    },
    count: () => countMemories(client),
    async cleanup(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      client.close();
      await sleep(20);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await sleep(50);
        }
      }
    },
  };
}
