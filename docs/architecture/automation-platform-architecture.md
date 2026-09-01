# 自动化、监督与记忆平台总体设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中 |
| 版本 | 0.3 |
| 日期 | 2026-08-19 |
| 适用产品 | GoodBuddy 桌面端 |
| 文档角色 | Task/Job、调度、目标、并行实验、会话监督、分区记忆与持续学习的总纲 |
| 领域模型 | [Task 与 Job 统一领域模型](../features/task-and-job/task-and-job-model.md) |

## 1. 背景

GoodBuddy 当前已经具备若干长期助手能力，但它们仍是彼此分离的功能：

1. 当前 Schedule 已支持单次、每日和每周触发，并在创建时绑定稳定产品级 Task 与真实
   Conversation；重复触发复用同一身份，文本结果写回 Conversation，独立文件和图片保存为
   Artifact。到期执行与用户在回复期间继续发送的普通消息共用 Conversation 级持久队列，
   因而不会与当前回复并发写入同一时间线。IANA 时区、Cron、事件触发、租约、重试和完整
   Job/Run 抽象仍待实现。
2. 当前智能心跳支持全局或项目范围的每日、每周回顾，读取有界会话、任务和已确认记忆，
   生成摘要、记忆建议和后续任务。
3. 专家执行的 Job 支持有限并发和只读综合，但没有实验变量、重复运行、统一指标和结果晋升。
4. 记忆已有全局、项目、会话三种作用域，以及偏好、事实、摘要、流程四种类型，
   但检索、来源、时态、冲突和运行级隔离仍不完整。
5. 魔法笔记已经提供“内容旁持续出现 AI 评论”的交互，可作为会话监督的体验参考，
   但它只分析笔记或待办，不观察会话和任务运行。

智能心跳长期方向是面向未来的分区记忆，但该模型尚未设计。近期只改善现有心跳的权威入口
与 Global / 多 Project 范围，并保留 Task Center 作为 Task 索引。若继续把 Task、调度、
监督、学习和执行加入“智能心跳”，将无法解释一次后台行为为什么发生、读取了什么、是否
越权、产生了什么影响。

本设计将这些能力统一到一个平台模型中，同时保留不同产品的清晰边界。

## 2. 核心产品判断

### 2.1 智能心跳保持独立，未来分区记忆另行设计

当前智能心跳继续承担周期回顾、报告和建议，并支持 Global 或指定 Project 范围。它不是
Task、通用调度器或后台 Agent，也不进入统一 `AutomationPlan.kind`。未来分区记忆的
数据、状态、唤起和页面需要独立设计，不能从当前方向直接推导。

- Scheduled Task 解决“何时在一个 Task 中执行新的 Job”。
- Goal Task 解决“围绕结果在同一 Task 中持续规划和推进”。
- 并行实验解决“隔离多个候选并用相同标准比较”。
- 会话监督解决“独立观察并在必要时评论、告警或暂停”。
- 智能心跳当前解决“在什么范围周期回顾并提出报告和建议”。
- 记忆系统解决“哪些经验可以在什么范围内被未来运行读取”。
- 持续学习解决“候选经验如何经过评估后改变未来行为”。

这些能力可以共享调度、运行、证据、预算和审计基础，但不能共享一段不断膨胀的提示词。

### 2.2 增加会话监督，但不把它等同于第二个聊天 Agent

建议新增会话监督功能，并借鉴魔法笔记的右侧 AI 评论流：

- 默认只观察和评论，不替用户发言。
- 只依据可见消息、工具事件、任务状态、成果和目标进行判断。
- 不读取或展示模型隐藏推理。
- 评论必须引用具体消息、步骤或证据。
- 模型监督可以建议暂停，只有确定性安全规则或用户预先批准的门禁才能自动暂停。
- 监督器不能自动批准工具、扩大目录、跨项目读取记忆或修改安全策略。

### 2.3 先做分区和来源，再做知识图谱

GoodBuddy 当前最需要的不是立即引入重型图数据库，而是保证：

1. 运行只能读取明确允许的记忆分区。
2. 并行实验的各个 Run 不共享可变记忆。
3. 每条记忆知道来自哪次会话、任务、监督判断或实验结果。
4. 新事实与旧事实冲突时保留时态和证据，不静默覆盖。
5. 记忆进入模型上下文前经过范围、状态、敏感度和预算过滤。

