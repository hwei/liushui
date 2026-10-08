/**
 * 校验与领域错误。
 *
 * 所有错误都带有机器可读的 `code`，供 Worker 转换成 API 错误响应，
 * 也供 CLI 判断是否值得重试。
 */

/** 校验/请求层面的错误码。 */
export type ValidationErrorCode =
  | 'invalid_request'
  | 'missing_field'
  | 'invalid_field'
  | 'content_too_large'
  | 'invalid_meta'
  | 'id_mismatch';

/** 表示输入不合法；`field` 指向出问题的字段（若可定位）。 */
export class ValidationError extends Error {
  readonly code: ValidationErrorCode;
  readonly field: string | undefined;

  constructor(code: ValidationErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.field = field;
  }
}
