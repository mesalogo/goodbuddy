# 自动任务、目标与调度 PRD

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中 |
| 版本 | 0.1 |
| 日期 | 2026-08-13 |
| 依赖 | [自动化、监督与记忆平台总体设计](./automation-platform-architecture.md) |

## 1. 背景

GoodBuddy 当前的定时任务支持单次、每日和每周触发固定 Ask 提示，并保存任务和成果；
智能心跳支持每日或每周回顾有界的会话、任务和已确认记忆。两者尚不能表达事件触发、
目标、成功标准、预算、停止条件和安全恢复。

## 2. 产品边界

| 类型 | 用户意图 | 是否形成循环 |
| --- | --- | --- |
| 定时任务 | 在指定时间执行已知操作 | 否 |
| 事件任务 | 当明确事件发生时执行已知操作 | 否 |
| 目标任务 | 在预算内持续推进到可验证结果 | 是 |

智能心跳是特殊的定时观察任务。并行实验属于独立产品。

## 3. 已确认的产品决策

1. 自动化定义与每次运行分离，编辑计划不改变已启动 Run。
2. 第一阶段保留现有定时任务的 Ask 限制，Execute 分阶段开放。
3. Execute 自动化不能因无人值守而绕过现有审批、主机执行策略和工具控制。
4. 应用退出后不承诺继续运行，重启后只进行状态恢复和错过执行结算。
5. 目标任务必须有成功标准，以及预算或人工结束条件。
6. 模型可以提出计划，确定性状态机负责预算、停止、权限和恢复。
7. 同一计划默认最多一个活动 Run。
8. 后台任务可被背压延后，不能挤占用户正在等待的前台请求。
9. 结果未知的外部副作用步骤不自动重试。
10. 项目、知识库、记忆、目录和工具范围在保存和运行页持续可见。

## 4. 目标

- 支持单次、每日、每周、每月、工作日和受限 Cron。
- 支持任务完成、失败、会话完成等内部事件触发。
- 允许用户用自然语言生成结构化草稿，再检查后启用。
- 为目标任务建立有界的“观察、计划、行动、评估”循环。
- 提供幂等、租约、错过执行、取消、重试、恢复、预算和审计。
- 为后续并行实验和持续学习复用协议、指标和运行基础。

## 5. 非目标

- 第一阶段不提供任意节点、脚本和循环的通用 DAG 编辑器。
- 不允许模型编写并执行任意 Shell、SQL 或无限频率 Cron。
- 不支持应用退出后通过未安装的系统服务继续运行。
- 不把“模型说完成了”作为唯一成功标准。
- 不允许自动任务静默修改自身权限、触发器或预算。
- 不在目标循环中无限创建子任务或专家。

## 6. 创建与启用

用户可以先输入自然语言意图：

```text
每周五下午 5 点总结本项目本周完成和失败的任务，
列出下周三个优先事项，不要修改文件。
```

模型只生成草稿：

- 名称、说明和自动化类型。
- 触发器。
- 目标、输出和成功标准建议。
- 工作模式和 Runtime 建议。
- 数据范围。
- 预算、停止条件和通知。

草稿不能自动启用。用户必须检查结构化配置。

### 6.1 所有计划必填

- 名称、范围和类型。
- 触发器。
- 工作模式和 Runtime。
- 输入、输出和通知。
- 预算和数据保留。
- 知识库、记忆、目录和工具范围。

### 6.2 目标任务额外必填

- 目标描述。
- 至少一个成功标准。
- 约束。
- 最大轮数或截止时间。
- 每轮评估方式。
- 无进展处理。

### 6.3 启用前检查

- 时区和下一次运行时间可解析。
- 项目、目录、Runtime 和模型可用。
- Ask 没有写入或外部副作用要求。
- Execute 的工具和审批范围明确。
- 预算不是无界值。
- 事件来源存在且已启用。
- 目标任务存在停止条件。

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

受限 Cron 只允许五字段，不支持秒、年份、宏、`L`、`W`、`#` 或供应商扩展。
Main 负责解析并展示未来五次运行时间，默认最小间隔为 15 分钟。

### 7.2 事件触发

第二阶段支持：

- `conversation.completed`
- `task.completed`
- `task.failed`
- `artifact.created`
- `knowledge.sync.completed`
- `magic_note.updated`

