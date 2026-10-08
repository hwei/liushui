# ID 测试向量（跨语言兼容基准）

`id-vectors.json` 是记忆 ID 规则的**唯一权威基准**。任何语言的客户端（本仓库的 TypeScript、
以后的 Python/Go 等）只要按该规则实现，就必须对每个向量算出相同的 `id`。

用它的原因：CLI 在本地算 `id`，Worker 收到后用同一份规则重算并比对。
如果两边实现有差异，向量会第一时间暴露，而不是等到线上数据分裂。

## 规则

```
id = base32( sha256( canonicalIdInput ) 的前 16 字节 )
```

- `canonicalIdInput`：对 `{ attachments, author, content, kind, ts }` 做**递归按键排序**的
  确定性 JSON 序列化。
  - `ts` 归一为 UTC 毫秒精度的 ISO 字符串（`2026-10-08T15:47:08.479+08:00` 与
    `2026-10-08T07:47:08.479Z` 相同）。
  - `attachments` 即使为空也必须出现（序列化为 `[]`），并按字典序排序。
  - 字符串使用标准 JSON 转义。
- base32：RFC 4648 大写字母表 `ABCDEFGHIJKLMNOPQRSTUVWXYZ234567`，**无填充**。
  128 位恰好编码为 26 个字符。
- `meta`、`received_at` 与目标库**不参与**计算。

## 修改期望值的后果

期望值只能在**变更 ID 规则本身**时修改，而那属于破坏性变更：需要新的 `schema_v`，
并同步更新 `memory-ledger` spec 与 design 文档。日常重构、bug 修复不得改动这些值。

## 校验方式

`packages/core/test/id.test.ts` 读取本文件并逐条断言；`base32Encode` 另有 RFC 4648
官方测试向量（`f`/`fo`/`foo`/`foob`/`fooba`/`foobar`）做独立校验。
