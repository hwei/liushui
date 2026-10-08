/**
 * 记录模型与输入校验。
 *
 * 字段定义见 openspec/changes/core-append-store/specs/memory-ledger。
 * 本模块同时被 Worker（校验请求）与 CLI（组装记录）使用。
 */

import { normalizeTs } from './canonical.ts';
import { ValidationError } from './errors.ts';

/** 当前 schema 版本，写入每条记录的 `schema_v`。 */
export const SCHEMA_VERSION = 1;

/** `content` 的默认大小上限（UTF-8 字节）。 */
export const DEFAULT_MAX_CONTENT_BYTES = 128 * 1024;

/** `kind` 的默认值。 */
export const DEFAULT_KIND = 'note';

/** 允许的 meta 值：JSON 原生类型，或嵌套的键值对象。 */
export type MetaValue = string | number | boolean | null | Meta;

/** 可自由增删字段的 meta（点号分层命名，如 `git.branch`）。 */
export interface Meta {
  [key: string]: MetaValue;
}

/** 库中的一条记忆。 */
export interface MemoryRecord {
  id: string;
  ts: string;
  author: string;
  kind: string;
  content: string;
  meta: Meta;
  /** 服务端接收时刻（UTC 毫秒 ISO），不参与 ID。 */
  received_at: string;
  schema_v: number;
}

/** 客户端提交的追加请求。 */
export interface AppendRequest {
  id: string;
  ts: string;
  author: string;
  kind: string;
  content: string;
  meta?: Meta;
}

/** 校验并规范化后的追加请求。 */
export interface ValidatedAppend {
  id: string;
  ts: string;
  author: string;
  kind: string;
  content: string;
  meta: Meta;
}

/** 校验选项。 */
export interface ValidateOptions {
  maxContentBytes?: number;
}

const MAX_META_DEPTH = 16;

/** UTF-8 字节长度。 */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** 判断是否为“普通对象”（排除数组、null、类实例）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireString(
  source: Record<string, unknown>,
  field: string,
  allowEmpty: boolean,
): string {
  if (!(field in source) || source[field] === undefined || source[field] === null) {
    throw new ValidationError('missing_field', `缺少必填字段：${field}`, field);
  }
  const value = source[field];
  if (typeof value !== 'string') {
    throw new ValidationError('invalid_field', `字段 ${field} 必须是字符串`, field);
  }
  if (!allowEmpty && value.length === 0) {
    throw new ValidationError('invalid_field', `字段 ${field} 不能为空`, field);
  }
  return value;
}

/**
 * 校验并规范化 meta：必须是键值对象，值只能是 JSON 原生类型或嵌套键值对象。
 * 值为 `undefined` 的键 MUST 省略，而不是写入占位。
 */
export function validateMeta(value: unknown, path = 'meta', depth = 0): Meta {
  if (!isPlainObject(value)) {
    throw new ValidationError('invalid_meta', `${path} 必须是键值对象`, path);
  }
  if (depth > MAX_META_DEPTH) {
    throw new ValidationError('invalid_meta', `${path} 嵌套过深`, path);
  }
  const out: Meta = {};
  for (const [key, raw] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (raw === undefined) {
      throw new ValidationError(
        'invalid_meta',
        `${childPath} 的值为 undefined，应省略该键`,
        childPath,
      );
    }
    out[key] = validateMetaValue(raw, childPath, depth + 1);
  }
  return out;
}

function validateMetaValue(raw: unknown, path: string, depth: number): MetaValue {
  if (raw === null || typeof raw === 'string' || typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      throw new ValidationError('invalid_meta', `${path} 必须是有限数值`, path);
    }
    return raw;
  }
  if (Array.isArray(raw)) {
    throw new ValidationError('invalid_meta', `${path} 不支持数组`, path);
  }
  if (isPlainObject(raw)) return validateMeta(raw, path, depth);
  throw new ValidationError('invalid_meta', `${path} 的值类型不受支持`, path);
}

/**
 * 校验一条追加请求。缺字段、类型错误、内容超限、meta 非法都会被拒绝，
 * 并抛出带 `field` 的 `ValidationError`。
 */
export function validateAppendInput(
  input: unknown,
  options: ValidateOptions = {},
): ValidatedAppend {
  if (!isPlainObject(input)) {
    throw new ValidationError('invalid_request', '请求体必须是 JSON 对象');
  }
  const maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;

  const id = requireString(input, 'id', false);
  const ts = normalizeTs(requireString(input, 'ts', false));
  const author = requireString(input, 'author', false);
  const kind = requireString(input, 'kind', false);
  const content = requireString(input, 'content', true);

  const size = utf8ByteLength(content);
  if (size > maxContentBytes) {
    throw new ValidationError(
      'content_too_large',
      `content 为 ${size} 字节，超过上限 ${maxContentBytes} 字节`,
      'content',
    );
  }

  const meta = input['meta'] === undefined ? {} : validateMeta(input['meta']);

  return { id, ts, author, kind, content, meta };
}
