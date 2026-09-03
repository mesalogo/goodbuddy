# 外部知识库技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计稿 |
| 版本 | 0.1 |
| 日期 | 2026-09-03 |
| 产品需求 | [外部知识库接入 PRD](./external-knowledge-prd.md) |
| 逻辑设计 | [外部知识库逻辑设计](./external-knowledge-logic-design.md) |
| UI 设计 | [外部知识库 UI 设计](./external-knowledge-ui-design.md) |

## 1. 设计约束

1. 外部知识库扩展现有知识库领域，不建立独立检索工具、聊天范围或 Runtime 权限模型。
2. 外部绑定使用远端检索，不落地远端文档、分块、向量和图谱。
3. 所有网络、凭据、Provider 响应校验和结果标准化都在 Main 完成。
4. Renderer 只能通过受限 IPC 管理实例、读取目录、保存绑定和发起测试。
5. Dify、FastGPT、RAGFlow 使用独立 Adapter 和判别配置，不通过任意 JSON 请求模板实现。
6. 首次实现只调用无内容修改语义的列表、详情和检索接口。
7. Provider API 变化通过真实 fixture、Adapter 版本和能力快照处理，不通过猜测字段兼容。

## 2. 现有代码边界

当前实现中的主要扩展点：

| 边界 | 现有位置 | 需要的变化 |
| --- | --- | --- |
| 共享知识契约 | `src/shared/knowledge-contracts.ts`、`src/shared/contracts.ts` | 增加实例、绑定、Provider 配置和外部引用判别联合 |
| IPC 名称 | `src/shared/ipc-channels.ts` | 增加实例和目录操作通道 |
| Preload | `src/preload/index.ts` | 暴露受限、类型化的外部知识库 API |
| Main IPC | `src/main/ipc.ts` | 校验输入、调用服务、投影脱敏结果 |
| 知识服务 | `src/main/knowledge/knowledge-service.ts` | 按知识库来源分派本地或外部检索 |
| 数据库 | `src/main/knowledge/knowledge-database.ts` | 增加实例、绑定和迁移 |
| 内部类型 | `src/main/knowledge/types.ts` | 增加 Provider、实例、绑定和标准化结果类型 |
| 知识页面 | `src/renderer/src/KnowledgeWorkspace.tsx` | 实例管理、创建向导类型和外部详情 |
| 检索测试 | `src/renderer/src/KnowledgeRetrievalWorkbench.tsx` | 支持本地与外部诊断判别联合 |
| 聊天预检索 | `src/main/ipc.ts` | 统一调用 Provider-aware 检索编排 |
| Agent 知识工具 | `src/main/agent/knowledge-mcp-gateway.ts` | 与预检索复用同一编排和引用标准化 |

外部 Provider 不是 `KnowledgeSourceType`。现有 `file | directory | url` 表示会进入本地
文档、分块和索引的资料来源；把远端绑定塞入该枚举会错误触发同步、分块和来源打开逻辑。

## 3. 模块设计

建议增加：

```text
src/main/knowledge/external/
├─ external-knowledge-service.ts
├─ external-knowledge-store.ts
├─ external-knowledge-errors.ts
├─ external-knowledge-http.ts
├─ external-knowledge-registry.ts
├─ external-knowledge-normalizer.ts
└─ providers/
   ├─ dify-adapter.ts
   ├─ fastgpt-adapter.ts
   └─ ragflow-adapter.ts
```

职责：

- `ExternalKnowledgeService`：实例、目录、绑定、测试和检索编排。
- `ExternalKnowledgeStore`：实例和绑定持久化，凭据加解密。
- `ExternalKnowledgeHttp`：超时、取消、大小限制、地址和响应读取。
- `ExternalKnowledgeRegistry`：按 Provider 返回内置 Adapter，不接受运行时插件注册。
- `ExternalKnowledgeNormalizer`：统一结果边界、截断和引用。
- Adapter：构造固定端点与请求，解析 Provider 响应，声明静态配置和能力条件。

`KnowledgeService` 继续作为聊天、检索测试和 MCP 网关的统一入口。它根据
`KnowledgeBase.kind` 调用现有本地检索或 `ExternalKnowledgeService.retrieve`。

## 4. Provider Adapter

