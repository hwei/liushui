/**
 * 回归评估执行器。
 *
 * 规范：openspec/changes/feedback-minimal/specs/memory-feedback/spec.md
 * 设计：openspec/changes/feedback-minimal/design.md (Decision 5)
 *
 * 流程：
 * 1. 在系统临时目录创建临时 SQLite 文件库；
 * 2. runMigrations(loadMigrations()) 建表；
 * 3. 批量原样插入快照行到 memories；
 * 4. rebuildDerived(client) 重建全部派生数据并记录版本；
 * 5. classifyFeedbacks 收集分类反馈；
 * 6. 校验期望 ID 是否全部在快照中存在：不在快照中的用例记为 invalid，并列出缺失 ID；
 * 7. 对每个用例逐条执行 queries：checkReadOnlyStatement -> expandFtsMacros -> wrapLimit -> 在只读事务中执行并回滚；
 * 8. 收集执行结果并通过 evaluateCase 判定命中与名次；
 * 9. 在结束时（无论成功与否）彻底清理删除临时文件库。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, type Client, type InStatement } from '@libsql/client';

import {
  classifyFeedbacks,
  type FeedbackCase,
  type FeedbackClassification,
  type FeedbackInvalid,
} from '../feedback.ts';
import { expandFtsMacros } from '../fts.ts';
import {
  checkReadOnlyStatement,
  QUERY_DEFAULT_LIMIT,
  shapeResult,
  wrapLimit,
} from '../query.ts';
import {
  evaluateCase,
  type CaseEvaluation,
  type CaseQueryResult,
} from '../regress.ts';
import { rebuildDerived, type DerivedBuildReport } from './derived.ts';
import { loadMigrations } from './load-migrations.ts';
import { runMigrations } from './migrate.ts';
import { readSnapshot, type SnapshotFile, type SnapshotRow } from './snapshot.ts';

export interface EvaluationResult {
  snapshotPath: string;
  header: SnapshotFile['header'];
  derivedVersions: DerivedBuildReport[];
  cases: CaseEvaluation[];
  pending: FeedbackClassification['pending'];
  invalid: FeedbackInvalid[];
  summary: {
    totalMemories: number;
    totalCases: number;
    pass: number;
    partial: number;
    fail: number;
    error: number;
    pendingCount: number;
    invalidCount: number;
  };
}

export interface RunEvaluationOptions {
  snapshotPath: string;
}

const INSERT_BATCH_SIZE = 500;

/**
 * 在临时本地文件库上对快照执行回归评估。
 */
