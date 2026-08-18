# Scheduled Task PRD

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 当前基础能力已存在，扩展调度设计中 |
| 版本 | 0.4 |
| 日期 | 2026-08-19 |
| 依赖 | [Task 与 Job 统一领域模型](./task-and-job-model.md) |
| 相关架构 | [自动化平台总体设计](../../architecture/automation-platform-architecture.md) |

## 1. 产品定义

Scheduled Task 是带时间或事件触发器的 Task。它不是 Schedule 定义与临时 Task 的松散组合，
也不创建第二条 Conversation。

创建 Scheduled Task 时：

1. 创建一个 Task。
2. 为该 Task 创建唯一 Conversation。
3. 保存 Schedule/Trigger Binding。
4. 每次触发在同一 Task 内创建新的 Job 和 Run。
5. 将面向用户的进展和结果持续写回同一 Task Conversation。

因此，一个每日任务在 Task Center 中始终是一条 Task，而不是每天新增一条 Task。

## 2. 当前能力

GoodBuddy 当前支持单次、每日和每周触发固定 Ask 提示，并持久化计划、Task、运行状态和成果。
近期改进不得破坏现有数据、错过执行结算、暂停、立即运行和应用退出行为。

## 3. 目标

- 支持单次、每日、每周、每月、工作日和受限 Cron。
- 支持 Task 完成、失败、Conversation 完成等内部事件触发。
- 允许自然语言生成结构化草稿，但必须由用户检查后启用。
- 提供时区、错过执行、幂等、租约、重试、恢复、取消、预算和审计。
- 让所有重复触发复用同一 Task Conversation。
- 为一次触发建立清晰 Job/Run，而不是创建新的顶层 Task。

## 4. 非目标

- 不提供任意脚本和循环的通用 DAG 编辑器。
- 不允许模型生成并直接执行任意 Shell、SQL 或无限频率 Cron。
- 不承诺应用退出后继续运行。
- 不允许计划静默扩大权限、目录、知识或记忆范围。
- 不把 Smart Heartbeat 变成 Scheduled Task。
- 不把每次触发或重试显示为新的 Task。

## 5. 创建与配置

用户可以输入自然语言意图：

```text
每周五下午 5 点总结本项目本周完成和失败的工作，
列出下周三个优先事项，不要修改文件。
```

模型只生成草稿：

- 名称和说明。
- 时间或事件触发器。
- 工作模式和 Runtime 建议。
- Project、知识、记忆、目录和工具范围。
- 输入、输出和通知。
- 预算、并发和错过执行策略。

用户确认后，系统一次性创建 Task、Conversation 和 Schedule Binding。编辑计划只影响后续
Job；已启动 Run 使用冻结快照。

## 6. 触发器

### 6.1 时间触发

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

受限 Cron 使用五字段，不支持秒、年份、宏、`L`、`W`、`#` 或供应商扩展。Main 负责解析，
默认最小间隔为 15 分钟，并展示未来五次触发时间。

### 6.2 事件触发

后续支持：

- `conversation.completed`
- `task.completed`
- `task.failed`
- `artifact.created`
- `knowledge.sync.completed`
- `magic_note.updated`

事件触发配置来源范围、确定性过滤、去重窗口、冷却时间和并发上限。基础匹配不调用模型。

### 6.3 手动触发

“立即运行”在当前 Task 内创建独立 Job 和 Run，不改变下一次计划时间，不创建新 Task。
重复点击使用调用级幂等键去重。

## 7. 一次触发的对象关系

```text
Scheduled Task
  ├─ Conversation（持续复用）
  ├─ Schedule Binding
  └─ Job: scheduled_occurrence
       └─ Run
```

- `scheduledFor` 和计划版本形成幂等键。
- 同一 Scheduled Task 默认最多一个活动 occurrence Job。
- 若允许并行 occurrence，它们仍属于同一 Task Conversation，并由协调器有序汇总。
- 重试产生新 Run，不产生新 Task 或新 Job。

## 8. 错过执行

| 策略 | 行为 |
| --- | --- |
| `skip` | 记录跳过，不补跑 |
| `run_once` | 无论错过多少次，只在当前 Task 内补一个 Job |
| `catch_up_bounded` | 在数量和时间窗口上限内创建多个有界 Job |

默认补跑最多 3 次、最多回溯 7 天。补跑同样受 Task 的并发、权限和预算控制。

## 9. 时区和夏令时

- 保存 IANA 时区，不保存固定 UTC 偏移。
- 春季不存在的本地时间在当日第一个有效分钟触发。
- 秋季重复时间只触发一次。
- 系统时区变化不自动修改计划时区。
- UI 显示计划时区、本机时区差异和未来触发时间。

## 10. Ask、Execute 与审批

第一阶段保持 Ask：

- Runtime 边界只读。
- 不写文件、不执行命令、不发送消息、不修改远程数据。
- 输出写回 Task Conversation；独立交付物才进入成果。

Execute 按顺序开放：

1. 有人值守，沿用逐工具审批。
2. 预批准低风险工具和参数范围。
3. 经过专项验证的内置无人值守模板。

高风险、越界或未预授权动作进入 `waiting_approval`，不能因定时触发而绕过策略。

## 11. 预算与背压

每个 Scheduled Task 配置：

- 最大 Job 耗时。
- 最大模型、Token 和工具调用。
- 最大成果大小。
- 最大活动 Job 数。
- 后台优先级。

前台请求优先。后台达到上限时延后并记录 `deferred`，不能挤占用户正在等待的请求，也不能
在恢复空闲时一次释放全部积压。

## 12. 重试、恢复和取消

- 瞬时、无副作用失败可以有界重试。
- 配置、权限和范围错误不重试。
- 外部副作用结果未知时进入 `outcome_unknown`，不自动重试。
- 应用退出将活动 Job/Run 标记为 `interrupted`。
- 暂停计划只阻止新 Job，不假装取消已发生的外部操作。
- 取消 Task 必须传播到活动 Job、Subjob 和 Runtime。

## 13. 界面

Task Center 显示 Scheduled Task 的范围、状态、最近进展、需要关注和下次触发时间。点击条目
打开同一 Task Conversation。

Task 内可查看：

- 计划和触发器。
- 下次执行和未来预览。
- 每次 occurrence Job。
- Run、审批、活动和成果。

不新增平行 Automation Center。

## 14. 兼容迁移

现有 Schedule、Schedule Run、Task 和 Conversation 数据渐进关联：

- 保留现有计划 ID、启停状态、下次时间和历史。
- 为每个现有计划建立或绑定一个持续 Task Conversation。
- 历史每次执行映射为该 Task 下的 occurrence Job/Run。
- 迁移不得复制消息、成果或顶层 Task。

## 15. 验收标准

- [ ] 创建 Scheduled Task 只创建一个 Task 和一个 Conversation。
- [ ] 重复触发始终复用该 Task Conversation。
- [ ] 每次触发创建 Job/Run，不创建新的顶层 Task。
- [ ] 支持单次、每日、每周、每月、工作日和受限 Cron。
- [ ] UI 显示计划时区和未来五次触发时间。
- [ ] 夏令时不会造成漂移或双跑。
- [ ] 错过执行按配置跳过、补一次或有界补跑。
- [ ] 手动运行不改变下次计划时间。
- [ ] Ask 在 Runtime 边界拒绝写操作和外部副作用。
- [ ] 应用重启不自动重放结果未知的副作用。
- [ ] Task Center 不因重复触发新增条目。
