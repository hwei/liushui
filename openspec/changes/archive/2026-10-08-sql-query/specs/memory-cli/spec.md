# Spec Delta

## ADDED Requirements

### Requirement: 查询命令
CLI SHALL 提供 `liushui sql`，把一条 SQL 发往单个库的查询端点并输出结果。目标库 MUST 至多一个：省略 `--vault` 时用默认库，指定多个库 MUST 作为用法错误拒绝。SQL 可以作为参数传入，也可以通过 `-` 从标准输入读取；位置参数通过可重复的 `--arg` 传入。

#### Scenario: 查询默认库
- **WHEN** 执行 `liushui sql "SELECT id, kind FROM memories ORDER BY ts DESC"`
- **THEN** 命令查询默认库，输出结果，退出码为 0

#### Scenario: 多库被拒绝
- **WHEN** 执行 `liushui sql --vault personal --vault work "SELECT 1"`
- **THEN** 命令报用法错误并以退出码 2 退出，不发出请求

#### Scenario: 从标准输入读取 SQL
- **WHEN** 通过标准输入提供 SQL 并执行 `liushui sql -`
- **THEN** 命令执行标准输入中的 SQL，行为与直接传参相同

#### Scenario: SQL 为空被拒绝
- **WHEN** 执行 `liushui sql ""`
- **THEN** 命令报错并以非 0 退出，不发出请求

### Requirement: 查询输出格式
`liushui sql` 的结果 SHALL 默认以带表头的 TSV 写到 stdout，单元格内的制表符、换行与反斜杠 MUST 转义，以保证一行对应一条记录。`--json` 时 SHALL 改为 JSONL，每行一个以列名为键的对象。命令 MUST 按默认值或 `--limit` 限制行数，并按默认值或 `--max-width` 限制单元格宽度。截断提示 MUST 写到 stderr，stdout 只包含结果。

#### Scenario: 默认 TSV 输出
- **WHEN** 查询返回两列三行，且某个单元格含换行
- **THEN** stdout 为 1 行表头加 3 行数据，该换行以转义形式出现

#### Scenario: JSONL 输出
- **WHEN** 执行 `liushui sql --json "SELECT id, kind FROM memories"`
- **THEN** stdout 每行是一个含 `id` 与 `kind` 键的 JSON 对象

#### Scenario: 截断提示不污染 stdout
- **WHEN** 结果因行数上限或单元格宽度被截断
- **THEN** stderr 给出截断提示，stdout 仍可按所选格式完整解析

#### Scenario: 空结果
- **WHEN** 查询没有匹配的行
- **THEN** TSV 模式下只输出表头，JSONL 模式下不输出任何行，退出码为 0

### Requirement: 查询失败与重试
查询失败时 `liushui sql` SHALL 把错误写到 stderr 并以退出码 1 退出；用法或配置错误以退出码 2 退出。SQL 错误 MUST 原样带出数据库给出的描述。网络错误与“存储不可用”可以重试；未授权、语句不允许、参数错误、SQL 错误与超时 MUST NOT 重试。网络错误的诊断提示要求同样适用于查询命令。

#### Scenario: SQL 错误不重试
- **WHEN** 查询返回 SQL 错误
- **THEN** 命令只发出一次请求，stderr 包含数据库给出的错误描述，退出码为 1

#### Scenario: 超时不重试
- **WHEN** 查询返回超时错误
- **THEN** 命令只发出一次请求并以退出码 1 退出

#### Scenario: 存储暂时不可用后成功
- **WHEN** 第一次请求返回存储不可用，第二次成功
- **THEN** 命令输出结果，退出码为 0

## MODIFIED Requirements

### Requirement: 配置
CLI SHALL 从本地配置读取各库的服务地址与 token，并支持选择默认库和 dev 与 prod 环境。配置中的 token MUST NOT 出现在任何命令（包括追加与查询）的输出与日志中。

#### Scenario: 未配置库
- **WHEN** 在没有任何库配置的机器上执行追加
- **THEN** 命令报错并提示如何配置，不发出请求

#### Scenario: 输出不泄露 token
- **WHEN** 追加失败并输出诊断信息
- **THEN** 输出中不包含任何 token

#### Scenario: 查询输出不泄露 token
- **WHEN** 查询失败或成功并输出结果与诊断信息
- **THEN** 输出中不包含任何 token
