# memory-ledger Specification

## Purpose

定义记忆流水账的记录模型：只追加、不可改写，具备由内容确定的稳定 ID 与可自由增删字段的 meta，使其成为系统唯一的事实来源，所有派生数据均可由它重建。

## Requirements

### Requirement: 记录字段
每条记忆 SHALL 包含 `id`、`ts`、`author`、`kind`、`content`、`meta`、`received_at`、`schema_v`。`ts` 与 `author` 由客户端提供，`received_at` 由服务端在接收时写入，`schema_v` 标识记录所用的 schema 版本。`kind` 的取值不受限于固定枚举，初始约定包含 `note`。

#### Scenario: 写入后可读回完整字段
- **WHEN** 成功追加一条 `kind=note` 的记忆
- **THEN** 库中存在该记录，且上述全部字段均有值（`meta` 可为空对象）

#### Scenario: 缺少必填字段被拒绝
- **WHEN** 追加请求缺少 `ts`、`author`、`kind` 或 `content` 之一
- **THEN** 系统拒绝该请求并说明缺失字段，库中不新增记录

### Requirement: 只追加
流水账 SHALL 只允许追加。系统 MUST NOT 提供修改或删除已有记录的接口，也 MUST NOT 在追加过程中改写已有记录。

#### Scenario: 不存在改写路径
- **WHEN** 客户端尝试通过任何公开接口更新或删除既有记录
- **THEN** 系统不提供该操作，既有记录保持不变

### Requirement: 确定性 ID
记录的 `id` SHALL 由 `ts`、`author`、`kind`、`content` 以及附件内容的 sha256（若有）经规范化后计算得到，与所属库、`meta`、`received_at` 无关。相同输入 MUST 得到相同 ID，任一输入不同则 ID 不同。

#### Scenario: 相同核心字段得到相同 ID
- **WHEN** 两次计算使用相同的 `ts`、`author`、`kind`、`content`，但 `meta` 或目标库不同
- **THEN** 得到相同的 `id`

#### Scenario: 内容不同得到不同 ID
- **WHEN** 仅 `content` 相差一个字符
- **THEN** 得到不同的 `id`

#### Scenario: 规范化消除表示差异
- **WHEN** 同一份核心字段以不同的 JSON 键顺序或等价的时间表示提交
- **THEN** 计算出的 `id` 相同

### Requirement: 幂等追加
以相同核心字段重复追加 SHALL 不产生重复记录。重复请求 MUST 成功返回既有记录的 `id` 并标明其为已存在，既有记录不被覆盖。

#### Scenario: 重试不重复
- **WHEN** 同一条记忆因网络失败被客户端重试而提交了两次
- **THEN** 库中只有一条该记忆，两次请求都返回相同的 `id`

#### Scenario: 已存在的记录不被改写
- **WHEN** 重复请求携带不同的 `meta`
- **THEN** 既有记录的 `meta` 与 `received_at` 保持首次写入时的值

### Requirement: 可扩展的 meta
`meta` SHALL 是一个键值结构，允许任意增删字段而无需变更库结构。键使用点号分层命名（如 `git.branch`），值可缺省，采集不到的字段 MUST 省略而不是写入空串。系统 MUST 支持在查询中按 meta 字段过滤。

#### Scenario: 新增字段无需迁移
- **WHEN** 客户端提交带有此前从未出现过的 meta 键的记忆
- **THEN** 记忆被成功写入，该键可在后续查询中被读取

#### Scenario: 缺省字段不占位
- **WHEN** 客户端无法采集某个 meta 字段
- **THEN** 该键不出现在写入的 `meta` 中

### Requirement: schema 版本标记
每条记录 SHALL 记录其写入时的 `schema_v`。较新的 schema 版本 MUST 保持对旧版本记录的可读，且不得要求改写旧记录。

#### Scenario: 旧记录在新版本下可读
- **WHEN** 系统升级到更高的 `schema_v` 后读取升级前写入的记录
- **THEN** 旧记录可正常读取，其内容与 `schema_v` 不变

### Requirement: 时间字段的语义
`ts` 由客户端提供，并在同一条记忆的重试中 MUST 保持不变（这是幂等的前提），因此它可能与服务端时钟不一致。`received_at` 由服务端在接收时写入。系统 MUST NOT 假设 `received_at` 晚于或等于 `ts`。需要时间先后语义的功能（排序、增量拉取、时间窗口过滤）SHALL 以 `ts` 为依据，`received_at` 只作服务端视角的旁证。

#### Scenario: 客户端时钟超前时记录仍按原值保存
- **WHEN** 提交的 `ts` 晚于服务端写入的 `received_at`
- **THEN** 记录被接受，两个字段都按各自的原始值保存，不做纠正、不做交换，也不因此拒绝请求
