# Scheduled Task PRD

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 首期稳定 Task 生命周期、创建体验与 Conversation 输入仲裁已实现；高级触发和执行治理待实施 |
| 版本 | 0.7 |
| 日期 | 2026-08-19 |
| 依赖 | [Task 与 Job 统一领域模型](./task-and-job-model.md) |
| 相关架构 | [自动化平台总体设计](../../architecture/automation-platform-architecture.md) |

## 1. 产品定义

Scheduled Task 是带时间或事件触发器的 Task。每个 Scheduled Task 关联一条 Conversation；
一条 Conversation 可以同时承载多个 Task。

创建 Scheduled Task 时：

1. 用户选择关联当前 Conversation 或创建新 Conversation。
2. 系统创建一个 Task，并保存稳定 `conversationId` 和 Schedule/Trigger Binding。
3. 每次触发在同一 Task 内创建新的 Job 和 Run。
4. 面向用户的文本进展和结果写回关联 Conversation，并标明 Task 来源。
5. 独立交付物保存为 Artifact，并由结果消息引用。

因此，一个每日任务在 Task Center 中始终是一条 Task，而不是每天新增一条 Task；左侧会话
列表通过行首展开按钮和带任务图标的子项呈现其关联。

## 2. 当前能力与差距

GoodBuddy 当前已实现首期统一生命周期：

- 创建 Modal 可以关联当前 Conversation 或原子创建新 Conversation，不修改当前
  Conversation 的标题和既有消息。
- 每个 Schedule 绑定一个稳定产品级 Task 和 Conversation；重复触发复用同一身份，不再
  为每次触发创建新的顶层 Task。
- 默认选择 Execute，并允许用户主动切换 Ask；不支持工具执行时明确禁用 Execute。
- 单次、每日和每周计划支持暂停、恢复、立即运行、应用重启恢复和最多 4 个独立计划并发。
- 到期和手动运行先进入关联 Conversation 的持久输入队列，与回复期间继续发送的普通消息
  顺序仲裁；默认不打断当前回复，也不与其并发写入时间线。
- Composer 上沿显示待发送项和来源。用户可以删除尚未执行的 occurrence，或选择“立即
  中断并插入”取消当前执行并将该项提升为下一项。
- 文本结果和失败写回关联 Conversation 并带 Task 来源；独立文件和图片继续保存为 Artifact。
- 左侧 Conversation 列表、Conversation Task 区和 Task Center 使用同一产品 Task；普通
  模型请求、Subagent、委派和 Smart Heartbeat 内部 Task 不进入产品索引。
- v22 迁移保留 Schedule 配置和历史运行，并为旧计划补齐稳定 Task 与 Conversation；v23
  增加可恢复的统一 Conversation 输入队列。

尚未实现的高级能力包括 IANA 时区与 DST 墙上时间、每月/工作日/受限 Cron、事件触发、
可配置错过执行策略、租约、重试与结果未知治理、完整预算和权限快照，以及面向内部
Job/Subjob/Run 的统一持久化抽象。当前每日和每周按既有 UTC 间隔递推。

## 3. 目标

- 支持单次、每日、每周、每月、工作日和受限 Cron。
- 支持 Task 完成、失败、Conversation 完成等内部事件触发。
- 创建时明确选择当前或新 Conversation。
- 默认使用 Execute，并允许用户主动切换到 Ask。
- 冻结 Project、Runtime、工作目录、工具、知识、记忆和审批范围。
- 提供时区、错过执行、幂等、租约、重试、恢复、取消、预算和审计。
- 让所有重复触发复用同一 Task 和 Conversation 关联。
- 为一次触发建立清晰 Job/Run，而不是创建新的顶层 Task。

## 4. 非目标

- 不提供任意脚本和循环的通用 DAG 编辑器。
- 不允许模型生成并直接启用任意 Shell、SQL 或无限频率 Cron。
- 不承诺应用退出后继续运行。
- 不允许后台计划静默扩大权限、目录、知识、记忆或网络范围。
- 不把 Smart Heartbeat 变成 Scheduled Task。
- 不把每次触发、重试、Job 或 Run 显示为新的顶层 Task。
- 不在左侧会话列表继续展开 Job、Subjob 或 Run。

## 5. 创建入口与 Modal

