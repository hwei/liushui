# Design

## Context

动机见 proposal.md，需求见 `specs/memory-query` 与 `specs/memory-cli`。和本设计相关的现状：

- Worker（`packages/worker/src/app.ts`）只有 `/health` 与 `/append`。鉴权用 `LIUSHUI_VAULT_TOKENS`（client token → `{ vault, url, authToken }`）。处理逻辑通过 `HandlerDeps` 注入 libSQL 客户端与时钟，可以在 Node 里用本地文件库测试。
- 同一个库可以同时有多个 client token（用于轮换窗口，见 `docs/deploy.md`），所以“库”和“client token”不是一一对应的。
- 已核实：`@libsql/client`（0.15，直到最新的 0.18）的 `ResultSet` **不暴露** `rows_read`；`batch(…, "read")` 会发出 `BEGIN TRANSACTION READONLY`（libSQL 扩展语法）。Turso 的 Hrana HTTP 协议在语句结果里带有 `rows_read` / `query_duration_ms`，但这一点需要在 dev 上实测确认。
- `memories` 只有 `ts`、`kind` 两个索引，没有派生表。按用户决定，本 change 不新建派生表。

## Goals / Non-Goals

**Goals:**
- 在免费部署形态下提供可放心交给 agent 的只读查询：只读由数据库层保证，结果规模有上限，用量看得见。
- 查询逻辑与 Cloudflare 运行时解耦，延续 `HandlerDeps` 注入方式，核心路径不依赖云端也能测试。
- `/append` 的行为、性能与配置完全不变。

**Non-Goals:**
- 不做 SQL 改写或优化器（除了包裹 LIMIT），不做查询缓存。
- 不做对 SQL 的完整解析。语句检查只用来给出友好的错误，不承担安全职责。
- 不让 limits 可配置（不新增 env 变量）。先用代码常量，有真实需要时再开放。
- 不区分读写 client token：同一个 client token 既能追加也能查询所属库。

## Decisions

### 1. 只读凭据放在独立 secret `LIUSHUI_VAULT_READ_CREDS`，按**库名**索引

```json
{ "personal": { "authToken": "<Turso 只读 token>" }, "work": { "authToken": "…" } }
```

- 连接地址沿用该库在 `LIUSHUI_VAULT_TOKENS` 里的 `url`，只读配置里**不允许**出现 `url`，以免查询被路由到另一个数据库。
- 按库名而不是按 client token 索引：轮换窗口里同一个库有多个 client token，它们共用一份只读凭据，轮换 client token 时不需要动这个 secret。
- 只在 `/sql` 路径上解析它。这个 secret 缺失或损坏时 `/append` 不受影响（spec「只读配置缺失不影响追加」）。
- 找不到该库的条目时返回 `server_misconfigured`（500），**绝不回退**到写凭据。本地 sqld 没有鉴权，条目里写 `"authToken": ""` 即可，但条目本身必须存在。这是“显式声明”，不是“缺省放行”。
- 如果同一个库名在 `LIUSHUI_VAULT_TOKENS` 中对应了不同的 `url`，视为配置错误，返回 500。
- 备选方案：在 `LIUSHUI_VAULT_TOKENS` 的每一项里加 `readAuthToken` 字段。已按用户决定放弃。这样做的缺点是只读凭据要跟着每个 client token 复制一遍，而且两类凭据的轮换会互相牵连。

### 2. 只读的三层保证

| 层 | 机制 | 起作用的环境 | 职责 |
|---|---|---|---|
| 1 | Turso 只读 token（`turso db tokens create <db> --read-only`） | dev/prod | **权威**：即使上面两层都被绕过，也写不进去 |
| 2 | 在只读事务里执行（`BEGIN TRANSACTION READONLY`） | 云端、本地 sqld 与本地文件库 | 兜底，同时让本地测试能覆盖“执行层阻止写入”这一条 |
| 3 | 语句检查（core 里的纯函数） | 全部 | 友好地报出 `statement_not_allowed`，并拒绝多语句 |

- 第 3 层的做法：跳过注释与空白，按引号、注释感知地扫描分号，只允许一条语句；首个关键字必须是 `SELECT`、`WITH` 或 `EXPLAIN QUERY PLAN`（大小写不敏感）。它**不**负责安全：`WITH … DELETE` 能通过这一层，由第 1、2 层拦住。spec 的「执行层兜底阻止写入」场景就是用来固定这一点的。
- 第 2 层在本地文件库上是否支持 `BEGIN TRANSACTION READONLY`，由任务 1.1 实测。如果不支持，改为在同一个 batch 里先执行 `PRAGMA query_only = ON`。两种方式对外行为相同，spec 不受影响。
- 备选方案：只靠语句检查。放弃，原因是 SQLite 的语法面太大（`WITH` 后接 DML、`ATTACH`、各种函数副作用），而且安全不应该依赖解析器。