SQLite、FTS 和可选本地向量已经足够支撑第一阶段。只有出现明确的关系追踪和跨实体查询
需求后，才考虑时间知识图谱。

### 2.4 学习必须有评估门和回滚

“生成一条总结并保存”不等于持续学习。只有当候选经验通过回放或实验验证，并能安全改变
未来行为时，才构成学习闭环。

初期自动学习只允许产生可审查候选，不允许自动修改：

- 工具权限和审批策略。
- Electron 安全边界。
- 项目根目录和数据访问范围。
- Runtime 当前用户执行权限与 Ask/Execute 边界。
- 系统级提示词。
- 远程消息发送或其他外部副作用策略。

## 3. 目标

### 3.1 用户目标

- 在现有 Task Center 中找到 Scheduled、Event 和 Goal Task，并直接打开关联 Conversation
  和对应 Task。
- 清楚知道 Task 的触发原因、当前目标、聚合执行状态、预算和停止条件。
- 在一个工作台中观察多个候选运行，并追溯结论到原始证据。
- 为重要会话启用独立监督，及时发现偏题、遗漏、矛盾、证据不足和风险。
- 知道每条记忆属于哪个范围、从哪里产生、何时有效以及被哪些运行使用。
- 审查、批准、拒绝或回滚系统提出的记忆、模板和策略改进。

### 3.2 产品目标

- 复用现有 Project、Conversation、Task、Run、Artifact、Approval 和 Notification 能力。
- 保持每个 Task 只关联一条 Conversation，同时允许一条 Conversation 承载多个 Task，不为
  同一项工作建立第二份内容载体。
- 为所有后台工作提供统一的幂等、租约、恢复、取消、预算和审计语义。
- 保持 Ask 只读，Execute 继续经过现有能力和审批控制。
- 保持本地优先，应用退出后不虚假承诺后台持续执行。
- 保证项目、会话、自动化和实验 Run 之间的记忆隔离。
- 先建立可观测和可评估能力，再允许任何形式的自动行为改变。

## 4. 非目标

本组设计不包含：

- 将 GoodBuddy 变为需要常驻服务器、Redis 或云端控制面的多租户平台。
- 在应用退出后依靠未安装的系统服务继续运行任务。
- 默认允许无人值守高风险 Execute。
- 让模型自行扩大工具、目录、知识库、记忆或网络访问范围。
- 允许多个实验 Run 并发修改同一个用户工作区。
- 记录键盘、持续录屏或静默监控其他应用。
- 把隐藏推理链作为监督、记忆或审计数据保存。
- 初期直接建设通用可视化工作流 DAG 编辑器。
- 将模型评分当作没有误差的客观真值。

## 5. 统一领域模型

以下模型是 Scheduled Task、Goal Task 和实验共享的技术基础，不要求新增独立
Automation Center。`AutomationPlan` 是 Task 的计划配置，`Job` 是 Task 内执行单位，
`Run` 是执行尝试。用户主要通过 Task Center、左侧会话 Task 列表和关联 Conversation
理解工作；当前 UI 不展示 Job/Run 层级。智能心跳
不属于此模型。

### 5.1 核心实体

```text
Conversation
  └─ Task 0..N
       ├─ AutomationPlan（可选）
       │   ├─ TriggerPolicy
       │   ├─ ObjectiveSet
       │   ├─ ExecutionProtocol
       │   ├─ BudgetPolicy
       │   ├─ ApprovalPolicy
       │   ├─ SupervisorPolicy
       │   └─ MemoryBinding
       └─ Job
            ├─ Run
            ├─ Subjob
            ├─ Observation
            ├─ SupervisorDecision
            ├─ Artifact
            ├─ Metric
            └─ MemoryCandidate
```

