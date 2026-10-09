# Design

## Context

动机见 proposal.md，需求见 `specs/memory-fts` 与 `specs/memory-query`。和本设计相关的现状：

- `memories` 以 `id TEXT PRIMARY KEY` 为主键，只有 `ts`、`kind` 两个索引。迁移由 `packages/core/migrations/*.sql` 与 `runMigrations` 幂等执行；Worker 单测的 `createTestContext()` 会对本地文件库跑全部迁移。
- `/append` 通过 `appendMemory(client, record)` 写入：一条 `INSERT … ON CONFLICT(id) DO NOTHING`，用 `rowsAffected` 判断是否为新写入。Worker 用 `@libsql/client/web` 和写凭据连库。
- `/sql` 的流程是 `checkReadOnlyStatement` → `wrapLimit` → 只读执行器（Hrana pipeline：`BEGIN TRANSACTION READONLY` → 语句 → `ROLLBACK`）。`core/src/query.ts` 的 `maskNonCode` 能把引号和注释里的内容遮掉，用来识别真正的代码区。
- 预研实测（本地 libSQL，SQLite 3.45.1，脚本不入库）：
  - `trigram`：2 个字的中文词 `MATCH` 返回空，不报错；`LIKE '%渲染%'` 能查到，但查询计划是全表扫描。
  - bigram 预切分 + `unicode61`：“渲染”“渲染问题”“iOS渲染”“阴影 OR 数据库”“打包 报错”“缺条目”“IL2CPP”“link.xml” 都按预期命中；单字“渲”查不到。
  - `client.batch([INSERT memories … ON CONFLICT DO NOTHING, INSERT INTO memories_fts … SELECT ?, ? WHERE changes() = 1], 'write')` 重放时不会重复写索引。
  - 以 `memories_fts.id = memories.id` 关联时，查询计划为 `SCAN f VIRTUAL TABLE INDEX 32:M2` + `SEARCH m USING COVERING INDEX sqlite_autoindex_memories_1 (id=?)`；包裹 `SELECT * FROM (… ORDER BY rank) LIMIT n` 后顺序保持不变。
  - **Turso dev 库实测（2026-10-09，任务 1.1，用 `spike_` 前缀的临时表，已删除）**：
    - FTS5 可用：`CREATE VIRTUAL TABLE … USING fts5(id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')` 成功，`MATCH … ORDER BY rank` 返回预期结果。
    - `@libsql/client/web` 的 `batch([INSERT … ON CONFLICT DO NOTHING, INSERT … SELECT ?, ? WHERE changes() = 1], 'write')`：首次 `rowsAffected` 为 1，重放为 0，索引里该 `id` 仍只有 1 条；第二条语句失败（索引表不存在）时整个 batch 回滚，`memories` 一侧没有新增。
    - 只读 token 经 Worker 的 Hrana 执行器（`BEGIN TRANSACTION READONLY` → 语句 → `ROLLBACK`）可以执行 `MATCH`；同一个只读执行器的写语句被拒绝。
    - `rows_read`（304 行数据）：`MATCH`（经 `JOIN` 关联）为 **2**，同样结果的 `LIKE '%渲染%'` 为 **304**（全表扫描）。
    - `client.transaction('write')` 交互式事务可用：提交的写入可见，回滚的写入不可见。

## Goals / Non-Goals

**Goals:**
- 中文两字词可检索，并按相关度排序；agent 只写原文，不感知分词。
- 切分规则只有一份实现（core），索引端与查询端共用，维护时可以整体替换规则并重建索引。
- 索引与流水账强一致（同一个事务），并且任何时候都能从流水账重建、核对。
- `/append`、`/sql` 的请求与响应形状不变。

**Non-Goals:**
- 不做词典分词、繁简转换、同义词扩展、拼音检索。这些都是维护阶段根据反馈记忆再决定的“进化”手段。
- 不做相关度调参（`bm25` 权重等），不做跨库检索。
- 不在 Worker 运行时自动检测或修复索引缺失；只靠重建脚本和一致性检查。
- 不支持 FTS5 的列过滤、`NEAR`、前缀查询等高级语法（agent 仍可以绕过宏直接写 `MATCH`，但要自行负责切分，skill 里不推荐）。

## Decisions

### 1. 自己切分 bigram，FTS5 用 `unicode61`，不用 `trigram`

