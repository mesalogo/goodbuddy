# GoodBuddy 本地文本向量模型与连接设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档类型 | 跨功能技术与产品架构 |
| 状态 | 已实施 |
| 版本 | 0.4 |
| 日期 | 2026-08-22 |
| 适用产品 | GoodBuddy 桌面端 |
| 目标平台 | Windows、macOS、Linux，x64 与 arm64 |
| 相关基线 | [知识库检索与分块增强 PRD](./prd.md)、[模型下载源设计](../../architecture/model-download-source-design.md)、[知识检索评估](./retrieval-evaluation.md)、[统一界面设计系统](../../../UI-DESIGN.md) |

本文定义 GoodBuddy 的文本向量模型产品形态，包括 GoodBuddy 提供的内置本地连接、
用户添加的 OpenAI 兼容连接、模型管理界面、进程边界、编码契约、索引兼容性、失败状态
和验收方法。

本文中的向量模型是 **GoodBuddy Main 进程所管理的知识检索基础设施**，不是 LLM，也不是
Agent Runtime。它不会成为直连模型、OpenCode、Continue、DeepSeek Harness 或后续 Runtime
的模型来源。Runtime 只能获得知识服务返回的有界文本证据、引用和检索诊断，不能获得
向量连接、模型文件、Tokenizer、原始向量或凭据。

内置连接与用户连接使用同一连接列表、选择、诊断和索引兼容语义。本文所称“支持多种连接”
不代表应用可以在它们之间自动切换。**GoodBuddy 不设计静默替换向量连接、模型、精度、
数据位置或编码方式。**

---

## 1. 摘要与核心决策

1. 向量连接只服务于 GoodBuddy 的知识索引与检索链路，不进入 Agent Runtime 的模型选择、
   配置、进程环境或凭据边界。
2. GoodBuddy 提供两种明确的向量连接类型：
   - **内置连接**：GoodBuddy 提供的只读系统连接，负责下载、校验、安装并在受控进程中
     运行固定本地模型。
   - **OpenAI 兼容连接**：用户填写 Endpoint、模型名称和可选 API Key，可以指向
     loopback、本地网络、自托管或外部服务。UI 不为具体服务品牌建立专属类型。
3. 内置连接与 LLM 模型连接使用相同的连接列表交互。这里复用的是设置界面的管理模式，
   不表示向量连接可分配给 LLM 或 Agent Runtime。向量页面不增加二级
   `SegmentedControl`。
4. 首个内置连接固定使用
   `ibm-granite/granite-embedding-97m-multilingual-r2`。模型权重不随安装包交付，
   用户需要先下载或导入，再完成真实诊断和保存。
5. 内置连接和用户连接没有回退顺序。当前连接不可用时，向量通道明确标记不可用；
   GoodBuddy 不自动换到另一连接或另一模型。
6. 向量通道失败时，全文、中文 CJK 和图谱通道可以按已保存检索设置继续工作，但界面必须
   显示“未使用向量检索”、失败原因和实际使用通道。这是可见的检索通道降级，不是向量
   Provider 回退。
7. 模型权重不随安装包交付。下载使用固定修订、已知字节数和 SHA-256；内网环境支持
   ZIP 导入。
8. 内置连接推理不在 UI Renderer 或 Main 事件循环内执行。Main 通过受控推理进程调用
   ONNX CPU Runtime，Renderer 只展示状态和发起经过校验的操作。
9. 文档和查询编码必须具有显式角色。Tokenizer、特殊 Token、Pooling、归一化、前缀、
   最大序列长度、精度和输出维度共同构成可复现的 `EmbeddingEncodingRecipe`。
10. Provider Fingerprint 必须覆盖完整编码配方和数据路径。任一兼容性字段变化后，旧向量
   不参与新请求，用户需要显式重建。
11. 保存模型切换不自动重建所有知识库。界面先说明受影响的知识库数量，再由用户逐库或
    显式批量发起重建。

---

## 2. 实施基线

### 2.1 当前实现

GoodBuddy 当前已经具备：

- 内置 Granite 系统连接与多个 OpenAI 兼容用户连接。
- 与 LLM 模型连接一致的左侧连接列表、右侧详情管理模式。
- 内置模型固定下载、进度、取消、SHA-256 校验、原子安装、ZIP 导入和删除。
- `@huggingface/tokenizers`、`onnxruntime-web/wasm`、CLS Pooling、L2 归一化和
  384 维输出组成的真实本地推理链路。
- 独立 Utility Process、私有协议、超时、取消、崩溃恢复预算和有界结果校验。
- `embedQuery()` 与 `embedDocuments()` 角色感知调用，以及旧 `embed()` 文档角色兼容。
- Main-only OpenAI 兼容 Endpoint、模型名称和每连接可选 API Key。
- Provider、Model、维度、数据路径和完整编码配方参与的 Fingerprint 与索引隔离。
- Float32 SQLite BLOB 存储、向量模长和有界分页余弦扫描。
- 文档级暂存与原子替换、失败和取消后的旧索引保护。
- 每个知识库的向量覆盖率、重建任务和检索通道诊断。

当前仍待后续知识增强阶段完成的能力包括全局展示受影响知识库数量、模型切换确认与逐库
重建入口，以及 Token 感知分块。内置 Granite 客户端不会静默截断超过 32,768 Token 的
输入，而是明确拒绝并返回诊断。

### 2.2 当前存储和搜索约束

向量以 Float32 保存，单条向量的纯数据成本为：

| 维度 | 每条向量 | 10 万条向量，不含 SQLite 开销 |
| --- | ---: | ---: |
| 384 | 1,536 字节 | 约 146.5 MiB |
| 512 | 2,048 字节 | 约 195.3 MiB |
| 768 | 3,072 字节 | 约 293.0 MiB |
| 1,024 | 4,096 字节 | 约 390.6 MiB |

当前向量召回采用 CPU 线性余弦扫描。默认模型不仅要考虑权重大小，还要考虑每个知识库的
长期索引大小和每次查询的乘加量。因此 384 维比 768 或 1,024 维更适合作为通用桌面端
默认值。

当前知识分块默认约 1,600 字符，父子模式的子块默认约 900 字符，允许的单块上限更高。
只有 512 Token 上下文的模型可能截断常见中文分块，不能在不调整分块或明确报错的情况下
作为默认模型。

---

## 3. 目标

### 3.1 用户目标

- 不安装其他服务即可按需获得可用的本地语义检索。
- 清楚知道向量计算发生在本机、局域网自托管服务还是云端。
- 在高性能硬件或自托管环境中通过 OpenAI 兼容连接使用自行选择的向量模型。
- 在断网设备上通过 ZIP 导入内置模型。
- 切换模型前知道哪些知识库会失去兼容向量，以及接下来需要做什么。
- 查看模型下载、校验、加载、真实推理测试和索引重建的独立状态。
- 失败时得到准确原因，不被应用暗中换模型、换精度或上传数据。