事件触发必须配置来源范围、确定性过滤、去重窗口、冷却时间和并发上限。
基础匹配不调用模型。

### 7.3 手动触发

- “立即运行”创建独立 Run，不改变下次计划时间。
- 多次点击使用调用级幂等键去重。
- 未保存的变更需先保存为新版本，或明确使用当前已发布版本。

### 7.4 错过执行

| 策略 | 行为 |
| --- | --- |
| `skip` | 记录跳过，不补跑 |
| `run_once` | 无论错过多少次，只补一次 |
| `catch_up_bounded` | 在数量和时间窗口上限内补跑 |

有界补跑默认最多 3 次、最多回溯 7 天。补跑同样受并发和预算控制。

### 7.5 时区和夏令时

- 保存 IANA 时区，不保存固定 UTC 偏移。
- 春季不存在的本地时间在当日第一个有效分钟运行。
- 秋季重复时间只运行一次。
- 系统时区变化不自动修改计划时区。
- UI 显示计划时区与本机时区差异。

## 8. 目标任务

### 8.1 目标模型

```ts
type AutomationObjective = {
  statement: string
  successCriteria: SuccessCriterion[]
  constraints: Constraint[]
  deadline?: string
}

type SuccessCriterion =
  | { type: 'artifact_exists'; kind: string; minimumCount: number }
  | { type: 'task_state'; taskId: string; expected: 'completed' }
  | {
      type: 'metric_threshold'
      metric: string
      operator: string
      value: number
    }
  | { type: 'checklist'; items: string[] }
  | { type: 'human_review' }
  | {
      type: 'model_rubric'
      rubricId: string
      minimumScore: number
    }
```

模型 Rubric 不能是唯一标准，除非任务本质是开放内容评价且 UI 明确标注。

### 8.2 有界循环

```text
Observe
  → Plan next action
  → Check permissions and budget
  → Act or request approval
  → Evaluate progress
  → Complete, pause, revise or continue
```

每轮持久化观察摘要、下一步、实际任务或工具、成果、指标、预算、进展状态和
Supervisor 决策。只保存专门生成的结构化理由摘要，不保存隐藏推理。

### 8.3 无进展检测

出现任一情况进入 `attention_required`：

- 连续两轮没有指标改善或新成果。
- 重复提出相同下一步。
- 连续失败达到上限。
- 需要的输入或权限不可用。
- 剩余预算不足。
- Supervisor 判定目标或前提需要澄清。

默认暂停并请求用户选择，不自动扩大范围。

### 8.4 计划修订

目标任务可以建议修改步骤、缩小目标、请求输入、增加预算或改变 Runtime。
修改范围、预算、Runtime、工作模式或权限必须用户确认，并形成新版本或 Run 修订记录。

## 9. 工作模式与审批

### 9.1 Ask

- 默认只读。
- 只使用明确开放的只读数据工具。
- 不写文件、不执行命令、不发送消息、不修改远程数据。
- 输出进入成果和通知。

### 9.2 Execute

按以下顺序开放：

1. 有人值守，沿用逐工具审批。
2. 预批准低风险工具和参数范围。
3. 经过专项验证的内置无人值守模板。

即使预批准，也不能扩大目录和能力。高风险或越界动作进入 `waiting_approval`。
密码输入、支付、授权、删除、公开发布和生产变更不能预批准。

## 10. 预算与背压

```ts
type AutomationBudget = {
  maximumDurationMs: number
  maximumIterations: number
  maximumModelCalls: number
  maximumInputTokens?: number
  maximumOutputTokens?: number
  maximumToolCalls: number
  maximumChildTasks: number
  maximumArtifactBytes: number
  maximumConcurrentChildren: number
}
```

建议默认值：

| 类型 | 最长时间 | 模型调用 | 子任务并发 |
| --- | --- | --- | --- |
| 定时 Ask | 5 分钟 | 4 | 1 |
| 心跳回顾 | 5 分钟 | 2 | 0 |
| 目标 Ask | 30 分钟 | 12 | 2 |
| 目标 Execute | 30 分钟 | 12 | 1 |

前台请求优先。后台使用独立并发池，达到上限时排队。高负载时低优先级心跳和维护任务
记录为 `deferred`，压力解除后有界恢复，不能一次性释放全部积压。

## 11. 重试、恢复与取消

