/**
 * 敏感信息清洗。
 *
 * git remote 里可能带 userinfo（用户名、密码、token）。写入 meta 前一律移除，
 * 只保留主机与路径；清洗失败则返回 null，由调用方省略该字段（宁缺毋滥）。
 */

const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const SUPPORTED_SCHEMES = new Set(['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'ftps:']);

/**
 * 把 git remote 归一为 `host/path`。
 * 无法安全解析（本地路径、异常格式、仍含 userinfo）时返回 null。
 */
export function sanitizeGitRemote(remote: string): string | null {
  const trimmed = remote.trim();
  if (trimmed === '' || WINDOWS_DRIVE.test(trimmed)) return null;

  let host: string;
  let path: string;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!SUPPORTED_SCHEMES.has(parsed.protocol)) return null;
    host = parsed.host;
    path = parsed.pathname;
  } else {
    const match = SCP_LIKE.exec(trimmed);
    if (!match?.[1] || !match[2]) return null;
    host = match[1];
    path = match[2];
  }

  const normalizedPath = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (host === '' || normalizedPath === '') return null;

  const result = `${host}/${normalizedPath}`;
  // 兜底：任何残留的 userinfo 都视为清洗失败。
  if (result.includes('@')) return null;
  return result;
}
