/**
 * 检索反馈（retrieval_feedback）格式、校验与序列化。
 *
 * 规范：openspec/changes/feedback-minimal/specs/memory-feedback/spec.md
 * 设计：openspec/changes/feedback-minimal/design.md
 */

import { canonicalJson, type JsonValue } from './canonical.ts';
import { ValidationError } from './errors.ts';
import { isPlainObject } from './record.ts';

export const CURRENT_FEEDBACK_VERSION = 1;

/** 26 位大写 base32 ID 正则（与 RFC 4648 base32 对应，不含 0/1/8/9）。 */
export const RECORD_ID_REGEX = /^[A-Z2-7]{26}$/;

/** 一条尝试过的 SQL 查询及其结果。 */
export interface FeedbackQuery {
  sql: string;
  args?: (string | number | null)[];
  outcome?: string;
}

/** v1 主反馈。 */
export interface FeedbackV1Main {
  v: 1;
  intent: string;
  queries: FeedbackQuery[];
  expected_ids?: string[];
  cause?: string;
  service_version?: string;
  refines?: never;
  note?: never;
}

/** v1 补充记录。 */
export interface FeedbackV1Refine {
  v: 1;
  refines: string;
  expected_ids: string[];
  note?: string;
  intent?: never;
  queries?: never;
  cause?: never;
  service_version?: never;
}

/** 支持的反馈文档联合。 */
export type FeedbackDocument = FeedbackV1Main | FeedbackV1Refine;

/**
 * 校验反馈输入是否为合法的反馈文档（目前支持 v1 主反馈与 v1 补充记录）。
 * 校验失败抛出带 `field` 的 ValidationError。
 */
export function validateFeedbackInput(input: unknown): FeedbackDocument {
  if (!isPlainObject(input)) {
    throw new ValidationError('invalid_request', '反馈必须是 JSON 对象');
  }

  if (!('v' in input) || input['v'] === undefined || input['v'] === null) {
    throw new ValidationError('missing_field', '缺少版本字段：v', 'v');
  }
  const v = input['v'];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new ValidationError('invalid_field', '版本字段 v 必须是整数', 'v');
  }
  if (v !== CURRENT_FEEDBACK_VERSION) {
    throw new ValidationError('invalid_field', `不支持的反馈版本：${v}，当前仅支持 1`, 'v');
  }

  // 判断是主反馈还是补充记录
  const isRefine = 'refines' in input;
  if (isRefine) {
    return validateV1Refine(input);
  }
  return validateV1Main(input);
}

const ALLOWED_V1_MAIN_FIELDS = new Set([
  'v',
  'intent',
  'queries',
  'expected_ids',
  'cause',
  'service_version',
]);

