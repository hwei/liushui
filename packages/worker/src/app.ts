/**
 * Worker 的请求处理：路由、鉴权、校验、幂等追加、统一错误。
 *
 * 处理逻辑与 Cloudflare 运行时解耦：`handleRequest` 只依赖注入的
 * `HandlerDeps`，因此可以在 Node 里用本地 libSQL 文件库做集成测试。
 */

import type { Client } from '@libsql/client';
import { createClient } from '@libsql/client/web';
import {
  QUERY_DEFAULT_LIMIT,
  QUERY_MAX_LIMIT,
  QUERY_TIMEOUT_MS,
  ValidationError,
  checkReadOnlyStatement,
  computeId,
  expandFtsMacros,
  shapeResult,
  validateAppendInput,
  wrapLimit,
} from '@liushui/core';
import { appendMemory } from '@liushui/core/storage';

import { extractBearerToken, findVaultForToken } from './auth.ts';
import {
  ConfigError,
  loadConfig,
  parseVaultReadCreds,
  serviceVersion,
  type Env,
  type VaultEntry,
} from './env.ts';
import { ApiError, QueryError, apiErrorResponse, jsonResponse, sanitizeDbMessage } from './errors.ts';
import { createHranaQueryExecutor, type CreateQueryExecutor, type QueryArg } from './query-executor.ts';

/** 注入点：默认用 Worker 的 libSQL web 客户端、Hrana 只读执行器与真实时钟。 */
export interface HandlerDeps {
  createClient(binding: VaultEntry): Client;
  createQueryExecutor: CreateQueryExecutor;
  now(): Date;
}

const defaultDeps: HandlerDeps = {
  createClient: (binding) =>
    binding.authToken
      ? createClient({ url: binding.url, authToken: binding.authToken })
      : createClient({ url: binding.url }),
  createQueryExecutor: createHranaQueryExecutor,
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

function bodyRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError('invalid_request', 400, '请求体必须是 JSON 对象', 'client');
  }
  return body as Record<string, unknown>;
}

function parseQueryArgs(value: unknown): QueryArg[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ApiError('invalid_field', 400, 'args 必须是数组', 'client', { field: 'args' });
  }
  return value.map((item) => {
    if (item === null || typeof item === 'string') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        throw new ApiError('invalid_field', 400, 'args 只接受有限数值', 'client', { field: 'args' });
      }
      return item;
    }
    throw new ApiError('invalid_field', 400, 'args 只接受 string、number 或 null', 'client', { field: 'args' });
  });
}

function parseQueryLimit(value: unknown): number {
  if (value === undefined) return QUERY_DEFAULT_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ApiError('invalid_field', 400, `limit 必须是 1..${QUERY_MAX_LIMIT} 的整数`, 'client', {
      field: 'limit',
    });
  }
  if (value > QUERY_MAX_LIMIT) {
    throw new ApiError('invalid_field', 400, `limit 不能超过 ${QUERY_MAX_LIMIT}`, 'client', {
      field: 'limit',
    });
  }
  return value;
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/** 每次查询一行 JSON；不含 SQL、参数、结果或凭据。 */
function logSqlUsage(entry: {
  vault: string;
  status: number;
  code?: string;
  rows: number;
  rowsRead?: number;
  durationMs: number;
}): void {
  const payload: Record<string, unknown> = {
    event: 'sql',
    vault: entry.vault,
    status: entry.status,
    rows: entry.rows,
    duration_ms: entry.durationMs,
  };
  if (entry.code !== undefined) payload['code'] = entry.code;
  if (entry.rowsRead !== undefined) payload['rows_read'] = entry.rowsRead;
  console.log(JSON.stringify(payload));
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

/** `POST /sql`：只读查询。 */
async function handleSql(request: Request, env: Env, deps: HandlerDeps): Promise<Response> {
  const startedAt = performance.now();
  let vaultName = 'unknown';
  try {
    const config = loadConfig(env);

    const token = extractBearerToken(request.headers.get('authorization'));
    const binding = token ? await findVaultForToken(config.entries, token) : null;
    if (!binding) {
      throw new ApiError('unauthorized', 401, 'token 无效或缺失', 'client');
    }
    vaultName = binding.vault;

    const body = parseJsonBody(await request.text());
    const requested = requestedVault(body);
    if (requested !== undefined && requested !== binding.vault) {
      throw new ApiError('vault_mismatch', 403, '该 token 无权访问指定的库', 'client');
    }

    const record = bodyRecord(body);
    const rawSql = record['sql'];
    if (rawSql === undefined || rawSql === null) {
      throw new ApiError('missing_field', 400, '缺少必填字段：sql', 'client', { field: 'sql' });
    }
    if (typeof rawSql !== 'string') {
      throw new ApiError('invalid_field', 400, 'sql 必须是字符串', 'client', { field: 'sql' });
    }
    const statement = checkReadOnlyStatement(rawSql);
    const args = parseQueryArgs(record['args']);
    const limit = parseQueryLimit(record['limit']);
    const wrapped = wrapLimit(expandFtsMacros(statement), limit);

    // 只读凭据在 /sql 路径解析；缺失时拒绝服务，绝不回退到写凭据。
    const readCreds = parseVaultReadCreds(env.LIUSHUI_VAULT_READ_CREDS);
    const readCred = readCreds[binding.vault];
    if (!readCred) {
      throw new ApiError('server_misconfigured', 500, '缺少该库的只读凭据', 'server');
    }

    const executor = deps.createQueryExecutor(binding, readCred);
    let execution;
    try {
      execution = await executor.execute(wrapped, args, { timeoutMs: QUERY_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof QueryError) {
        const secrets = [binding.url, readCred.authToken, token ?? ''];
        throw new ApiError(
          error.apiCode,
          error.status,
          sanitizeDbMessage(error.message, secrets),
          error.kind,
        );
      }
      throw new ApiError('storage_unavailable', 503, '存储后端暂时不可用', 'server');
    }

    const shaped = shapeResult(execution.columns, execution.rows, { limit });
    const durationMs = elapsedMs(startedAt);
    const stats: Record<string, number> = { duration_ms: durationMs };
    if (execution.rowsRead !== undefined) stats['rows_read'] = execution.rowsRead;

    logSqlUsage({
      vault: vaultName,
      status: 200,
      rows: shaped.rows.length,
      ...(execution.rowsRead !== undefined ? { rowsRead: execution.rowsRead } : {}),
      durationMs,
    });

    return jsonResponse(
      {
        vault: vaultName,
        columns: shaped.columns,
        rows: shaped.rows,
        truncated: shaped.truncated,
        stats,
      },
      200,
    );
  } catch (error) {
    const api = toApiError(error);
    logSqlUsage({
      vault: vaultName,
      status: api.status,
      code: api.code,
      rows: 0,
      durationMs: elapsedMs(startedAt),
    });
    throw api;
  }
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

    if (pathname === '/sql') {
      if (method !== 'POST') {
        throw new ApiError('method_not_allowed', 405, '查询端点只支持 POST', 'client');
      }
      return await handleSql(request, env, deps);
    }

    throw new ApiError('not_found', 404, '未知端点', 'client');
  } catch (error) {
    return apiErrorResponse(toApiError(error));
  }
}
