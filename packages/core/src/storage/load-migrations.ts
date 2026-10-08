/**
 * 从 `packages/core/migrations/` 读取版本化 SQL 文件。
 *
 * 仅在 Node 环境（本地测试、迁移脚本、部署流程）使用；Worker 运行时不需要迁移。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Migration } from './migrate.ts';

/** 仓库内迁移目录的默认位置。 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const FILE_PATTERN = /^(\d+)[-_](.+)\.sql$/;

/** 读取并解析迁移目录，按版本升序返回。 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  return files.map((file) => {
    const match = FILE_PATTERN.exec(file);
    if (!match?.[1] || !match[2]) {
      throw new Error(`迁移文件名必须形如 0001_init.sql：${file}`);
    }
    return {
      version: Number(match[1]),
      name: match[2],
      sql: readFileSync(join(dir, file), 'utf8'),
    };
  });
}