### 3.2 产品目标

- 提供一个六平台共同支持的轻量本地默认向量能力。
- 复用现有知识索引、模型管理、安全存储、任务中心和通知体系。
- 保持应用安装包不包含模型权重，避免无条件增加下载和安装体积。
- 对内置连接和任意 OpenAI 兼容连接使用同一上层 Provider 和索引兼容契约。
- 让模型升级、量化变化和角色格式变化都可见、可诊断、可重建。
- 保持 Renderer 无 Node 集成，不向 Renderer 暴露数据库、模型目录或长期凭据。

### 3.3 质量目标

- 内置模型对当前中文、中英文混合和跨语言检索样例具有稳定收益。
- 同一模型包、编码配方和输入在同一 CPU Runtime 下产生可复现的向量维度和近似值。
- UI 线程不执行 Tokenization、ONNX 推理或大向量序列化。
- 取消、应用退出和模型切换不会留下半安装目录、孤立进程或半替换索引。
- 任何向量不可用、索引不兼容或输入过长都进入有界诊断，不能表现为正常的空向量结果。

### 3.4 适用范围与 Agent Runtime 边界

首期允许调用向量连接的生产服务只有 GoodBuddy Main 中的知识能力：

- 知识库文档分块向量化。
- 知识查询向量化。
- 向量召回、混合检索以及 GraphRAG 中明确设计的语义召回。
- 不读取用户知识库的固定连接诊断和检索质量评测。

对话需要知识时，数据链路固定为：

```text
用户问题
→ Main / KnowledgeService 生成查询向量并检索
→ Main 选择有界文本证据、引用和诊断
→ Runtime Orchestrator 把这些不可信证据作为上下文提供给当前 Agent Runtime
```

边界规则：

- 向量连接不进入 `AgentRuntimeSelection`、Runtime Model Profile 或项目 Runtime 设置。
- OpenCode、Continue、DeepSeek Harness、直连 LLM 和远程 Runtime 都不能直接创建或调用
  `EmbeddingProvider`。
- 向量 Endpoint、API Key、模型目录、Tokenizer、向量和索引 Fingerprint 不进入 Runtime
  进程环境、配置文件、模型网关或远程主机。
- `knowledge_search` 等 Runtime 工具只能调用 Main 暴露的有界知识服务，并获得文本结果、
  引用和脱敏诊断。
- Agent Runtime 的选择或切换不改变当前向量连接；向量连接的选择或切换也不改变当前
  Agent Runtime。
- 未来记忆、笔记或其他本地语义检索若要复用向量连接，必须经过独立产品设计、权限与
  数据路径评审后显式接入，不能因存在全局向量连接而自动获得使用权。

---

## 4. 非目标

首期不包含：

- 把 Granite、Qwen、BGE 或其他向量权重直接打入 GoodBuddy 安装包。
- 由 GoodBuddy 安装、启动、停止或升级用户填写的 OpenAI 兼容服务。
- 根据硬件、网络、延迟或准确率自动选择内置连接或用户连接。
- 在用户连接不可用时自动启用内置连接，或在内置连接失败时自动连接外部服务。
- 在模型失败时自动改用另一个模型名称、量化档位、输出维度或 Query 前缀。
- 为用户连接背后的具体服务或模型质量作统一保证。用户选择的模型需要通过真实诊断和
  知识评测验证。
- 首期引入专用向量数据库、GPU 索引或平台原生 SQLite 向量扩展。
- 在后台自动更新模型版本或覆盖当前正在使用的模型包。
- 静默截断超过模型上下文的分块。
- 把知识库文档、查询、向量或模型凭据用于训练、遥测或外部质量分析。
- 把向量连接作为聊天生成模型、Agent Runtime 模型、Runtime 模型网关或远程 Runtime
  依赖。
- 向 Agent Runtime 暴露 Embedding Provider、模型文件、Tokenizer、原始向量、Endpoint
  或凭据。
- 在没有独立设计和显式接入的情况下，把当前向量连接自动扩展到记忆、自动化、项目文件
  搜索或其他应用服务。

---

## 5. 术语与路径分类

| 术语 | 定义 |
| --- | --- |
| `builtin` | GoodBuddy 提供的只读系统连接，管理模型包和推理进程，推理数据不离开设备 |
| `openai-compatible` | 用户配置的通用 OpenAI 兼容 Embeddings 服务 |
| 模型包 | 固定修订的 ONNX、Tokenizer、配置、许可和校验清单 |
| 编码配方 | Query/Document 格式、Tokenizer、Pooling、归一化、精度、维度和 Token 限制 |
| Connection Profile | 一个可选择的内置或用户连接配置，不含凭据正文 |
| Embedding Operation Snapshot | 一次向量诊断、索引任务或查询实际使用的冻结配置；与 Agent Runtime 无关 |
| Provider Fingerprint | 对连接、数据路径和编码配方的规范化摘要，用于索引隔离 |
| 兼容索引 | Provider Fingerprint、模型、维度和内容校验均匹配的向量集合 |
| 可见通道降级 | 向量不可用时继续使用已配置的其他检索通道，并明确显示差异 |

OpenAI 兼容 Endpoint 为 `127.0.0.1`、`localhost` 或 `[::1]` 时，可以标记“本机服务”。
局域网地址、VPN 地址、域名或公网地址统一标记“网络服务：<主机名>”。GoodBuddy 不根据
URL 或模型名称猜测具体服务品牌，也不把非 loopback Endpoint 描述为数据不离开本机。

---

## 6. 模型选择

### 6.1 内置默认模型

首个内置连接只包含一个固定模型：

| 字段 | 值 |
| --- | --- |
| 模型 | `ibm-granite/granite-embedding-97m-multilingual-r2` |
| 参数量 | 97M |
| 输出维度 | 384 |
| 上下文 | 32K Token |
| 语言 | 200+，重点增强 52 种语言的检索 |
| 权重 | 固定修订的通用 INT8 ONNX 工件 |
| 量化权重体积 | 97,858,099 字节，不含 Tokenizer 和配置 |
| License | Apache 2.0 |
| 编码配方 | Query/Document 空前缀、CLS Pooling、L2 归一化 |
| UI 标签 | 内置、轻量、多语言、本地、INT8 |

选择理由：

1. 384 维降低当前 SQLite 线性扫描和长期索引成本。
2. 32K 上下文覆盖 GoodBuddy 当前常见分块，不要求为了默认模型全面缩短分块。
3. 中文、英文和混合内容可以使用同一索引，不需要按语言拆分。
4. ONNX Community 提供面向 Transformers.js 的通用 INT8 转换，并在 Hugging Face 与
   ModelScope 上提供 SHA-256 相同的固定工件。
5. Apache 2.0 适合应用内提供目录元数据和用户自行下载使用。

