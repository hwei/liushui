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
```

prod 同理，库名换成 `liushui-personal-prod` / `liushui-work-prod`。

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

预期输出：首次 `已应用迁移：1（共 1 个）。`，再次执行 `schema 已是最新…`。

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
# → {"ok":true,"version":"0.1.0-dev"}

# 未授权必须被拒绝：
curl -i -X POST https://liushui-mem-dev.<subdomain>.workers.dev/append -d '{}'
# → 401 {"error":{"code":"unauthorized",...}}
```

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

## 9. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `GET /health` 返回旧版本 | 部署未生效或看错环境 | 检查 `SERVICE_VERSION` 与 `--env`；重跑 `wrangler deploy --env <env>` |
| `/append` 返回 500 `server_misconfigured` | `LIUSHUI_VAULT_TOKENS` 不是合法 JSON 或缺字段 | 重新写入 secret；`vault`/`url` 必须非空 |
| `/append` 返回 503 `storage_unavailable` | 数据库不可达或 Turso 凭据失效 | 检查 `url`/`authToken`；必要时轮换凭据（8.2） |
| `/append` 返回 401 | token 未配置到该环境 | 确认 CLI 用的配置文件与环境，以及 `LIUSHUI_VAULT_TOKENS` 中的 key |
| `/append` 返回 403 `vault_mismatch` | 请求体里的 `vault` 与 token 绑定的库不同 | 用该库自己的 token，或去掉请求体的 `vault` 字段 |
| `/append` 返回 413 `content_too_large` | `content` 超过 `LIUSHUI_MAX_CONTENT_BYTES` | 截断内容或调整上限 |
| CLI 报「未找到配置文件」 | 未创建配置或未设置 `LIUSHUI_CONFIG` | 见第 6 节 |
| 迁移报 `schema 已是最新` 但仍无表 | 连到了错误的数据库 | 用 `turso db shell <db> '.tables'` 确认 |
