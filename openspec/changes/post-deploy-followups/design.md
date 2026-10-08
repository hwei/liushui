# Design

## Context

动机见 proposal.md — Why。相关契约见 `specs/memory-cli/spec.md`（网络错误的诊断提示）与 `specs/memory-ledger/spec.md`（时间字段的语义）。

现有实现的约束：

- CLI 的失败信息在 `packages/cli/src/client.ts` 里组装（`网络错误：${error.name}: ${error.message}`），重试 3 次后在 `src/append.ts` 变成 `VaultReport`，再由 `src/main.ts` 输出 —— 单库走 stderr 一行人话，多库走 stdout 的 JSONL。也就是说**存在两条输出路径**，提示必须两条都覆盖。
- `client.ts` 目前不读环境变量；`append.ts` 已有 `deps.env`，是唯一同时看得到环境与失败结果的地方。
- 本机实测：直连 `*.workers.dev` 超时，经 `HTTPS_PROXY` 200；Node 的 `fetch` 默认不读代理环境变量，`NODE_USE_ENV_PROXY=1` 后正常。

## Goals / Non-Goals

**Goals**
- 让"网络失败但其实是代理没启用"这一种情况**自解释**：失败信息里直接给出可执行修法。
- 把 `ts` / `received_at` 的语义固化成契约，并有一条能跑的测试，供 `sql-query` 依赖。

**Non-Goals**
- 不实现"自动使用代理"。见 Decision 2。
- 不改 Worker 资源名。见 Decision 3。
- 不重写 `docs/deploy.md` 里已记录的 Windows 装 Turso CLI 内容。见 Decision 4。
- 不做连通性探测（不做 DNS 解析、不试连代理）来"判断是不是代理问题"。见 Decision 5。

## Decisions

### 1. 提示在 `append.ts` 组装 report 时附加，而不是在 `client.ts`
`client.ts` 保持纯传输职责（只报告"网络错误"这一事实），提示由上层依据环境补上。这样单库 stderr 与多库 JSONL 两条路径天然都带上提示，不需要在两个输出点各写一遍。

- 判定逻辑抽成一个无副作用的纯函数（输入环境变量，输出提示或 null），便于单测；判定与输出分离，字符串以后改动也不影响逻辑。
- 备选：在 `client.ts` 里直接拼进 `message`。放弃：需要把 env 一路传进传输层，且多库 JSONL 的 message 与单库 stderr 的 message 会分叉维护。

### 2. 只提示，不自动使用代理
明确放弃"CLI 自己读 `HTTP_PROXY`/`HTTPS_PROXY` 并走代理"。

- 理由：要正确处理必须引入 `undici` 并用 `EnvHttpProxyAgent`（或自行实现），而且**必须同时正确处理 `NO_PROXY`** —— 否则本地 `wrangler dev`（`127.0.0.1:8787`）会被送去代理，把本地开发打断。收益只是省掉在 shell profile 里写一行 `NODE_USE_ENV_PROXY=1`，不抵新增依赖与 `NO_PROXY` 边界情况的成本。
- 另一条备选：失败时 re-exec 自己并带上 `NODE_USE_ENV_PROXY=1`。放弃：多一次进程、要防递归、而且把"本应由环境决定的事"藏进程序里，出问题时更难排查。
- 影响：用户仍需在需要代理的机器上设置一次 `NODE_USE_ENV_PROXY=1`（文档已写）。若日后发现这行仍然经常被漏掉，再单独开一个 change 做自动代理解析。

### 3. Worker 资源名保持 `liushui-mem-{dev,prod}`
- 理由：`liushui-mem` 读作"liushui 的记忆服务"，这里的 `mem` 是 memory 的缩写、不是命令名，并不含糊；而重命名要新建 Worker、旧 Worker 成为孤儿资源、`workers.dev` URL 变更，还要同步 CLI 配置里的 url、`docs/deploy.md` 与集成测试。收益（命名表面一致）明显小于成本与线上扰动。
- 备选：改名为 `liushui-{dev,prod}`。保留为将来可选项；真要做时应当是一个只做重命名 + 一次迁移的独立 change。
- **durable 落点**：`DESIGN.md` 的「部署与资源命名」小节。本节只记录取舍过程，结论以那里为准（避免两处维护、日后分叉）。

### 4. 已落地到文档的两件事不在本 change 里重复
- Windows 装 Turso CLI（官方 `install.sh` 只支持 Darwin/Linux，用 `go install`）已写进 `docs/deploy.md` 第 0 节；
- 代理与 `NO_PROXY` 的说明已在 README「常见问题」与 `docs/deploy.md` 第 0 节。

本 change 只补一句「CLI 现在会自己提示」，避免同一件事两处维护、日后分叉。

- **durable 落点**：正文在 `docs/deploy.md`，入口指针在 `DESIGN.md` 的「部署与资源命名」小节。本 change 不改这两处的正文。

### 5. 判定条件是"代理已配置且代理支持未启用"，不做联网探测
提示只在 `HTTP_PROXY`/`HTTPS_PROXY` 之一非空、且 `NODE_USE_ENV_PROXY` 未启用、且**确实发生了网络错误**时出现。三个条件都满足才提示，把误报压到最低。

- 放弃：解析 `NO_PROXY` 去判断"目标地址是否真的会被代理" —— 规则复杂（含通配、CIDR、端口），在错误路径上再做一遍容易引入新的错。宁可提示里提醒用户注意本地地址。
- 放弃：探测式判断（试连代理）。失败路径上再加超时只会让报错更慢。

## Risks / Trade-offs

- [提示误报：确实有代理变量，但故障其实是别的原因] → 提示是**附加**在原始错误之后，不替换原始信息；措辞用"如果这台机器经代理出网"，不断言。
- [提示污染机器可读输出] → 多库场景的 JSONL 本来就带 `message` 字段，提示进入该字段而不新增字段，解析方不受影响。
- [用户照着提示设了变量但没重开 shell] → 提示里写明"新开一个 shell 或在当前 shell export"。
- [时间语义写进 spec 但下游（`sql-query`）仍按 `received_at` 排序] → 该 spec 是 `sql-query` 的设计输入；届时以其 spec 的验收为准。
- [代理变量值被回显] → 提示只用变量**名**，不回显值；既有 `scrubSecrets` 仍是最后一道防线。

## Migration Plan

无需迁移：不改 schema、不改线上 Worker 与 secrets、不动已有数据。CLI 侧变更随下一次 `npm install`/代码更新生效（全局安装是指向仓库的 junction，改完即生效）。

回滚：只涉及 CLI 一处提示逻辑，`git revert` 即可，无数据影响。

## Open Questions

- 提示里是否要顺带给出"本地回环地址应加入 `NO_PROXY`"的例子，取决于用户实际配置方式；不影响 spec、方案与任务拆分，实现时按需决定。