| 实体 | 职责 |
| --- | --- |
| `Task` | 用户可见工作单位，只关联一条 Conversation；Conversation 可以承载多个 Task |
| `Job` | Task 内部一次步骤、触发、并行分支或委派执行 |
| `Run` | Task/Job 的一次执行尝试和审计记录 |
| `AutomationPlan` | Task 的可编辑计划配置，描述做什么、为何做、何时做和允许做什么 |
| `TriggerPolicy` | 手动、时间、事件或条件触发，以及错过执行策略 |
| `ObjectiveSet` | 成功标准、优化指标、约束和停止条件 |
| `ExecutionProtocol` | 本次运行冻结的提示、步骤模板、变量、Runtime、工具和数据范围 |
| `BudgetPolicy` | 最大耗时、模型调用、Token、工具次数、Job/Subjob 数、成果大小和并发 |
| `ApprovalPolicy` | 哪些动作可自动执行、哪些等待批准、哪些禁止 |
| `SupervisorPolicy` | 观察维度、触发频率、干预级别和确定性门禁 |
| `MemoryBinding` | 运行可读取和可写入哪些记忆分区 |
| `Observation` | 对消息、步骤、工具、指标或系统状态的结构化观察 |
| `SupervisorDecision` | `continue`、`comment`、`warn`、`request_review`、`pause` 或 `stop` |
| `Metric` | 可复现的运行指标及其计算来源 |
| `MemoryCandidate` | 尚未进入未来上下文的候选经验 |

### 5.2 自动化类型

`AutomationPlan.kind` 第一阶段使用有限枚举，而不是任意工作流：

| 类型 | 说明 |
| --- | --- |
| `scheduled_task` | 到点运行一个固定任务 |
| `goal_loop` | 围绕目标重复执行“观察、计划、行动、评估” |
| `experiment` | 生成隔离候选 Run，按统一协议评估和比较 |

会话监督不是独立 Task。用户选择 Conversation、Task 或 Experiment 作为监督对象；
`SupervisorPolicy` 可以在内部观察所属 Job/Run 事件，但当前 UI 不把它们作为独立目标。

### 5.3 运行快照

每次启动必须冻结：

- Plan 版本。
- 项目和工作目录。
- Runtime 和模型配置引用。
- 工作模式。
- 提示和变量。
- 工具、Skills、MCP 和知识库范围。
- 可读、可写记忆分区。
- 监督策略和评估器版本。
- 预算和并发限制。
- 审批策略。

运行开始后的设置变化只影响下一次 Run。用户可以在 Task 执行记录中查看当次快照与最新
Plan 的差异，但 Run 不作为独立导航对象。

## 6. 统一状态模型

### 6.1 Plan 状态

```text
draft → active ↔ paused → archived
```

- `draft`：未通过配置校验，不能自动触发。
- `active`：可以被触发。
- `paused`：保留定义和历史，不产生新 Run。
- `archived`：只读保留，不能恢复运行，复制后可继续使用。

### 6.2 Run 状态

```text
queued
  → running
  → waiting_approval
  → paused
  → evaluating
  → completed

任意活动状态
  → failed | cancelled | interrupted | budget_exceeded | superseded
```

规则：

- `completed` 只表示协议成功结束，不自动表示目标达成。
- `goalStatus` 独立为 `met`、`not_met`、`inconclusive` 或 `not_applicable`。
- 应用退出时活动 Run 标记为 `interrupted`，不自动重放有副作用步骤。
- `waiting_approval` 不占用 LLM 并发配额。
- 预算耗尽必须使用 `budget_exceeded`，不能伪装为普通失败。

### 6.3 Supervisor 状态

```text
inactive → observing → attention_required → paused → resolved
```

监督状态不覆盖 Run 状态。Run 可以仍在运行但存在 `attention_required`，也可以因确定性门禁
进入 `paused`。

## 7. 统一运行循环

### 7.1 调度与执行分离

```text
Trigger
  → AutomationCoordinator 在所属 Task 内声明 Job
  → ExecutionQueue 按优先级和预算排队
  → AutomationExecutor 为 Job 创建或恢复 Run
  → Runtime 执行
  → Supervisor 观察
  → Evaluator 计算指标
  → 结果、证据和候选记忆入库
  → 用户审查或后续执行
```

`AutomationCoordinator` 只负责触发、声明和恢复，不直接调用模型。执行仍通过 Job 和
Runtime 边界完成，用户可见结果通过所属 Task 汇入关联 Conversation。

### 7.2 优先级

默认优先级从高到低：

1. 用户正在等待的前台对话。
2. 用户手动启动的 Task 执行。
3. 等待批准后恢复的 Task 执行。
4. 到期 Scheduled Task 的执行。
5. 目标循环和实验执行。
6. 心跳回顾、记忆巩固和维护。

后台任务必须可被背压延后。延后记录为 `deferred`，不得丢失，也不得在系统恢复空闲时一次性
释放全部积压。

