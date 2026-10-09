/**
 * 回归工具命令行入口：本地快照导出与回归评估执行。
 *
 * 用法：
 *   # 导出快照（凭据只从环境变量读取）：
 *   TURSO_URL=libsql://... TURSO_AUTH_TOKEN=... npm run regress -- snapshot --name personal-prod
 *   # -> .liushui/snapshots/personal-prod-<UTC时间>.jsonl
 *
 *   # 评估（默认写报告到 .liushui/reports/，摘要打到 stdout）：
 *   npm run regress -- run --snapshot .liushui/snapshots/personal-prod-....jsonl [--out <file>] [--baseline <report.json>]
 *
 * 退出码：
 *   0: 成功 / 无退化
 *   1: 存在退化
 *   2: 用法错误、文件错误或连接错误
 */

import { execSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import {
  compareWithBaseline,
  type BaselineReport,
} from '@liushui/core';
import {
  exportSnapshot,
  runEvaluation,
  type EvaluationResult,
  type SnapshotWriter,
} from '@liushui/core/storage';

const USAGE = `用法：
  npm run regress -- snapshot --name <prefix> [--out <file>]
  npm run regress -- run --snapshot <path> [--out <file>] [--baseline <report.json>]

说明：
  snapshot:
    从 TURSO_URL 与 TURSO_AUTH_TOKEN 环境变量读取数据库凭据；
    默认导出到 .liushui/snapshots/<prefix>-<UTC时间>.jsonl。
  run:
    对快照在临时本地文件库上执行迁移、派生数据重建与用例评估；
    默认写报告到 .liushui/reports/<快照名>-<UTC时间>.json；
    指定 --baseline 时与历史报告对比，存在退化时以退出码 1 退出。
`;

interface GitInfo {
  commit: string;
  dirty: boolean;
}

function getGitInfo(): GitInfo {
  try {
    const commit = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const status = execSync('git status --porcelain', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return {
      commit,
      dirty: status.length > 0,
    };
  } catch {
    return {
      commit: 'unknown',
      dirty: false,
    };
  }
}

function formatUtcTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .replace('T', '-');
}

export async function runRegressCli(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (sub === 'snapshot') {
    return runSnapshotSubcommand(argv.slice(1));
  } else if (sub === 'run') {
    return runRunSubcommand(argv.slice(1));
  } else {
    process.stderr.write(`未知子命令：${sub}\n\n${USAGE}`);
    return 2;
  }
}

async function runSnapshotSubcommand(args: string[]): Promise<number> {
  let name: string | undefined;
  let outFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--name') {
      name = args[++i];
    } else if (a.startsWith('--name=')) {
      name = a.slice('--name='.length);
    } else if (a === '--out') {
      outFile = args[++i];
    } else if (a.startsWith('--out=')) {
      outFile = a.slice('--out='.length);
    } else {
      process.stderr.write(`未知选项：${a}\n\n${USAGE}`);
      return 2;
    }
  }

  if (!name && !outFile) {
    process.stderr.write(`缺少 --name 或 --out 参数\n\n${USAGE}`);
    return 2;
  }

  const url = process.env['TURSO_URL'];
  const token = process.env['TURSO_AUTH_TOKEN'];
  if (!url) {
    process.stderr.write(`缺少 TURSO_URL 环境变量\n\n${USAGE}`);
    return 2;
  }

  const now = new Date();
  const targetPath =
    outFile ??
    join(process.cwd(), '.liushui', 'snapshots', `${name}-${formatUtcTimestamp(now)}.jsonl`);

  // 保证父目录存在
  const parentDir = join(targetPath, '..');
  mkdirSync(parentDir, { recursive: true });

  const client = createClient(token ? { url, authToken: token } : { url });
  const writeStream = createWriteStream(targetPath, { encoding: 'utf8' });

  const writer: SnapshotWriter = {
    writeLine: async (line: string) => {
      if (!writeStream.write(line + '\n')) {
        await new Promise<void>((resolve) => {
          writeStream.once('drain', () => resolve());
        });
      }
    },
  };

  try {
    const header = await exportSnapshot(client, writer, { now: () => now });
    await new Promise((resolve, reject) => {
      writeStream.end((err?: Error | null) => (err ? reject(err) : resolve(null)));
    });

    process.stdout.write(
      `快照已导出：${targetPath}（共 ${header.rows} 行，taken_at: ${header.taken_at}）\n`,
    );
    return 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const scrubbed = token ? msg.replaceAll(token, '***') : msg;
    process.stderr.write(`快照导出失败：${scrubbed}\n`);
    return 2;
  } finally {
    client.close();
  }
}

