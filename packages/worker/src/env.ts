/**
 * Worker 的运行时配置（Cloudflare Worker bindings / secrets）。
 *
 * 每个库一个独立的数据库，token 与库一一绑定。token 只存在于 Worker secrets 与
 * 本地 `.dev.vars`，绝不写入日志或响应。
 */

import { DEFAULT_MAX_CONTENT_BYTES, SCHEMA_VERSION } from '@liushui/core';

/** 一个 token 绑定的库。 */
export interface VaultEntry {
  /** token 明文（仅存在于内存与 secrets 中）。 */
  token: string;
  /** 库名，用于日志与跨库拒绝的判定。 */
  vault: string;
  /** libSQL/Turso 连接地址。 */
  url: string;
  /** Turso 凭据；本地 sqld 可为空。 */
  authToken: string;
}

/** 来自 wrangler 的环境绑定。 */
export interface Env {
  /** 服务版本，健康检查返回。 */
  SERVICE_VERSION?: string;
  /** JSON：{ "<token>": { "vault": string, "url": string, "authToken"?: string } } */
  LIUSHUI_VAULT_TOKENS: string;
  /** 可选的 content 上限（UTF-8 字节）。 */
  LIUSHUI_MAX_CONTENT_BYTES?: string;
  /** 可选的 schema 版本覆盖（默认取 core 的 SCHEMA_VERSION）。 */
  LIUSHUI_SCHEMA_V?: string;
}

/** 解析后的运行时配置。 */
export interface WorkerConfig {
  entries: VaultEntry[];
  maxContentBytes: number;
  schemaVersion: number;
}

/** 配置错误：属于服务端故障，不向客户端暴露细节。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析 `LIUSHUI_VAULT_TOKENS`。结构非法时抛 `ConfigError`（不包含 token 明文）。
 */
export function parseVaultTokens(raw: string | undefined): VaultEntry[] {
  if (!raw || raw.trim() === '') {
    throw new ConfigError('未配置 LIUSHUI_VAULT_TOKENS');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError('LIUSHUI_VAULT_TOKENS 不是合法 JSON');
  }
  if (!isRecord(parsed)) {
    throw new ConfigError('LIUSHUI_VAULT_TOKENS 必须是 { token: {...} } 形式的对象');
  }

  const entries: VaultEntry[] = [];
  for (const [token, value] of Object.entries(parsed)) {
    if (token.length === 0) throw new ConfigError('LIUSHUI_VAULT_TOKENS 含空 token');
    if (!isRecord(value)) throw new ConfigError('LIUSHUI_VAULT_TOKENS 的每一项必须是对象');
    const { vault, url, authToken } = value;
    if (typeof vault !== 'string' || vault.length === 0) {
      throw new ConfigError('LIUSHUI_VAULT_TOKENS 的每一项都需要非空 vault');
    }
    if (typeof url !== 'string' || url.length === 0) {
      throw new ConfigError('LIUSHUI_VAULT_TOKENS 的每一项都需要非空 url');
    }
    if (authToken !== undefined && typeof authToken !== 'string') {
      throw new ConfigError('LIUSHUI_VAULT_TOKENS 的 authToken 必须是字符串');
    }
    entries.push({ token, vault, url, authToken: authToken ?? '' });
  }
  if (entries.length === 0) throw new ConfigError('LIUSHUI_VAULT_TOKENS 未配置任何库');
  return entries;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`期望正整数，得到 ${raw}`);
  }
  return value;
}

/** 解析完整的运行时配置。 */
export function loadConfig(env: Env): WorkerConfig {
  return {
    entries: parseVaultTokens(env.LIUSHUI_VAULT_TOKENS),
    maxContentBytes: parsePositiveInt(env.LIUSHUI_MAX_CONTENT_BYTES, DEFAULT_MAX_CONTENT_BYTES),
    schemaVersion: parsePositiveInt(env.LIUSHUI_SCHEMA_V, SCHEMA_VERSION),
  };
}

/** 服务版本（健康检查用）。 */
export function serviceVersion(env: Env): string {
  const version = env.SERVICE_VERSION;
  return version && version.trim() !== '' ? version : '0.0.0-dev';
}
