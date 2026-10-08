# Tasks

## 1. Spike：只读执行与 `rows_read`

- [ ] 1.1 在本地文件库与本地 sqld 上实测 `batch([...], "read")`（`BEGIN TRANSACTION READONLY`）能否阻止 `INSERT` / `DELETE`；不支持时改用 `PRAGMA query_only = ON` 并在 design Decision 2 记录。验证：一个临时测试在两种后端上都断言写入失败、记录数不变
- [ ] 1.2 在 dev 的 Turso 上实测：(a) `turso db tokens create <db> --read-only` 的 token 执行写语句被拒；(b) 直接 `fetch` Hrana pipeline 的语句结果是否含 `rows_read` / `query_duration_ms`；(c) `SELECT * FROM memories` 的 `rows_read` 数值。结论（选方案 A 或 B、是否需要 `EXPLAIN` 预检及其触发规模）写回 design Decision 4。验证：design 中 Decision 4 不再含“由 spike 决定”的待定表述，且附实测数据

## 2. core：语句检查与 LIMIT 包裹

- [ ] 2.1 新增纯函数模块（`packages/core/src/query.ts`）：注释与引号感知的单语句检查，首关键字限 `SELECT` / `WITH` / `EXPLAIN QUERY PLAN`；去除末尾分号。验证：单测覆盖多语句、字符串或注释里的分号、`DELETE`/`PRAGMA x=1`/`BEGIN`/`ATTACH` 被拒、大小写与前导注释、`WITH … SELECT` 通过
- [ ] 2.2 实现 LIMIT 包裹（`SELECT * FROM (<stmt>) LIMIT n+1`，`n` 校验为正整数且 ≤ 最大值，以字面量写入；`EXPLAIN QUERY PLAN` 不包裹）与单元格截断、blob→base64、大整数→字符串的结果整形，以及响应字节上限下的按行截断。验证：单测断言用户 `?` 参数位不受影响、截断计数正确；对本地文件库断言带 `ORDER BY ts` 的子查询包裹后顺序保持

## 3. Worker：`POST /sql`

- [ ] 3.1 `env.ts` 解析 `LIUSHUI_VAULT_READ_CREDS`（按库名、只含 `authToken`、出现 `url` 即报错、同库名多 `url` 报错），只在 `/sql` 路径调用。验证：单测覆盖缺失/非法 JSON/缺条目/含 `url`；`/append` 在该 secret 缺失或损坏时仍返回 201
- [ ] 3.2 `HandlerDeps` 新增 `createQueryExecutor`，按 spike 结论实现执行器（方案 A 或 B；本地测试用文件库执行器），支持超时。验证：单测注入慢执行器断言返回 `query_timeout`（504）且无结果行；断言缺少只读凭据时返回 `server_misconfigured` 且执行器工厂从未拿到写凭据
- [ ] 3.3 实现 `/sql` 处理：鉴权与 `vault_mismatch` 复用 `/append` 逻辑，请求体校验（`sql`、`args` 仅 string/number/null、`limit`），语句检查、包裹、执行、整形，`errors.ts` 新增 `statement_not_allowed` / `sql_error` / `query_timeout` 并按 design Decision 5 映射。验证：测试覆盖 memory-query spec 的「查询端点」「单库范围」「只接受只读语句」（含关掉语句检查后执行层兜底）「结果行数上限」「单元格与响应大小上限」「查询错误语义」全部 Scenario，并断言错误体不含 token、Turso 凭据与连接地址
- [ ] 3.4 用量日志：每次 `/sql` 输出一行 JSON（vault、status、code、rows、rows_read、duration_ms）。验证：截获 `console.log` 的测试断言 WHERE 中的私人文本与结果数据不出现在日志里；执行器报告 `rows_read` 时响应 `stats.rows_read` 存在
- [ ] 3.5 两库隔离：在 `isolation.test.ts` 中为 `/sql` 补用例。验证：个人库 token 查询只看到个人库记录
- [ ] 3.6 更新 `.dev.vars.example` 加入 `LIUSHUI_VAULT_READ_CREDS` 示例（本地 sqld 为空 `authToken`），`wrangler.toml` 的 `SERVICE_VERSION` 升到 `0.2.0(-dev)`。验证：`npm run test:worker-integration` 新增的 `/sql` 端到端用例（含写语句被拒）通过

