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
- 检索不好用时，用 `liushui feedback` 写一条结构化的 `retrieval_feedback` 记录（见下方「记录检索反馈」一节）。

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

-- 全文关键词（推荐用 fts()，见下面「全文检索」一节）
SELECT m.id, m.ts, m.content
FROM memories_fts JOIN memories m ON m.id = memories_fts.id
WHERE memories_fts MATCH fts('iOS 渲染') ORDER BY rank LIMIT 20;

-- 按作者
SELECT id, ts, content FROM memories WHERE author = 'will' ORDER BY ts DESC LIMIT 20;

-- 查询计划（服务端不包裹 LIMIT，用于排查慢查询）
EXPLAIN QUERY PLAN SELECT * FROM memories WHERE ts > '2026-01-01';
```

## 全文检索

`memories_fts(id, body)` 是 `memories.content` 的全文索引（派生数据，随追加同步更新）。检索时用 `fts('…')` 宏，agent 只写原文，不用关心分词：

```sql
SELECT m.id, m.ts, m.content
FROM memories_fts JOIN memories m ON m.id = memories_fts.id
WHERE memories_fts MATCH fts('渲染 问题')
ORDER BY rank
LIMIT 20;
```

宏的写法：

- 空格分隔的词表示**同时出现**；独立的大写 `OR` 表示**任一出现**，且同时出现优先于 `OR`：`fts('打包 报错 OR 阴影')` 即“（打包 且 报错）或 阴影”。
- 每个词按**连续出现**匹配：`fts('渲染问题')` 不会命中“渲染很慢，问题在别处”。
- 中文按相邻两个字切分，所以**两个字及以上**的中文词都能检索；英文不区分大小写，按词匹配（`ios` 能命中 `iOS`，但 `OS` 不能命中 `iOS`）。
- 宏只接受一个**字符串字面量**，不能写 `fts(?)` 或列名；文本里的引号、`*` 之类都当普通字符。
- **单个汉字或假名**（如 `fts('渲')`、`fts('iOS的')`）会被拒绝并提示改用 `LIKE`：单字检索和任意子串匹配请用 `content LIKE '%字%'`。

可以和其它条件自由组合：

```sql
SELECT m.id, m.ts, m.content
FROM memories_fts JOIN memories m ON m.id = memories_fts.id
WHERE memories_fts MATCH fts('打包 报错')
  AND m.kind = 'note'
  AND json_extract(m.meta, '$.git.branch') = 'main'
ORDER BY rank
LIMIT 20;
```

注意：

- 展示内容和片段一律取 `memories.content`；**不要读 `body`，也不要用 `snippet()` / `highlight()`**（`body` 是切分后的文本，读起来不自然）。
- 这是 bigram 匹配，偶尔会有误命中（两字片段跨词边界，如“作用”命中“合作用户”）；`ORDER BY rank` 会把更相关的排前面。
- 搜不到时，先换词或拆词，再用 `liushui feedback` 记录反馈。
- 直接手写 `MATCH '渲染问题'`（不用宏）会因为没切分而静默返回空，不要这样写。
- **反馈内容也会进入全文索引**：`retrieval_feedback` 记录的 `content` 也是一段文本，其字段与 SQL 会被索引。因此检索普通笔记时，必要时加上 `kind <> 'retrieval_feedback'` 过滤。

## 记录检索反馈 `liushui feedback`

当尝试了若干 SQL 依然未能查到想要的信息、或者经过人工/事后排查找到了真实期望命中的记忆 ID 时，使用 `liushui feedback` 写入结构化反馈。

命令接受一份反馈 JSON（直接传参或管道从标准输入 `-` 输入）：

```bash
# 管道/标准输入示例（推荐）：
cat << 'EOF' | liushui feedback -
{
  "v": 1,
  "intent": "查找上次 iOS 渲染问题是怎么排查解决的",
  "queries": [
    {
      "sql": "SELECT m.id, m.content FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts MATCH fts('iOS渲染') ORDER BY rank",
      "outcome": "0 行"
    },
    {
      "sql": "SELECT id, content FROM memories WHERE content LIKE '%渲染%'",
      "outcome": "3 行，但都是 Web 端渲染，不是 iOS"
    }
  ],
  "expected_ids": ["RYRP4645Q2VOLZ4DOVYPLUKVA4"],
  "cause": "原文写的是“Metal 着色器”，没有出现“渲染”二字：同义词问题"
}
EOF
```

### 反馈填写要点
1. **`queries` 写真实执行过的 SQL**：用例的查询必须是当时真实尝试过的查询与结果概要（`outcome`），这是回归有意义的前提。
2. **`cause` 写当场调查结论**：记录为什么没搜到（如同义词问题、时间过滤过窄、切分断词等）。
3. **期望 ID 可先留空**：若当时不知道正确记录的 ID，省略 `expected_ids` 字段即可（记为待补充反馈）。找到真实 ID 后，再写一条补充记录。

### 补充期望 ID
流水账不可改写，补充或更正期望 ID 通过一条引用原反馈的补充记录完成：

```bash
liushui feedback '{"v":1,"refines":"RYRP4645Q2VOLZ4DOVYPLUKVA4","expected_ids":["BCDEFGHJKMNPQRSTVWXYZ23456"],"note":"事后翻阅流水账找到了当时记录的真实 ID"}'
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
- **尚无 `embed()`**：语义检索（`embed('…')` 宏、向量索引）尚未实现，写 SQL 时不要假设它们可用。全文检索用 `fts()`，见上一节。

## 安装

把本目录复制或软链到 agent 的 skill 目录：

```bash
mkdir -p ~/.claude/skills
cp -r skills/liushui ~/.claude/skills/liushui
# 或
ln -s "$PWD/skills/liushui" ~/.claude/skills/liushui
```

命令本身需要机器上已配置好 `liushui`（参见仓库 README 的 CLI 配置一节）。
