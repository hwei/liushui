# Proposal

## Why

系统上线后已经在 prod 里积累了真实记忆，但只能写、不能读：agent 没有任何办法查回自己写过的东西。`DESIGN.md` 里的检索、反馈记忆与维护流程都以“能查询”为前提，`core-append-store` 与 `post-deploy-followups` 也都把 `sql-query` 定为下一个 change（后者已为它定好了 `ts` / `received_at` 的时间语义）。现在补上只读查询，才能让后续的 `feedback-minimal`、`embedding`、FTS 等有真实使用可依。

## What Changes

- Worker 新增只读查询端点 `POST /sql`：沿用现有 client token 鉴权与“token → 库”的绑定，一次只查该 token 所属的**单个库**。
- **只读由数据库层保证**：`/sql` 只用 Turso 的**只读凭据**连库。只读凭据放在**新的独立 Worker secret** 里（不并入 `LIUSHUI_VAULT_TOKENS`）；缺失时拒绝服务，**绝不回退**到写凭据。另有两层纵深防御：只接受单条 `SELECT` / `WITH` / `EXPLAIN QUERY PLAN` 语句，并在只读事务里执行。
- **强制上限**：服务端强制行数上限、单元格截断、响应体大小上限与查询超时；被截断时在响应里明确标出，而不是静默丢弃。
- **用量可见**：后端报告 `rows_read` 时随响应返回并记日志（日志不含 SQL 文本与结果）。`rows_read` 的获取方式与 `EXPLAIN` 预检是否需要，由本 change 内的 spike 决定，结论写进 design。
- CLI 新增 `liushui sql "<SELECT ...>"`：只针对单库（`--vault` 至多一个），默认输出带表头的 TSV，`--json` 输出 JSONL。行数与列宽有默认限制，截断提示写到 stderr，stdout 保持可解析。支持从 stdin 读 SQL，并用 `--arg` 传参数。
- 新增一个最小的 agent skill：说明 `memories` 表结构、`meta` 的 `json_extract` 用法、时间排序以 `ts` 为准，以及 `liushui sql` / `liushui append` 的用法。
- 文档：在 `docs/deploy.md` 中补充只读凭据的创建、secret 写入与轮换；在 README 中补充 `liushui sql`。

**不做**：`embed()` 与向量检索（`embedding` change）、FTS5（中文分词需要单独评估，另起 change）、派生表、跨库查询、读写分离的 client token。

## Capabilities

### New Capabilities
- `memory-query`: 记忆库的只读 SQL 查询契约，包括单库范围、只读保证（只读凭据与独立配置，不回退）、语句限制、行数/单元格/响应大小上限与截断标记、超时、错误语义与用量报告。

### Modified Capabilities
- `memory-cli`: 新增「查询命令」要求，即 `liushui sql` 的单库约束、输出格式（TSV / JSONL）、截断提示、退出码与重试规则；并让「配置」中的 token 不泄露要求同样覆盖查询命令。

## Impact

- **代码**：
  - `packages/worker`：新增 `/sql` 路由与处理；`env.ts` 解析新 secret；`errors.ts` 新增错误码。
  - `packages/cli`：新增 `sql` 子命令、查询客户端与输出格式化。
  - `packages/core`：可能新增一个纯函数模块，负责语句检查与 LIMIT 包裹，供 Worker 使用并单独测试。
- **API**：新增 `POST /sql`。`/append` 与 `/health` 不变，向后兼容。
- **依赖**：不新增运行时依赖。spike 若改为直接调用 Hrana HTTP 协议来拿 `rows_read`，会用 `fetch` 实现，也不新增依赖。
- **线上**：每个 dev/prod 库都要创建 Turso 只读凭据，写入新 secret，并重新部署 Worker。`LIUSHUI_VAULT_TOKENS` 不变，现有 CLI 配置不需要修改。
- **文档与 skill**：`docs/deploy.md`、README、`DESIGN.md`（接口一节标注已实现的部分）以及新增的 agent skill 文件。
- **后续依赖**：FTS、`embed()` 宏和反馈记忆都会建立在本 change 的查询端点与上限契约之上。