export async function runEvaluation(
  options: RunEvaluationOptions,
): Promise<EvaluationResult> {
  // 1. 读取快照（保证快照文件存在且完整，不修改快照）
  const snapshot = readSnapshot(options.snapshotPath);

  // 2. 创建临时本地文件库
  const tempDir = mkdtempSync(join(tmpdir(), 'liushui-regress-'));
  const tempDbFile = join(tempDir, 'regress.db');
  const dbUrl = `file:${tempDbFile.replaceAll('\\', '/')}`;
  const client = createClient({ url: dbUrl });

  try {
    // 3. 执行迁移
    await runMigrations(client, loadMigrations());

    // 4. 原样批量插入快照行
    await insertSnapshotRows(client, snapshot.rows);

    // 5. 重建全部派生数据
    const derivedVersions = await rebuildDerived(client);

    // 6. 从快照行中提取 feedback 记录并分类
    const feedbackEntries = snapshot.rows
      .filter((r) => r.kind === 'retrieval_feedback')
      .map((r) => ({
        id: r.id,
        ts: r.ts,
        content: r.content,
      }));

    const classification = classifyFeedbacks(feedbackEntries);
    const existingIds = new Set(snapshot.rows.map((r) => r.id));

    const validCases: FeedbackCase[] = [];
    const invalidList: FeedbackInvalid[] = [...classification.invalid];

    // 7. 校验期望 ID 在快照中是否存在
    for (const c of classification.cases) {
      const missingIds = c.expectedIds.filter((id) => !existingIds.has(id));
      if (missingIds.length > 0) {
        invalidList.push({
          id: c.feedbackId,
          ts: c.feedbackTs,
          reason: `期望 ID 不在快照中：${missingIds.join(', ')}`,
        });
      } else {
        validCases.push(c);
      }
    }

    // 8. 执行每个用例
    const evaluatedCases: CaseEvaluation[] = [];

    for (const c of validCases) {
      const queryResults: CaseQueryResult[] = [];

      for (const q of c.queries) {
        const qr = await executeCaseQuery(client, q.sql, q.args);
        queryResults.push({
          sql: q.sql,
          args: q.args,
          outcome: q.outcome,
          error: qr.error,
          rows: qr.rows,
          columns: qr.columns,
        });
      }

      const evaluation = evaluateCase(c, queryResults);
      evaluatedCases.push(evaluation);
    }

    let passCount = 0;
    let partialCount = 0;
    let failCount = 0;
    let errorCount = 0;

    for (const ec of evaluatedCases) {
      if (ec.status === 'pass') passCount++;
      else if (ec.status === 'partial') partialCount++;
      else if (ec.status === 'fail') failCount++;
      else if (ec.status === 'error') errorCount++;
    }

    return {
      snapshotPath: options.snapshotPath,
      header: snapshot.header,
      derivedVersions,
      cases: evaluatedCases,
      pending: classification.pending,
      invalid: invalidList,
      summary: {
        totalMemories: snapshot.rows.length,
        totalCases: evaluatedCases.length,
        pass: passCount,
        partial: partialCount,
        fail: failCount,
        error: errorCount,
        pendingCount: classification.pending.length,
        invalidCount: invalidList.length,
      },
    };
  } finally {
    // 9. 关闭客户端并彻底删除临时库与目录
    try {
      client.close();
    } catch {
      // ignore
    }
    await cleanupDir(tempDir);
  }
}

async function insertSnapshotRows(client: Client, rows: SnapshotRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const chunk = rows.slice(i, i + INSERT_BATCH_SIZE);
    const statements: InStatement[] = chunk.map((r) => ({
      sql: `INSERT INTO memories (id, ts, author, kind, content, meta, received_at, schema_v)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        r.id,
        r.ts,
        r.author,
        r.kind,
        r.content,
        r.meta,
        r.received_at,
        r.schema_v,
      ],
    }));
    await client.batch(statements);
  }
}

interface QueryExecOutput {
  rows?: CaseQueryResult['rows'];
  columns?: string[];
  error?: {
    code: string;
    message: string;
  };
}

/**
 * 执行用例的单条 SQL 查询：
 * checkReadOnlyStatement -> expandFtsMacros -> wrapLimit -> 事务执行后回滚
 */
async function executeCaseQuery(
  client: Client,
  rawSql: string,
  args?: (string | number | null)[],
): Promise<QueryExecOutput> {
  let executableSql = rawSql;

  // 1. 语句检查
  try {
    checkReadOnlyStatement(executableSql);
  } catch (err) {
    return {
      error: {
        code: 'statement_not_allowed',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // 2. fts() 宏展开
  try {
    executableSql = expandFtsMacros(executableSql);
  } catch (err) {
    return {
      error: {
        code: 'macro_expansion_error',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // 3. wrapLimit
  try {
    executableSql = wrapLimit(executableSql, QUERY_DEFAULT_LIMIT);
  } catch (err) {
    return {
      error: {
        code: 'invalid_field',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // 4. 事务执行后回滚
  const tx = await client.transaction('write');
  try {
    const result = await tx.execute({
      sql: executableSql,
      args: (args ?? []) as (string | number | null)[],
    });

    const columns = result.columns;
    const rawRows = result.rows.map((row) =>
      columns.map((c) => (row as Record<string, unknown>)[c]),
    );

    const shaped = shapeResult(columns, rawRows, { limit: QUERY_DEFAULT_LIMIT });
    return {
      columns: shaped.columns,
      rows: shaped.rows,
    };
  } catch (err) {
    return {
      error: {
        code: 'sql_error',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    await tx.rollback().catch(() => undefined);
    tx.close();
  }
}

async function cleanupDir(dir: string): Promise<void> {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(50);
    }
  }
}