```ts
type ExternalKnowledgeProvider = 'dify' | 'fastgpt' | 'ragflow'

interface ExternalKnowledgeAdapter<PersistedConfig, CapabilitySnapshot> {
  readonly provider: ExternalKnowledgeProvider
  readonly configVersion: number

  normalizeBaseUrl(input: string): URL
  testConnection(context: AdapterContext): Promise<ConnectionTestResult>
  listKnowledgeBases(
    context: AdapterContext,
    input: CatalogPageInput
  ): Promise<CatalogPage>
  getKnowledgeBase(
    context: AdapterContext,
    remoteKnowledgeBaseId: string
  ): Promise<RemoteKnowledgeBaseSummary>
  probeRetrieval(
    context: AdapterContext,
    input: ProviderRetrieveInput<PersistedConfig>
  ): Promise<ProviderRetrieveResult>
  retrieve(
    context: AdapterContext,
    input: ProviderRetrieveInput<PersistedConfig>
  ): Promise<ProviderRetrieveResult>
  parseCapabilities(input: unknown): CapabilitySnapshot
  validateConfig(
    input: unknown,
    capabilities: CapabilitySnapshot
  ): PersistedConfig
}
```

`probeRetrieval` 可以复用 `retrieve`，但必须使用用户在创建向导中明确输入的测试查询。
不得生成会泄露组织信息的默认问题，不得调用 Provider 的 App 或模型问答接口，也不得
修改远端知识内容。Provider 自身记录 API 审计或计算检索用量不属于内容修改，必须由界面
提前说明。

Adapter 返回数据对象，不返回 React 组件、HTML 或远端 Schema。Renderer 中的配置定义
由共享的 Provider 判别联合和本地字段描述生成。

## 5. 共享契约

### 5.1 实例

```ts
type CredentialMutation =
  | { action: 'keep' }
  | { action: 'replace'; value: string }
  | { action: 'clear' }

interface ExternalKnowledgeInstanceSummary {
  id: string
  name: string
  provider: 'dify' | 'fastgpt' | 'ragflow'
  baseUrl: string
  enabled: boolean
  credentialStatus: 'configured' | 'missing' | 'unavailable'
  probeStatus:
    | 'untested'
    | 'catalog-ready'
    | 'healthy'
    | 'list-restricted'
    | 'auth-failed'
    | 'unreachable'
    | 'incompatible'
    | 'failed'
  detectedVersion?: string
  bindingCount: number
  lastTestedAt?: string
  lastErrorCode?: string
}
```

Renderer 输入使用 `CredentialMutation`，因此新密钥会在输入控件和该次 IPC 中短暂存在。
Main 返回值永远没有 `credential`、`apiKey`、`authorization` 或加密 envelope。

### 5.2 绑定

```ts
interface ExternalKnowledgeBinding {
  knowledgeBaseId: string
  instanceId: string
  remoteKnowledgeBaseId: string
  remoteName: string
  remoteDescription?: string
  commonConfig: ExternalKnowledgeCommonConfig
  providerConfig: DifyConfig | FastGptConfig | RagflowConfig
  providerConfigVersion: number
  adapterVersion: number
  lastVerifiedAt?: string
}
```

`providerConfig` 必须带 `provider` 判别字段，且与实例 Provider 一致。`remoteName` 是用于
显示和变化检测的快照，不是授权标识。

### 5.3 标准化结果

现有 `KnowledgeRetrievalResult` 假定结果映射到本地 `documentId/sourceId/chunkId`。需要改为
引用定位的判别联合，同时保持现有调用方可按统一字段读取片段：

```ts
type KnowledgeReferenceLocator =
  | {
      kind: 'local'
      documentId: string
      sourceId: string
      chunkId: string
      parentChunkId?: string
    }
  | {
      kind: 'external'
      provider: ExternalKnowledgeProvider
      instanceId: string
      remoteKnowledgeBaseId: string
      remoteDocumentId?: string
      remoteChunkId?: string
      providerScore?: number
      location?: string
      sourceUrl?: string
      metadata?: Record<string, string | number | boolean | null>
    }

interface UnifiedKnowledgeRetrievalResult {
  knowledgeBaseId: string
  documentTitle: string
  sourceDisplayName: string
  snippet: string
  relevance?: number
  rank: number
  locator: KnowledgeReferenceLocator
}
```

`remoteDocumentId` 和 `remoteChunkId` 只保存 Provider 实际返回的标识，缺失时不得从标题、
序号或内容哈希推导。`providerScore` 保留原始值，但不改名为统一 `relevance`。只有经过
单独定义和验证的归一化算法才能填写跨 Provider `relevance`。初始跨库拼装按结果配额和
稳定 Provider 顺序工作，不按原始分数混排。

