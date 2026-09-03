# 外部知识库逻辑设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计稿 |
| 版本 | 0.1 |
| 日期 | 2026-09-03 |
| 关联需求 | [外部知识库接入 PRD](./external-knowledge-prd.md) |
| 关联场景 | [外部知识库 User Stories](./external-knowledge-user-stories.md) |

## 1. 不变量

### EK-I-01 单一知识库身份

本地知识库和外部知识库都使用 GoodBuddy `knowledgeBaseId` 参与聊天范围、检索模式、
工具授权和活动记录。Provider、实例 ID 和远端知识库 ID 不能替代该授权单位。

对应：`EK-FR-10`、`EK-FR-11`、`EK-US-C1`。

### EK-I-02 外部绑定只读

GoodBuddy 对外部实例只执行连接测试、目录读取、详情读取和检索。添加、编辑、移除
均只修改本机记录，不调用远端创建、更新、上传或删除接口。

对应：`EK-FR-15`、`EK-US-A3`。

### EK-I-03 凭据不离开 Main

API Key 明文只在 Main 内完成解密并短暂进入请求头。Renderer、Preload 返回值、Runtime、
Provider 配置、知识库元数据、诊断、日志和错误只能获得凭据状态。

对应：`EK-FR-02`、`EK-FR-11`。

### EK-I-04 Provider 不能定义界面

远端响应只提供数据和能力证据。可显示字段、字段类型、范围、默认值和请求映射均来自
GoodBuddy 内置、版本化的 Provider Adapter。

对应：`EK-FR-09`、`EK-US-D1`。

### EK-I-05 无静默切换

请求固定使用绑定保存的实例、远端知识库和 Provider 配置。失败时不切换实例、公共云
地址、认证方式或其他知识库。

对应：`EK-FR-14`、`EK-FR-16`、`EK-US-C4`。

### EK-I-06 零结果与失败分离

成功响应经过过滤后没有片段才是零结果。超时、认证、权限、限流、目标不存在、服务错误
和响应无效均为失败，不能折叠成零结果。

对应：`EK-FR-14`、`EK-US-D4`。

### EK-I-07 外部证据不可信

Provider 返回的名称、内容、元数据、URL 和错误均视为不可信输入，经过长度、数量、类型
和 URL 校验后才能显示或进入 Runtime。内容中的指令不能改变系统或工具权限。

对应：`EK-FR-12`。

### EK-I-08 Provider 配置不跨类型复用

Dify、FastGPT 和 RAGFlow 使用各自的判别配置。切换知识库类型或实例 Provider 时，旧类型
配置不参与新请求，也不能按同名字段自动迁移。

对应：`EK-FR-06`、`EK-FR-09`。

## 2. 对象关系

```text
ExternalKnowledgeInstance 1 ─── n ExternalKnowledgeBinding
                                      │
                                      │ 1:1
                                      ▼
                                KnowledgeBase
```

- 实例可以没有绑定。
- 外部知识库只能绑定一个实例和一个远端知识库 ID。
- 同一实例的同一远端知识库默认只允许存在一个绑定，避免重复选择和重复检索。
- 允许不同实例绑定同名或相同远端 ID，因为实例边界不同。
- 本地知识库不存在 `ExternalKnowledgeBinding`。

## 3. 实例状态

实例状态由启停、凭据和最近探测三个维度组成，不能用一个布尔值代替。

### 3.1 持久状态

| 维度 | 值 |
| --- | --- |
| 启停 | `enabled`、`disabled` |
| 凭据 | `configured`、`missing`、`unavailable` |
| 探测 | `untested`、`catalog-ready`、`healthy`、`list-restricted`、`auth-failed`、`unreachable`、`incompatible`、`failed` |

`unavailable` 表示系统安全存储当前无法解密或保存凭据，与用户尚未配置的 `missing` 分开。

### 3.2 派生可用性

| 条件 | 目录读取 | 已绑定知识库检索 | 页面状态 |
| --- | --- | --- | --- |
| disabled | 禁止 | 禁止 | 已停用 |
| missing / unavailable | 禁止 | 禁止 | 缺少凭据 / 凭据不可用 |
| auth-failed | 禁止 | 禁止 | 认证失效 |
| unreachable | 可重试 | 可重试 | 无法连接 |
| incompatible | 禁止 | 禁止 | 接口不兼容 |
| list-restricted | 禁止 | 允许按 ID 验证与检索 | 需手工指定知识库 |
| catalog-ready | 允许 | 创建绑定时验证 | 目录可用，检索待验证 |
| healthy | 允许 | 允许 | 正常 |
| untested | 允许测试 | 已有绑定可尝试检索 | 未测试 |

