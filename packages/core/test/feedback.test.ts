import { describe, expect, it } from 'vitest';
import {
  classifyFeedbacks,
  parseFeedback,
  serializeFeedback,
  validateFeedbackInput,
  ValidationError,
} from '../src/index.ts';

const VALID_ID_1 = 'RYRP4645Q2VOLZ4DOVYPLUKVA4';
const VALID_ID_2 = 'BCDEFGHJKMNPQRSTVWXYZ23456';
const VALID_ID_3 = '77777777777777777777777777';

describe('反馈格式校验与解析 (task 1.1)', () => {
  it('Scenario: 完整的反馈可被解析', () => {
    const raw = {
      v: 1,
      intent: '上次 iOS 渲染问题是怎么查的',
      queries: [
        {
          sql: 'SELECT m.id, m.content FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH fts(?) ORDER BY rank',
          args: ['iOS渲染'],
          outcome: '0 行',
        },
        {
          sql: 'SELECT id, content FROM memories WHERE content LIKE ?',
          args: ['%渲染%'],
          outcome: '3 行，都不是想要的',
        },
      ],
      expected_ids: [VALID_ID_1],
      cause: '原文写的是“Metal 着色器”，没有出现“渲染”二字：同义词问题',
      service_version: '0.3.0',
    };

    const doc = validateFeedbackInput(raw);
    expect(doc).toEqual(raw);

    const jsonStr = JSON.stringify(raw);
    const parsed = parseFeedback(jsonStr);
    expect(parsed).toEqual(raw);
  });

  it('Scenario: 不知道期望 ID 时也能写', () => {
    const raw = {
      v: 1,
      intent: '不知道期望 ID 的检索',
      queries: [{ sql: 'SELECT id FROM memories' }],
    };
    const parsed = validateFeedbackInput(raw);
    expect(parsed.expected_ids).toBeUndefined();
    expect(parsed.v).toBe(1);
    expect(parsed.intent).toBe('不知道期望 ID 的检索');
  });

  it('Scenario: 缺少意图被拒绝', () => {
    const raw = {
      v: 1,
      queries: [{ sql: 'SELECT 1' }],
    };
    expect(() => validateFeedbackInput(raw)).toThrowError(ValidationError);
    try {
      validateFeedbackInput(raw);
    } catch (err) {
      expect((err as ValidationError).field).toBe('intent');
    }
  });

  it('空白意图被拒绝', () => {
    const raw = {
      v: 1,
      intent: '   ',
      queries: [{ sql: 'SELECT 1' }],
    };
    expect(() => validateFeedbackInput(raw)).toThrowError(ValidationError);
    try {
      validateFeedbackInput(raw);
    } catch (err) {
      expect((err as ValidationError).field).toBe('intent');
    }
  });

  it('Scenario: 没有尝试过的查询被拒绝', () => {
    const raw = {
      v: 1,
      intent: '检索',
      queries: [],
    };
    expect(() => validateFeedbackInput(raw)).toThrowError(ValidationError);
    try {
      validateFeedbackInput(raw);
    } catch (err) {
      expect((err as ValidationError).field).toBe('queries');
    }
  });

  it('查询中缺少 sql 或 sql 为空白被拒绝', () => {
    expect(() =>
      validateFeedbackInput({
        v: 1,
        intent: 'test',
        queries: [{ outcome: 'none' }],
      }),
    ).toThrowError(ValidationError);

    expect(() =>
      validateFeedbackInput({
        v: 1,
        intent: 'test',
        queries: [{ sql: '   ' }],
      }),
    ).toThrowError(ValidationError);
  });

  it('查询中 args 包含非 string/number/null 被拒绝', () => {
    expect(() =>
      validateFeedbackInput({
        v: 1,
        intent: 'test',
        queries: [{ sql: 'SELECT 1', args: [{} as unknown as string] }],
      }),
    ).toThrowError(ValidationError);
  });

  it('Scenario: 期望 ID 格式错误被拒绝', () => {
    const raw = {
      v: 1,
      intent: 'test',
      queries: [{ sql: 'SELECT 1' }],
      expected_ids: ['abc'],
    };
    expect(() => validateFeedbackInput(raw)).toThrowError(ValidationError);
    try {
      validateFeedbackInput(raw);
    } catch (err) {
      expect((err as ValidationError).field).toBe('expected_ids[0]');
    }
  });

  it('期望 ID 重复被拒绝', () => {
    const raw = {
      v: 1,
      intent: 'test',
      queries: [{ sql: 'SELECT 1' }],
      expected_ids: [VALID_ID_1, VALID_ID_1],
    };
    expect(() => validateFeedbackInput(raw)).toThrowError(ValidationError);
    try {
      validateFeedbackInput(raw);
    } catch (err) {
      expect((err as ValidationError).field).toBe('expected_ids[1]');
    }
  });

  it('Scenario: 拼错的字段被拒绝', () => {
    const raw = {
      v: 1,
      intent: 'test',
      queries: [{ sql: 'SELECT 1' }],
      expect_ids: [VALID_ID_1],
    };
    expect(() => validateFeedbackInput(raw)).toThrowError(ValidationError);
    try {
      validateFeedbackInput(raw);
    } catch (err) {
      expect((err as ValidationError).field).toBe('expect_ids');
    }
  });

  it('queries 中拼错字段被拒绝', () => {
    const raw = {
      v: 1,
      intent: 'test',
      queries: [{ sql: 'SELECT 1', extra: 'bad' }],
    };
    expect(() => validateFeedbackInput(raw)).toThrowError(ValidationError);
    try {
      validateFeedbackInput(raw);
    } catch (err) {
      expect((err as ValidationError).field).toBe('queries[0].extra');
    }
  });

  it('Scenario: 不支持的版本被拒绝', () => {
    const raw = {
      v: 2,
      intent: 'test',
      queries: [{ sql: 'SELECT 1' }],
    };
    expect(() => validateFeedbackInput(raw)).toThrowError(ValidationError);
    try {
      validateFeedbackInput(raw);
    } catch (err) {
      expect((err as ValidationError).field).toBe('v');
    }
  });

  it('补充记录只允许合法字段', () => {
    const refine = {
      v: 1,
      refines: VALID_ID_1,
      expected_ids: [VALID_ID_2],
      note: '补充说明',
    };
    expect(validateFeedbackInput(refine)).toEqual(refine);

    // 允许空 expected_ids 撤回期望 ID
    const emptyRefine = {
      v: 1,
      refines: VALID_ID_1,
      expected_ids: [],
    };
    expect(validateFeedbackInput(emptyRefine)).toEqual(emptyRefine);

    // 缺少 expected_ids 拒绝
    expect(() =>
      validateFeedbackInput({
        v: 1,
        refines: VALID_ID_1,
      }),
    ).toThrowError(ValidationError);

    // 含 intent 拒绝（补充记录不能改 intent）
    expect(() =>
      validateFeedbackInput({
        v: 1,
        refines: VALID_ID_1,
        expected_ids: [VALID_ID_2],
        intent: 'something',
      }),
    ).toThrowError(ValidationError);
  });

  it('序列化：不同键顺序与缩进序列化后逐字相同，保留 queries 数组顺序', () => {
    const a = parseFeedback(`{
      "service_version": "0.3.0",
      "v": 1,
      "queries": [
        {"outcome": "none", "sql": "SELECT 1"},
        {"sql": "SELECT 2"}
      ],
      "intent": "查找",
      "expected_ids": ["${VALID_ID_1}"]
    }`);

    const b = parseFeedback(`{
      "intent": "查找",
      "v": 1,
      "expected_ids": ["${VALID_ID_1}"],
      "queries": [
        {"sql": "SELECT 1", "outcome": "none"},
        {"sql": "SELECT 2"}
      ],
      "service_version": "0.3.0"
    }`);

    const strA = serializeFeedback(a);
    const strB = serializeFeedback(b);
    expect(strA).toBe(strB);

    // 数组顺序不会被重排
    expect(strA.indexOf('SELECT 1')).toBeLessThan(strA.indexOf('SELECT 2'));
  });
});

