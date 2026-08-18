# 并行实验工作台 PRD

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中 |
| 版本 | 0.1 |
| 日期 | 2026-08-13 |
| 依赖 | [自动化平台总体设计](../../architecture/automation-platform-architecture.md)、[Task 与 Job 统一领域模型](../task-and-job/task-and-job-model.md) |

## 1. 背景

GoodBuddy 已能把一个请求并行委派给最多三个只读专家，再综合结果。这适合“一次请求，
多种专业视角”，但不等同于实验：当前没有结构化变量、重复运行、统一指标、结果晋升和
Run 级记忆隔离。

本功能借鉴 MesaLogo ParallelLab 中变量隔离、批量 Run、失败结算、指标比较和运行证据
的思想，但不引入其 Action Space、服务端队列或重型仿真平台。

## 2. 产品定义

并行实验是在冻结的研究问题和执行协议下，生成多个相互隔离的候选 Run，以相同评估标准
比较结果，并将结论追溯到运行证据。

```text
Experiment
  ├─ Question / Hypothesis
  ├─ Protocol
  ├─ Variables and Variants
  ├─ Objectives and Evaluators
  ├─ Budget and Stop Conditions
  └─ ExperimentRun × N
       ├─ Isolated Conversation
       ├─ Isolated Run Memory
       ├─ Tasks and Artifacts
       ├─ Metrics
       └─ Evidence
```

## 3. 已确认的产品决策

1. 实验 Run 复用现有 Task、Runtime、Artifact 和审批机制。
2. 每个 Run 有独立变量、会话、运行记忆、任务和成果。
3. 默认实验是只读 Ask；写工作区的实验后续使用每 Run 独立沙箱。
4. 多个 Run 不能并发修改同一个用户工作区。
5. 失败、取消、预算耗尽或结果不完整的 Run 不参与最佳结果选择。
6. 没有成功 Run 时实验为失败或无结论，不能报告成功。
7. 模型生成的实验协议必须可审查、编辑和版本化。
8. 评估优先使用确定性指标；模型 Rubric 显示评估器版本和不确定性。
9. “最佳”只针对声明的目标和约束，不代表普遍最好。
10. 最佳结果只能创建候选，不能直接覆盖计划、记忆或工作区。

## 4. 目标

- 把问题转为可审查的实验问题、变量、候选和指标。
- 比较不同提示、模型、专家组合、参数或方案。
- 监控每个 Run 的状态、成本、证据和失败原因。
- 查看结果表、差异、稳定性和评估依据。
- 从候选创建普通任务、计划草稿或记忆候选。
- 为持续学习提供回放和非退化评估基础。

## 5. 非目标

- 第一阶段不模拟数千 Agent 或社会群体涌现。
- 不实现任意连续参数的自动贝叶斯优化。
- 不在样本不足时宣称统计显著性。
- 不把模型的自报置信度直接作为跨模型比较指标。
- 不允许实验自行增加样本数、预算或能力范围。
- 不允许自动部署结果或修改安全策略。
- 不把专家团队的一次回答自动包装成科学实验。

## 6. 实验类型

| 类型 | 变量示例 | 用途 |
| --- | --- | --- |
| Prompt 对比 | 系统说明、输出格式、示例 | 比较自动化协议 |
| 模型对比 | 已配置文本模型 | 质量、速度和 Token 权衡 |
| 专家组合 | 专家集合、综合策略 | 多视角研究 |
| 参数扫描 | 检索模式、Top K、轮数 | 寻找有限参数组合 |
| 方案候选 | 多个用户或模型方案 | 按统一 Rubric 比较 |
| 回放评估 | 历史脱敏案例集合 | 验证学习候选是否退化 |

后续多轮情景模拟需要单独定义角色、环境和状态变量。

## 7. 创建流程

### 7.1 研究问题

用户填写：

- 实验名称。
- 问题和可选假设。
- 探索、比较、优化或回放验证类型。
- 项目范围。
- 期望输出。
- 禁止行为。

### 7.2 协议

`ExperimentProtocol` 包含：

- 基准输入或案例集。
- 固定提示和步骤。
- 变量与候选。
- Runtime、模型和专家。
- 工具、知识库和记忆范围。
- 工作模式。
- 每 Run 预算。
- 指标、评估器和停止条件。
- 重复次数。

模型生成协议草稿时必须标明用户字段、模型建议、确定性指标和模型判断指标。

### 7.3 变量