保存新实例要求至少完成服务可达和认证验证。目录受限可以保存；检索接口尚未通过时，
实例不能用于创建绑定。

## 4. 连接测试状态机

```text
idle
  └─ test → connecting
               ├─ network failure → unreachable
               └─ connected → authenticating
                                  ├─ 401 → auth-failed
                                  ├─ incompatible response → incompatible
                                   └─ authenticated → listing
                                                         ├─ 403 / unsupported → list-restricted
                                                         └─ success
                                                              ├─ no target → catalog-ready
                                                              └─ target selected → probing-retrieval
                                                                                       ├─ success / empty → healthy
                                                                                       └─ failure → failed
```

检索探测需要一个目标知识库。新增实例尚未选择目标时，目录成功即可把实例保存为“目录可用，
检索待绑定验证”；创建绑定时补做真实检索。手工模式必须先填写目标 ID，再执行检索探测。
检索请求正常完成但返回零条结果时，说明接口和目标可访问，可继续创建绑定；失败状态按错误
分类处理。

每次测试拥有 request ID 和取消信号。用户修改 Provider、地址、凭据或实例后，旧 request ID
的结果作废。

## 5. 目录读取规则

1. 只有选定、启用且凭据可用的实例可以读取目录。
2. Provider 列表接口按适配器定义分页，Main 最多向 Renderer 返回 500 个目录项。
3. FastGPT 列表中的文件夹和知识库必须按类型区分；文件夹不可作为绑定目标。
4. 列表搜索优先使用 Provider 支持的服务端过滤，不支持时只过滤已经有界加载的当前结果。
5. 下拉列表以远端 ID 为值，以远端名称为标签；重名时追加短 ID 或父级名称。
6. 已经绑定的目标显示“已添加”并禁止重复添加。
7. 远端列表项名称变化不自动修改 GoodBuddy 显示名称，只更新远端名称快照。
8. 刷新失败时可以保留上次成功目录供查看，但不得用旧目录完成新绑定，直到目标重新验证。

## 6. 创建向导状态

### 6.1 类型

```text
local | dify | fastgpt | ragflow
```

`local` 使用现有字段和验证。外部类型使用以下步骤状态：

```text
provider selected
→ instance selected
→ catalog loading / manual ID
→ remote target selected
→ configuration valid
→ retrieval verified
→ binding created
```

前置字段变化时，后续状态按下表失效：

| 变化 | 必须清除或重新验证 |
| --- | --- |
| 类型 | 实例、远端目标、全部 Provider 配置、测试结果 |
| 实例 | 远端目标、能力快照、Provider 配置、测试结果 |
| 远端目标 | 远端详情、能力适用性、测试结果 |
| 通用或 Provider 配置 | 测试结果 |
| 显示名称 | 不清除测试结果 |

## 7. 配置模型

### 7.1 通用配置

| 字段 | 范围 | 默认值 | 语义 |
| --- | --- | --- | --- |
| `resultLimit` | 1 至 20 | 6 | Provider 结果标准化后最多保留的片段数 |
| `requestTimeoutMs` | 1,000 至 60,000 | 15,000 | 单次远端请求总时限 |
| `maxSnippetCharacters` | 500 至 8,000 | 4,000 | 单片段进入 IPC 和 Runtime 前的字符上限 |

Provider 请求仍使用自己的候选数量或 Token 预算。`resultLimit` 只定义 GoodBuddy 最终保留
上限，不改写 Provider 字段的单位。

### 7.2 Dify 配置

