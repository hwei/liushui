/**
 * `liushui sql` 的核心逻辑：单库、一次性查询，结果写到 stdout，截断/错误写到 stderr。
 *
 * 与进程解耦：返回 `{ exitCode, stdout, stderr }`，由 `main` 统一做 token 清洗与输出。
 */

import { postSql } from './client.ts';
import { loadConfig } from './config.ts';
import { CliError } from './errors.ts';
import { proxyHint } from './proxy-hint.ts';
import { formatJsonl, formatTsv } from './query-format.ts';

/** `--limit` 默认值。 */
export const DEFAULT_SQL_LIMIT = 50;
/** `--max-width` 默认值。 */
export const DEFAULT_SQL_MAX_WIDTH = 200;

export interface SqlCommandOptions {
  sql: string;
  /** `--vault`；查询至多一个，多个是用法错误。 */
  vaultNames: readonly string[];
  /** 可重复的 `--arg`。 */
  args: readonly string[];
  limit: number;
  maxWidth: number;
  json: boolean;
}

export interface SqlCommandDeps {
  env: Record<string, string | undefined>;
  cwd: string;
  configPath?: string;
  envName?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
}

export interface SqlCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 执行一次 `liushui sql`。用法/配置错误抛 `CliError`（退出码 2）。 */
export async function runSqlCommand(
  options: SqlCommandOptions,
  deps: SqlCommandDeps,
): Promise<SqlCommandResult> {
  if (options.vaultNames.length > 1) {
    throw new CliError('查询一次只能针对一个库，--vault 至多一个', 2);
  }
  if (options.sql.trim() === '') {
    throw new CliError('SQL 不能为空', 2);
  }

  const config = loadConfig({
    ...(deps.configPath !== undefined ? { configPath: deps.configPath } : {}),
    ...(deps.envName !== undefined ? { env: deps.envName } : {}),
    vaultNames: options.vaultNames,
    envVars: deps.env,
  });
  const vault = config.vaults[0]!;

  const outcome = await postSql(
    vault,
    { sql: options.sql, args: options.args, limit: options.limit },
    {
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
      ...(deps.baseDelayMs !== undefined ? { baseDelayMs: deps.baseDelayMs } : {}),
    },
  );

  if (!outcome.ok) {
    const hint = outcome.kind === 'network' ? proxyHint(deps.env) : null;
    const message = hint !== null ? `${outcome.message}\n${hint}` : outcome.message;
    return { exitCode: 1, stdout: '', stderr: `liushui: 查询失败：${message}\n` };
  }

  const response = outcome.response;
  const formatted = options.json
    ? formatJsonl(response.columns, response.rows, options.maxWidth)
    : formatTsv(response.columns, response.rows, options.maxWidth);

  let stderr = '';
  if (response.truncated.rows) {
    stderr += `liushui: 结果已截断（行数上限 ${options.limit}）\n`;
  }
  const truncatedCells = formatted.truncatedCells + (response.truncated.cells ?? 0);
  if (truncatedCells > 0) {
    stderr += `liushui: ${truncatedCells} 个单元格被截断\n`;
  }

  return { exitCode: 0, stdout: formatted.text, stderr };
}