### 3. 用包裹 LIMIT 来限行数，多取一行来判断截断

`SELECT`/`WITH` 语句会被改写为 `SELECT * FROM (<原语句去掉末尾分号>) LIMIT <n+1>`，其中 `n` 是服务端校验过的整数，以字面量写入，不占用户的 `?` 参数位。取回 `n+1` 行就说明被截断了，只返回前 `n` 行。`EXPLAIN QUERY PLAN` 不包裹。

- 理由：web 客户端会一次取回全部结果行，没有游标，所以只有让数据库自己停下才能真正限制成本。
- 排序：SQLite 对带 `ORDER BY` 的子查询做扁平化后会保留顺序。spec 的「超过上限被截断并标记」场景要求按 `ts` 升序取前 10 行，由测试固定这一行为。
- 代价：结果中有重名列时，SQLite 会在子查询里把它们改名（如 `id:1`）。这对 JSONL 输出反而是好事（键不会冲突），在 skill 里说明即可。
- 默认值（代码常量）：默认 50 行，最多 500 行；单元格最多 2000 个字符；响应体最大 1 MiB（超出时按行截断）；超时 5 s。CLI 默认 `--limit 50`、`--max-width 200`（在服务端截断之外再收一层显示宽度）。

### 4. 执行器抽象，`rows_read` 的取法由 spike 决定

`HandlerDeps` 新增 `createQueryExecutor(binding, readCreds)`，返回 `execute(sql, args, { timeoutMs }) → { columns, rows, rowsRead? }`。handler 不关心底层是怎么实现的。

- **方案 A（倾向）**：直接 `fetch` Turso 的 Hrana HTTP pipeline（`libsql://` 换成 `https://`），一次请求里依次执行 `BEGIN TRANSACTION READONLY`、语句、`ROLLBACK`、`close`。好处是能拿到 `rows_read`，而且可以用 `AbortSignal` 真正取消 HTTP 请求。
- **方案 B（兜底）**：沿用 `@libsql/client` 的 `batch([...], "read")`，拿不到 `rows_read`，超时只能用 `Promise.race`（后端可能还在继续执行）。
- 任务 1.2 的 spike 在 dev 的 Turso 上实测：(a) Hrana 响应里有没有 `rows_read`；(b) 只读 token 加 READONLY 事务的组合是否可用。结论写回本节。spec 只要求“后端报告时返回”，所以两种方案都满足 spec。
- 本地测试（Node + 文件库）始终走方案 B 的执行器。方案 A 由 `test:worker-integration`（本地 sqld，同样说 Hrana）覆盖。
- **`EXPLAIN` 预检**：默认**不做**。现在数据量很小，免费额度很宽，预检还会把每次查询的请求数翻倍。spike 会对 `SELECT * FROM memories` 这类全表扫描实测 `rows_read`，把“记多少条以后需要预检”的判断写回本节，留给后续 change。

### 5. 错误映射

| 情况 | code | HTTP | 类别 |
|---|---|---|---|
| 语句检查未通过，或执行层报只读违规 | `statement_not_allowed` | 400 | client |
| `limit` 或 `args` 非法、超过最大值 | `invalid_field` | 400 | client |
| SQL 语法错误、未知表或列等 | `sql_error` | 400 | client |
| 超时 | `query_timeout` | 504 | server |
| 缺少只读凭据，或 url 冲突 | `server_misconfigured` | 500 | server |
| 网络或后端故障 | `storage_unavailable` | 503 | server |

- `sql_error` 带出数据库给出的错误描述，但先去掉其中任何 URL 或主机名样式的片段，并把长度限制在 500 字符以内。
- 区分 `sql_error` 与 `storage_unavailable` 的依据是 libSQL 错误码（`SQLITE_ERROR`、`SQL_PARSE_ERROR` 等），而不是消息文本。具体的码表在实现时以测试固定。
- `vault_mismatch`、`unauthorized` 沿用 `/append` 的语义与实现。

### 6. 请求与响应形状

```jsonc
// POST /sql
{ "sql": "SELECT ...", "args": ["note"], "limit": 50, "vault": "personal" }   // args/limit/vault 可选
// 200
{ "vault": "personal",
  "columns": ["id", "kind"],
  "rows": [["…", "note"]],
  "truncated": { "rows": false, "cells": 0 },
  "stats": { "rows_read": 12, "duration_ms": 18 } }   // rows_read 仅在后端报告时出现
```

