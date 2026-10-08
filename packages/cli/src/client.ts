/**
 * 与 Worker 通信：`POST /append`，带重试。
 *
 * 重试策略：
 * - 网络错误与服务端错误（5xx）可重试；重试复用同一个 `ts` 与 `id`，靠服务端幂等去重。
 * - 客户端错误（未授权、格式错误、内容过大等 4xx）不重试，立即返回。
 *
 * token 只放在 Authorization 头里，绝不会进入返回消息。
 */

import type { Meta } from '@liushui/core';

import type { ResolvedVault } from './config.ts';
import { scrubSecrets } from './errors.ts';

/** 发往 Worker 的一条记录（received_at / schema_v 由服务端补）。 */
export interface AppendPayload {
  id: string;
  ts: string;
  author: string;
  kind: string;
  content: string;
  meta: Meta;
}

/** 追加失败的分类。 */
export type AppendFailureKind = 'client' | 'server' | 'network';

export interface AppendSuccess {
  ok: true;
  id: string;
  created: boolean;
  attempts: number;
}

export interface AppendFailure {
  ok: false;
  kind: AppendFailureKind;
  status: number | null;
  code: string | null;
  message: string;
  attempts: number;
}

export type AppendOutcome = AppendSuccess | AppendFailure;

export interface PostAppendOptions {
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface ErrorBody {
  error?: { code?: string; message?: string };
}

async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === 'object' && parsed !== null) return parsed as ErrorBody;
  } catch {
    // 忽略无法解析的响应体。
  }
  return {};
}

/** 追加一条记录到某个库；按需重试。 */
export async function postAppend(
  vault: ResolvedVault,
  payload: AppendPayload,
  options: PostAppendOptions = {},
): Promise<AppendOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const sleep = options.sleep ?? defaultSleep;
  const scrub = (text: string): string => scrubSecrets(text, [vault.token]);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${vault.url}/append`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${vault.token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        const body = (await response.json()) as { id?: string; created?: boolean };
        return {
          ok: true,
          id: typeof body.id === 'string' ? body.id : payload.id,
          created: body.created === true,
          attempts: attempt,
        };
      }

      const errorBody = await readErrorBody(response);
      const code = errorBody.error?.code ?? null;

      if (response.status >= 500) {
        const message = scrub(
          `服务端错误 ${response.status}${code ? ` (${code})` : ''}`,
        );
        if (attempt < maxAttempts) {
          await sleep(baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        return { ok: false, kind: 'server', status: response.status, code, message, attempts: attempt };
      }

      // 客户端错误：不重试。
      return {
        ok: false,
        kind: 'client',
        status: response.status,
        code,
        message: scrub(`客户端错误 ${response.status}${code ? ` (${code})` : ''}`),
        attempts: attempt,
      };
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const message = scrub(`网络错误：${detail}`);
      if (attempt < maxAttempts) {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
        continue;
      }
      return { ok: false, kind: 'network', status: null, code: null, message, attempts: attempt };
    }
  }

  // 循环必然在上面 return，这里只是让类型收敛。
  return {
    ok: false,
    kind: 'network',
    status: null,
    code: null,
    message: '未知错误',
    attempts: maxAttempts,
  };
}
