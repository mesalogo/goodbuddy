# Task Center PRD

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | Scheduled Task 首期已实现；Goal/Event Task 与完整操作待实施 |
| 版本 | 0.3 |
| 日期 | 2026-08-19 |
| 依赖 | [Task 与 Job 统一领域模型](./task-and-job-model.md) |
| 界面归属 | [通用助手工作栏与执行空间](../assistant-experience/assistant-workbar-and-execution-spaces-prd.md) |

## 1. 产品定义

Task Center 是所有产品级 Task 的应用级单例索引，不是 Automation Center，也不复制
Conversation 内容。点击条目打开其关联 Conversation，并定位或展开对应 Task。

每个 Task 只关联一条 Conversation；一条 Conversation 可以关联零个、一个或多个 Task。
Conversation 不因为关联 Task 而改变对象类型。

## 2. 收录边界

收录：

- 用户明确创建或确认的 Task。
- Scheduled Task、Event Task 和 Goal Task。
- 未来由用户确认创建的其他顶层 Task。

不收录：

- 没有显式 Task 关联的普通 Conversation。
- 普通模型请求或工具调用产生的内部执行记录。
- Job、Subjob、Run、工具步骤或 Subagent。
- Smart Heartbeat 配置、报告和建议。
- 仅用于审计的活动记录。

当前产品 UI 的对象层级止于 Task。Task Center、左侧会话列表和 Conversation 任务区都不显示
Job/Subjob/Run 树、独立详情或路由。

## 3. 列表信息

每条 Task 至少显示：

- 名称和 Global / Project 范围。
- 关联 Conversation 标题。
- Task 类型和触发来源。
- Ask / Execute 模式。
- 当前聚合状态。
- 最近一次面向用户的进展。
- 最近活动时间。
- 等待审批、失败或需要关注状态。
- 下次计划时间（如适用）。

Task 行只显示聚合后的用户状态，不要求用户理解内部 Job/Run。

## 4. 交互

- 点击条目打开关联 Conversation，并定位到该 Task。
- 支持按需要关注、进行中、已暂停、已结束筛选。
- 支持立即运行、暂停、恢复、取消、编辑和删除。
- 后台变化更新状态和徽标，不自动抢占当前页面。
- 立即运行、重试和恢复在 UI 上都是 Task 操作，内部 Job/Run 不单独显示。
- 完整消息留在 Conversation；工具、审批和错误可以在活动或 Runtime 中按 Task 查看；
  独立交付物在成果中查看。

## 5. 左侧 Conversation Task 列表

左侧最近会话列表承担轻量 Task 发现，不替代 Task Center：

```text
▾ 产品发布讨论                           10:24

   每周进度总结       每周 · Execute · 等待中 ●
   发布前检查                     单次 · Execute ✓
```

- 无 Task 的 Conversation 保持现有单行样式。
- 有 Task 时在行最左侧显示独立展开按钮；父会话行不重复显示任务标签或数量。
- 会话标题溢出时保持时间和操作区固定；悬停会话行后，标题在自身裁切区域内横向滑动展示
  完整名称。未溢出标题不滑动，减少动态效果偏好下使用完整标题提示而不产生位移。
- 展开后每个 Task 子项左侧显示名称，右侧显示本地化的模式、计划和状态标记，与父会话
  更新时间对齐；已完成使用带勾成功点并将文案保留给辅助技术。列表不显示 Job、Subjob、
  Run 或工具步骤。
- 点击 Conversation 标题打开聊天；点击 Task 打开同一 Conversation 并定位该 Task。
- 新建 Task 后首次自动展开；用户手动折叠后保持选择。
- 后台状态变化不强制展开；Task 状态持续显示在展开后的子项和 Task Center 中。
- 默认最多显示 3 个 Task；“查看全部 N 个任务”打开该 Conversation 的完整任务区。

## 6. Conversation 任务区

包含 Task 的 Conversation 顶部显示可折叠任务区：

```text
本会话有 2 个任务
[每周进度总结] [发布前检查]                         [管理任务]
```

选择 Task 后显示名称、模式、聚合状态、计划、下次执行、最近结果和 Task 级操作。工具、审批、
错误和成果通过 Task 关联显示，但不暴露 Job/Run 层级。

## 7. 删除关系

- 删除 Schedule 只停止后续触发，不删除 Task、Conversation 或历史。
- 删除 Task 停止其计划并移除关联，默认保留 Conversation 和既有消息。
- 删除最后一个 Task 后，左侧 Conversation 的展开按钮消失。
- 删除 Conversation 前必须显示关联 Task 数量，并先停止或结算活动执行。

## 8. 验收标准

- [x] Task Center 只展示产品级 Task。
- [x] 一条 Conversation 可以关联并展开多个 Task。
- [x] 点击 Task 打开正确 Conversation 并定位到对应 Task。
- [x] 左侧会话列表通过独立展开按钮显示带任务图标和本地化摘要的 Task 子项。
- [x] 当前 UI 不显示 Job/Subjob/Run 树或独立页面。
- [x] Scheduled Task 显示下次时间，但每次触发不新增 Task 条目。
- [x] 普通模型请求和工具调用不会误显示为 Task。
- [ ] 删除 Task 默认保留 Conversation 和既有消息。
- [x] Smart Heartbeat 不进入 Task Center。
