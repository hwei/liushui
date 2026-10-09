# Tasks

## 1. Spike：Turso 上的 FTS5 与同事务写入

- [x] 1.1 在 dev 的 Turso 上实测（临时库或 dev 库中的临时表，结束后删除）：(a) `CREATE VIRTUAL TABLE … USING fts5(id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')` 能否创建，`MATCH` / `ORDER BY rank` 能否执行；(b) 用 `@libsql/client/web` 的 `batch([INSERT … ON CONFLICT DO NOTHING, INSERT … SELECT ?, ? WHERE changes() = 1], 'write')` 重放时不会重复写索引；(c) 用只读 token 在 Hrana pipeline 的 `BEGIN TRANSACTION READONLY` 中执行 `MATCH`；(d) 同一数据上一次 `MATCH` 与一次 `LIKE '%…%'` 的 `rows_read`；(e) `client.transaction('write')` 交互式事务可用。验证：结论与实测数据写回 design 的 Context 与 Decision 3/5，不再有“尚未在 Turso 上验证”的表述；若 (b) 不成立，按 Risks 中的备选方案改写 Decision 3

## 2. core：切分与宏展开

- [x] 2.1 新增 `packages/core/src/fts.ts`：`FTS_SEGMENTER_V = 1` 与 `segment(text)`（Han/Hiragana/Katakana 加 `ー` 组成 run，长度 ≥2 的 run 输出重叠二字单元，长度为 1 的 run 不输出，run 两侧插入分界，其它文字原样保留），并从 `index.ts` 导出。验证：单测覆盖纯中文、中英混写（`iOS渲染问题`）、日文（`ログを確認した`、`サーバー`）、标点、单字 run、空串，以及对同一输入切分结果的确定性
- [x] 2.2 实现 `expandFtsMacros(statement)`：基于 `maskNonCode` 的代码区定位（不区分大小写）、单引号字面量解析（含 `''`）、按空白切词与 `OR` 分组、短语与 `"` 转义、组加括号、结果作为 SQL 字面量替换；错误一律抛 `ValidationError('invalid_field', …, 'sql')`。验证：单测覆盖 memory-query spec「全文检索宏的语义」「全文检索宏的参数限制」的展开结果与全部错误情形（`?`、列名、空、只有 `OR`、开头/结尾/连续的 `OR`、单字、`iOS的`、纯标点），字符串和注释里的 `fts(` 不展开，`?` 参数个数不变
- [x] 2.3 用本地文件库做切分一致性测试：用若干中日英混合文档建索引，对每个文档随机取 ≥2 字的中日文子串，经 `expandFtsMacros` 检索都能命中该文档。验证：测试通过，覆盖 memory-fts spec「中日文切分规则」的全部 Scenario

## 3. core：迁移、追加与重建

- [x] 3.1 新增迁移 `packages/core/migrations/0002_fts.sql`（`memories_fts` 与 `derived_state`，按 design Decision 2）。验证：`storage.test.ts` 断言重复执行迁移幂等，`schema_migrations` 含版本 2，`memories` 的数据不变
- [x] 3.2 `appendMemory` 改为 design Decision 3 的同事务 batch（按 1.1 的结论）。验证：单测覆盖新记录立即可检索、重复追加索引条目数不变（`created:false`）、删除 `memories_fts` 后追加抛错且 `memories` 无新增
- [x] 3.3 新增存储函数 `rebuildFts(client)` 与 `checkFts(client)`（design Decision 5：交互式写事务、按 `id` 分页、upsert `derived_state`；检查返回缺失、多余、重复与版本状态）。验证：单测覆盖 memory-fts spec「整体重建」「一致性检查」「派生全文索引」的全部 Scenario（用绕过 append 的 `seedMemories` 造缺失；改写 `derived_state.version` 模拟版本过期；重建前后逐字段比较 `memories`）
- [x] 3.4 新增 `scripts/fts-rebuild.ts` 与 npm script `fts:rebuild`（`--check` 只读；任一项不一致时退出码非 0；凭据只从环境变量读，绝不打印）。验证：对本地文件库或本地 sqld 运行重建与检查，输出与退出码符合预期，输出中不含 token

## 4. Worker

- [x] 4.1 `/sql` 在 `checkReadOnlyStatement` 之后、`wrapLimit` 之前调用 `expandFtsMacros`；`/append` 使用新的 `appendMemory`。验证：`sql.test.ts` 覆盖 memory-query spec「全文检索宏」各 Scenario（含 `EXPLAIN QUERY PLAN` 中也展开，以及参数错误时执行器从未被调用）；`append.test.ts` 覆盖 memory-fts spec「追加时同事务维护索引」各 Scenario，并断言索引写入失败时返回 503 `storage_unavailable`
- [x] 4.2 两库隔离：`isolation.test.ts` 补用例，验证个人库 token 的 `fts()` 检索只命中个人库的记录。验证：测试通过
- [x] 4.3 `wrangler.toml` 的 `SERVICE_VERSION` 升到 `0.3.0(-dev)`；`test:worker-integration` 增加端到端用例：本地 sqld 迁移后 append 一条中文记忆，再用 `fts()` 经 Hrana 只读执行器查回。验证：`npm run test:worker-integration` 通过

## 5. Skill 与文档

- [x] 5.1 更新 `skills/liushui/SKILL.md`（design Decision 7），删除“尚无 FTS”的说法。验证：skill 中每条 FTS 示例 SQL 在本地 worker-harness 上经 `liushui sql` 执行成功，单字示例返回带 `LIKE` 提示的错误
- [x] 5.2 `docs/deploy.md` 增补“先迁移、再部署、后重建”的顺序、`fts:rebuild` 与 `--check` 的用法、503 排障条目（索引表缺失）；README 补充 `fts:rebuild` 与全文检索示例；`DESIGN.md` 的「接口」一节标注 FTS 已实现（bigram 加 `fts()` 宏），并记下“派生数据状态登记在 `derived_state`”。验证：文档与 design 的 Migration Plan 一致，没有互相矛盾的表述

