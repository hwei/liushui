# memory-api Specification

## Purpose

提供记忆系统的写入 Web API：以 token 鉴权，把每个请求路由到对应库的独立数据库，保证追加的幂等与明确的错误语义，并在 dev 与 prod 环境之间保持数据隔离。

## Requirements

### Requirement: Token 鉴权
除健康检查外，API 的所有端点 SHALL 要求有效 token。缺失或无效的 token MUST 被拒绝，且响应不得泄露库是否存在。

#### Scenario: 无 token 被拒绝
- **WHEN** 请求不携带 token 调用追加端点
- **THEN** 返回未授权错误，且不写入任何数据

#### Scenario: 无效 token 被拒绝
- **WHEN** 请求携带不属于任何库的 token
- **THEN** 返回未授权错误，且响应不透露任何库的信息

### Requirement: 按库路由与隔离
每个库 SHALL 对应一个独立的数据库。一个 token MUST 只能访问其所属库，不得读写其他库的数据。

#### Scenario: token 只能写入所属库
- **WHEN** 持有个人库 token 的请求调用追加端点
- **THEN** 记录只写入个人库的数据库，公司库中不出现该记录

#### Scenario: 跨库访问被拒绝
- **WHEN** 持有个人库 token 的请求显式指定公司库
- **THEN** 请求被拒绝，两个库均无变化

### Requirement: 追加端点
API SHALL 提供追加端点，接收一条完整记录（含客户端计算的 `id`）。服务端 MUST 使用与客户端相同的规则重新计算 ID，若不一致则拒绝。成功时返回记录 `id` 与是否为新写入。

#### Scenario: 新记录写入成功
- **WHEN** 提交一条合法且此前不存在的记录
- **THEN** 返回成功及该记录的 `id`，并标明为新写入

#### Scenario: 重复记录幂等返回
- **WHEN** 提交一条 `id` 已存在于该库的记录
- **THEN** 返回成功及既有 `id`，并标明为已存在，库内记录数不变

#### Scenario: ID 与内容不一致被拒绝
- **WHEN** 提交的 `id` 与服务端按核心字段重新计算的结果不同
- **THEN** 请求被拒绝并说明 ID 不匹配，库中不新增记录

### Requirement: 输入校验与错误语义
API SHALL 对输入做校验并返回可区分的错误：格式错误、字段缺失、内容超过大小上限、未授权、服务端故障。错误响应 MUST 机器可读，且不得包含密钥或内部堆栈。

#### Scenario: 超限内容被拒绝
- **WHEN** 提交的 `content` 超过配置的大小上限
- **THEN** 返回明确的“内容过大”错误，库中不新增记录

#### Scenario: 服务端故障可与客户端错误区分
- **WHEN** 后端数据库暂时不可用
- **THEN** 返回与格式错误不同的服务端错误，以便客户端决定是否重试

### Requirement: 环境隔离
系统 SHALL 提供 dev 与 prod 两套环境，各自使用独立的服务实例、独立的数据库与独立的 token。dev 环境 MUST NOT 能读写 prod 数据。

#### Scenario: dev token 不能访问 prod
- **WHEN** 使用 dev 环境的 token 调用 prod 的追加端点
- **THEN** 返回未授权错误，prod 数据不变

### Requirement: 健康检查
API SHALL 提供无需鉴权、不访问数据库的健康检查端点，用于部署后的冒烟验证，响应中包含服务版本。

#### Scenario: 部署后可确认版本
- **WHEN** 调用健康检查端点
- **THEN** 返回成功及当前部署的服务版本
