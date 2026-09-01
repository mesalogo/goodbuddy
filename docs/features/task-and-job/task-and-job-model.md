# Task 与 Job 统一领域模型

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 产品边界与 Scheduled Task 首期已实现；通用 Job/Run 能力待实施 |
| 版本 | 0.3 |
| 日期 | 2026-08-19 |
| 适用产品 | GoodBuddy 桌面端 |
| 文档角色 | Task、Conversation、Job、Run 与 Subagent 的权威定义 |

## 1. 核心定义

### 1.1 Task

Task 是用户明确创建或确认的工作单位，也是 Task Center 的顶层对象。

- 每个 Task 必须关联且只关联一条 Conversation。
- 创建 Task 时，用户可以关联当前 Conversation，也可以同时创建一条新 Conversation。
- 关联当前 Conversation 不改变其对象类型、标题、既有消息或普通聊天能力，只增加 Task
  关联及其可见入口。
- Task 的目标、状态、范围、计划、Job、审批、活动和成果使用独立 Task 身份保存。
- 打开 Task 会打开关联的 Conversation，并定位或展开对应 Task。
- 一个 Task 在生命周期内保持稳定的 `taskId` 和 `conversationId` 关联。
- 删除 Task 默认停止其计划并移除关联，不删除 Conversation 或既有消息。

普通模型请求、工具调用或 Runtime Run 不自动成为产品级 Task。只有用户明确创建、确认或
由已启用产品流程创建的工作，才进入 Task Center 和 Conversation 的 Task 列表。

### 1.2 Conversation

Conversation 是用户消息、助手消息和面向用户结果的内容容器，不因为关联 Task 而变成另一
种 Conversation：

- 一条 Conversation 可以不关联 Task，也可以关联一个或多个 Task。
- 多个 Task 可以共享同一 Conversation 的可见上下文，但各自拥有独立配置、计划、权限
  快照、状态、Job、Run 和成果引用。
- Conversation 标题与 Task 名称相互独立。创建或重命名 Task 不静默修改现有会话标题。
- 从稳定的本地 Conversation 创建分支会生成新的 Conversation 和消息 ID，并保存直接来源
  标识；它只复制可见聊天内容与会话级 Runtime/知识检索选择，不复制 Task、发送队列、Job、
  Run、记忆或 Artifact 归属。来源与分支后续独立更新，删除来源不删除已创建的分支。
- 左侧会话列表根据显式 Task 关联显示行首展开按钮；父会话行不重复任务标签，展开后的
  Task 子项左侧显示名称，右侧显示状态标记，并只展开到 Task 层。
- 并行 Job 不直接无序写入消息流；进度留在各自 Task/Job 状态中，最终文本以带来源元数据
  的完整消息写入 Conversation。
- 删除 Conversation 前必须说明关联 Task 数量，并先停止或结算仍活动的 Job。

### 1.3 Job

Job 是 Task 内部的执行单位，不是新的顶层 Task：

- 一次计划触发、一个执行步骤、一项专家委派或一组并行工作都可以是 Job。
- 一个 Task 可以串行或并行运行多个 Job。
- 所有 Job 仍属于同一个 Task，并通过该 Task 关联的 Conversation 呈现用户可见结果。
- Job 可以有自己的状态、预算、Runtime、执行者、输入快照和成果引用。
- Job 不进入 Task Center、左侧会话列表或独立详情页。当前产品 UI 的对象层级止于 Task；
  活动和 Runtime 只按 Task 展示有界执行事件、工具、审批与错误，不呈现 Job 树。

### 1.4 Subjob

Subjob 是 Job 的子执行单元。它用于分解和并发，不创建新的 Task 或 Conversation。

- 父 Job 负责合并 Subjob 结果。
- 取消父 Job 必须传播到仍活动的 Subjob。
- Subjob 不能扩大父 Job 的 Project、目录、工具、知识、记忆或审批范围。
- 深度、数量、并发、时间、Token 和输出大小必须有界。

### 1.5 Run

Run 是 Job 或 Subjob 的一次执行尝试和审计记录，不是用户工作对象：

