# memory-feedback Specification

## Purpose

规定检索反馈记忆（`kind = retrieval_feedback`）的格式与合并语义，并把反馈变成可在本地快照上、用候选代码重复执行的回归评估，让维护时能在部署前判断检索是否改善、有无退化。

## Requirements

### Requirement: 反馈记录格式
`kind = retrieval_feedback` 的记忆 SHALL 以一个 JSON 对象作为 `content`，并含版本字段 `v`（当前为 `1`）。v1 的字段为：`intent`（检索意图，自然语言）、`queries`（尝试过的查询列表，每项含 `sql`，可选 `args` 与 `outcome` 结果概要）、`expected_ids`（期望命中的记忆 ID 列表，可省略）、`cause`（当场的原因调查，可省略）、`service_version`（可省略）。写入的 `content` MUST 是键排序的紧凑 JSON。

#### Scenario: 完整的反馈可被解析
- **WHEN** 一条 `retrieval_feedback` 的 `content` 为含 `v`、`intent`、两条 `queries`、一个 `expected_ids`、`cause` 与 `service_version` 的 JSON
- **THEN** 解析得到上述全部字段，与写入时的值一致

#### Scenario: 不知道期望 ID 时也能写
- **WHEN** 反馈省略 `expected_ids`
- **THEN** 反馈仍然合法，可被写入与解析

#### Scenario: 内容可以用 SQL 读取
- **WHEN** 用 `json_extract(content, '$.intent')` 查询一条反馈
- **THEN** 返回该反馈的检索意图原文

### Requirement: 反馈的校验规则
v1 反馈 SHALL 满足：`intent` 为非空字符串；`queries` 至少一项，每项的 `sql` 为非空字符串，`args` 若有则只含字符串、数值或 null；`expected_ids` 若有则每项都是 26 位大写 base32 的记忆 ID 且不重复；不得出现 v1 未定义的字段。不满足时 MUST 报告出错字段的路径。

#### Scenario: 缺少意图被拒绝
- **WHEN** 校验一份没有 `intent` 的反馈
- **THEN** 校验失败，错误指出 `intent`

#### Scenario: 没有尝试过的查询被拒绝
- **WHEN** 校验一份 `queries` 为空数组的反馈
- **THEN** 校验失败，错误指出 `queries`

#### Scenario: 期望 ID 格式错误被拒绝
- **WHEN** `expected_ids` 中有一项为 `abc`
- **THEN** 校验失败，错误指出该项的路径（如 `expected_ids[0]`）

#### Scenario: 拼错的字段被拒绝
- **WHEN** 反馈含未定义的字段 `expect_ids`
- **THEN** 校验失败，错误指出 `expect_ids`

#### Scenario: 不支持的版本被拒绝
- **WHEN** 反馈的 `v` 为 `2`
- **THEN** 校验失败，说明不支持该版本

### Requirement: 事后补充期望 ID
流水账不可改写，补充或更正某条反馈的期望 ID SHALL 通过一条新的 `retrieval_feedback` 记录完成：它含 `v`、`refines`（被补充反馈的 ID）、`expected_ids`，可选 `note`，且不含 `intent` 与 `queries`。一条反馈的有效期望 ID MUST 取引用它的补充记录中 `ts` 最新的一条（`ts` 相同取 `id` 较大者）；没有补充时取它自身的 `expected_ids`。补充记录 MUST NOT 引用另一条补充记录。

#### Scenario: 为原本留空的反馈补上期望 ID
- **WHEN** 反馈 A 没有 `expected_ids`，之后写入一条 `refines = A`、`expected_ids = [X]` 的补充
- **THEN** A 的有效期望 ID 为 `[X]`

#### Scenario: 更正以最新的补充为准
- **WHEN** 反馈 A 先后有两条补充，较早的为 `[X]`，较晚的为 `[Y]`
- **THEN** A 的有效期望 ID 为 `[Y]`

#### Scenario: 补充记录不能引用补充记录
- **WHEN** 校验一条 `refines` 指向另一条补充记录的补充
- **THEN** 回归评估把它报告为无效，不影响任何用例的期望 ID

### Requirement: 本地快照
回归工具 SHALL 能用某个库的只读数据库凭据，把该库 `memories` 表的全部行原样导出为本地快照文件。快照只包含流水账，不含任何派生数据。凭据 MUST NOT 出现在快照、报告或任何输出中。快照默认写在不纳入版本控制的本地目录。

#### Scenario: 快照与库中的记忆一致
- **WHEN** 对一个含 N 条记忆的库导出快照
- **THEN** 快照恰有 N 条记录，每条的全部字段与库中一致

#### Scenario: 只读凭据即可导出
- **WHEN** 使用只读凭据导出快照
- **THEN** 导出成功，库中的数据不变

