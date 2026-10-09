/**
 * `liushui` 命令行入口：参数解析、调用追加/查询逻辑、输出与退出码。
 *
 * 输出约定（便于人和 agent 解析）：
 * - append 单库成功：stdout 只输出 `id`（一行）。
 * - append 多库：stdout 输出 JSONL，每个库一行 `{"vault","ok","id","created":...}`。
 * - sql：stdout 为带表头的 TSV（`--json` 时为 JSONL），截断提示只写 stderr。
 * - 失败：单库写 stderr；多库把失败也写进 JSONL。任何库失败时退出码为 1。
 *
 * 退出码：0 成功；1 执行失败；2 用法或配置错误。
 *
 * 所有写出的文本都会再次清洗 token（最后一道防线）。
 */

import type { GitRunner } from './meta.ts';
import { runAppend } from './append.ts';
import { readConfiguredTokens } from './config.ts';
import { CliError, scrubSecrets } from './errors.ts';
import { runFeedbackCommand } from './feedback.ts';
import { DEFAULT_SQL_LIMIT, DEFAULT_SQL_MAX_WIDTH, runSqlCommand } from './sql.ts';
import { CLI_VERSION } from './version.ts';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** `liushui sql -` 或 `liushui feedback -` 从标准输入读取；默认读 process.stdin。 */
  readStdin?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  runGit?: GitRunner;
  hostname?: () => string;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
}

const USAGE = `用法：
  liushui append [--vault <name>]... [--kind <kind>] [--config <path>] [--env <name>] <内容...>
  liushui feedback [--vault <name>] [--config <path>] [--env <name>] <JSON | ->
  liushui sql [--vault <name>] [--json] [--limit N] [--max-width N] [--arg V]... <SQL | ->
  liushui --version
  liushui --help

示例：
  liushui append "修复了 iOS 渲染问题"
  liushui feedback '{"v":1,"intent":"搜渲染问题","queries":[{"sql":"SELECT 1"}]}'
  echo '{"v":1,"intent":"搜渲染问题","queries":[{"sql":"SELECT 1"}]}' | liushui feedback -
  liushui sql "SELECT id, kind FROM memories ORDER BY ts DESC LIMIT 5"
  echo "SELECT COUNT(*) FROM memories" | liushui sql -

说明：
  --vault 可重复，也可用逗号分隔（--vault personal,work）；省略时使用配置中的默认库。
  feedback 与 sql 一次只针对一个库（--vault 至多一个）。
  --kind 省略时默认 note。
  sql 默认输出带表头的 TSV，--json 输出 JSONL。
  sql 的 --limit 默认 ${DEFAULT_SQL_LIMIT}，--max-width 默认 ${DEFAULT_SQL_MAX_WIDTH}；--arg 可重复，作为位置参数传给 SQL。
  token 只从配置文件读取，不会出现在输出与日志中。
`;

interface ParsedArgs {
  command: 'append' | 'feedback' | 'sql' | 'help' | 'version';
  // append & feedback
  vaultNames: string[];
  kind: string;
  content: string;
  useStdin: boolean;
  // sql
  sqlText: string;
  sqlArgs: string[];
  json: boolean;
  limit: number | undefined;
  maxWidth: number | undefined;
  // shared
  configPath: string | undefined;
  envName: string | undefined;
}

function emptyArgs(): ParsedArgs {
  return {
    command: 'help',
    vaultNames: [],
    kind: 'note',
    content: '',
    useStdin: false,
    sqlText: '',
    sqlArgs: [],
    json: false,
    limit: undefined,
    maxWidth: undefined,
    configPath: undefined,
    envName: undefined,
  };
}

