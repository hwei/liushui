# memory-cli Specification

## Purpose

提供人和 agent 共用的本地命令行入口 `liushui append`：自动采集运行环境的 meta、清洗敏感信息，把一条文本记忆可靠地追加到一个或多个库，不依赖调用方手工填写元信息。

## Requirements

### Requirement: 追加命令
CLI SHALL 提供 `liushui append`，接收文本内容，并支持 `--vault` 与 `--kind` 选项。省略 `--kind` 时 MUST 默认为 `note`。成功时输出新记忆的 `id`，输出紧凑、便于 agent 解析。

#### Scenario: 追加一条文本
- **WHEN** 执行 `liushui append "修复了 iOS 渲染问题"`
- **THEN** 记忆被追加到默认库，命令输出该记忆的 `id`，退出码为 0

#### Scenario: 内容为空被拒绝
- **WHEN** 执行 `liushui append ""`
- **THEN** 命令报错并以非 0 退出，不发出请求

### Requirement: meta 自动采集
CLI SHALL 在追加时自动采集 meta，不依赖调用方填写。至少包括主机名、操作系统、当前工作目录、git 仓库与分支与提交与是否有未提交改动、当前进程、agent 名称与会话标识（若可识别）、CLI 版本、时区、来源。无法采集的字段 MUST 省略。

#### Scenario: 在 git 仓库内追加
- **WHEN** 在一个 git 仓库的工作目录内执行追加
- **THEN** 记录的 meta 含 `git.repo`、`git.branch`、`git.commit` 与 `git.dirty`

#### Scenario: 不在 git 仓库内追加
- **WHEN** 在非 git 目录执行追加
- **THEN** 记录的 meta 不含任何 `git.*` 键，追加仍成功

### Requirement: 敏感信息清洗
CLI MUST 在写入 meta 前清洗可能含凭据的值。git remote URL 中的用户名、密码、token 等 userinfo SHALL 被移除。清洗失败时该字段 MUST 被省略，而不是原样写入。

#### Scenario: remote 含凭据
- **WHEN** git remote 为 `https://user:ghp_xxx@github.com/org/repo.git`
- **THEN** 写入的 `git.repo` 不含 `user`、`ghp_xxx`，仅保留主机与路径

### Requirement: 多库提交
CLI SHALL 支持把同一条记忆提交到多个库。同一条记忆在各库中的 `id` MUST 相同；各库的 meta MUST 可按库独立脱敏，使某个库中不出现不应暴露的字段。

#### Scenario: 同时提交个人库与公司库
- **WHEN** 执行追加并指定两个库
- **THEN** 两个库各有一条记录，`id` 相同

#### Scenario: 按库脱敏
- **WHEN** 公司库配置为不记录 `cwd`
- **THEN** 公司库中该记录的 meta 不含 `cwd`，个人库中的仍含 `cwd`

#### Scenario: 其中一个库失败
- **WHEN** 同时提交到两个库而其中一个库不可达
- **THEN** 命令明确报告每个库的结果，已成功的库不回滚，退出码非 0

### Requirement: 可靠重试
CLI SHALL 在网络错误或服务端故障时对同一条已生成的记录自动重试，重试使用相同的 `ts` 与 `id`，依靠服务端幂等避免重复。客户端类错误（未授权、格式错误）MUST NOT 重试。

#### Scenario: 临时网络故障后成功
- **WHEN** 第一次请求因网络中断失败而重试成功
- **THEN** 库中只有一条该记忆

#### Scenario: 未授权不重试
- **WHEN** 服务端返回未授权
- **THEN** 命令立即以非 0 退出并给出原因，不再重试

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