“内置”表示 GoodBuddy 提供并维护该系统连接，不表示权重已经包含在安装包中。用户仍需
执行下载或导入、真实测试和保存选择。

IBM 官方仓库当前提供的轻量工件名为 `model_quint8_avx2.onnx`，明确面向 AVX2，不能未经
验证作为六平台统一工件。当前内置连接使用
`onnx-community/granite-embedding-97m-multilingual-r2-ONNX` 中固定修订的
`onnx/model_quantized.onnx`：

- Hugging Face Revision：`536a9f241cb3f02a9c5995a1e708c784bd274859`。
- ModelScope Revision：`2741cd30a7448219ec2699afdf373a44df5aaa33`。
- 文件大小：`97,858,099` 字节。
- SHA-256：`704c1ebca5fbb7cd83ced41827658ac4c9990c64f7f2874d22b78044e5022e22`。

该工件是社区自动转换。Windows x64 已使用固定 Tokenizer 和真实 ONNX 文件完成
Query/Document 推理，确认输出为 384 维、CLS Pooling 和 L2 归一化链路可运行。其余五个
发布目标仍由对应原生 Runner 验证安装、加载、推理、取消和退出；任一目标验证失败时必须
修复同一路径，不能静默改用平台特定工件或用户连接。

### 6.2 为什么首期不托管多个默认模型

`BAAI/bge-small-zh-v1.5` 体积更小，但其常见部署配置是 512 维、512 Token。它可能截断
当前默认中文分块，并增加每条索引的维度成本。首期不把它设为第二个自动候选，也不建立
Granite → BGE 的回退关系。

未来只有在以下条件全部满足后，才增加其他内置连接：

- 固定修订和全部文件 SHA-256 已独立验证。
- 六个平台均能加载和运行。
- Tokenizer、Pooling、Normalization 和角色格式可复现。
- 当前分块上限不会被静默截断，或产品已经提供明确的 Token 感知分块迁移。
- 固定检索样例通过质量和性能门。
- License、NOTICE 和模型仓库说明已经纳入交付清单。

### 6.3 高硬件或准确性需求

高性能用户可以自行准备提供 OpenAI 兼容 Embeddings API 的本机、网络或外部服务，并在
GoodBuddy 中添加连接，显式填写 Endpoint、模型名称、可选凭据和编码预设。

GoodBuddy 不代替用户判断服务背后模型的显存、内存、速度、语言和 License。设置界面必须
显示用户填写的模型标识、实际 Endpoint 主机、输出维度和真实诊断结果，不能仅根据名称
宣称质量更高。

---

## 7. 信息架构

不新增一级设置页面。入口继续为：

```text
设置
└─ 模型连接
   └─ 向量模型
      ├─ GoodBuddy 内置连接
      ├─ 用户添加的 OpenAI 兼容连接
      └─ 当前连接详情与诊断
```

“模型连接”中的模型类型继续使用现有 `SegmentedControl`：

```text
[LLM 模型] [向量模型] [重排模型] [语音输入]
```

向量模型内部不增加第二组模式切换。它复用 LLM 模型连接的列表、当前连接、添加、编辑、
测试和删除交互。复用只限界面模式和通用表单行为，不复用 LLM/Agent Runtime 的连接契约、
选择状态、凭据注入或路由。内置连接只是列表中的一种只读系统连接，不是独立页面或独立
模式。

知识库设置继续显示当前知识库的向量覆盖率和重建入口，不复制全局模型下载、Endpoint 或
凭据编辑表单。

---

## 8. 全局设置界面

### 8.1 页面层级

向量模型面板按以下顺序组织：

1. 标题、说明、启用开关和“添加自定义”。
2. 左侧为内置连接与用户连接组成的单一连接列表。
3. 右侧为所选连接详情；列表选择只切换详情，不改变当前连接。
4. 当前连接单选、连接编辑和添加/删除均保存在页面草稿中，只随“保存设置”提交。
5. 内置详情提供下载、取消、ZIP 导入、删除和真实诊断。
6. 用户连接详情提供名称、Endpoint、模型、认证、API Key、删除和真实诊断。

停用向量检索只阻止把连接设为当前和执行诊断，不阻止选择详情、编辑用户连接或管理内置
模型文件。

示意：

```text
向量模型              [启用向量检索] [添加自定义]

┌ 可用连接 ───────────────┬ 连接详情 ─────────────────────────────┐
│ GoodBuddy 内置向量模型   │ GoodBuddy 内置向量模型       (当前连接) │
│ Granite 97M R2           │ 模型：Granite 97M R2                  │
│ [当前]                   │ 状态：已安装                           │
│ 自定义向量模型           │ [测试] [从 ZIP 导入] [移除本地模型]     │
│ nomic-embed-text         │                                      │
└──────────────────────────┴──────────────────────────────────────┘

用户连接详情：
名称 / Embeddings Endpoint / 模型名称 / 认证方式 / API Key
[删除] [测试]

页面级 [保存设置] 提交启用状态、当前连接和用户连接草稿。
```

### 8.2 当前生效与待保存

界面必须同时区分：

- **当前生效**：Main 正在用于新查询和新索引任务的已保存 Connection Profile。
- **正在编辑**：所选用户连接的表单草稿，或准备设为当前的内置连接。
- **已验证草稿**：最近一次诊断与连接草稿 Fingerprint 完全匹配。
- **待保存**：当前连接选择或用户连接草稿与已保存状态不同。

用户修改路径、Endpoint、模型、精度、维度或编码预设后，旧诊断立即显示：

> 配置已变化，需要重新测试。

不能把旧模型的“测试成功”继续显示在新模型旁边。

### 8.3 内置连接

内置连接是 GoodBuddy 提供的只读系统 Profile，与用户连接出现在同一列表。它显示：

- 固定连接名称“GoodBuddy 内置”和固定模型名称。
- 下载、取消、导入 ZIP 和删除。
- 固定模型名称和安装状态。
- “已安装”“待保存”“正在使用”“下载中”“校验中”“损坏”等状态。

内置连接不能编辑 Endpoint、模型名称、凭据、精度、维度或编码配方。未来增加其他内置
模型时，为每个经过验证的模型提供独立系统连接，不在同一个连接中建立自动模型路由。

未安装时主操作是“下载”，次操作是“导入 ZIP”。下载完成后可以自动把该模型选入草稿，
但不能自动保存、启用或重建知识库。

### 8.4 OpenAI 兼容连接

用户可以添加多个 OpenAI 兼容连接。添加和编辑表单复用 LLM 模型连接的结构，显示：

- 用户可编辑的连接名称。
- 完整 Embeddings Endpoint。
- 模型名称。
- 可选 API Key 和凭据来源。
- 编码预设和模型最大输入 Token。
- 根据 Endpoint 显示“本机服务”或“网络服务：<主机名>”。
- “测试向量生成”和连接删除操作。

