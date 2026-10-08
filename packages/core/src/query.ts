/**
 * 只读 SQL 查询的纯函数：单语句检查、LIMIT 包裹与结果整形。
 *
 * 这些函数不接触数据库，供 Worker（请求处理）与测试共用。
 * 它们**不承担安全职责**：语句检查只用来给出友好的 `statement_not_allowed`，
 * 真正的只读由数据库层的只读凭据与执行层兜底保证（见 design Decision 2）。
 */

import { ValidationError } from './errors.ts';
import { utf8ByteLength } from './record.ts';

/** 默认返回行数上限。 */
export const QUERY_DEFAULT_LIMIT = 50;
/** 服务端允许的最大行数上限。 */
export const QUERY_MAX_LIMIT = 500;
/** 单元格文本的最大码点数（超出即截断）。 */
export const QUERY_MAX_CELL_CHARS = 2000;
/** 响应体的最大 UTF-8 字节数（超出按行截断）。 */
export const QUERY_MAX_RESPONSE_BYTES = 1024 * 1024;
/** 单次查询的服务端超时（毫秒）。 */
export const QUERY_TIMEOUT_MS = 5000;

/** 整形后的一个单元格：文本、数字或 null。 */
export type ShapedCell = string | number | null;

/** 整形后的结果。 */
export interface ShapedResult {
  columns: string[];
  rows: ShapedCell[][];
  /** `rows`：因行数上限或响应大小上限被截断；`cells`：被截断的单元格个数。 */
  truncated: { rows: boolean; cells: number };
}

export interface ShapeOptions {
  /** 请求的行数上限（服务端已校验）。 */
  limit: number;
  /** 单元格最大码点数；默认 {@link QUERY_MAX_CELL_CHARS}。 */
  maxCellChars?: number;
  /** 响应体最大字节数；默认 {@link QUERY_MAX_RESPONSE_BYTES}。 */
  maxResponseBytes?: number;
}

/**
 * 把引号与注释里的字符替换成空格（保留长度与换行），
 * 只留下“有效代码”的掩码，便于按分号切分语句与提取首关键字。
 */
function maskNonCode(sql: string): string {
  const chars = sql.split('');
  const n = sql.length;
  let i = 0;
  const blank = (index: number): void => {
    if (chars[index] !== '\n') chars[index] = ' ';
  };
  while (i < n) {
    const ch = sql[i]!;
    const next = i + 1 < n ? sql[i + 1]! : '';
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      blank(i);
      i += 1;
      while (i < n) {
        const c = sql[i]!;
        if (c === quote) {
          if (sql[i + 1] === quote) {
            blank(i);
            blank(i + 1);
            i += 2;
            continue;
          }
          blank(i);
          i += 1;
          break;
        }
        blank(i);
        i += 1;
      }
      continue;
    }
    if (ch === '[') {
      blank(i);
      i += 1;
      while (i < n) {
        const c = sql[i]!;
        blank(i);
        i += 1;
        if (c === ']') break;
      }
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') {
        blank(i);
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      blank(i);
      blank(i + 1);
      i += 2;
      while (i < n) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          blank(i);
          blank(i + 1);
          i += 2;
          break;
        }
        blank(i);
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return chars.join('');
}

function firstKeyword(masked: string): string | undefined {
  return /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(masked)?.[1]?.toLowerCase();
}

function isExplainQueryPlanMasked(masked: string): boolean {
  return /^\s*explain\s+query\s+plan\b/i.test(masked);
}

/** 该语句是否为 `EXPLAIN QUERY PLAN`（不包裹 LIMIT）。 */
export function isExplainQueryPlan(statement: string): boolean {
  return isExplainQueryPlanMasked(maskNonCode(statement));
}

/**
 * 校验 `sql` 是一条只读的单语句，返回去掉首尾空白与末尾分号后的语句。
 *
 * - 只允许 `SELECT`、`WITH …`（不校验最终是不是 SELECT，安全由执行层负责）、`EXPLAIN QUERY PLAN`。
 * - 引号与注释里的分号不参与切分，因此不会误判。
 * - 多条语句、写语句、DDL、`PRAGMA`、事务控制语句一律拒绝。
 */