| 字段 | 初始范围 | 说明 |
| --- | --- | --- |
| `useDatasetDefaults` | boolean，默认 true | 开启时不发送 `retrieval_model` 覆盖 |
| `searchMethod` | keyword / semantic / full-text / hybrid | 对应 Dataset Retrieve 检索方式 |
| `providerTopK` | 1 至适配器上限 | Dify 返回候选数量 |
| `scoreThresholdEnabled` | boolean | 是否向 Dify 发送分数阈值 |
| `scoreThreshold` | 0 至 1 | 开启阈值后生效 |
| `rerankingMode` | weighted-score / reranking-model | 覆盖检索配置时必填 |
| `rerankingProvider`、`rerankingModel` | 受支持的远端标识 | 选择模型重排时必填 |
| `keywordWeight`、`vectorWeight` | 0 至 1，总和为 1 | 加权混合模式时生效 |
| `embeddingProvider`、`embeddingModel` | 受支持的远端标识 | Dify 要求时从知识库详情选择或填写 |

`useDatasetDefaults` 开启时，其余覆盖字段隐藏且不发送。关闭后必须收集当前 Dify 接口
构造 `retrieval_model` 所需的完整字段，缺少 Provider 或模型标识时不能保存。

### 7.3 FastGPT 配置

| 字段 | 初始范围 | 说明 |
| --- | --- | --- |
| `searchMode` | embedding / fullTextRecall / mixedRecall | 搜索方式 |
| `tokenLimit` | 适配器限制，最高 20,000 | Provider 返回内容预算，不等同结果条数 |
| `similarity` | 0 至 1 | 最低相关度 |
| `usingRerank` | boolean | 使用 FastGPT 重排 |

初始版本不开放 FastGPT 查询优化字段，避免把查询发送给 FastGPT 配置的 LLM。检索和重排
仍可能产生远端 Embedding、Rerank 用量及 API 审计记录，测试与保存配置时必须说明。

### 7.4 RAGFlow 配置

| 字段 | 初始范围 | 说明 |
| --- | --- | --- |
| `similarityThreshold` | 0 至 1 | 最低综合相似度 |
| `vectorSimilarityWeight` | 0 至 1 | 向量分数权重 |
| `knnTopK` | 1 至适配器上限 | KNN 候选数量，不使用已弃用 `top_k` |
| `rerankCandidatesCount` | 0 或正整数 | 重排候选数量，实例支持时显示 |
| `rerankId` | 可选受限字符串 | 远端重排模型 ID |
| `useKg` | boolean，默认 false | 仅在已有图谱证据成立时允许开启 |
| `includeKnowledgeCompilation` | boolean，默认 false | 实例支持时显式发送，禁止依赖服务端默认 true |
| `metadataCondition` | 后续受控编辑器 | 初始版本不接受任意 JSON 文本 |

`parser_config.graphrag.use_graphrag` 描述构建状态，不是检索参数。只有列表、详情或受控
探测提供已有图谱的证据时，界面才允许开启 `useKg`。Knowledge Compilation 是另一项
检索能力，必须与旧 GraphRAG 分别显示和保存。

## 8. 配置优先级

生效请求由以下信息组成：

```text
GoodBuddy 固定安全上限
∩ 当前 Adapter 支持矩阵
∩ 当前绑定保存的通用配置和 Provider 配置
= 本次请求配置
```

- 固定安全上限不可被实例或用户扩大。
- 远端知识库自身默认值只用于创建表单的建议值，不在每次请求时覆盖本地已保存值。
- Provider 增加新字段不会自动启用。
- 当前实例版本离开 Adapter 支持矩阵，或 Adapter 新版本无法解析已保存配置时，绑定标记
  配置失效；用户确认前不重写配置。
- 服务端忽略未知字段不能视为成功。Adapter 只发送已知且受支持的字段。

## 9. 绑定状态

| 状态 | 条件 | 可进入聊天范围 |
| --- | --- | --- |
| `ready` | 实例可用，目标最近验证成功，配置有效 | 是 |
| `untested` | 迁移或新增后尚未完成真实检索 | 否 |
| `instance-disabled` | 实例停用 | 否 |
| `credential-error` | 凭据缺失、不可用或认证失败 | 否 |
| `remote-missing` | 远端目标返回不存在 | 否 |
| `config-invalid` | 已保存配置不再受支持 | 否 |
| `temporarily-unavailable` | 超时、限流或服务错误 | 是，但本次显示失败并允许重试 |

短暂故障不立即永久禁用绑定；认证失败、目标不存在和配置失效会改变持久状态。

## 10. 多知识库检索

