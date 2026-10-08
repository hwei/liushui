/**
 * 对某个库执行迁移（幂等）。
 *
 * 用法：
 *   TURSO_URL=libsql://xxx.turso.io TURSO_AUTH_TOKEN=xxx npm run migrate
 *   TURSO_URL=http://127.0.0.1:8080 npm run migrate          # 本地 sqld
 *
 * token 只从环境变量读取，绝不打印。
 */

import { createClient } from '@libsql/client';
import { loadMigrations } from '@liushui/core/migrations';
import { runMigrations } from '@liushui/core/storage';

const url = process.env['TURSO_URL'];
const authToken = process.env['TURSO_AUTH_TOKEN'];

if (!url) {
  process.stderr.write('缺少 TURSO_URL 环境变量；用法见 scripts/migrate.ts 顶部注释。\n');
  process.exit(2);
}

const client = createClient(authToken ? { url, authToken } : { url });
try {
  const migrations = loadMigrations();
  const applied = await runMigrations(client, migrations);
  if (applied.length === 0) {
    process.stdout.write(`schema 已是最新（共 ${migrations.length} 个迁移，无需应用）。\n`);
  } else {
    process.stdout.write(`已应用迁移：${applied.join(', ')}（共 ${migrations.length} 个）。\n`);
  }
} finally {
  client.close();
}