## 6. 部署与综合验证

- [x] 6.1 dev：按 design Migration Plan 的 1–4 执行（迁移、部署 `0.3.0-dev`、重建、`--check` 全部为 0、冒烟）。验证：逐项命令输出记录在本任务说明中，包括一次 `fts()` 查询的 `rows_read`。实测记录（2026-10-09，只做个人库 `liushui-personal-dev`，按用户决定不迁移公司库）：① `npm run migrate` → `已应用迁移：2（共 2 个）。`，再次执行 → `schema 已是最新`；迁移后 `--check` 为 memories 8 / 索引 0 / 缺失 8、退出码 1。② `wrangler deploy --env dev`（Version ID 53b28bca-2200-4241-8e26-17a4954abd27），`/health` → `{"ok":true,"version":"0.3.0-dev"}`。③ `npm run fts:rebuild` → `已重建全文索引：8 条（切分版本 1）`；`--check` → 缺失 0 / 多余 0 / 重复 0 / 版本一致、退出码 0。④ 冒烟：`liushui append` 写入 id `RYRP4645Q2VOLZ4DOVYPLUKVA4`；`fts('渲染')` 立即命中该 id，`stats.rows_read` = 2；`fts('渲')` → 400 `invalid_field` 且提示 LIKE；用同一条记录的字段重放 `/append` → 200 `created:false`，该 id 的索引条目数前后均为 1；memories 与 memories_fts 总数均为 9
- [x] 6.2 prod：按 Migration Plan 的第 5 步执行，并用 `fts()` 查回 prod 中已有的真实记忆（至少一条两字中文词检索）。验证：记录已知 id 被命中，`--check` 全部为 0。实测记录（2026-10-09，只做个人库 `liushui-personal-prod`；迁移、部署、重建由用户在会话中用 `!` 执行，权限分类器拦截了自动执行的 prod 迁移）：① `node scripts/migrate.ts` → `已应用迁移：2（共 2 个）。`② `wrangler deploy --env prod`（Version ID c85f5144-38a8-4618-87e6-da0b77782d26），`/health` → `{"ok":true,"version":"0.3.0"}`。③ `fts-rebuild` → `已重建全文索引：9 条（切分版本 1）`；`--check` → memories 9 / 索引 9，缺失 0 / 多余 0 / 重复 0，版本一致，检查通过。④ 只读查回 prod 已有的真实记忆（不写入）：`fts('定案')` → GUCQVDRG7OSC3FJNN27ZC5BQEM，`fts('代理')` → DH2UWRAQESXW4MDP4VPIRMWNAU，`fts('时钟')` → BWHEYPP5K2GGBUHYCGANEZLTR4，`fts('冒烟')` → XP6QTDV7EU4F5TJADWTTOL5RBI，均各命中 1 条且为预期记忆，`rows_read` 均为 2；`fts('渲')` → 400 `invalid_field` 且提示 LIKE；memories 与 memories_fts 总数均为 9
- [x] 6.3 全量回归：`npm test`、`npm run lint`、`npm run typecheck`、`npm run test:worker-integration`。验证：四项全部通过，测试数不少于上个 change 的基线。结果（本地）：`npm test` 22 个文件 263 个测试通过（上个 change 基线 232）；`npm run lint`、`npm run typecheck` 通过；`node --test packages/worker/integration/wrangler-local.test.ts` 通过（wrangler + 本地 sqld，迁移 [1,2]，含 append 中文记忆后经 Hrana 只读执行器用 `fts('渲染')` 查回）
- [x] 6.4 对照 memory-fts 与 memory-query 两个 delta spec 的全部 Scenario，逐条核对测试与真实环境结果。验证：每个 Scenario 都能对应到一个测试或一条真实环境记录，映射写在本任务说明中。映射（本地测试；dev/prod 的真实环境记录见 6.1/6.2）：memory-fts「索引可与流水账关联」→ `fts-storage.test.ts` 新记录立即可检索 + `isolation.test.ts`；「重建不改变流水账」→ `fts-storage.test.ts` 重复重建；「两字中文词」「多字短语」「中英文混写」「日文假名」→ `fts-storage.test.ts` 切分一致性（spec 场景、子串遍历、短语）；「新记录立即可检索」「重复追加不产生重复索引」「索引不可写时追加整体失败」→ `append.test.ts`（含 503）+ `fts-storage.test.ts`；「为已有记录补建索引」「重复重建结果相同」「发现缺失条目」「发现切分版本过期」→ `fts-storage.test.ts`；memory-query「用宏做全文检索」「字符串和注释里的宏不展开」「引号与运算符不破坏表达式」「多个词同时出现」「OR」「同时出现优先于 OR」→ `sql.test.ts` 全文检索宏 + `fts.test.ts`；「单个汉字」「词中夹带单字」「非字面量参数」「空文本」→ `sql.test.ts`（含执行器从未被调用）+ `fts.test.ts`

## Workflow follow-up

- 评审通过后归档本 change，把新增的 `memory-fts` 与 `memory-query` 的新增要求同步到 `openspec/specs/`。
- 下一个候选 change：`feedback-minimal`（结构化反馈记忆加回归测试集，可以直接用 `fts()` 查询作为回归用例），并起草 `MAINTENANCE.md` 的第一版。
