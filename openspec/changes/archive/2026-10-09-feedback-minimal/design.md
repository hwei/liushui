# Design

## Context

动机见 proposal.md，需求见 `specs/memory-feedback` 与 `specs/memory-cli`。和本设计相关的现状：

- `/append` 不限制 `kind`，`content` 是任意文本（上限 128 KiB）。`meta` 的校验**不支持数组**（`validateMeta` 拒绝数组），所以期望 ID 列表这类结构不能放进 meta。
- 记录 ID 由 `ts`/`author`/`kind`/`content` 经 `canonicalJson` 规范化后算出，是 26 位大写 base32（`[A-Z2-7]{26}`）。core 已导出 `canonicalJson`。
- CLI 的 `runAppend` 负责采集 meta、按库脱敏、重试，`resolveAuthor` 从 `LIUSHUI_AUTHOR`/`USER`/`USERNAME` 取作者；`/health` 不鉴权，返回 `{"ok":true,"version":"…"}`。
- `/sql` 在 Worker 中的流程是 `checkReadOnlyStatement` → `expandFtsMacros` → `wrapLimit(…, limit)`（默认 `QUERY_DEFAULT_LIMIT = 50`）→ Hrana 只读执行器 → `shapeResult`。前三步和整形都是 core 的纯函数，只有执行器在 Worker 里。
- 派生数据目前只有全文索引：`rebuildFts(client)` 在一个写事务里从 `memories` 重建，并登记 `derived_state`。迁移由 `loadMigrations()` + `runMigrations()` 执行。
- 流水账只允许追加；`/sql` 的单元格会被截断到 2000 字符，单次最多 500 行，所以**不能**用 `/sql` 完整导出流水账。
- DESIGN.md 原则 6：进化出的部分高度个人化，不适合公开。反馈的意图文本、期望 ID 都是个人数据。

## Goals / Non-Goals

**Goals:**
- 反馈是机器可读的，且格式校验只有一份实现（core），CLI 写入和回归读取共用。
- 维护时能在**部署之前**，用候选代码对真实数据跑回归，并和上一次结果比较。
- 不改 Worker、不改 API、不需要重新部署线上服务。

**Non-Goals:**
- 不做回归结果的持久化与趋势分析（报告是本地 JSON 文件，比较只做“本次 vs 指定基线”）。
- 不做多库合并评估：一次评估只针对一个库的快照。
- 不为评估提供超时与 `rows_read` 统计（本地小库，必要时以后再加）。
- 不让回归工具写入任何线上库，包括自动写 `maintenance_log`。

## Decisions

### 1. 反馈放在 `content` 里，用带版本号的 JSON，不放 meta

- 可选方案：(a) `content` 放自然语言，结构化字段放 meta；(b) `content` 放 JSON；(c) 新增表或新列。
- 选 (b)。原因：meta 不支持数组，而 `queries`、`expected_ids` 都是列表；meta 会按库脱敏，不适合放语义数据；meta 不参与 ID，同一份反馈改了期望 ID 却得到同一个 ID，会被幂等吞掉。(c) 需要迁移且偏离“流水账是唯一事实来源”，没有必要。
- `content` 用 `canonicalJson`（键排序、紧凑）序列化。数组的顺序保留（`queries` 的顺序有意义，就是尝试的先后）。这样同一份反馈不论输入格式如何，都得到相同的 `content` 和 ID，CLI 重试也天然幂等。
- 有了 `v` 字段，以后改格式可以加 v2，解析器按 `v` 分派，旧记录永远可读（与 `schema_v` 的承诺一致）。
- v1 拒绝未知字段：反馈写一次就不能改，拼错字段（如 `expect_ids`）若被静默接受，这条反馈就永远成不了用例。严格校验让错误在写入时暴露。

v1 主反馈：

```json
{
  "v": 1,
  "intent": "上次 iOS 渲染问题是怎么查的",
  "queries": [
    { "sql": "SELECT m.id, m.content FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH fts('iOS渲染') ORDER BY rank", "outcome": "0 行" },
    { "sql": "SELECT id, content FROM memories WHERE content LIKE ?", "args": ["%渲染%"], "outcome": "3 行，都不是想要的" }
  ],
  "expected_ids": ["RYRP4645Q2VOLZ4DOVYPLUKVA4"],
  "cause": "原文写的是“Metal 着色器”，没有出现“渲染”二字：同义词问题",
  "service_version": "0.3.0"
}
```

补充记录：`{"v":1,"refines":"<原反馈 id>","expected_ids":[…],"note":"…"}`。`expected_ids` 允许为空数组，表示撤回之前给的期望 ID（该反馈回到“待补充”）。

### 2. 补充记录的合并：取 `ts` 最新的一条，不做并集

