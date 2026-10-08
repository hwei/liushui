/**
 * 确定性记忆 ID 的计算。
 *
 * 规则（见 openspec/changes/core-append-store/specs/memory-ledger）：
 * - 输入是 `ts`、`author`、`kind`、`content` 与附件 sha256 列表（本 change 无附件）。
 * - 输入经“键排序的确定性 JSON 序列化”规范化，`ts` 统一为 UTC 毫秒精度的 ISO 字符串。
 * - 取 sha256 的前 128 位，按 RFC 4648 base32（无填充，大写）编码，得到 26 个字符。
 * - `meta`、`received_at` 与目标库不参与计算。
 *
 * 这里使用 Web Crypto（Worker 与 Node 都可用），因此 `computeId` 是异步的。
 */

import { ValidationError } from './errors.ts';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 参与 ID 计算的核心字段。 */
export interface IdInput {
  ts: string;
  author: string;
  kind: string;
  content: string;
  /** 附件内容的 sha256（本 change 尚未支持附件，保留该位置）。 */
  attachments?: readonly string[];
}

/** 可被确定性序列化的 JSON 值。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * 把时间统一成 UTC 毫秒精度的 ISO 字符串。
 * 等价的表示（不同时区偏移、不同精度）归一后相同。
 */
export function normalizeTs(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError('invalid_field', `无效的时间表示：${ts}`, 'ts');
  }
  return date.toISOString();
}

/** 递归按键排序的确定性 JSON 序列化。 */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`,
    );
    return `{${parts.join(',')}}`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError('invalid_field', `无法序列化的数值：${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

/** 构造参与 sha256 的规范化字符串。 */
export function canonicalIdInput(input: IdInput): string {
  const attachments = [...(input.attachments ?? [])].sort();
  return canonicalJson({
    attachments,
    author: input.author,
    content: input.content,
    kind: input.kind,
    ts: normalizeTs(input.ts),
  });
}

/** 计算记忆 ID。相同输入恒得到相同结果。 */
export async function computeId(input: IdInput): Promise<string> {
  const payload = new TextEncoder().encode(canonicalIdInput(input));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
  return base32Encode(digest.subarray(0, 16));
}

/** RFC 4648 base32 编码（大写、无填充）。 */
export function base32Encode(bytes: Uint8Array): string {
  let buffer = 0;
  let bits = 0;
  let out = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return out;
}