### 7.3 Conversation 输入仲裁

当前实现以 Main 和 SQLite 中的 `conversation_queue_items` 作为每条 Conversation 的权威
输入队列，而不是在 Renderer 分别维护聊天草稿队列和 Scheduled Task 队列：

- 普通消息在发送时冻结 Runtime、工作模式、专家/团队、知识范围和附件上下文，再以
  `source=user` 入队；附件内容使用有界序列化保存，应用重启后仍可恢复。
- 到期或手动启动的 Scheduled Task 先建立 `schedule_run`，再以 `source=schedule` 进入同一
  队列。Scheduler 不再绕过队列直接调用 Runtime。
- Main 对每条 Conversation 只保留一个活动请求或 Renderer 派发保留位。默认按 FIFO 认领；
  全局 Scheduled Task 执行仍受最多 4 项并发限制。
- 用户消息由 Main 派发给 Renderer，由 Renderer 建立用户消息和流式助手消息后调用
  `agent.run`；Scheduled Task 由 Main 直接执行。两条路径共享同一 Conversation 活动锁。
- 当前执行到达终态后再认领下一项。删除只移除尚未执行的项；“立即中断并插入”取消当前
  请求并把所选项设为下一项，不重排其他项。
- 每条 Conversation 最多保留 20 个用户可提交的待执行项。启动时将未完成的派发恢复为
  `pending`，但应用退出期间不会实际执行任务。

Renderer 只通过显式 IPC 列出、加入、删除、提升、释放和接收用户队列项；Main 在接受
`agent.run` 时校验队列项仍处于 `dispatching` 且属于同一 Conversation，防止 Renderer
绕过顺序仲裁。

### 7.4 幂等和租约

- 每次计划触发使用 `planId + scheduledFor + planVersion` 形成幂等键。
- 手动触发使用调用方提供的单次幂等键。
- Run 和长步骤使用租约，租约过期后才能恢复或重试。
- 有外部副作用的步骤还需要工具级幂等键，无法确认结果时进入
  `outcome_unknown`，不得自动重试。
- 同一个 Plan 可以限制最大活动 Run 数，默认 1。

## 8. 触发模型

### 8.1 支持顺序

| 阶段 | 触发类型 |
| --- | --- |
| 第一阶段 | 手动、单次、每日、每周、每月、受限 Cron |
| 第二阶段 | 应用启动、会话完成、任务完成或失败、文件同步完成、变量变化 |
| 后续 | 用户定义的组合条件和外部受信任事件 |

事件触发必须来自 Main 进程内的持久事件，不允许 Renderer 临时事件直接启动高影响自动化。

### 8.2 错过执行策略

| 策略 | 行为 |
| --- | --- |
| `skip` | 记录跳过，不补跑 |
| `run_once` | 无论错过多少次，只补一次 |
| `catch_up_bounded` | 在数量和时间窗口上限内补跑 |

默认：

- 日常摘要使用 `run_once`。
- 高频事件使用 `skip` 或事件去重。
- 不允许无限补跑。

## 9. 目标、协议和实验的关系

```text
目标：想得到什么结果
协议：用什么固定方法尝试
运行：协议的一次执行
实验：同一问题下多个隔离协议或变量组合的运行集合
监督：运行过程中独立判断是否偏离目标、违反约束或需要人工介入
记忆：运行可读的历史经验，以及运行结束后提出的候选经验
```

关键规则：

- 没有可计算或可审查成功标准的目标，不允许宣称“已完成目标”。
- 实验的最佳结果只在成功 Run 中选择。
- 全部 Run 失败时，实验状态为失败，不生成伪最佳结果。
- 模型生成的实验协议必须先由用户审查，或在只读、低成本模板中明确启用自动接受。
- 实验结果不能直接修改生产自动化，只能创建候选版本。

## 10. 监督边界

监督分为两层：

### 10.1 确定性监督

由代码执行，适合：

- 权限、目录和工具白名单。
- Token、耗时、并发和输出大小预算。
- JSON Schema、状态机和幂等约束。
- 明确的停止条件和指标阈值。
- 数据分区和跨范围访问。

确定性监督可以阻止、暂停或终止运行。

### 10.2 模型监督

适合：

- 目标偏移。
- 计划遗漏。
- 结论与证据不一致。
- 多个候选之间的定性差异。
- 用户可能需要澄清的歧义。
- 质量、表达和风险评论。