UI 不显示具体服务的专属类型、安装入口、品牌文案或检测按钮。用户可以在任何兼容服务中
自行准备模型，再将其 Endpoint 作为普通 OpenAI 兼容连接添加。

通用接口无法提供稳定模型摘要时，界面显示：

> 服务未提供可验证的模型修订。GoodBuddy 将按 Endpoint、模型名称和编码配置隔离索引；
> 服务端原地替换同名模型后，需要重新测试并重建。

非 loopback Endpoint 下方持续显示：

> 建立索引时会向 `api.example.com` 发送已启用知识库的分块文本；检索时会发送用户查询。
> GoodBuddy 不会自动切换到内置连接或其他用户连接。

设置页不把“已配置 API Key”表示为“服务可用”。只有真实 Embeddings 请求可以产生
“测试成功”状态。

### 8.5 数据去向

内置连接名称和模型管理操作已经明确表达本地执行，不再常驻展示固定的进程与 SQLite
路径。下载模型时访问仓库属于模型安装操作，不等同于推理时发送知识内容。

用户连接必须在 Endpoint 下方显示实际数据去向：

| 路径 | 文案 |
| --- | --- |
| Loopback 兼容连接 | 知识分块和查询将发送到此设备上的 `host:port` |
| 非 Loopback 兼容连接 | 建立索引时会向 `host:port` 发送知识分块，检索时会发送查询 |

非 Loopback 提示持续可见，不能只用“网络服务”徽标表达。

### 8.6 状态

| 状态 | 界面表达 | 可用操作 |
| --- | --- | --- |
| 未安装 | 需要下载或导入后使用 | 下载、导入 ZIP |
| 下载中 | 文件、已下载字节、总字节、百分比 | 取消 |
| 校验中 | 正在校验大小和 SHA-256 | 取消 |
| 已安装 | 已安装，尚未使用 | 设为当前模型、导入、删除 |
| 待保存 | 选择尚未生效 | 保存设置 |
| 可用 | 路径、模型、维度、最近测试时间 | 重新测试 |
| 加载失败 | 脱敏原因和处理建议 | 重试当前配置 |
| 输入过长 | 实际 Token、模型上限和受影响文档 | 调整分块或更换模型 |
| 索引不兼容 | 索引模型与当前模型摘要 | 查看知识库、重建 |
| 有新版本 | 当前版本、新版本、下载体积 | 显式下载新版本 |
| 模型损坏 | 失败文件，不显示任意本机路径 | 重新导入或删除 |

状态必须同时使用图标和文字，不只依赖颜色。

### 8.7 真实诊断

诊断使用固定、不含用户数据的测试文本，至少验证：

1. Provider 可以实际产生向量。
2. 返回数量正确。
3. 所有向量维度一致、数值有限且范数非零。
4. 实际维度与 Profile 声明一致。
5. Query 和 Document 两种角色都能编码。
6. 同一固定输入重复编码的余弦相似度满足确定性阈值。
7. 已知最大输入范围不会被 GoodBuddy 客户端静默截断。

诊断结果绑定完整 Fingerprint，并显示：

- 路径和数据位置。
- Provider、模型、模型修订或 Digest。
- 编码预设。
- 实际维度。
- 冷启动或加载耗时。
- 单查询热路径耗时。
- 测试时间。
- 脱敏错误和处理建议。

诊断不读取用户知识库、不改变索引，也不证明真实资料的召回质量。

### 8.8 保存和切换确认

保存会改变 Fingerprint 的配置前显示确认对话框：

> **切换向量模型？**
>
> 当前使用 `nomic-embed-text / 768 维`，将切换为
> `Granite Embedding 97M R2 INT8 / 384 维`。
>
> 现有向量不会参与新配置下的检索。3 个知识库需要显式重建。保存不会自动重建，也不会
> 自动切换到其他向量模型。

按钮：

- 取消。
- 切换向量模型。

保存前存在运行中的向量重建任务时，界面必须说明任务将被取消并丢弃未发布的暂存结果。
用户确认后先完成取消，再替换活动 Profile。

### 8.9 删除模型

- 当前生效的内置模型不能直接删除。
- 用户必须先停用向量模型或显式选择并保存其他 Profile。
- 删除只移除模型文件，不自动删除旧向量索引。
- 删除确认显示模型名称、版本和磁盘空间。
- 删除失败保留模型状态和可重试错误，不能自动改选其他模型。

---

## 9. 知识库界面

每个知识库的“向量索引”区块继续位于知识库设置中，显示：

```text
向量索引

当前模型：Granite Embedding 97M R2 · INT8 · 384 维
索引模型：nomic-embed-text · 768 维

状态：模型不兼容
当前检索不会使用这些旧向量，也不会切换到其他向量模型。

已索引 42     缺失 3     错误 0     总计 45

[重建向量索引]
```

规则：

- 当前 Profile 和索引 Fingerprint 完全匹配时才显示“兼容”。
- 重建始终使用启动任务时冻结的 Embedding Operation Snapshot。
- 重建期间全局 Profile 变化时取消旧任务，不让任务后半段切到新模型。
- 同一 Fingerprint 的重建失败时，可以继续保留上一次完整就绪索引。
- Fingerprint 已变化时，旧索引可以保留在数据库中等待清理，但不参与当前向量召回。
- 重建完成前，检索诊断持续显示向量通道不可用或部分可用，不把旧索引描述为当前索引。

全局设置中的“查看受影响的知识库”打开有界列表，显示知识库名称、兼容状态、文档数、
预计待向量化分块数和进入该知识库设置的操作。

---

## 10. 不静默替换契约

### 10.1 禁止自动发生的变化

以下变化不得在诊断、索引任务或查询中静默发生：

- 内置连接与任何 OpenAI 兼容连接之间切换。
- Endpoint、Provider、账号或数据位置切换。
- 模型名称、模型修订、服务端模型摘要或模型文件变化。
- INT8、FP16、FP32 或其他精度变化。
- 输出维度变化或 Matryoshka 截断维度变化。
- Query/Document 前缀、指令或角色格式变化。
- Tokenizer、特殊 Token、Pooling 或归一化变化。
- 超出模型上下文时截断、换模型或跳过部分输入后继续表示成功。
- GPU、CPU 或执行后端变化导致可感知质量差异时继续沿用旧 Fingerprint。

### 10.2 允许的内部恢复

以下操作可以自动执行，但必须保持同一 Embedding Operation Snapshot 和语义：

- 同一内置模型进程的有限重启。
- 同一 Endpoint、模型、Digest 和编码配方的有限网络重试。
- 动态批大小、线程调度、缓存和空闲卸载等不改变向量语义的资源优化。
- 同一索引任务内对可重试批次进行有界重试。

