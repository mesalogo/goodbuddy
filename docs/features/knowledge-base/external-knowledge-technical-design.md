# 外部知识库技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 三家生产 IPC 真实生成、Dify 完整 App 与当前 UI 自动回归已通过；远程待验收 |
| 版本 | 0.2 |
| 日期 | 2026-09-13 |
| 产品需求 | [外部知识库接入 PRD](./external-knowledge-prd.md) |
| 行为规则 | [外部知识库逻辑设计](./external-knowledge-logic-design.md) |
| 界面 | [外部知识库 UI 设计](./external-knowledge-ui-design.md) |
| 验证状态 | [实施进度](./progress.md) |

## 1. 实现边界

外部知识库复用 GoodBuddy 知识库 ID、聊天范围和检索入口。网络、凭据、响应读取和
标准化在 Main 完成，Renderer 通过明确的 Preload 方法调用 IPC。远端只执行目录、详情和
检索请求，不创建、修改、上传或删除远端内容，不调用外部 App、Chat、Workflow 或 Agent。

本地 `file | directory | url` 仍表示需要导入和索引的资料来源。外部绑定独立存储，
不加入该枚举，也不生成本地文档、分块、向量或图谱。实际用于回答的片段随会话引用保存。

## 2. 当前模块

| 文件 | 职责 |
| --- | --- |
| `src/main/knowledge/external/external-knowledge-client.ts` | 一个 `ExternalKnowledgeClient` 内按 Provider 分支处理固定端点、地址规范化、分页、HTTP 错误、超时、取消、响应上限和结果映射；同文件定义 `ExternalKnowledgeError` |
| `src/main/knowledge/external/external-knowledge-service.ts` | 实例保存与测试、凭据加解密、目录与详情、检索测试、创建或更新绑定、请求生命周期与配置变化检查 |
| `src/main/knowledge/external/external-knowledge-store.ts` | 在已有 SQLite 连接上读写实例 JSON 和绑定 JSON |
| `src/main/knowledge/knowledge-database.ts` | v12 迁移、知识库与绑定事务、唯一约束及删除外键 |
| `src/main/knowledge/knowledge-service.ts` | 本地与外部检索分派、混合检索和总字符预算；阻止外部绑定进入本地维护操作 |
| `src/shared/external-knowledge-contracts.ts` | Provider 配置、实例与绑定输入、目录、测试结果和外部引用定位契约 |
| `src/shared/knowledge-contracts.ts`、`contracts.ts`、`assistant-contracts.ts` | 现有知识结果、列表和会话引用增加外部字段 |
| `src/shared/knowledge-reference.ts` | 预检索与 MCP 共用的引用转换和去重键 |
| `src/main/ipc.ts`、`src/preload/index.ts`、`src/shared/ipc-channels.ts` | 可信发送方检查、Zod 输入解析、类型化跨进程调用 |
| `src/renderer/src/ExternalKnowledge.tsx` | 实例 Modal、绑定表单、Provider 配置、外部详情与检索结果 |
| `KnowledgeWorkspace.tsx`、`App.tsx`、`KnowledgeCitationDialog.tsx` | 统一列表、聊天选择、刷新及历史引用显示 |

