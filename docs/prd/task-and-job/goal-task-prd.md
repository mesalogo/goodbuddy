# Goal Task PRD

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中，未来能力 |
| 版本 | 0.1 |
| 日期 | 2026-08-19 |
| 依赖 | [Task 与 Job 统一领域模型](./task-and-job-model.md) |

## 1. 产品定义

Goal Task 是围绕可验证结果持续推进的 Task。它仍然只有一个 Task Conversation；每轮观察、
计划、行动和评估由 Job/Run 表达，不创建一串顶层 Task。

## 2. 必要配置

- 目标描述。
- 至少一个成功标准。
- 约束和停止条件。
- 最大轮数、截止时间或预算。
- 每轮评估方式。
- 无进展处理。
- Project、Runtime、知识、记忆、目录、工具和审批范围。

## 3. 有界循环

```text
Observe Job
  → Planning Job
  → Permission and budget check
  → Action Job / parallel Jobs
  → Evaluation Job
  → Complete, pause, revise or continue
```

循环内的所有 Job 共享 Task Conversation。只有协调器把有意义的阶段进展写入消息时间线，
避免每个内部步骤产生一条顶层任务或杂乱消息。

## 4. 完成和无进展

- 模型声明不能单独证明目标完成。
- 成功标准必须可计算或可人工审查。
- 连续两轮没有指标改善、重复下一步、连续失败、权限不可用或预算不足时暂停。
- 修改范围、预算、Runtime、工作模式或权限必须用户确认。

## 5. 验收原则

- [ ] Goal Task 只有一个 Task Conversation。
- [ ] 循环步骤以 Job 表达，不创建顶层子 Task。
- [ ] 没有成功标准和停止条件时不能启用。
- [ ] 无进展和预算耗尽不会伪装为成功。
