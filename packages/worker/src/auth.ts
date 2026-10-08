/**
 * token 鉴权：常数时间比较，逐项扫描全部绑定（不提前退出），
 * 因此响应时间与“token 是否接近某个库”无关。
 *
 * 比较前先对提供的 token 与每个候选 token 取 sha256，把长度差异也抹平；
 * 无效 token 与缺失 token 得到完全相同的响应，不泄露库是否存在。
 */

import type { VaultEntry } from './env.ts';

async function sha256(text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** 从 `Authorization` 头取出 Bearer token；缺失或格式不对返回 null。 */
export function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * 找到 token 绑定的库。找不到返回 null。
 * 无论是否命中都会扫描全部条目，避免通过耗时区分 token。
 */
export async function findVaultForToken(
  entries: readonly VaultEntry[],
  token: string,
): Promise<VaultEntry | null> {
  const provided = await sha256(token);
  let found: VaultEntry | null = null;
  for (const entry of entries) {
    const candidate = await sha256(entry.token);
    if (equalBytes(provided, candidate)) found = entry;
  }
  return found;
}
