# memory-query Specification

## Purpose
为人和 agent 提供对记忆库的只读 SQL 查询：一次只查 token 所属的单个库，由数据库层保证只读，并对结果规模、耗时与资源用量设上限、做报告，使查询既安全又不会撑爆调用方上下文或免费额度。

## Requirements

### Requirement: 查询端点
API SHALL 提供只读查询端点，接收一条 SQL 文本与可选的位置参数，返回列名与结果行。端点 MUST 要求有效 token（与追加端点相同的鉴权），缺失或无效 token 的响应 MUST 与追加端点一致，且不泄露库是否存在。

#### Scenario: 查询成功返回列与行
- **WHEN** 持有效 token 提交 `SELECT id, kind FROM memories ORDER BY ts DESC`
- **THEN** 返回成功，响应包含列名 `id`、`kind` 与按 `ts` 倒序的结果行

#### Scenario: 位置参数
- **WHEN** 提交 `SELECT id FROM memories WHERE kind = ?` 并带参数 `["note"]`
- **THEN** 只返回 `kind` 为 `note` 的记录

#### Scenario: 无 token 被拒绝
- **WHEN** 请求不携带 token 调用查询端点
- **THEN** 返回未授权错误，且不访问任何数据库

### Requirement: 单库范围
一次查询 SHALL 只在 token 所属的那一个库上执行。请求显式指定其它库时 MUST 被拒绝。查询端点 MUST NOT 提供跨库查询。

#### Scenario: 只看到所属库的数据
- **WHEN** 个人库与公司库各有不同的记录，持个人库 token 查询 `SELECT id FROM memories`
- **THEN** 结果只包含个人库的记录

#### Scenario: 指定其它库被拒绝
- **WHEN** 持个人库 token 的查询请求显式指定公司库
- **THEN** 请求被拒绝，不执行任何 SQL

### Requirement: 只读凭据与独立配置
查询 SHALL 使用该库的只读数据库凭据连接。只读凭据 MUST 存放在与追加凭据分开的独立配置中。某个库缺少只读凭据时，查询 MUST 以服务端配置错误失败，MUST NOT 回退到追加使用的凭据。追加端点的行为不受只读配置影响。

#### Scenario: 缺少只读凭据时拒绝而不回退
- **WHEN** 某库配置了追加凭据但没有只读凭据，持该库 token 发起查询
- **THEN** 返回服务端配置错误，且没有用追加凭据建立任何连接

#### Scenario: 只读配置缺失不影响追加
- **WHEN** 只读配置整体缺失或无法解析时，持有效 token 追加一条记录
- **THEN** 追加照常成功

### Requirement: 只接受只读语句
查询端点 SHALL 只接受单条只读语句：`SELECT`、`WITH … SELECT` 或 `EXPLAIN QUERY PLAN`。多条语句、写语句、DDL、`PRAGMA` 赋值与事务控制语句 MUST 被拒绝且不执行。即使语句检查被绕过，执行环境 MUST 仍阻止任何写入。

#### Scenario: 写语句被拒绝
- **WHEN** 提交 `DELETE FROM memories`
- **THEN** 返回“语句不允许”错误，库内记录数不变

#### Scenario: 多条语句被拒绝
- **WHEN** 提交 `SELECT 1; DELETE FROM memories`
- **THEN** 请求被拒绝，两条都不执行，库内记录数不变

#### Scenario: 执行层兜底阻止写入
- **WHEN** 一条带写副作用的语句通过了语句检查（例如测试中关闭检查后提交 `INSERT`）
- **THEN** 执行失败，库内记录数不变

#### Scenario: 查询计划可用
- **WHEN** 提交 `EXPLAIN QUERY PLAN SELECT * FROM memories WHERE ts > '2026-01-01'`
- **THEN** 返回查询计划行

### Requirement: 结果行数上限
查询结果 SHALL 受行数上限约束：请求可以指定不超过服务端最大值的上限，省略时使用服务端默认值。结果超过上限时 MUST 只返回上限以内的行，并在响应中明确标记“行数被截断”。未超过上限时 MUST NOT 标记截断。语句自身的排序 MUST 在截断后保持。

#### Scenario: 超过上限被截断并标记
- **WHEN** 库里有 30 条记录，以上限 10 查询 `SELECT id FROM memories ORDER BY ts`
- **THEN** 返回按 `ts` 升序的前 10 行，响应标记行数被截断

#### Scenario: 未超过上限不标记
- **WHEN** 库里有 3 条记录，以上限 10 查询全部记录
- **THEN** 返回 3 行，响应不标记截断

#### Scenario: 请求上限超过服务端最大值
- **WHEN** 请求的上限大于服务端允许的最大值
- **THEN** 返回参数错误，不执行查询

### Requirement: 单元格与响应大小上限
文本单元格超过服务端单元格上限时 SHALL 被截断，响应 MUST 指明哪些单元格被截断（或被截断的个数）。整个响应 MUST 不超过服务端响应大小上限；超过时按行截断并标记行数被截断。

#### Scenario: 长文本被截断并标记
- **WHEN** 查询一条 `content` 长度超过单元格上限的记录
- **THEN** 该单元格被截断到上限以内，响应标记存在被截断的单元格

### Requirement: 查询超时
每次查询 SHALL 受服务端超时约束。超时时 MUST 返回可与其它错误区分的超时错误，并且不返回部分结果。

#### Scenario: 慢查询超时
- **WHEN** 一条查询的执行时间超过服务端超时
- **THEN** 返回超时错误，响应中没有结果行

### Requirement: 查询错误语义
查询的错误 SHALL 机器可读并可区分：未授权、跨库、语句不允许、参数错误、SQL 错误（语法、未知表或列）、超时、服务端配置错误、存储不可用。SQL 错误 MUST 返回数据库给出的错误描述，以便调用方修正语句。错误响应 MUST NOT 包含 token、数据库凭据、连接地址或堆栈。

#### Scenario: SQL 错误可修正
- **WHEN** 提交 `SELECT nope FROM memories`
- **THEN** 返回 SQL 错误，描述中指出未知列，且属于客户端错误

#### Scenario: 存储不可用可与 SQL 错误区分
- **WHEN** 查询时后端数据库暂时不可用
- **THEN** 返回与 SQL 错误不同的服务端错误

### Requirement: 用量报告
后端报告了查询读取的行数（`rows_read`）时，查询响应 SHALL 包含该值。服务端 SHALL 对每次查询记录库名、`rows_read`（如有）、耗时与结果状态。用量记录 MUST NOT 包含 SQL 文本、参数、结果数据或任何凭据。

#### Scenario: 响应带读取行数
- **WHEN** 在报告 `rows_read` 的后端上执行一次查询
- **THEN** 响应包含该次查询的 `rows_read`

#### Scenario: 用量日志不含查询内容
- **WHEN** 执行一条在 `WHERE` 中包含私人文本的查询
- **THEN** 服务端的用量记录里没有该文本，也没有结果数据