function validateV1Main(input: Record<string, unknown>): FeedbackV1Main {
  for (const key of Object.keys(input)) {
    if (!ALLOWED_V1_MAIN_FIELDS.has(key)) {
      throw new ValidationError('invalid_field', `主反馈含未定义字段：${key}`, key);
    }
  }

  // intent: 必须存在且为非空字符串
  if (!('intent' in input) || input['intent'] === undefined || input['intent'] === null) {
    throw new ValidationError('missing_field', '缺少必填字段：intent', 'intent');
  }
  const intent = input['intent'];
  if (typeof intent !== 'string') {
    throw new ValidationError('invalid_field', 'intent 必须是字符串', 'intent');
  }
  if (intent.trim().length === 0) {
    throw new ValidationError('invalid_field', 'intent 不能为空', 'intent');
  }

  // queries: 必须存在且为非空数组
  if (!('queries' in input) || input['queries'] === undefined || input['queries'] === null) {
    throw new ValidationError('missing_field', '缺少必填字段：queries', 'queries');
  }
  const queriesRaw = input['queries'];
  if (!Array.isArray(queriesRaw)) {
    throw new ValidationError('invalid_field', 'queries 必须是数组', 'queries');
  }
  if (queriesRaw.length === 0) {
    throw new ValidationError('invalid_field', 'queries 至少包含一项', 'queries');
  }

  const queries: FeedbackQuery[] = [];
  const ALLOWED_QUERY_FIELDS = new Set(['sql', 'args', 'outcome']);

  for (let i = 0; i < queriesRaw.length; i++) {
    const q = queriesRaw[i];
    const path = `queries[${i}]`;
    if (!isPlainObject(q)) {
      throw new ValidationError('invalid_field', `${path} 必须是对象`, path);
    }
    for (const key of Object.keys(q)) {
      if (!ALLOWED_QUERY_FIELDS.has(key)) {
        throw new ValidationError('invalid_field', `${path} 含未定义字段：${key}`, `${path}.${key}`);
      }
    }
    if (!('sql' in q) || q['sql'] === undefined || q['sql'] === null) {
      throw new ValidationError('missing_field', `${path} 缺少必填字段：sql`, `${path}.sql`);
    }
    const sql = q['sql'];
    if (typeof sql !== 'string') {
      throw new ValidationError('invalid_field', `${path}.sql 必须是字符串`, `${path}.sql`);
    }
    if (sql.trim().length === 0) {
      throw new ValidationError('invalid_field', `${path}.sql 不能为空`, `${path}.sql`);
    }

    const item: FeedbackQuery = { sql };

    if ('args' in q && q['args'] !== undefined) {
      const argsRaw = q['args'];
      if (!Array.isArray(argsRaw)) {
        throw new ValidationError('invalid_field', `${path}.args 必须是数组`, `${path}.args`);
      }
      const args: (string | number | null)[] = [];
      for (let j = 0; j < argsRaw.length; j++) {
        const argVal = argsRaw[j];
        const argPath = `${path}.args[${j}]`;
        if (
          argVal !== null &&
          typeof argVal !== 'string' &&
          (typeof argVal !== 'number' || !Number.isFinite(argVal))
        ) {
          throw new ValidationError(
            'invalid_field',
            `${argPath} 必须是字符串、有限数值或 null`,
            argPath,
          );
        }
        args.push(argVal);
      }
      item.args = args;
    }

    if ('outcome' in q && q['outcome'] !== undefined) {
      const outcome = q['outcome'];
      if (typeof outcome !== 'string') {
        throw new ValidationError('invalid_field', `${path}.outcome 必须是字符串`, `${path}.outcome`);
      }
      item.outcome = outcome;
    }

    queries.push(item);
  }

  // expected_ids: 可选，存在时必须是数组且每项为合法 ID 且不重复
  let expectedIds: string[] | undefined;
  if ('expected_ids' in input && input['expected_ids'] !== undefined) {
    expectedIds = validateExpectedIds(input['expected_ids'], 'expected_ids', false);
  }

  // cause: 可选字符串
  let cause: string | undefined;
  if ('cause' in input && input['cause'] !== undefined) {
    if (typeof input['cause'] !== 'string') {
      throw new ValidationError('invalid_field', 'cause 必须是字符串', 'cause');
    }
    cause = input['cause'];
  }

  // service_version: 可选字符串
  let serviceVersion: string | undefined;
  if ('service_version' in input && input['service_version'] !== undefined) {
    if (typeof input['service_version'] !== 'string') {
      throw new ValidationError('invalid_field', 'service_version 必须是字符串', 'service_version');
    }
    serviceVersion = input['service_version'];
  }

  const result: FeedbackV1Main = {
    v: 1,
    intent,
    queries,
  };
  if (expectedIds !== undefined) result.expected_ids = expectedIds;
  if (cause !== undefined) result.cause = cause;
  if (serviceVersion !== undefined) result.service_version = serviceVersion;
  return result;
}

const ALLOWED_V1_REFINE_FIELDS = new Set(['v', 'refines', 'expected_ids', 'note']);

