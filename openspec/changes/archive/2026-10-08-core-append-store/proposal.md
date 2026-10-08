# Proposal

## Why

自进化记忆系统（见 `DESIGN.md`）的一切能力都建立在"只追加、永不改写的流水账"之上：检索、索引、反馈、维护都是它的派生物。目前仓库是空的，没有任何存储与写入路径。需要先把最小的可用内核建起来并部署，才能让人和 agent 开始写入真实记忆，后续的查询、向量、反馈才有数据可依、有真实使用可进化。

## What Changes

- 新增流水账（ledger）数据模型：`id`、`ts`、`author`、`kind`、`content`、`meta`（JSON）、`received_at`、`schema_v`。流水账只追加，不提供修改与删除。
- 新增确定性记忆 ID：对 `ts`、`author`、`kind`、`content`、附件 sha256 的规范化形式取 sha256 前 128 位并 base32 编码。`meta` 不参与 hash；`ts` 由客户端提供，因此重试幂等。
- 新增 Cloudflare Worker 写入 API：token 鉴权，按 token 路由到对应库；**每个库一个独立的 Turso 数据库**；`POST /append` 幂等写入。
- 新增 CLI `liushui append`：自动采集 meta（主机、系统、cwd、git 状态、进程、agent、CLI 版本、时区、来源），对 git remote 等敏感信息做清洗，支持 `--vault` 与 `--kind`；一次提交到多个库时 ID 相同、meta 可按库脱敏。
- 提供 dev 与 prod 两套环境（独立 Worker 加独立 Turso DB），并完成首次部署与冒烟验证。
- 本 change **仅支持文本**，不含查询、FTS、向量、附件、OCR、提交页、反馈与维护流程，这些由后续 change 负责。

## Capabilities

### New Capabilities
- `memory-ledger`: 只追加的记忆记录模型，包括字段定义、确定性 ID、幂等追加、可扩展的 JSON meta、schema 版本。
- `memory-api`: Worker 提供的写入 Web API，包括 token 鉴权、按库路由到独立数据库、幂等与错误语义、dev/prod 环境隔离。
- `memory-cli`: `liushui append` 命令，包括 meta 自动采集与敏感信息清洗、多库提交、本地配置、失败重试。

### Modified Capabilities
<!-- 无：仓库当前没有任何已有 spec -->

## Impact

- 新增代码：Worker 服务（TypeScript）、CLI、共享的 ID/规范化库、Turso schema 与迁移。
- 新增依赖：Cloudflare Workers 与 wrangler、`@libsql/client`；本地测试使用 libSQL 文件库。
- 新增外部资源：Cloudflare Worker（dev/prod）、Turso 数据库（至少 dev/prod 各一个，每个库一个）、各库的访问 token 与 Turso 凭据（作为 secrets，不入库）。
- 免费额度：本 change 的写入量远低于 Turso 与 Workers 的免费上限，不涉及 Workers AI 与 R2。
- 后续 change 依赖本 change 定义的 ID 规则与 `meta` 约定：`sql-query`、`feedback-minimal`、`embedding`、`attachments`、`submit-page`、`maintenance-process`。
