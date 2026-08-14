# 持续学习与评估门 PRD

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中，远期能力 |
| 版本 | 0.1 |
| 日期 | 2026-08-13 |
| 依赖 | [自动化平台总体设计](./automation-platform-architecture.md)、[并行实验 PRD](./parallel-experiments-prd.md)、[分区记忆 PRD](./partitioned-memory-prd.md) |

## 1. 背景

智能心跳已经可以生成摘要、后续任务和记忆候选，但这还不是完整学习：

- 候选是否改善未来行为没有评估。
- 一条反思是否会被检索和使用并不确定。
- 没有 Baseline、回放集、Shadow、晋升和回滚。
- 没有持续监控候选生效后的收益与退化。
- 如果允许系统直接修改 Prompt、Skill 或规则，可能发生静默劣化。

持续学习必须建立为可观察、可评估、可批准、可回滚的闭环，而不是“让模型自动改自己”。

## 2. 产品定义

```text
Observe
  → Propose candidate
  → Validate structure and safety
  → Evaluate against baseline
  → Shadow
  → Promote with approval
  → Monitor
  → Keep, revise, rollback or archive
```

学习产物只有在改变未来行为后才算生效；只保存一条 Reflection 仍属于记忆候选。

## 3. 已确认的产品决策

1. 评估门必须先于任何自动应用能力上线。
2. 新候选默认 `candidate`，通过离线评估后先进入 `shadow`。
3. 第一阶段只允许人工晋升。
4. 每次晋升必须记录 Baseline、候选、评估结果、作用域和回滚版本。
5. 学习不能修改安全边界、工具审批、目录权限、沙箱或 Electron 配置。
6. 失败案例和用户负反馈只作为评估数据，不直接成为新规则。
7. 回放案例必须脱敏、版本化，并得到用户明确选择或来自仓库公开样例。
8. 模型评估不是唯一真值，优先使用确定性验收和人工反馈。
9. 生效后的候选继续监控，发生退化可自动停用，但不能自动换上另一个候选。
10. 没有足够证据时保持 `inconclusive`，不强行晋升。

## 4. 学习产物

首期只支持：

| 产物 | 作用 | 是否可自动应用 |
| --- | --- | --- |
| Memory | 改善相关上下文召回 | 否，人工确认 |
| Automation Template | 改善目标、步骤、提示或预算默认值 | 否，创建新草稿 |
| Prompt Variant | 用于实验比较 | 否 |
| Rubric | 改善评估标准 | 否 |
| Retrieval Preference | 调整特定 Automation 的检索配置候选 | 否 |

后续评估：

| 产物 | 风险 |
| --- | --- |
| Skill | 可能扩大行为和工具使用 |
| Procedure | 可能长期影响多个任务 |
| Non-security Rule | 可能阻断或改变行为 |
| Agent Preference | 可能产生难以解释的个性漂移 |

永久禁止自动学习修改：

- 工具权限和审批策略。
- 工作区根目录和文件访问范围。
- 网络、远程消息和电脑控制权限。
- Electron 安全设置。
- API Key、凭据和 Provider Endpoint。
- 删除、支付、发布和生产操作政策。

## 5. 候选来源

- 用户对回答、任务或 Supervisor 意见的显式反馈。
- 智能心跳提出的重复模式。
- 自动化 Run 的成功与失败比较。
- 并行实验结论。
- 回放评估发现的稳定差异。
- 用户手动创建。

候选必须包含：

- 作用域。
- 产物类型。
- 来源证据。
- 预期改善的指标。
- 可能影响的行为。
- 风险级别。
- Baseline 引用。
- 建议的评估集。

模型不能仅凭一条成功案例宣称“已学习”。

## 6. 状态机

```text
candidate
  → evaluating
  → rejected
  → inconclusive
  → shadow
  → awaiting_approval
  → promoted
  → paused
  → rolled_back
  → archived
```

| 状态 | 含义 |
| --- | --- |
| `candidate` | 尚未评估 |
| `evaluating` | 正在运行离线评估 |
| `rejected` | 明确退化、安全不合格或无效 |
| `inconclusive` | 证据不足 |
| `shadow` | 计算候选决策但不影响真实行为 |
| `awaiting_approval` | 达到晋升标准，等待用户 |
| `promoted` | 已作为指定作用域的当前版本 |
| `paused` | 暂停影响，保留版本 |
| `rolled_back` | 已恢复前一版本 |
| `archived` | 不再评估和使用 |

