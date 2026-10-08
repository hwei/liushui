# Proposal

## Why

上一次部署（`core-append-store`）在真实环境里暴露了两个只有"用起来"才会碰到的问题：

1. CLI 在需要代理的机器上失败时只吐一句 `TimeoutError: The operation was aborted due to timeout`，看不出是代理问题，也看不出该怎么修（本机实测：直连 workers.dev 超时，经代理 200）。
2. `ts` 与 `received_at` 的关系没有任何契约。下游做排序、增量拉取或时间窗口过滤时很容易假设 `received_at >= ts`，但实测客户端时钟可能快于服务端（见过 `received_at` 早于 `ts` 约 136 ms）。

这两条是后续 `sql-query`（排序、`rows_read` 记账、时间窗口）与检索质量评估的地基，先收口比等踩到再修便宜。

## What Changes

- CLI 在网络错误时给出**可操作的诊断提示**：当环境配置了代理（`HTTP_PROXY` / `HTTPS_PROXY`）但没有启用 Node 的代理支持（`NODE_USE_ENV_PROXY`）时，失败信息 SHALL 指出这一点以及怎么修（并用 `NO_PROXY` 让本地回环地址不受影响）。未配置代理时不加任何提示，避免噪声。
- 明确 `ts` 与 `received_at` 的**语义契约**：`ts` 由客户端提供且在同一条记忆的重试中 MUST 保持不变（幂等的前提），因此它可能不准；系统 MUST NOT 假设 `received_at >= ts`；需要时间先后的功能 SHALL 基于 `ts`，`received_at` 只作服务端视角的旁证。
- 记录两个**"不做"的决定**及其理由：结论落在 `DESIGN.md` 的「部署与资源命名」小节与 `docs/deploy.md`（Worker 资源名不重命名；Windows 装 Turso CLI 已于文档覆盖），取舍过程记录在本 change 的 design。

## Capabilities

### New Capabilities
<!-- 无：本次只改已有能力的既有契约 -->

### Modified Capabilities
- `memory-cli`: 新增「网络错误的诊断提示」要求（失败信息在代理环境下必须可操作）
- `memory-ledger`: 新增「时间字段的语义」要求（禁止假设 `received_at >= ts`，明确时间先后的依据）

## Impact

- **代码**：`packages/cli`（新增一个纯函数模块判定是否该给代理提示；在 report 组装处接上，使单库 stderr 与多库 JSONL 两条输出路径都带上）。`packages/worker` 不改代码，只新增测试固化时间语义。
- **依赖**：无新增。不走"自动使用代理"路线（需引入 `undici` 并正确处理 `NO_PROXY`，否则本地 `wrangler dev` 的 `127.0.0.1` 会被代理；理由见 design）。
- **线上**：无变更 —— dev/prod 的 Worker、secrets、Turso 数据都不动。
- **文档**：README 的「常见问题」与 `docs/deploy.md` 第 0 节已记录代理与 Windows 装 Turso CLI；本次只补一句「CLI 现在会自己提示」，不重复正文。
- **后续依赖**：`sql-query` 的时间过滤与排序将依赖本次定下的时间语义。
