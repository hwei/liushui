/**
 * 命中判定与基线比较的纯函数。
 *
 * 规范：openspec/changes/feedback-minimal/specs/memory-feedback/spec.md
 * 设计：openspec/changes/feedback-minimal/design.md
 */

import type { FeedbackCase } from './feedback.ts';
import type { ShapedCell } from './query.ts';

/**
 * 单条查询的执行结果。
 */
export interface CaseQueryResult {
  sql: string;
  args?: (string | number | null)[] | undefined;
  outcome?: string | undefined;
  /** 执行出错时的信息。 */
  error?: {
    code: string;
    message: string;
  } | undefined;
  /** 执行成功时的结果行。 */
  rows?: ShapedCell[][] | undefined;
  columns?: string[] | undefined;
  /** 期望 ID 在本条查询中的命中名次（1 开始）；未命中则不在映射中。 */
  hits?: Record<string, number> | undefined;
}

/**
 * 一个用例的评测状态。
 */
export type CaseStatus = 'pass' | 'partial' | 'fail' | 'error';

/**
 * 单个用例的评估报告项。
 */
export interface CaseEvaluation {
  case: FeedbackCase;
  status: CaseStatus;
  queryResults: CaseQueryResult[];
  /** 全部查询中各个期望 ID 的最好名次（名次数值越小越好）。 */
  bestHits: Record<string, number>;
}

/**
 * 纯函数：判定单个用例的状态与各查询命中名次。
 *
 * 命中规则：
 * - 单元格值转为字符串后（忽略 null 与非精确匹配），若与期望 ID 完全相等，即为命中。
 * - 名次为包含该单元格的第一行序号（从 1 开始）。
 *
 * 用例状态：
 * - pass：存在至少一条查询命中该用例的全部期望 ID。
 * - partial：未达 pass，但所有查询合起来至少命中了一个期望 ID。
 * - fail：一个都未命中，且至少有一条查询成功执行（未出错）。
 * - error：全部查询都出错。
 */
export function evaluateCase(
  c: FeedbackCase,
  queryResults: CaseQueryResult[],
): CaseEvaluation {
  const expectedSet = new Set(c.expectedIds);
  let allQueriesErrored = true;
  let hasPassQuery = false;
  const overallHitIds = new Set<string>();
  const bestHits: Record<string, number> = {};

  const evaluatedQueries: CaseQueryResult[] = [];

  for (const q of queryResults) {
    if (q.error) {
      evaluatedQueries.push(q);
      continue;
    }

    allQueriesErrored = false;
    const hits: Record<string, number> = {};
    const rows = q.rows ?? [];

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const rank = rIdx + 1;
      const row = rows[rIdx]!;
      for (const cell of row) {
        if (cell === null || cell === undefined) continue;
        const cellStr = String(cell);
        if (expectedSet.has(cellStr)) {
          if (!(cellStr in hits)) {
            hits[cellStr] = rank;
          }
          overallHitIds.add(cellStr);
          if (!(cellStr in bestHits) || rank < bestHits[cellStr]!) {
            bestHits[cellStr] = rank;
          }
        }
      }
    }

    // 检查本条查询是否命中全部期望 ID
    let hitsAllInThisQuery = true;
    for (const expId of c.expectedIds) {
      if (!(expId in hits)) {
        hitsAllInThisQuery = false;
        break;
      }
    }

    if (hitsAllInThisQuery && c.expectedIds.length > 0) {
      hasPassQuery = true;
    }

    evaluatedQueries.push({
      ...q,
      hits,
    });
  }

  let status: CaseStatus;
  if (hasPassQuery) {
    status = 'pass';
  } else if (overallHitIds.size > 0) {
    status = 'partial';
  } else if (allQueriesErrored) {
    status = 'error';
  } else {
    status = 'fail';
  }

  return {
    case: c,
    status,
    queryResults: evaluatedQueries,
    bestHits,
  };
}

/** 基线对比的一项变动。 */
export interface CaseDiff {
  feedbackId: string;
  from?: CaseStatus;
  to: CaseStatus;
}

/** 基线报告结构（用于比对）。 */
export interface BaselineReport {
  cases: Array<{
    feedbackId?: string;
    case?: { feedbackId: string };
    status: CaseStatus;
  }>;
}

/** 基线对比结果。 */
export interface ComparisonResult {
  improved: CaseDiff[];
  regressed: CaseDiff[];
  added: CaseDiff[];
  removed: string[];
  hasRegression: boolean;
}

/** 状态质量排序：pass > partial > fail > error */
const STATUS_RANK: Record<CaseStatus, number> = {
  pass: 4,
  partial: 3,
  fail: 2,
  error: 1,
};

/**
 * 比较本次评估结果与基线报告。
 * - 任何在基线中为 pass 而本次不是 pass 的用例都算退化（regressed）。
 * - 状态评级升高算改善（improved）。
 * - 状态评级降低且不属于 pass 变其它（如 partial 变 fail）也算退化。
 * - 基线中没有算 added，本次没有算 removed。
 */
export function compareWithBaseline(
  current: CaseEvaluation[],
  baseline: BaselineReport,
): ComparisonResult {
  const baselineMap = new Map<string, CaseStatus>();
  for (const b of baseline.cases) {
    const id = b.feedbackId ?? b.case?.feedbackId;
    if (id) {
      baselineMap.set(id, b.status);
    }
  }

  const improved: CaseDiff[] = [];
  const regressed: CaseDiff[] = [];
  const added: CaseDiff[] = [];
  const currentIds = new Set<string>();

  for (const cur of current) {
    const id = cur.case.feedbackId;
    currentIds.add(id);
    const prevStatus = baselineMap.get(id);

    if (prevStatus === undefined) {
      added.push({ feedbackId: id, to: cur.status });
      continue;
    }

    if (cur.status === prevStatus) {
      continue;
    }

    // 任何上次为 pass 而本次不是 pass 必须算退化
    if (prevStatus === 'pass' && cur.status !== 'pass') {
      regressed.push({ feedbackId: id, from: prevStatus, to: cur.status });
      continue;
    }

    if (STATUS_RANK[cur.status] > STATUS_RANK[prevStatus]) {
      improved.push({ feedbackId: id, from: prevStatus, to: cur.status });
    } else {
      regressed.push({ feedbackId: id, from: prevStatus, to: cur.status });
    }
  }

  const removed: string[] = [];
  for (const prevId of baselineMap.keys()) {
    if (!currentIds.has(prevId)) {
      removed.push(prevId);
    }
  }

  return {
    improved,
    regressed,
    added,
    removed,
    hasRegression: regressed.length > 0,
  };
}
