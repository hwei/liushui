# 部署与 token 轮换

面向 dev 与 prod 两套环境的部署流程。每套环境使用**独立的 Worker 实例、独立的数据库、独立的 token**，
dev 与 prod 之间不共享任何凭据，因此 dev token 无法读写 prod 数据。

前置假设：每个库一个独立的 Turso 数据库（与 `DESIGN.md` 一致）；目标是在免费额度内长期运行。

> 本 change 只部署写入路径。dev/prod 的实际部署与冒烟属于 OpenSpec change `core-append-store` 的
> 任务 6.1–6.4；本文档描述**怎么做**（任务 6.5）。

## 0. 准备

```bash
npm install
npx wrangler login          # Cloudflare
```

需要 Cloudflare 账号（Workers）与 Turso 账号。每个环境的每个库都要建一个数据库。

### Turso CLI 的安装（Windows 注意）

官方 `install.sh` 的 `probe_os()` 只支持 `Darwin` / `Linux`，**Windows 无法用它安装**；
`scoop` / `winget` 也没有对应包。Windows 上直接用 Go 从源码安装（实测 go1.26 windows/amd64 可用）：

```powershell
go install github.com/tursodatabase/turso-cli/cmd/turso@latest
# → %USERPROFILE%\go\bin\turso.exe（约 41 MB）
```

该目录通常不在 PATH 中，用全路径或自行加 PATH。登录：

```powershell
turso auth login            # 或 turso auth login --headless，给链接，不依赖本机浏览器
turso auth whoami
```

> 别装成 npm 上的 `turso` 包：那是 `tursodb`（本地 SQL shell），不是 cloud 管理 CLI。

### 出网需要代理的机器

Node 的 `fetch` **默认不读** `HTTP_PROXY` / `HTTPS_PROXY`（curl 会读），因此 `mem` 的写入会超时。
设置后即可（实测本机直连 workers.dev 超时、经代理 200）：

```bash
export NODE_USE_ENV_PROXY=1     # Node 24 起支持
```

CLI 在网络失败时会自行提示这一点，不必自己对照本节排障。

## 1. 创建数据库（每库一个）

以 dev 的 `personal` 与 `work` 两个库为例：

```bash
turso db create liushui-personal-dev
turso db create liushui-work-dev

turso db show liushui-personal-dev --url    # → libsql://liushui-personal-dev-<org>.turso.io
turso db show liushui-work-dev --url

turso db tokens create liushui-personal-dev   # → Turso 凭据（authToken），只显示一次
turso db tokens create liushui-work-dev

# 只读查询（/sql）专用：--read-only 生成的 token 在服务端被禁止写入
turso db tokens create liushui-personal-dev --read-only
turso db tokens create liushui-work-dev --read-only
```

prod 同理，库名换成 `liushui-personal-prod` / `liushui-work-prod`。

> 只读凭据与写凭据是两层，互不牵连：写凭据用于 `/append`，只读凭据用于 `/sql`。
> 一个库可以由多个 client token 共用同一份只读凭据（见第 8 节）。

## 2. 执行迁移（幂等）

对**每个**数据库执行一次；重复执行不会重复应用。

```bash
TURSO_URL='libsql://liushui-personal-dev-<org>.turso.io' \
TURSO_AUTH_TOKEN='<turso-token>' \
npm run migrate

TURSO_URL='libsql://liushui-work-dev-<org>.turso.io' \
TURSO_AUTH_TOKEN='<turso-token>' \
npm run migrate
```

预期输出：首次 `已应用迁移：1, 2（共 2 个）。`（已有旧库则只显示新增的版本），再次执行 `schema 已是最新…`。

> **顺序很重要：先迁移、再部署、后重建索引。** 从 `0.3.0` 起 `/append` 会同事务写全文索引表 `memories_fts`；
> 如果 Worker 先于迁移上线，`/append` 在没有该表的库上会一直返回 503 `storage_unavailable`。
> 回滚 Worker 不需要回滚迁移（旧代码忽略新表）。

### 2.1 重建全文索引（每个库，部署之后）

迁移只建空表；迁移之后、新 Worker 上线之前写入的记录没有索引条目，所以部署后要重建一次，并用 `--check` 确认：

```bash
TURSO_URL='libsql://liushui-personal-dev-<org>.turso.io' TURSO_AUTH_TOKEN='<turso-token>' npm run fts:rebuild

TURSO_URL='libsql://liushui-personal-dev-<org>.turso.io' TURSO_AUTH_TOKEN='<turso-token>' npm run fts:rebuild -- --check
```