恢复预算耗尽后当前操作失败。诊断提供“重试当前配置”，不提供默认选中的替代模型。

### 10.3 与其他检索通道的关系

FTS、CJK、向量和图谱是用户已配置的并列检索通道。向量失败时继续使用 FTS、CJK 或图谱
不等同于切换向量 Provider，但必须满足：

- 请求通道和实际使用通道都可见。
- 向量失败原因可见。
- 结果不得标记为完整混合检索成功。
- 不自动修改保存的向量权重。
- 不自动扩大知识库范围。
- 不自动生成或使用其他模型的查询向量。

推荐设置文案：

> 向量模型不可用时，本次检索将明确标记“未使用向量检索”，并显示实际使用的全文、中文
> 或图谱通道。GoodBuddy 不会自动切换到其他向量模型或数据路径。

---

## 11. 总体架构

```text
┌──────────────────────── Renderer ────────────────────────┐
│ Settings / Model catalog / Diagnostics / Index status    │
│ No credentials, no model paths, no database access       │
└──────────────── typed preload + validated IPC ───────────┘
                              │
┌────────────────────────── Main ───────────────────────────┐
│ EmbeddingProfileStore                                     │
│ EmbeddingModelManager                                     │
│ EmbeddingProviderFactory                                  │
│ KnowledgeService / EmbeddingIndexCoordinator              │
│ Credentials / fingerprint / task lifecycle                │
└───────────────┬──────────────────────┬────────────────────┘
                │                      │
       Managed utility process     HTTP(S) provider
       Tokenizer + ONNX CPU        OpenAI-compatible endpoint
                │
       Managed model directory
       manifest + fixed artifacts
```

Agent Runtime 不在向量 Provider 架构内。对话编排只能通过 `KnowledgeService` 获取有界
检索结果；图中的 Provider、推理进程、HTTP Endpoint、凭据和向量存储都保持在 Main 知识
服务边界内。

### 11.1 Renderer

Renderer 负责：

- 显示内置模型状态与下载进度、当前/草稿 Profile，并仅为用户连接显示根据 Endpoint
  判断的实际数据去向。
- 发起下载、导入、导出、选择、删除、诊断和重建。
- 展示知识库影响、真实维度和脱敏错误。
- 使用应用通知显示短期成功和非字段异步错误。

Renderer 不负责：

- 读取模型目录。
- 下载或解压模型。
- 读取 API Key。
- 为知识库分块执行 Tokenization 或推理。
- 决定 Provider 回退。
- 直接访问用户 Endpoint 或 SQLite。

### 11.2 Main

Main 负责：

- 校验 Renderer sender 和共享 Zod 输入。
- 管理模型目录、固定下载、ZIP 和文件摘要。
- 保存不含凭据正文的 Profile，并在系统安全存储中绑定凭据。
- 规范化 Endpoint 和计算 Fingerprint。
- 创建冻结的 Embedding Operation Snapshot。
- 选择唯一的 Adapter，不执行自动 Adapter 路由。
- 将查询、索引、取消、超时和应用关闭传播到推理进程或 HTTP Provider。
- 对模型切换、任务取消和知识索引状态执行一致的生命周期管理。

### 11.3 内置连接推理进程

内置模型运行在 GoodBuddy 管理的独立 Utility Process：

- 不监听端口。
- 不继承云端 API Key、Agent Runtime 凭据或无关环境变量。
- 只接受 Main 通过受控消息通道发送的有界请求。
- 模型路径由 Main 从已校验 Manifest 解析，不接受 Renderer 或请求中的任意路径。
- Tokenization、ONNX 推理、Pooling 和归一化都在该进程完成。
- 每个请求包含 UUID、角色、文本、Fingerprint 和取消标识。
- 返回有界 Float32 向量和诊断，不返回内部文件路径或原始日志。
- 崩溃后可以在同一模型和同一配置下有限重启；超过预算后明确失败。
- 应用退出时终止完整进程，并等待有界时间释放模型句柄。

初始推理后端固定为 ONNX CPU。实现阶段必须验证所选 ONNX JavaScript/Native Runtime 在
六个平台的打包、许可、算子、线程和退出行为；某个平台未通过时，该平台显示“不支持此
本地模型”，不能改用用户连接继续。

现有 Renderer OCR Worker 不直接复用，因为知识分块不应为了推理被批量发送到 UI
Renderer。可以复用其 ONNX 资源固定、Worker 消息边界和有界错误经验。

### 11.4 OpenAI 兼容 Provider

所有用户连接复用 Main 中的 OpenAI 兼容 Embeddings Client，并保持：

- HTTP(S) 协议限制。
- Endpoint 长度和规范化。
- 禁止重定向。
- 批量数量、单项字符、总字符、超时和响应字节上限。
- 返回数量、索引顺序、维度、有限值和非零范数校验。
- 取消传播和脱敏错误。

首期不增加品牌专属 Adapter，不探测服务安装状态、已安装模型列表或管理服务生命周期。

### 11.5 Agent Runtime 集成边界

知识检索发生在 Agent Runtime 启动前的 Main 预检索，或 Runtime 通过受控
`knowledge_search` 工具请求 Main 检索时。两种路径都由 `KnowledgeService` 调用当前
Embedding Operation Snapshot，Runtime 只接收：

- 有界的证据文本和来源引用。
- 请求通道、实际通道和是否降级。
- 脱敏且有长度上限的检索诊断。

Runtime 不接收连接 Profile、Endpoint、凭据引用、模型路径、Tokenizer、Float32 向量或
索引存储键。远程 Runtime 不通过模型网关转发 Embeddings 请求，也不在远端复制向量配置。

---

## 12. 编码配方

### 12.1 Query 与 Document 角色

现有 `EmbeddingProvider.embed(string[])` 需要改为角色感知接口：

```ts
type EmbeddingInputRole = 'query' | 'document'

type EmbeddingInput = {
  text: string
  role: EmbeddingInputRole
}

interface EmbeddingProvider {
  readonly identity: EmbeddingProviderIdentity
  embed(
    input: readonly EmbeddingInput[],
    signal?: AbortSignal
  ): Promise<number[][]>
}
```

索引分块始终使用 `document`，检索问题始终使用 `query`。诊断分别发送固定的 Query 和
Document 测试输入，不能偷用文档角色代替查询测试，也不创建第三种模型角色。

内置 Granite 使用模型包内固定的编码配置。OpenAI 兼容连接通过用户显式选择的编码预设
决定是否添加前缀或指令。不能只根据模型名称在后台猜测并改变输入。

### 12.2 编码预设

Profile 至少支持：

- `symmetric`：Query 和 Document 不添加不同前缀。
- `query-passage`：固定 Query 与 Passage 前缀。
- `instruction-query`：Query 使用固定检索指令，Document 使用固定文档格式。
- `builtin-manifest`：完全由受信任模型包 Manifest 决定，用户不可局部修改。

