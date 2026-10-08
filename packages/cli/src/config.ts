/**
 * 本地配置：各库的服务地址与 token、默认库、dev/prod 环境选择，以及按库的 meta 脱敏。
 *
 * 配置文件默认位于 `~/.config/liushui/config.json`，可用 `LIUSHUI_CONFIG` 或 `--config` 覆盖。
 * token 只从配置读取，不出现在任何输出与日志中。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CliError } from './errors.ts';

/** 单个库在某环境下的配置。 */
export interface VaultConfig {
  url: string;
  token: string;
  /** 该库需要移除的 meta 点号路径，例如 ["cwd", "git.repo"]。 */
  redact: string[];
}

/** 单个环境（dev/prod/自定义）的配置。 */
export interface EnvironmentConfig {
  defaultVault: string | undefined;
  vaults: Record<string, VaultConfig>;
}

/** 配置文件结构。 */
export interface CliConfigFile {
  /** 默认环境名。 */
  env: string | undefined;
  environments: Record<string, EnvironmentConfig>;
}

/** 解析后的某个目标库。 */
export interface ResolvedVault {
  name: string;
  url: string;
  token: string;
  redact: string[];
}

/** 解析后的配置。 */
export interface ResolvedConfig {
  path: string;
  env: string;
  vaults: ResolvedVault[];
}

export interface LoadConfigOptions {
  /** 配置文件路径；默认 `LIUSHUI_CONFIG` 或 `~/.config/liushui/config.json`。 */
  configPath?: string;
  /** 环境名；默认 `LIUSHUI_ENV`、配置文件里的 env、再退回 "dev"。 */
  env?: string;
  /** 目标库名；省略时用默认库。 */
  vaultNames?: readonly string[];
  /** 用于读取 LIUSHUI_CONFIG / LIUSHUI_ENV。 */
  envVars?: Record<string, string | undefined>;
}

/** 默认配置文件路径。 */
export function defaultConfigPath(home: string = homedir()): string {
  return join(home, '.config', 'liushui', 'config.json');
}

/**
 * 尽力而为地读出配置里的所有 token，供输出清洗使用（最后一道防线）。
 * 配置不存在或损坏时返回空数组，不抛错：真正的错误由 loadConfig 报出。
 */
export function readConfiguredTokens(configPath?: string): string[] {
  const path = configPath ?? process.env['LIUSHUI_CONFIG'] ?? defaultConfigPath();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed['environments'])) return [];
    const tokens: string[] = [];
    for (const environment of Object.values(parsed['environments'])) {
      if (!isRecord(environment) || !isRecord(environment['vaults'])) continue;
      for (const vault of Object.values(environment['vaults'])) {
        if (isRecord(vault) && typeof vault['token'] === 'string') tokens.push(vault['token']);
      }
    }
    return tokens;
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVault(name: string, value: unknown): VaultConfig {
  if (!isRecord(value)) {
    throw new CliError(`配置错误：库 ${name} 必须是对象`);
  }
  const { url, token, redact } = value;
  if (typeof url !== 'string' || url.trim() === '') {
    throw new CliError(`配置错误：库 ${name} 缺少非空 url`);
  }
  if (typeof token !== 'string' || token.trim() === '') {
    throw new CliError(`配置错误：库 ${name} 缺少非空 token`);
  }
  if (redact !== undefined && (!Array.isArray(redact) || redact.some((p) => typeof p !== 'string'))) {
    throw new CliError(`配置错误：库 ${name} 的 redact 必须是字符串数组`);
  }
  return { url, token, redact: (redact as string[] | undefined) ?? [] };
}

function parseEnvironment(name: string, value: unknown): EnvironmentConfig {
  if (!isRecord(value)) {
    throw new CliError(`配置错误：环境 ${name} 必须是对象`);
  }
  const rawVaults = value['vaults'];
  if (!isRecord(rawVaults) || Object.keys(rawVaults).length === 0) {
    throw new CliError(`配置错误：环境 ${name} 未配置任何库`);
  }
  const vaults: Record<string, VaultConfig> = {};
  for (const [vaultName, vaultValue] of Object.entries(rawVaults)) {
    vaults[vaultName] = parseVault(vaultName, vaultValue);
  }
  const defaultVault = value['defaultVault'];
  if (defaultVault !== undefined && typeof defaultVault !== 'string') {
    throw new CliError(`配置错误：环境 ${name} 的 defaultVault 必须是字符串`);
  }
  if (defaultVault !== undefined && !(defaultVault in vaults)) {
    throw new CliError(`配置错误：环境 ${name} 的 defaultVault 指向未配置的库 ${defaultVault}`);
  }
  return { defaultVault, vaults };
}

/** 解析配置文件内容。 */
export function parseConfig(raw: string): CliConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError('配置文件不是合法 JSON');
  }
  if (!isRecord(parsed)) throw new CliError('配置文件必须是 JSON 对象');
  const rawEnvironments = parsed['environments'];
  if (!isRecord(rawEnvironments) || Object.keys(rawEnvironments).length === 0) {
    throw new CliError('配置文件缺少 environments');
  }
  const environments: Record<string, EnvironmentConfig> = {};
  for (const [name, value] of Object.entries(rawEnvironments)) {
    environments[name] = parseEnvironment(name, value);
  }
  const env = parsed['env'];
  if (env !== undefined && typeof env !== 'string') {
    throw new CliError('配置错误：env 必须是字符串');
  }
  return { env, environments };
}

/**
 * 读取并解析配置，选出本次要写入的库。
 * 未配置时抛出带配置指引的错误（不发出任何请求）。
 */
export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
  const vars = options.envVars ?? {};
  const path = options.configPath ?? vars['LIUSHUI_CONFIG'] ?? defaultConfigPath();

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new CliError(
      [
        `未找到配置文件：${path}`,
        '请创建该文件，或设置 LIUSHUI_CONFIG 指向配置文件。格式示例：',
        JSON.stringify(
          {
            env: 'dev',
            environments: {
              dev: {
                defaultVault: 'personal',
                vaults: {
                  personal: { url: 'http://127.0.0.1:8787', token: '<token>', redact: ['cwd'] },
                },
              },
            },
          },
          null,
          2,
        ),
      ].join('\n'),
    );
  }

  const config = parseConfig(raw);
  const env = options.env ?? vars['LIUSHUI_ENV'] ?? config.env ?? 'dev';
  const environment = config.environments[env];
  if (!environment) {
    const known = Object.keys(config.environments).join(', ');
    throw new CliError(`配置中没有环境 ${env}（可选：${known}）`);
  }

  const requested = options.vaultNames && options.vaultNames.length > 0
    ? [...options.vaultNames]
    : environment.defaultVault
      ? [environment.defaultVault]
      : [];
  if (requested.length === 0) {
    throw new CliError(
      `环境 ${env} 没有默认库，请用 --vault 指定，或在配置中设置 defaultVault`,
    );
  }

  const vaults: ResolvedVault[] = [];
  for (const name of requested) {
    const vault = environment.vaults[name];
    if (!vault) {
      const known = Object.keys(environment.vaults).join(', ');
      throw new CliError(`环境 ${env} 中没有库 ${name}（可选：${known}）`);
    }
    vaults.push({ name, url: vault.url.replace(/\/+$/, ''), token: vault.token, redact: vault.redact });
  }

  return { path, env, vaults };
}
