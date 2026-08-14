# 分区记忆 PRD

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中 |
| 版本 | 0.1 |
| 日期 | 2026-08-13 |
| 依赖 | [自动化平台总体设计](./automation-platform-architecture.md) |

## 1. 背景

GoodBuddy 当前记忆已经支持：

- `global`、`project`、`conversation` 三种作用域。
- `preference`、`fact`、`summary`、`procedure` 四种类型。
- `proposed`、`confirmed`、`rejected` 三种状态。
- 智能心跳提出 Global 或 Project 记忆候选，由用户确认。

但当前能力仍不足以支撑自动化和并行实验：

1. 交互请求会把已加载列表中的最多 20 条已确认记忆直接拼入提示，缺少查询相关度和明确的
   会话级过滤契约。
2. 数据库有会话作用域，但心跳只提出 Global 和 Project 记忆。
3. 缺少 Automation、Experiment 和 Run 分区。
4. 来源字段存在于表结构，但普通创建和心跳候选尚未完整保存来源关系。
5. 缺少事实的有效时间、冲突、替代、访问记录和衰减。
6. 实验 Run 若共享可变记忆，会造成候选互相污染。

本设计先完成分区、来源、检索和生命周期，再评估时间知识图谱。

## 2. 核心产品判断

### 2.1 分区是权限和隔离边界

分区不是搜索标签。每次读取先根据运行快照确定允许分区，再在这些分区中检索。
模型不能请求任意分区 ID，Renderer 也不能把任意 ID 作为可信范围。

### 2.2 作用域和记忆种类是两个维度

- 作用域回答“谁可以读取”。
- 类型回答“这是什么信息”。

不能用 `summary` 表示会话范围，也不能用 `project` 表示事实类型。

### 2.3 记忆和知识库分离

| 记忆 | 知识库 |
| --- | --- |
| 用户偏好、项目约定、过程经验、会话摘要 | 文档、网页、文件和外部资料 |
| 小规模、动态、可确认和可遗忘 | 大规模、按来源同步和引用 |
| 强调作用域、来源、时态和行为影响 | 强调检索、分块和证据引用 |

不能把整个文档或长工具输出保存为记忆。

### 2.4 第一阶段不需要图数据库

SQLite 显式字段、FTS、来源关系和可选本地 Embedding 足以支持首期。时间图谱只有在以下
需求经过验证后再建设：

- 实体关系的多跳查询。
- 事实有效期和关系演变。
- 同一实体跨大量会话的别名消歧。
- 可解释的关系证据链。

## 3. 目标

- 为会话、自动化和并行 Run 提供严格隔离。
- 每条记忆显示范围、类型、状态、来源、时间和敏感度。
- 在允许分区内按相关性、重要性、新鲜度和预算检索。
- 保留冲突事实和时态，不静默覆盖。
- 让候选记忆经过确认或评估后再晋升。
- 支持编辑、移动、合并、拒绝、归档、删除和要求忘记。
- 记录哪些 Run 实际读取了哪些记忆。

## 4. 非目标

- 不保存完整聊天、文档、工具日志或隐藏推理作为记忆。
- 不自动确认敏感个人信息。
- 不默认跨项目共享 Project、Conversation 或 Run 记忆。
- 不允许模型自行创建新分区或跨分区移动记忆。
- 不承诺记忆中的事实永远正确。
- 第一阶段不建设 Memory Palace 五层空间隐喻。
- 不把向量相似度作为权限判定。

## 5. 分区模型

### 5.1 分区类型

```ts
type MemoryNamespaceKind =
  | 'global'
  | 'project'
  | 'conversation'
  | 'automation'
  | 'experiment'
  | 'run'
  | 'agent'
```

