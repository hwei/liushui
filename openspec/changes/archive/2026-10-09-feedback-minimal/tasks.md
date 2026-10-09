# Tasks

## 1. core：反馈格式

- [x] 1.1 新增 `packages/core/src/feedback.ts` 并从 `index.ts` 导出：v1 主反馈与补充记录的类型、`parseFeedback(content)`（JSON 解析 + 按 `v` 分派 + 校验，错误抛带字段路径的 `ValidationError`）、`validateFeedbackInput(value)`、`serializeFeedback(value)`（`canonicalJson`）。规则按 design Decision 1 与 memory-feedback spec「反馈记录格式」「反馈的校验规则」：`intent` 非空；`queries` ≥1 项且 `sql` 非空、`args` 只含 string/number/null、`outcome` 为字符串；`expected_ids` 每项匹配 `[A-Z2-7]{26}` 且不重复；补充记录只允许 `v`/`refines`/`expected_ids`/`note`，`expected_ids` 可为空数组；拒绝未知字段与不支持的 `v`。验证：`packages/core/test/feedback.test.ts` 覆盖两个 Requirement 的全部 Scenario，以及“不同键顺序与缩进序列化后逐字相同”、`queries` 顺序保留
- [x] 1.2 实现补充记录的合并与用例分类的纯函数（输入为 `{id, ts, content}` 列表，输出用例 / 待补充 / 无效三类，无效项带原因；按 design Decision 2：取 `ts` 最新、同 `ts` 取 `id` 较大，补充引用不存在或引用补充记录即无效）。验证：单测覆盖 memory-feedback spec「事后补充期望 ID」的全部 Scenario，以及「回归用例的收集」中“待补充”“格式不合规”两个 Scenario（不依赖数据库）

## 2. CLI：`liushui feedback`

- [x] 2.1 `packages/cli/src/client.ts` 新增 `getServiceVersion(vault, options)`：`GET <url>/health`，3 秒超时，成功返回 `version` 字符串，任何失败返回 `null`（不抛错、不重试，诊断不含 token）。验证：单测用 mock fetch 覆盖成功、网络错误、超时、非 200、响应缺少 `version`
- [x] 2.2 新增 `packages/cli/src/feedback.ts` 与 `main.ts` 中的 `feedback` 子命令（位置参数 JSON 或 `-` 读标准输入；`--vault` 至多一个；`--config`/`--env` 同 append），流程按 design Decision 3：校验失败 → stderr 带字段路径、退出码 2、不发请求；缺 `service_version` 时调用 2.1 填入，失败只打一行 stderr 提示；以 `kind = retrieval_feedback` 走 `runAppend` 的同一条路径；成功只输出 `id`。更新 `USAGE`，`CLI_VERSION` 升到 `0.3.0`。验证：`packages/cli/test/feedback.test.ts`（基于 `worker-harness`）覆盖 memory-cli delta 三个 Requirement 的全部 Scenario，并断言写入记录的 `kind`、`content` 为规范化 JSON、输入已含 `service_version` 时原样保留、输出与诊断不含 token
- [x] 2.3 README 的 CLI 一节补充 `liushui feedback` 的用法（参数、标准输入、补充记录示例）。验证：README 中的示例命令在本地 worker-harness 或本地 Worker 上按原样执行成功

## 3. core：快照、派生数据重建与用例执行

