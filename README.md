# 流水（liushui）

自进化记忆系统的**只追加记忆流水账**。总体设计见 [`DESIGN.md`](./DESIGN.md)。

当前仓库实现的是最小可用内核：写入（`core-append-store`）与只读查询（`sql-query`）：

```
liushui append  →  Cloudflare Worker（token 鉴权）  →  Turso / libSQL（每库一个独立数据库）
liushui sql     →  POST /sql（只读凭据 + 只读事务）  →  单库只读查询
```

已实现文本的写入、只读查询与全文检索（FTS5，中日文 bigram 切分，`fts('…')` 宏）。向量（`embed()`）、附件、提交页、反馈与维护流程都还不在范围内。

## 目录结构

```
packages/core      共享内核：记录模型与校验、规范化与确定性 ID、迁移与幂等追加、只读查询的语句检查/包裹/整形、全文检索的切分与 fts() 宏展开
packages/worker    Cloudflare Worker：token 鉴权、按 token 路由到库、POST /append、POST /sql、GET /health
packages/cli       `liushui` 命令行：meta 自动采集与清洗、按库脱敏、多库提交、失败重试、只读查询与 TSV/JSONL 输出
skills/liushui/    供所有项目的 agent 使用的记忆读写 skill（安装方式见下）
scripts/migrate.ts 对某个库幂等执行迁移
scripts/fts-rebuild.ts 重建或检查某个库的全文索引（派生数据，可随时重建）
scripts/regress.ts 导出回归快照并在本地运行评估与基线对比
MAINTENANCE.md     系统维护指南（从反馈到回归测试的闭环流程）
openspec/          OpenSpec change 与 spec（唯一的需求来源）
```

## 环境要求

- **Node.js >= 24**。CLI 与脚本直接运行 TypeScript（Node 的类型剥离），无需构建步骤。
- npm（本仓库使用 npm workspaces）。
- 可选：**Docker**，仅用于 `npm run test:worker-integration`（本地 libSQL 服务）。

## 安装与验证

```bash
npm install

npm test          # 单元 + 集成测试（全部在本地跑，不依赖云端）
npm run lint      # ESLint
npm run typecheck # 每个包分别 tsc --noEmit

npm run test:worker-integration  # 真实链路：wrangler dev + 本地 sqld（需要 Docker）
```

测试分层：

| 命令 | 覆盖内容 | 依赖 |
|---|---|---|
| `npm test` | ID 规则、校验、迁移、幂等追加、meta 过滤、鉴权、错误语义、两库隔离、CLI 采集/清洗/脱敏/重试（Node 内直接调用 handler 与本地文件库） | 无 |
| `npm run test:worker-integration` | workerd 运行时 + `wrangler dev` + `@libsql/client/web` + 两个独立库的端到端链路 | Docker |

## 本地开发

### 1. 起两个本地 libSQL 服务（各一个文件库）

```bash
mkdir -p .turso/personal .turso/work
docker run -d --name liushui-sqld-personal -p 8080:8080 \
  -e SQLD_DB_PATH=/var/lib/sqld -v "$PWD/.turso/personal:/var/lib/sqld" \
  ghcr.io/tursodatabase/libsql-server:latest
docker run -d --name liushui-sqld-work -p 8081:8080 \
  -e SQLD_DB_PATH=/var/lib/sqld -v "$PWD/.turso/work:/var/lib/sqld" \
  ghcr.io/tursodatabase/libsql-server:latest
```

### 2. 执行迁移

```bash
TURSO_URL=http://127.0.0.1:8080 npm run migrate
TURSO_URL=http://127.0.0.1:8081 npm run migrate
```

迁移是幂等的：重复执行不会重复应用（`schema_migrations` 记录已应用的版本）。

### 3. 启动 Worker（wrangler 本地模式）

```bash
cp packages/worker/.dev.vars.example packages/worker/.dev.vars   # 已 gitignore
cd packages/worker && npm run dev -- --port 8787
```

`GET /health` 不需要鉴权，可直接冒烟：

```bash
curl http://127.0.0.1:8787/health
```

### 4. 配置并运行 CLI

```bash
export LIUSHUI_CONFIG="$PWD/.turso-cli/config.json"   # 也可用默认路径 ~/.config/liushui/config.json
```

配置文件格式：

```json
{
  "env": "dev",
  "environments": {
    "dev": {
      "defaultVault": "personal",
      "vaults": {
        "personal": { "url": "http://127.0.0.1:8787", "token": "local-personal-token" },
        "work": {
          "url": "http://127.0.0.1:8787",
          "token": "local-work-token",
          "redact": ["cwd", "git.repo"]
        }
      }
    },
    "prod": { "defaultVault": "personal", "vaults": { "personal": { "url": "https://…", "token": "…" } } }
  }
}
```