| 失败类型 | 行为 |
| --- | --- |
| 瞬时网络或限流 | 指数退避，有界重试 |
| 模型格式错误 | 最多一次结构化修复 |
| 配置或权限错误 | 不重试，等待修复 |
| 无副作用的确定性工具失败 | 按工具策略重试 |
| 结果未知或已有外部副作用 | 不自动重试 |

应用退出时停止声明新 Run，取消可取消工作，活动 Run 标记为 `interrupted` 并保存安全
检查点。重启后用户可恢复、复制剩余步骤或放弃；结果未知步骤必须先人工核实。

暂停 Plan 只阻止新 Run，不终止当前 Run。取消 Run 必须传播到子任务和 Runtime，
但不能把已发生的外部副作用假装撤销。

## 12. 输出与通知

输出可保存为文字或文件成果、创建后续任务建议，或仅通知。后续可支持更新指定魔法笔记。

通知事件：

- Run 完成或失败。
- 等待审批。
- Supervisor 要求关注。
- 目标达成。
- 预算达到 80%。
- 连续无进展。

同一事件不同时显示重复页内横幅和全局通知。

## 13. 信息架构

计划列表显示名称、类型、范围、启用状态、下次运行、最近 Run、目标状态和需要关注数量。

计划详情页签：

- 概览。
- 目标与协议。
- 触发器。
- 权限与预算。
- 运行历史。

Run 详情展示总览、时间线、任务、审批、监督、指标、证据、成果以及实际读取的知识和记忆。

## 14. 数据模型建议

```ts
type AutomationPlan = {
  id: string
  projectId?: string
  kind: 'scheduled_task' | 'heartbeat_review' | 'goal_loop'
  name: string
  description: string
  status: 'draft' | 'active' | 'paused' | 'archived'
  currentVersion: number
  nextRunAt?: string
  createdAt: string
  updatedAt: string
}

type AutomationPlanVersion = {
  planId: string
  version: number
  trigger: TriggerPolicy
  objective?: AutomationObjective
  protocol: ExecutionProtocol
  budget: AutomationBudget
  approvalPolicy: ApprovalPolicy
  supervisorPolicy?: SupervisorPolicy
  memoryBinding: MemoryBinding
}
```

状态、范围、下次运行、版本和索引字段使用显式列；版本化协议可以使用经过共享 Schema
验证的 JSON。

## 15. 安全要求

1. 所有输入由共享 Zod Schema 验证。
2. Main 重新验证项目、目录、Runtime、工具、知识库和记忆分区归属。
3. Renderer 不可直接声明 Run 完成或批准工具。
4. 自动化提示、事件、记忆和成果都视为不可信数据。
5. 事件过滤不执行用户 JavaScript、SQL 或无限复杂表达式。
6. Cron 有复杂度和最小间隔限制。
7. 自动化不能读取未绑定知识库、桌面上下文或其他项目记忆。
8. 日志和通知对私人内容、密钥和工具输出有界脱敏。

## 16. 实施顺序

1. 统一现有 Schedule 和 Heartbeat 的 Run 视图。
2. 增加幂等、租约、月度、工作日、受限 Cron、错过执行和未来运行预览。
3. 建立内部持久事件、过滤、冷却和去重，首期只支持 Ask。
4. 上线目标 Ask、有界循环、无进展检测和人工暂停。
5. 接入会话监督。
6. 再开放有人值守和预批准低风险 Execute。

## 17. 验收标准

- [ ] 支持单次、每日、每周、每月、工作日和受限 Cron。
- [ ] UI 显示计划时区和未来五次运行时间。
- [ ] 夏令时不会造成计划漂移或双跑。
- [ ] 同一计划同一时间点只产生一个 Run。
- [ ] 错过执行按配置跳过、补一次或有界补跑。
- [ ] 手动运行不改变下次计划时间。
- [ ] Ask 自动化在 Runtime 边界拒绝写工具和外部副作用。
- [ ] 目标任务必须有成功标准和停止条件。
- [ ] 每轮都有观察、行动、评估和预算记录。
- [ ] 连续无进展会暂停，不无限循环。
- [ ] 达到预算使用 `budget_exceeded`，不伪装为成功。
- [ ] 设置变化不影响已启动 Run。
- [ ] 重启后不自动重放结果未知的副作用步骤。
- [ ] 后台任务排队时不挤占前台模型请求。