export function checkReadOnlyStatement(sql: string): string {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new ValidationError('invalid_field', 'sql 不能为空', 'sql');
  }
  const masked = maskNonCode(sql);

  let start = 0;
  const segments: Array<{ start: number; text: string }> = [];
  for (let i = 0; i <= masked.length; i += 1) {
    if (i === masked.length || masked[i] === ';') {
      const text = masked.slice(start, i);
      if (text.trim() !== '') segments.push({ start, text });
      start = i + 1;
    }
  }

  if (segments.length === 0) {
    throw new ValidationError('invalid_field', 'sql 不能为空', 'sql');
  }
  if (segments.length > 1) {
    throw new ValidationError(
      'statement_not_allowed',
      '只允许执行单条语句，检测到多条语句',
      'sql',
    );
  }

  const segment = segments[0]!;
  const statement = sql.slice(segment.start, segment.start + segment.text.length).trim();
  const keyword = firstKeyword(segment.text);
  if (keyword === 'select' || keyword === 'with') return statement;
  if (keyword === 'explain' && isExplainQueryPlanMasked(segment.text)) return statement;
  throw new ValidationError(
    'statement_not_allowed',
    '只允许只读语句（SELECT、WITH … SELECT、EXPLAIN QUERY PLAN）',
    'sql',
  );
}

/**
 * 用 `SELECT * FROM (<stmt>) LIMIT n+1` 包裹，多取一行以便判断是否被截断。
 * `EXPLAIN QUERY PLAN` 不包裹；`limit` 必须是 1..{@link QUERY_MAX_LIMIT} 的整数。
 */
export function wrapLimit(statement: string, limit: number): string {
  if (!Number.isInteger(limit) || limit <= 0 || limit > QUERY_MAX_LIMIT) {
    throw new ValidationError(
      'invalid_field',
      `limit 必须是 1..${QUERY_MAX_LIMIT} 的整数`,
      'limit',
    );
  }
  const stripped = statement.replace(/[\s;]+$/u, '');
  if (stripped === '') {
    throw new ValidationError('invalid_field', 'sql 不能为空', 'sql');
  }
  if (isExplainQueryPlan(stripped)) return stripped;
  return `SELECT * FROM (\n${stripped}\n) LIMIT ${limit + 1}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x1000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function shapeCell(value: unknown, maxCellChars: number): { value: ShapedCell; truncated: boolean } {
  if (value === null || value === undefined) return { value: null, truncated: false };
  if (typeof value === 'string') {
    const codePoints = Array.from(value);
    if (codePoints.length > maxCellChars) {
      return { value: codePoints.slice(0, maxCellChars).join(''), truncated: true };
    }
    return { value, truncated: false };
  }
  if (typeof value === 'number') return { value, truncated: false };
  if (typeof value === 'bigint') return { value: value.toString(), truncated: false };
  if (typeof value === 'boolean') return { value: value ? 1 : 0, truncated: false };
  if (value instanceof Uint8Array) return { value: bytesToBase64(value), truncated: false };
  if (value instanceof ArrayBuffer) {
    return { value: bytesToBase64(new Uint8Array(value)), truncated: false };
  }
  return { value: JSON.stringify(value) ?? String(value), truncated: false };
}

/**
 * 结果整形：按行数上限裁剪、单元格截断、blob→base64、大整数→字符串，
 * 并在响应字节上限内按行截断。`rows` 可以多一行（用于判断是否被截断）。
 */
export function shapeResult(
  columns: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  options: ShapeOptions,
): ShapedResult {
  const maxCellChars = options.maxCellChars ?? QUERY_MAX_CELL_CHARS;
  const maxResponseBytes = options.maxResponseBytes ?? QUERY_MAX_RESPONSE_BYTES;
  const limit = options.limit;

  let rowsTruncated = rows.length > limit;
  const limited = rows.slice(0, limit);

  let cellsTruncated = 0;
  const shapedRows: ShapedCell[][] = [];
  let usedBytes = 0;

  for (const row of limited) {
    const shaped: ShapedCell[] = [];
    for (const cell of row) {
      const result = shapeCell(cell, maxCellChars);
      if (result.truncated) cellsTruncated += 1;
      shaped.push(result.value);
    }
    const size = utf8ByteLength(JSON.stringify(shaped));
    if (usedBytes + size + 1 > maxResponseBytes) {
      rowsTruncated = true;
      break;
    }
    usedBytes += size + 1;
    shapedRows.push(shaped);
  }

  return {
    columns: [...columns],
    rows: shapedRows,
    truncated: { rows: rowsTruncated, cells: cellsTruncated },
  };
}
