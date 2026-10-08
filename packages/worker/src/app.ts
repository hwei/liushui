/**
 * Worker 的请求处理：路由、鉴权、校验、幂等追加、统一错误。
 *
 * 处理逻辑与 Cloudflare 运行时解耦：`handleRequest` 只依赖注入的
 * `HandlerDeps`，因此可以在 Node 里用本地 libSQL 文件库做集成测试。
 */

import type { Client } from '@libsql/client';
import { createClient } from '@libsql/client/web';
import { ValidationError, computeId, validateAppendInput } from '@liushui/core';
import { appendMemory } from '@liushui/core/storage';

import { extractBearerToken, findVaultForToken } from './auth.ts';
import { ConfigError, loadConfig, serviceVersion, type Env, type VaultEntry } from './env.ts';
import { ApiError, apiErrorResponse, jsonResponse } from './errors.ts';

/** 注入点：默认用 Worker 的 libSQL web 客户端与真实时钟。 */
export interface HandlerDeps {
  createClient(binding: VaultEntry): Client;
  now(): Date;
}

const defaultDeps: HandlerDeps = {
  createClient: (binding) =>
    binding.authToken
      ? createClient({ url: binding.url, authToken: binding.authToken })
      : createClient({ url: binding.url }),
  now: () => new Date(),
};

function validationToApiError(error: ValidationError): ApiError {
  const details = error.field ? { field: error.field } : undefined;
  if (error.code === 'content_too_large') {
    return new ApiError('content_too_large', 413, error.message, 'client', details);
  }
  if (error.code === 'id_mismatch') {
    return new ApiError('id_mismatch', 400, error.message, 'client', details);
  }
  return new ApiError(error.code, 400, error.message, 'client', details);
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ValidationError) return validationToApiError(error);
  if (error instanceof ConfigError) {
    return new ApiError('server_misconfigured', 500, '服务配置错误', 'server');
  }
  // 其它异常一律折叠成通用服务端错误，避免泄漏内部信息与堆栈。
  return new ApiError('internal_error', 500, '服务内部错误', 'server');
}

function parseJsonBody(text: string): unknown {
  if (text.trim() === '') {
    throw new ApiError('invalid_json', 400, '请求体不能为空', 'client');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('invalid_json', 400, '请求体不是合法 JSON', 'client');
  }
}

function requestedVault(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>)['vault'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError('invalid_field', 400, 'vault 必须是非空字符串', 'client', { field: 'vault' });
  }
  return value;
}

async function handleAppend(
  request: Request,
  env: Env,
  deps: HandlerDeps,
): Promise<Response> {
  const config = loadConfig(env);

  const token = extractBearerToken(request.headers.get('authorization'));
  const binding = token ? await findVaultForToken(config.entries, token) : null;
  if (!binding) {
    // 缺失与无效 token 得到完全相同的响应，不透露任何库的信息。
    throw new ApiError('unauthorized', 401, 'token 无效或缺失', 'client');
  }

  const body = parseJsonBody(await request.text());

  const vault = requestedVault(body);
  if (vault !== undefined && vault !== binding.vault) {
    throw new ApiError('vault_mismatch', 403, '该 token 无权访问指定的库', 'client');
  }

  const input = validateAppendInput(body, { maxContentBytes: config.maxContentBytes });

  const expectedId = await computeId({
    ts: input.ts,
    author: input.author,
    kind: input.kind,
    content: input.content,
  });
  if (expectedId !== input.id) {
    throw new ApiError('id_mismatch', 400, 'id 与核心字段重新计算的结果不一致', 'client', {
      field: 'id',
    });
  }

  let created: boolean;
  try {
    const client = deps.createClient(binding);
    const result = await appendMemory(client, {
      id: input.id,
      ts: input.ts,
      author: input.author,
      kind: input.kind,
      content: input.content,
      meta: input.meta,
      received_at: deps.now().toISOString(),
      schema_v: config.schemaVersion,
    });
    created = result.created;
  } catch {
    // 后端不可用：与客户端错误明确区分，客户端可以安全重试（同 id 幂等）。
    throw new ApiError('storage_unavailable', 503, '存储后端暂时不可用', 'server');
  }

  return jsonResponse({ id: input.id, created }, created ? 201 : 200);
}

/** Worker 的入口。 */
export async function handleRequest(
  request: Request,
  env: Env,
  deps: HandlerDeps = defaultDeps,
): Promise<Response> {
  try {
    const { pathname } = new URL(request.url);
    const method = request.method.toUpperCase();

    if (pathname === '/health') {
      if (method !== 'GET') {
        throw new ApiError('method_not_allowed', 405, '健康检查只支持 GET', 'client');
      }
      // 不鉴权、不访问数据库。
      return jsonResponse({ ok: true, version: serviceVersion(env) }, 200);
    }

    if (pathname === '/append') {
      if (method !== 'POST') {
        throw new ApiError('method_not_allowed', 405, '追加端点只支持 POST', 'client');
      }
      return await handleAppend(request, env, deps);
    }

    throw new ApiError('not_found', 404, '未知端点', 'client');
  } catch (error) {
    return apiErrorResponse(toApiError(error));
  }
}
