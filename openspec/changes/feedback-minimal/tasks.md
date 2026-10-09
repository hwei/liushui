# Tasks

## 1. core：反馈格式

- [ ] 1.1 新增 `packages/core/src/feedback.ts` 并从 `index.ts` 导出：v1 主反馈与补充记录的类型、`parseFeedback(content)`（JSON 解析 + 按 `v` 分派 + 校验，错误抛带字段路径的 `ValidationError`）、`validateFeedbackInput(value)`、`serializeFeedback(value)`（`canonicalJson`）。规则按 design Decision 1 与 memory-feedback spec「反馈记录格式」「反馈的校验规则」：`intent` 非空；`queries` ≥1 项且 `sql` 非空、`args` 只含 string/number/null、`outcome` 为字符串；`expected_ids` 每项匹配 `[A-Z2-7]{26}` 且不重复；补充记录只允许 `v`/`refines`/`expected_ids`/`note`，`expected_ids` 可为空数组；拒绝未知字段与不支持的 `v`。验证：`packages/core/test/feedback.test.ts` 覆盖两个 Requirement 的全部 Scenario，以及“不同键顺序与缩进序列化后逐字相同”、`queries` 顺序保留
- [ ] 1.2 实现补充记录的合并与用例分类的纯函数（输入为 `{id, ts, content}` 列表，输出用例 / 待补充 / 无效三类，无效项带原因；按 design Decision 2：取 `ts` 最新、同 `ts` 取 `id` 较大，补充引用不存在或引用补充记录即无效）。验证：单测覆盖 memory-feedback spec「事后补充期望 ID」的全部 Scenario，以及「回归用例的收集」中“待补充”“格式不合规”两个 Scenario（不依赖数据库）

## 2. CLI：`liushui feedback`

- [ ] 2.1 `packages/cli/src/client.ts` 新增 `getServiceVersion(vault, options)`：`GET <url>/health`，3 秒超时，成功返回 `version` 字符串，任何失败返回 `null`（不抛错、不重试，诊断不含 token）。验证：单测用 mock fetch 覆盖成功、网络错误、超时、非 200、响应缺少 `version`
- [ ] 2.2 新增 `packages/cli/src/feedback.ts` 与 `main.ts` 中的 `feedback` 子命令（位置参数 JSON 或 `-` 读标准输入；`--vault` 至多一个；`--config`/`--env` 同 append），流程按 design Decision 3：校验失败 → stderr 带字段路径、退出码 2、不发请求；缺 `service_version` 时调用 2.1 填入，失败只打一行 stderr 提示；以 `kind = retrieval_feedback` 走 `runAppend` 的同一条路径；成功只输出 `id`。更新 `USAGE`，`CLI_VERSION` 升到 `0.3.0`。验证：`packages/cli/test/feedback.test.ts`（基于 `worker-harness`）覆盖 memory-cli delta 三个 Requirement 的全部 Scenario，并断言写入记录的 `kind`、`content` 为规范化 JSON、输入已含 `service_version` 时原样保留、输出与诊断不含 token
- [ ] 2.3 README 的 CLI 一节补充 `liushui feedback` 的用法（参数、标准输入、补充记录示例）。验证：README 中的示例命令在本地 worker-harness 或本地 Worker 上按原样执行成功

## 3. core：快照、派生数据重建与用例执行

- [ ] 3.1 新增 `packages/core/src/storage/derived.ts`：`rebuildDerived(client)` 依次重建全部派生数据并返回 `{ name, version, rows }[]`（目前只有 `memories_fts`），注释写明“新增派生数据必须在此登记”。验证：单测断言对载入的 `memories` 调用后 `checkFts` 全部通过，返回值含 `memories_fts` 与 `FTS_SEGMENTER_V`
- [ ] 3.2 快照的读写（design Decision 4）：`exportSnapshot(client, writer)` 按 `id` 分页读取 `memories` 全部 8 列并写 JSONL（首行头部含 `liushui_snapshot`、`taken_at`、`rows`、`schema_versions`），`readSnapshot(path)` 校验头部与行数一致、行字段完整，不一致时报错。验证：单测用本地文件库写入含中文、多行内容、嵌套 meta 的记录，导出再读回后逐字段相等（`meta` 原文相等）；截断的快照文件被拒绝
- [ ] 3.3 评估执行（design Decision 5）：新建临时文件库 → `runMigrations(loadMigrations())` → 原样批量插入快照行 → `rebuildDerived` → 收集用例（1.2）→ 每条查询走 `checkReadOnlyStatement` → `expandFtsMacros` → `wrapLimit(…, QUERY_DEFAULT_LIMIT)`，在事务中执行后回滚；出错记录错误码与消息；结束时删除临时库。验证：单测覆盖 memory-feedback spec「在候选代码上重建派生数据」「用例的执行」的全部 Scenario，并断言快照文件评估前后字节相同、临时库已删除、期望 ID 不在快照中的用例记为无效且列出缺失 ID
- [ ] 3.4 命中判定与基线比较的纯函数（按单元格字符串值精确比较，名次从 1 开始；`pass`/`partial`/`fail`/`error`；比较输出改善、退化、新增、消失）。验证：单测覆盖 memory-feedback spec「命中的判定」「报告与基线比较」的全部 Scenario