- 并集无法更正错误的 ID；“最新为准”既能补充也能更正，规则也简单。`ts` 相同取 `id` 较大者，保证结果确定。
- 禁止补充记录再引用补充记录，避免链式解析与环。
- 补充只改期望 ID，不改 `queries`：用例的查询必须是当时真实尝试过的查询，这是回归有意义的前提。

### 3. `liushui feedback`：JSON 输入，复用追加路径

- 输入方式：位置参数为一份 JSON，或 `-` 从标准输入读取。不提供 `--intent`/`--sql` 这类逐字段的参数：SQL 本身含引号，经 shell（尤其 Windows）转义很容易出错；agent 生成 JSON 并用管道传入最稳定。
- 流程：读取 → `JSON.parse` → core 校验（错误带字段路径，退出码 2，不发请求）→ 若无 `service_version` 则 `GET <vault.url>/health`（3 秒超时，失败只打一行 stderr 提示）→ `canonicalJson` → 以 `kind = retrieval_feedback` 走 `runAppend` 的同一条追加路径（meta 采集、脱敏、重试、token 清洗都复用）。
- 限制单库：期望 ID 是否存在取决于库，反馈描述的也是“在这个库里没搜到”。写进多个库会让用例在别的库里必然“无效”。
- 不在写入时检查期望 ID 是否存在：那需要额外调用一次 `/sql`，而且网络失败时到底写不写，会让命令语义变复杂。回归时会把不存在的 ID 报告为“无效”，足以发现问题。
- `CLI_VERSION` 升到 `0.3.0`。

### 4. 回归在本地快照上执行，不经过 Worker

- 可选方案：(a) 回归经 `/sql` 在线执行；(b) 导出快照，在本地临时库上用工作区代码执行。
- 选 (b)。(a) 只能评估**已部署**的代码，维护流程要求“改完重跑、确认无退化后再部署”；而且切分规则一变，线上索引是旧规则建的，(a) 根本测不出新规则的效果。(b) 每次都从流水账重建派生数据，正好贯彻“派生数据可整体重建”的原则。
- 快照不能经 `/sql` 导出（单元格截断、行数上限），所以直接用 `@libsql/client` 和**只读**数据库凭据（`turso db tokens create --read-only`，部署时已经为 `/sql` 创建过）按 `id` 分页读取 `memories`。
- 快照格式为 JSONL：第一行是头部 `{"liushui_snapshot":1,"taken_at":…,"rows":N,"schema_versions":[…]}`，之后每行一条 `memories` 记录，8 列都按库中原值保存（`meta` 保留原始 JSON 文本，不重新序列化）。选 JSONL 而不是 SQLite 文件：与代码版本无关、可 diff、可以直接用文本工具查看；头部的行数用于在读取时校验完整性。
- 默认目录：快照在 `.liushui/snapshots/`，报告在 `.liushui/reports/`，把 `.liushui/` 加入 `.gitignore`。

### 5. 评估流程：临时文件库 → 迁移 → 重建全部派生数据 → 执行

1. 在系统临时目录建一个新的 SQLite 文件库（评估结束后删除）。**不用 `:memory:`**：`@libsql/client` 对 `:memory:` 开事务时会换一个新连接，数据会丢，而 `rebuildFts` 依赖写事务。
2. `runMigrations(client, loadMigrations())`：用工作区的迁移建表。
3. 把快照的行原样批量插入 `memories`（直接 `INSERT`，不经过 `appendMemory`，从而不在插入时写派生数据）。
4. `rebuildDerived(client)`：core 新增的入口，按顺序重建所有派生数据并返回各自的版本。目前只调用 `rebuildFts`；以后新增派生表（如向量）的 change 必须在这里登记，回归才会覆盖它。
5. 从 `memories` 中读取 `kind = 'retrieval_feedback'` 的记录，用 core 的纯函数解析、合并补充记录、分类为用例、待补充、无效。
6. 对每个用例的每条查询：`checkReadOnlyStatement` → `expandFtsMacros` → `wrapLimit(…, QUERY_DEFAULT_LIMIT)`，在一个事务里执行，执行后回滚、不提交（与 Worker 执行器“永不提交”的做法一致）。出错时记录错误码和消息：语句检查与宏的错误来自 core，消息与 `/sql` 相同；SQL 错误使用数据库的原始描述。
7. 命中判定与用例状态见 spec。比较单元格时只比较字符串值，忽略数值与 null。

收集、合并、判定、基线比较都是不接触数据库的纯函数，放在 core（如 `src/feedback.ts`、`src/regress.ts`）；需要 `Client` 的部分（载入快照、重建、执行）放在 `core/storage`。这样单元测试可以分层写。

### 6. 命令行入口：`scripts/regress.ts`

