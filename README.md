# 流水（liushui）

自进化记忆系统的**只追加记忆流水账**。总体设计见 [`DESIGN.md`](./DESIGN.md)。

当前仓库实现的是最小可用内核 `core-append-store`：

```
liushui append  →  Cloudflare Worker（token 鉴权）  →  Turso / libSQL（每库一个独立数据库）
```

本 change 只覆盖**文本的写入路径**。查询、FTS、向量、附件、提交页、反馈与维护流程都不在范围内。

## 目录结构

```
packages/core      共享内核：记录模型与校验、规范化与确定性 ID、迁移与幂等追加
packages/worker    Cloudflare Worker：token 鉴权、按 token 路由到库、POST /append、GET /health
packages/cli       `mem` 命令行：meta 自动采集与清洗、按库脱敏、多库提交、失败重试
scripts/migrate.ts 对某个库幂等执行迁移
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

**输出约定**：单库成功时 stdout 只有 `id`（便于 agent 解析）；多库时 stdout 是 JSONL，每库一行；失败写到 stderr，任何库失败退出码为 1；用法/配置错误退出码为 2。`--env dev|prod` 或 `LIUSHUI_ENV` 切换环境，配置文件里的 `env` 是默认值。

## 环境与 secrets 清单

| 环境 | 服务实例 | 数据库 | token |
|---|---|---|---|
| dev | 独立 Worker（`wrangler --env dev`） | 每库一个独立 Turso DB | 每库独立 token，与 prod 不通用 |
| prod | 独立 Worker（`wrangler --env prod`） | 每库一个独立 Turso DB | 每库独立 token，与 dev 不通用 |

**Worker 侧**（通过 `wrangler secret put` 设置，绝不入库）：

| 名称 | 必填 | 说明 |
|---|---|---|
| `LIUSHUI_VAULT_TOKENS` | 是 | JSON：`{ "<token>": { "vault": "personal", "url": "libsql://…", "authToken": "<Turso 凭据>" } }`，token 与库一一绑定 |
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
- 部署与 token 轮换：[`docs/deploy.md`](./docs/deploy.md)
- 需求与验收标准：[`openspec/`](./openspec)（spec 是唯一需求来源）

## 常见问题

**`liushui append` 报「网络错误：TimeoutError」但 curl 同一个地址正常**
你的机器出网要走代理。Node 的 `fetch` 默认不读 `HTTP_PROXY` / `HTTPS_PROXY`（curl 会读）：

```bash
export NODE_USE_ENV_PROXY=1     # Node 24 起支持
```

**在 Windows 上装 Turso CLI**
官方 `install.sh` 只支持 Darwin/Linux（`probe_os()` 里没有 Windows 分支）。用 Go 装：

```powershell
go install github.com/tursodatabase/turso-cli/cmd/turso@latest   # → %USERPROFILE%\go\bin\turso.exe
```

别装 npm 上的 `turso` 包——那是 `tursodb`（本地 SQL shell），不是 cloud 管理 CLI。
详见 [`docs/deploy.md`](./docs/deploy.md) 第 0 节。