UI 必须在保存前显示用户连接的实际编码预设。自定义预设中的前缀有长度上限，不允许插入
凭据或读取知识内容。

### 12.3 Tokenizer、Pooling 和归一化

内置模型必须从固定模型包读取：

- `tokenizer.json` 及其摘要。
- 特殊 Token ID。
- 最大序列长度。
- Pooling 策略。
- 是否进行 L2 归一化。
- 输出维度。
- ONNX 输入和输出名称。

实现不得手写一个“近似 Tokenizer”，也不得只取任意输出 Tensor。运行时启动后使用固定
公开测试向量验证配方，配置不匹配则阻止服务就绪。

SQLite 当前会保存模长并计算余弦相似度。即使模型输出已经归一化，Provider 仍需验证
范数有限且非零；是否归一化继续写入 Fingerprint。

### 12.4 输入长度

- 每个 Profile 声明 `maximumSequenceTokens`。
- 内置路径在发送 ONNX 前完成 Token 计数。
- 批处理同时受最大项目数和最大总 Token 数限制。
- 单条输入超过上限时返回 `input_too_long`，不截断后继续表示成功。
- 已知模型上下文小于当前知识库分块时，设置和知识库页面持续显示不兼容提示。
- 用户可以调整分块并显式重建，或显式选择上下文更长的模型。

通用远端服务无法提供 Tokenizer 或上下文上限时，Profile 显示“输入上限由服务端决定”。
GoodBuddy 继续执行客户端字符上限，但不声称已经证明服务端不会截断。真实诊断只能证明
请求成功，不能证明服务端完整使用了全部文本。

---

## 13. 共享契约

建议扩展 `src/shared/embedding-contracts.ts`：

```ts
type EmbeddingConnectionKind = 'builtin' | 'openai-compatible'

type EmbeddingDataLocation =
  | { kind: 'device' }
  | {
      kind: 'endpoint'
      endpointHost: string
      scope: 'loopback' | 'network'
    }

type EmbeddingEncodingRecipe = {
  recipeId: string
  tokenizerDigest?: string
  pooling: 'cls' | 'mean' | 'last-token' | 'provider-managed'
  normalization: 'l2' | 'none' | 'provider-managed'
  queryTemplate: string
  documentTemplate: string
  maximumSequenceTokens?: number
  dimensions?: number
}

type EmbeddingModelReference = {
  modelId: string
  revision?: string
  artifactDigest?: string
  serviceDigest?: string
  precision?: 'int8' | 'fp16' | 'fp32' | 'provider-managed'
}

type EmbeddingConnectionProfile = {
  id: string
  name: string
  kind: EmbeddingConnectionKind
  system: boolean
  endpoint?: string
  accountRef?: string
  credentialRef?: string
  model: EmbeddingModelReference
  encoding: EmbeddingEncodingRecipe
  dataLocation: EmbeddingDataLocation
}

type EmbeddingOperationSnapshot = {
  profile: EmbeddingConnectionProfile
  fingerprint: string
  actualDimensions: number
  createdAt: string
}
```

内置连接固定为 `kind: 'builtin'` 和 `system: true`，不能携带 Endpoint、账号或凭据。
用户连接固定为 `kind: 'openai-compatible'` 和 `system: false`。`accountRef` 和
`credentialRef` 只引用 Main 加密设置，不包含密钥正文。Endpoint 进入 Profile 前删除
用户名、密码和 Fragment；查询参数只有在 Provider API 明确需要且经过脱敏策略验证时
才允许保留。

模型目录契约复用语音模型管理模式，并增加适合文本向量的文件角色：

- `model`
- `tokenizer`
- `tokenizer-configuration`
- `model-configuration`
- `sentence-transformers-configuration`
- `license`
- `notice`

---

## 14. Provider Fingerprint 与索引兼容

### 14.1 Fingerprint 内容

Fingerprint 使用规范化 JSON 计算 SHA-256，至少覆盖：

- Provider Kind。
- 规范化 Endpoint 和数据位置。
- 模型 ID。
- 固定 Revision、模型文件摘要或服务端稳定模型摘要。
- 精度。
- 输出维度。
- Tokenizer 摘要。
- Pooling 和归一化。
- Query/Document 模板。
- 最大序列长度。
- 影响向量数值的推理配置版本。

Fingerprint 不包含：

- API Key。
- 本机用户名或绝对模型目录。
- 下载临时路径。
- 诊断时间和延迟。
- 不影响向量数值的 UI 名称。

现有 `embeddingStorageProvider()` 可以继续对 Fingerprint 做有界 SHA-256 派生，但
Fingerprint 本身必须来自上述完整规范化结构。

### 14.2 兼容判断

一个向量只有同时满足以下条件才参与召回：

1. Knowledge Base 匹配。
2. Provider Storage Key 匹配。
3. 模型标识匹配。
4. 维度匹配。
5. 分块内容校验和匹配。
6. 文档级索引状态为 Ready。

不能因为两个模型都返回 384 维就视为兼容，也不能因为用户连接中的模型名称相同就忽略
Endpoint、编码配置或服务端稳定模型摘要变化。

### 14.3 模型切换

模型切换流程：

1. 用户编辑候选 Profile。
2. 使用固定测试文本真实诊断候选。
3. 计算候选 Fingerprint 和受影响知识库。
4. 用户确认数据路径、模型和重建影响。
5. 取消并收尾使用旧 Profile 的活动向量任务。
6. 原子保存新 Profile。
7. 新查询只使用新 Fingerprint 的兼容向量。
8. 用户显式发起知识库重建。

保存失败时旧 Profile 保持生效。不能出现设置显示新模型而 Main 仍使用旧模型的部分提交。

---

## 15. 模型包和目录

### 15.1 目录

受管目录：

```text
<userData>/models/embedding/
├─ granite-embedding-97m-multilingual-r2-int8/
│  ├─ manifest.json
│  ├─ model_quantized.onnx
│  ├─ tokenizer.json
│  ├─ tokenizer_config.json
│  ├─ config.json
│  └─ special_tokens_map.json
└─ .staging-<uuid>/
```

文件名、数量、单文件大小、总大小和压缩包展开大小均有上限。Manifest 不允许绝对路径、
父目录跳转、符号链接或可执行文件。

### 15.2 下载

- 目录只包含元数据，不包含模型权重。
- 每个来源的文件固定不可变 Revision、URL、字节数和 SHA-256。
- 实际下载使用“平台功能 → 通用设置”中显式选择的 ModelScope 或 Hugging Face，完整
  来源契约以[平台功能页签与模型下载源设计](../../architecture/model-download-source-design.md)为准。
