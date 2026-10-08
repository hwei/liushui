/**
 * 版本化迁移：顺序编号的 SQL + 幂等执行器。
 *
 * - `schema_migrations` 记录已应用的版本，重复执行不会重复应用。
 * - 迁移只允许新增列或表（流水账不可改写）。
 */

import type { Client } from '@libsql/client';

/** 一个版本化迁移。 */
export interface Migration {
  /** 正整数，执行顺序。 */
  version: number;
  /** 迁移名，用于审计。 */
  name: string;
  /** 该迁移的 SQL（可含多条语句）。 */
  sql: string;
}

const MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY NOT NULL,
  name       TEXT    NOT NULL,
  applied_at TEXT    NOT NULL
)`;

/** 读取已应用的迁移版本。 */
export async function appliedVersions(client: Client): Promise<number[]> {
  await client.execute(MIGRATIONS_TABLE_SQL);
  const result = await client.execute('SELECT version FROM schema_migrations ORDER BY version');
  return result.rows.map((row) => Number(row['version']));
}

/**
 * 幂等地执行迁移，返回本次实际应用的版本列表。
 * 已应用的版本会被跳过；迁移内容不与仓库比对（流水账不依赖逐字一致）。
 */
export async function runMigrations(
  client: Client,
  migrations: readonly Migration[],
): Promise<number[]> {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  assertValidMigrations(ordered);

  const applied = new Set(await appliedVersions(client));
  const newlyApplied: number[] = [];

  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;
    await client.executeMultiple(migration.sql);
    await client.execute({
      sql: 'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      args: [migration.version, migration.name, new Date().toISOString()],
    });
    newlyApplied.push(migration.version);
  }

  return newlyApplied;
}

function assertValidMigrations(migrations: readonly Migration[]): void {
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(`迁移版本必须是正整数：${migration.version}`);
    }
    if (seen.has(migration.version)) {
      throw new Error(`迁移版本重复：${migration.version}`);
    }
    seen.add(migration.version);
  }
}