- 重试、恢复或手动重新运行可以产生新的 Run。
- Run 冻结当次配置、范围、预算、Runtime 和权限策略。
- Run 进入内部审计；当前 UI 可以显示某次 Task 执行的时间、状态和活动，但不把 Run 呈现为
  可导航的产品对象。
- `completed` 只表示该次执行按协议结束，不必然表示 Task 目标达成。

### 1.6 Subagent

Subagent 是执行 Job 或 Subjob 的受限执行者，不是对象层级：

- 专家、Agent Runtime 或其他执行器可以承担 Job。
- Subagent 不自动拥有独立 Task 或 Conversation。
- Subagent 输出先回到所属 Job，再由 Task 协调器写入关联 Conversation。

## 2. 对象关系

```text
Conversation 1 ── 0..N Task
                      │
                      ├─ Schedule / Trigger Binding（可选）
                      ├─ Job 1
                      │   ├─ Run 0..N
                      │   └─ Subjob 0..N
                      │       └─ Run 0..N
                      ├─ Job 2（可与 Job 1 并行）
                      └─ Artifact / Approval / Activity / Notification
```

从 Task 方向看：

```text
Task N ── 1 Conversation
```

不允许：

```text
Task → 没有关联 Conversation
Task → 同时关联多条 Conversation
Job → 新建顶层 Task
Subagent → 自动新建 Conversation
Job / Run → 成为可独立导航的 UI 对象
```

## 3. 创建 Task

创建定制 Task 时必须明确选择 Conversation：

```text
关联当前 Conversation
或
创建新 Conversation
```

- 从当前聊天发起时，默认选择当前 Conversation。
- 从 Task Center 发起时，默认选择新 Conversation。
- 选择当前 Conversation 时持续显示会话标题、Project 和已有 Task 数量。
- 选择新 Conversation 时，默认使用 Task 名称作为会话标题，但允许用户修改。
- Task、Conversation 关联和可选 Schedule Binding 必须在 Main 中原子创建或回滚。

## 4. Scheduled Task

Scheduled Task 仍然是 Task，而不是 Schedule 定义和临时 Task 的松散组合：

1. 用户选择当前或新 Conversation。
2. 系统创建一个 Task，建立稳定 `conversationId` 关联，并保存 Schedule/Trigger Binding。
3. 到期时在该 Task 内创建新的 Job 和 Run。
4. 每次触发的进展和文本结果写入同一关联 Conversation。
5. 独立文件、图片和其他交付物保存为 Artifact，并从结果消息引用。
6. 编辑计划影响后续 Job，不修改已经启动的 Run。

同一 Scheduled Task 默认串行触发。需要并行时，应显式允许多个 Job 并发，并继续使用同一
Task 和 Conversation 关联，而不是复制顶层 Task。

## 5. 消息归属

Task 产生的用户可见消息至少记录：

```ts
type TaskMessageMetadata = {
  taskId: string
  jobId: string
  runId: string
  trigger: 'manual' | 'scheduled' | 'event' | 'goal'
}
```

同一 Conversation 关联多个 Task 时：

- 消息持续显示来源 Task 名称。
- 点击左侧展开项或 Task Center 条目可以定位对应 Task 和近期消息。
- 任务筛选只改变定位和高亮，不隐藏用户未主动筛选的普通消息。
- 多个活动 Job 的流式细节进入各自活动记录，最终文本有界持久化后再写入 Conversation。

## 6. 状态分层

| 层级 | 典型状态 | 用户在哪里看到 |
| --- | --- | --- |
| Task | idle、queued、running、waiting_approval、paused、completed、failed、cancelled、interrupted | Task Center、左侧会话展开项、Conversation |
| Job | queued、running、waiting_approval、completed、failed、cancelled | 内部协调与审计，不作为 UI 对象 |
| Run | claimed、running、completed、failed、cancelled、interrupted、budget_exceeded、outcome_unknown | 内部执行与审计，不作为 UI 对象 |

Task 状态由当前目标和所属 Job 聚合得出，但不能用“任一 Job 完成”直接推断 Task 完成。
Conversation 折叠行只显示其关联 Task 中最高优先级的关注状态：

