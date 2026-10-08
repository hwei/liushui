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

/** 把 `ApiError` 转成响应；`details` 只包含字段名等非敏感信息。 */
export function apiErrorResponse(error: ApiError): Response {
  const payload: { error: { code: string; message: string; details?: Record<string, string | number> } } = {
    error: { code: error.code, message: error.message },
  };
  if (error.details) payload.error.details = { ...error.details };
  return jsonResponse(payload, error.status);
}