#### Scenario: 输出不含凭据
- **WHEN** 导出成功或因连接失败而报错
- **THEN** 标准输出、标准错误与快照文件中都不含凭据

### Requirement: 在候选代码上重建派生数据
回归评估 SHALL 把快照载入一个新建的临时本地库，用当前工作区代码的迁移建表，再从流水账重建全部派生数据后执行用例。评估 MUST NOT 修改快照文件，也 MUST NOT 连接线上库。

#### Scenario: 换了切分规则也能直接评估
- **WHEN** 工作区代码修改了全文检索的切分规则，而快照来自旧规则下的线上库
- **THEN** 评估使用新规则重建的索引执行用例

#### Scenario: 评估不改动快照
- **WHEN** 对同一份快照连续评估两次
- **THEN** 快照文件内容不变，两次结果相同

### Requirement: 回归用例的收集
回归评估 SHALL 从快照中收集全部 `retrieval_feedback`：可解析且有效期望 ID 非空的反馈成为用例；有效期望 ID 为空的记为“待补充”；无法解析或不合 v1 规则的、以及引用不存在或引用补充记录的补充记录记为“无效”。期望 ID 不在快照中的用例 MUST 记为“无效”，并列出缺失的 ID。

#### Scenario: 待补充的反馈不参与评估
- **WHEN** 快照中有一条没有期望 ID、也没有补充的反馈
- **THEN** 它出现在报告的“待补充”列表中，不计入用例

#### Scenario: 格式不合规的反馈不中断评估
- **WHEN** 快照中有一条 `content` 不是 JSON 的 `retrieval_feedback`
- **THEN** 它出现在报告的“无效”列表中，其余用例照常评估

#### Scenario: 期望 ID 不存在
- **WHEN** 某个用例的期望 ID 在快照中找不到对应记忆
- **THEN** 该用例记为“无效”，报告列出缺失的 ID

### Requirement: 用例的执行
回归评估 SHALL 对每个用例逐条执行其 `queries`，执行前的语句检查、`fts()` 宏展开与行数上限 MUST 与查询端点的默认行为一致，位置参数取自该条的 `args`。执行 MUST 只读。单条查询的出错（语句不允许、宏参数错误、SQL 错误）MUST 被记录在该条查询下，不中断评估。

#### Scenario: 宏在评估中同样展开
- **WHEN** 用例的查询为 `... WHERE memories_fts MATCH fts('渲染') ...`
- **THEN** 评估结果与在查询端点上执行同一语句（同一份数据）的结果相同

#### Scenario: 查询出错被记录
- **WHEN** 用例的某条查询使用 `fts('渲')`
- **THEN** 该条查询记为出错并附带与查询端点相同的错误描述，其它查询照常执行

### Requirement: 命中的判定
期望 ID 在某条查询的结果中以完整的单元格值出现（任意列）即为命中，名次是包含它的第一行的序号（从 1 开始）。一个用例 SHALL 判定为：`pass`（存在一条查询命中全部期望 ID）、`partial`（未达 `pass`，但所有查询合起来至少命中一个）、`fail`（一个都未命中，且至少一条查询成功执行）、`error`（全部查询都出错）。

#### Scenario: 一条查询命中全部期望 ID
- **WHEN** 用例期望 `[A, B]`，其中一条查询的结果第 2 行的 `id` 列为 A、第 5 行为 B
- **THEN** 用例为 `pass`，A 的名次为 2，B 的名次为 5

#### Scenario: 分散在不同查询里只算部分命中
- **WHEN** 用例期望 `[A, B]`，一条查询只命中 A，另一条只命中 B
- **THEN** 用例为 `partial`

#### Scenario: 列名不影响命中
- **WHEN** 查询以 `SELECT m.id AS mid ...` 返回期望 ID
- **THEN** 该 ID 被判定为命中

### Requirement: 报告与基线比较
回归评估 SHALL 输出一份机器可读的报告（每个用例的状态、各查询的命中与名次及错误）和一段人可读的摘要（各状态的计数）。给定基线报告时 MUST 列出状态变好与变差的用例；任何上次为 `pass` 而本次不是 `pass` 的用例都算退化，存在退化时 MUST 以非 0 退出码结束。

#### Scenario: 没有退化
- **WHEN** 与基线相比，没有用例从 `pass` 变为其它状态
- **THEN** 摘要列出改善的用例，退出码为 0

#### Scenario: 出现退化
- **WHEN** 某个用例在基线中为 `pass`，本次为 `fail`
- **THEN** 摘要把它列为退化，退出码非 0

#### Scenario: 基线之后新增的用例
- **WHEN** 本次的某个用例在基线中不存在
- **THEN** 摘要把它列为新增用例，不算退化
