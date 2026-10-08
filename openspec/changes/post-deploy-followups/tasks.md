# Tasks

## 1. CLI 网络错误的诊断提示

- [ ] 1.1 新增一个无副作用的纯函数模块（`packages/cli/src/proxy-hint.ts`）：输入环境变量，当 `HTTP_PROXY` 或 `HTTPS_PROXY` 非空且 `NODE_USE_ENV_PROXY` 未启用时返回提示文本，否则返回 null；提示里只出现变量名与修法，不回显变量值。验证：单测覆盖"有代理未启用 / 有代理已启用 / 无代理 / 变量为空串"四种输入，并断言提示含 `NODE_USE_ENV_PROXY`、不含任何 token
- [ ] 1.2 在 report 组装处（`packages/cli/src/append.ts`）把提示附加到**网络类**失败的 message 上，使单库 stderr 与多库 JSONL 两条输出路径都带上，且服务端/客户端错误不受影响。验证：单测断言（a）单库网络失败时 stderr 含提示；（b）多库时该库的 JSONL `message` 含提示；（c）4xx/5xx 失败时不附加
- [ ] 1.3 文档补一句：README「常见问题」与 `docs/deploy.md` 第 0 节各加一行「CLI 在网络失败时会自行提示」，不重复已有正文。验证：两处都提到该行为，且与原文（代理说明、`NODE_USE_ENV_PROXY`）不冲突

## 2. 时间字段的语义

- [ ] 2.1 为 `memory-ledger` 的新要求补 worker 测试：注入固定服务端时钟，提交 `ts` 晚于它的请求，断言返回 201、`ts` 与 `received_at` 都按原值保存、且 `received_at < ts`。验证：该测试不依赖真实时钟（全部注入）而稳定通过
- [ ] 2.2 对照 `openspec/specs/memory-ledger/spec.md` 核对「时间字段的语义」与既有表述（「记录字段」里对 `ts`/`received_at` 的说明）是否冲突；有冲突则在同一 change 内修正，而不是留给归档时的合并去猜。验证：主 spec 内无矛盾表述，或差异已被显式修掉

## 3. 端到端验收

- [ ] 3.1 在确实需要代理的机器上做真实验证：于**未设置** `NODE_USE_ENV_PROXY` 的 shell 里跑 `liushui append "..."`，确认退出码非 0 且提示出现；再设置该变量重跑，确认成功且库中只新增一条记录。验证：两次运行的 stdout/stderr 与退出码符合预期，且设置变量后重跑的写入不产生重复
- [ ] 3.2 全量回归：`npm test`、`npm run lint`、`npm run typecheck`、`npm run test:worker-integration`。验证：四项全部通过，测试数不少于 126（本 change 只增不减）

## Workflow follow-up

- 评审通过后归档本 change，并让 `openspec/specs/` 下的主 spec 与新要求保持一致。
- design 里的两个 Non-Goal 都不需要后续 change，除非出现新信号：CLI 自动使用代理（Decision 2）、Worker 资源名重命名（Decision 3）。触发条件与代价已写明；它们的结论另有 durable 落点（`DESIGN.md` 的「部署与资源命名」小节与 `docs/deploy.md`），本节只指向那里。