function validateV1Refine(input: Record<string, unknown>): FeedbackV1Refine {
  for (const key of Object.keys(input)) {
    if (!ALLOWED_V1_REFINE_FIELDS.has(key)) {
      throw new ValidationError('invalid_field', `补充记录含未定义字段：${key}`, key);
    }
  }

  // refines: 必须为合法 ID
  const refines = input['refines'];
  if (typeof refines !== 'string') {
    throw new ValidationError('invalid_field', 'refines 必须是字符串', 'refines');
  }
  if (!RECORD_ID_REGEX.test(refines)) {
    throw new ValidationError('invalid_field', `refines 必须是 26 位记忆 ID：${refines}`, 'refines');
  }

  // expected_ids: 必须存在且为数组，每项合法且不重复（允许为空数组）
  if (!('expected_ids' in input) || input['expected_ids'] === undefined || input['expected_ids'] === null) {
    throw new ValidationError('missing_field', '补充记录缺少必填字段：expected_ids', 'expected_ids');
  }
  const expectedIds = validateExpectedIds(input['expected_ids'], 'expected_ids', true);

  // note: 可选字符串
  let note: string | undefined;
  if ('note' in input && input['note'] !== undefined) {
    if (typeof input['note'] !== 'string') {
      throw new ValidationError('invalid_field', 'note 必须是字符串', 'note');
    }
    note = input['note'];
  }

  const result: FeedbackV1Refine = {
    v: 1,
    refines,
    expected_ids: expectedIds,
  };
  if (note !== undefined) result.note = note;
  return result;
}

