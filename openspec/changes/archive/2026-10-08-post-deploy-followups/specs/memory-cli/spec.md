# Spec Delta

## ADDED Requirements

### Requirement: 网络错误的诊断提示
当追加请求以网络错误失败、且运行环境配置了代理（`HTTP_PROXY` 或 `HTTPS_PROXY`）而没有启用 Node 的代理支持（`NODE_USE_ENV_PROXY`）时，CLI MUST 在失败信息里说明这一点并给出可执行的修法。环境未配置代理、或代理支持已启用时 MUST NOT 附带这类提示。提示 MUST NOT 包含任何 token。

#### Scenario: 代理环境下网络失败给出提示
- **WHEN** 环境设置了 `HTTPS_PROXY` 而未启用 `NODE_USE_ENV_PROXY`，且追加请求以网络错误失败
- **THEN** 失败信息包含 `NODE_USE_ENV_PROXY` 与修法，退出码非 0

#### Scenario: 未配置代理时不加提示
- **WHEN** 环境既没有 `HTTP_PROXY` 也没有 `HTTPS_PROXY`，且请求以网络错误失败
- **THEN** 失败信息只描述网络错误，不含代理相关内容

#### Scenario: 已启用代理支持时不加提示
- **WHEN** 环境设置了 `HTTPS_PROXY` 且已启用 `NODE_USE_ENV_PROXY`
- **THEN** 失败信息不含代理相关提示

#### Scenario: 多库提交时失败的库也带上提示
- **WHEN** 一次提交发往多个库，其中某个库因网络错误失败
- **THEN** 该库在 stdout 的 JSONL 结果里包含同样的诊断提示