```text
waiting_approval > failed > running > paused > idle
```

## 7. UI 展示边界

当前产品 UI 的对象层级统一止于 Task：

- 左侧会话列表展开到 Task。
- Task Center 只索引 Task。
- Conversation 顶部任务区只选择和管理 Task。
- 活动与 Runtime 可以展示 Task 的执行时间、工具、审批、错误、成果和状态事件，但不显示
  Job/Subjob 树，不提供 Job/Run 路由、列表或独立操作菜单。
- “立即运行”“重试”和“恢复”在 UI 上都是 Task 操作；Job/Run 只在内部创建和审计。

## 8. 左侧 Conversation Task 列表

左侧最近会话列表是轻量发现入口，不替代 Task Center：

- 无 Task 的 Conversation 保持现有单行样式。
- 有 Task 的 Conversation 显示行首展开按钮，父会话行不重复任务标签或数量。
- 展开后只显示名称、本地化摘要和右侧状态标记，不继续显示 Job、Subjob 或 Run。
- 新建 Task 成功后首次自动展开；用户手动折叠后保持选择，后台状态变化不强制展开。
- 默认最多直接显示 3 个 Task；“查看全部 N 个任务”打开该 Conversation 的完整 Task 区。
- Task 子项的状态标记固定在右侧；运行、审批、失败和暂停同时使用本地化状态文字。
- 删除最后一个关联 Task 后，Conversation 的展开按钮自动消失。

## 9. 兼容映射

当前代码和旧文档中的对象按以下方式收敛：

| 旧概念 | 目标概念 |
| --- | --- |
| 自动任务 | Scheduled Task、Event Task 或 Goal Task |
| 自动会话 | 删除该独立概念，使用关联 Conversation |
| 子任务、Child Task | Job 或 Subjob |
| 专家子任务 | 由专家 Subagent 执行的 Job/Subjob |
| 多任务并行 | 一个或多个 Task 下的并行 Job；根据用户目标和 Conversation 归属明确建模 |
| Schedule Run | Scheduled Task 内的 Job Run |
| Automation Run | Task 所属 Job 或 Subjob 的 Run |
| 普通请求 Task 行 | 内部执行/审计记录，不自动成为产品级 Task |

数据库字段可以在兼容期保留旧名称，但新产品文案、PRD 和新增契约必须使用本模型。

## 10. 安全和数据要求

- Main 验证 Conversation、Task、Job、Run 和 Project 的完整归属链。
- Task 只能关联同一 Project 范围内允许使用的 Conversation。
- Renderer 不能把任意 Task 或 Job 绑定到其他 Project 的 Conversation。
- Job/Subjob 继承 Task 的能力上限，只能缩小，不能扩大。
- Execute Task 冻结 Runtime、工作目录、工具和审批策略；后台触发不能扩大权限。
- 并行输出先有界持久化，再按确定顺序汇总到 Conversation。
- 取消、超时、审批和应用退出必须沿 Task → Job / Subjob → Run → Runtime 传播。
- 删除 Task 默认保留 Conversation 和消息；删除 Conversation 必须处理其全部关联 Task。

## 11. 验收原则

- [ ] 每个 Task 只关联一条 Conversation。
- [ ] 一条 Conversation 可以关联零个、一个或多个 Task。
- [ ] 创建 Task 可以选择当前 Conversation 或新 Conversation，且不会改变当前会话类型。
- [ ] 左侧会话列表通过行首按钮展开带任务图标和本地化摘要的 Task，但不展开 Job/Run。
- [ ] 当前 UI 不提供 Job、Subjob 或 Run 的独立列表、树、路由或操作菜单。
- [ ] Scheduled Task 的重复触发复用同一 Task 和 Conversation 关联。
- [ ] 一个 Task 可以运行多个串行或并行 Job。
- [ ] Job、Subjob、Run 和 Subagent 不进入 Task Center，也不成为其他可导航 UI 对象。
- [ ] Task 消息可以通过 `taskId`、`jobId` 和 `runId` 追溯来源。
- [ ] 并行 Job 不直接无序写入 Conversation。
- [ ] 取消和权限范围能够沿层级正确传播。