Task Center 和 Conversation 操作都可以提供“新建定制任务”，但共用同一个 Modal，不在
窄侧栏长期展开完整表单。

```text
新建定制任务
创建一个可以按计划自动运行，并持续记录在会话中的任务

任务名称 *
[ 每周项目总结                                  ]

任务要求 *
[ 总结本周完成和失败的工作，并列出下周优先事项。 ]

关联会话
◉ 当前会话
  产品发布讨论 · GoodBuddy Desktop · 已有 2 个任务

○ 新建会话
  为任务创建一条新会话，默认标题为任务名称

执行模式
[ Execute ] [ Ask ]

运行频率
[ 单次 ] [ 每日 ] [ 每周 ] [ 每月 ] [ 工作日 ] [ Cron ]

首次运行    [ 2026-08-21 ] [ 17:00 ]
时区        [ Asia/Shanghai                    ▾ ]

执行范围
GoodBuddy Desktop · OpenCode · 项目工作目录
8 个工具可用 · 高风险操作需要审批                 [编辑]

                                 [取消] [创建任务]
```

### 5.1 Conversation 选择

- 从当前聊天发起时默认选择当前 Conversation。
- 从 Task Center 发起时默认选择新 Conversation。
- 当前选择必须持续可见，不能根据入口静默决定后隐藏。
- 关联当前 Conversation 不修改其标题、既有消息和普通聊天能力。
- 当前 Conversation 已有关联 Task 时，显示 Task 数量和共享上下文说明。
- 新 Conversation 默认使用 Task 名称作为标题，用户可以单独修改。
- 远程通道、归档、正在删除或 Project 不匹配的 Conversation 不可选择，并显示原因。

### 5.2 创建摘要

提交前显示确定性摘要：

```text
✓ 为当前 Conversation 新增一个 Task
✓ 在左侧会话列表显示“任务 3”
✓ 默认以 Execute 模式运行
✓ 每周五 17:00 自动执行此 Task
✓ 文本结果写入当前 Conversation
✓ 独立交付物保存到成果
```

创建 Task、可选新 Conversation、关联关系和 Schedule Binding 必须在 Main 中原子提交。
失败时保持 Modal 和用户输入，不只显示短暂通知。提交期间锁定重复操作。

### 5.3 Modal 行为与无障碍

- 使用 `role="dialog"`、`aria-modal="true"`、稳定标题和说明关联。
- 打开后聚焦首个必填字段，Tab 焦点限制在 Modal 内。
- Escape 在未提交时关闭并恢复触发按钮焦点。
- 窄窗口使用接近全宽布局，保留 `16px` 外边距。
- 字段错误靠近字段；非字段异步错误保留在 Modal 内并提供重试。

## 6. 工作模式、Runtime 与工具

### 6.1 默认 Execute

创建 Modal 默认选择 Execute：

- Execute 可以调用当前 Runtime 与 Project 已启用、且被 Task 快照允许的工具。
- Ask 保持 Runtime 边界只读，只能调用允许的只读能力。
- 所选 Runtime 不支持工具执行时，不能静默降级为 Ask；用户必须更换 Runtime 或主动选择
  Ask。
- Modal 持续显示实际 Runtime、Project、工作目录和权限摘要。

### 6.2 权限快照

Task 创建时冻结：

- Project 和工作目录。
- Runtime 与模型选择。
- 工作模式。
- Skills、MCP、知识库、记忆和上下文范围。
- 可用工具与审批策略。
- 预算、并发和输出限制。

后续设置变化不修改已启动 Run。编辑 Task 配置只影响后续 Job。

### 6.3 审批

- Execute 继续遵守当前 Runtime、GoodBuddy 原生能力和工具审批控制。
- 已启用且按现有策略允许自动执行的工具可以在后台运行。
- 需要额外确认的动作进入 `waiting_approval`，暂停所属 Job 并发送应用内及桌面通知。
- 用户批准后继续同一个 Job/Run；拒绝后按协议失败、跳过或请求调整。
- 定时触发不能把高风险、越界或未授权动作转换成自动批准。
- 结果未知的外部副作用进入 `outcome_unknown`，不得自动重试。

## 7. 触发器

### 7.1 时间触发

