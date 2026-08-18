# Task 与 Job 统一领域模型

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 产品边界已确认，部分能力待实施 |
| 版本 | 0.1 |
| 日期 | 2026-08-19 |
| 适用产品 | GoodBuddy 桌面端 |
| 文档角色 | Task、Conversation、Job、Run 与 Subagent 的权威定义 |

## 1. 核心定义

### 1.1 Task

Task 是用户明确创建或由已启用计划创建的工作单位，也是 Task Center 的顶层对象。

- 创建 Task 就创建一条新的 Conversation。
- Task 的内容载体是这条 Conversation，不再维护第二份任务正文或消息时间线。
- 打开 Task 就打开其 Conversation。
- Task 的目标、状态、范围、计划、Job、审批、活动和成果都围绕同一 Conversation 组织。
- 一个 Task 在生命周期内保持同一个 `taskId` 和 `conversationId` 绑定。

普通 Conversation 不自动成为 Task。用户只是聊天时，不应因为存在模型调用或工具步骤就
产生顶层 Task。

### 1.2 Conversation

Conversation 是 Task 的交互和内容载体：

- 保存用户消息、助手消息和面向用户的进展。
- 承载同一 Task 内多个 Job 的可理解汇总。
- 不让并行 Job 直接无序写入同一消息流；由 Task 协调器合并进展和结果。
- 删除、归档和切换范围时遵循 Task 的生命周期规则。

### 1.3 Job

Job 是 Task 内部的执行单位，不是新的顶层 Task：

- 一次计划触发、一个执行步骤、一项专家委派或一组并行工作都可以是 Job。
- 一个 Task 可以串行或并行运行多个 Job。
- 所有 Job 仍属于同一个 Task 和同一条 Conversation。
- Job 可以有自己的状态、预算、Runtime、执行者、输入快照和成果引用。
- Job 不进入 Task Center；它显示在 Task 的时间线、活动或 Runtime 视图中。

### 1.4 Subjob

Subjob 是 Job 的子执行单元。它用于分解和并发，不创建新的 Task 或 Conversation。

- 父 Job 负责合并 Subjob 结果。
- 取消父 Job 必须传播到仍活动的 Subjob。
- Subjob 不能扩大父 Job 的项目、目录、工具、知识、记忆或审批范围。
- 深度、数量、并发、时间、Token 和输出大小必须有界。

### 1.5 Run

Run 是 Task 或 Job 的一次执行尝试和审计记录，不是用户工作对象：

- 重试、恢复或手动重新运行可以产生新的 Run。
- Run 冻结当次配置、范围、预算和 Runtime。
- Run 进入活动记录和审计，不进入 Task Center。
- `completed` 只表示该次执行按协议结束，不必然表示 Task 目标达成。

### 1.6 Subagent

Subagent 是执行 Job 或 Subjob 的受限执行者，不是对象层级：

- 专家、Agent Runtime 或其他执行器可以承担 Job。
- Subagent 不自动拥有独立 Task 或 Conversation。
- Subagent 输出先回到所属 Job，再由 Task 协调器写入同一 Conversation。

## 2. 对象关系

```text
Task 1 ── 1 Conversation
  │
  ├─ Schedule / Trigger Binding（可选）
  ├─ Job 1
  │   ├─ Run 1..N
  │   └─ Subjob 0..N
  ├─ Job 2（可与 Job 1 并行）
  └─ Artifact / Approval / Activity / Notification
```

不允许：

```text
Task → 第二条 Conversation
Job → 新建顶层 Task
Subagent → 自动新建 Conversation
Run → 出现在 Task Center
```

## 3. Scheduled Task

Scheduled Task 仍然是 Task，而不是独立的自动化对象：

1. 用户创建 Scheduled Task。
2. 系统创建一个 Task 和一个 Conversation，并保存 Schedule/Trigger Binding。
3. 到期时在该 Task 内创建新的 Job 和 Run。
4. 每次触发的进展和结果汇入同一个 Task Conversation。
5. 编辑计划影响后续 Job，不修改已经启动的 Run。

同一 Scheduled Task 默认串行触发。需要并行时，应显式允许多个 Job 并发，并继续使用同一
Conversation，而不是复制 Task。

## 4. 状态分层

| 层级 | 典型状态 | 用户在哪里看到 |
| --- | --- | --- |
| Task | queued、running、waiting_approval、paused、completed、failed、cancelled、interrupted | Task Center、Task Conversation |
| Job | queued、running、waiting、completed、failed、cancelled | Task 时间线、活动、Runtime |
| Run | claimed、running、completed、failed、cancelled、interrupted、budget_exceeded | 活动与审计 |

Task 状态由当前目标和所属 Job 聚合得出，但不能用“任一 Job 完成”直接推断 Task 完成。

## 5. 兼容映射

当前代码和旧文档中的对象按以下方式收敛：

| 旧概念 | 目标概念 |
| --- | --- |
| 自动任务 | Scheduled Task、Event Task 或 Goal Task |
| 自动会话 | 删除该独立概念，使用 Task Conversation |
| 子任务、Child Task | Job 或 Subjob |
| 专家子任务 | 由专家 Subagent 执行的 Job/Subjob |
| 多任务并行 | 一个 Task 内多个并行 Job；确实独立的用户目标才创建多个 Task |
| Schedule Run | Scheduled Task 内的 Job Run |
| Automation Run | Task 或 Job 的 Run |

数据库字段可以在兼容期保留旧名称，但新产品文案、PRD 和新增契约必须使用本模型。

## 6. 安全和数据要求

- Main 验证 Task、Conversation、Job、Run 和 Project 的归属链。
- Renderer 不能把任意 Job 绑定到其他 Task 或 Conversation。
- Job/Subjob 继承父级能力上限，只能缩小，不能扩大。
- 并行输出先有界持久化，再按确定顺序汇总到 Conversation。
- 取消、超时、审批和应用退出必须沿 Task → Job → Subjob → Runtime 传播。
- 用户删除 Task 时，先处理活动 Job，再按数据保留规则清理关联对象。

## 7. 验收原则

- [ ] 创建 Task 时只创建一条对应 Conversation。
- [ ] Scheduled Task 的重复触发复用同一 Task Conversation。
- [ ] 一个 Task 可以在同一 Conversation 下运行多个并行 Job。
- [ ] Job、Subjob、Run 和 Subagent 不进入 Task Center。
- [ ] 并行 Job 不直接无序写入 Conversation。
- [ ] 取消和权限范围能够沿层级正确传播。
- [ ] 新文档不再把 Job/Subjob 定义为新的顶层 Task。
