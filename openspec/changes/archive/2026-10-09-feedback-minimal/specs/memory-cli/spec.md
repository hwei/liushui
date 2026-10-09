# Spec Delta

## ADDED Requirements

### Requirement: 反馈命令
CLI SHALL 提供 `liushui feedback`，从参数或标准输入（`-`）读取一份反馈 JSON，按反馈格式校验后以 `kind = retrieval_feedback` 追加到一个库，成功时与单库追加一样只输出 `id`。目标库 MUST 至多一个：省略 `--vault` 时用默认库，指定多个库 MUST 作为用法错误拒绝。meta 的采集、清洗、按库脱敏与重试行为与 `liushui append` 相同。

#### Scenario: 写入一条反馈
- **WHEN** 执行 `liushui feedback '{"v":1,"intent":"上次 iOS 渲染问题怎么查的","queries":[{"sql":"SELECT id FROM memories WHERE content LIKE ''%渲染%''","outcome":"0 行"}]}'`
- **THEN** 默认库中新增一条 `kind = retrieval_feedback` 的记忆，命令输出其 `id`，退出码为 0

#### Scenario: 从标准输入读取
- **WHEN** 通过标准输入提供同一份反馈 JSON 并执行 `liushui feedback -`
- **THEN** 结果与直接传参相同

#### Scenario: 多库被拒绝
- **WHEN** 执行 `liushui feedback --vault personal --vault work '<反馈 JSON>'`
- **THEN** 命令报用法错误并以退出码 2 退出，不发出请求

### Requirement: 反馈命令的写入前校验
`liushui feedback` MUST 在发出请求之前完成校验：输入不是 JSON、或不符合反馈格式时，命令 SHALL 把出错字段的路径写到 stderr，以退出码 2 退出，且不发出任何请求。写入的 `content` MUST 是规范化（键排序、紧凑）的 JSON，使同一份反馈不论输入时的键顺序与空白如何都得到相同内容。

#### Scenario: 不是 JSON
- **WHEN** 执行 `liushui feedback "搜不到渲染相关的记忆"`
- **THEN** 命令说明输入须为反馈 JSON 并给出模板位置，退出码为 2，不发出请求

#### Scenario: 字段不合规
- **WHEN** 输入的反馈缺少 `queries`
- **THEN** stderr 指出 `queries`，退出码为 2，不发出请求

#### Scenario: 键顺序不影响写入内容
- **WHEN** 同一份反馈分别以两种键顺序和缩进输入
- **THEN** 两次写入的 `content` 逐字相同

### Requirement: 反馈命令自动填写服务版本
输入未提供 `service_version` 时，`liushui feedback` SHALL 在写入前向目标库所在服务的健康检查端点读取版本号并填入。读取失败（网络错误、超时、响应异常）时 MUST 省略该字段并照常写入，只在 stderr 给出一行提示。输入已提供 `service_version` 时 MUST 原样保留。

#### Scenario: 自动填入版本
- **WHEN** 健康检查返回版本 `0.3.0`，输入未含 `service_version`
- **THEN** 写入的反馈 `service_version` 为 `0.3.0`

#### Scenario: 读不到版本时仍然写入
- **WHEN** 健康检查请求失败
- **THEN** 反馈照常写入且不含 `service_version`，stderr 有一行提示，退出码为 0