模型监督默认只评论或请求关注。它不能替代确定性安全边界，也不能自动批准高风险动作。

## 11. 记忆边界

### 11.1 计划读取链

运行只读取显式绑定的分区。推荐优先级：

```text
当前 Run
→ 当前 Automation
→ 当前 Conversation（如有关联）
→ 当前 Project
→ Global
```

每一层都有独立结果数和字符预算。低层记忆不能通过同名内容自动覆盖高层记忆，
冲突必须被标记并交给上下文组装器处理。

### 11.2 写入规则

- Run 只能直接写入自己的运行分区和候选区。
- 向 Automation、Project 或 Global 晋升需要评估或用户确认。
- 实验 Run 不能直接互相读取运行记忆。
- Supervisor 的判断保存为观察或候选，不自动变成事实。
- 被拒绝的候选保留摘要指纹，避免重复建议，同时不进入模型上下文。

## 12. 信息架构

当前阶段保留任务中心并适度完善，不新增独立自动化中心。智能心跳使用自己的菜单入口，
并已在现有模型上实现 Global / 多 Project 范围与唯一配置入口：

```text
任务中心
├─ 需要关注
├─ 进行中
├─ 已暂停
└─ 已结束
   └─ 打开任务自身

任务自身
├─ 消息时间线
├─ Run、步骤与审批活动
├─ 监督、指标与证据
└─ 独立成果

智能心跳
├─ 成长概览
├─ 待处理建议
├─ 心跳轨迹
└─ 心跳计划
   └─ Global / 指定 Project
```

监督统一进入应用级助手工作栏中固定且始终可访问的“监督”栏目，不再保留“独立可折叠右栏”
和“动态新增页签”两种实现。栏目默认跟随当前上下文，用户可以固定到其他 Conversation、
Task 或实验对象；详细范围与交互契约见
[通用助手工作栏与执行空间 PRD](../features/assistant-workbar/prd.md)。

## 13. 安全与隐私

1. Ask 在 Runtime 边界保持只读，而不只是提示词要求只读。
2. Execute 继续通过现有审批、主机执行策略、工具和目录控制。
3. 无人值守只允许用户显式批准的能力集合；遇到未预授权动作时进入等待审批。
4. Supervisor、Evaluator 和 Heartbeat 都把消息、工具输出、记忆和成果视为不可信数据。
5. 监督器不能读取隐藏推理，只能读取产品允许持久化和展示的事件。
6. 所有跨分区读取由 Main 根据绑定关系决定，Renderer 不能提交任意分区 ID。
7. 记忆和监督证据不得包含密钥、认证头、Cookie、完整私有文件或未经限制的工具输出。
8. 自动化产生的通知默认隐藏私人内容。
9. 应用退出时停止调度和新执行，持久化中断状态，释放 Runtime 和租约。
10. 清除项目时按外键和显式事务清理其计划、运行、运行分区、监督记录和候选，
    不影响 Global 或其他项目。

## 14. 可观测性

每次 Task 执行的内部 Job/Run 记录至少保存：

- 触发来源和计划版本。
- 计划目标和当前 `goalStatus`。
- Runtime、工作模式和工作目录。
- 实际读取的知识库与记忆分区。
- 实际调用的模型、Token、工具、耗时和成果大小。
- 当前预算和剩余预算。
- Task、Job 和 Subjob 状态。
- Supervisor 评论、证据、严重度和处理结果。
- 评估器版本、指标和证据。
- 产生的候选记忆或学习产物。
- 重试、延后、中断和恢复原因。

UI 在 Task 下呈现上述信息的有界摘要和活动，不提供 Job/Run 树或独立导航。不得只显示一个
模糊的“自动化成功率”而隐藏失败、跳过或无结论的 Task 执行。

## 15. 建议的数据模型增量

以下为设计建议，字段在实现前仍需共享 Zod Schema 和 SQLite 迁移细化：

```text
automation_plans
automation_plan_versions
automation_triggers
automation_runs
automation_run_events
automation_metrics
automation_observations
supervisor_sessions
supervisor_decisions
memory_namespaces
memory_candidates
learning_artifacts
evaluation_cases
evaluation_results
experiments
experiment_variants
experiment_runs
```

