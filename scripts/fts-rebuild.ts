/**
 * 重建或检查某个库的全文索引 `memories_fts`（派生数据，可随时重建）。
 *
 * 用法：
 *   TURSO_URL=libsql://xxx.turso.io TURSO_AUTH_TOKEN=xxx npm run fts:rebuild
 *   TURSO_URL=libsql://xxx.turso.io TURSO_AUTH_TOKEN=xxx npm run fts:rebuild -- --check
 *   TURSO_URL=http://127.0.0.1:8080 npm run fts:rebuild                 # 本地 sqld
 *
 * 部署顺序：先 `npm run migrate`，再部署 Worker，最后重建索引。
 * `--check` 只读；缺失、多余、重复或切分版本不一致时以退出码 1 退出。
 * token 只从环境变量读取，绝不打印。
 */

import { createClient } from '@libsql/client';
import { checkFts, rebuildFts } from '@liushui/core/storage';

const url = process.env['TURSO_URL'];
const authToken = process.env['TURSO_AUTH_TOKEN'];
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const unknown = args.filter((arg) => arg !== '--check');

if (unknown.length > 0) {
  process.stderr.write(`未知参数：${unknown.join(' ')}；用法见 scripts/fts-rebuild.ts 顶部注释。\n`);
  process.exit(2);
}
if (!url) {
  process.stderr.write('缺少 TURSO_URL 环境变量；用法见 scripts/fts-rebuild.ts 顶部注释。\n');
  process.exit(2);
}

const client = createClient(authToken ? { url, authToken } : { url });
let exitCode = 0;
try {
  if (!checkOnly) {
    const result = await rebuildFts(client);
    process.stdout.write(`已重建全文索引：${result.rows} 条（切分版本 ${result.version}）。\n`);
  }
  const check = await checkFts(client);
  const recorded = check.version.recorded === null ? '从未重建' : String(check.version.recorded);
  process.stdout.write(
    [
      `memories：${check.memories}，索引：${check.indexed}`,
      `缺失：${check.missing}，多余：${check.extra}，重复：${check.duplicates}`,
      `切分版本：记录 ${recorded}，当前 ${check.version.current}（${check.version.ok ? '一致' : '不一致，需要重建'}）`,
      check.ok ? '检查通过。' : '检查未通过。',
    ].join('\n') + '\n',
  );
  if (!check.ok) exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // 错误信息可能带连接地址；凭据不会出现在其中，但保守起见去掉 token 字样。
  process.stderr.write(`全文索引操作失败：${authToken ? message.replaceAll(authToken, '***') : message}\n`);
  exitCode = 2;
} finally {
  client.close();
}
process.exit(exitCode);
