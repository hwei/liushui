/**
 * `liushui append` 的核心逻辑（与进程/终端解耦，便于测试）。
 *
 * 一次命令只生成一份核心字段（`ts`、`id`），因此：
 * - 发往多个库时 id 相同；
 * - 重试时 `ts` 与 `id` 不变，服务端幂等保证不重复。
 */

import { computeId, type Meta } from '@liushui/core';

import { postAppend, type AppendFailureKind, type AppendOutcome } from './client.ts';
import { loadConfig, type ResolvedVault } from './config.ts';
import { CliError } from './errors.ts';
import { collectMeta, type GitRunner } from './meta.ts';
import { proxyHint } from './proxy-hint.ts';
import { redactMeta } from './redact.ts';

export interface AppendCommandOptions {
  content: string;
  kind: string;
  /** `--vault` 指定的库；为空时用默认库。 */
  vaultNames: readonly string[];
}

export interface AppendCommandDeps {
  env: Record<string, string | undefined>;
  cwd: string;
  configPath?: string;
  envName?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  runGit?: GitRunner;
  hostname?: () => string;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
}

/** 单个库的结果，用于逐库报告。 */
export interface VaultReport {
  vault: string;
  ok: boolean;
  id: string | null;
  created: boolean | null;
  failureKind: AppendFailureKind | null;
  code: string | null;
  message: string | null;
  attempts: number;
}

export interface AppendCommandResult {
  id: string;
  ts: string;
  ok: boolean;
  reports: VaultReport[];
}

/** 记忆作者：优先 LIUSHUI_AUTHOR，其次系统用户名。 */
export function resolveAuthor(env: Record<string, string | undefined>): string {
  return env['LIUSHUI_AUTHOR'] ?? env['USER'] ?? env['USERNAME'] ?? 'unknown';
}

function toReport(
  vault: ResolvedVault,
  outcome: AppendOutcome,
  networkHint: string | null,
): VaultReport {
  if (outcome.ok) {
    return {
      vault: vault.name,
      ok: true,
      id: outcome.id,
      created: outcome.created,
      failureKind: null,
      code: null,
      message: null,
      attempts: outcome.attempts,
    };
  }
  // 只在网络类失败时附加代理提示；服务端 / 客户端错误保持原样。
  const message =
    outcome.kind === 'network' && networkHint !== null
      ? `${outcome.message}\n${networkHint}`
      : outcome.message;
  return {
    vault: vault.name,
    ok: false,
    id: null,
    created: null,
    failureKind: outcome.kind,
    code: outcome.code,
    message,
    attempts: outcome.attempts,
  };
}

/** 收集 meta 并按库脱敏。 */
export function buildMetaByVault(
  meta: Meta,
  vaults: readonly ResolvedVault[],
): Array<{ vault: ResolvedVault; meta: Meta }> {
  return vaults.map((vault) => ({ vault, meta: redactMeta(meta, vault.redact) }));
}

/** 执行一次追加。空内容会直接报错，不发出任何请求。 */
export async function runAppend(
  options: AppendCommandOptions,
  deps: AppendCommandDeps,
): Promise<AppendCommandResult> {
  if (options.content.trim() === '') {
    throw new CliError('内容不能为空', 2);
  }

  const config = loadConfig({
    ...(deps.configPath !== undefined ? { configPath: deps.configPath } : {}),
    ...(deps.envName !== undefined ? { env: deps.envName } : {}),
    vaultNames: options.vaultNames,
    envVars: deps.env,
  });

  const now = deps.now ?? ((): Date => new Date());
  const ts = now().toISOString();
  const author = resolveAuthor(deps.env);
  const kind = options.kind;
  const content = options.content;

  // 只算一次 id：与库无关，也与 meta 无关。
  const id = await computeId({ ts, author, kind, content });

  const meta = collectMeta({
    cwd: deps.cwd,
    env: deps.env,
    ...(deps.runGit !== undefined ? { runGit: deps.runGit } : {}),
    ...(deps.hostname !== undefined ? { hostname: deps.hostname } : {}),
  });

  const reports: VaultReport[] = [];
  const networkHint = proxyHint(deps.env);
  for (const { vault, meta: vaultMeta } of buildMetaByVault(meta, config.vaults)) {
    const outcome = await postAppend(
      vault,
      { id, ts, author, kind, content, meta: vaultMeta },
      {
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
        ...(deps.baseDelayMs !== undefined ? { baseDelayMs: deps.baseDelayMs } : {}),
        ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      },
    );
    reports.push(toReport(vault, outcome, networkHint));
  }

  return { id, ts, ok: reports.every((report) => report.ok), reports };
}