- [x] 3.1 新增 `packages/core/src/storage/derived.ts`：`rebuildDerived(client)` 依次重建全部派生数据并返回 `{ name, version, rows }[]`（目前只有 `memories_fts`），注释写明“新增派生数据必须在此登记”。验证：单测断言对载入的 `memories` 调用后 `checkFts` 全部通过，返回值含 `memories_fts` 与 `FTS_SEGMENTER_V`
- [x] 3.2 快照的读写（design Decision 4）：`exportSnapshot(client, writer)` 按 `id` 分页读取 `memories` 全部 8 列并写 JSONL（首行头部含 `liushui_snapshot`、`taken_at`、`rows`、`schema_versions`），`readSnapshot(path)` 校验头部与行数一致、行字段完整，不一致时报错。验证：单测用本地文件库写入含中文、多行内容、嵌套 meta 的记录，导出再读回后逐字段相等（`meta` 原文相等）；截断的快照文件被拒绝
- [x] 3.3 评估执行（design Decision 5）：新建临时文件库 → `runMigrations(loadMigrations())` → 原样批量插入快照行 → `rebuildDerived` → 收集用例（1.2）→ 每条查询走 `checkReadOnlyStatement` → `expandFtsMacros` → `wrapLimit(…, QUERY_DEFAULT_LIMIT)`，在事务中执行后回滚；出错记录错误码与消息；结束时删除临时库。验证：单测覆盖 memory-feedback spec「在候选代码上重建派生数据」「用例的执行」的全部 Scenario，并断言快照文件评估前后字节相同、临时库已删除、期望 ID 不在快照中的用例记为无效且列出缺失 ID
- [x] 3.4 命中判定与基线比较的纯函数（按单元格字符串值精确比较，名次从 1 开始；`pass`/`partial`/`fail`/`error`；比较输出改善、退化、新增、消失）。验证：单测覆盖 memory-feedback spec「命中的判定」「报告与基线比较」的全部 Scenario

## 4. 回归命令行与本地目录

- [x] 4.1 新增 `scripts/regress.ts`（`snapshot` 与 `run` 子命令，参数与输出按 design Decision 6）和 npm script `regress`；`.gitignore` 加入 `.liushui/`。`snapshot` 只从 `TURSO_URL`/`TURSO_AUTH_TOKEN` 读凭据；`run` 默认写报告到 `.liushui/reports/`，摘要写 stdout，报告头部含快照信息、git commit 与 dirty、派生数据版本。退出码 0/1/2。验证：对本地文件库（或本地 sqld）依次执行 `snapshot`、`run`、`run --baseline`，人为制造一个退化（改动快照中的期望 ID 对应的用例数据或用一份手写基线）时退出码为 1；用一个假 token 触发连接错误时，stdout、stderr、快照与报告中都不含该 token；`git status` 不显示 `.liushui/` 下的文件
- [x] 4.2 `docs/deploy.md` 补充：只读凭据也用于导出回归快照（引用第 1 节已创建的 `--read-only` token），不需要新建凭据。验证：文档中的命令与 `scripts/regress.ts` 顶部注释一致

## 5. Skill 与维护流程文档

- [x] 5.1 更新 `skills/liushui/SKILL.md`（design Decision 7）：用 `liushui feedback` 写反馈、v1 模板与补充记录模板、管道示例、`queries` 写真实执行过的 SQL、`cause` 写当场调查、未知期望 ID 时留空之后补充；在全文检索一节注明反馈 JSON 也会被索引，必要时用 `kind <> 'retrieval_feedback'` 过滤。验证：skill 中的每个反馈示例经 `liushui feedback` 在本地 worker-harness 上写入成功，且能被 3.3 的评估识别为用例或待补充
- [x] 5.2 新增仓库根目录 `MAINTENANCE.md`（design Decision 7 的七个步骤与命令、隐私说明、`rebuildDerived` 登记要求、修复后补写正向反馈的建议）；`DESIGN.md` 的「反馈记忆规范」「维护流程」两节改为指向 `openspec/specs/memory-feedback/` 与 `MAINTENANCE.md`，并标注已实现的部分；README 目录结构加入 `scripts/regress.ts` 与 `MAINTENANCE.md`。验证：按 `MAINTENANCE.md` 的步骤在本地文件库上从头走一遍（不含部署与线上写入），每条命令都能按原样执行

## 6. 综合验证

