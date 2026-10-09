# Proposal

## Why

DESIGN.md 的核心是一个闭环：agent 检索失败时写一条反馈记忆，人定期维护时把反馈转成回归用例，再根据用例改进系统。现在写入、SQL 查询和 `fts()` 全文检索都已上线，但闭环的后半段还没有：skill 只说“写一条 `retrieval_feedback`”，没有规定反馈的格式，也没有任何工具能把反馈变成可重复执行的回归测试。这样写下的反馈无法被机器读取，维护时也就无法回答“这次改动让检索变好了吗、有没有退化”。`fts-search` 归档时已把 `feedback-minimal` 定为下一个 change。

现在做的另一个原因是，后面的重型改动（向量检索、调整 bigram 规则、同义词）都需要用真实的失败用例来判断是否值得做、做完是否有效。闭环越早接上，积累的用例就越多。

## What Changes

- **结构化的反馈记录**：`kind = retrieval_feedback` 的记忆，其 `content` 是一个带版本号的 JSON 文档。文档包含检索意图、实际尝试过的 SQL（以及每条 SQL 的结果概要）、期望命中的记忆 ID（可留空）、当场的原因调查和服务版本号。格式校验放在 core，CLI 和回归工具共用同一份实现。
- **事后补充期望 ID**：流水账不可改写，所以“事后补上期望 ID”用一条新的反馈记录表示，它通过 `refines` 引用原反馈。多条补充按 `ts` 取最新一条。
- **`liushui feedback` 命令**：从参数或标准输入读取反馈 JSON，校验后自动填入服务版本号（取自 `/health`，取不到就省略），作为 `retrieval_feedback` 追加到**一个**库，输出 `id`。格式错误时不发出请求。
- **回归工具（本地运行，不经过 Worker）**：
  - `snapshot`：用 Turso 的只读凭据把某个库的 `memories` 原样导出为本地 JSONL 快照，只导出流水账本身。
  - `run`：把快照载入一个临时的本地库，用**当前工作区的代码**执行迁移并重建全部派生数据，然后从快照中收集反馈、生成用例，用与 `/sql` 相同的语句检查、宏展开和 LIMIT 包裹执行每条 SQL，判定每个用例是否命中期望 ID，最后输出 JSON 报告和摘要。
  - `--baseline`：与上一次的报告比较，列出改善和退化；有退化时以非 0 退出。

  因为回归始终在同一份快照上用候选代码执行，所以维护时可以在部署**之前**确认“有改善、无退化”。快照和报告含个人数据，只存放在 gitignore 的本地目录里，不进仓库。
- **`MAINTENANCE.md` 第一版**：写明一次维护的步骤和命令：拉取快照 → 跑基线 → 归类问题并修改 → 用候选代码重跑并对比 → 部署 → 写一条 `maintenance_log` 记忆。
- **Skill 与文档**：SKILL.md 改为用 `liushui feedback` 写反馈，给出 JSON 模板和“当场调查”的要求；README、DESIGN.md 的反馈与维护章节指向新的 spec 和 `MAINTENANCE.md`。

**不做**：Worker 端对反馈格式做校验（`/append` 不变，不需要重新部署；格式不合规的反馈在回归时报告为“无法解析”而不是被拒）；根据意图自动生成 SQL；“不应命中”的负向用例；相关度指标（MRR、nDCG 等），只判定是否命中和名次；把回归集提交进仓库；`maintenance_log` 的结构化格式（继续用普通文本 `append`）；把运行时自动调优作为进化手段。

## Capabilities

### New Capabilities
- `memory-feedback`: 检索反馈记忆的格式与语义（字段、版本、事后补充的合并规则），以及基于反馈的回归评估：本地快照、在候选代码上重建派生数据、执行用例、判定命中、报告与基线比较。

### Modified Capabilities
- `memory-cli`: 新增「反馈命令」要求：`liushui feedback` 的输入方式、写入前校验、单库限制、服务版本号的自动填写和输出格式。

## Impact

- **代码**：
  - `packages/core`：新增反馈格式的解析、校验与规范化序列化（如 `src/feedback.ts`）；新增“重建全部派生数据”的入口（当前只包含全文索引），供回归工具调用，以后新增的派生表也在这里登记；新增回归用例的收集、执行与判定逻辑。
  - `packages/cli`：新增 `feedback` 子命令和读取 `/health` 版本号的客户端函数；`CLI_VERSION` 升到 `0.3.0`。
  - `scripts/regress.ts`（`snapshot` / `run` 两个子命令）和对应的 npm script；`.gitignore` 增加本地快照和报告目录。
- **API / Worker**：不变，不需要重新部署，`SERVICE_VERSION` 不变。
- **依赖**：不新增依赖（本地临时库使用现有的 `@libsql/client`）。
- **数据与隐私**：快照包含库里的全部记忆，以明文写在本机。只用 Turso 的只读凭据导出，文件放在 gitignore 的目录中，凭据不会写入快照、报告或输出。
- **文档**：新增 `MAINTENANCE.md`；更新 `skills/liushui/SKILL.md`、`README.md`、`DESIGN.md`，`docs/deploy.md` 补充只读凭据也用于导出快照。