```ts
type TimeTrigger =
  | { type: 'once'; at: string; timezone: string }
  | { type: 'daily'; localTime: string; timezone: string }
  | {
      type: 'weekly'
      weekdays: number[]
      localTime: string
      timezone: string
    }
  | {
      type: 'monthly'
      day: number | 'last'
      localTime: string
      timezone: string
    }
  | {
      type: 'cron'
      expression: string
      timezone: string
    }
```

“工作日”是 `weekly` 的周一至周五预设，不增加新的持久化触发类型。

受限 Cron 使用五字段，不支持秒、年份、宏、`L`、`W`、`#` 或供应商扩展。Main 负责解析，
默认最小间隔为 15 分钟，并展示未来五次触发时间。

### 7.2 事件触发

后续支持：

- `conversation.completed`
- `task.completed`
- `task.failed`
- `artifact.created`
- `knowledge.sync.completed`
- `magic_note.updated`

事件触发配置来源范围、确定性过滤、去重窗口、冷却时间和并发上限。基础匹配不调用模型。

### 7.3 手动触发

“立即运行”在当前 Task 内创建独立 Job 和 Run，不改变下一次计划时间，不创建新 Task。
重复点击使用调用级幂等键去重。

### 7.4 与普通消息的顺序

同一 Conversation 的普通消息和 Scheduled Task occurrence 使用同一 FIFO 队列。Agent
正在回复时，到期 occurrence 只显示为待执行，不中断当前输出；当前执行结束后才认领下一项。
用户显式选择“立即中断并插入”时，系统取消当前 Conversation 的活动请求，并让所选项成为
下一项。删除待执行 occurrence 只取消该次运行，不删除稳定 Task、Conversation 或历史结果。

## 8. 一次触发的对象关系

```text
Conversation
  └─ Scheduled Task
       ├─ Schedule Binding
       └─ Job: scheduled_occurrence
            └─ Run
```

- `scheduledFor` 和计划版本形成幂等键。
- 同一 Scheduled Task 默认最多一个活动 occurrence Job。
- 若允许并行 occurrence，它们仍属于同一 Task，并由协调器有序写回关联 Conversation。
- 重试产生新 Run，不产生新 Task 或新 occurrence Job。

## 9. 左侧会话列表

普通 Conversation 保持单行。包含 Task 的 Conversation 显示行首展开按钮：

```text
▾ 产品发布讨论                           10:24

   每周进度总结       每周 · Execute · 等待中 ●
   发布前检查                     单次 · Execute ✓
```

- 父会话行不重复显示任务标签或数量；Task 子项名称在左，模式、计划和状态标记收在右侧，
  与父会话的更新时间位置一致。
- 点击 Conversation 标题打开聊天；点击 Task 子项打开同一 Conversation 并定位到该 Task。
- 新建 Task 成功后首次自动展开。用户手动折叠后持久化其选择，后台运行不强制展开。
- 默认最多直接显示 3 个 Task；“查看全部 N 个任务”打开该 Conversation 的完整 Task 区。
- Task 子项显示本地化的模式、计划和非完成态状态文字；状态标记固定在行尾。已完成使用
  带勾成功点，并将完成文案保留给辅助技术，避免在紧凑元数据中重复显示且不只靠颜色表达。
- 左侧只展开 Task；当前产品 UI 的其他区域也不提供 Job/Run 树或独立导航。

## 10. Conversation 内呈现

打开包含 Task 的 Conversation 后，顶部提供可折叠 Task 条：

```text
本会话有 2 个任务
[每周进度总结] [发布前检查]                         [管理任务]
```

选中 Task 后显示：

- 名称、状态和模式。
- 计划、下次执行和未来预览。
- 最近一次执行结果。
- “立即运行”“暂停”“编辑计划”等操作。
- 需要审批时的明确恢复入口。

每条自动结果消息显示 Task 名称、触发来源和时间。普通文本作为消息保存；文件、图片、PDF 和
其他独立交付物保存为 Artifact，并从消息引用。多个 Task 并发时，最终文本以完整消息写入，
不能把流式 Token 无序混入同一消息时间线。

## 11. Task Center

Task Center 显示 Scheduled Task 的范围、关联 Conversation、状态、模式、最近进展、需要
关注和下次触发时间：