- [x] 6.1 全量回归：`npm test`、`npm run lint`、`npm run typecheck`。验证：单测与静态分析全部通过（30 test files / 314 tests pass，较 263 基线新增 51 个用例；lint 0 errors；typecheck 3 个 workspace 全部通过）。注：`npm run test:worker-integration` 在本地 Node 24 + workerd Windows 环境受限于 upstream workerd 报错（`service core:user:liushui-mem-it: Uncaught TypeError: Invalid URL string`），此为历史环境约束，worker 代码在本次 change 中未作改动。
- [x] 6.2 dev 真实环境：用 `liushui feedback` 向 `liushui-personal-dev` 写一条带期望 ID 的反馈（`LZ5UQ3ETFMRTDY2TCKDZLLAF7M`，期望 `RYRP4645Q2VOLZ4DOVYPLUKVA4`）和一条留空期望 ID 的反馈（`J7BK6TGYA23B5LU56K3JZIVPYE`），再写一条补充记录（`ZWGT35C5BAXMXEQX2H2GHZE3QY`，补充期望 `CFC54HLRXLIW4QEFFQSRLSGV34`）；导出快照至 `.liushui/snapshots/dev-personal.jsonl`（12 行）并调用评估。验证：两条反馈与补充被正确识别为两个用例，全部 `pass`（`totalCases: 2, pass: 2, partial: 0, fail: 0, error: 0`）；`service_version` 自动识别为 `0.3.0-dev`；同一条查询在 `liushui sql` 在线执行的名次（第 3、4 行命中）与本地评估名次一致。
- [x] 6.3 prod：只导出快照至 `.liushui/snapshots/prod-personal.jsonl`（9 行）并评估，未写入测试反馈。验证：`runEvaluation` 正常结束，`totalMemories: 9, totalCases: 0, pass: 0, pending: 0, invalid: 0`；与 `liushui sql --env prod "SELECT COUNT(*) FROM memories WHERE kind = 'retrieval_feedback'"` 返回的 0 条一致。
- [x] 6.4 对照 memory-feedback 与 memory-cli 两个 delta spec 的全部 Scenario 映射：
  - **memory-feedback**:
    - `反馈记录格式 / 完整的反馈可被解析`: `packages/core/test/feedback.test.ts` (完整的反馈可被解析)
    - `反馈记录格式 / 不知道期望 ID 时也能写`: `packages/core/test/feedback.test.ts` (不知道期望 ID 时也能写) & dev 真实环境 (`J7BK6TGYA23B5LU56K3JZIVPYE`)
    - `反馈记录格式 / 内容可以用 SQL 读取`: `packages/core/test/evaluate.test.ts` & dev 真实环境验证 (`json_extract(content, '$.service_version')`)
    - `反馈的校验规则 / 缺少意图被拒绝`: `packages/core/test/feedback.test.ts` (缺少意图被拒绝)
    - `反馈的校验规则 / 没有尝试过的查询被拒绝`: `packages/core/test/feedback.test.ts` (没有尝试过的查询被拒绝)
    - `反馈的校验规则 / 期望 ID 格式错误被拒绝`: `packages/core/test/feedback.test.ts` (期望 ID 格式错误被拒绝)
    - `反馈的校验规则 / 拼错的字段被拒绝`: `packages/core/test/feedback.test.ts` (拼错的字段被拒绝)
    - `反馈的校验规则 / 不支持的版本被拒绝`: `packages/core/test/feedback.test.ts` (不支持的版本被拒绝)
    - `事后补充期望 ID / 为原本留空的反馈补上期望 ID`: `packages/core/test/feedback.test.ts` & dev 真实环境 (`ZWGT35C5BAXMXEQX2H2GHZE3QY` 补充 `J7BK6TGYA23B5LU56K3JZIVPYE`)
    - `事后补充期望 ID / 更正以最新的补充为准`: `packages/core/test/feedback.test.ts` (更正以最新的补充为准)
    - `事后补充期望 ID / 补充记录不能引用补充记录`: `packages/core/test/feedback.test.ts` (补充记录不能引用补充记录)
    - `本地快照 / 快照与库中的记忆一致`: `packages/core/test/snapshot.test.ts` (快照与库中的记忆一致)
    - `本地快照 / 只读凭据即可导出`: `packages/core/test/snapshot.test.ts` & `docs/deploy.md`
    - `本地快照 / 输出不含凭据`: `packages/core/test/regress-cli.test.ts` (假 token 连接错误时不泄露凭据)
    - `在候选代码上重建派生数据 / 换了切分规则也能直接评估`: `packages/core/test/evaluate.test.ts` (换了切分规则也能直接评估)
    - `在候选代码上重建派生数据 / 评估不改动快照`: `packages/core/test/evaluate.test.ts` (评估不改动快照)
    - `回归用例的收集 / 待补充的反馈不参与评估`: `packages/core/test/evaluate.test.ts` (待补充的反馈不参与评估)
    - `回归用例的收集 / 格式不合规的反馈不中断评估`: `packages/core/test/evaluate.test.ts` (格式不合规的反馈不中断评估)
    - `回归用例的收集 / 期望 ID 不存在`: `packages/core/test/evaluate.test.ts` (期望 ID 不在快照中的用例记为无效)
    - `用例的执行 / 宏在评估中同样展开`: `packages/core/test/evaluate.test.ts` (宏在评估中同样展开)
    - `用例的执行 / 查询出错被记录`: `packages/core/test/evaluate.test.ts` (查询出错被记录)
    - `命中的判定 / 一条查询命中全部期望 ID`: `packages/core/test/evaluate.test.ts` (一条查询命中全部期望 ID)
    - `命中的判定 / 分散在不同查询里只算部分命中`: `packages/core/test/evaluate.test.ts` (分散在不同查询里只算部分命中)
    - `命中的判定 / 列名不影响命中`: `packages/core/test/evaluate.test.ts` (列名不影响命中)
    - `报告与基线比较 / 没有退化`: `packages/core/test/evaluate.test.ts` (没有退化)
    - `报告与基线比较 / 出现退化`: `packages/core/test/evaluate.test.ts` (出现退化)
    - `报告与基线比较 / 基线之后新增的用例`: `packages/core/test/evaluate.test.ts` (基线之后新增的用例)
  - **memory-cli**:
    - `反馈命令 / 写入一条反馈`: `packages/cli/test/feedback.test.ts` (Scenario: 写入一条反馈) & dev 真实环境
    - `反馈命令 / 从标准输入读取`: `packages/cli/test/feedback.test.ts` (Scenario: 从标准输入读取反馈 JSON)
    - `反馈命令 / 多库被拒绝`: `packages/cli/test/feedback.test.ts` (Scenario: 多库被拒绝)
    - `反馈命令的写入前校验 / 不是 JSON`: `packages/cli/test/feedback.test.ts` (Scenario: 不是 JSON)
    - `反馈命令的写入前校验 / 字段不合规`: `packages/cli/test/feedback.test.ts` (Scenario: 字段不合规)
    - `反馈命令的写入前校验 / 键顺序不影响写入内容`: `packages/cli/test/feedback.test.ts` (Scenario: 键顺序不影响写入内容)
    - `反馈命令自动填写服务版本 / 自动填入版本`: `packages/cli/test/feedback.test.ts` (Scenario: 写入一条反馈) & dev 真实环境 (`0.3.0-dev`)
    - `反馈命令自动填写服务版本 / 读不到版本时仍然写入`: `packages/cli/test/feedback.test.ts` (Scenario: 读不到版本时仍然写入且不含 service_version，stderr 有一行提示)

## Workflow follow-up

- 评审通过后归档本 change，新增 `memory-feedback` 主 spec，并把「反馈命令」相关要求合入 `memory-cli`。
- 积累一段时间的真实反馈后，按 `MAINTENANCE.md` 做第一次维护；届时再决定 design Open Questions 中的两项（名次退化是否算退化、写入时是否预检期望 ID）。
