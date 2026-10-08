# Tasks

## 1. 工程脚手架

- [x] 1.1 建立 monorepo 结构（`packages/core`、`packages/worker`、`packages/cli`），配置 TypeScript、测试框架与 lint；验证 `npm test` 与 `npm run lint` 在空项目上通过
- [x] 1.2 在 README 中写明本地开发、dev/prod 环境与所需 secrets 的清单；验证按文档能在干净环境完成安装

## 2. 共享核心（`core`）：记录模型、规范化与 ID

- [x] 2.1 定义记录类型与校验（必填字段、`content` 大小上限、`meta` 为键值对象）；验证单测覆盖缺字段、超限、非法 `meta`
- [x] 2.2 实现核心字段的规范化（键排序的确定性序列化、`ts` 统一为 UTC 毫秒 ISO）与 ID 计算（sha256 前 128 位，base32）；验证单测覆盖：meta 变化不影响 ID、content 差一字符 ID 不同、键顺序与等价时间表示不影响 ID
- [x] 2.3 固化一组 ID 测试向量（输入与期望输出）放入仓库；验证 core 的单测以该向量为准，并在文档中说明其为跨语言兼容基准

## 3. 存储：Turso schema 与迁移

- [x] 3.1 编写版本化迁移 SQL（`memories` 表：核心列 + `meta` JSON 列 + `received_at` + `schema_v`，`id` 为主键），并实现幂等迁移执行器；验证在本地 libSQL 文件库上重复执行迁移结果一致
- [x] 3.2 实现“若不存在则插入”的追加函数，返回是否新写入；验证单测覆盖重复 `id` 不覆盖既有记录的 `meta` 与 `received_at`
- [x] 3.3 验证按 `json_extract(meta, '$.git.branch')` 等 meta 字段过滤的查询可用（本地测试），并确认新增未见过的 meta 键无需迁移

## 4. Worker API（`worker`）

- [x] 4.1 实现 token 鉴权与 token→库映射（常数时间比较，无效 token 响应不泄露库信息）；验证测试覆盖无 token、无效 token、跨库访问被拒绝
- [x] 4.2 实现 `POST /append`：校验输入、用 core 重算 ID 并比对、调用追加函数、返回 `id` 与是否新写入；验证测试覆盖新写入、重复幂等、ID 不匹配、内容过大
- [x] 4.3 统一错误响应（机器可读、区分客户端错误与服务端错误、不含密钥与堆栈）；验证后端不可用时返回服务端错误
- [x] 4.4 实现无鉴权、不访问数据库的 `GET /health`，返回服务版本；验证响应含版本
- [x] 4.5 在 wrangler 本地模式下以本地 libSQL 文件库跑通 API 集成测试，覆盖两个库的隔离；验证个人库 token 写入后公司库无记录

## 5. CLI（`cli`）：`liushui append`

- [x] 5.1 实现配置读取（各库地址与 token、默认库、环境选择）与未配置时的提示；验证 token 不出现在任何输出与日志中
- [x] 5.2 实现 meta 自动采集（host、os、cwd、git.repo/branch/commit/dirty、proc、agent.name/session、cli.version、tz、src）；验证在 git 仓库内含 `git.*`，在非 git 目录不含
- [x] 5.3 实现敏感信息清洗（git remote userinfo 移除，清洗失败则省略字段）；验证单测以含 `user:token@` 的 remote 为输入
- [x] 5.4 实现按库的 meta 脱敏配置；验证同一条记忆发往两个库时 ID 相同而 meta 按各库配置不同
- [x] 5.5 实现 `liushui append`（`--vault`、`--kind`，默认 `note`；空内容报错；紧凑输出 `id`）；验证成功时退出码 0 且输出 `id`
- [x] 5.6 实现重试（网络错误与服务端错误复用同一 `ts` 与 `id` 重试，未授权与格式错误不重试）与多库结果报告；验证对本地 Worker 注入故障后库中仍只有一条记录，且单库失败时退出码非 0 并逐库报告


- [x] 5.7 把 CLI 命令名与配置目录落地为 `liushui` 与 `~/.config/liushui/`，并把 CLI 环境变量前缀改为 `LIUSHUI_`（`bin/liushui.ts`、package.json 的 `bin`、默认配置路径、`LIUSHUI_CONFIG` / `LIUSHUI_ENV` / `LIUSHUI_AUTHOR` / `LIUSHUI_AGENT_*` / `LIUSHUI_SRC`、README 与 docs/deploy.md），并迁移本机既有配置

## 6. 部署与首次真实验证

- [x] 6.1 创建 dev 与 prod 的 Turso 数据库与 Worker 配置，secrets 通过 wrangler 设置；验证 dev 的 `GET /health` 返回版本
- [x] 6.2 在 dev 执行迁移并用 `liushui append` 写入真实记录；验证重复执行同一命令后 dev 库中仍只有一条
- [x] 6.3 验证 dev 的 token 无法访问 prod，且 prod 的 token 无法访问 dev
- [x] 6.4 部署 prod，执行一次冒烟（health 加一条写入）；验证 `received_at`、`schema_v`、`meta` 在真实库中符合预期
- [x] 6.5 编写部署与 token 轮换文档；验证按文档可在新机器上完成 CLI 配置并写入成功

- [x] 6.6 把 Worker 的 secrets 与变量重命名为 `LIUSHUI_VAULT_TOKENS` / `LIUSHUI_MAX_CONTENT_BYTES` / `LIUSHUI_SCHEMA_V`；先设新 secret、再部署新代码，重跑 6.2–6.4 的验证，最后删除旧 secret
## 7. 综合验证

- [x] 7.1 对照三个 spec 的全部 Scenario 逐条核对测试与真实环境结果，补齐缺失用例
- [ ] 7.2 用本 change 部署的系统开始记录本项目自身的开发记忆，持续使用一段时间；验证无重复、无敏感信息泄漏（检查 `git.repo` 与 `cwd`），并把发现的问题记为后续 change 的输入

## Workflow follow-up

- 评审通过后归档该 change，并让 `DESIGN.md` 与归档后的主 spec 保持一致。
- 下一个 change：`sql-query`（含 `rows_read` 记账与 `EXPLAIN` 预检的 spike）。