```ts
type ExperimentVariable =
  | { name: string; type: 'enum'; values: JsonValue[] }
  | {
      name: string
      type: 'range'
      start: number
      end: number
      step: number
    }
  | { name: string; type: 'boolean' }
  | { name: string; type: 'prompt_variant'; values: string[] }
  | {
      name: string
      type: 'model_profile'
      profileIds: string[]
    }
  | {
      name: string
      type: 'expert_set'
      expertIdSets: string[][]
    }
```

第一阶段只支持有限、确定生成的组合。保存前展示组合数、重复后 Run 总数、最大模型调用、
Token 和耗时范围，以及最大并发。超过上限时要求缩小变量，不静默抽样。

### 7.4 基准与候选

- 至少一个 Variant。
- 对比实验建议设置 Baseline。
- Baseline 与 Candidate 使用相同案例和评估器。
- 评估器不能读取 Variant 标签和模型名称作为质量信号。
- 模型评分时随机化候选顺序并保存实际顺序。

## 8. Run 隔离

### 8.1 数据隔离

每个 Run 独立拥有：

- `experimentRunId` 和运行会话。
- 变量快照和临时上下文。
- Run 记忆分区。
- Task、Job、Subjob 和成果。
- 指标、证据和 Runtime 会话标识。

禁止：

- Run A 读取 Run B 的消息、临时记忆或中间成果。
- 多个 Run 共享可变变量对象。
- Run 候选记忆在实验结算前进入其他 Run。
- 通过全局列表误取其他项目或实验数据。

### 8.2 工作区隔离

阶段 1 只支持 Ask 和只读工具。阶段 2 的 Execute Run 使用独立临时沙箱或版本化工作树，
结果以 Patch 或成果展示，用户选择候选后再进入单独应用流程。

### 8.3 记忆隔离

Run 只读取冻结的 Global、Project、Automation 记忆快照和自己的 Run 分区，
不读取其他 Run 或实验期间新产生的候选记忆。

## 9. 调度与预算

- 默认最大并发 3，与现有子专家调度能力一致。
- 还需遵守全局后台并发和模型连接并发。
- 每个 Variant 使用相同的单 Run 预算。
- 不因候选暂时领先而静默给它更多预算。
- 提前停止必须来自预先声明的规则。
- UI 显示运行、排队、成功、失败和取消数量。

停止条件：

```ts
type ExperimentStopCondition =
  | { type: 'all_runs_terminal' }
  | { type: 'successful_run_count'; count: number }
  | {
      type: 'metric_threshold'
      metric: string
      operator: string
      value: number
    }
  | { type: 'budget' }
  | { type: 'deadline'; at: string }
  | { type: 'manual' }
```

触发停止后不启动新 Run；是否取消正在运行的 Run 必须在条件中明确。保存停止原因，
未运行 Variant 不参与最终比较。

## 10. 评估与指标

### 10.1 指标类型

| 类型 | 示例 |
| --- | --- |
| 确定性结果 | Schema 有效、测试通过、文件存在、检查项完成 |
| 运行指标 | 耗时、模型调用、Token、工具调用、成果大小 |
| 检索指标 | 召回、引用覆盖、降级状态 |
| 人工评分 | 正确性、可用性、偏好 |
| 模型 Rubric | 结构、完整性、表达、风险 |

### 10.2 模型 Rubric

必须保存 Rubric 版本、评估模型、输入证据摘要、候选展示顺序、分项得分、结构化理由和
格式修复。它不能覆盖确定性失败，也不能在缺少证据时编造事实正确性判断。

### 10.3 多目标

```ts
type ExperimentObjective = {
  metric: string
  direction: 'maximize' | 'minimize' | 'target'
  weight?: number
  target?: number
  hardConstraint?: boolean
}
```

结算先排除非成功和违反硬约束的 Run，再计算其余指标。存在明显权衡时展示 Pareto 候选，
不强行选唯一最佳。

## 11. 结算规则

Run 成功要求：

- Runtime 正常结束。
- 必填成果存在。
- 必填评估器成功。
- 未违反硬约束。
- 没有结果未知的副作用。

Experiment 结算：

| 情况 | 状态 |
| --- | --- |
| 至少一个成功 Run，所需 Run 已结算 | `completed` |
| 所有 Run 失败或无有效结果 | `failed` |
| 提前停止且已有可比较结果 | `stopped_with_results` |
| 提前停止且无可比较结果 | `cancelled` |
| 指标冲突或证据不足 | `inconclusive` |