## 4. 回归命令行与本地目录

- [ ] 4.1 新增 `scripts/regress.ts`（`snapshot` 与 `run` 子命令，参数与输出按 design Decision 6）和 npm script `regress`；`.gitignore` 加入 `.liushui/`。`snapshot` 只从 `TURSO_URL`/`TURSO_AUTH_TOKEN` 读凭据；`run` 默认写报告到 `.liushui/reports/`，摘要写 stdout，报告头部含快照信息、git commit 与 dirty、派生数据版本。退出码 0/1/2。验证：对本地文件库（或本地 sqld）依次执行 `snapshot`、`run`、`run --baseline`，人为制造一个退化（改动快照中的期望 ID 对应的用例数据或用一份手写基线）时退出码为 1；用一个假 token 触发连接错误时，stdout、stderr、快照与报告中都不含该 token；`git status` 不显示 `.liushui/` 下的文件
- [ ] 4.2 `docs/deploy.md` 补充：只读凭据也用于导出回归快照（引用第 1 节已创建的 `--read-only` token），不需要新建凭据。验证：文档中的命令与 `scripts/regress.ts` 顶部注释一致

## 5. Skill 与维护流程文档

- [ ] 5.1 更新 `skills/liushui/SKILL.md`（design Decision 7）：用 `liushui feedback` 写反馈、v1 模板与补充记录模板、管道示例、`queries` 写真实执行过的 SQL、`cause` 写当场调查、未知期望 ID 时留空之后补充；在全文检索一节注明反馈 JSON 也会被索引，必要时用 `kind <> 'retrieval_feedback'` 过滤。验证：skill 中的每个反馈示例经 `liushui feedback` 在本地 worker-harness 上写入成功，且能被 3.3 的评估识别为用例或待补充
- [ ] 5.2 新增仓库根目录 `MAINTENANCE.md`（design Decision 7 的七个步骤与命令、隐私说明、`rebuildDerived` 登记要求、修复后补写正向反馈的建议）；`DESIGN.md` 的「反馈记忆规范」「维护流程」两节改为指向 `openspec/specs/memory-feedback/` 与 `MAINTENANCE.md`，并标注已实现的部分；README 目录结构加入 `scripts/regress.ts` 与 `MAINTENANCE.md`。验证：按 `MAINTENANCE.md` 的步骤在本地文件库上从头走一遍（不含部署与线上写入），每条命令都能按原样执行

## 6. 综合验证

- [ ] 6.1 全量回归：`npm test`、`npm run lint`、`npm run typecheck`、`npm run test:worker-integration`。验证：四项全部通过，测试数不少于上个 change 的基线（263）
- [ ] 6.2 dev 真实环境：用 `liushui feedback` 向 `liushui-personal-dev` 写一条带期望 ID 的反馈（其查询应能命中）和一条留空期望 ID 的反馈，再写一条补充记录；用只读凭据导出快照并 `run`。验证：两条反馈与补充被正确识别（一个 `pass` 用例、补充后的用例状态符合预期），`service_version` 为 `0.3.0-dev`；同一条查询经 `liushui sql` 在线执行的结果与本地评估的命中名次一致（design Risks 中的本地与 Turso 差异检查）。实测记录写在本任务说明中
- [ ] 6.3 prod：只导出快照并评估，不写入测试反馈（prod 的反馈应来自真实使用）。验证：`run` 正常结束，报告中用例/待补充/无效的计数与 `liushui sql "SELECT COUNT(*) FROM memories WHERE kind = 'retrieval_feedback'"` 的结果一致
- [ ] 6.4 对照 memory-feedback 与 memory-cli 两个 delta spec 的全部 Scenario，逐条对应到测试或真实环境记录。验证：映射写在本任务说明中，没有未覆盖的 Scenario

## Workflow follow-up

- 评审通过后归档本 change，新增 `memory-feedback` 主 spec，并把「反馈命令」相关要求合入 `memory-cli`。
- 积累一段时间的真实反馈后，按 `MAINTENANCE.md` 做第一次维护；届时再决定 design Open Questions 中的两项（名次退化是否算退化、写入时是否预检期望 ID）。