`--check` 只读：报告 `memories` 与索引的条数、缺失、多余、重复，以及切分版本是否与当前代码一致；任何一项不一致都以退出码 1 退出，可直接用于部署验证。
重建在一个写事务里完成（当前数据量下是秒级），期间并发的 `/append` 会等待或被 CLI 自动重试。
以后切分规则升版本（`FTS_SEGMENTER_V`）后，也用同一条命令重建。凭据只从环境变量读取，不会被打印。

## 3. 生成本系统的 token 并写入 Worker secrets

`LIUSHUI_VAULT_TOKENS` 把**本系统的 token** 绑定到**库**。token 是客户端持有的凭据，
与上面的 Turso 凭据（`authToken`）是两层，互不相同。

```bash
PERSONAL_TOKEN=$(openssl rand -hex 32)   # 或：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
WORK_TOKEN=$(openssl rand -hex 32)

cat <<JSON
{"$PERSONAL_TOKEN":{"vault":"personal","url":"libsql://liushui-personal-dev-<org>.turso.io","authToken":"<turso-token>"},
 "$WORK_TOKEN":{"vault":"work","url":"libsql://liushui-work-dev-<org>.turso.io","authToken":"<turso-token>"}}
JSON
```

把上面这行 JSON 作为 secret 写入（`wrangler secret put` 从 stdin 读取，不要写进仓库、不要出现在命令行参数里）：

```bash
cd packages/worker
printf '%s' "$LIUSHUI_VAULT_TOKENS" | npx wrangler secret put LIUSHUI_VAULT_TOKENS --env dev
```

首次对某个环境执行时，如果该 Worker 还不存在，wrangler 会问是否新建（非交互环境会
auto-yes 并打印 `Creating new Worker ...`），然后上传 secret；随后的 `wrangler deploy` 会把它一起发布。

可选 secrets：

```bash
printf '%s' '131072' | npx wrangler secret put LIUSHUI_MAX_CONTENT_BYTES --env dev   # 可选
```

### 3.1 写入只读查询凭据 `LIUSHUI_VAULT_READ_CREDS`

`/sql` 只用**只读凭据**连库，凭据放在单独 secret，按**库名**索引，只允许 `authToken`（含 `url` 即报错）：

```bash
cat <<JSON
{"personal":{"authToken":"<personal 的 --read-only token>"},"work":{"authToken":"<work 的 --read-only token>"}}
JSON

printf '%s' "$LIUSHUI_VAULT_READ_CREDS" | npx wrangler secret put LIUSHUI_VAULT_READ_CREDS --env dev
```

- 这个 secret 缺失或损坏时，`/sql` 返回 `server_misconfigured`（500），且**绝不回退**到写凭据；`/append` 完全不受影响。
- 本地 sqld 没有鉴权，值写 `{"personal":{"authToken":""},"work":{"authToken":""}}` 即可（条目必须存在）。
- 轮换写入后重新 `wrangler deploy --env <env>`（见第 8.4 节）。

`SERVICE_VERSION` 是普通变量，写在 `packages/worker/wrangler.toml` 的 `[env.dev.vars]` / `[env.prod.vars]` 里，
`GET /health` 会返回它，用来确认部署的确是新版本。

## 4. 部署

```bash
cd packages/worker
npx wrangler deploy --env dev
npx wrangler deploy --env prod
```

`workers_dev = true` 会给出 `https://liushui-mem-<env>.<subdomain>.workers.dev`；生产可以再绑自定义域名。
部署前可先用 `npx wrangler deploy --dry-run --env dev` 检查打包结果。

## 5. 冒烟

