import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createClient } from '@libsql/client';
import { loadMigrations } from '@liushui/core/migrations';
import { runMigrations } from '@liushui/core/storage';
import { runRegressCli } from '../../../scripts/regress.ts';

const ID_1 = 'RYRP4645Q2VOLZ4DOVYPLUKVA4';

describe('scripts/regress.ts CLI (task 4.1)', () => {
  it('端到端测试：snapshot -> run -> run --baseline (含退化检测与假 token 清洗)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'regress-cli-test-'));
    const dbFile = join(tempDir, 'test.db');
    const dbUrl = `file:${dbFile.replaceAll('\\', '/')}`;
    const client = createClient({ url: dbUrl });

    try {
      await runMigrations(client, loadMigrations());

      // 写入一条普通记忆
      await client.execute({
        sql: `INSERT INTO memories (id, ts, author, kind, content, meta, received_at, schema_v)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          ID_1,
          '2026-10-09T00:00:00.000Z',
          'will',
          'note',
          'iOS 渲染故障记录',
          '{}',
          '2026-10-09T00:00:00.000Z',
          1,
        ],
      });

      // 写入一条成功的反馈（期望命中 ID_1）
      await client.execute({
        sql: `INSERT INTO memories (id, ts, author, kind, content, meta, received_at, schema_v)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          'FEEDBACK000000000000000001',
          '2026-10-09T00:01:00.000Z',
          'will',
          'retrieval_feedback',
          JSON.stringify({
            v: 1,
            intent: '搜渲染',
            queries: [
              {
                sql: "SELECT m.id FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH fts('渲染')",
              },
            ],
            expected_ids: [ID_1],
          }),
          '{}',
          '2026-10-09T00:01:00.000Z',
          1,
        ],
      });

      // 1. 测试 snapshot 子命令
      const snapshotFile = join(tempDir, 'snapshot.jsonl');
      process.env['TURSO_URL'] = dbUrl;
      delete process.env['TURSO_AUTH_TOKEN'];

      const snapCode = await runRegressCli([
        'snapshot',
        '--name',
        'test-db',
        '--out',
        snapshotFile,
      ]);
      expect(snapCode).toBe(0);
      expect(existsSync(snapshotFile)).toBe(true);

      // 2. 测试 run 子命令导出首次报告（基线）
      const baselineReportFile = join(tempDir, 'baseline-report.json');
      const runCode = await runRegressCli([
        'run',
        '--snapshot',
        snapshotFile,
        '--out',
        baselineReportFile,
      ]);
      expect(runCode).toBe(0);
      expect(existsSync(baselineReportFile)).toBe(true);

      // 3. 测试 --baseline：正常无退化对比
      const secondReportFile = join(tempDir, 'second-report.json');
      const noRegressCode = await runRegressCli([
        'run',
        '--snapshot',
        snapshotFile,
        '--out',
        secondReportFile,
        '--baseline',
        baselineReportFile,
      ]);
      expect(noRegressCode).toBe(0);

      // 4. 人为制造一个退化：构造一份把该用例改回 fail 的新快照（修改 queries 使得搜不到），对比基线
      const regressedSnapshotFile = join(tempDir, 'regressed-snapshot.jsonl');
      const regressedLines = [
        JSON.stringify({
          liushui_snapshot: 1,
          taken_at: '2026-10-09T00:00:00.000Z',
          rows: 2,
          schema_versions: [1, 2],
        }),
        JSON.stringify({
          id: ID_1,
          ts: '2026-10-09T00:00:00.000Z',
          author: 'will',
          kind: 'note',
          content: 'iOS 渲染故障记录',
          meta: '{}',
          received_at: '2026-10-09T00:00:00.000Z',
          schema_v: 1,
        }),
        JSON.stringify({
          id: 'FEEDBACK000000000000000001',
          ts: '2026-10-09T00:01:00.000Z',
          author: 'will',
          kind: 'retrieval_feedback',
          content: JSON.stringify({
            v: 1,
            intent: '搜渲染',
            queries: [
              {
                sql: "SELECT m.id FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH fts('完全无关的词汇')",
              },
            ],
            expected_ids: [ID_1],
          }),
          meta: '{}',
          received_at: '2026-10-09T00:01:00.000Z',
          schema_v: 1,
        }),
      ];
      writeFileSync(regressedSnapshotFile, regressedLines.join('\n') + '\n', 'utf8');

      const regressReportFile = join(tempDir, 'regress-report.json');
      const regressCode = await runRegressCli([
        'run',
        '--snapshot',
        regressedSnapshotFile,
        '--out',
        regressReportFile,
        '--baseline',
        baselineReportFile,
      ]);
      // 存在退化时退出码为 1
      expect(regressCode).toBe(1);

      // 5. 测试假 token 报错清洗：连接错误时不泄漏 token
      const fakeToken = 'secret-fake-super-token-12345';
      process.env['TURSO_URL'] = 'libsql://fake-domain-that-does-not-exist-123456789.turso.io';
      process.env['TURSO_AUTH_TOKEN'] = fakeToken;

      let errOutput = '';
      const origStderr = process.stderr.write;
      process.stderr.write = (chunk: unknown) => {
        errOutput += String(chunk);
        return true;
      };

      try {
        const fakeCode = await runRegressCli([
          'snapshot',
          '--name',
          'fake',
          '--out',
          join(tempDir, 'fake.jsonl'),
        ]);
        expect(fakeCode).toBe(2);
        expect(errOutput).not.toContain(fakeToken);
      } finally {
        process.stderr.write = origStderr;
      }
    } finally {
      client.close();
      delete process.env['TURSO_URL'];
      delete process.env['TURSO_AUTH_TOKEN'];
      for (let i = 0; i < 20; i++) {
        try {
          rmSync(tempDir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
  });
});