function validateExpectedIds(raw: unknown, path: string, _allowEmpty: boolean): string[] {
  if (!Array.isArray(raw)) {
    throw new ValidationError('invalid_field', `${path} 必须是数组`, path);
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const itemPath = `${path}[${i}]`;
    if (typeof item !== 'string') {
      throw new ValidationError('invalid_field', `${itemPath} 必须是字符串`, itemPath);
    }
    if (!RECORD_ID_REGEX.test(item)) {
      throw new ValidationError(
        'invalid_field',
        `${itemPath} 必须是 26 位大写 base32 记忆 ID：${item}`,
        itemPath,
      );
    }
    if (seen.has(item)) {
      throw new ValidationError('invalid_field', `${itemPath} 与前面的 ID 重复：${item}`, itemPath);
    }
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

/**
 * 解析并校验 JSON 文本形式的反馈。
 * 出错时抛出带 `field` 的 ValidationError。
 */
export function parseFeedback(content: string): FeedbackDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new ValidationError(
      'invalid_request',
      `反馈内容不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateFeedbackInput(parsed);
}

/**
 * 将反馈对象序列化为规范化（键排序、紧凑）的 JSON 字符串。
 * 数组中元素的顺序（如 queries、expected_ids）保持原样。
 */
export function serializeFeedback(feedback: FeedbackDocument): string {
  return canonicalJson(feedback as unknown as JsonValue);
}

/**
 * 原始记录中的一条反馈项。
 */
export interface RawFeedbackEntry {
  id: string;
  ts: string;
  content: string;
}

/**
 * 分类后的用例。
 */
export interface FeedbackCase {
  feedbackId: string;
  feedbackTs: string;
  intent: string;
  queries: FeedbackQuery[];
  expectedIds: string[];
  cause?: string;
  serviceVersion?: string;
  refinementId?: string;
  refinementNote?: string;
}

/**
 * 待补充的反馈。
 */
export interface FeedbackPending {
  feedbackId: string;
  feedbackTs: string;
  intent: string;
  queries: FeedbackQuery[];
  cause?: string;
  serviceVersion?: string;
}

/**
 * 无效的反馈项。
 */
export interface FeedbackInvalid {
  id: string;
  ts: string;
  reason: string;
  rawContent?: string;
}

/**
 * 收集并合并反馈记录的结果。
 */
export interface FeedbackClassification {
  cases: FeedbackCase[];
  pending: FeedbackPending[];
  invalid: FeedbackInvalid[];
}

/**
 * 纯函数：将一批反馈记录按规则合并补充记录并分类为用例、待补充、无效三类。
 *
 * 合并规则（design Decision 2）：
 * - 补充记录通过 refines 引用原反馈 ID。
 * - 若存在多条引用同一反馈的补充，取 ts 最新者；同 ts 取 id 较大（字典序）者。
 * - 补充记录不能引用另一条补充记录（被引用的必须是主反馈），否则补充记录记为无效。
 * - 引用不存在的反馈 ID 的补充记录记为无效。
 * - 有效期望 ID 非空的主反馈成为用例（FeedbackCase）。
 * - 有效期望 ID 为空或未设置的主反馈成为待补充（FeedbackPending）。
 * - 格式不合规或未通过校验的记录记为无效（FeedbackInvalid）。
 */
export function classifyFeedbacks(entries: readonly RawFeedbackEntry[]): FeedbackClassification {
  const parsedMains = new Map<string, { entry: RawFeedbackEntry; doc: FeedbackV1Main }>();
  const parsedRefines: { entry: RawFeedbackEntry; doc: FeedbackV1Refine }[] = [];
  const invalid: FeedbackInvalid[] = [];

  for (const entry of entries) {
    try {
      const doc = parseFeedback(entry.content);
      if ('refines' in doc && doc.refines) {
        parsedRefines.push({ entry, doc: doc as FeedbackV1Refine });
      } else {
        parsedMains.set(entry.id, { entry, doc: doc as FeedbackV1Main });
      }
    } catch (err) {
      invalid.push({
        id: entry.id,
        ts: entry.ts,
        reason: err instanceof Error ? err.message : String(err),
        rawContent: entry.content,
      });
    }
  }

  // 记录所有补充记录的 id，用于检测“补充引用了补充”
  const refineIds = new Set(parsedRefines.map((r) => r.entry.id));

  // 按被引用的 targetId 归类补充记录
  const refinesByTarget = new Map<string, { entry: RawFeedbackEntry; doc: FeedbackV1Refine }[]>();

  for (const r of parsedRefines) {
    const targetId = r.doc.refines;
    if (refineIds.has(targetId)) {
      invalid.push({
        id: r.entry.id,
        ts: r.entry.ts,
        reason: `补充记录不能引用另一条补充记录：${targetId}`,
        rawContent: r.entry.content,
      });
      continue;
    }
    if (!parsedMains.has(targetId)) {
      invalid.push({
        id: r.entry.id,
        ts: r.entry.ts,
        reason: `补充记录引用的原反馈不存在：${targetId}`,
        rawContent: r.entry.content,
      });
      continue;
    }

    let list = refinesByTarget.get(targetId);
    if (!list) {
      list = [];
      refinesByTarget.set(targetId, list);
    }
    list.push(r);
  }

  const cases: FeedbackCase[] = [];
  const pending: FeedbackPending[] = [];

  for (const [id, { entry, doc }] of parsedMains.entries()) {
    const refinesList = refinesByTarget.get(id);
    let effectiveExpectedIds: string[] = doc.expected_ids ? [...doc.expected_ids] : [];
    let refinementId: string | undefined;
    let refinementNote: string | undefined;

    if (refinesList && refinesList.length > 0) {
      // 排序：ts 降序，ts 相同 id 降序（字典序比较）
      refinesList.sort((a, b) => {
        if (a.entry.ts !== b.entry.ts) {
          return a.entry.ts > b.entry.ts ? -1 : 1;
        }
        return a.entry.id > b.entry.id ? -1 : 1;
      });
      const latest = refinesList[0]!;
      effectiveExpectedIds = [...latest.doc.expected_ids];
      refinementId = latest.entry.id;
      refinementNote = latest.doc.note;
    }

    if (effectiveExpectedIds.length > 0) {
      const c: FeedbackCase = {
        feedbackId: id,
        feedbackTs: entry.ts,
        intent: doc.intent,
        queries: doc.queries,
        expectedIds: effectiveExpectedIds,
      };
      if (doc.cause !== undefined) c.cause = doc.cause;
      if (doc.service_version !== undefined) c.serviceVersion = doc.service_version;
      if (refinementId !== undefined) c.refinementId = refinementId;
      if (refinementNote !== undefined) c.refinementNote = refinementNote;
      cases.push(c);
    } else {
      const p: FeedbackPending = {
        feedbackId: id,
        feedbackTs: entry.ts,
        intent: doc.intent,
        queries: doc.queries,
      };
      if (doc.cause !== undefined) p.cause = doc.cause;
      if (doc.service_version !== undefined) p.serviceVersion = doc.service_version;
      pending.push(p);
    }
  }

  return { cases, pending, invalid };
}