```bash
curl https://liushui-mem-dev.<subdomain>.workers.dev/health
# → {"ok":true,"version":"0.3.0-dev"}

# 未授权必须被拒绝：
curl -i -X POST https://liushui-mem-dev.<subdomain>.workers.dev/append -d '{}'
# → 401 {"error":{"code":"unauthorized",...}}

# 只读查询：
curl -s -X POST https://liushui-mem-dev.<subdomain>.workers.dev/sql \
  -H 'authorization: Bearer <PERSONAL_TOKEN>' -H 'content-type: application/json' \
  -d '{"sql":"SELECT COUNT(*) AS n FROM memories"}'
# → 200 {"vault":"personal","columns":["n"],"rows":[[...]],"truncated":{"rows":false,"cells":0},"stats":{...}}

# 全文检索（先 append 一条含两字中文词的记忆，例如“渲染管线测试”）：
curl -s -X POST https://liushui-mem-dev.<subdomain>.workers.dev/sql   -H 'authorization: Bearer <PERSONAL_TOKEN>' -H 'content-type: application/json'   -d '{"sql":"SELECT m.id FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH fts('"'"'渲染'"'"') ORDER BY rank"}'
# → 200，rows 里有刚写入的 id；stats.rows_read 是这次检索的读取行数
# 单字（fts('渲')）必须返回 400 invalid_field，消息提示改用 LIKE

# 写语句必须被拒绝且记录数不变：
curl -s -X POST https://liushui-mem-dev.<subdomain>.workers.dev/sql \
  -H 'authorization: Bearer <PERSONAL_TOKEN>' -H 'content-type: application/json' \
  -d '{"sql":"DELETE FROM memories"}'
# → 400 {"error":{"code":"statement_not_allowed",...}}
```

用 CLI 冒烟更方便：`liushui sql "SELECT id, ts FROM memories ORDER BY ts DESC LIMIT 5"`；
截断提示只会写到 stderr。

## 6. 新机器上的 CLI 配置

1. 安装 Node.js >= 24，克隆仓库，`npm install`。
2. 创建配置文件（默认 `~/.config/liushui/config.json`，或用 `LIUSHUI_CONFIG` 指向别处）：

```json
{
  "env": "dev",
  "environments": {
    "dev": {
      "defaultVault": "personal",
      "vaults": {
        "personal": { "url": "https://liushui-mem-dev.<subdomain>.workers.dev", "token": "<PERSONAL_TOKEN>" },
        "work": {
          "url": "https://liushui-mem-dev.<subdomain>.workers.dev",
          "token": "<WORK_TOKEN>",
          "redact": ["cwd", "git.repo"]
        }
      }
    },
    "prod": {
      "defaultVault": "personal",
      "vaults": {
        "personal": { "url": "https://liushui-mem-prod.<subdomain>.workers.dev", "token": "<PROD_PERSONAL_TOKEN>" }
      }
    }
  }
}
```

3. 收紧权限并验证：

```bash
chmod 600 ~/.config/liushui/config.json

# 出网需要代理时（见第 0 节）
export NODE_USE_ENV_PROXY=1

node packages/cli/bin/liushui.ts append "新机器冒烟"
# → 输出 26 位 id，退出码 0

node packages/cli/bin/liushui.ts append --vault personal,work "多库冒烟"
# → 两行 JSONL，两个库的 id 相同

node packages/cli/bin/liushui.ts append --env prod "prod 冒烟"
# → 用配置里 prod 环境的库
```

4. 用一条只读查询确认记录真的落库（见第 6.1 / 6.2 节的验证记录）：检查 `received_at`、`schema_v`、
   `meta.git.repo`（应为 `host/path`，不含 userinfo）与 `meta.cwd`（公司库应按配置缺失）。

4. 把配置文件放进 dotfiles/secrets 管理器；**不要把 token 提交进仓库**。CLI 的输出与日志都会清洗 token。

## 7. 环境隔离验证

```bash
# dev 的 token 调 prod：必须 401，prod 数据不变
curl -i -X POST https://liushui-mem-prod.<subdomain>.workers.dev/append \
  -H 'authorization: Bearer <DEV_PERSONAL_TOKEN>' \
  -H 'content-type: application/json' -d '{"id":"x"}'
# → 401
```

反向（prod token 调 dev）同样必须 401。

## 8. token 轮换

分两层：**本系统的 token**（客户端 → Worker）与 **Turso 凭据**（Worker → 数据库）。
两层都支持「先加后删」的重叠窗口，避免服务中断。

### 8.1 轮换本系统 token

1. 生成新 token：

```bash
NEW_PERSONAL_TOKEN=$(openssl rand -hex 32)
```

2. 在 `LIUSHUI_VAULT_TOKENS` 中**保留旧 key 并加入新 key**（两个 key 指向同一个库），写入 secret 并部署：

```bash
printf '%s' "$LIUSHUI_VAULT_TOKENS_WITH_BOTH" | npx wrangler secret put LIUSHUI_VAULT_TOKENS --env dev
cd packages/worker && npx wrangler deploy --env dev
```

3. 更新所有机器上的 CLI 配置，验证新 token 可用：

```bash
node packages/cli/bin/liushui.ts append "轮换验证"
```

4. 删掉旧 key，再次写入 secret 并部署；确认旧 token 返回 401。

