# Job 与 Subjob PRD

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中，未来能力 |
| 版本 | 0.1 |
| 日期 | 2026-08-19 |
| 依赖 | [Task 与 Job 统一领域模型](./task-and-job-model.md) |

## 1. 目标

在不创建额外顶层 Task 或 Conversation 的前提下，让一个 Task 能够分解、串行、并行和委派
多个执行单元，并将进展和结果有序汇入 Task 的同一 Conversation。

## 2. Job 类型

首期只使用有限类型：

- `step`：Task 内一个明确步骤。
- `scheduled_occurrence`：Scheduled Task 的一次到期执行。
- `delegated`：交给 Subagent 或远程执行器。
- `parallel_branch`：并行方案或分工。
- `aggregation`：汇总多个前置 Job。

类型描述执行方式，不创造新的产品对象层级。

## 3. 并行模型

```text
关联 Conversation
  └─ Coordinating Job
       ├─ Parallel Job A
       ├─ Parallel Job B
       ├─ Parallel Job C
       └─ Aggregation Job
```

- 并行 Job 使用同一个 `taskId` 和 `conversationId`。
- 每个 Job 有独立输入快照、状态、Run、预算和输出缓冲。
- 并行 Job 不直接同时追加助手消息。
- Aggregation Job 或 Task 协调器按确定顺序生成一条进展或结果消息。
- 用户可以按 Task 查看有界活动和聚合状态，但不选择或展开单个 Job；主 Conversation
  保持可读。

## 4. Subjob

Job 可以创建有界 Subjob：

- 默认最大深度 2。
- 默认最大并发 3。
- 默认最大子项数、模型调用、Token、耗时和输出大小由父 Job 预算限制。
- 子级只能使用父级已授权能力的子集。
- 父级取消、失败或超时后，活动子级必须取消。

## 5. Subagent

Subagent 是 Job 的执行者：

- 专家选择和路由记录在 Job 上。
- Subagent 的原始流式输出进入有界 Job 缓冲和活动记录。
- 完成、失败和部分输出都返回父 Job。
- Subagent 不获得独立 Task Center 条目或 Conversation。

## 6. 状态与恢复

Job 状态至少包括：

```text
queued → running → waiting_approval → completed
                 ↘ failed | cancelled | interrupted | budget_exceeded
```

- 重试创建新 Run，不覆盖失败 Run。
- 应用退出将活动 Job 标记为 `interrupted`。
- 有外部副作用且结果未知的 Job 不自动重试。
- 聚合 Job 必须明确处理部分成功、全部失败和取消。

## 7. 界面

当前产品 UI 的对象层级止于 Task，不提供 Job/Subjob 树、独立页面或导航入口。

关联 Conversation 和 Task Center 只显示：

- 当前总体进展。
- 并行执行数量和聚合状态。
- 需要审批或用户输入的 Task 状态。
- 完成后的统一结果。

活动与 Runtime 可以按 Task 显示执行者、工具、耗时、预算、错误、审批和成果事件，但不把
Job、Subjob 或 Run 暴露为可选择、可展开或可操作的产品对象。内部标识只用于关联与审计。

## 8. 验收标准

- [ ] 并行 Job 通过所属 Task 写入同一关联 Conversation。
- [ ] Job 不创建顶层 Task。
- [ ] 并行输出不会无序污染消息时间线。
- [ ] Subjob 深度、并发、预算和输出有界。
- [ ] Subagent 失败能够返回部分输出和明确状态。
- [ ] 父级取消传播到所有活动子级。
- [ ] 当前 UI 只展示到 Task，不显示 Job/Subjob/Run 层级。