切分规则（`segment(text)`，放在 core 的纯函数模块里）：

- **中日文字符**：Unicode Script 为 Han、Hiragana、Katakana 的字符，再加上长音符 `ー`（U+30FC，Script=Common，不加的话 “サーバー” 会被拆碎）。连续的中日文字符构成一段（run）。
- 长度 ≥ 2 的 run 输出相互重叠的二字单元（“渲染问题” → `渲染 染问 问题`）；**长度为 1 的 run 不输出任何单元**。
- 其它字符原样保留，在中日文 run 的两侧插入空格作分界，交给 `unicode61 remove_diacritics 2` 分词（不区分大小写、去掉变音符，标点作分隔）。
- 规则带版本号 `FTS_SEGMENTER_V = 1`，规则有任何变化都要升版本。

理由：

- `trigram` 对两字词静默返回空，而这正是中文最常见的词长（见 Context 实测）。
- bigram 能命中任意 ≥2 字的子串，而且短语查询（连续出现）保证了多字词的精度：“渲染问题”不会命中“渲染很慢，问题在别处”。
- 长度为 1 的 run 不进索引，是为了让索引端和查询端**对任何输入都切分一致**：如果索引里保留单字，查询 “iOS的” 会得到 `iOS 的`，而文档 “iOS的渲染” 的切分结果是 `iOS 的渲 渲染`，两边对不上就会静默漏命中。干脆在查询端把单字判为错误（Decision 4），提示改用 `LIKE`。
- 备选：词典分词（jieba 等）。放弃，原因有三：Worker 的包体积与 CPU 限制；词典变化会改变切分结果，需要重建；而且分词错误会造成漏召回。以后有反馈记忆证明 bigram 不够用时，可以在维护中替换规则（升 `FTS_SEGMENTER_V` 再重建），agent 的写法不变。
- 备选：`trigram` 加 `LIKE` 兜底。按用户决定放弃。

### 2. 索引表结构：普通 FTS5 表，按 `id` 关联