## 4. CLI：`liushui sql`

- [ ] 4.1 参数解析：`sql` 子命令，`--vault` 至多一个（多个为退出码 2），`--json`、`--limit`、`--max-width`、可重复 `--arg`、`-` 从 stdin 读 SQL，空 SQL 报错不发请求；更新 USAGE。验证：单测覆盖 memory-cli spec「查询命令」全部 Scenario
- [ ] 4.2 新增 `postSql`：只对网络错误与 503 重试，`sql_error` / `statement_not_allowed` / `query_timeout` / 401 / 403 不重试；网络失败带上代理提示。验证：单测按 spec「查询失败与重试」各 Scenario 断言请求次数与退出码
- [ ] 4.3 输出格式化：TSV（表头、`\\`/`\t`/`\n`/`\r` 转义、NULL 为 `\N`）、JSONL、`--max-width` 按码点截断加 `…`、截断提示只写 stderr、空结果行为；所有输出过 `scrubSecrets`。验证：单测覆盖「查询输出格式」全部 Scenario 与「查询输出不泄露 token」，并用 worker-harness 跑一次本地端到端
- [ ] 4.4 `CLI_VERSION` 升到 `0.2.0`；README 增加 `liushui sql` 用法、输出约定与 Worker secrets 表中的 `LIUSHUI_VAULT_READ_CREDS`。验证：README 中的示例命令在本地 worker-harness 上按文档运行得到所述输出

## 5. Agent skill 与文档

- [ ] 5.1 新增 `skills/liushui/SKILL.md`（何时写/查、`memories` 字段与索引、`json_extract` 用法、以 `ts` 排序、常用查询模板、截断提示、重名列改名、FTS/`embed()` 尚未提供），README 写明安装方式（复制或软链到 `~/.claude/skills/liushui/`）。验证：skill 中每条示例 SQL 在本地库上经 `liushui sql` 执行成功
- [ ] 5.2 `docs/deploy.md` 增补只读 token 创建、`LIUSHUI_VAULT_READ_CREDS` 写入与轮换（与 client token 轮换互不牵连）、`/sql` 冒烟步骤；`DESIGN.md`「接口」一节标注 `liushui sql` 已实现、`embed()` 未实现。验证：文档与 design Decision 1、Migration Plan 一致，无矛盾表述

## 6. 部署与综合验证

- [ ] 6.1 dev：创建只读 token、写入 secret、部署，`/health` 返回 `0.2.0-dev`；冒烟查询成功、`DELETE` 被拒且记录数不变、跨库指定被拒、`/append` 照常。验证：逐项命令输出记录在本任务说明或提交信息中
- [ ] 6.2 prod：同 6.1，并用 `liushui sql` 查回 core-append-store 期间写入的真实记忆。验证：查询结果包含已知 id，日志中可见 `rows_read`（若方案 A）且不含 SQL 文本
- [ ] 6.3 全量回归：`npm test`、`npm run lint`、`npm run typecheck`、`npm run test:worker-integration`。验证：四项全部通过，测试数不少于上个 change 的基线（只增不减）
- [ ] 6.4 对照 memory-query 与 memory-cli 两个 delta spec 的全部 Scenario 逐条核对测试与真实环境结果，补齐缺失用例。验证：每个 Scenario 都能指到一个测试或一条真实环境记录

## Workflow follow-up

- 评审通过后归档本 change，并让 `openspec/specs/` 下的主 spec 与新要求保持一致（新增 `memory-query`，`memory-cli` 合入查询相关要求）。
- 下一个候选 change：FTS（含中文分词评估：`trigram` tokenizer 或分词后入派生表），以及 `feedback-minimal`。
