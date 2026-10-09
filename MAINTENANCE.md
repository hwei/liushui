# 系统维护指南（MAINTENANCE.md）

供维护者参考的系统迭代与回归维护指南。
本系统遵循「流水账是唯一事实来源、派生数据可整体重建」的原则。维护流程始终在本地运行、在候选代码上用线上快照执行回归，确保**部署前确认有改善、无退化**。

---

## 隐私与安全说明

- **快照包含真实个人数据**：快照文件包含指定库的所有记忆（明文），其默认路径 `.liushui/snapshots/` 和评估报告路径 `.liushui/reports/` 已在 `.gitignore` 中忽略，**切勿提交至版本控制仓库**。
- **只用只读凭据**：导出快照仅使用 Turso 的 `--read-only` 数据库凭据，严禁使用写凭据。
- **评估环境安全**：评估工具在系统临时目录建立临时 SQLite 文件库，并在评估结束后立即删除，绝不改动快照文件，也绝不连接线上库。
- 快照使用完毕后可随时本地手动删除。

---

## 维护步骤与命令

一次完整的维护迭代流程包含以下 7 个步骤：

### 1. 用只读凭据导出快照

使用要维护的目标库（如 prod）的只读凭据，将流水账导出为本地快照：

```bash
TURSO_URL='libsql://liushui-personal-prod-<org>.turso.io' \
TURSO_AUTH_TOKEN='<只读 token>' \
npm run regress -- snapshot --name personal-prod
# 导出至 .liushui/snapshots/personal-prod-<UTC时间>.jsonl
```

### 2. 在当前 main 上运行评估，得到基线报告

在修改代码前，对刚导出的快照执行一次评估，记录当前的基线：

```bash
npm run regress -- run \
  --snapshot .liushui/snapshots/personal-prod-20261009-060000.jsonl \
  --out .liushui/reports/baseline-20261009.json
```

### 3. 查看「待补充」与「无效」反馈

阅读基线报告中的 `pending`（待补充）与 `invalid`（无效）记录。
如果某些之前不知道答案的反馈在事后已能找到对应的记忆 ID，可在日常开发机上用 `liushui feedback` 补写一条补充记录，并重新导出快照：

```bash
liushui feedback '{"v":1,"refines":"<原反馈 ID>","expected_ids":["<真实记忆 ID>"],"note":"事后翻阅流水账补齐"}'
```

### 4. 按 fail/partial 用例的原因调查（cause）归类问题并修改候选代码

阅读报告中未通过的用例（`fail`、`partial`）及其 `cause`，针对性地调整候选代码：
- 改进全文切分规则；
- 增加 SQL 宏展开支持；
- 引入同义词扩展或未来的向量索引等。

> **派生数据登记要求**：
> 若本次修改增加了新的派生数据表（如向量表），必须在 `packages/core/src/storage/derived.ts` 的 `rebuildDerived` 函数中登记并调用重建，否则回归评估无法覆盖新派生数据！

### 5. 在候选代码上用同一份快照加 `--baseline` 重跑对比

在候选代码分支上，使用**同一份快照**和第 2 步生成的基线报告运行回归评估：

```bash
npm run regress -- run \
  --snapshot .liushui/snapshots/personal-prod-20261009-060000.jsonl \
  --baseline .liushui/reports/baseline-20261009.json
```

- 若有任何用例从 `pass` 变为非 `pass`，命令会报告退化并以非 0 退出（退出码 1）。
- 确认**有改善（improved > 0）且无退化（regressed == 0）**后方可推进。

### 6. 正常走 OpenSpec 变更与部署流程

按常规 OpenSpec change 流程提交审核，并按 `docs/deploy.md` 部署：
1. 若有表结构变化，先跑 `npm run migrate`；
2. 部署 Worker；
3. 若派生规则更新，跑派生数据重建（如 `npm run fts:rebuild`）。

### 7. 写入维护记录与补充正向反馈

部署完成后，记录本次维护审计日志，并建议补写一条成功查询的反馈：

1. **写一条 maintenance_log 记忆**：
   ```bash
   liushui append --kind maintenance_log "维护完成：优化了渲染相关 bigram 切分规则。回归用例 12 个，pass 由 4 个提升到 8 个，无退化。"
   ```

2. **补充正向反馈建议**：
   对于本次修好的用例，可在 agent 中用 `liushui feedback` 记一条其成功查询与期望 ID 的反馈，将成功的查询也沉淀为用例，使其成为后续迭代中稳固的防退化护栏。