1. 读取请求冻结的 GoodBuddy 知识库 ID 集合。
2. 本地库进入本地检索，外部库按实例和绑定构造独立请求。
3. 同一请求最多选择现有契约允许的 20 个知识库，并遵循全局并发上限。
4. 每个库单独记录成功、零结果、失败、耗时和截断。
5. 成功结果按知识库保留来源，不比较不同 Provider 的原始分数。
6. 上下文拼装使用现有总字符预算，在各成功知识库间采用确定性配额。
7. 全部失败时返回检索失败；至少一个成功时返回证据和部分失败诊断。

初始版本不对跨 Provider 结果运行统一学习型重排。后续如增加，必须保留原始 Provider
分数和重排来源，且单独定义评估数据。

## 11. 错误分类

| 稳定错误码 | 用户状态 | 持久影响 |
| --- | --- | --- |
| `EXTERNAL_KB_NETWORK` | 无法连接实例 | 无 |
| `EXTERNAL_KB_TIMEOUT` | 检索超时 | 无 |
| `EXTERNAL_KB_AUTH` | 认证失效 | 实例标记认证失败 |
| `EXTERNAL_KB_FORBIDDEN` | 没有访问权限 | 目录或绑定按操作标记受限 |
| `EXTERNAL_KB_NOT_FOUND` | 远端知识库不存在 | 绑定标记目标不存在 |
| `EXTERNAL_KB_RATE_LIMITED` | 请求过于频繁 | 无，可显示建议等待 |
| `EXTERNAL_KB_INCOMPATIBLE` | 接口或配置不兼容 | 实例或绑定标记不兼容 |
| `EXTERNAL_KB_INVALID_RESPONSE` | 返回内容无法读取 | 无，记录脱敏诊断 |
| `EXTERNAL_KB_SERVER` | 外部服务处理失败 | 无 |
| `EXTERNAL_KB_CANCELLED` | 已取消 | 无 |

Provider 原始正文不能直接成为用户错误。Adapter 将其映射为稳定错误码和有界短消息。

## 12. 删除规则

| 操作 | 无绑定 | 有绑定 |
| --- | --- | --- |
| 停用实例 | 直接停用 | 允许；绑定变为不可用 |
| 清除凭据 | 直接清除 | 需要确认；绑定保留但不可用 |
| 删除实例 | 直接删除 | 阻止直接删除，要求同时移除本地绑定 |
| 移除绑定 | 删除本地绑定 | 不影响实例和远端知识库 |

删除确认不得使用“删除远端知识库”等文案。

## 13. 需求追踪

| 需求 | 主要逻辑 | User Story |
| --- | --- | --- |
| `EK-FR-01` 至 `EK-FR-03` | 实例状态、连接测试状态机 | `EK-US-A1`、`EK-US-A2` |
| `EK-FR-04`、`EK-FR-05` | 目录读取规则、手工目标验证 | `EK-US-B1`、`EK-US-B2` |
| `EK-FR-06`、`EK-FR-07`、`EK-FR-08`、`EK-FR-09` | 创建向导状态、配置模型和优先级 | `EK-US-B3`、`EK-US-B4`、`EK-US-D1`、`EK-US-D3` |
| `EK-FR-10` 至 `EK-FR-13` | 单一身份、多知识库检索和引用规则 | `EK-US-C1` 至 `EK-US-C3`、`EK-US-D2` |
| `EK-FR-14` | 绑定状态、错误分类和部分失败 | `EK-US-C4`、`EK-US-D4` |
| `EK-FR-15` | 对象关系和删除规则 | `EK-US-A3` |
| `EK-FR-16` | 无静默切换、请求冻结和传输风险确认 | `EK-US-C2` |

## 14. 逻辑完整性

已确定：

- 产品入口、对象关系、只读边界和凭据边界。
- 目录读取与手工 ID 的切换条件。
- 三种 Provider 的初始配置范围和 RAGFlow 图谱语义。
- 多知识库部分失败、删除和版本变化规则。

实施前仍需技术验证：

- 选定支持的 Dify、FastGPT、RAGFlow 最低版本，形成固定支持矩阵并保存真实响应 fixture。
- 验证各版本检索探测的 API 审计、用量和内容修改行为。
- 确定 Provider 返回 URL 的安全打开策略；未验证前只显示文本定位和远端 ID。
- 依据真实延迟确定默认并发上限和跨知识库上下文配额。
