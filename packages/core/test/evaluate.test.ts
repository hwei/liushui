import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  compareWithBaseline,
  evaluateCase,
  type CaseEvaluation,
  type CaseQueryResult,
  type FeedbackCase,
} from '../src/index.ts';
import { runEvaluation } from '../src/storage/index.ts';

const ID_A = 'RYRP4645Q2VOLZ4DOVYPLUKVA4';
const ID_B = 'BCDEFGHJKMNPQRSTVWXYZ23456';
const ID_MISSING = 'MISSING7777777777777777777';

describe('命中判定与基线比较纯函数 (task 3.4)', () => {
  it('Scenario: 一条查询命中全部期望 ID -> pass，记录名次', () => {
    const c: FeedbackCase = {
      feedbackId: 'CASE1',
      feedbackTs: '2026-10-09T00:00:00.000Z',
      intent: '测试命中',
      queries: [{ sql: 'SELECT 1' }],
      expectedIds: [ID_A, ID_B],
    };

    // 查询返回多行：第 2 行含 ID_A，第 5 行含 ID_B
    const queryResults: CaseQueryResult[] = [
      {
        sql: 'SELECT id FROM memories',
        rows: [
          ['OTHER_1'],
          [ID_A], // rank 2
          ['OTHER_2'],
          ['OTHER_3'],
          [ID_B], // rank 5
        ],
      },
    ];

    const result = evaluateCase(c, queryResults);
    expect(result.status).toBe('pass');
    expect(result.queryResults[0]?.hits?.[ID_A]).toBe(2);
    expect(result.queryResults[0]?.hits?.[ID_B]).toBe(5);
    expect(result.bestHits[ID_A]).toBe(2);
    expect(result.bestHits[ID_B]).toBe(5);
  });

  it('Scenario: 分散在不同查询里只算部分命中 -> partial', () => {
    const c: FeedbackCase = {
      feedbackId: 'CASE2',
      feedbackTs: '2026-10-09T00:00:00.000Z',
      intent: '测试部分命中',
      queries: [{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }],
      expectedIds: [ID_A, ID_B],
    };

    const queryResults: CaseQueryResult[] = [
      {
        sql: 'SELECT id FROM memories WHERE id = A',
        rows: [[ID_A]],
      },
      {
        sql: 'SELECT id FROM memories WHERE id = B',
        rows: [[ID_B]],
      },
    ];

    const result = evaluateCase(c, queryResults);
    expect(result.status).toBe('partial');
  });

  it('Scenario: 列名不影响命中 (任意列出现即命中)', () => {
    const c: FeedbackCase = {
      feedbackId: 'CASE3',
      feedbackTs: '2026-10-09T00:00:00.000Z',
      intent: '测试列名别名',
      queries: [{ sql: 'SELECT 1' }],
      expectedIds: [ID_A],
    };

    const queryResults: CaseQueryResult[] = [
      {
        sql: 'SELECT m.id AS mid, m.content AS text FROM memories m',
        columns: ['mid', 'text'],
        rows: [['other', 'text'], [ID_A, 'something']],
      },
    ];

    const result = evaluateCase(c, queryResults);
    expect(result.status).toBe('pass');
    expect(result.bestHits[ID_A]).toBe(2);
  });

  it('一个都未命中且查询成功执行 -> fail', () => {
    const c: FeedbackCase = {
      feedbackId: 'CASE4',
      feedbackTs: '2026-10-09T00:00:00.000Z',
      intent: '测试失败',
      queries: [{ sql: 'SELECT 1' }],
      expectedIds: [ID_A],
    };

    const queryResults: CaseQueryResult[] = [
      {
        sql: 'SELECT id FROM memories',
        rows: [['OTHER_ID']],
      },
    ];

    const result = evaluateCase(c, queryResults);
    expect(result.status).toBe('fail');
  });

  it('全部查询出错 -> error', () => {
    const c: FeedbackCase = {
      feedbackId: 'CASE5',
      feedbackTs: '2026-10-09T00:00:00.000Z',
      intent: '测试出错',
      queries: [{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }],
      expectedIds: [ID_A],
    };

    const queryResults: CaseQueryResult[] = [
      {
        sql: 'SELECT 1',
        error: { code: 'sql_error', message: 'syntax error' },
      },
      {
        sql: 'SELECT 2',
        error: { code: 'statement_not_allowed', message: 'denied' },
      },
    ];

    const result = evaluateCase(c, queryResults);
    expect(result.status).toBe('error');
  });

  it('基线比较：Scenario: 没有退化', () => {
    const current: CaseEvaluation[] = [
      {
        case: { feedbackId: 'CASE1', expectedIds: [ID_A], intent: '', queries: [], feedbackTs: '' },
        status: 'pass',
        queryResults: [],
        bestHits: {},
      },
      {
        case: { feedbackId: 'CASE2', expectedIds: [ID_B], intent: '', queries: [], feedbackTs: '' },
        status: 'pass', // 上次 partial 本次 pass，改善
        queryResults: [],
        bestHits: {},
      },
    ];

    const baseline = {
      cases: [
        { feedbackId: 'CASE1', status: 'pass' as const },
        { feedbackId: 'CASE2', status: 'partial' as const },
      ],
    };

    const diff = compareWithBaseline(current, baseline);
    expect(diff.hasRegression).toBe(false);
    expect(diff.regressed).toHaveLength(0);
    expect(diff.improved).toHaveLength(1);
    expect(diff.improved[0]?.feedbackId).toBe('CASE2');
  });

  it('基线比较：Scenario: 出现退化 (pass -> fail 或 partial)', () => {
    const current: CaseEvaluation[] = [
      {
        case: { feedbackId: 'CASE1', expectedIds: [ID_A], intent: '', queries: [], feedbackTs: '' },
        status: 'fail',
        queryResults: [],
        bestHits: {},
      },
    ];

    const baseline = {
      cases: [{ feedbackId: 'CASE1', status: 'pass' as const }],
    };

    const diff = compareWithBaseline(current, baseline);
    expect(diff.hasRegression).toBe(true);
    expect(diff.regressed).toHaveLength(1);
    expect(diff.regressed[0]?.feedbackId).toBe('CASE1');
    expect(diff.regressed[0]?.from).toBe('pass');
    expect(diff.regressed[0]?.to).toBe('fail');
  });

  it('基线比较：Scenario: 基线之后新增的用例', () => {
    const current: CaseEvaluation[] = [
      {
        case: { feedbackId: 'NEW_CASE', expectedIds: [ID_A], intent: '', queries: [], feedbackTs: '' },
        status: 'fail',
        queryResults: [],
        bestHits: {},
      },
    ];

    const baseline = { cases: [] };

    const diff = compareWithBaseline(current, baseline);
    expect(diff.hasRegression).toBe(false);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.feedbackId).toBe('NEW_CASE');
  });
});