### 8.2 轮换 Turso 凭据

1. `turso db tokens create <db>` 生成新凭据（可同时有效）。
2. 更新 `LIUSHUI_VAULT_TOKENS` 中该库的 `authToken`，写 secret 并部署。
3. 验证写入仍然成功（`liushui append` 返回 id）。
4. `turso db tokens invalidate <db> --all-but-this-one`（或逐个失效旧凭据），再次验证。

### 8.3 轮换过程中的幂等

重试与轮换期间不会有重复记录：`id` 由内容决定，追加是「若不存在则插入」。
同一个 `ts` 与 `id` 重复提交只会命中既有记录，并返回 `created:false`。

### 8.4 轮换只读凭据（与 client token 轮换互不牵连）

只读凭据按**库名**记录在 `LIUSHUI_VAULT_READ_CREDS` 里，与 `LIUSHUI_VAULT_TOKENS` 中的 client token 无关：

1. `turso db tokens create <db> --read-only` 生成新的只读凭据（旧的仍有效）。
2. 更新 `LIUSHUI_VAULT_READ_CREDS` 中该库的 `authToken`，写入 secret 并重新部署。
3. 用 `liushui sql` 验证查询仍然成功。
4. `turso db tokens invalidate <db> --all-but-this-one` 失效旧凭据，再次验证。

轮换 client token（8.1）**不需要**动这个 secret：轮换窗口里的多个 client token 指向同一个库，共用同一份只读凭据。

## 9. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `GET /health` 返回旧版本 | 部署未生效或看错环境 | 检查 `SERVICE_VERSION` 与 `--env`；重跑 `wrangler deploy --env <env>` |
| `/append` 返回 500 `server_misconfigured` | `LIUSHUI_VAULT_TOKENS` 不是合法 JSON 或缺字段 | 重新写入 secret；`vault`/`url` 必须非空 |
| `/append` 返回 503 `storage_unavailable` | 数据库不可达或 Turso 凭据失效 | 检查 `url`/`authToken`；必要时轮换凭据（8.2） |
| `/append` 返回 401 | token 未配置到该环境 | 确认 CLI 用的配置文件与环境，以及 `LIUSHUI_VAULT_TOKENS` 中的 key |
| `/append` 返回 403 `vault_mismatch` | 请求体里的 `vault` 与 token 绑定的库不同 | 用该库自己的 token，或去掉请求体的 `vault` 字段 |
| `/append` 返回 413 `content_too_large` | `content` 超过 `LIUSHUI_MAX_CONTENT_BYTES` | 截断内容或调整上限 |
| `/sql` 返回 500 `server_misconfigured` | `LIUSHUI_VAULT_READ_CREDS` 缺失、损坏，或该库没有条目 | 检查 secret（只允许 `authToken`，不含 `url`），重新写入并部署（3.1 / 8.4） |
| `/sql` 返回 503 `storage_unavailable` | 只读凭据失效或库不可达 | 检查只读 token；必要时轮换（8.4） |
| `/sql` 返回 400 `statement_not_allowed` | 提交了写语句、DDL、`PRAGMA` 或多条语句 | 只提交单条 `SELECT` / `WITH … SELECT` / `EXPLAIN QUERY PLAN` |
| `/append` 在升级后一直返回 503，`/sql` 查 `memories_fts` 报“no such table” | 库还没执行 `0002_fts` 迁移（Worker 先于迁移上线） | 对该库执行 `npm run migrate`，再 `npm run fts:rebuild`（2.1） |
| `fts()` 检索查不到刚迁移前写入的记录 | 这些记录没有索引条目 | `npm run fts:rebuild -- --check` 看缺失数，再 `npm run fts:rebuild` |
| `/sql` 返回 400 `invalid_field`，提示单字改用 `LIKE` | `fts()` 里有单个汉字或假名 | 换成两字及以上的词，或改用 `content LIKE '%字%'` |
| `/sql` 返回 400 `sql_error` | SQL 语法错误、未知表或列 | 按错误描述修正语句 |
| `/sql` 返回 504 `query_timeout` | 查询超过服务端 5s 超时 | 缩小查询范围或加索引（后续 change） |
| CLI 报「未找到配置文件」 | 未创建配置或未设置 `LIUSHUI_CONFIG` | 见第 6 节 |
| 迁移报 `schema 已是最新` 但仍无表 | 连到了错误的数据库 | 用 `turso db shell <db> '.tables'` 确认 |