现有 `schedules`、`schedule_runs`、`heartbeat_configs`、`heartbeat_runs`、
`heartbeat_entries`、`tasks` 和 `runs` 不应一次性重写。Schedule 可渐进建立稳定 Task 与
Conversation 关联，旧 child-task 字段可兼容映射到 Job/Subjob；心跳数据保持独立，不得
静默转成 `AutomationPlan` 或顶层 Task。未来分区记忆完成设计前，不新增迁移目标。

## 16. 分阶段实施

### 阶段 0：统一术语和可观测性

- 固定 Task、Conversation、Job、Subjob、Run、Plan、Goal、Protocol、Supervisor、
  Observation、Memory Candidate 等概念。
- 明确 Task N:1 Conversation 关系、左侧行首展开按钮与 Task 子项图标，以及 Task Center
  索引边界，不复制内容。
- 为现有 Scheduled Task 和专家执行建立按 Task 聚合的活动视图。
- 明确当前心跳保持独立，未来分区记忆尚待设计。
- 补充触发来源、运行版本、预算和读写范围展示。

### 阶段 1：调度与运行基础

- 统一 Run 声明、幂等、租约、恢复和错过执行策略。
- 增加月度和受限 Cron。
- 增加后台优先级与并发预算。
- 保持现有任务执行器不变。

### 阶段 2：会话监督与分区记忆

- 上线评论型会话监督。
- 智能心跳配置支持 Global 或指定一个、多个 Project。
- 增加 Automation 和 Run 记忆分区。
- 建立来源、证据、时态、冲突和晋升流程。

### 阶段 3：目标任务

- 增加目标、成功标准、约束、预算和停止条件。
- 支持有界的观察、计划、行动、评估循环。
- 默认 Ask 或需要逐步审批的 Execute。

### 阶段 4：并行实验

- 变量和运行隔离。
- 候选、重复、指标、证据、失败结算和最佳结果选择。
- 复用现有任务和受限子专家并发。

### 阶段 5：持续学习

- 先建立回放集和评估门。
- 再增加候选、Shadow、晋升、监控、衰减和回滚。
- 初期只晋升记忆和自动化模板，不自动改变安全策略。

## 17. 相关文档

- [Task 与 Job 统一领域模型](../features/task-and-job/task-and-job-model.md)
- [Task Center PRD](../features/task-and-job/task-center-prd.md)
- [Scheduled Task PRD](../features/task-and-job/scheduled-task-prd.md)
- [Job 与 Subjob PRD](../features/task-and-job/job-and-subjob-prd.md)
- [智能心跳 PRD](../features/smart-heartbeat/prd.md)
- [并行实验工作台 PRD](../features/parallel-experiments/prd.md)
- [会话监督 PRD](../features/conversation-supervision/prd.md)
- [分区记忆 PRD](../features/memory/prd.md)
- [持续学习与评估门 PRD](../features/continuous-learning/prd.md)
- [GoodBuddy 长期助手功能规划](../roadmap/long-term-assistant-roadmap.md)
- [GoodBuddy 统一界面设计系统](../../UI-DESIGN.md)

## 18. 总体验收标准

- [ ] 智能心跳保持独立，不作为 Task 类型；未来分区记忆尚未设计。
- [ ] Task Center 只索引 Task；每个 Task 只关联一条 Conversation，一条 Conversation 可以
  关联多个 Task。
- [ ] 当前 UI 只展示到 Task，不提供 Job/Subjob/Run 树或独立导航。
- [ ] Scheduled Task 的重复触发和并行 Job 不创建新的顶层 Task。
- [ ] 每次自动执行的内部 Run 都记录触发原因、目标、范围、预算、状态和结果，并在所属
  Task 下提供有界可观测信息。
- [ ] Ask 自动化无法调用写工具或产生外部副作用。
- [ ] Execute 自动化不能绕过现有审批、主机执行策略和能力控制。
- [ ] 会话监督默认只评论，不能替用户发言或批准工具。
- [ ] 并行 Run 的变量、会话、运行记忆、任务和成果相互隔离。
- [ ] 失败 Run 不参与最佳结果选择，全部失败不报告成功。
- [ ] 记忆跨分区读取必须显式授权并可审计。
- [ ] 候选经验在评估门和回滚能力完成前不能自动改变未来行为。
- [ ] 应用重启后状态可恢复，但不会自动重放结果未知的副作用步骤。