- 下载写入随机暂存目录和 `.partial` 文件。
- 禁止未声明重定向到其他主机。
- 每个文件边下载边计算摘要。
- 全部校验成功后原子重命名为最终目录。
- 取消或失败清理本次暂存，不删除已安装版本。
- 所选来源不可用或缺少模型时显示失败，不尝试另一个来源。
- 两个来源可以维护不同的固定大小和 SHA-256，但文件名和运行角色必须兼容；一次模型包
  只能完整使用一个来源，不混合来源文件。

### 15.3 ZIP 导入

- 导入先在暂存目录展开并验证 Manifest 和全部文件摘要。
- 不接受 Manifest 之外的可执行文件。
- 不接受路径穿越、符号链接、超大文件和压缩炸弹。
- 导入的模型 ID、Revision 和摘要必须与目录条目一致。

---

## 16. OpenAI 兼容连接

### 16.1 产品边界

GoodBuddy 对用户连接负责：

- 保存连接名称、Endpoint、模型名称、可选凭据和编码预设。
- 发送有界 Embeddings 请求。
- 校验向量并展示真实诊断。
- 根据 Endpoint、模型、稳定模型摘要、维度和编码配置隔离索引。

GoodBuddy 不负责：

- 安装、启动、停止或升级 Endpoint 背后的服务。
- 下载、删除或更新用户服务中的模型。
- 修改用户服务的监听地址、认证、代理或硬件设置。
- 判断第三方模型 License 是否适合用户用途。

### 16.2 统一连接表单

添加连接只显示通用字段：

- 连接名称。
- 完整 OpenAI 兼容 Embeddings Endpoint。
- 模型名称。
- 可选 API Key。
- 编码预设和可选最大输入 Token。

GoodBuddy 不根据 Endpoint、端口或模型名称猜测具体服务品牌。连接名称由用户决定，
GoodBuddy 只持续显示规范化 Endpoint 主机、实际维度和诊断结果。

### 16.3 连接诊断

用户点击“测试”后，Main 发送固定、不含用户数据的真实 Embeddings 请求。诊断验证返回
数量、维度、有限值、非零范数、Query/Document 编码和配置确定性。诊断结果只绑定当前
连接草稿，不自动保存、切换或修改模型。服务返回的自由文本经过长度限制和脱敏，不直接
写入日志或 DOM。

### 16.4 Endpoint 安全

- 默认只建议 loopback。
- 用户填写非 loopback 地址时显示将发送文档内容的目标主机。
- HTTPS 自托管地址按 TLS 校验，不忽略证书错误。
- HTTP 非 loopback 地址显示明文传输警告，但不自动改写为其他地址。
- 不跟随重定向。
- 不把服务响应中的内部路径、环境信息或未受限原文暴露给 Renderer。

---

## 17. 安全与隐私

### 17.1 数据处理

| 路径 | 文档分块 | 查询 | 向量 | 凭据 |
| --- | --- | --- | --- | --- |
| 内置连接 | Main → 本地 Utility Process | Main → 本地 Utility Process | 返回 Main，保存 SQLite | 不需要 |
| Loopback 兼容连接 | Main → 本机服务 | Main → 本机服务 | 返回 Main，保存 SQLite | 可选，Main-only |
| 非 Loopback 兼容连接 | Main → 指定主机 | Main → 指定主机 | 返回 Main，保存 SQLite | 可选，Main-only |

默认不记录原始分块、查询正文、返回向量或 Authorization Header。诊断只保存有界统计和
脱敏错误。

### 17.2 Electron 边界

- 保持 Context Isolation 和 Sandbox。
- Renderer 不启用 Node Integration。
- 所有 IPC 输入使用共享 Zod Schema。
- Main 验证可信发送者。
- Preload 只暴露具体模型管理和诊断方法。
- 不向 Renderer 传递任意本机路径、Electron API、文件句柄或长期 Token。
- Utility Process 只接受 Main 创建的私有通道。

### 17.3 模型供应链

- 模型目录元数据进入源码审查。
- Revision、大小和 SHA-256 必须固定。
- 模型许可和上游来源随应用资源与目录元数据交付。
- 下载工件不执行脚本。
- ONNX 外部数据文件必须显式列入 Manifest。
- 模型加载前再次验证已安装 Manifest，不能只在首次下载时验证。

---

## 18. 失败与恢复

| 场景 | 行为 |
| --- | --- |
| 内置模型未安装 | 阻止启用，提供下载或 ZIP 导入 |
| 模型文件损坏 | 阻止加载，显示重新导入或删除，不启用用户连接 |
| Utility Process 崩溃 | 同一 Snapshot 有限重启，耗尽后当前操作失败 |
| 用户 Endpoint 不可用 | 显示连接不可用，保留配置，不启动或改连其他服务 |
| 用户连接模型不存在 | 显示准确模型名和处理建议，不自动选择其他模型 |
| 用户连接认证失败 | 显示认证错误，保留配置，不尝试内置连接 |
| Provider 限流或超时 | 同一 Provider 有界重试，之后明确失败 |
| 返回维度变化 | 当前请求失败，索引标记不兼容，不截断或填充向量 |
| 输入超过上下文 | 标记文档或查询失败，提示调整分块，不静默截断 |
| 部分文档向量失败 | 保留成功文档并显示覆盖率和错误数 |
| 模型切换时有重建任务 | 经用户确认后取消旧任务并丢弃未发布暂存 |
| 新 Profile 保存失败 | 旧 Profile 继续生效，草稿和错误保留 |
| 重建失败 | 同 Fingerprint 的上一版就绪索引保留；不同 Fingerprint 的旧索引不参与 |
| 应用退出 | 取消请求、停止新批次、关闭进程和文件句柄 |

错误不得包含 API Key、完整私人文本、模型内部绝对路径或未经限制的 Provider 响应。

---

## 19. 性能与资源

### 19.1 推理生命周期

- 本地推理进程按首次诊断、查询或索引任务惰性启动。
- 同一时间只加载当前内置模型。
- 空闲达到有界时间后可以卸载同一模型，下一次使用重新加载。
- 卸载和重载不改变 Fingerprint。
- 查询优先于后台索引批次，避免知识重建长期阻塞交互。
- 索引批次在查询到达时可以在批次边界让出。

### 19.2 批处理

- 使用最大项目数和最大总 Token 数双重上限。
- 长输入单独成批。
- 不为追求吞吐超过配置的内存预算。
- 返回向量直接转为 Float32，避免长期保留重复 Number Array。
- Main 与 Utility Process 使用有界可转移 Buffer 或等价二进制消息，不使用 Base64。

### 19.3 基线指标

实施评测至少记录：

- 模型包磁盘大小。
- 冷启动时间。
- 单条中文 Query 热路径 P50/P95。
- 默认 1,600 字符分块的吞吐。
- 进程峰值 RSS。
- 10 万条 384 维向量的数据库增量和扫描时间。
- 查询到达时后台索引的让出延迟。
- 取消响应时间和退出时间。