function parsePositiveInt(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`${flag} 需要一个正整数，得到 ${value}\n\n${USAGE}`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const result = emptyArgs();

  const first = argv[0];
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    result.command = 'help';
    return result;
  }
  if (first === '--version' || first === '-V' || first === 'version') {
    result.command = 'version';
    return result;
  }
  if (first !== 'append' && first !== 'feedback' && first !== 'sql') {
    throw new CliError(`未知子命令：${first}\n\n${USAGE}`);
  }

  const command = first;
  let index = 1;
  const positional: string[] = [];
  const takeValue = (flag: string, inline: string | undefined): string => {
    if (inline !== undefined) return inline;
    const next = argv[index + 1];
    if (next === undefined) throw new CliError(`${flag} 需要一个值\n\n${USAGE}`);
    index += 1;
    return next;
  };
  const inlineValue = (arg: string): string | undefined =>
    arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;

  for (; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith('--vault')) {
      const value = takeValue('--vault', inlineValue(arg));
      result.vaultNames.push(
        ...value
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== ''),
      );
      continue;
    }
    if (arg.startsWith('--config')) {
      result.configPath = takeValue('--config', inlineValue(arg));
      continue;
    }
    if (arg.startsWith('--env')) {
      result.envName = takeValue('--env', inlineValue(arg));
      continue;
    }
    if (command === 'append') {
      if (arg.startsWith('--kind')) {
        const value = takeValue('--kind', inlineValue(arg));
        if (value.trim() === '') throw new CliError('--kind 不能为空');
        result.kind = value.trim();
        continue;
      }
    } else if (command === 'feedback') {
      // feedback 不接受 --kind, --json 等
    } else {
      if (arg === '--json') {
        result.json = true;
        continue;
      }
      if (arg.startsWith('--limit')) {
        result.limit = parsePositiveInt('--limit', takeValue('--limit', inlineValue(arg)));
        continue;
      }
      if (arg.startsWith('--max-width')) {
        result.maxWidth = parsePositiveInt('--max-width', takeValue('--max-width', inlineValue(arg)));
        continue;
      }
      if (arg.startsWith('--arg')) {
        result.sqlArgs.push(takeValue('--arg', inlineValue(arg)));
        continue;
      }
    }
    if (arg === '--help' || arg === '-h') {
      result.command = 'help';
      return result;
    }
    if (arg.startsWith('-') && arg !== '-') {
      throw new CliError(`未知选项：${arg}\n\n${USAGE}`);
    }
    positional.push(arg);
  }

  if (command === 'append') {
    result.command = 'append';
    result.content = positional.join(' ');
    return result;
  }

  if (command === 'feedback') {
    result.command = 'feedback';
    if (positional.includes('-')) {
      if (positional.length !== 1) {
        throw new CliError('`-` 必须单独使用（从标准输入读取反馈 JSON）\n\n' + USAGE);
      }
      result.useStdin = true;
    } else {
      result.content = positional.join(' ');
    }
    return result;
  }

  result.command = 'sql';
  if (positional.includes('-')) {
    if (positional.length !== 1) {
      throw new CliError('`-` 必须单独使用（从标准输入读取 SQL）\n\n' + USAGE);
    }
    result.useStdin = true;
  } else {
    result.sqlText = positional.join(' ');
  }
  return result;
}

function formatMultiVaultReport(reports: Awaited<ReturnType<typeof runAppend>>['reports']): string {
  return reports
    .map((report) =>
      JSON.stringify(
        report.ok
          ? {
              vault: report.vault,
              ok: true,
              id: report.id,
              created: report.created,
            }
          : {
              vault: report.vault,
              ok: false,
              code: report.code,
              failure: report.failureKind,
              message: report.message,
            },
      ),
    )
    .join('\n');
}

