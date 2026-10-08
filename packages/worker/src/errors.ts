/**
 * 统一的机器可读错误响应。
 *
 * 约定：
 * - 客户端错误（4xx）与服务端错误（5xx）用不同的 `code` 与状态码区分，客户端据此决定是否重试。
 * - 响应体永不含密钥、连接串或堆栈。
 */

/** API 错误码。 */
export type ApiErrorCode =
  | 'invalid_json'
  | 'invalid_request'
  | 'missing_field'
  | 'invalid_field'
  | 'invalid_meta'
  | 'content_too_large'
  | 'id_mismatch'
  | 'unauthorized'
  | 'vault_mismatch'
  | 'not_found'
  | 'method_not_allowed'
  | 'statement_not_allowed'
  | 'sql_error'
  | 'query_timeout'
  | 'server_misconfigured'
  | 'storage_unavailable'
  | 'internal_error';

export type ApiErrorKind = 'client' | 'server';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const;

/** 可安全返回给客户端的错误。 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly kind: ApiErrorKind;
  readonly details: Readonly<Record<string, string | number>> | undefined;

  constructor(
    code: ApiErrorCode,
    status: number,
    message: string,
    kind: ApiErrorKind,
    details?: Readonly<Record<string, string | number>>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.kind = kind;
    this.details = details;
  }
}

/** 组装 JSON 响应。 */
export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * 执行器抛出的查询错误：携带尚未清洗的数据库描述。
 * handler 会先清洗（去掉 URL 与凭据）再转成 `ApiError`。
 */
export class QueryError extends Error {
  readonly apiCode: ApiErrorCode;
  readonly status: number;
  readonly kind: ApiErrorKind;

  constructor(
    apiCode: ApiErrorCode,
    status: number,
    kind: ApiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'QueryError';
    this.apiCode = apiCode;
    this.status = status;
    this.kind = kind;
  }
}

/** 清洗数据库错误描述：抹掉凭据与 URL，并限制长度。 */
export function sanitizeDbMessage(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('***');
  }
  // URL / 主机名样式（scheme://…、方案 A 的 libsql://、wss://）。
  out = out.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'`]+/gi, '<url>');
  return out.length > 500 ? `${out.slice(0, 500)}…` : out;
}

/** 把 `ApiError` 转成响应；`details` 只包含字段名等非敏感信息。 */
export function apiErrorResponse(error: ApiError): Response {
  const payload: { error: { code: string; message: string; details?: Record<string, string | number> } } = {
    error: { code: error.code, message: error.message },
  };
  if (error.details) payload.error.details = { ...error.details };
  return jsonResponse(payload, error.status);
}
