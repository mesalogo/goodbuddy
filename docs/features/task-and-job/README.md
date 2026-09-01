# Task 与 Job 文档集

本目录定义 GoodBuddy 的工作对象、内部执行单元和调度关系。

## 权威文档

1. [Task 与 Job 统一领域模型](./task-and-job-model.md)：术语、身份和对象关系。
2. [Task Center PRD](./task-center-prd.md)：Task 的应用级索引。
3. [Scheduled Task PRD](./scheduled-task-prd.md)：时间或事件触发的 Task。
4. [Goal Task PRD](./goal-task-prd.md)：围绕可验证结果有界推进的 Task。
5. [Job 与 Subjob PRD](./job-and-subjob-prd.md)：Task 内部串行、并行和委派执行。

## 阅读顺序

先阅读统一领域模型。其他功能文档不得重新定义 Task、Conversation、Job、Run 或 Subagent。
若实现与文档出现冲突，应先修正统一模型，再同步功能 PRD。

## 相关功能

- [直连模型 Agent 能力](../direct-model-agent/README.md) 使用本目录定义的 Subagent 与
  Job/Subjob 语义，为直连模型提供单层编程委派，但不重新定义产品对象层级。
