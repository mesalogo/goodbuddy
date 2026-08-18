# Task Center PRD

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中 |
| 版本 | 0.1 |
| 日期 | 2026-08-19 |
| 依赖 | [Task 与 Job 统一领域模型](./task-and-job-model.md) |
| 界面归属 | [通用助手工作栏与执行空间](../assistant-experience/assistant-workbar-and-execution-spaces-prd.md) |

## 1. 产品定义

Task Center 是所有 Task 的应用级单例索引。它不是第二份任务数据，也不是 Automation
Center。点击条目直接打开 Task 自身的 Conversation。

## 2. 收录边界

收录：

- 用户明确创建的 Task。
- Scheduled Task、Event Task 和 Goal Task。
- 未来由用户确认创建的其他顶层 Task。

不收录：

- 普通 Conversation。
- Job、Subjob、Run、工具步骤或 Subagent。
- Smart Heartbeat 配置、报告和建议。
- 仅用于审计的活动记录。

## 3. 列表信息

每条 Task 至少显示：

- 名称和 Global / Project 范围。
- Task 类型和触发来源。
- 当前聚合状态。
- 最近一次面向用户的进展。
- 最近活动时间。
- 等待审批、失败或需要关注数量。
- 下次计划时间（如适用）。

## 4. 交互

- 点击条目打开 Task Conversation。
- 支持按需要关注、进行中、已暂停、已结束筛选。
- 支持暂停、恢复、取消和打开详情，但不在窄栏复制完整 Job 时间线。
- 后台变化更新状态和徽标，不自动抢占当前页面。
- Task 的计划、Job、Run、审批和成果在 Task 自身或对应活动视图管理。

## 5. 验收标准

- [ ] Task Center 只展示 Task。
- [ ] 点击 Task 不会跳转到另一条内容相同的附属 Conversation。
- [ ] Job/Subjob/Run 不会重复成为顶层条目。
- [ ] Scheduled Task 显示下次时间，但每次触发不新增 Task 条目。
- [ ] Smart Heartbeat 不进入 Task Center。
