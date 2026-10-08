# 自进化记忆系统 — 设计文档

供人和 agent 共用的个人记忆系统。终极目标不是结构化记忆，而是**优化记忆检索**；结构化、摘要、遗忘规则等都只是可选手段，不提前假设。

## 核心原则

1. **流水账是唯一事实来源**：只追加、永不改写。支持文本、图片等多种内容。
2. **派生数据可整体重建**：索引、向量、摘要、结构化表都放在派生表中，可随时删除重建、回滚。
3. **多库归属**：人和他的多个 agent 的流水账可放同一个库；同一条记忆可提交到多个库（如个人库 + 公司库）。
4. **检索失败也是记忆**：agent 发现检索不好用时，写一条反馈记忆。
5. **人发起的定期维护**：不做运行时自动进化。人定期按 `MAINTENANCE.md` 流程，根据反馈记忆改进系统源码并部署。
6. 只有基础部分适合公开共用，进化出的部分是高度个人化的。

## 架构（serverless，目标免费长期运行）

| 部分 | 选型 |
|---|---|
| API | Cloudflare Workers（纯 Web API + token 鉴权） |
| 数据库 | Turso (libSQL)：FTS5 全文检索 + 原生向量索引 |
| 附件 | Cloudflare R2 |
| Embedding | Workers AI（多语言模型） |
| 人的提交页 | Cloudflare Pages，极简表单（文本 + 图片） |
| Agent 接口 | 本地 CLI + skill。暂不做远程 MCP；以后需要时在 Web API 上加薄适配层 |

人不做查询界面，人永远通过 agent 查询。

### 部署与资源命名

- 部署步骤、secrets 清单、token 轮换与排障：见 [`docs/deploy.md`](docs/deploy.md)（含 Windows 上只能用 `go install` 装 Turso CLI 的说明）。
- 资源命名：Cloudflare Worker 为 `liushui-mem-{dev,prod}`；Turso 每个库一个独立 DB，名为 `liushui-{personal,work}-{dev,prod}`；client token 与库的绑定放在 Worker secret `LIUSHUI_VAULT_TOKENS`（不进仓库）。
- Worker 名里的 `mem` 是 memory 的缩写，**不是命令名**（命令叫 `liushui`）。不为表面一致改成 `liushui-{dev,prod}`：那要新建 Worker、旧 Worker 成为孤儿资源、`workers.dev` URL 变更，还要同步 CLI 配置里的 url、`docs/deploy.md` 与集成测试；收益只是名字好看。若将来真要做，应当是一个只做重命名 + 一次迁移的独立 change。

## 记忆的数据模型

（总体设计，包含尚未实现的部分；已实现的行为契约以 `openspec/specs/` 下的主 spec 为准。）

每条记忆：
- `id`：全局稳定 ID（永久锚点）；由核心字段规范化后取 hash 得到，与 meta、目标库无关
- `ts`：时间；由客户端提供，重试时保持不变（幂等的前提）
- `kind`：`note` / `image` / `retrieval_feedback` / `maintenance_log` …
- `content`：文本；附件存 R2，表中存引用 + 描述文本
- meta：JSON 键值对象（地点、作者（人或哪个 agent）、主机名、当前进程、工作区（cwd、git 仓库）…），不参与 ID
- `received_at`：服务端接收时刻，不参与 ID；可作时钟偏差的旁证
- `schema_v`：写入时的 schema 版本
- 所属库：**每个库一个独立数据库**（已定案；一条 SQL 不跨库）。同一条记忆可提交到多个库，`id` 相同而 meta 可按库脱敏；跨库隔离由 token→库的绑定保证

meta 由 CLI 自动采集，不依赖 agent 手填。

## 接口

### CLI
- `liushui append [--vault ...] [--kind ...] [--file x.png] "文本"`：追加记忆，附件由 CLI 上传 R2
- `liushui sql "<SELECT ...>"`：只读查询

输出默认紧凑格式（JSONL/TSV），限制行数与字段长度，避免撑爆 agent 上下文。

### SQL 查询
- 只读连接，强制 LIMIT 与超时
- 写入不走 SQL，只走 append
- 语义检索通过 `embed('文本')` 宏：服务端预处理，把它替换为向量参数后再执行

```sql
SELECT m.id, m.ts, m.author, m.content
FROM vector_top_k('mem_vec_idx', embed('上次 iOS 渲染问题怎么查的'), 20) v
JOIN memories m ON m.rowid = v.id
WHERE m.ts > '2026-01-01';
```

库隔离在数据库层面完成（每个库一个独立 DB、每个 token 只能连到自己那个），
因此 `memories` 表里没有 `vault` 列，查询也不需要按库过滤。

向量召回、FTS5 `MATCH`、meta 过滤可在一条 SQL 中自由组合。

### Skill
向 agent 说明 schema、`embed()` 宏、FTS5 用法、反馈记忆规范。每次维护改了 schema 要同步更新 skill。

## 反馈记忆规范（kind = retrieval_feedback）

版本号不足以复现，因为索引、模型、数据量都在变。反馈记忆应包含：
- 失败的检索意图（自然语言 query）
- 实际尝试过的 SQL 与返回结果概要
- **期望命中的记忆 ID**（流水账不变，ID 是稳定锚点，可直接转为回归测试）；当时不知道可留空，事后再补一条引用
- **当场的原因调查**（同义词？时间过滤太窄？图片无文本描述？）
- 系统版本号（辅助信息）

## 维护流程（详见 MAINTENANCE.md）

1. 拉取上次维护以来的反馈记忆
2. 带期望 ID 的反馈加入回归测试集
3. 跑测试集看现状
4. 归类问题，提出改进（schema、派生表、SQL 宏、遗忘规则……）
5. 改完重跑，确认改善且无退化
6. 部署，并写一条 `maintenance_log` 记忆：改了什么、为什么

## 相关工作（参考）
- projectmem：append-only 事件日志 + 确定性投影（arXiv 2606.12329）
- User as Code：append-only 事实日志 + 定期结构化（arXiv 2606.16707）
- EvolveMem：根据检索失败自动调优检索配置（arXiv 2605.13941）
- Generative Agents memory stream