| 分区 | 内容 | 生命周期 |
| --- | --- | --- |
| Global | 用户长期偏好和跨项目通用约定 | 长期，严格确认 |
| Project | 项目术语、目标、决策和流程 | 随项目 |
| Conversation | 当前会话摘要、局部约定和待澄清信息 | 随会话或短期 |
| Automation | 某计划的稳定协议经验和运行约定 | 随计划 |
| Experiment | 实验设计、结论和限制 | 随实验 |
| Run | 单次运行观察、中间状态和临时经验 | 短期、严格隔离 |
| Agent | 某专家或角色的个性化经验 | 后续，默认关闭 |

首期实现 Global、Project、Conversation、Automation 和 Run。Experiment 可复用
Automation 机制后增加；Agent 必须在专家长期身份明确后再开放。

### 5.2 分区标识

```text
global
project:{projectId}
conversation:{conversationId}
automation:{planId}
experiment:{experimentId}
run:{automationRunId}
agent:{expertId}
```

数据库使用 UUID 外键和显式 `kind`，上述字符串只用于日志和展示，不作为未经验证的访问凭据。

### 5.3 读取链

交互会话推荐：

```text
Conversation → Project → Global
```

自动化 Run：

```text
Run → Automation → Conversation（可选）→ Project → Global
```

实验 Run：

```text
Run → Experiment frozen snapshot → Project frozen snapshot → Global frozen snapshot
```

各层使用独立结果数和字符预算。Run 层不能覆盖权限更高层，只能提供更具体上下文。

## 6. 记忆条目

```ts
type MemoryItem = {
  id: string
  namespaceId: string
  kind:
    | 'preference'
    | 'fact'
    | 'summary'
    | 'procedure'
    | 'decision'
    | 'constraint'
    | 'reflection'
  content: string
  status:
    | 'candidate'
    | 'confirmed'
    | 'rejected'
    | 'superseded'
    | 'archived'
  confidence: number
  salience: number
  sensitivity: 'normal' | 'sensitive' | 'restricted'
  validFrom?: string
  validTo?: string
  expiresAt?: string
  sourceId: string
  supersedesId?: string
  createdAt: string
  updatedAt: string
}
```

兼容映射：

- 当前 `proposed` 对应 `candidate`。
- 当前 `confirmed` 和 `rejected` 保留。
- 当前四种类型保留，并按真实需求增加 `decision`、`constraint` 和 `reflection`。

## 7. 来源与证据

### 7.1 来源类型

```ts
type MemorySource =
  | { type: 'user_entry'; createdBy: 'user' }
  | {
      type: 'message'
      conversationId: string
      messageId: string
    }
  | { type: 'task'; taskId: string; eventId?: string }
  | { type: 'heartbeat'; heartbeatRunId: string; entryId: string }
  | { type: 'supervisor'; supervisorRecordId: string }
  | { type: 'automation_run'; automationRunId: string }
  | {
      type: 'experiment_conclusion'
      experimentId: string
      conclusionId: string
    }
  | { type: 'artifact'; artifactId: string }
```

### 7.2 来源规则

- 每条非用户手动记忆必须有来源。
- 来源被删除时记忆不一定删除，但显示“来源不可用”并降低可信度。
- 来源内容不复制进记忆表，只保存有界证据摘要和引用。
- 用户确认只表示允许后续使用，不表示事实已被外部验证。
- Supervisor 判断只能生成候选，不能直接生成确认事实。

## 8. 候选生成

候选来源：

- 智能心跳。
- 用户明确“记住这个”。
- 会话结束总结。
- 自动化 Run 结束反思。
- 实验结论。
- Supervisor 建议后用户采纳。

候选生成必须：

- 限制数量和长度。
- 检查同分区近似重复。
- 标记推断和不确定性。
- 不自动提取密码、密钥、身份号码、健康和财务等敏感信息。
- 不把指令型工具输出自动当作用户偏好。
- 不从助手自己的未确认陈述提取事实。

## 9. 确认与晋升

### 9.1 允许路径

```text
Run candidate
  → Automation candidate
  → Project candidate
  → Global candidate
```