最佳结果展示 Variant、参数、成功和失败数量、重复运行原始值与聚合、目标分项、硬约束、
证据和限制。只有一个成功 Run 时使用“当前最高分候选”，不使用“稳定最佳”。

## 12. 重复与复现

- 每个 Variant 默认重复 1 次，波动敏感实验建议至少 3 次。
- 重复 Run 使用相同变量和独立运行会话。
- Runtime 支持种子时保存种子，否则明确标注不可完全复现。
- 聚合展示原始值、中位数或均值，并说明计算方式。
- 样本不足时不展示统计显著性结论。

## 13. 会话监督接入

Supervisor 可以检查偏离协议、遗漏必填输出、证据不足和候选间协议不一致；
确定性预算或权限违规可以暂停 Run，模型判断默认只警告或请求人工复核。

Supervisor 不能：

- 根据其他候选结果提示当前 Run。
- 临时修改某个候选协议。
- 自动提高预算或批准工具。

## 14. 信息架构

实验工作台页签：

1. **设计**：问题、协议、变量、指标和预算。
2. **运行**：总体进度、Run 表和状态。
3. **比较**：指标表、图表、差异和 Pareto 候选。
4. **证据**：按结论、指标和 Run 查看证据。
5. **结论**：总结、限制和后续操作。

Run 详情展示参数、协议版本、时间线、消息、任务、成果、监督记录、指标、评估理由、
上下文和记忆快照、Token、耗时与错误。

## 15. 后续操作

允许：

- 用候选参数创建普通任务。
- 创建自动化计划草稿。
- 保存实验模板。
- 创建记忆候选。
- 追加确认 Run。
- 导出脱敏结果摘要。

不得自动启用新计划、覆盖现有计划、确认长期记忆、应用工作区 Patch 或扩大权限。

## 16. 数据模型建议

```ts
type Experiment = {
  id: string
  projectId?: string
  name: string
  question: string
  status:
    | 'draft'
    | 'queued'
    | 'running'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'stopped_with_results'
    | 'inconclusive'
    | 'cancelled'
  protocolVersion: number
  totalRuns: number
  successfulRuns: number
  failedRuns: number
}

type ExperimentRun = {
  id: string
  experimentId: string
  variantId: string
  repetition: number
  automationRunId: string
  variables: Record<string, JsonValue>
  status: string
  goalStatus: 'met' | 'not_met' | 'inconclusive'
}
```

建议表：

- `experiments`
- `experiment_protocol_versions`
- `experiment_variants`
- `experiment_runs`
- `experiment_run_metrics`
- `experiment_evidence`
- `experiment_conclusions`

## 17. 安全与隐私

1. 协议、案例、输出和评估输入都视为不可信数据。
2. Renderer 不能指定其他项目的 Run 或记忆分区。
3. 每个 Run 使用唯一 Runtime conversation ID，并在结束后释放。
4. 实验默认不能写用户工作区。
5. 模型对比不能传递其他供应商的凭据或隐藏配置。
6. 导出默认不包含完整私人案例、提示、消息或文件内容。
7. 取消实验传播到排队和运行任务，但不伪装撤销已有副作用。
8. 实验删除不能误删已由用户独立保存的成果或计划候选。

## 18. 实施顺序

1. 建立 Experiment、Variant、Run 聚合实体和只读 Ask Run。
2. 实现有限组合、预算估算、并发调度和运行监控。
3. 增加确定性指标、失败结算和结果比较。
4. 增加模型 Rubric、人工评分和证据工作台。
5. 增加重复运行和回放评估。
6. 最后评估独立工作树中的 Execute 实验。

## 19. 验收标准

- [ ] 保存前显示变量组合、重复后 Run 总数和最大预算。
- [ ] 每个 Run 的会话、变量、记忆、任务和成果相互隔离。
- [ ] 默认实验无法写用户工作区。
- [ ] 最大并发和全局后台预算同时生效。
- [ ] 各 Variant 使用相同单 Run 预算。
- [ ] 失败、取消、预算耗尽和不完整 Run 不参与最佳选择。
- [ ] 全部 Run 失败时实验不报告成功或最佳结果。
- [ ] 模型 Rubric 显示版本、模型、分项和证据。
- [ ] 多目标冲突时可以展示多个 Pareto 候选。
- [ ] 用户可从候选创建草稿，但不会自动部署或确认记忆。
- [ ] 结论能追溯到具体 Run、指标、成果和证据。