迁移 `0002_fts.sql`：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS derived_state (
  name       TEXT    PRIMARY KEY NOT NULL,   -- 'memories_fts'
  version    INTEGER NOT NULL,               -- 重建时的 FTS_SEGMENTER_V
  built_at   TEXT    NOT NULL,
  rows       INTEGER NOT NULL
);
```

- **按 `id` 关联而不是按 rowid 关联**：`memories` 没有 `INTEGER PRIMARY KEY`，它的隐式 rowid 在 `VACUUM` 后可能被重新编号，而托管的 Turso 何时整理文件不由我们控制。按 `id` 关联时，`memories` 一侧走主键索引（见 Context 的查询计划），代价可以忽略。
- **普通表，不用外部内容表或无内容表**：外部内容表（`content='memories'`）要求按 rowid 对齐，排除；无内容表的删除依赖 `contentless_delete`（SQLite 3.43+），Turso 是否支持未知，而且重建时只需要 `DELETE FROM memories_fts`。代价是 `body` 多存一份切分后的文本，按当前数据量可以忽略。
- `body` 存的是切分后的文本，不适合给人看。skill 里说明：展示内容和片段一律取 `memories.content`，不使用 `snippet()` / `highlight()`。
- `derived_state` 是通用的派生数据状态表，以后的向量索引等也登记在这里。它本身也是派生数据，重建时一并改写。
- 迁移只新增表，符合“迁移只允许新增列或表”的约定；`schema_v`（记录的 schema 版本）不变，因为记录本身没有变化。

### 3. 追加：在同一个写事务里写记录和索引

> 已在 Turso dev 库实测（见 Context）：`changes()` 在 Hrana batch 里语义与本地一致，下面的方案成立，不需要 `RETURNING` 备选。

`appendMemory` 改为：

```ts
client.batch([
  { sql: INSERT_SQL /* ON CONFLICT(id) DO NOTHING */, args: [...] },
  { sql: 'INSERT INTO memories_fts (id, body) SELECT ?, ? WHERE changes() = 1', args: [id, segment(content)] },
], 'write');
```

- `batch(…, 'write')` 在一个事务里执行，满足 spec「追加时同事务维护索引」。幂等命中时第一条语句改动 0 行，`changes()` 返回 0，于是不写索引。是否为新写入仍以第一条语句的 `rowsAffected` 判断。
- 索引表不存在或写入失败时整个 batch 回滚，`/append` 和原来一样返回 `storage_unavailable`（503）。CLI 会重试，但重试也会失败；这是部署顺序错误，靠 Migration Plan 避免（见 Risks）。
- 备选：用 SQL 触发器自动维护。放弃，因为触发器只能用 SQL，没法调用 `segment()`。
- 备选：用 `NOT EXISTS (SELECT 1 FROM memories_fts WHERE id = ?)` 判断是否已有索引条目。放弃，因为 `id UNINDEXED` 上的查找需要扫描整个索引表。

### 4. 查询宏 `fts('…')`：在 core 里做文本展开

`expandFtsMacros(statement): string`，放在 core 的纯函数模块里。Worker 在 `checkReadOnlyStatement` 之后、`wrapLimit` 之前调用它。

- **定位**：在 `maskNonCode` 得到的代码掩码上找 `\bfts\s*\(`（不区分大小写），所以字符串和注释里的 `fts(` 不会被展开。然后在原文上从 `(` 之后解析：可选空白、一个单引号字符串字面量（`''` 表示转义的单引号）、可选空白、`)`。其它任何形式（`?`、`:name`、列名、多个参数、拼接）都报 `invalid_field`（field 为 `sql`）。
- **表达式**：按 Unicode 空白切分出词；大写 `OR` 单独成词时作为运算符，出现在开头、结尾或连续出现都报错。用 `OR` 把词分组，组内每个词经 `segment()` 后变成一个短语 `"t1 t2 …"`（`"` 转义成 `""`），组内用空格连接（FTS5 的隐式 AND），组与组之间用 ` OR ` 连接，每组都加括号：`("打包" "报错") OR ("阴影")`。显式加括号，避免依赖 FTS5 的运算符优先级。
- **逐词校验**：词里含有长度为 1 的中日文 run 时报错，并提示“单字检索请改用 LIKE '%字%'”。词里不含任何字母或数字（`\p{L}`、`\p{N}`）时也报错。
- **输出**：整个宏调用替换成一个 SQL 字符串字面量（`'` 转义成 `''`）。替换不会改变 `?` 参数的个数和位置。
- 因为 Decision 1 的切分对任何输入都一致，查询短语的切分单元序列一定是文档切分单元序列的连续子串，所以“短语命中”与“原文子串包含”在中日文 run 上是等价的。
- 备选：注册 SQL 自定义函数。远程 Turso 上无法注册，排除。
- 备选：支持 `fts(?)`。需要按占位符的位置改写 `args`，还要兼顾 `?NNN` 和 `:name`，复杂度不划算；agent 拼一个字面量也不难。按 proposal，本 change 不做。
- 这套“在代码区定位宏、解析字面量参数、替换”的机制，以后 `embed('…')` 可以直接复用。

### 5. 重建与一致性检查：`scripts/fts-rebuild.ts`

> 已在 Turso dev 库实测（见 Context）：交互式写事务 `client.transaction('write')` 可用。

- 用法：`TURSO_URL=… TURSO_AUTH_TOKEN=… npm run fts:rebuild [-- --check]`。凭据的处理与 `scripts/migrate.ts` 相同（只从环境变量读，绝不打印）。逻辑放在 core 的存储函数里（`rebuildFts(client)`、`checkFts(client)`），脚本只负责解析参数和输出，便于单测。
- **重建**：在**一个交互式写事务**（`client.transaction('write')`）里执行 `DELETE FROM memories_fts`，然后按 `id` 分页（每页 500 条）读取 `memories` 并批量插入切分结果，最后 upsert `derived_state('memories_fts', FTS_SEGMENTER_V, now, rows)` 并提交。事务期间并发的 `/append` 会等待或失败重试，不会产生重复或遗漏。当前数据量下事务持续时间在秒级；10^5 条以上时再考虑分段方案（见 Open Questions）。
- **检查**（只读）：
  - 缺失数：`SELECT COUNT(*) FROM (SELECT id FROM memories EXCEPT SELECT id FROM memories_fts)`
  - 多余数：反过来的 `EXCEPT`
  - 重复数：`SELECT COUNT(*) - COUNT(DISTINCT id) FROM memories_fts`
  - 版本：`derived_state` 里记录的版本与 `FTS_SEGMENTER_V` 比较；没有记录时报“从未重建”
  
  用 `EXCEPT` 而不是 `NOT EXISTS`，是为了避免在 `id UNINDEXED` 上做嵌套扫描。只要有一项不一致，脚本就以非 0 退出码退出，便于部署时验证。

### 6. 错误与版本

- 宏的所有错误都是 `invalid_field`（400，client，field 为 `sql`），消息说明具体原因。不新增错误码，CLI 已经能处理这个错误（不重试，原样输出消息）。
- FTS5 自身的语法错误（只会在 agent 不用宏、直接手写 `MATCH` 时出现）沿用现有的 `sql_error` 映射。
- `SERVICE_VERSION` 升到 `0.3.0(-dev)`。CLI 代码不改，`CLI_VERSION` 不变。

### 7. Skill 更新

SKILL.md 新增「全文检索」一节：

- `memories_fts(id, body)` 表，以及推荐模板 `SELECT m.id, m.ts, m.content FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH fts('…') ORDER BY rank LIMIT 20`；
- 和 `ts`、`kind`、`json_extract(meta, …)` 组合使用的示例；
- 宏的语法（空格表示同时出现，`OR` 表示或，每个词按连续出现匹配）；
- 单字检索和需要任意子串匹配时用 `LIKE`；
- 不要读 `body`，也不要用 `snippet()`；
- 搜不到时，先换词或拆词，再按反馈记忆规范记一条 `retrieval_feedback`。

同时删除「陷阱」一节里“尚无 FTS”的说法。

## Risks / Trade-offs

- [部署顺序错误：Worker 先于迁移上线，`/append` 在没有 `memories_fts` 的库上返回 503] → Migration Plan 规定“先迁移、再部署、后重建”；每个库迁移后用 `--check` 确认表存在。回滚 Worker 不需要回滚迁移（旧代码忽略新表）。
- [迁移后、新 Worker 上线前写入的记录没有索引] → 部署后执行一次重建，再用 `--check` 确认缺失数为 0。
- [Turso 不支持 FTS5，或 Hrana batch 中 `changes()` 的语义与本地不同] → 任务 1 已在 dev 上实测，结论成立（见 Context）。如果以后 `changes()` 的行为变化，改为在同一事务里先 `INSERT … RETURNING id`，再根据返回的行决定是否写索引（需要交互式事务），并把结论写回 Decision 3。
- [bigram 召回过宽：两字片段跨越词边界，例如 “作用” 会命中 “合作用户”] → 这是 bigram 的固有代价；`bm25` 排序会把完整命中排在前面。真实使用里的误命中由反馈记忆收集，维护时决定是否换规则。
- [索引大小和写入行数增加，每条记录多写一个 FTS 条目及其 shadow 表] → 按当前数据量远低于免费额度；任务 1 记录一次 `MATCH` 和一次 `LIKE` 的 `rows_read` 作为基线。
- [agent 不用宏、直接手写 `MATCH '渲染问题'`，会因为切分对不上而静默返回空] → skill 只教宏的写法；无法从服务端阻止，因为直接 `MATCH` 仍然是合法的只读查询。
- [重建事务期间 `/append` 被阻塞] → 当前数据量下只有秒级；CLI 会自动重试 503。

## Migration Plan

1. dev：对 `liushui-{personal,work}-dev` 执行 `npm run migrate`（应用 `0002_fts`）。
2. 部署 Worker `0.3.0-dev`，用 `/health` 确认版本。
3. 对每个 dev 库执行 `npm run fts:rebuild`，然后执行 `npm run fts:rebuild -- --check`，确认缺失、多余、重复都为 0，版本一致。
4. dev 冒烟：`append` 一条含两字中文词的记忆后，用 `fts()` 立即查回；单字查询返回参数错误；`/append` 幂等重放后索引条目数不变；记录一次 `rows_read`。
5. prod：重复 1–4，并用 `fts()` 查回 prod 中已有的真实记忆。
6. 回滚：重新部署 `0.2.0`。`memories_fts` 和 `derived_state` 对旧代码无害，可以保留；再次上线新版本后重新执行一次重建即可补齐。

## Open Questions

- 重建时单个事务能承受的数据量上限：当前是数十到数百条，暂不处理；超过约 10^5 条时，改为“在影子表里重建，再原子切换”。这不影响 spec。
- bigram 在真实数据上的误命中率：用反馈记忆收集，维护时评估。这不影响本 change 的契约。