- `args` 只接受 string、number、null，以免 bool 和 blob 的语义含糊。行一律用数组（而不是对象）返回：响应更紧凑，也不受重名列影响。
- 单元格里的 blob 用 base64 字符串表示，同样受单元格上限约束。超出安全整数范围的整数以字符串返回。

### 7. 用量日志

每次 `/sql` 结束时调用一次 `console.log(JSON.stringify({ event: "sql", vault, status, code?, rows, rows_read?, duration_ms }))`，可以在 Workers Logs 里看到。日志里**不记录** SQL、`args`、结果和任何凭据。spec「用量日志不含查询内容」用一条在 WHERE 里含私人文本的查询，加上截获 `console.log` 来验证。

### 8. CLI：复用配置与传输层，输出与重试单独实现

- `liushui sql [--vault <one>] [--env] [--config] [--json] [--limit N] [--max-width N] [--arg V]... <SQL | ->`
- 复用 `loadConfig`、`scrubSecrets` 与代理提示（`proxy-hint.ts`）。新增 `postSql`：只在网络错误和 503 时重试（最多 3 次，与 append 的退避相同）；`query_timeout`、`sql_error` 等 4xx 不重试。
- TSV 转义：`\` 转成 `\\`，制表符转成 `\t`，换行转成 `\n`，回车转成 `\r`，NULL 输出为 `\N`（与 COPY 惯例一致，以便和空串区分）。`--max-width` 按码点截断，并在末尾加 `…`。
- 截断提示只写到 stderr，例如 `liushui: 结果已截断（行数上限 50）`、`liushui: 12 个单元格被截断`。
- 备选方案：默认输出 JSONL。放弃，原因是 TSV 对 agent 上下文更省，列名也只出现一次。需要 JSONL 的场景用 `--json`。

### 9. Agent skill 放在仓库的 `skills/liushui/SKILL.md`

- 内容：何时写记忆、何时查记忆；`memories` 的字段与索引；`json_extract(meta, '$.git.branch')`；时间先后以 `ts` 为准（不假设 `received_at >= ts`）；常用查询模板；输出格式与截断提示；FTS 与 `embed()` 尚未提供。
- 安装方式：复制或软链到 `~/.claude/skills/liushui/`，写进 README。按 DESIGN.md 的原则，以后改 schema 时要同步更新这个 skill。
- 不放进 `.claude/skills/`：那里是本仓库开发时用的 skill，而这个 skill 是给**所有项目里的 agent** 用的。

### 10. 版本号

`SERVICE_VERSION` 升到 `0.2.0(-dev)`，`CLI_VERSION` 升到 `0.2.0`，用 `/health` 确认部署的是新版本。

## Risks / Trade-offs

- [`WITH … DELETE` 等写语句绕过语句检查] → 由第 1、2 层拦截；有专门的测试关掉第 3 层，验证第 2 层能拦住。
- [Turso 只读 token 与 READONLY 事务的组合在云端行为未知] → 任务 1.2 在 dev 实测，部署验收里再次验证写语句被拒绝。
- [方案 B 下超时无法取消后端查询] → 优先采用方案 A；在 B 下，5 s 超时加上行数上限也能控制住最坏情况，数据量小时影响很小。
- [查询反复全表扫描，消耗免费额度里的 rows read] → 返回并记录 `rows_read`，以便尽早发现；FTS 和派生索引留给后续 change。
- [LIMIT 包裹改变了重名列的列名] → 在 skill 里说明；如果需要原名，用户可以自己起别名。
- [SQL 错误描述里夹带内部信息] → 去掉 URL 与主机名样式的片段，限制长度，并由测试断言其中不含凭据与连接地址。
- [查询结果本身包含敏感记忆，进入 agent 上下文] → 这是查询功能本来的目的。库的隔离靠 token 绑定保证；同一个库内不做行级权限。

## Migration Plan

1. 为每个 dev 库创建只读 token：`turso db tokens create liushui-<vault>-dev --read-only`。
2. 把 `LIUSHUI_VAULT_READ_CREDS` 写入 dev Worker（从 stdin 输入），然后 `wrangler deploy --env dev`，用 `/health` 确认版本。
3. 在 dev 上冒烟：查询成功；`DELETE` 被拒绝且记录数不变；用个人库 token 指定公司库被拒绝；`/append` 照常。
4. 在 prod 上重复 1–3。`LIUSHUI_VAULT_TOKENS` 和现有 CLI 配置都不需要改。
5. 回滚：重新部署上一个版本即可。新 secret 对旧代码无害，可以保留。

## Open Questions

- 默认上限（50/500 行、2000 字符、1 MiB、5 s）是先拍定的值，可以在真实使用后调整，不影响 spec。
- 记多少条以后需要 `EXPLAIN` 预检或派生索引：由 spike 给出初步数字，最终在 FTS 或后续 change 中决定。