每次跨层都是显式晋升，不是移动原记录：

- 保留原候选和来源。
- 创建目标分区新版本。
- 保存晋升理由、评估和操作者。
- 可回滚到晋升前状态。

### 9.2 确认规则

- Global 默认必须人工确认。
- Project 默认人工确认，可对特定低敏感模板启用批量确认。
- Conversation 可以由用户“记住”直接确认。
- Automation 和 Run 由自动化协议决定，但只在自身范围有效。
- Experiment 结论必须结算成功且显示证据，才可成为 Project 候选。

### 9.3 拒绝

拒绝后：

- 不进入检索。
- 保存规范化摘要指纹，减少重复建议。
- 用户可查看和恢复。
- 不把拒绝内容回填给模型，除非用于“避免重复建议”的有界规则。

## 10. 检索

### 10.1 两步边界

```text
根据可信运行上下文确定允许分区
→ 在允许分区中检索和排序
```

这两步不能颠倒。先全库相似搜索再过滤会增加泄漏和实现风险。

### 10.2 排序

建议综合：

- 文本相关度。
- 可选向量相关度。
- Salience。
- Confidence。
- 新鲜度和有效时间。
- 类型匹配。
- 分区优先级。
- 最近是否已使用。

只有 `confirmed`、当前有效且敏感度允许的记忆进入普通上下文。

### 10.3 预算

建议默认：

| 层级 | 最大条数 | 最大字符 |
| --- | --- | --- |
| Run | 8 | 4,000 |
| Automation / Experiment | 8 | 4,000 |
| Conversation | 8 | 4,000 |
| Project | 10 | 5,000 |
| Global | 6 | 3,000 |

总预算还受模型上下文组装器限制。不能每层取满后无界拼接。

### 10.4 上下文格式

提供给 Runtime 的每条记忆包含：

- 类型。
- 范围。
- 内容。
- 有效时间。
- 来源类型和可选引用。
- 不确定或冲突标记。

可信指令明确说明记忆是用户确认的信息或候选证据，不是系统指令。

## 11. 冲突与时态

### 11.1 冲突

新条目与现有条目冲突时：

- 不静默覆盖。
- 创建冲突关系。
- 向用户展示两个内容、来源、时间和范围。
- 用户可选择保留两者、设定有效期、替代旧条目或拒绝新条目。

### 11.2 时态

事实和决策支持：

- `validFrom`：何时开始有效。
- `validTo`：何时不再有效。
- `observedAt`：何时被系统观察。
- `createdAt`：何时写入数据库。

例如“项目目标是 8 月发布”变更为“延期到 9 月”时，旧事实保留历史有效期，新事实成为
当前有效版本。

### 11.3 适用范围冲突

Project 记忆与 Global 偏好冲突时：

- 当前 Project 的更具体约定优先。
- 上下文中标明这是项目级覆盖。
- 不修改 Global 原记录。

## 12. 实验隔离

- 实验启动时冻结可读长期记忆快照。
- 各 Run 拥有独立 Run 分区。
- Run 期间产生的候选不互相可见。
- 实验结算后只从成功 Run 和有效证据生成 Experiment 候选。
- 最佳 Run 的临时经验不会自动晋升。
- 重跑相同协议可以选择复用原冻结快照或创建新版本，必须明确显示。

## 13. 生命周期与衰减

### 13.1 访问记录

保存有界使用记录：

- 哪个 Run 检索了该记忆。
- 是否实际进入模型上下文。
- 是否被用户或评估器认为有用。
- 最近使用时间和命中次数。

不保存完整请求副本。

### 13.2 衰减

- Preference、Constraint 和 Procedure 不仅因时间自动失效。
- Conversation、Run Summary 和 Reflection 可配置过期时间。
- 长期未命中、低 Salience 的候选可归档。
- 衰减先影响排序，再进入归档，不直接硬删除。
- Restricted 记忆可采用更短保留期。