```bash
node packages/cli/bin/liushui.ts append "修复了 iOS 渲染问题"
# → EXW22UONNOLRSUJWO3EIA7KE2I        （单库：stdout 只有 id）

node packages/cli/bin/liushui.ts append --vault personal,work --kind note "同时写入两个库"
# → {"vault":"personal","ok":true,"id":"…","created":true}
#   {"vault":"work","ok":true,"id":"…","created":true}
```

也可以直接 `npx liushui …`（workspace bin 已链接）。

#### 记录检索反馈 `liushui feedback`

当检索未命中或效果不佳时，用 `liushui feedback` 写入一条 `kind = retrieval_feedback` 的结构化记录。输入必须为合法的反馈 JSON（传参或通过 stdin `-` 传入），命令会在写入前严格校验，并自动向目标库所在服务的健康检查端点补充 `service_version`：

```bash
# 直接传参写入一条主反馈（省略 --vault 时使用默认库）：
node packages/cli/bin/liushui.ts feedback '{"v":1,"intent":"上次 iOS 渲染问题怎么查的","queries":[{"sql":"SELECT id FROM memories WHERE content LIKE '\''%渲染%'\''","outcome":"0 行"}],"expected_ids":["RYRP4645Q2VOLZ4DOVYPLUKVA4"],"cause":"同义词问题"}'
# → RYRP4645Q2VOLZ4DOVYPLUKVA4        （成功时输出 id）

# 从标准输入读取（推荐，避免复杂的 shell 转义）：
cat << 'EOF' | node packages/cli/bin/liushui.ts feedback -
{
  "v": 1,
  "intent": "搜不到渲染相关的记忆",
  "queries": [
    { "sql": "SELECT m.id, m.content FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH fts('iOS渲染') ORDER BY rank" }
  ]
}
EOF

# 事后补充或更正期望 ID（流水账不可修改，写入一条引用原反馈的补充记录）：
node packages/cli/bin/liushui.ts feedback '{"v":1,"refines":"RYRP4645Q2VOLZ4DOVYPLUKVA4","expected_ids":["BCDEFGHJKMNPQRSTVWXYZ23456"],"note":"事后翻看流水账找到了当时记录的真实 ID"}'
```

### 5. 只读查询 `liushui sql`

`liushui sql` 对一个库执行一条只读 SQL，默认输出带表头的 TSV：

```bash
node packages/cli/bin/liushui.ts sql "SELECT id, kind, ts FROM memories ORDER BY ts DESC LIMIT 5"
# → id<TAB>kind<TAB>ts
#   EXW2…<TAB>note<TAB>2026-10-08T07:47:08.479Z

node packages/cli/bin/liushui.ts sql --json "SELECT json_extract(meta, '$.git.branch') AS branch FROM memories LIMIT 5"
# → {"branch":"main"}

echo "SELECT COUNT(*) AS n FROM memories" | node packages/cli/bin/liushui.ts sql -
node packages/cli/bin/liushui.ts sql --arg note "SELECT id FROM memories WHERE kind = ? ORDER BY ts"
```

输出约定：