这些指标在 Windows、macOS、Linux 的 x64 与 arm64 原生 Runner 上记录。未达到产品门时
显示模型在该平台不可用或继续优化同一路径，不能把云端作为隐藏的性能补偿。

---

## 20. 评测

### 20.1 评测层次

1. **契约测试**：文件、Profile、Fingerprint、IPC 和向量校验。
2. **推理一致性测试**：固定模型包、固定输入和固定编码配方。
3. **检索集成测试**：真实 `KnowledgeService`、SQLite 和混合检索路径。
4. **质量评测**：中文、中英文混合、跨语言和代码标识固定样例。
5. **平台评测**：六个平台的安装、加载、取消、退出和资源。

现有[知识检索评估](./retrieval-evaluation.md)中的确定性内存 Provider
用于验证生产检索管道，不代表真实模型质量。内置模型需要单独的可选本地评测命令，
该命令不读取用户数据库、不联网、不进入默认 CI。

### 20.2 固定质量样例

至少覆盖：

- 中文自然语言改写和同义词。
- 中文 Query 检索英文资料。
- 英文 Query 检索中文资料。
- 中英文混合产品名、缩写和版本号。
- 精确代码标识、路径和错误码。
- 长文档标题与正文分离。
- 无答案问题。
- 语义相近但事实冲突的负例。

指标：

- Recall@5 和 Recall@10。
- nDCG@10。
- MRR。
- 无答案错误召回。
- 端到端延迟。
- 索引体积。

### 20.3 对比组

- FTS + CJK。
- 内置 Granite 97M R2 INT8。
- 用户显式配置的本机 OpenAI 兼容连接。
- 用户显式配置的网络 OpenAI 兼容连接。

用户连接组只在用户明确配置并授权评测时运行。评测报告必须记录完整 Fingerprint，不能
只写连接名称或模型显示名。

---

## 21. 实施状态

### 已完成：契约和模型目录

- 扩展角色感知 `EmbeddingProvider`。
- 定义 Profile、Encoding Recipe、Embedding Operation Snapshot 和完整 Fingerprint。
- 新增内置模型目录、Manifest、下载、取消、ZIP 和删除。
- 固定 Granite 97M R2 INT8 的 Revision、字节数、SHA-256、Tokenizer 和许可清单。

### 已完成：本地推理

- 新增 Utility Process 和私有消息协议。
- 实现 Tokenizer、ONNX CPU、Pooling、归一化和动态 Token 批处理。
- 实现加载、诊断、取消、崩溃恢复和退出。
- Windows x64 已完成真实推理；其余目标由六平台发布 Runner 继续验证。

### 已完成：设置界面

- 把现有单一向量表单重组为与 LLM 一致的连接列表，加入只读内置连接和用户可管理的
  OpenAI 兼容连接。
- 新增内置模型详情、下载进度、当前/草稿状态和真实诊断；内置连接不重复展示固定本地
  路径。
- 更正“自动回退”文案。

### 已完成：Provider 与索引兼容

- 将完整 Fingerprint 接入索引存储和查询。
- 冻结每个诊断、查询和重建任务的 Embedding Operation Snapshot。
- 验证模型切换、任务取消和文档级原子替换。

### 已完成：多连接管理

- 支持添加、编辑、测试和删除多个 OpenAI 兼容连接。
- 将现有单一 Endpoint、模型和凭据迁移为一个用户 Connection Profile。
- 用户连接持续显示 Loopback 与非 Loopback 数据去向，不引入品牌专属检测。

### 后续知识增强阶段

- 在全局设置中显示模型切换的受影响知识库数量和确认。
- 提供逐库或显式批量重建入口。
- 在知识库界面集中显示当前模型、索引模型和完整兼容性诊断。
- 增加用户授权的兼容连接质量评测入口。

---

## 22. 验收标准

### 22.1 产品

- 用户可以不安装外部服务，下载或导入内置 Granite 模型并完成真实诊断。
- 未经用户操作不会下载、启用、切换或更新模型。
- 内置连接与用户添加的 OpenAI 兼容连接出现在同一连接列表，不存在第二组路径切换。
- 向量连接不出现在项目 Runtime、Agent Runtime 或远程 Runtime 的模型选择中。
- 切换 Agent Runtime 不改变向量连接，切换向量连接也不改变 Agent Runtime。
- 用户连接持续显示数据去向，非 Loopback Endpoint 不标记为“本机”。
- 保存模型切换前显示当前模型、新模型和受影响知识库。
- 模型切换不会自动重建知识库。
- 向量失败时显示请求通道、实际通道和原因，不自动换模型。
- 旧诊断不会显示在已变化的草稿旁边。

### 22.2 推理与索引

- Query 和 Document 使用显式角色。
- 内置模型的 Tokenizer、Pooling、归一化、精度和维度全部来自固定 Manifest。
- 超长输入不会被 GoodBuddy 静默截断。
- Fingerprint 任一兼容字段变化后，旧向量不参与当前召回。
- 384 维向量继续以 Float32 和有效模长保存。
- 模型切换期间的活动任务按确认语义取消，不会混合两个 Provider。
- 新重建失败不破坏同一 Fingerprint 的上一版完整索引。

### 22.3 安全与交付

- Renderer 不读取模型目录、知识数据库或长期凭据。
- Agent Runtime 只能获得有界检索文本、引用和脱敏诊断，不能获得 Provider、模型文件、
  Tokenizer、原始向量、Endpoint 或凭据。
- 模型下载、导入和启动都验证 Manifest、大小和 SHA-256。
- ZIP 导入拒绝路径穿越、符号链接、可执行文件和超限内容。
- Utility Process 不监听端口、不继承无关密钥，应用退出时正常终止。
- 六个发布目标分别完成原生安装、模型加载、推理、取消和退出验证。
- 模型权重不出现在 GoodBuddy 安装包或仓库中。

### 22.4 工程验证

源代码实施后必须通过：

```text
npm test
npm run typecheck
npm run lint
npm run build
```

真实本地模型评测和用户连接调用使用独立门控命令，只有在模型已安装或连接已配置且用户
明确授权时运行。

---

## 23. 参考资料

- IBM Granite 97M Multilingual R2 模型卡：
  <https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2>
- IBM Granite Embedding Multilingual R2 说明：
  <https://huggingface.co/blog/ibm-granite/granite-embedding-multilingual-r2>
- IBM Granite Embedding 模型仓库：
  <https://github.com/ibm-granite/granite-embedding-models>
- BGE v1/v1.5 文档：
  <https://bge-model.com/bge/bge_v1_v1.5.html>
- BGE Small Chinese v1.5 模型卡：
  <https://huggingface.co/BAAI/bge-small-zh-v1.5>
- ONNX Community Granite 97M Multilingual R2：
  <https://huggingface.co/onnx-community/granite-embedding-97m-multilingual-r2-ONNX>
