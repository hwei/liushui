import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliIo } from '../src/main.ts';

export interface CapturedIo extends CliIo {
  stdoutText(): string;
  stderrText(): string;
}

export interface IoOptions extends Partial<Omit<CliIo, 'stdout' | 'stderr'>> {
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/** 构建一个把输出收集到内存的 CLI 运行环境。 */
export function createIo(options: IoOptions = {}): CapturedIo {
  let out = '';
  let err = '';
  return {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    stdoutText: () => out,
    stderrText: () => err,
    env: options.env ?? {},
    cwd: options.cwd ?? process.cwd(),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.runGit !== undefined ? { runGit: options.runGit } : {}),
    ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.baseDelayMs !== undefined ? { baseDelayMs: options.baseDelayMs } : {}),
  };
}

export interface CapturedRequest {
  url: string;
  token: string | undefined;
  body: Record<string, unknown>;
}

export interface FetchStub {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
}

/** 一个记录请求并按脚本响应的 fetch stub。 */
export function createFetchStub(
  handler: (call: CapturedRequest, index: number) => Response | Promise<Response>,
): FetchStub {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    const call: CapturedRequest = {
      url: String(input),
      token: headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? undefined,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** 构造一个包含完整 meta 的合法响应体。 */
export function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface TempConfigFile {
  path: string;
  dir: string;
  remove(): void;
}

/** 写一个临时配置文件。 */
export function writeTempConfig(config: unknown): TempConfigFile {
  const dir = mkdtempSync(join(tmpdir(), 'liushui-cli-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  return {
    path,
    dir,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 创建一个临时目录（可指定子目录名）。 */
export function makeTempDir(): { dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'liushui-cli-'));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
