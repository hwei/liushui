# Proposal

## Why

`liushui sql` 上线后，agent 只能用 `LIKE '%…%'` 做关键词检索：没有相关度排序，多个关键词只能手写多段 `LIKE`，而且每次都扫全表。DESIGN.md 的终极目标是“优化记忆检索”，而全文检索是第一块基础，后面的反馈记忆回归集和向量检索都要建立在它上面。`sql-query` 归档时已把 FTS（含中文分词评估）定为下一个候选。

中文分词已在本地 libSQL（SQLite 3.45.1）上实测过：FTS5 自带的 `trigram` 分词器对 3 个字及以上的词效果很好，但**对 2 个字的中文词用 `MATCH` 查会静默返回空结果**（例如“渲染”，`"渲染" OR "阴影"` 也一样），只能退回 `LIKE` 全表扫描。中文里常用词大多是两个字，agent 很容易踩到“搜不到就以为没有”这个坑。所以本 change 采用**自己切分的 bigram 分词**，并提供 `fts('…')` 查询宏：索引和查询用同一套切分规则，agent 只写原文，不需要关心分词细节。

## What Changes

- **派生全文索引**：新增派生表 `memories_fts`（FTS5，`unicode61` 分词器，内容是切分后的文本，用 `id` 关联 `memories`）。它和其它派生数据一样，可以随时整表删除重建，流水账本身不变。
- **切分规则放在 core**：连续的中日文汉字/假名切成相互重叠的 bigram（单独的一个字不进索引）；其它文字原样交给 `unicode61` 处理。规则带一个版本号（`FTS_SEGMENTER_V`），以后维护时可以换规则并整体重建索引。
- **追加时同事务写索引**：`/append` 在同一个写事务里写入 `memories` 和 `memories_fts`；幂等命中（记录已存在）时不重复写索引。
- **重建脚本**：新增 `scripts/fts-rebuild.ts`，从 `memories` 整体重建索引，同时提供只读的一致性检查（报告缺失、多余的索引行和切分版本）。它也用来给已有记录补建索引。
- **查询宏 `fts('…')`**：`/sql` 在语句检查之后、包裹 LIMIT 之前，把代码区里的 `fts('<字符串字面量>')` 展开成 FTS5 `MATCH` 表达式的字符串字面量。宏的语法：空白分隔的词表示同时出现（AND），独立的 `OR` 表示或，每个词按切分规则展开成短语（要求连续出现）。宏只接受一个字符串字面量参数；参数为空、词里有单独的一个汉字或假名、或参数不是字面量时，返回参数错误，而不是静默返回空结果。
- **Skill 与文档**：SKILL.md 补充 `memories_fts` 表、`fts()` 宏、按 `rank` 排序的模板，以及“单字和需要子串匹配时用 `LIKE`”的说明；README、DESIGN.md、`docs/deploy.md` 补充迁移、部署、重建的顺序。

**不做**：`liushui search` 便捷命令（按用户决定，只扩展 SQL）；`embed()` 与向量检索；`fts()` 宏接受 `?` 绑定参数；繁简转换、同义词、词典分词；`snippet()` / `highlight()`（索引里存的是切分后的文本，片段读起来不自然，片段一律取自 `memories.content`）；Hangul 的特殊处理（韩文有空格分词，交给 `unicode61`）。

## Capabilities

### New Capabilities
- `memory-fts`: 记忆的派生全文索引，包括索引内容与切分规则、追加时的同事务维护与幂等、整体重建与一致性检查，以及切分规则的版本标记。

### Modified Capabilities
- `memory-query`: 新增「全文检索宏」要求，规定 `fts('…')` 的展开语义（AND / OR / 短语）、参数限制与错误，以及宏只在代码区展开（字符串和注释里的 `fts(` 不展开）。

## Impact

- **代码**：
  - `packages/core`：新增切分与宏展开的纯函数模块（例如 `src/fts.ts`）；`storage/append.ts` 改为在一个写事务里同时写 `memories` 和 `memories_fts`；新增重建与一致性检查的存储函数；新增迁移 `0002_fts.sql`。
  - `packages/worker`：`/sql` 处理流程里加入宏展开；`/append` 走新的追加函数（行为契约不变）。
  - `scripts/fts-rebuild.ts` 与对应的 npm script。
- **API**：`/append`、`/sql` 的请求与响应形状不变；`/sql` 多了一个宏，并多了一种参数错误。版本升到 `0.3.0`。
- **依赖**：不新增依赖。
- **线上**：每个 dev/prod 库都要按「迁移 → 部署 Worker → 重建索引」的顺序执行；顺序反了会让 `/append` 在没有索引表的库上返回 503（见 design 的 Risks）。还要在 dev 的 Turso 上先确认 FTS5 可用。
- **存储**：索引大约是 `content` 的 2 到 3 倍，按当前数据量可以忽略；`rows_read` 的变化在 spike 中实测。
