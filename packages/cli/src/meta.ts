/**
 * meta 自动采集：不依赖调用方填写。
 *
 * 采集不到的字段一律省略（不写空串），git 相关的字段只在确实位于 git 仓库内时出现。
 */

import { execFileSync } from 'node:child_process';
import { arch, hostname as osHostname, platform, release } from 'node:os';
import { basename } from 'node:path';

import type { Meta } from '@liushui/core';

import { sanitizeGitRemote } from './sanitize.ts';
import { CLI_VERSION } from './version.ts';

/** 执行 git 命令并返回去掉首尾空白的 stdout；失败返回 null。 */
export type GitRunner = (args: readonly string[], cwd: string) => string | null;

export interface CollectMetaOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  runGit?: GitRunner;
  hostname?: () => string;
  argv0?: string;
  pid?: number;
  ppid?: number;
}

/** 默认的 git 执行器：找不到 git 或不在仓库内时返回 null。 */
export function defaultGitRunner(args: readonly string[], cwd: string): string | null {
  try {
    const out = execFileSync('git', [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      encoding: 'utf8',
    });
    return out.trim() === '' ? '' : out.trim();
  } catch {
    return null;
  }
}

function firstDefined(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}

function detectAgent(
  env: Record<string, string | undefined>,
): { name?: string; session?: string } {
  const explicitName = firstDefined(env, ['MEM_AGENT_NAME', 'MEM_AGENT']);
  const explicitSession = firstDefined(env, ['MEM_AGENT_SESSION', 'MEM_SESSION']);

  let name = explicitName;
  if (!name) {
    if (firstDefined(env, ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_SESSION_ID'])) name = 'claude';
    else if (firstDefined(env, ['CODEX_HOME', 'CODEX_SESSION_ID', 'OPENAI_CODEX'])) name = 'codex';
    else if (firstDefined(env, ['PI_SESSION_ID', 'PI_AGENT'])) name = 'pi';
  }
  const session =
    explicitSession ??
    firstDefined(env, ['CLAUDE_SESSION_ID', 'CODEX_SESSION_ID', 'PI_SESSION_ID']);

  const agent: { name?: string; session?: string } = {};
  if (name !== undefined) agent.name = name;
  if (session !== undefined) agent.session = session;
  return agent;
}

function collectGit(cwd: string, runGit: GitRunner): Meta | undefined {
  const toplevel = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (toplevel === null || toplevel === '') return undefined;

  const git: Meta = {};
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branch) git['branch'] = branch;
  const commit = runGit(['rev-parse', 'HEAD'], cwd);
  if (commit) git['commit'] = commit;
  const status = runGit(['status', '--porcelain'], cwd);
  if (status !== null) git['dirty'] = status !== '';

  // remote 一律清洗；清洗失败则省略 git.repo。
  const remote = runGit(['remote', 'get-url', 'origin'], cwd);
  if (remote) {
    const sanitized = sanitizeGitRemote(remote);
    if (sanitized !== null) git['repo'] = sanitized;
  }

  return Object.keys(git).length > 0 ? git : undefined;
}

/**
 * 采集 meta。所有无法获得的字段都被省略。
 * 注意：meta 的物理形态是嵌套对象，因此 `json_extract(meta, '$.git.branch')` 可用。
 */
export function collectMeta(options: CollectMetaOptions): Meta {
  const { cwd, env } = options;
  const runGit = options.runGit ?? defaultGitRunner;
  const hostname = options.hostname ?? osHostname;

  const meta: Meta = {};

  const host = hostname();
  if (host) meta['host'] = host;

  meta['os'] = { platform: platform(), release: release(), arch: arch() };
  if (cwd) meta['cwd'] = cwd;

  const argv0 = options.argv0 ?? process.argv[1] ?? process.argv[0] ?? '';
  const procName = argv0 ? basename(argv0) : undefined;
  const proc: Meta = {};
  if (procName) proc['name'] = procName;
  if (options.pid !== undefined) proc['pid'] = options.pid;
  if (options.ppid !== undefined) proc['ppid'] = options.ppid;
  if (Object.keys(proc).length > 0) meta['proc'] = proc;

  const git = collectGit(cwd, runGit);
  if (git) meta['git'] = git;

  const agent = detectAgent(env);
  if (Object.keys(agent).length > 0) meta['agent'] = agent;

  meta['cli'] = { version: CLI_VERSION };

  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) meta['tz'] = tz;
  } catch {
    // 采集不到时省略。
  }

  const src = firstDefined(env, ['MEM_SRC']);
  meta['src'] = src ?? 'cli';

  return meta;
}
