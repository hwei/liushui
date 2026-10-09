# Spec Delta

## ADDED Requirements

### Requirement: 全文检索宏
查询端点 SHALL 支持 `fts('<文本>')` 宏：执行前把它替换为与全文索引同一切分规则生成的检索表达式（字符串字面量），供对全文索引做 `MATCH` 时使用。宏只在 SQL 的代码部分展开；出现在字符串字面量或注释里的 `fts(` MUST 原样保留。宏 MUST 先于结果行数上限的处理展开，`EXPLAIN QUERY PLAN` 中同样展开。

#### Scenario: 用宏做全文检索
- **WHEN** 提交 `SELECT m.id FROM memories_fts f JOIN memories m ON m.id = f.id WHERE memories_fts MATCH fts('渲染') ORDER BY rank`
- **THEN** 返回内容中含“渲染”的记忆，按相关度排序

#### Scenario: 字符串和注释里的宏不展开
- **WHEN** 提交 `SELECT 'fts(''x'')' AS s -- fts('y')`
- **THEN** 返回一行，`s` 的值为 `fts('x')`

### Requirement: 全文检索宏的语义
`fts()` 的文本 SHALL 按空白切分为词：多个词表示须同时出现，词与词之间独立的大写 `OR` 表示任一出现即可，且“同时出现”优先于 `OR`（`a b OR c` 即“a 与 b 同时出现，或 c 出现”）。每个词 MUST 作为短语匹配（其切分单元须连续出现）。文本中的引号与 FTS 运算符 MUST 被当作普通字符，不得改变检索表达式的结构。

#### Scenario: 多个词同时出现
- **WHEN** 库里有“打包时 IL2CPP 报错”与“打包成功”两条记忆，检索 `fts('打包 报错')`
- **THEN** 只命中第一条

#### Scenario: OR 表示任一出现
- **WHEN** 库里有“阴影变糊”与“换了数据库”两条记忆，检索 `fts('阴影 OR 数据库')`
- **THEN** 两条都被命中

#### Scenario: 同时出现优先于 OR
- **WHEN** 库里有“打包时 IL2CPP 报错”“打包成功”“阴影变糊”三条记忆，检索 `fts('打包 报错 OR 阴影')`
- **THEN** 命中第一条与第三条，不命中“打包成功”

#### Scenario: 引号与运算符不破坏表达式
- **WHEN** 检索 `fts('"NEAR" link.xml*')`
- **THEN** 查询正常执行（不报 FTS 语法错误），按普通文字匹配

### Requirement: 全文检索宏的参数限制
`fts()` SHALL 只接受一个字符串字面量参数。以下情况 MUST 以参数错误拒绝且不执行查询：参数不是单个字符串字面量（例如绑定参数 `?` 或列名）、文本为空或只含空白与 `OR`、某个词里含有单独的一个汉字或假名（前后都不是汉字或假名，例如 `渲` 或 `iOS的`）、某个词没有任何可检索的字符（例如只有标点）。错误描述 MUST 指出原因；单字的情况 MUST 提示改用 `LIKE`。

#### Scenario: 单个汉字被拒绝并提示
- **WHEN** 提交 `SELECT id FROM memories_fts WHERE memories_fts MATCH fts('渲')`
- **THEN** 返回参数错误，描述中提示单字检索改用 `LIKE`，且不执行查询

#### Scenario: 词中夹带单字被拒绝
- **WHEN** 提交带 `fts('iOS的')` 的查询
- **THEN** 返回参数错误，描述中提示单字检索改用 `LIKE`，且不执行查询

#### Scenario: 非字面量参数被拒绝
- **WHEN** 提交 `SELECT id FROM memories_fts WHERE memories_fts MATCH fts(?)` 并带参数 `["渲染"]`
- **THEN** 返回参数错误，且不执行查询

#### Scenario: 空文本被拒绝
- **WHEN** 提交带 `fts('  ')` 的查询
- **THEN** 返回参数错误，且不执行查询
