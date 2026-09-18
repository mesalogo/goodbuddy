# Task 与 Job 文档集

本目录定义 GoodBuddy 的工作对象、内部执行单元和调度关系。

## 权威文档

1. [Task 与 Job 统一领域模型](./task-and-job-model.md)：术语、身份和对象关系。
2. [Task Center PRD](./task-center-prd.md)：Task 的单实例项目跟随索引与范围切换。
3. [Scheduled Task PRD](./scheduled-task-prd.md)：时间或事件触发的 Task。
4. [Goal Task PRD](./goal-task-prd.md)：围绕可验证结果有界推进的 Task。
5. [Job 与 Subjob PRD](./job-and-subjob-prd.md)：Task 内部串行、并行和委派执行。
6. [技术设计](./technical-design.md)：统计查询契约、请求证据与不完整数据边界，以及立即创建的事务和入队规则。

正式功能范围固定为当前项目：顶部显示当前会话消息总数和 Agent 累计回复时间，下方列出本项目全部会话的任务。创建默认立即执行并关联当前会话，可选择本项目其他会话、新会话或定时周期；产品与验收规则见 Task Center PRD 和 Scheduled Task PRD。

## 阅读顺序

[当前会话统计 Demo](./hierarchy-demo.html) 用于评审任务中心中的紧凑统计区：上方显示当前会话的消息数与 Agent 累计回复时长，下方管理当前项目全部会话的任务及用时。切换会话只更新会话统计，任务范围固定为当前项目，没有全局或所有项目入口。支持状态筛选、定位所属会话，以及暂停、继续和取消任务的模拟操作。新建任务支持填写内容、关联本项目已有或新建会话、立即或定时执行；仅在页面内模拟，刷新后恢复样例。
配套 `hierarchy-demo.css` 与 `hierarchy-demo.js` 仅服务于该静态原型；使用演示数据，未接入产品。
项目任务标题右侧依次为 `＋` 新建按钮与筛选图标，状态筛选默认收起；应用筛选后图标高亮并显示当前筛选条件。
时间为固定样例，Demo 从每次回复的起止秒数计算。正式功能按请求有效区间累计，包含轮内工具和审批等待、不计轮间空闲；任务用时按 `schedule_runs` 关联请求汇总，不按父任务生命周期计算。缺失历史有提示，远程缺少可靠证据时不推算用时，数据来源与边界以技术设计为准。

先阅读统一领域模型。其他功能文档不得重新定义 Task、Conversation、Job、Run 或 Subagent。
若实现与文档出现冲突，应先修正统一模型，再同步功能 PRD。

## 相关功能

- [本机专用推理架构与任务控制评估](../../architecture/local-inference-task-control.md)记录 ASR、OCR、embedding 的任务与服务状态、执行所有权、取消、超时、清理及观测待办；推理请求不自动等同于本目录的产品 Task，候选迁移尚未采用。
- [直连模型 Agent 能力](../direct-model-agent/README.md) 使用本目录定义的 Subagent 与
  Job/Subjob 语义，为直连模型提供单层编程委派，但不重新定义产品对象层级。