```bash
# 导出快照（只读凭据只从环境变量读取）
TURSO_URL=libsql://… TURSO_AUTH_TOKEN=<只读 token> npm run regress -- snapshot --name personal-prod
# → .liushui/snapshots/personal-prod-<UTC时间>.jsonl

# 评估（默认写报告到 .liushui/reports/，摘要打到 stdout）
npm run regress -- run --snapshot .liushui/snapshots/personal-prod-….jsonl [--out <file>] [--baseline <report.json>]
```

- 退出码：0 无退化；1 有退化；2 用法、文件或连接错误。
- 报告头部记录快照的 `taken_at` 与行数、工作区的 git commit 与是否有未提交改动、`rebuildDerived` 返回的各派生数据版本、生成时间，便于事后对照“这份报告是哪份代码在哪份数据上跑的”。
- 与 `fts-rebuild.ts` 一样，错误消息中出现的 token 会被替换成 `***`；连接地址可以打印，凭据不打印。
- 选择放在 `scripts/` 而不是做成 `liushui regress` 子命令：这是维护者在仓库里执行的工具，需要工作区代码与数据库凭据；`liushui` CLI 面向日常读写，只持有本系统的 token。

### 7. Skill 与 `MAINTENANCE.md`

- SKILL.md：把“写一条 `retrieval_feedback`”改为用 `liushui feedback`，给出 v1 模板、补充记录模板、一个 heredoc/管道的例子；强调三点：`queries` 写**真实执行过的** SQL；`cause` 要写当场的调查结论（同义词？时间窗口太窄？内容里没有这个词？）；知道正确答案的 ID 就填上，不知道就留空，找到后再写补充记录。
- `MAINTENANCE.md`（仓库根目录）：一次维护的步骤与命令：(1) 用只读凭据导出快照；(2) 在当前 `main` 上 `run`，得到基线报告；(3) 阅读“待补充”与“无效”的反馈，必要时写补充记录并重新导出快照；(4) 按 `fail`/`partial` 用例的 `cause` 归类问题，提出改进；(5) 在候选代码上用**同一份快照**加 `--baseline` 重跑，确认有改善、无退化；(6) 走正常的 OpenSpec change 与部署流程；(7) 用 `liushui append --kind maintenance_log` 写一条维护记录（改了什么、为什么、回归前后的计数）。同时说明快照和报告含个人数据，只保存在本地。

## Risks / Trade-offs

- [快照是明文个人数据，落在本地磁盘] → 只用只读凭据导出；目录在 `.gitignore` 里；`MAINTENANCE.md` 写明用完可删；评估用的临时库在结束时删除。
- [反馈 JSON 会进入全文索引，键名（`intent`、`queries`、`sql`…）也会被索引，检索 `fts('sql')` 会命中所有反馈] → 影响有限，agent 可以加 `kind <> 'retrieval_feedback'` 过滤，skill 里会提到。如果反馈中的误命中成为问题，以后可以在切分时只索引 JSON 的值，这是派生数据规则的变化，重建即可。
- [用例的查询都是失败过的查询，基线时几乎全部为 `fail`，“无退化”的保护一开始很弱] → 这是预期的：随着维护修好的用例变成 `pass`，它们就成了防退化的护栏。`MAINTENANCE.md` 建议在修复后让 agent 再写一条反馈记录，把能成功的查询也记进去，作为正向用例。
- [CLI 的严格校验导致 agent 写反馈失败而放弃] → 错误信息给出字段路径和模板位置，退出码 2 与网络错误区分开；skill 里提供可直接套用的模板。
- [Worker 不校验，绕过 CLI 用 `liushui append --kind retrieval_feedback` 写入的反馈可能不合规] → 回归把它们列为“无效”并给出 ID，人工可以补写一条合规的反馈；skill 明确要求用 `liushui feedback`。
- [本地 libSQL 与 Turso 的行为差异（版本、FTS5 细节）导致本地评估结果与线上不一致] → 实施时在 dev 上对同一份数据比较一次本地评估与 `/sql` 的结果（任务里有专门的验证项）。
- [`rebuildDerived` 漏登记新的派生表，回归测不到它] → 在 `rebuildDerived` 的注释和 `MAINTENANCE.md` 里写明登记要求；以后新增派生数据的 change 在 tasks 中加一项检查。

## Migration Plan

1. 合并后，在每台使用 `liushui` 的机器上更新仓库（CLI 直接从仓库运行，无构建步骤），并重新安装 skill（复制安装的需要重新复制，软链接的不用）。
2. Worker、迁移、线上库都不变，不需要部署。
3. 回滚：回退仓库即可。已经写入的反馈记录照常保留，旧 CLI 不读取它们，不受影响。

## Open Questions

- 是否需要名次相关的指标（如期望 ID 的名次变差也算退化）：先只看状态，积累一些用例后在维护中再决定，不影响本 change 的报告格式（报告里已经包含名次）。
- 期望 ID 存在性是否要在写入时检查：先看实际产生的“无效”用例多不多，再决定是否在 `liushui feedback` 中加一次 `/sql` 预检。