- 默认 TSV，一行表头加若干行数据；单元格内的 `\`、制表符、换行与回车转义，NULL 输出为 `\N`。
- `--json` 改为 JSONL，每行一个以列名为键的对象。
- `--limit` 默认 50、`--max-width` 默认 200；截断提示只写 stderr，stdout 永远只有结果。
- 行数超过上限、或单元格被截断时，服务端在响应里标记，CLI 额外在 stderr 提示。
- 查询一次只针对一个库：`--vault` 至多一个，省略时用默认库。
- 只有一条只读语句（`SELECT` / `WITH … SELECT` / `EXPLAIN QUERY PLAN`）被接受；写语句、DDL、`PRAGMA`、多条语句一律拒绝。
- `sql_error`、`statement_not_allowed`、`query_timeout` 与 401/403 不重试；网络错误与 503 重试。

#### 全文检索

`memories_fts` 是 `memories.content` 的派生全文索引（追加时同事务维护）。用 `fts('…')` 宏检索，只写原文：

```bash
node packages/cli/bin/liushui.ts sql "SELECT m.id, m.ts, m.content FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH fts('渲染 问题') ORDER BY rank LIMIT 10"
```

- 空格分隔的词表示同时出现，独立的大写 `OR` 表示任一出现（同时出现优先）；每个词按连续出现匹配。
- 中文按相邻两个字切分，所以两个字及以上的词都能检索；单个汉字或假名会被拒绝并提示改用 `LIKE`。
- 索引是派生数据，可随时重建；已有数据或升级后用 `npm run fts:rebuild`，核对用 `npm run fts:rebuild -- --check`（凭据环境变量同 `npm run migrate`）。部署顺序见 [`docs/deploy.md`](./docs/deploy.md)：**先迁移、再部署、后重建**。

**输出约定**：单库成功时 stdout 只有 `id`（便于 agent 解析）；多库时 stdout 是 JSONL，每库一行；失败写到 stderr，任何库失败退出码为 1；用法/配置错误退出码为 2。`--env dev|prod` 或 `LIUSHUI_ENV` 切换环境，配置文件里的 `env` 是默认值。

### 6. Agent skill

[`skills/liushui/SKILL.md`](./skills/liushui/SKILL.md) 说明何时写/查记忆、`memories` 表与 `json_extract` 用法、常用查询模板与截断提示。安装到 agent 的 skill 目录：

```bash
mkdir -p ~/.claude/skills
cp -r skills/liushui ~/.claude/skills/liushui
# 或软链：ln -s "$PWD/skills/liushui" ~/.claude/skills/liushui
```

以后改 schema 时要同步更新这个 skill（见 `DESIGN.md`）。

## 环境与 secrets 清单

| 环境 | 服务实例 | 数据库 | token |
|---|---|---|---|
| dev | 独立 Worker（`wrangler --env dev`） | 每库一个独立 Turso DB | 每库独立 token，与 prod 不通用 |
| prod | 独立 Worker（`wrangler --env prod`） | 每库一个独立 Turso DB | 每库独立 token，与 dev 不通用 |

**Worker 侧**（通过 `wrangler secret put` 设置，绝不入库）：

| 名称 | 必填 | 说明 |
|---|---|---|
| `LIUSHUI_VAULT_TOKENS` | 是 | JSON：`{ "<token>": { "vault": "personal", "url": "libsql://…", "authToken": "<Turso 凭据>" } }`，token 与库一一绑定 |
| `LIUSHUI_VAULT_READ_CREDS` | `/sql` 必填 | JSON：`{ "<vault>": { "authToken": "<Turso 只读凭据>" } }`，按库名索引，只允许 `authToken`（含 `url` 即报错）。缺失时 `/sql` 返回 `server_misconfigured`，**绝不回退**到写凭据；`/append` 不受影响。本地 sqld 留空 `authToken` |
| `LIUSHUI_MAX_CONTENT_BYTES` | 否 | `content` 上限（UTF-8 字节），默认 131072 |
| `LIUSHUI_SCHEMA_V` | 否 | 覆盖写入的 `schema_v`，默认取 `@liushui/core` 的 `SCHEMA_VERSION` |

**Worker 侧普通变量**：`SERVICE_VERSION`（`GET /health` 返回，用于确认部署版本）。

**CLI 侧**：各库的 `url` 与 `token`（配置文件，权限建议 `chmod 600`）；CLI 不读环境变量里的 token。

**部署与 token 轮换**：见 [`docs/deploy.md`](./docs/deploy.md)。

## 数据模型与 ID 规则

一条记忆：`id`、`ts`、`author`、`kind`、`content`、`meta`（JSON）、`received_at`、`schema_v`。

- 只追加：没有修改与删除接口；重复 `id` 一律忽略，既有记录的 `meta` 与 `received_at` 不被覆盖。
- `id` 由 `ts`、`author`、`kind`、`content`（以及将来的附件 sha256）规范化后取 sha256 前 128 位、base32 编码得到；`meta`、`received_at` 与目标库**不参与**，因此同一条记忆在各库中 id 相同、重试幂等。
- 跨语言兼容基准见 [`packages/core/vectors/README.md`](./packages/core/vectors/README.md)。
- `meta` 是嵌套 JSON（`git.branch` 物理上是 `{"git":{"branch":…}}`），因此 `json_extract(meta, '$.git.branch')` 可直接用于过滤；新增 meta 键**无需迁移**。
- 采集不到的 meta 字段一律省略（不写空串）；git remote 的 userinfo 在本地清洗，清洗失败则省略该字段。

## 文档

- 总体设计：[`DESIGN.md`](./DESIGN.md)
- 系统维护指南：[`MAINTENANCE.md`](./MAINTENANCE.md)
- 部署与 token 轮换：[`docs/deploy.md`](./docs/deploy.md)
- 需求与验收标准：[`openspec/`](./openspec)（spec 是唯一需求来源）
- Agent skill：[`skills/liushui/SKILL.md`](./skills/liushui/SKILL.md)

## 常见问题

**`liushui append` 报「网络错误：TimeoutError」但 curl 同一个地址正常**
你的机器出网要走代理。Node 的 `fetch` 默认不读 `HTTP_PROXY` / `HTTPS_PROXY`（curl 会读）：

```bash
export NODE_USE_ENV_PROXY=1     # Node 24 起支持
```

CLI 现在会在网络失败时自行提示这一点（`NODE_USE_ENV_PROXY`），不必先看到这条 FAQ。

**在 Windows 上装 Turso CLI**
官方 `install.sh` 只支持 Darwin/Linux（`probe_os()` 里没有 Windows 分支）。用 Go 装：

```powershell
go install github.com/tursodatabase/turso-cli/cmd/turso@latest   # → %USERPROFILE%\go\bin\turso.exe
```

别装 npm 上的 `turso` 包——那是 `tursodb`（本地 SQL shell），不是 cloud 管理 CLI。
详见 [`docs/deploy.md`](./docs/deploy.md) 第 0 节。
