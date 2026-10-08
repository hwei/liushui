# Spec Delta

## Purpose

提供人和 agent 共用的本地命令行入口 `mem append`：自动采集运行环境的 meta、清洗敏感信息，把一条文本记忆可靠地追加到一个或多个库，不依赖调用方手工填写元信息。

## ADDED Requirements

### Requirement: 追加命令
CLI SHALL 提供 `mem append`，接收文本内容，并支持 `--vault` 与 `--kind` 选项。省略 `--kind` 时 MUST 默认为 `note`。成功时输出新记忆的 `id`，输出紧凑、便于 agent 解析。

#### Scenario: 追加一条文本
- **WHEN** 执行 `mem append "修复了 iOS 渲染问题"`
- **THEN** 记忆被追加到默认库，命令输出该记忆的 `id`，退出码为 0

#### Scenario: 内容为空被拒绝
- **WHEN** 执行 `mem append ""`
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
CLI SHALL 从本地配置读取各库的服务地址与 token，并支持选择默认库和 dev 与 prod 环境。配置中的 token MUST NOT 出现在命令输出与日志中。

#### Scenario: 未配置库
- **WHEN** 在没有任何库配置的机器上执行追加
- **THEN** 命令报错并提示如何配置，不发出请求

#### Scenario: 输出不泄露 token
- **WHEN** 追加失败并输出诊断信息
- **THEN** 输出中不包含任何 token