### 13.3 删除与忘记

- 删除记忆后立即停止检索。
- “忘记”同时清理派生索引、Embedding 和缓存。
- 来源消息是否删除由其自身生命周期决定，不能反向静默删除用户会话。
- 删除 Project 时清理其分区、自动化和 Run 记忆，不影响 Global。
- 审计只保留不含原内容的删除事件和 ID 摘要。

## 14. 敏感信息

| 敏感度 | 行为 |
| --- | --- |
| Normal | 按普通确认和检索规则 |
| Sensitive | 必须人工确认，UI 持续标记 |
| Restricted | 默认不允许模型自动生成；仅用户手动创建，读取需要显式启用 |

禁止自动长期记忆：

- 密码、密钥、Token、Cookie。
- 完整身份证件、银行卡和账户凭据。
- 未经用户明确要求的健康、财务和高度私密信息。
- 工具输出中的认证数据。

## 15. 信息架构

记忆中心建议页签：

1. **记忆**：按范围、类型、状态和敏感度浏览。
2. **待确认**：候选、冲突和晋升请求。
3. **分区**：Global、Project、Conversation、Automation、Run 的统计和访问策略。
4. **使用记录**：哪些 Run 使用了哪些记忆。
5. **设置**：候选生成、保留期、敏感信息和检索预算。

每条记忆展示内容、类型、范围、来源、状态、时间、置信度、重要性和冲突。

## 16. 数据模型建议

建议表：

- `memory_namespaces`
- `memory_items`
- `memory_sources`
- `memory_relations`
- `memory_access_events`
- `memory_promotion_events`
- `memory_embeddings`，可选

现有 `memory_items` 可渐进迁移：

1. 增加 Namespace 并回填现有 Scope。
2. 回填来源为空的旧记录为 `legacy_unknown`。
3. 增加状态和类型兼容映射。
4. 上线新检索器后再停止旧的列表拼接方式。

## 17. 安全与隐私

1. 分区解析只在 Main 进行。
2. 所有 ID 重新验证对象归属和项目范围。
3. Renderer 无法指定任意分区进行搜索。
4. Runtime 只能获得有界记忆文本和来源摘要。
5. Embedding 只能发送用户已配置允许的记忆，Restricted 默认不发送外部服务。
6. 记忆内容和来源不出现在普通日志与通知。
7. 跨分区晋升需要明确操作和审计。
8. Ask 和 Execute 使用同一只读记忆检索边界。
9. 记忆不能绕过系统指令、工具审批和工作区权限。

## 18. 实施顺序

1. 修正当前交互请求的范围过滤，确保只读 Global、当前 Project 和当前 Conversation。
2. 增加来源记录和“实际进入上下文”的诊断。
3. 建立 Automation 和 Run Namespace。
4. 上线有界相关检索，替换简单列表前 20 条拼接。
5. 增加冲突、时态、替代和归档。
6. 增加实验冻结快照与 Run 隔离。
7. 增加可选本地 Embedding 和混合排序。
8. 只有明确需求后再评估时间知识图谱。

## 19. 验收标准

- [ ] 普通会话只读取 Global、当前 Project 和当前 Conversation 的允许记忆。
- [ ] 自动化 Run 只读取运行快照绑定的分区。
- [ ] 实验 Run 不能读取其他 Run 的消息或记忆。
- [ ] 每条非手动记忆都有可追溯来源。
- [ ] 候选和被拒绝记忆不进入普通上下文。
- [ ] Global 和 Project 晋升需要明确确认或评估。
- [ ] 冲突事实不被静默覆盖。
- [ ] 当前有效事实可通过有效时间正确选择。
- [ ] 上下文组装遵守各层和总字符预算。
- [ ] UI 能显示某次 Run 实际使用的记忆。
- [ ] 删除或忘记后，文本、索引和缓存不再可检索。
- [ ] Restricted 记忆不会自动生成或发送给外部 Embedding 服务。