## 7. 评估案例

### 7.1 案例来源

优先级：

1. 仓库内公开、无隐私的固定评测样例。
2. 用户手动创建的案例和期望。
3. 用户明确选择并脱敏的历史会话或任务。
4. 实验中产生、经用户批准保留的案例。

禁止默认采样所有私人会话用于学习。

### 7.2 案例结构

```ts
type EvaluationCase = {
  id: string
  suiteId: string
  input: EvaluationInput
  assertions: EvaluationAssertion[]
  forbiddenBehaviors: EvaluationAssertion[]
  source: EvaluationCaseSource
  sensitivity: 'public' | 'private_local'
  version: number
}
```

断言可以是：

- 输出符合 Schema。
- 包含或不包含确定文本模式。
- 引用来自允许知识库。
- 不调用工具。
- 任务状态和成果存在。
- 测试命令通过。
- 人工评分。
- 模型 Rubric 分项。

### 7.3 冻结

一次评估冻结：

- 案例版本。
- Baseline 版本。
- Candidate 版本。
- Runtime 和模型。
- 知识、记忆和工作区快照。
- 预算。
- 评估器版本。

设置变化不改变已开始的评估。

## 8. 评估门

### 8.1 判定

```ts
type GateVerdict = {
  decision: 'reject' | 'inconclusive' | 'shadow'
  baselineMetrics: MetricValue[]
  candidateMetrics: MetricValue[]
  regressions: Regression[]
  caseIds: string[]
  evaluatorVersions: string[]
  notes: string
}
```

最小规则：

1. 任何安全、权限或硬约束退化立即 Reject。
2. 确定性质量指标不能低于配置阈值。
3. 成本和延迟退化必须在允许范围。
4. 开放质量指标至少非退化，或收益足以覆盖明确成本。
5. 案例数或评估器不足时 Inconclusive。
6. 通过离线门只进入 Shadow，不直接 Promote。

### 8.2 Baseline

Baseline 是当前已生效版本或明确的无候选行为。不能用另一个同时变化的实验配置充当 Baseline。

### 8.3 多模型评估

模型 Rubric 可使用与被评候选不同的模型，但必须：

- 固定版本和提示。
- 隐藏候选身份。
- 随机化顺序。
- 保存分项和证据。
- 在关键晋升中结合确定性或人工评估。

## 9. Shadow

Shadow 模式：

- 接收与当前真实行为相同的有界输入。
- 计算候选会做出的选择或输出。
- 不调用有副作用工具。
- 不替换用户看到的结果。
- 不写入长期记忆。
- 保存与实际结果可比较的指标。

对于成本较高的候选：

- 只对抽样的已授权案例运行。
- 用户可设置月度调用上限。
- 系统繁忙时延后。

Shadow 达到配置的最小观察数且无安全退化后进入 `awaiting_approval`。

## 10. 晋升

晋升对话框必须显示：

- 候选将改变什么。
- 作用域和受影响计划。
- 来源。
- Baseline 与 Candidate 指标。
- 失败案例和不确定性。
- 额外成本。
- 回滚版本。

用户可以：

- 晋升。
- 继续 Shadow。
- 拒绝。
- 缩小作用域后重新评估。

晋升采用原子版本切换。不能在一半对象上成功、一半失败。

## 11. 上线后监控

监控：

- 使用次数。
- 成功、失败和无结论。
- 确定性指标。
- 用户采纳、撤销和负反馈。
- Token、耗时和工具调用变化。
- Supervisor 警告变化。

自动暂停条件：

- 安全或权限硬约束失败。
- 确定性错误率超过阈值。
- 连续崩溃或格式失败。
- 成本超过批准上限。

自动暂停只恢复到上一已批准版本，并通知用户。系统不能自行选择新候选替代。

## 12. 回滚

- 每个 Promoted 产物有不可变版本。
- 保存前一版本和作用域绑定。
- 一键回滚使用原子切换。
- 回滚不删除失败版本，保留指标和原因。
- 当前有运行使用该版本时，只影响下一次 Run；紧急安全暂停可取消尚未开始的 Run。
- 被回滚候选再次晋升必须重新评估。