async function runRunSubcommand(args: string[]): Promise<number> {
  let snapshotPath: string | undefined;
  let outFile: string | undefined;
  let baselinePath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--snapshot') {
      snapshotPath = args[++i];
    } else if (a.startsWith('--snapshot=')) {
      snapshotPath = a.slice('--snapshot='.length);
    } else if (a === '--out') {
      outFile = args[++i];
    } else if (a.startsWith('--out=')) {
      outFile = a.slice('--out='.length);
    } else if (a === '--baseline') {
      baselinePath = args[++i];
    } else if (a.startsWith('--baseline=')) {
      baselinePath = a.slice('--baseline='.length);
    } else {
      process.stderr.write(`未知选项：${a}\n\n${USAGE}`);
      return 2;
    }
  }

  if (!snapshotPath) {
    process.stderr.write(`缺少 --snapshot 参数\n\n${USAGE}`);
    return 2;
  }

  if (!existsSync(snapshotPath)) {
    process.stderr.write(`快照文件不存在：${snapshotPath}\n`);
    return 2;
  }

  let baseline: BaselineReport | undefined;
  if (baselinePath) {
    if (!existsSync(baselinePath)) {
      process.stderr.write(`基线文件不存在：${baselinePath}\n`);
      return 2;
    }
    try {
      baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineReport;
    } catch (err) {
      process.stderr.write(`基线文件解析失败：${String(err)}\n`);
      return 2;
    }
  }

  const git = getGitInfo();
  let evalResult: EvaluationResult;
  try {
    evalResult = await runEvaluation({ snapshotPath });
  } catch (err) {
    process.stderr.write(`评估执行失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const generatedAt = new Date().toISOString();
  const fullReport = {
    generated_at: generatedAt,
    git: {
      commit: git.commit,
      dirty: git.dirty,
    },
    snapshot: {
      path: snapshotPath,
      taken_at: evalResult.header.taken_at,
      rows: evalResult.header.rows,
      schema_versions: evalResult.header.schema_versions,
    },
    derived_versions: evalResult.derivedVersions,
    summary: evalResult.summary,
    cases: evalResult.cases.map((c) => ({
      feedbackId: c.case.feedbackId,
      status: c.status,
      intent: c.case.intent,
      expectedIds: c.case.expectedIds,
      bestHits: c.bestHits,
      cause: c.case.cause,
      serviceVersion: c.case.serviceVersion,
      queries: c.queryResults.map((q) => ({
        sql: q.sql,
        hits: q.hits,
        error: q.error,
        outcome: q.outcome,
      })),
    })),
    pending: evalResult.pending,
    invalid: evalResult.invalid,
  };

  const reportOut =
    outFile ??
    join(
      process.cwd(),
      '.liushui',
      'reports',
      `report-${formatUtcTimestamp(new Date())}.json`,
    );

  mkdirSync(join(reportOut, '..'), { recursive: true });
  writeFileSync(reportOut, JSON.stringify(fullReport, null, 2), 'utf8');

  // 输出摘要到 stdout
  process.stdout.write(`=== 回归评估报告 ===\n`);
  process.stdout.write(`快照：${snapshotPath}（${evalResult.header.rows} 行记忆）\n`);
  process.stdout.write(`Git：${git.commit}${git.dirty ? ' (dirty)' : ''}\n`);
  process.stdout.write(
    `派生版本：${evalResult.derivedVersions.map((d) => `${d.name}@${d.version} (${d.rows} 行)`).join(', ')}\n`,
  );
  process.stdout.write(
    `用例统计：共 ${evalResult.summary.totalCases} 个用例（pass: ${evalResult.summary.pass}, partial: ${evalResult.summary.partial}, fail: ${evalResult.summary.fail}, error: ${evalResult.summary.error}）；待补充: ${evalResult.summary.pendingCount}；无效: ${evalResult.summary.invalidCount}\n`,
  );
  process.stdout.write(`完整报告已保存至：${reportOut}\n`);

  let exitCode = 0;
  if (baseline) {
    const diff = compareWithBaseline(evalResult.cases, baseline);
    process.stdout.write(`\n=== 基线对比结果 ===\n`);
    if (diff.improved.length > 0) {
      process.stdout.write(`改善 (${diff.improved.length}):\n`);
      for (const imp of diff.improved) {
        process.stdout.write(`  + ${imp.feedbackId}: ${imp.from} -> ${imp.to}\n`);
      }
    }
    if (diff.added.length > 0) {
      process.stdout.write(`新增用例 (${diff.added.length}):\n`);
      for (const add of diff.added) {
        process.stdout.write(`  * ${add.feedbackId}: ${add.to}\n`);
      }
    }
    if (diff.regressed.length > 0) {
      process.stdout.write(`退化 (${diff.regressed.length}):\n`);
      for (const reg of diff.regressed) {
        process.stdout.write(`  ! ${reg.feedbackId}: ${reg.from} -> ${reg.to}\n`);
      }
      exitCode = 1;
    } else {
      process.stdout.write(`无退化。\n`);
    }
  }

  return exitCode;
}

// 仅在直接执行本文件时启动 CLI
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('regress.ts') || process.argv[1].endsWith('regress.js'));

if (isMainModule) {
  runRegressCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