describe('反馈合并与用例分类纯函数 (task 1.2)', () => {
  it('Scenario: 为原本留空的反馈补上期望 ID', () => {
    const entries = [
      {
        id: VALID_ID_1,
        ts: '2026-03-01T00:00:00.000Z',
        content: JSON.stringify({
          v: 1,
          intent: '搜不到',
          queries: [{ sql: 'SELECT 1' }],
        }),
      },
      {
        id: VALID_ID_2,
        ts: '2026-03-01T01:00:00.000Z',
        content: JSON.stringify({
          v: 1,
          refines: VALID_ID_1,
          expected_ids: [VALID_ID_3],
          note: '找到对应记录了',
        }),
      },
    ];

    const result = classifyFeedbacks(entries);
    expect(result.invalid).toHaveLength(0);
    expect(result.pending).toHaveLength(0);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]!.feedbackId).toBe(VALID_ID_1);
    expect(result.cases[0]!.expectedIds).toEqual([VALID_ID_3]);
    expect(result.cases[0]!.refinementId).toBe(VALID_ID_2);
    expect(result.cases[0]!.refinementNote).toBe('找到对应记录了');
  });

  it('Scenario: 更正以最新的补充为准（ts 较晚优先；ts 相同 id 较大优先）', () => {
    const entries = [
      {
        id: VALID_ID_1,
        ts: '2026-03-01T00:00:00.000Z',
        content: JSON.stringify({
          v: 1,
          intent: '主反馈',
          queries: [{ sql: 'SELECT 1' }],
          expected_ids: [VALID_ID_1],
        }),
      },
      {
        id: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
        ts: '2026-03-01T01:00:00.000Z',
        content: JSON.stringify({
          v: 1,
          refines: VALID_ID_1,
          expected_ids: [VALID_ID_2],
        }),
      },
      {
        id: 'BBBBBBBBBBBBBBBBBBBBBBBBBB',
        ts: '2026-03-01T02:00:00.000Z',
        content: JSON.stringify({
          v: 1,
          refines: VALID_ID_1,
          expected_ids: [VALID_ID_3],
        }),
      },
    ];

    const result = classifyFeedbacks(entries);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]!.expectedIds).toEqual([VALID_ID_3]);
    expect(result.cases[0]!.refinementId).toBe('BBBBBBBBBBBBBBBBBBBBBBBBBB');

    // ts 相同，取 id 较大者
    const sameTsEntries = [
      entries[0]!,
      {
        id: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
        ts: '2026-03-01T02:00:00.000Z',
        content: JSON.stringify({
          v: 1,
          refines: VALID_ID_1,
          expected_ids: [VALID_ID_2],
        }),
      },
      {
        id: 'BBBBBBBBBBBBBBBBBBBBBBBBBB',
        ts: '2026-03-01T02:00:00.000Z',
        content: JSON.stringify({
          v: 1,
          refines: VALID_ID_1,
          expected_ids: [VALID_ID_3],
        }),
      },
    ];
    const sameTsResult = classifyFeedbacks(sameTsEntries);
    expect(sameTsResult.cases[0]!.expectedIds).toEqual([VALID_ID_3]);
  });

  it('Scenario: 补充记录不能引用补充记录', () => {
    const refine1Id = 'AAAAAAAAAAAAAAAAAAAAAAAAAA';
    const refine2Id = 'BBBBBBBBBBBBBBBBBBBBBBBBBB';
    const entries = [
      {
        id: VALID_ID_1,
        ts: '2026-03-01T00:00:00.000Z',
        content: JSON.stringify({
          v: 1,
          intent: '主反馈',
          queries: [{ sql: 'SELECT 1' }],
          expected_ids: [VALID_ID_1],
        }),
      },
      {
        id: refine1Id,
        ts: '2026-03-01T01:00:00.000Z',
        content: JSON.stringify({
          v: 1,
          refines: VALID_ID_1,
          expected_ids: [VALID_ID_2],
        }),
      },
      {
        id: refine2Id,
        ts: '2026-03-01T02:00:00.000Z',
        content: JSON.stringify({
          v: 1,
          refines: refine1Id, // 引用了补充记录！
          expected_ids: [VALID_ID_3],
        }),
      },
    ];

    const result = classifyFeedbacks(entries);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]!.id).toBe(refine2Id);
    expect(result.invalid[0]!.reason).toContain('补充记录不能引用另一条补充记录');
    // 主反馈仍然受合法的 refine1 影响
    expect(result.cases[0]!.expectedIds).toEqual([VALID_ID_2]);
  });

  it('补充记录引用不存在的反馈记为无效', () => {
    const entries = [
      {
        id: VALID_ID_2,
        ts: '2026-03-01T01:00:00.000Z',
        content: JSON.stringify({
          v: 1,
          refines: VALID_ID_1,
          expected_ids: [VALID_ID_3],
        }),
      },
    ];
    const result = classifyFeedbacks(entries);
    expect(result.cases).toHaveLength(0);
    expect(result.pending).toHaveLength(0);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]!.id).toBe(VALID_ID_2);
    expect(result.invalid[0]!.reason).toContain('不存在');
  });

  it('Scenario: 待补充的反馈不参与评估', () => {
    const entries = [
      {
        id: VALID_ID_1,
        ts: '2026-03-01T00:00:00.000Z',
        content: JSON.stringify({
          v: 1,
          intent: '搜不到',
          queries: [{ sql: 'SELECT 1' }],
        }),
      },
    ];
    const result = classifyFeedbacks(entries);
    expect(result.cases).toHaveLength(0);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]!.feedbackId).toBe(VALID_ID_1);
    expect(result.invalid).toHaveLength(0);
  });

  it('Scenario: 格式不合规的反馈不中断评估', () => {
    const entries = [
      {
        id: 'NOT_JSON_IDAAAAAAAAAAAAAAA',
        ts: '2026-03-01T00:00:00.000Z',
        content: 'Not a JSON',
      },
      {
        id: VALID_ID_1,
        ts: '2026-03-01T01:00:00.000Z',
        content: JSON.stringify({
          v: 1,
          intent: '正常反馈',
          queries: [{ sql: 'SELECT 1' }],
          expected_ids: [VALID_ID_2],
        }),
      },
    ];
    const result = classifyFeedbacks(entries);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]!.id).toBe('NOT_JSON_IDAAAAAAAAAAAAAAA');
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]!.feedbackId).toBe(VALID_ID_1);
  });

  it('补充记录清空期望 ID 后，主反馈回到待补充', () => {
    const entries = [
      {
        id: VALID_ID_1,
        ts: '2026-03-01T00:00:00.000Z',
        content: JSON.stringify({
          v: 1,
          intent: '主反馈',
          queries: [{ sql: 'SELECT 1' }],
          expected_ids: [VALID_ID_2],
        }),
      },
      {
        id: VALID_ID_3,
        ts: '2026-03-01T01:00:00.000Z',
        content: JSON.stringify({
          v: 1,
          refines: VALID_ID_1,
          expected_ids: [],
        }),
      },
    ];
    const result = classifyFeedbacks(entries);
    expect(result.cases).toHaveLength(0);
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]!.feedbackId).toBe(VALID_ID_1);
  });
});