`ExternalKnowledge.tsx` 的字段改用全局 `.field`，修正 body Portal 脱离知识库祖先后
丢失 scoped 控件样式的问题。CSS 提供 560px 紧凑弹窗和粘附底部操作区；实例选择复用
既有 picker 样式并实现菜单键盘行为。没有新增 Main 模块，具体控件规则由
[UI 设计](./external-knowledge-ui-design.md#当前实现与验收边界)维护。

当前没有独立 Provider 文件、Adapter Registry、Normalizer、版本化能力清单或配置迁移框架。
本文件按现有三个 Main 模块描述实现，不把旧草案中的拆分方案列为待建基础设施。

## 3. 共享契约

### 3.1 实例与绑定

实例输入包含 `id?`、`name`、`provider`、`baseUrl`、`enabled` 和
`credential: keep | replace | clear`。实例摘要返回启停、凭据状态、`probeStatus`、绑定数、
最近测试时间和错误码，不返回凭据 envelope。当前没有 `detectedVersion`、`adapterVersion`
或 `transportSecurity` 字段。

绑定保存 `knowledgeBaseId`、`instanceId`、`provider`、`remoteKnowledgeBaseId`、
`remoteName`、`commonConfig`、`providerConfig` 和 `lastVerifiedAt`。GoodBuddy 名称和描述
保留在知识库记录。创建和更新输入都要求用户填写 `testQuery`；服务保存前重新执行检索，
因此先点击“测试检索”再保存会产生两次检索请求。成功零命中允许保存。

### 3.2 配置范围

| 配置 | 当前共享契约 |
| --- | --- |
| 通用 | `resultLimit` 1 至 20，默认 6；`requestTimeoutMs` 1,000 至 60,000，默认 15,000；`maxSnippetCharacters` 100 至 8,000，默认 4,000 |
| Dify | 默认分支仅包含 `provider` 和 `useDatasetDefaults: true`；覆盖分支使用严格的 `retrievalModel` 对象，包含检索方式、Top K、阈值开关和重排开关，按启用条件校验阈值、重排模型或权重 |
| FastGPT | `searchMode`、`tokenLimit`（1 至 30,000）、`similarity`、`usingRerank`；不发送查询优化参数 |
| RAGFlow | `similarityThreshold`、`vectorSimilarityWeight`、`knnTopK`（1 至 2,048）、`useKg`、`includeKnowledgeCompilation`；当前无 Rerank、Metadata 编辑字段 |

Provider 必须与实例一致。Dify 加权配置还在客户端检查权重和为 1。共享查询输入上限为
4,000 字符，Dify 客户端另按 Unicode 码点拒绝超过 250 字符的查询，不静默压缩。

### 3.3 结果与引用

现有 `KnowledgeRetrievalResult` 的本地 `documentId/sourceId/chunkId` 改为可选，增加
`external?: ExternalKnowledgeLocator`，没有另建一套 `UnifiedKnowledgeRetrievalResult`。
外部定位包含 Provider、实例 ID、远端库 ID，以及实际返回的文档 ID、片段 ID、位置和评分。
FastGPT 数组评分存为 `providerScores: {type, value, index?}[]`，保留顺序与类型；数值评分
存为 `providerScore`，不选取数组首项冒充总分。

外部结果沿用旧结果容器的空 `channels` 和 `scores.fusedScore = 0`。该零值是结构占位，
不表示质量；`toKnowledgeReference` 不把它写成引用总分。外部结果没有统一 `relevance`，
不同 Provider 的原始分数不参与跨库混排。引用去重键包含外部定位和片段，不伪造本地 ID。

## 4. SQLite 与凭据

数据库 v12 增加两张表：

```sql
CREATE TABLE external_knowledge_instances (
  id TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
CREATE TABLE external_knowledge_bindings (
  knowledge_base_id TEXT PRIMARY KEY REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES external_knowledge_instances(id) ON DELETE RESTRICT,
  remote_id TEXT NOT NULL,
  value_json TEXT NOT NULL,
  UNIQUE(instance_id, remote_id)
);
```

没有向 `knowledge_bases` 增加 `kind` 列；IPC 快照根据是否存在绑定投影
`KnowledgeLibrary.kind` 和 `external`。旧本地数据保留，知识库与绑定在同一事务中保存。
外部库沿用本地表所需的默认字段，但这些字段不进入 Provider 请求。

Main 启动把已有 `secureCipher` 注入 `KnowledgeService`。服务复用
`SettingsCredentialCipher` 和现有加密函数，把 envelope 放入实例 JSON；`replace` 要求
安全存储可用，`keep` 保留已有 envelope，`clear` 移除凭据。列表会尝试解密以区分
`configured/missing/unavailable`，请求前再次解密，没有独立明文凭据缓存。

## 5. IPC 与生命周期

Preload 暴露实例 `List/Save/Test/SetEnabled/Delete`、目录 `List/Get`、绑定
`Create/Update` 和 `externalRetrievalTest`。通道使用 `knowledge:external-*` 前缀，
准确名称以 `ipc-channels.ts` 为准。移除绑定复用 `deleteLibrary`，没有独立 remove 通道。

Handler 调用 `assertTrustedSender` 并解析共享输入；检索按实例 ID 在 Main 读取地址与凭据。
实例先保存为 `untested`，列表上的连接测试调用目录请求并更新摘要，不测试未保存草稿。
绑定检索测试是单独操作，不会改变实例探测状态。探测状态取值为 `untested`、
`catalog-ready`、`list-restricted`、`auth-failed`、`unreachable`、`failed`。

服务按实例记录 AbortController。保存实例、停用、删除以及服务关闭会取消相应请求；
调用方取消信号与总超时合并。取消即是配置变更的唯一处理方式：被取消的连接测试直接抛出
`EXTERNAL_KB_CANCELLED`，不写回探测结果，因此不需要额外的前后配置快照比较。绑定保存在
验证请求前后各检查一次同一远端目标是否已被占用，最终以 `UNIQUE(instance_id, remote_id)`
索引为准。共享 IPC 没有 `requestId` 或取消方法；Renderer 用局部 generation/active 标记
丢弃旧响应，这与中止 Main 请求是两种行为。

删除仍被引用的实例返回 `EXTERNAL_KB_INSTANCE_IN_USE`。UI 确认后逐个调用本地
`deleteLibrary`，再删除实例；这是顺序操作，发生中途失败会刷新已移除的绑定，不是跨调用事务。

## 6. HTTP 边界

客户端只接受 HTTP(S)，拒绝地址内的用户名、密码、查询与片段；按 Provider 规范化 API
路径，仅拼接内置端点。请求使用 Bearer 认证，`redirect: 'error'`，无自动重试或公共云回退。
默认超时 15 秒，单个响应默认上限 5,000,000 字节；响应头和流式读取均检查上限，取消
期间终止读取。解析后只投影需要的有界字段，最多返回 20 条、每片段 8,000 字符。

当前使用 `fetcher ?? fetch`，没有单独连接全局内网兼容模式、证书例外或按地址保存传输
确认。2026-09-13 当前生产服务在真实 Electron 中对两个 Dify 和 FastGPT HTTPS 配置完成
严格证书校验，RAGFlow 使用 HTTP。此证据覆盖这些配置的请求，不表示旧 PRD 的地址确认
或证书例外流程已实现；相关产品差异仍由功能 owner 核对。

## 7. 检索编排

`KnowledgeService.retrieve` 按知识库 ID 单行查询本地绑定，存在绑定时调用
`ExternalKnowledgeService.retrieve`，否则执行现有本地路径。外部结果附加
`diagnostics.external`，不运行本地向量、全文或图谱检索。

`ExternalKnowledgeService` 区分两个入口：`retrieve` 是生产检索路径，只发出一次检索请求；
`testRetrieval` 仅用于保存绑定前的验证，额外在同一超时预算内确认 RAGFlow 图谱与知识编排
能力可用，能力缺失时返回 `EXTERNAL_KB_CAPABILITY_UNAVAILABLE`。生产检索不执行该能力预检，
因此正常对话不会多一次 detail 请求，也不会出现仅属于保存校验的错误码。

`retrieveMany` 对传入知识库 ID 去重并读取知识库，使用 `Promise.all` 逐库检索；只有选中
需要向量的本地库时才准备本地查询 Embedding。当前没有额外的 Provider 并发队列。单库
失败写入 `response.diagnostics.failure` 并保留空结果，成功零命中没有 failure；调用方
取消仍向上传播。当前返回 `{knowledgeBaseId, response}[]`，没有独立的 Outcome 状态联合。

服务检索与绑定验证共用同一裁剪逻辑：先按绑定的结果数与单片段限制裁剪，并限制该次片段
总量为 48,000 字符。
`retrieveMany` 展平各库结果并按库内 rank 稳定排序，再轮转分配 48,000 字符的片段预算：
先处理各库第 1 条，再处理各库第 2 条，同 rank 保持输入库顺序。不会先耗完整个库再轮到
下一个库；仍没有固定的每库最低字符配额。关联的本地上下文 groups 随相应结果使用另一份
48,000 字符预算。二次裁剪会标记 `context.truncated`，但第一次标准化裁剪不提供完整的
远端原始条数与截断诊断。

聊天预检索、检索测试相关 IPC 和 `KnowledgeMcpGateway` 已使用统一检索入口。引用转换
复用 `knowledge-reference.ts`，聊天与 MCP 仍按现有授权范围和各自输出预算处理结果。
MCP 在总预算裁剪后按库内 rank 交错选择结果，再应用工具条数和字节上限；有失败且
没有任何片段时返回工具错误。预检索只在全部库失败时报告整体失败，成功零命中伴随其他
库失败时保留降级诊断。这两种上层呈现并不完全相同。

## 8. 引用显示与历史数据

会话契约和数据库保存外部定位及有界片段。外部引用弹窗读取保存的片段，显示 Provider、
实例 ID、远端库和实际返回的定位及评分；不请求本地 `referenceContext`，不显示本地
`openSource` 操作。当前没有远端来源打开或引用刷新请求，`sourceUrl` 是可选契约字段，
三家现有映射没有填充它。

App 的 `source-references` 事件使用共享 `knowledgeReferenceKey` 去重传入引用，再合并
尚未被替代的旧引用，最多保留 20 条。键包含 Provider、实例、远端库、远端文档和片段 ID、
定位与片段正文；外部结果缺少本地 ID 时也不会仅因本地 ID 相同而被合并。引用弹窗按
`context.locator ?? external.location ?? locator` 选择一个定位，只显示一次。

移除绑定后历史片段仍可阅读；当前弹窗不查询实例状态，也不生成“连接已移除”标记。
实例名称没有作为独立字段存入外部 locator，不能承诺删除实例后仍显示其名称。

2026-09-13 Dify 桌面报告已验证实时搜索引用通过生产 `conversations.saveLocal` 保存、
重载并打开弹窗。会话由验证程序标记为测试记录，没有模型生成答案；最终引用去重与定位
修正后的回归状态单独记录在[实施进度](./progress.md)。

后续 `kb-full-app-live` 则通过完整 App 输入区真实发送并保存模型答案，再点击引用。
引用片段、远端文档和片段 ID 与真实检索记录一致，无伪造会话或事件；此证据覆盖 Dify
单库短答案。三家生产 IPC 生成检查还验证了 `task_events` 中的文本、引用和选中库范围。

## 9. Provider 映射

本节区分当前客户端行为与历史接口探测。历史响应和官方文档只说明当时观察到的接口，
不证明当前桌面已完成验收。

### 9.0 真实实例验证基线

| 历史日期 | 证据与限制 |
| --- | --- |
| 2026-09-09 | [基线报告](./external-knowledge-probe-baseline.json)：累计 107 次只读请求，最终归档脚本 19 次；当时 HTTPS 放宽证书校验 |
| 2026-09-10 | [基础报告](./external-knowledge-probe-2026-09-10-strict.json)与[扩展报告](./external-knowledge-probe-2026-09-10-extended.json)：共 33 次只读请求，其中检索 17 次；HTTPS 显式开启证书校验，RAGFlow 为 HTTP |

历史结果包含 Dify 0.15.8 详情 405、检索零命中，Dify 1.17.0 详情成功及 3 条非空结果；
FastGPT 三种模式和重排非空；RAGFlow 图谱开关产生不同结果，但 Knowledge Compilation
没有配置证据。FastGPT/RAGFlow 产品版本、Dify 0.15.8 非空结构及真实错误矩阵仍未确认。
逐项数量、脚本命令和当时测试结果由[实施进度](./progress.md#验证证据)维护。

2026-09-13 新增当前产品证据：[生产验证摘要](./external-knowledge-validation-2026-09-13.json)
记录真实 Electron safeStorage 持久化重开、生产服务与本机 HTTP MCP，以及 Dify 桌面。
服务结果与 MCP 引用数分别为 Dify 配置 1 的 0/0、Dify 配置 2 的 2/2、FastGPT 的 2/2、
RAGFlow 的 1/1。报告配置编号不是版本识别，历史版本差异不据此重新认证。

### 9.1 Dify

固定使用 `GET /v1/datasets`、`GET /v1/datasets/{id}` 和
`POST /v1/datasets/{id}/retrieve`。默认省略整个 `retrieval_model`，远端优先使用知识库
当时配置，未保存时由远端选默认；覆盖时发送完整的本地 `retrievalModel`，不逐字段合并。
结果从 `records[].segment`、文档和分数取值。

客户端把详情 405 分类为不兼容，绑定表单允许详情失败后继续检索验证，不实现版本探测或
自动遍历目录的详情回退。Scoped Key 可尝试手工 ID，但当前产品的真实受限密钥验收仍待完成。
Metadata、多模态、摘要索引、子块、附件和 Pipeline 没有进入当前简化目录或结果映射。

官方来源：[Knowledge API](https://docs.dify.ai/en/api-reference/guides/knowledge)、
[列表](https://docs.dify.ai/en/api-reference/knowledge-bases/list-knowledge-bases)、
[详情](https://docs.dify.ai/en/api-reference/knowledge-bases/get-knowledge-base)、
[检索](https://docs.dify.ai/en/api-reference/knowledge-bases/retrieve-chunks-from-a-knowledge-base-test-retrieval)、
[缺省配置实现](https://github.com/langgenius/dify/blob/main/api/services/hit_testing_service.py)。

### 9.2 FastGPT

固定使用 `POST /api/core/dataset/list`、`GET /api/core/dataset/detail?id=...` 和
`POST /api/core/dataset/searchTest`。列表 `data[]` 保留 Dataset 与文件夹，按 `parentId`
读取层级，在当前父级响应内搜索和分页；文件夹只用于浏览。

检索接受业务码 200 的 `data.list[]` 与旧手工文档的 `data[]`，不递归猜测嵌套结构。
`q` 必需，`a` 仅在存在时追加；评分数组保留类型、值和可选 index，数值评分独立处理。
当前客户端已通过 FastGPT 真实服务与本机 HTTP MCP，均返回 2 条。报告确认结果契约与
引用映射有效，没有逐项归档评分包装，故旧包装和全部评分变体仍以定向测试证据为限。

请求映射 `datasetId/text/limit/similarity/searchMode/usingReRank`，不发送查询扩展。
Embedding、Rerank 和远端 API 审计仍可能产生用量；不调用 FastGPT 生成最终回答。

官方来源：[API 说明](https://doc.fastgpt.io/zh-CN/openapi/intro)、
[旧手工接口页](https://doc.fastgpt.io/zh-CN/openapi/dataset)、
[生成 Schema](https://github.com/labring/FastGPT/blob/main/packages/global/openapi/core/dataset/api.ts)、
[检索处理器](https://github.com/labring/FastGPT/blob/main/projects/app/src/pages/api/core/dataset/searchTest.ts)、
[结果 Schema](https://github.com/labring/FastGPT/blob/main/packages/global/core/dataset/type.ts)。
4.15.0 起应核对部署实例生成文档；历史检查只取得云端 `/apidoc/` 应用壳。

### 9.3 RAGFlow

目录和按 ID 详情均使用 `GET /api/v1/datasets`，检索使用 `POST /api/v1/retrieval`。
请求发送 `question`、单个 `dataset_ids`、`page: 1`、`page_size: 20`、阈值、向量权重、
`knn_top_k` 及显式的图谱、知识编译布尔值。HTTP 成功且业务码为 0 才读取 `data.chunks`。
文档名映射 `document_keyword`，位置保存返回的 `positions`，分数取原始 `similarity`。

`graphEnabled` 根据有效非零 `graphrag_task_finish_at` 判断；仅配置
`parser_config.graphrag.use_graphrag` 不算完成。知识编译依据非空
`compilation_template_group_id`。启用任一能力时，服务在检索前重新读取详情确认。
当前不保存完整能力快照，不区分图谱未配置与构建中，也不检测 Provider 版本。

官方来源：[HTTP API](https://ragflow.io/docs/dev/http_api_reference)、
[当前文档原文](https://github.com/infiniflow/ragflow/blob/main/docs/references/http_api_reference.md)、
[v0.24.0 文档](https://github.com/infiniflow/ragflow/blob/v0.24.0/docs/references/http_api_reference.md)。
旧文档只声明 `top_k`，当前客户端发送 `knn_top_k`；请求成功不证明候选数参数生效，
也不是旧部署版本兼容承诺。

## 10. 验证与验收

三家 Provider 已通过生产 `KnowledgeService` 与本机 HTTP MCP，真实 Electron
safeStorage 加解密和持久化重开成功。Dify 桌面已完成绑定、参数更新、重启、三档窗口宽度
及历史引用检查。验证方法、原始报告边界和调用计数见[实施进度](./progress.md)及
[脱敏摘要](./external-knowledge-validation-2026-09-13.json)。本轮文档只读取报告，没有
另发 Provider 或模型请求，也未改动历史探测 JSON。

当前 Portal 与控件修改后的聚焦测试、全量回归、类型检查、lint、工作区及暂存区 diff
检查均已通过。精确计数、运行命令、耗时、执行期间文件稳定性和原失败修正记录统一见
[实施进度](./progress.md#2026-09-13-当前工作区实现与分组验证)。

后续真实生成使用已保存的默认模型，凭据在 Main 通过 safeStorage 解密。三家 Provider
的 `always` 及 Dify `auto` 已产生有依据和引用的短答案；Dify `auto` 经进程内
`ModelToolProvider → KnowledgeMcpGateway` 执行，不能当成本机 HTTP MCP 或远程 ACP
验收。FastGPT/RAGFlow 首轮因直接比较序列化字符串产生验证断言失败，解码请求和嵌入
证据 JSON 后重跑通过；报告保留初始结果。完整 App 输入区的发送、真实答案及引用点击
仅覆盖 Dify。Dify/FastGPT 使用严格 HTTPS，RAGFlow 和模型使用已配置的 HTTP。

请求精确增量与视觉 fixture 边界见[后续验证摘要](./external-knowledge-follow-up-2026-09-13.json)
及[实施进度](./progress.md#2026-09-13-ui-修正与真实生成复验)。不公开模型端点、私有配置
标识、凭据和答案正文。这些短答案检查没有评估广泛问答质量。

FastGPT/RAGFlow 完整桌面专属操作、复杂或混合问答、删除和真实错误矩阵仍需补验。
Linux Host 的两条网络路径可达，但验证程序无法解密已有 SSH 凭据，在认证前返回
`E_SAFE_STORAGE_DECRYPT_FAILED`，真实远程 forced-preflight 未执行。本机 HTTP MCP
成功不覆盖该远程路径。剩余 Provider 版本和高级参数效果也不能由基础检索成功推断。

原设计的分项探测 UI、最低版本矩阵、详细诊断、地址确认和取消交互未全部落地。它们是
待核对的产品差异，不能以补建 Adapter Registry 或版本框架代替验收决策。

`scripts/external-knowledge-probe.mjs` 仍可只读探测列表、详情、检索；`--extended` 增加
Dify 配置覆盖、FastGPT 重排和 RAGFlow 两种开关。报告区分成功零命中与失败，不输出
凭据或业务正文。脚本不打包到桌面或 Agent，脚本执行本身不覆盖 UI、IPC、存储和引用链路。

## 11. 需求追踪

| 需求 | 当前实现落点 | 待验收重点 |
| --- | --- | --- |
| `EK-FR-01` 至 `EK-FR-05` | 实例 Service/Store、目录 Client、IPC 与管理表单 | 服务已验证；补充 FastGPT/RAGFlow 桌面和受限目录手工 ID |
| `EK-FR-06` 至 `EK-FR-10` | 共享 Provider 配置、绑定事务、统一列表与两栏表单 | Dify 参数与布局已验证；其他 Provider 专属参数及未提供字段待核对 |
| `EK-FR-11` 至 `EK-FR-14` | `retrieveMany`、预检索、MCP、共享引用与 failure 字段 | 三家 IPC 短答案与 Dify 完整输入区引用已验证；混合失败、广泛问答与远程待补 |
| `EK-FR-15` | 唯一约束、外键保护、顺序本地删除 | 中途失败刷新、远端内容不变 |
| `EK-FR-16` | Main 固定端点、有界请求与数据说明 | 当前桌面传输行为与 PRD 差异 |
