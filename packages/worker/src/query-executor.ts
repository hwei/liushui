/**
 * 只读查询执行器（design Decision 4 的方案 A）。
 *
 * 直接 `fetch` Turso/libSQL 的 Hrana HTTP pipeline（`libsql://` → `https://`），
 * 在同一次请求里依次执行 `BEGIN TRANSACTION READONLY`、用户语句、`ROLLBACK`、`close`：
 * - 不做 `COMMIT`，所以即使语句检查被绕过，写入也不会落库；
 * - `rows_written > 0` 视为只读违规，直接拒绝；
 * - 语句结果里的 `rows_read` / `query_duration_ms` 一并带回；
 * - `AbortSignal.timeout` 能真正取消慢查询。
 *
 * 只接受只读凭据；不把凭据或连接地址放进错误信息。
 */

import type { ReadCred, VaultEntry } from './env.ts';
import { QueryError, sanitizeDbMessage } from './errors.ts';

/** 位置参数；与 spec 一致，只允许 string / number / null。 */
export type QueryArg = string | number | null;

export interface QueryExecutionResult {
  columns: string[];
  /** 原始单元格值（未整形）：string / number / bigint / Uint8Array / null。 */
  rows: unknown[][];
  /** 后端报告时才有。 */
  rowsRead?: number;
}

export interface QueryExecuteOptions {
  timeoutMs: number;
}

export interface QueryExecutor {
  execute(
    sql: string,
    args: readonly QueryArg[],
    options: QueryExecuteOptions,
  ): Promise<QueryExecutionResult>;
}

/** 由 `HandlerDeps.createQueryExecutor` 注入：只拿到只读凭据。 */
export type CreateQueryExecutor = (binding: VaultEntry, readCred: ReadCred) => QueryExecutor;

/** 把 libSQL/Turso 地址转成 Hrana HTTP pipeline 端点。 */
export function pipelineEndpoint(url: string): string {
  const trimmed = url.replace(/\/+$/u, '');
  if (trimmed.startsWith('libsql://')) {
    return `https://${trimmed.slice('libsql://'.length)}/v2/pipeline`;
  }
  return `${trimmed}/v2/pipeline`;
}

function encodeArg(arg: QueryArg): Record<string, unknown> {
  if (arg === null) return { type: 'null' };
  if (typeof arg === 'number') {
    return Number.isInteger(arg)
      ? { type: 'integer', value: String(arg) }
      : { type: 'float', value: arg };
  }
  return { type: 'text', value: arg };
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  switch (record['type']) {
    case 'null':
      return null;
    case 'integer': {
      const text = String(record['value']);
      const num = Number(text);
      return Number.isSafeInteger(num) ? num : BigInt(text);
    }
    case 'float':
      return Number(record['value']);
    case 'text':
      return String(record['value']);
    case 'blob':
      return base64ToBytes(String(record['value']));
    default:
      return null;
  }
}

interface HranaError {
  message?: unknown;
  code?: unknown;
}

type StatementOutcome =
  | { kind: 'error'; error: HranaError }
  | { kind: 'ok'; result: Record<string, unknown> }
  | undefined;

function statementOutcome(parsed: unknown): StatementOutcome {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const results = (parsed as Record<string, unknown>)['results'];
  if (!Array.isArray(results)) return undefined;
  const entry = results[1];
  if (typeof entry !== 'object' || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  if (record['type'] === 'error') {
    const error = record['error'];
    return { kind: 'error', error: typeof error === 'object' && error !== null ? (error as HranaError) : {} };
  }
  const response = record['response'];
  if (typeof response !== 'object' || response === null) return undefined;
  const responseRecord = response as Record<string, unknown>;
  if (responseRecord['type'] === 'error') {
    const error = responseRecord['error'];
    return { kind: 'error', error: typeof error === 'object' && error !== null ? (error as HranaError) : {} };
  }
  if (responseRecord['type'] === 'execute') {
    const result = responseRecord['result'];
    return { kind: 'ok', result: typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {} };
  }
  return undefined;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

function isSqlErrorCode(code: string): boolean {
  return code.startsWith('SQL_') || code.startsWith('SQLITE_');
}

function isReadOnlyViolation(code: string, message: string): boolean {
  return code === 'BLOCKED' || code === 'SQLITE_READONLY' || /readonly|read-only|write operations are forbidden/iu.test(message);
}

/** 创建一个走 Hrana HTTP pipeline 的只读执行器。 */
export function createHranaQueryExecutor(binding: VaultEntry, readCred: ReadCred): QueryExecutor {
  const endpoint = pipelineEndpoint(binding.url);
  const secrets = [binding.url, readCred.authToken];

  return {
    async execute(sql, args, options): Promise<QueryExecutionResult> {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (readCred.authToken !== '') headers['authorization'] = `Bearer ${readCred.authToken}`;

      const requests = [
        { type: 'execute', stmt: { sql: 'BEGIN TRANSACTION READONLY' } },
        { type: 'execute', stmt: { sql, args: args.map(encodeArg) } },
        { type: 'execute', stmt: { sql: 'ROLLBACK' } },
        { type: 'close' },
      ];

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ requests }),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        if (isTimeoutError(error)) {
          throw new QueryError('query_timeout', 504, 'server', '查询超时');
        }
        throw new QueryError('storage_unavailable', 503, 'server', '存储后端暂时不可用');
      }

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }

      if (!response.ok) {
        const topLevelError =
          typeof parsed === 'object' && parsed !== null && typeof (parsed as Record<string, unknown>)['error'] === 'string';
        if (topLevelError) {
          // 只读凭据无效/过期：服务端配置问题，不是客户端错误。
          throw new QueryError('server_misconfigured', 500, 'server', '只读凭据无效或已失效');
        }
        throw new QueryError('storage_unavailable', 503, 'server', '存储后端暂时不可用');
      }

      const outcome = statementOutcome(parsed);
      if (!outcome) {
        throw new QueryError('storage_unavailable', 503, 'server', '存储后端响应异常');
      }
      if (outcome.kind === 'error') {
        const code = typeof outcome.error.code === 'string' ? outcome.error.code : '';
        const rawMessage = typeof outcome.error.message === 'string' ? outcome.error.message : 'SQL 执行失败';
        const message = sanitizeDbMessage(rawMessage, secrets);
        if (isReadOnlyViolation(code, message)) {
          throw new QueryError('statement_not_allowed', 400, 'client', message);
        }
        if (isSqlErrorCode(code)) {
          throw new QueryError('sql_error', 400, 'client', message);
        }
        throw new QueryError('storage_unavailable', 503, 'server', message);
      }

      const result = outcome.result;
      const rowsWritten = Number(result['rows_written'] ?? 0);
      if (rowsWritten > 0) {
        throw new QueryError('statement_not_allowed', 400, 'client', '语句不允许：检测到写入');
      }
      const rawColumns = Array.isArray(result['cols']) ? result['cols'] : [];
      const columns = rawColumns.map((col) => String((col as Record<string, unknown>)?.['name'] ?? ''));
      const rawRows = Array.isArray(result['rows']) ? result['rows'] : [];
      const rows = rawRows.map((row) =>
        Array.isArray(row) ? row.map((cell) => decodeValue(cell)) : [],
      );
      const rowsRead = typeof result['rows_read'] === 'number' ? result['rows_read'] : undefined;
      return rowsRead === undefined ? { columns, rows } : { columns, rows, rowsRead };
    },
  };
}