所有共享 Schema 使用严格对象并限制：

- 查询不超过 4,000 字符；同时遵守 Provider 更小限制，例如 Dify 当前公开接口的
  250 字符限制，超出时在发送前明确失败，不静默截断查询。
- 单次目录页不超过 100 项，总目录最多 500 项。
- 标准化结果最多 20 条，单片段最多 8,000 字符。
- 标题、ID、定位、URL 和元数据键值均设独立上限。
- Provider 原始响应总字节数设固定上限，超限立即取消读取。

## 6. 持久化

### 6.1 数据库变化

保留现有 `knowledge_bases` 表，增加：

```sql
ALTER TABLE knowledge_bases
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'local'
  CHECK (kind IN ('local', 'external'));
```

增加实例表：

```sql
CREATE TABLE external_knowledge_instances (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('dify', 'fastgpt', 'ragflow')),
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  credential_envelope_json TEXT,
  probe_status TEXT NOT NULL,
  detected_version TEXT,
  capabilities_json TEXT NOT NULL,
  transport_security TEXT NOT NULL,
  transport_risk_accepted_url TEXT,
  transport_risk_accepted_at TEXT,
  last_tested_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

增加绑定表：

```sql
CREATE TABLE external_knowledge_bindings (
  knowledge_base_id TEXT PRIMARY KEY
    REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL
    REFERENCES external_knowledge_instances(id) ON DELETE RESTRICT,
  remote_knowledge_base_id TEXT NOT NULL,
  remote_name TEXT NOT NULL,
  remote_description TEXT,
  common_config_json TEXT NOT NULL,
  provider_config_json TEXT NOT NULL,
  provider_config_version INTEGER NOT NULL,
  adapter_version INTEGER NOT NULL,
  binding_status TEXT NOT NULL,
  last_verified_at TEXT,
  last_success_at TEXT,
  last_error_code TEXT,
  UNIQUE(instance_id, remote_knowledge_base_id)
);
```

已有知识库迁移为 `kind = 'local'`。外部知识库仍保留现有名称、描述和创建时间，但本地
`storageMode`、图谱、分块和本地检索设置不进入外部请求；后续可以在数据库重构时再移除
这些历史必填默认值，本功能不为此扩大迁移范围。

### 6.2 凭据

复用 `SettingsCredentialCipher` 和 Electron `safeStorage`：

- `replace`：Main 加密新值后在一个事务中替换 envelope。
- `keep`：不读取、不重写现有 envelope。
- `clear`：确认后删除 envelope，并把实例凭据状态设为缺失。
- 安全存储不可用时拒绝新增或替换，不降级为明文。
- 解密只发生在发起请求前；请求结束后不缓存明文。

实例导出、诊断和数据库普通 JSON 视图均排除 `credential_envelope_json`。

## 7. IPC 设计

建议增加独立通道：

```text
knowledge:external-instances:list
knowledge:external-instances:test
knowledge:external-instances:save
knowledge:external-instances:set-enabled
knowledge:external-instances:delete
knowledge:external-catalog:list
knowledge:external-catalog:get
knowledge:external-bindings:create
knowledge:external-bindings:update
knowledge:external-bindings:remove
knowledge:external-retrieval:test
```

所有 Handler 必须：

1. `assertTrustedSender`。
2. 用共享 Zod Schema 解析严格输入。
3. 根据实例 ID 在 Main 读取地址和凭据，不接受 Renderer 在检索请求中重复传入。
4. 使用稳定错误码返回脱敏错误。
5. 对网络操作支持 AbortSignal、总超时和响应大小限制。

目录和测试请求返回 `requestId`。Renderer 仍需校验当前类型、实例和目标与响应关联，避免
旧响应覆盖新表单。

## 8. HTTP 边界

### 8.1 服务地址

- 只接受 `http:` 和 `https:`。
- 拒绝用户名、密码、查询和片段。
- Adapter 负责规范化 Provider 所需 API 根路径，避免用户填写完整操作端点。
- 请求只能拼接 Adapter 内置相对路径，远端目录项或错误不能改变目标 URL。
- 重定向默认拒绝；若某 Provider 的受支持部署确需重定向，只允许同源且不得跨跳转发送
  Authorization。
- 当前全局“内网兼容模式”决定是否允许 HTTP 和非标准 HTTPS 证书；操作开始后冻结该值。
- HTTP 或实际使用证书例外时，Main 返回 `transportSecurity` 风险状态。用户必须针对规范化
  后的当前地址明确确认，才能保存实例或发送 API Key；地址变化立即使旧确认失效。
- 不进行公共云回退，不把自部署地址替换成 Provider 官方地址。

用户明确配置内网地址属于产品用途，因此不能采用禁止私网地址的通用 SSRF 规则。安全边界
依靠显式实例配置、Main-only 请求、固定端点、无任意方法和无远端 URL 跟随。

### 8.2 请求限制

- 默认超时 15 秒，用户可在 1 至 60 秒内调整。
- 目录、详情和检索分别设置响应字节上限。
- JSON 解析后仍执行深度、数组数量、字符串长度和未知字段策略。
- 默认不自动重试。用户重试或上层下一次检索会产生新请求。
- 取消、应用关闭和实例删除立即终止相关请求。
- 日志只记录 Provider、实例 ID、操作、状态码、稳定错误码、耗时和字节数。

## 9. Provider 映射

本节记录 2026-09-03 核对的初始公开接口。实施时应把每个受支持版本的真实响应保存为
去敏 fixture，并以 fixture 和真实实例测试作为发布依据。

### 9.1 Dify

| 操作 | 接口 |
| --- | --- |
| 列表 | `GET /v1/datasets` |
| 检索 | `POST /v1/datasets/{dataset_id}/retrieve` |
| 认证 | `Authorization: Bearer <knowledge-api-key>` |

Adapter 只接受 Knowledge Service API Key，不调用应用 `/info`、Chat 或 Workflow。默认不
发送 `retrieval_model`，沿用远端知识库配置。用户选择覆盖时，Adapter 必须一次收集并验证
当前接口要求的搜索方式、Top K、阈值、`reranking_mode`，以及相应的 Rerank Provider/模型
或关键词/向量权重与 Embedding Provider/模型；缺少任何必填标识时不构造请求。响应从
`records[].segment`、`score`、文档名称和元数据提取标准化引用。

Dify 当前文档限制查询不超过 250 字符。GoodBuddy 不静默截断；超出时检索测试和聊天
诊断返回 Provider 限制，并允许后续单独设计查询压缩策略。

### 9.2 FastGPT

| 操作 | 接口 |
| --- | --- |
| 列表 | `POST /api/core/dataset/list` |
| 详情 | `GET /api/core/dataset/detail?id=...` |
| 检索 | `POST /api/core/dataset/searchTest` |
| 认证 | `Authorization: Bearer <api-key>` |

列表响应同时包含文件夹和知识库，只有 `type = dataset` 可以绑定。检索映射 `datasetId`、
`text`、Token `limit`、`similarity`、`searchMode` 和 `usingReRank`。初始版本不发送查询优化
字段，避免调用 FastGPT 配置的 LLM。
响应从 `q`、`a`、`sourceName`、`sourceId`、`collectionId` 和 `score` 构造片段与引用。

FastGPT 4.15.0 起部署实例的 `/apidoc/devapi` 是接口事实来源，手工文档可能落后。支持矩阵
必须按真实版本测试；不能因为健康页可访问就假定列表和检索 Schema 相同。`searchTest`
可能记录 `SEARCH_TEST` 等远端审计并更新 API Key 用量；Embedding 和 Rerank 也可能产生
费用。GoodBuddy 将这些行为作为检索成本显示，不宣称该接口没有副作用。

### 9.3 RAGFlow

| 操作 | 接口 |
| --- | --- |
| 列表/详情 | `GET /api/v1/datasets` |
| 检索 | `POST /api/v1/retrieval` |
| 认证 | `Authorization: Bearer <api-key>` |

检索映射 `question`、`dataset_ids`、`page_size`、`similarity_threshold`、
`vector_similarity_weight`、`knn_top_k`、重排、`use_kg` 和
`include_knowledge_compilation`。不发送已弃用的 `top_k`。响应从 `data.chunks` 和
`data.doc_aggs` 提取片段、文档、位置和原始相似度。

图谱规则：

- `parser_config.graphrag` 或等价详情字段作为已有图谱的证据，不写回。
- `use_kg` 是检索时开关，只在已有图谱和受支持版本均确认后发送。
- Knowledge Compilation 与旧 GraphRAG 分别建模。
- `include_knowledge_compilation` 使用本地保存的显式布尔值，初始默认 false；即使服务端
  默认 true，也不依赖字段省略获得隐式行为。
- Provider 没有返回图节点或路径证据时，GoodBuddy 不生成图谱引用。

## 10. 检索编排

```text
retrieveMany(knowledgeBaseIds, query, requestContext)
  ├─ load and authorize GoodBuddy knowledge bases
  ├─ partition local and external bindings
  ├─ local: existing retrieval path
  ├─ external: bounded concurrent adapter requests
  ├─ validate and normalize each response
  ├─ allocate deterministic context budget
  └─ return evidence plus per-library diagnostics