describe('评估执行与用例执行 (task 3.3)', () => {
  const tempFiles: string[] = [];
  const createTempSnapshot = (content: string): string => {
    const p = join(tmpdir(), `eval-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(p, content, 'utf8');
    tempFiles.push(p);
    return p;
  };

  afterEach(() => {
    for (const f of tempFiles) {
      try {
        unlinkSync(f);
      } catch {
        // ignore
      }
    }
  });

  it('Scenario: 候选代码上重建派生数据、fts 展开与错误记录、期望 ID 缺失标记为无效、快照字节不变', async () => {
    const header = {
      liushui_snapshot: 1,
      taken_at: '2026-10-09T00:00:00.000Z',
      rows: 5,
      schema_versions: [1, 2],
    };

    // 普通记忆记录：
    // ID_A: 包含“渲染”
    // ID_B: 包含“优化”
    const rowA = {
      id: ID_A,
      ts: '2026-10-09T00:00:01.000Z',
      author: 'will',
      kind: 'note',
      content: 'iOS 画面渲染引擎排查记录',
      meta: '{}',
      received_at: '2026-10-09T00:00:01.000Z',
      schema_v: 1,
    };
    const rowB = {
      id: ID_B,
      ts: '2026-10-09T00:00:02.000Z',
      author: 'will',
      kind: 'note',
      content: 'Metal 着色器性能优化手册',
      meta: '{}',
      received_at: '2026-10-09T00:00:02.000Z',
      schema_v: 1,
    };

    // 反馈 1：正常用例，使用 fts('渲染') 检索，期望命中 ID_A
    const feedbackValid = {
      id: 'FEEDBACK000000000000000001',
      ts: '2026-10-09T00:01:00.000Z',
      author: 'will',
      kind: 'retrieval_feedback',
      content: JSON.stringify({
        v: 1,
        intent: '搜渲染',
        queries: [
          {
            sql: "SELECT m.id FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH fts('渲染') ORDER BY rank",
          },
        ],
        expected_ids: [ID_A],
      }),
      meta: '{}',
      received_at: '2026-10-09T00:01:00.000Z',
      schema_v: 1,
    };

    // 反馈 2：某条查询出错 (fts('渲') 单字错误) 的用例
    const feedbackWithErr = {
      id: 'FEEDBACK000000000000000002',
      ts: '2026-10-09T00:02:00.000Z',
      author: 'will',
      kind: 'retrieval_feedback',
      content: JSON.stringify({
        v: 1,
        intent: '单字宏测试',
        queries: [
          {
            sql: "SELECT id FROM memories_fts WHERE memories_fts MATCH fts('渲')",
          },
        ],
        expected_ids: [ID_A],
      }),
      meta: '{}',
      received_at: '2026-10-09T00:02:00.000Z',
      schema_v: 1,
    };

    // 反馈 3：期望 ID 不在快照中
    const feedbackMissingId = {
      id: 'FEEDBACK000000000000000003',
      ts: '2026-10-09T00:03:00.000Z',
      author: 'will',
      kind: 'retrieval_feedback',
      content: JSON.stringify({
        v: 1,
        intent: '期望 ID 不存在测试',
        queries: [{ sql: 'SELECT id FROM memories' }],
        expected_ids: [ID_MISSING],
      }),
      meta: '{}',
      received_at: '2026-10-09T00:03:00.000Z',
      schema_v: 1,
    };

    const lines = [
      JSON.stringify(header),
      JSON.stringify(rowA),
      JSON.stringify(rowB),
      JSON.stringify(feedbackValid),
      JSON.stringify(feedbackWithErr),
      JSON.stringify(feedbackMissingId),
    ];

    const snapshotContent = lines.join('\n') + '\n';
    const snapshotPath = createTempSnapshot(snapshotContent);
    const beforeBytes = readFileSync(snapshotPath);

    // 执行评估
    const result = await runEvaluation({ snapshotPath });

    // 1. 断言快照文件评估前后字节相同
    const afterBytes = readFileSync(snapshotPath);
    expect(beforeBytes.equals(afterBytes)).toBe(true);

    // 2. 派生数据重建成功
    expect(result.derivedVersions).toHaveLength(1);
    expect(result.derivedVersions[0]?.name).toBe('memories_fts');

    // 3. 用例执行结果
    expect(result.cases).toHaveLength(2);

    // feedbackValid: 成功展开 fts('渲染') 并 pass，命中 ID_A
    const case1 = result.cases.find((c) => c.case.feedbackId === 'FEEDBACK000000000000000001');
    expect(case1).toBeDefined();
    expect(case1?.status).toBe('pass');
    expect(case1?.bestHits[ID_A]).toBe(1);

    // feedbackWithErr: fts('渲') 记录为 macro_expansion_error
    const case2 = result.cases.find((c) => c.case.feedbackId === 'FEEDBACK000000000000000002');
    expect(case2).toBeDefined();
    expect(case2?.status).toBe('error');
    expect(case2?.queryResults[0]?.error?.code).toBe('macro_expansion_error');

    // 4. 期望 ID 不在快照中记为无效且列出缺失 ID
    const missingInvalid = result.invalid.find((inv) => inv.id === 'FEEDBACK000000000000000003');
    expect(missingInvalid).toBeDefined();
    expect(missingInvalid?.reason).toContain('期望 ID 不在快照中');
    expect(missingInvalid?.reason).toContain(ID_MISSING);
  });
});
