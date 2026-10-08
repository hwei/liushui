# Spec Delta

## ADDED Requirements

### Requirement: 时间字段的语义
`ts` 由客户端提供，并在同一条记忆的重试中 MUST 保持不变（这是幂等的前提），因此它可能与服务端时钟不一致。`received_at` 由服务端在接收时写入。系统 MUST NOT 假设 `received_at` 晚于或等于 `ts`。需要时间先后语义的功能（排序、增量拉取、时间窗口过滤）SHALL 以 `ts` 为依据，`received_at` 只作服务端视角的旁证。

#### Scenario: 客户端时钟超前时记录仍按原值保存
- **WHEN** 提交的 `ts` 晚于服务端写入的 `received_at`
- **THEN** 记录被接受，两个字段都按各自的原始值保存，不做纠正、不做交换，也不因此拒绝请求
