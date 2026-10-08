/**
 * `mem` 命令行入口：参数解析、调用追加逻辑、输出与退出码。
 *
 * 输出约定（便于人和 agent 解析）：
 * - 单库成功：stdout 只输出 `id`（一行）。
 * - 多库：stdout 输出 JSONL，每个库一行 `{"vault","ok","id","created":...}`。
 * - 失败：单库写 stderr；多库把失败也写进 JSONL。任何库失败时退出码为 1。
 *
 * 退出码：0 成功；1 写入失败；2 用法或配置错误。
 *
 * 所有写出的文本都会再次清洗 token（最后一道防线）。
 */

import type { GitRunner } from './meta.ts';
import { runAppend } from './append.ts';
import { readConfiguredTokens } from './config.ts';
import { CliError, scrubSecrets } from './errors.ts';
import { CLI_VERSION } from './version.ts';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  runGit?: GitRunner;
  hostname?: () => string;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
}

const USAGE = `用法：
  mem append [--vault <name>]... [--kind <kind>] [--config <path>] [--env <name>] <内容...>
  mem --version
  mem --help

示例：
  mem append "修复了 iOS 渲染问题"
  mem append --vault personal --vault work --kind note "同一条记忆写入两个库"

说明：
  --vault 可重复，也可用逗号分隔（--vault personal,work）；省略时使用配置中的默认库。
  --kind 省略时默认 note。
  token 只从配置文件读取，不会出现在输出与日志中。
`;

interface ParsedArgs {
  command: 'append' | 'help' | 'version';
  vaultNames: string[];
  kind: string;
  content: string;
  configPath: string | undefined;
  envName: string | undefined;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: 'help',
    vaultNames: [],
    kind: 'note',
    content: '',
    configPath: undefined,
    envName: undefined,
  };

  let index = 0;
  const first = argv[0];
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    result.command = 'help';
    return result;
  }
  if (first === '--version' || first === '-V' || first === 'version') {
    result.command = 'version';
    return result;
  }
  if (first !== 'append') {
    throw new CliError(`未知子命令：${first}\n\n${USAGE}`);
  }
  result.command = 'append';
  index = 1;

  const positional: string[] = [];
  const takeValue = (flag: string, inline: string | undefined): string => {
    if (inline !== undefined) return inline;
    const next = argv[index + 1];
    if (next === undefined) throw new CliError(`${flag} 需要一个值\n\n${USAGE}`);
    index += 1;
    return next;
  };

  for (; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith('--vault')) {
      const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;
      const value = takeValue('--vault', inline);
      result.vaultNames.push(
        ...value
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== ''),
      );
      continue;
    }
    if (arg.startsWith('--kind')) {
      const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;
      const value = takeValue('--kind', inline);
      if (value.trim() === '') throw new CliError('--kind 不能为空');
      result.kind = value.trim();
      continue;
    }
    if (arg.startsWith('--config')) {
      const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;
      result.configPath = takeValue('--config', inline);
      continue;
    }
    if (arg.startsWith('--env')) {
      const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;
      result.envName = takeValue('--env', inline);
      continue;
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

  result.content = positional.join(' ');
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
  const secrets = readConfiguredTokens(args.configPath ?? io.env['MEM_CONFIG']);
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
      err(`mem: 库 ${report.vault} 写入失败：${report.message ?? '未知错误'}\n`);
      return 1;
    }

    out(`${formatMultiVaultReport(result.reports)}\n`);
    if (!result.ok) {
      const failed = result.reports.filter((report) => !report.ok).map((report) => report.vault);
      err(`mem: 以下库写入失败：${failed.join(', ')}\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      err(`${error.message}\n`);
      return error.exitCode;
    }
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    err(`mem: 未预期的错误：${detail}\n`);
    return 1;
  }
}