async function readStdinDefault(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

/** 执行一条 CLI 命令，返回退出码。 */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const message = error instanceof CliError ? error.message : String(error);
    io.stderr(`${message}\n`);
    return error instanceof CliError ? error.exitCode : 2;
  }

  // token 清洗的最后一道防线：把配置文件里出现过的 token 全部抹掉。
  const secrets = readConfiguredTokens(args.configPath ?? io.env['LIUSHUI_CONFIG']);
  const out = (text: string): void => io.stdout(scrubSecrets(text, secrets));
  const err = (text: string): void => io.stderr(scrubSecrets(text, secrets));

  try {
    if (args.command === 'help') {
      out(USAGE);
      return 0;
    }
    if (args.command === 'version') {
      out(`${CLI_VERSION}\n`);
      return 0;
    }

    if (args.command === 'feedback') {
      const feedbackInput = args.useStdin
        ? await (io.readStdin ?? readStdinDefault)()
        : args.content;
      const result = await runFeedbackCommand(
        {
          input: feedbackInput,
          vaultNames: args.vaultNames,
        },
        {
          env: io.env,
          cwd: io.cwd,
          ...(args.configPath !== undefined ? { configPath: args.configPath } : {}),
          ...(args.envName !== undefined ? { envName: args.envName } : {}),
          ...(io.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}),
          ...(io.now !== undefined ? { now: io.now } : {}),
          ...(io.runGit !== undefined ? { runGit: io.runGit } : {}),
          ...(io.hostname !== undefined ? { hostname: io.hostname } : {}),
          ...(io.sleep !== undefined ? { sleep: io.sleep } : {}),
          ...(io.maxAttempts !== undefined ? { maxAttempts: io.maxAttempts } : {}),
          ...(io.baseDelayMs !== undefined ? { baseDelayMs: io.baseDelayMs } : {}),
          stderr: (t) => err(t),
        },
      );

      const report = result.appended.reports[0]!;
      if (report.ok) {
        out(`${report.id}\n`);
        return 0;
      }
      err(`liushui: 库 ${report.vault} 写入失败：${report.message ?? '未知错误'}\n`);
      return 1;
    }

    if (args.command === 'sql') {
      const sql = args.useStdin ? await (io.readStdin ?? readStdinDefault)() : args.sqlText;
      const result = await runSqlCommand(
        {
          sql,
          vaultNames: args.vaultNames,
          args: args.sqlArgs,
          limit: args.limit ?? DEFAULT_SQL_LIMIT,
          maxWidth: args.maxWidth ?? DEFAULT_SQL_MAX_WIDTH,
          json: args.json,
        },
        {
          env: io.env,
          cwd: io.cwd,
          ...(args.configPath !== undefined ? { configPath: args.configPath } : {}),
          ...(args.envName !== undefined ? { envName: args.envName } : {}),
          ...(io.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}),
          ...(io.sleep !== undefined ? { sleep: io.sleep } : {}),
          ...(io.maxAttempts !== undefined ? { maxAttempts: io.maxAttempts } : {}),
          ...(io.baseDelayMs !== undefined ? { baseDelayMs: io.baseDelayMs } : {}),
        },
      );
      out(result.stdout);
      err(result.stderr);
      return result.exitCode;
    }

    const result = await runAppend(
      { content: args.content, kind: args.kind, vaultNames: args.vaultNames },
      {
        env: io.env,
        cwd: io.cwd,
        ...(args.configPath !== undefined ? { configPath: args.configPath } : {}),
        ...(args.envName !== undefined ? { envName: args.envName } : {}),
        ...(io.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}),
        ...(io.now !== undefined ? { now: io.now } : {}),
        ...(io.runGit !== undefined ? { runGit: io.runGit } : {}),
        ...(io.hostname !== undefined ? { hostname: io.hostname } : {}),
        ...(io.sleep !== undefined ? { sleep: io.sleep } : {}),
        ...(io.maxAttempts !== undefined ? { maxAttempts: io.maxAttempts } : {}),
        ...(io.baseDelayMs !== undefined ? { baseDelayMs: io.baseDelayMs } : {}),
      },
    );

    if (result.reports.length === 1) {
      const report = result.reports[0]!;
      if (report.ok) {
        out(`${report.id}\n`);
        return 0;
      }
      err(`liushui: 库 ${report.vault} 写入失败：${report.message ?? '未知错误'}\n`);
      return 1;
    }

    out(`${formatMultiVaultReport(result.reports)}\n`);
    if (!result.ok) {
      const failed = result.reports.filter((report) => !report.ok).map((report) => report.vault);
      err(`liushui: 以下库写入失败：${failed.join(', ')}\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      err(`${error.message}\n`);
      return error.exitCode;
    }
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    err(`liushui: 未预期的错误：${detail}\n`);
    return 1;
  }
}
