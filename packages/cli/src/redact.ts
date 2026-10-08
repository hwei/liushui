/**
 * 按库的 meta 脱敏：同一份 meta 发往不同库时，去掉该库不该看到的字段。
 *
 * ID 由核心字段决定，与 meta 无关，所以脱敏后各库的 id 仍然相同。
 */

import type { Meta, MetaValue } from '@liushui/core';

function cloneMeta(meta: Meta): Meta {
  const out: Meta = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = cloneValue(value);
  }
  return out;
}

function cloneValue(value: MetaValue): MetaValue {
  if (value !== null && typeof value === 'object') return cloneMeta(value);
  return value;
}

/**
 * 按点号路径删除 meta 字段（如 `cwd`、`git.repo`）。
 * 返回新的对象，不修改入参；删除后变成空对象的中间层保留（不额外清理）。
 */
export function redactMeta(meta: Meta, paths: readonly string[]): Meta {
  const out = cloneMeta(meta);
  for (const path of paths) {
    const parts = path.split('.').filter((part) => part !== '');
    if (parts.length === 0) continue;
    let cursor: Meta | undefined = out;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (cursor === undefined) break;
      const key = parts[i]!;
      const child: MetaValue | undefined = cursor[key];
      cursor = child !== null && typeof child === 'object' ? child : undefined;
    }
    const last = parts.at(-1);
    if (cursor && last !== undefined) delete cursor[last];
  }
  return out;
}