## 13. 衰减与归档

- 长期未使用的候选和 Shadow 可归档。
- Promoted 产物不因时间静默删除。
- Memory 类型遵守分区记忆的衰减规则。
- 评估案例变化后，相关候选标记为“评估过期”。
- 模型或 Runtime 大版本变化时，可要求重新回放。
- 归档保留不含私人正文的指标和版本元数据。

## 14. 信息架构

建议在自动化中心增加“学习”：

1. **候选**：来源、作用域、预期收益和风险。
2. **评估中**：进度、案例和预算。
3. **Shadow**：观察数、差异和成本。
4. **待批准**：晋升摘要。
5. **已生效**：当前版本、使用量和健康状态。
6. **历史**：拒绝、回滚和归档。

候选详情页签：

- 概览。
- 变更 Diff。
- 评估案例。
- 指标和失败。
- Shadow。
- 版本与回滚。

## 15. 数据模型建议

```ts
type LearningArtifact = {
  id: string
  scopeKind: 'global' | 'project' | 'automation' | 'agent'
  scopeId?: string
  kind:
    | 'memory'
    | 'automation_template'
    | 'prompt_variant'
    | 'rubric'
    | 'retrieval_preference'
  status:
    | 'candidate'
    | 'evaluating'
    | 'rejected'
    | 'inconclusive'
    | 'shadow'
    | 'awaiting_approval'
    | 'promoted'
    | 'paused'
    | 'rolled_back'
    | 'archived'
  payload: JsonValue
  sourceRefs: LearningSourceRef[]
  baselineVersionId?: string
  promotedVersionId?: string
  createdAt: string
  updatedAt: string
}
```

建议表：

- `learning_artifacts`
- `learning_artifact_versions`
- `evaluation_suites`
- `evaluation_cases`
- `evaluation_runs`
- `evaluation_results`
- `shadow_observations`
- `promotion_events`
- `rollback_events`

## 16. 安全与隐私

1. Apply 层拒绝没有 Gate Verdict 的候选。
2. 产物类型和目标作用域使用代码白名单。
3. 安全与权限配置不在可学习目标白名单中。
4. 私人评估案例只在本地使用，不导出或发送到未授权 Provider。
5. Shadow 不调用有副作用工具。
6. Candidate 内容和评估输出都视为不可信数据。
7. Renderer 不能直接设置 Promoted 状态，Main 验证评估与审批。
8. 删除私人评估案例后清理派生缓存和 Embedding。
9. 日志不记录完整案例、Prompt、回答、文件或凭据。
10. 自动暂停采用确定性条件，不依赖模型自由判断。

## 17. 实施顺序

严格顺序：

1. 建立版本化评估案例和确定性断言。
2. 复用并行实验运行 Baseline 与 Candidate。
3. 实现 Gate Verdict，只有 Reject、Inconclusive 和 Shadow。
4. 实现 Shadow，但不允许 Apply。
5. 实现人工晋升和原子回滚。
6. 实现上线监控和确定性自动暂停。
7. 首先开放 Memory 和 Automation Template。
8. 经过长期验证后再评估 Skill、Procedure 和非安全规则。

不能先做自动改 Prompt，再补评估门。

## 18. 验收标准

- [ ] 没有评估结果的候选无法晋升。
- [ ] 安全、权限或硬约束退化必定 Reject。
- [ ] 评估不足时显示 Inconclusive，不强行选优。
- [ ] Baseline、Candidate、案例、Runtime 和评估器都被冻结和版本化。
- [ ] Shadow 不影响用户结果、不调用副作用工具、不写长期记忆。
- [ ] 晋升前展示收益、退化、成本、作用域和回滚版本。
- [ ] 第一阶段只有用户可以批准晋升。
- [ ] 晋升和回滚采用原子版本切换。
- [ ] 生效后出现确定性严重退化时自动暂停并恢复上一批准版本。
- [ ] 系统不会自动选择另一个候选替代。
- [ ] 私人会话不会默认进入评估集。
- [ ] 安全策略、权限、目录、凭据和 Electron 配置不属于可学习产物。