- 点击条目打开关联 Conversation，并定位到该 Task。
- “立即运行”在内部创建 Job/Run，但 UI 仍只呈现 Task，不改变计划时间。
- 暂停只阻止新 Job，不取消已经完成的外部副作用。
- Task Center 是完整索引；左侧展开列表只是最近 Conversation 下的轻量入口。
- 不新增平行 Automation Center。

## 12. 错过执行

| 策略 | 行为 |
| --- | --- |
| `skip` | 记录跳过，不补跑 |
| `run_once` | 无论错过多少次，只在当前 Task 内补一个 Job |
| `catch_up_bounded` | 在数量和时间窗口上限内创建多个有界 Job |

默认补跑最多 3 次、最多回溯 7 天。补跑同样受 Task 的并发、权限和预算控制。

## 13. 时区和夏令时

- 保存 IANA 时区，不保存固定 UTC 偏移。
- 春季不存在的本地时间在当日第一个有效分钟触发。
- 秋季重复时间只触发一次。
- 系统时区变化不自动修改计划时区。
- UI 显示计划时区、本机时区差异和未来五次触发时间。

## 14. 预算、恢复和删除

每个 Scheduled Task 配置最大 Job 耗时、模型/Token/工具调用、成果大小、活动 Job 数和后台
优先级。前台请求优先，后台达到上限时记录 `deferred`。

- 瞬时且没有未知副作用的失败可以有界重试。
- 配置、权限和范围错误不重试。
- 应用退出将活动 Job/Run 标记为 `interrupted`。
- 取消 Task 必须传播到活动 Job、Subjob 和 Runtime。
- 删除 Schedule 只停止后续触发，不删除 Task、Conversation 或历史。
- 删除 Task 停止其计划并移除关联，默认保留 Conversation 和既有消息。
- 删除 Conversation 前显示关联 Task 数量，并先处理活动 Job。

## 15. 兼容迁移

现有 Schedule、Schedule Run、Task 和 Conversation 数据渐进关联：

- 保留现有计划 ID、启停状态、下次时间和历史。
- 为每个现有 Schedule 创建一个稳定产品级 Task。
- 旧 Schedule 不猜测绑定已有用户 Conversation；为其创建新的关联 Conversation。
- 历史每次执行映射为该 Task 下的 occurrence Job/Run。
- 旧执行产生的 Task 行在映射成功后不再作为产品级 Task 索引，但其状态、活动和成果继续
  通过迁移后的 Job/Run 归属保留。
- 旧文本 Artifact 可以保留，但迁移不得把它们重复写成新消息。
- 迁移不得复制用户消息、独立成果或顶层 Task。

## 16. 验收标准

- [x] 创建 Scheduled Task 可以选择当前或新 Conversation。
- [x] 关联当前 Conversation 不修改其标题、类型或既有消息。
- [x] 一条 Conversation 可以在左侧展开一个或多个 Task。
- [x] 默认工作模式为 Execute，且用户可以主动选择 Ask。
- [ ] Execute 能调用快照允许的工具，但不能绕过 Runtime 和审批控制。
- [x] 不支持工具的 Runtime 不会让 Execute 静默降级。
- [x] 重复触发始终复用同一 Task 和 Conversation 关联。
- [x] 每次触发创建内部运行记录，不创建新的顶层 Task。
- [x] 内部运行记录只用于执行和审计，不在 UI 中显示为独立层级。
- [ ] 支持单次、每日、每周、每月、工作日和受限 Cron。
- [ ] UI 显示计划时区和未来五次触发时间。
- [ ] 夏令时不会造成漂移或双跑。
- [ ] 错过执行按配置跳过、补一次或有界补跑。
- [x] 手动运行不改变下次计划时间。
- [x] Scheduled Task 与普通消息共用 Conversation 级队列，不并发写入同一时间线。
- [x] 当前回复期间可以继续发送普通消息，并在 Composer 上沿查看、删除或提升待发送项。
- [x] 应用重启恢复尚未执行的队列项和有界附件上下文；已写入 Conversation 的用户输入
  通过队列项身份完成恢复对账，不会再次进入待发送队列。
- [x] 文本结果只写入 Conversation，独立交付物才进入成果。
- [ ] Task Center 和桌面通知可以打开正确 Conversation 并定位 Task。
- [ ] 应用重启不自动重放结果未知的副作用。
