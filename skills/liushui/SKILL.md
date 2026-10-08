---
name: liushui
description: 读写用户的 liushui 记忆流水账（只追加）。当用户想记住某事、查回以前写过的记忆、或需要按时间/meta 检索历史时使用。命令为 `liushui append` 与 `liushui sql`。
---

# liushui 记忆流水账

`liushui` 是一个**只追加**的个人记忆系统：每条记忆写一次、永不改写，查询走只读 SQL。
本 skill 说明何时写、何时查，以及 `memories` 表的用法。

## 何时写、何时查

- **写**（`liushui append "…"`）：用户明确说“记住这个”“记下来”，或发生了值得留档的事（决定、修复、踩坑、上下文）。写入是幂等的，重复提交同一条不会产生副本。
- **查**（`liushui sql "SELECT …"`）：需要回忆以前的决定/修复/上下文时先查，再依靠记忆回答；不要凭印象编造。
- 检索不好用时，按 `DESIGN.md` 的反馈记忆规范写一条 `kind = retrieval_feedback` 的记忆（先用 `append`）。

## `memories` 表

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | 全局稳定 ID（由 `ts`/`author`/`kind`/`content` 算出，与库和 meta 无关） |
| `ts` | TEXT | 记忆时间（客户端提供，ISO 8601，**排序以此为准**） |
| `author` | TEXT | 作者（人或多个 agent） |
| `kind` | TEXT | `note` / `image` / `retrieval_feedback` / `maintenance_log` … |
| `content` | TEXT | 正文 |
| `meta` | TEXT | JSON 文本（嵌套对象），如 `{"git":{"branch":"main"}}` |
| `received_at` | TEXT | 服务端接收时刻（旁证，**不保证 `received_at >= ts`**，客户钟可能超前） |
| `schema_v` | INTEGER | 写入时的 schema 版本 |

索引只有 `idx_memories_ts (ts)` 与 `idx_memories_kind (kind)`。没有 `vault` 列——每个库是独立的数据库，token 决定能连哪个库，因而查询天然单库。

## `meta` 与 `json_extract`

`meta` 是 JSON 文本，用 `json_extract` 读取嵌套字段：

```sql
SELECT id, ts, content
FROM memories
WHERE json_extract(meta, '$.git.branch') = 'main'
ORDER BY ts DESC
LIMIT 20;
```

新增 meta 键无需迁移；字段采集不到时会被省略（不是空串）。

## 常用查询模板

```sql
-- 最近若干条
SELECT id, ts, kind, content FROM memories ORDER BY ts DESC LIMIT 20;

-- 按 kind
SELECT id, ts, content FROM memories WHERE kind = 'maintenance_log' ORDER BY ts DESC LIMIT 20;

-- 全文关键词（尚无 FTS，用 LIKE 粗筛）
SELECT id, ts, content FROM memories WHERE content LIKE '%iOS%渲染%' ORDER BY ts DESC LIMIT 20;

-- 按作者
SELECT id, ts, content FROM memories WHERE author = 'will' ORDER BY ts DESC LIMIT 20;

-- 查询计划（服务端不包裹 LIMIT，用于排查慢查询）
EXPLAIN QUERY PLAN SELECT * FROM memories WHERE ts > '2026-01-01';
```

## 查询命令与输出

```bash
liushui sql "SELECT id, kind, ts FROM memories ORDER BY ts DESC LIMIT 5"
liushui sql --json "SELECT json_extract(meta, '$.git.branch') AS branch FROM memories LIMIT 5"
echo "SELECT COUNT(*) AS n FROM memories" | liushui sql -
liushui sql --arg note "SELECT id FROM memories WHERE kind = ? ORDER BY ts"
```

- 只接受**单条只读语句**：`SELECT`、`WITH … SELECT`、`EXPLAIN QUERY PLAN`。写语句、DDL、`PRAGMA`、多条语句一律被拒。
- 一次只查一个库（`--vault` 至多一个，省略时用默认库）。
- 默认输出带表头的 TSV；`--json` 为 JSONL。单元格内的制表符/换行/反斜杠会转义，NULL 为 `\N`。
- `--limit` 默认 50、`--max-width` 默认 200。**截断提示只写 stderr**：行数到上限会说“结果已截断”，单元格被截断会说“N 个单元格被截断”。看到提示时不要以为拿到了全部数据，可缩小范围或分页。
- 服务端还会把超长单元格截断到 2000 字符，响应里用 `truncated.cells` 计数。

## 陷阱

- **重名列会被改名**：服务端用 `SELECT * FROM (<你的 SQL>) LIMIT n+1` 包裹来限行数，重名列在子查询里会变成 `id:1`、`id:2`。需要稳定列名时自己起别名：`SELECT m.id AS mid, v.id AS vid …`。
- **别用 `received_at` 排序**：时钟可能偏差，排序用 `ts`；`received_at` 只作旁证。
- **尚无 FTS 与 `embed()`**：全文检索目前只能用 `LIKE`；语义检索（`embed('…')` 宏、向量索引）尚未实现，写 SQL 时不要假设它们可用。中文分词方案会另起 change 评估。

## 安装

把本目录复制或软链到 agent 的 skill 目录：

```bash
mkdir -p ~/.claude/skills
cp -r skills/liushui ~/.claude/skills/liushui
# 或
ln -s "$PWD/skills/liushui" ~/.claude/skills/liushui
```

命令本身需要机器上已配置好 `liushui`（参见仓库 README 的 CLI 配置一节）。
