import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFeedbackCommand } from '../src/feedback.ts';
import { runEvaluation } from '@liushui/core/storage';
import { exportSnapshot } from '@liushui/core/storage';
import { startLocalWorker, type LocalWorker } from './worker-harness.ts';
import { writeTempConfig, type TempConfigFile } from './utils.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';

const configFor = (url: string, token: string) => ({
  env: 'dev',
  environments: {
    dev: {
      defaultVault: 'personal',
      vaults: {
        personal: { url, token },
      },
    },
  },
});

describe('skill 中的反馈示例验证 (task 5.1)', () => {
  let worker: LocalWorker;
  beforeEach(async () => {
    worker = await startLocalWorker();
  });
  afterEach(async () => {
    await worker.cleanup();
  });

  it('skill 中的反馈示例经 liushui feedback 写入成功，且能被评估识别为用例与补充', async () => {
    const file: TempConfigFile = writeTempConfig(configFor(worker.url, worker.token));
    const tempFiles: string[] = [];
    try {
      // 写入被期望命中的目标记忆
      const targetMemory = await worker.client.execute({
        sql: `INSERT INTO memories (id, ts, author, kind, content, meta, received_at, schema_v)
              VALUES ('RYRP4645Q2VOLZ4DOVYPLUKVA4', '2026-10-09T00:00:00.000Z', 'will', 'note', 'Metal 着色器渲染指南', '{}', '2026-10-09T00:00:00.000Z', 1)
              RETURNING id`,
      });
      const targetId = String(targetMemory.rows[0]?.['id']);
      expect(targetId).toBe('RYRP4645Q2VOLZ4DOVYPLUKVA4');

      // 1. skill 中的主反馈示例（带 expected_ids）
      const example1 = JSON.stringify({
        v: 1,
        intent: '查找上次 iOS 渲染问题是怎么排查解决的',
        queries: [
          {
            sql: "SELECT m.id, m.content FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH fts('iOS渲染') ORDER BY rank",
            outcome: '0 行',
          },
          {
            sql: "SELECT id, content FROM memories WHERE content LIKE '%渲染%'",
            outcome: '3 行，但都是 Web 端渲染，不是 iOS',
          },
        ],
        expected_ids: ['RYRP4645Q2VOLZ4DOVYPLUKVA4'],
        cause: '原文写的是“Metal 着色器”，没有出现“渲染”二字：同义词问题',
      });

      const res1 = await runFeedbackCommand(
        { input: example1, vaultNames: ['personal'] },
        {
          cwd: process.cwd(),
          env: { LIUSHUI_CONFIG: file.path },
          fetchImpl: fetch,
        },
      );
      expect(res1.id).toBeTruthy();

      // 2. skill 中的补充记录示例
      // 插入一条新的目标记忆供补充记录引用
      await worker.client.execute({
        sql: `INSERT INTO memories (id, ts, author, kind, content, meta, received_at, schema_v)
              VALUES ('BCDEFGHJKMNPQRSTVWXYZ23456', '2026-10-09T00:00:10.000Z', 'will', 'note', '补充的记录', '{}', '2026-10-09T00:00:10.000Z', 1)`,
      });

      const example2 = JSON.stringify({
        v: 1,
        refines: res1.id,
        expected_ids: ['BCDEFGHJKMNPQRSTVWXYZ23456'],
        note: '事后翻阅流水账找到了当时记录的真实 ID',
      });

      const res2 = await runFeedbackCommand(
        { input: example2, vaultNames: ['personal'] },
        {
          cwd: process.cwd(),
          env: { LIUSHUI_CONFIG: file.path },
          fetchImpl: fetch,
        },
      );
      expect(res2.id).toBeTruthy();

      // 3. 导出快照并执行评估，断言其被识别为有效用例（并成功生效了补充记录的期望 ID）
      const snapshotPath = join(tmpdir(), `skill-verify-${Date.now()}.jsonl`);
      tempFiles.push(snapshotPath);

      const lines: string[] = [];
      await exportSnapshot(worker.client, {
        writeLine: (l) => {
          lines.push(l);
        },
      });
      writeFileSync(snapshotPath, lines.join('\n') + '\n', 'utf8');

      const evaluation = await runEvaluation({ snapshotPath });
      expect(evaluation.summary.invalidCount).toBe(0);
      expect(evaluation.cases).toHaveLength(1);
      const caseItem = evaluation.cases[0]!;
      expect(caseItem.case.feedbackId).toBe(res1.id);
      expect(caseItem.case.expectedIds).toEqual(['BCDEFGHJKMNPQRSTVWXYZ23456']);
      expect(caseItem.case.refinementId).toBe(res2.id);
    } finally {
      file.remove();
      for (const f of tempFiles) {
        try {
          unlinkSync(f);
        } catch {
          // ignore
        }
      }
    }
  });
});