```

预检索和 `knowledge_search` 工具必须调用同一个 `retrieveMany`。如果只修改聊天预检索而
未修改 `KnowledgeMcpGateway`，`auto` 和 `always` 会产生不同能力，这是阻断发布的问题。

### 10.1 上下文预算

- 每个知识库先保留不超过其 `resultLimit` 的结果。
- 先给每个成功知识库一个最小有界配额，再按稳定顺序分配剩余字符。
- 不用不同 Provider 原始分数决定跨库优先级。
- 片段截断在 Main 完成并在引用中标记。
- 相同实例的多个绑定仍按绑定分别请求，除非 Provider 明确支持且 Adapter 实现等价的多
  Dataset 请求；合并不得改变每个绑定的配置和诊断。

### 10.2 失败结果

返回结构包含每个知识库的：

```ts
interface KnowledgeRetrievalOutcome {
  knowledgeBaseId: string
  status: 'success' | 'empty' | 'failed' | 'cancelled'
  durationMs: number
  resultCount: number
  errorCode?: ExternalKnowledgeErrorCode
  truncated: boolean
}
```

至少一个 `success` 或 `empty` 表示检索编排完成；全部 `failed/cancelled` 时上层显示整体失败。

## 11. 引用与来源打开

外部结果不能进入依赖本地数据库的 `referenceContext` 和 `openSource` 路径。

- 引用详情直接使用请求时保存的标准化片段和定位。
- Main 可以按远端片段 ID 提供一次只读重新读取，但初始版本不要求。
- Provider 返回 URL 只作为不可信元数据保存。没有独立 URL 规则和真实实例验证前，
  Renderer 不显示打开链接操作。
- 活动和会话持久化保存标准化引用，其中包含实际用于回答的有界远端片段；这属于引用
  留存，不是批量同步或本地索引。删除会话或对应活动时按现有生命周期删除该副本。
- 实例删除后，历史引用仍显示 Provider、知识库、文档名称和已保存片段，但标记连接已移除。

## 12. 支持矩阵与版本变化

每个 Adapter 维护明确的最低版本、已验证版本和 `adapterVersion`。连接测试优先读取可靠的
版本接口或响应头；无法识别版本时，只允许经真实请求验证过的基础列表和检索字段，高级字段
保持不可用。

Adapter 可以保存少量受控事实，例如“目录接口可用”“详情表明已构建图谱”，但不尝试从
远端拼出完整 capability manifest，也不计算 capability fingerprint。

- `adapterVersion` 相同且实例仍在支持矩阵内：解析已保存配置并执行。
- Adapter 升级：使用明确的配置迁移或把绑定标记为 `config-invalid`，不猜测字段迁移。
- 实例版本离开支持矩阵：停止发送高级字段，并要求重新测试和确认。
- 新能力出现：保持默认关闭，用户主动配置后才发送。
- RAGFlow `use_kg` 还要求当前远端知识库存在已构建图谱的证据。

## 13. 安全与隐私

- API Key 在用户输入和保存 IPC 中短暂存在，随后使用系统安全存储加密；保存后不返回
  Renderer，也不进入 Runtime、日志和普通元数据。
- 请求不附带完整会话、附件、本地知识库证据、系统提示、模型配置或其他 Provider 结果。
- Provider 结果使用与本地知识证据相同的不可信上下文标记。
- Adapter 拒绝响应中的原型污染键、过深对象、超长数组和非有限数值。
- 远端错误正文只用于 Main 内映射，日志与 UI 使用稳定错误码和短消息。
- 外部知识库不能扩大当前对话显式选择的 GoodBuddy 知识库 ID。
- Ask 与 Execute 对知识检索均为只读，Execute 不获得额外 Provider 权限。
- Provider 配置中的模型 ID、背景文本和 Metadata 条件按独立长度限制验证，不能携带凭据。
- HTTP 或证书例外需要按当前规范化地址确认凭据传输风险，地址变化后重新确认。

## 14. 测试

### 14.1 契约测试

- 每个 Provider 的列表、详情、检索成功和错误 fixture。
- 未知字段、缺字段、错误类型、超长内容、非有限分数和超大响应。
- Dify 查询长度、FastGPT 文件夹过滤、RAGFlow 图谱和 Knowledge Compilation 字段。
- Provider 配置判别联合拒绝类型错配和未知字段。

### 14.2 安全测试

- 保存完成后的 Renderer 快照、IPC 返回值、日志、错误、活动和导出中不存在明文 API Key；
  `replace` 输入只在当前表单和单次 IPC 请求中短暂存在。
- `keep/replace/clear` 凭据语义和安全存储不可用路径。
- 地址中的凭据、查询、片段、危险 scheme、跨源重定向和远端 URL 注入被拒绝。
- 取消、超时、响应大小上限和应用关闭释放请求。

### 14.3 集成测试

- 实例保存、目录读取、手工 ID、绑定创建、编辑和本地移除。
- 同一远端目标重复绑定被拒绝。
- 删除实例的引用保护和级联本地移除确认。
- 本地与外部 `retrieveMany` 部分成功、全部失败和确定性上下文预算。
- 聊天 `always` 与 Agent `knowledge_search` 使用同一 Provider-aware 编排。
- 历史引用在实例或绑定移除后仍可读。

### 14.4 UI 测试

- 类型切换、异步旧响应、目录搜索、刷新和手工模式。
- 两栏与窄窗口堆叠、键盘、焦点恢复和离开保护。
- Provider 字段显隐、失效配置、RAGFlow 图谱说明和恢复默认。
- 外部详情不出现导入、同步、分块和本地图谱操作。
- 错误、零结果、部分失败和 Provider 引用显示。

### 14.5 真实实例验收

每个 Provider 至少选择一个明确版本的自部署实例，记录：

- 版本、部署方式和认证范围。
- 列表与检索的请求/响应 fixture，移除凭据和业务正文。
- 默认与专属配置是否真实生效。
- 401、403、404、429、超时和取消行为。
- 查询、片段、引用和诊断的实际上限。

Mock 或公开文档通过不能代替真实实例验收。

## 15. 实施顺序

这里的顺序只用于控制代码依赖，不裁剪产品设计：

1. 建立共享判别契约、数据库迁移和凭据存储。
2. 实现 HTTP 边界、错误映射和 Adapter Registry。
3. 逐个实现三种 Provider，并用 fixture 完成契约测试。
4. 实现实例管理和目录 IPC。
5. 扩展创建向导、统一列表和外部详情。
6. 扩展检索测试、引用和 `retrieveMany`。
7. 接入聊天预检索与 `KnowledgeMcpGateway`。
8. 完成真实实例、安全、响应式和跨平台验收。

## 16. 发布条件

- 三种 Provider 的受支持版本和限制已在产品界面或发布说明中可查。
- 真实实例列表、绑定、检索和错误矩阵均通过。
- 没有写入远端知识内容的代码路径。
- API Key 泄漏测试、地址边界和响应大小测试通过。
- 本地知识库创建、同步、检索、图谱和引用回归测试通过。
- `auto`、`always`、检索测试和 MCP 知识工具得到一致的外部知识能力。

## 17. 需求追踪

| 需求 | 技术落点 | 验证 |
| --- | --- | --- |
| `EK-FR-01` 至 `EK-FR-03` | 实例契约、Store、实例 IPC、凭据和测试状态 | 实例集成测试、安全测试 |
| `EK-FR-04`、`EK-FR-05` | Adapter 目录与详情接口、目录 IPC | Provider fixture、手工 ID 集成测试 |
| `EK-FR-06` 至 `EK-FR-09` | Provider 判别联合、Adapter 配置版本、Renderer 本地字段定义 | 契约测试、UI 字段显隐测试 |
| `EK-FR-10`、`EK-FR-11` | `KnowledgeBase.kind`、绑定表、统一 `retrieveMany` | 本地与外部混合检索测试 |
| `EK-FR-12`、`EK-FR-13` | 引用定位判别联合、结果标准化、检索测试 IPC | 引用持久化与 UI 测试 |
| `EK-FR-14` | 稳定错误码、逐库 Outcome、取消和超时 | 错误 fixture、部分失败测试 |
| `EK-FR-15` | 外键限制、绑定本地删除、无远端写接口 | 删除生命周期测试 |
| `EK-FR-16` | Main-only HTTP、固定端点、传输风险确认 | 地址、证书和凭据泄漏测试 |
