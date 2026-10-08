/**
 * 网络失败时的代理诊断提示。
 *
 * Node 的 `fetch` 默认不读 `HTTP_PROXY` / `HTTPS_PROXY`；只有把
 * `NODE_USE_ENV_PROXY` 设为精确的字符串 `"1"` 才会启用（实测 `true`、`0`、
 * 空串、未设置都不会启用）。这里只做判定与文案，不产生任何副作用，
 * 也不回显任何变量的值。
 */

/** 判定所需的环境变量（只读一个子集）。 */
export interface ProxyHintEnv {
  HTTP_PROXY?: string | undefined;
  HTTPS_PROXY?: string | undefined;
  NODE_USE_ENV_PROXY?: string | undefined;
}

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 当环境配置了代理（`HTTP_PROXY` / `HTTPS_PROXY` 之一非空）而未启用 Node 的
 * 代理支持（`NODE_USE_ENV_PROXY === "1"`）时，返回可执行的提示；否则返回 null。
 *
 * 提示只出现变量名与修法，**不回显任何变量值**，因此不会泄漏代理凭据或 token。
 */
export function proxyHint(env: ProxyHintEnv): string | null {
  if (!hasValue(env.HTTP_PROXY) && !hasValue(env.HTTPS_PROXY)) return null;
  if (env.NODE_USE_ENV_PROXY === '1') return null;

  return (
    '环境里配置了 HTTP_PROXY / HTTPS_PROXY，但 Node 的 fetch 默认不走系统代理。' +
    '如果这台机器经代理出网，请设置 NODE_USE_ENV_PROXY=1 后重试' +
    '（新开一个 shell，或在当前 shell export；本地回环地址可用 NO_PROXY 排除）。'
  );
}
