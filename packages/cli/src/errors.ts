/** CLI 的用户可见错误（配置、用法）。绝不包含 token。 */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/**
 * 把输出中可能出现的 secret 替换掉。
 *
 * 用于最后一道防线：任何写到 stdout/stderr 的文本都先过这里，
 * 保证 token 不会因为上游异常信息而泄漏。
 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('***');
  }
  return out;
}
