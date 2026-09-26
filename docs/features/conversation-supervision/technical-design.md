# 监督者技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 生产分页、持久化批次、暂停/继续及设置已接线；27 条消息完整会话通过真实模型验证，较大样本仍未完成；完整历史回放未实现 |
| 日期 | 2026-09-23 |
| 产品设计 | [监督者应用产品设计](./supervisor-prd.md) |
| 行为规则 | [监督者逻辑设计](./logic-design.md) |
| 界面设计 | [监督者 UI 设计](./ui-design.md) |
| 实施进度 | SQLite schema 47；当前算法、设置和验收边界见[生产接线](./review-scheduling-design.md#0-生产接线与剩余边界) |

本文回答如何在现有 GoodBuddy 桌面端中实现监督者。它不改变产品范围，也不把模拟 Demo 当作生产数据模型。

生产入口由 `supervision-production.ts` 组装服务、SQLite、共享池和 ask Runtime。`supervision-review-store.ts` 保存冻结来源清单，按有界页和片段供 `SupervisorService` 派发；叶子及连续位置先提交，导航和完整结果之后发布。消息已有知识引用保留本地或外部 locator，已确认记忆通过独立背景输入提供。不会检索外部全库。详细存储、调度及当前限制统一见[分块调度第 0 节](./review-scheduling-design.md#0-生产接线与剩余边界)。

模型实体 `id` 只在单次输出内有效。Main 从同一 scope 的故事线提供最多 100 个未撤销实体候选，生产提示只暴露 `candidateRef`（如 `known_1`）、名称和说明。模型显式选择候选后，Main 转换为严格 UUID 类型的内部 `persistedId`。服务校验候选集成员和重复映射，保存事务再次按实体主键校验故事线归属及撤销状态。没有有效候选引用时分配新 UUID，不按名称或裸模型 ID 合并。来源仍按每次结果分配 UUID，保留原始 `source_id` 和 locator。

新实体省略 `candidateRef`，不要求模型生成数据库 ID。未知非空 `candidateRef`、冲突身份和候选集之外的 UUID 均拒绝。旧输出中的 `persistedId` 仅在 UUID 合法且属于候选集时复用；空值、占位符和格式错误值不能证明已有身份，保留为独立新实体。局部 ID 或同名不会触发合并。

真实旧库存在 `goodbuddy` 等文本实体主键。候选读取为这些键生成稳定 UUID 别名，并在 Main 内保留 `storageId` 到原键的映射；模型看不到这两个字段。别名使用 scope 和原键的 SHA-256 摘要构造 UUID v8，保存时按精确映射查询原实体，保留历史图谱引用和人工确认字段，不迁移或重写原主键。新实体仍由 Main 分配随机 UUID。此兼容仅处理已经存在的旧库键，模型返回同样的文本不能直接复用实体。实测见[真实失败运行修复](./progress.md#2026-09-24-真实失败运行身份修复)。

schema 42 为实体、实体变化和关系增加 `source_reference_ids_json`，保存映射后的来源 ID。升级只补列，旧记录、ID、确认状态及 locator 保留；此前未保存的引用使用空数组，已被覆盖或忽略的历史内容无法据此恢复。

schema 43 在结果上增加 `graph_snapshot_json`，保存当次实体名称、说明、确认状态、关系理由及本次来源引用。后续 run 只更新 `automatic` 的当前实体与关系，已确认、修订或移除状态受保护。历史结果读取自身内容；人工操作带 `resultId` 时先校验成员归属，在事务内更新当前对象及所选结果，其他结果不变。移除关系记录 `revoked`，防止后续相同端点和类型的自动关系恢复它。

升级从现有事件实体关联、实体变化和来源引用恢复结果成员，不猜测名称匹配；旧数据缺失的归属或已经覆盖的内容无法还原，原对象仍保留。新结果即使实体没有事件或来源，也会保存完整成员。结果内容与运行、事件、来源在同一事务提交。

`overview({ target? })` 返回稳定的 `id`、`storyLineId` 及来源 ID。指定 Conversation/Task 时，Main 读取目标实际项目，查询同时要求目标来源匹配、结果 scope 为 global 或包含该项目；LIMIT 在过滤之后。卡片展示结果真实范围，global 结果不会伪装成单会话摘要。`graph({ resultId, storyLineId? })` 校验二者归属，只返回该结果的事件、对象和来源；显式 ID 无效时不回退到最新结果。继续讨论按结果主键读取，并验证来源属于该结果。

工作回顾保存所选结果，切换或刷新使用请求序号忽略迟到图谱。侧栏按目标重建卡片，清空来源和预览，并忽略旧请求；工作栏 tasks 实例的 `targetRef` 可保存 conversation/task 固定目标，取消固定后恢复跟随当前选择。该绑定只控制监督卡片，不改变任务列表的项目范围。继续讨论预览显示实际目标名称和 ID，发送回调显式携带该会话 ID，由 Main 使用该会话的 Runtime 与项目。

侧栏通过 `onOpenSupervisionGraph(resultId)` 交给 App 导航；App 遵守现有离页检查，向 HeartbeatCenter / SupervisorWorkspace 传递类型化 `graphNavigation`，复用 `heartbeat` 路由及 keepalive 页面。每次点击创建新的导航请求，打开 graph 页签并更新历史选择共用的 resultId。overview 未包含该 ID 时仍直接请求其 graph；旧 overview、graph、来源和操作响应通过同一请求序号失效，不覆盖新结果。没有新增 window 事件、页面或持久化字段。

继续讨论入队时，无附件请求省略 `serializedContexts`；请求未指定 Runtime 时使用会话保存的选择。知识库预览与提交均检查目标库存在且为本地可写库，更新实体还检查其实际所属库。侧栏确认框展示 Main 返回的实体字段、目标库和来源正文，取消或写入失败后可以重新预览。

监督来源清单将 UI 时间区间归一化为 UTC，先筛选再按稳定键分页。项目必须存在且 active；消息按闭区间筛选，任务按区间内创建或完成时间筛选。手动和自动监督共用该路径，自动清单另读取 supervisor checkpoint；手动心跳报告保留原有 collector。

已确认记忆作为当前背景，不参与新增正文覆盖。最多四条、每条 500 字符，时间来自真实更新时间；模型不能把背景引用为本批新增证据。旧结果继续保留原来源类型和 locator。监督正文上限现用于分批，余段继续处理；心跳报告的有界输入语义没有改变。

## 模型阶段超时与调度

监督整理超时由 run 创建时冻结；共享模型池仍采用实时设置上限。`supervision:pause` 取消该 run 的排队和在途工作，`supervision:resume` 继续已保存批次；监督整理输出在流中按 `supervisionReview.responseKiB` 检查响应容量，默认 1024 KiB，可在设置页调整为 100 至 16384 KiB。该容量每次请求读取当前设置，继续旧运行也采用新值；超限保留成功批次并提示调高后继续。生成摘要及事实内容不设独立短字符限制，监督旧摘要读取保留全文，具体边界见[生产接线](./review-scheduling-design.md#0-生产接线与剩余边界)。以下报告领取和租约规则继续适用。

手动和自动监督均在桌面 Main 调用生产工厂，Runtime 解析请求只有 `workMode: ask`，不携带 SSH 项目或执行空间。摘要校验、合并和持久化在 Main 完成；本次取消内容长度限制不改变 `gbagent`、远端 Runtime 启动或桌面到 Agent 协议。

`ApplicationSettingsStore` 持久化报告和整理模型超时，均为 30..600 整数秒，默认 240。报告排队前冻结，监督创建 run 时冻结；计时从获槽及 Runtime 解析后开始，覆盖模型执行及其内部重试。流结束校验 signal 和完成事件，finally 释放临时会话，心跳报告保持原有 100KB 上限，监督整理使用上文的可调响应容量。采集、排队、保存和清理不计入模型超时。

`supervisorModelConcurrency` 为 1 至 4 的整数，默认 1。报告和监督整理共用 Main 内 `SupervisionModelPool` FIFO 池，普通聊天不入池；降低上限不终止在途请求。报告槽位从领取前持有至报告完成或无变化提交后，在下游监督开始前释放，避免并发 1 时相互等待。监督服务外层运行仍串行；该池不是完整分块调度器，也不提供跨聊天与监督的提供商全局并发、RPM、TPM 或 Retry-After 控制。

报告租约为 `max(300, reportTimeoutSeconds + 60)` 秒，300 是下限；每次到期领取最多一条。Runtime 解析后、模型请求开始前按冻结超时刷新租约，数据库要求运行 ID、owner、attempt、claimed 状态和未过期条件均匹配，否则拒绝启动模型。直连模型独立的 600 秒传输超时、网络重试、心跳重领及轮询不属于用户阶段时限。设置 UI 提供两个超时、共享并发及分页/分批/单次响应容量字段；整次回顾持续处理至完成，旧 `executionSeconds` 不再参与执行判断。

schema 47 的四张批次相关表使用外键随监督运行清理，未完成运行不新增自动过期删除规则。启动时原有 running 记录会标 failed，但已保存批次和配置保留，活动页仍可继续。发布逐页读取叶子并复用现有结果/来源/图谱写入，在同一事务更新完成状态和自动 checkpoint。

当前设置及冻结范围见[当前设置合同](./review-scheduling-design.md#当前设置合同)。未实现的高级参数继续保留在目标清单，不显示为可保存控件；没有兼容原型数据库的读取器。

## 自动增量收集

本节的 100 来源/2,000 码点批次查询现用于原心跳报告及旧服务测试；生产监督使用 schema 47 清单及批次位置，自动 checkpoint 只在完整发布时提交。已有 schema 46 指纹算法和 checkpoint 仍复用，不重置用户已处理位置。

对应 FR-S4、FR-S10 和 US-S27，行为定义见[自动增量与手动重看](./logic-design.md#自动增量与手动重看)。schema 46 在现有数据库增加 `review_checkpoints`，主键为阶段、规范化 scope 和来源标识，保存版本指纹、已处理位置和来源长度。来源标识区分消息 ID、任务 ID 和消息内知识引用位置，不使用消息时间戳作为身份。

消息正文写入时由 SQLite trigger 更新轻量 `review_revision`；范围、标题、角色和时间共同参与版本指纹。任务标题、状态、创建和完成时间，以及知识引用内容或定位变化分别使对应来源待处理。工具执行元数据更新不会把未修改的消息正文再次标为新增。删除来源时清理其进度。原始消息不复制到进度表；自动查询先排除已处理版本，再读取待处理片段，不重新载入每个会话的历史正文。

原心跳增量查询按来源时间和 ID 排序，每轮最多 100 个来源、每个最多 2,000 码点，正文预算 12,000 UTF-16 单元。该报告路径的余段留待后续检查，窗口外来源不自动补读。生产监督另用冻结清单和持久化批次，未读尾部不会因继续时的滚动窗口变化而消失；旧监督分支的 44,000/48,000 字符上限已退出生产接线。

只有实际送入模型、通过结果校验且成功落库的完整片段推进位置。心跳报告及其进度、监督结果及其进度分别在各自 SQLite 事务提交。监督服务串行执行，后续自动请求在前次保存后重新收集。报告成功而监督失败时，下一次自动检查跳过已成功的报告输入，但重试监督输入；无变化不创建报告、来源或图谱事件。

已有同 scope 故事线的 scope 表示和实体 ID 保留；比较项目集合时忽略排序。模型接收最近摘要和同 scope 最多 100 个未撤销实体的候选引用、名称、说明，显式选择候选才复用，身份转换按上文执行。不同范围不合并，已有重复实体不自动修复。知识引用继续以独立来源保存 locator；当前记忆和旧摘要不作为新事件。

迁移在事务中扩展心跳计划及运行表的状态 CHECK，保留列、索引、ID、计划、报告与引用；消息版本列使用默认值，无需遍历或重写旧正文。进度初始为空，首次自动运行从配置窗口开始。报告保留期限覆盖 `no_change` 运行，但不删除来源进度；删除报告不触发重新消费。

## 活动读取与执行持久化

对应 FR-S10、US-S26。schema 45 在既有 `supervision_runs` 增加可空 `heartbeat_run_id` 和唯一索引，在 `heartbeat_runs` 增加执行范围、下游投影状态、错误及结束时间字段。迁移保留原记录，不补造旧关联。监督服务通过 store 的 start/fail 接线记录执行，保存结果事务更新同一 run；不增加调度器。心跳在执行前记录冻结范围和投影进度，报告事务仍保持原有含义，下游失败单独保存。手动心跳在生产路径使用实际结束时间，活动等待下游结束后才显示整次执行的结束时间。

`supervision:activity` 沿用可信 sender 与 Zod 输入校验，接受 `limit`（1 至 100，默认 50）、`offset`（0 至 100000）及可选 `configId`。应用未启用时返回空列表且不访问活动表。未筛选时 SQL 合并心跳及未关联的监督记录；筛选时在 LIMIT/OFFSET 前按 `heartbeat_runs.config_id` 精确匹配，排除独立手动回顾，不依赖计划名称或范围。关联查询使用运行 ID；返回状态、阶段、范围、时间、错误、摘要和 resultId，不调用模型。保留规则和历史缺失见[活动记录](./logic-design.md#活动记录)。

Preload 暴露类型化 `supervision.activity()`。`overview({ resultId })` 支持按 ID 读取历史回顾，供活动跳转使用。Renderer 只在活动页签和 heartbeat 路由同时激活时串行定时读取，每次有界分页；effect 清理撤销定时器并使旧响应失效。App 关闭应用时卸载页面；读取没有执行副作用。该改动位于桌面 Main/Renderer，未修改 Agent 或远程 Runtime 协议。

活动进度现在包含既有运行 JSON 中的持久 `phase` 及导航表计数 `navigationNodes`。`SupervisionReviewStages` 将实际阶段与监督运行状态组合呈现；`SupervisionBatchDetails` 按既有 10 批分页结果组织项目、会话和批次，新增批数变化时刷新已打开页。导航和叶子使用不同的严格输出 schema，继续仍复用成功叶子与导航节点。字段语义、旧记录缺失和同步阶段限制由[生产调度合同](./review-scheduling-design.md#已接入的调度与存储)统一定义；未增加任务调度器、数据库表或远程协议。

## 1. 总体方案

监督者作为 Main 进程中的一个领域服务，复用现有智能心跳的计划、运行领取、租约、重试和有界模型调用。图谱是监督者整理结果的查询视图，知识库继续拥有资料正文、索引和检索。

```mermaid
flowchart LR
    UI["Renderer\n监督者页面 / 图谱 / 侧栏"]
    IPC["Preload + IPC\n类型化输入输出"]
    SVC["SupervisorService\n范围、运行、结果、用户确认"]
    HB["HeartbeatService\n计划、领取、租约、重试"]
    EVIDENCE["EvidenceCollector\n按范围读取有界证据"]
    MODEL["BoundedSummarizer\n只读 JSON 输出"]
    STORE["AssistantDatabase\nSQLite 事务与查询"]
    KB["KnowledgeService\n本地资料、引用、检索"]
    CONV["会话 / 笔记 / 任务"]

    UI --> IPC --> SVC
    HB --> SVC
    SVC --> EVIDENCE
    EVIDENCE --> CONV
    EVIDENCE --> KB
    SVC --> MODEL
    SVC --> STORE
    SVC --> UI
    SVC -->|确认后补充本地条目| KB
```

职责边界如下：

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| `HeartbeatService` | 计划、到期运行、租约、重试、已有报告兼容 | 图谱实体合并、用户确认、知识库写入编排 |
| `SupervisorService` | 触发统一、证据收集、整理结果、图谱查询和修订 | 自己实现调度器、复制来源正文 |
| `EvidenceCollector` | 按冻结范围读取会话、笔记、任务、知识库引用 | 越过范围读取全部数据、调用工具 |
| `SupervisorSummarizer` | 以有界输入调用文本模型并解析结构化输出 | 执行工具、直接修改知识库 |
| `AssistantDatabase` | 事务、外键、分页、状态和来源定位持久化 | 生成模型内容 |
| `KnowledgeService` | 资料和本地知识条目的维护、检索及引用 | 管理监督者事件和关系 |
| Renderer | 展示和发起用户操作 | 访问 SQLite、决定权限或拼接 SQL |

## 2. 运行路径

应用启停遵守[逻辑规则](./logic-design.md#应用启停与执行)。`ApplicationSettingsStore` 对新设置及缺失的 `heartbeatEnabled` 使用 `false`，保留显式布尔值。Main 在心跳 tick 调用 `processDue()` 前、`heartbeatsRunNow` 与 `supervisionRun` IPC 入口、心跳完成后的监督回顾回调中读取已保存设置，只有值为 `true` 才继续。此检查不取消已领取运行，也不改变普通任务调度链路。Renderer 由 App 将同一启用状态传入 `RightAssistantSidebar`，控制监督面板挂载。

`HeartbeatCenter` 的五个顶层页签直接选择内容，无内部页签。overview 只由 `SupervisorWorkspace` 读取 `supervision.overview` 的统一结果，历史选择和图谱共享 resultId；新请求控件不改变所选结果的 scope/timeRange。`HeartbeatSections` 仅在 plans 输出内容，包含 `HeartbeatSettings`、范围与刷新、运行概览、指标、趋势、自动监督报告、记忆与行动建议及审计；activity 只渲染 `SupervisorActivity`，settings 只渲染两个算法参数表单。运行中的手动请求保留既有结果，活动入口清空计划筛选并聚焦 activity。计划列表放在当前状态下，复用唯一创建按钮及未配置说明。计划表单在原组件内通过 body Portal 显示，复用 `custom-task-dialog` 和 `activateModalFocus` / `trapTabFocus`，没有复制表单或嵌套 form。关闭确认、提交锁定及失败草稿由本地状态管理；保存继续调用 App 原有心跳 CRUD 回调。

计划“执行记录”将 `activityPlanId` 交给活动查询，并切换、聚焦 activity 页签。更换计划时清空旧列表、重置 offset 并清理旧轮询，保留筛选控件的键盘焦点；该筛选不传入自动监督概览，返回 plans 时仍显示全部计划的统计和心跳审计。报告展开和追加条数保存在同一组件内，切换顶层页签仍保留；图谱继续由 `SupervisorWorkspace` 持有结果选择，活动结果跳转保留精确 resultId。此次仅调整桌面 UI 和只读活动查询，不修改 schema、Agent 或远程 Runtime。

计划 CRUD 沿用 App → Preload → Main 接线。`heartbeatRecurrenceSchema` 与 `computeNextHeartbeatRun` 仅支持 daily/weekly；本轮不增加分钟间隔合同或调度分支。编辑草稿保存已有 `timezone` 和 `enabled`，新建仅在显式提交时使用本机时区创建启用计划。UI 命名统一为自动监督，内部 ID、翻译键、数据库及 IPC 名称保留。

手动回顾和心跳回顾必须经过同一个 `SupervisorService.run()`，只在触发来源上区分。这样可以保证两者使用相同的范围校验、输入预算、输出契约、结果状态和来源处理。

```mermaid
sequenceDiagram
    participant T as 手动/智能心跳
    participant S as SupervisorService
    participant D as AssistantDatabase
    participant C as EvidenceCollector
    participant M as 文本模型
    participant R as Renderer

    T->>S: run(scope, timeRange, trigger)
    S->>D: 创建 run，冻结范围与时间
    S->>C: collect(frozenScope)
    C-->>S: 有界证据 + source references
    S->>M: 结构化整理请求，禁止工具
    M-->>S: validated result
    S->>D: 事务写入 result、events、entities、relations、references
    D-->>S: completed
    S-->>R: 状态和定位信息
```

运行状态与内容确认状态分开保存：

- 当前监督运行状态：`running`、`paused`、`completed`、`failed`、`no_change`。心跳及合并活动的映射见[活动记录](./logic-design.md#活动记录)。
- 内容状态：来源事实、自动归纳、待核对、用户确认、用户修订、已移除关系。
- 运行成功只表示模型结果已按契约保存，不表示所有实体和关系已经被用户确认。
- 失败保留上次完整结果和本次已保存批次；暂停不生成完整结果，继续入口恢复同一 run。

## 3. 数据模型

首版使用现有 `AssistantDatabase` 和同一 SQLite 数据库。新增表保持领域对象独立，但不复制会话、笔记或知识库正文。

```mermaid
erDiagram
    supervision_runs ||--o{ supervision_results : produces
    supervision_results ||--o{ story_events : contains
    story_lines ||--o{ story_events : organizes
    story_lines }o--o{ knowledge_entities : references
    story_events }o--o{ knowledge_entities : changes
    knowledge_entities ||--o{ knowledge_relations : source
    knowledge_entities ||--o{ knowledge_relations : target
    supervision_results ||--o{ source_references : cites
    story_events ||--o{ source_references : cites
    knowledge_entities ||--o{ source_references : cites
    knowledge_relations ||--o{ source_references : cites
```

建议的最小持久化对象：

| 对象 | 关键字段 | 说明 |
| --- | --- | --- |
| `supervision_runs` | `id`, `trigger`, `scope_json`, `time_range_json`, `status`, `error`, `started_at`, `completed_at` | 一次手动或心跳整理；保存冻结范围，不从当前配置回推历史 |
| `supervision_results` | `id`, `run_id`, `summary`, `change_digest`, `coverage_json`, `graph_snapshot_json` | 工作回顾、监督反馈和图谱共同读取的结果版本 |
| `story_lines` | `id`, `scope_json`, `title`, `created_at`, `updated_at` | 用户选择的工作故事线，不等同于 Project |
| `story_events` | `id`, `story_line_id`, `result_id`, `occurred_at`, `title`, `description`, `event_type`, `confidence` | 时间轴上的事件；同日聚合只在查询或 UI 层处理 |
| `knowledge_entities` | `id`, `canonical_label`, `description`, `state`, `confirmation_state`, `updated_at` | 可被多条故事线引用的持续认识，不与知识库文档一一对应 |
| `entity_changes` | `event_id`, `entity_id`, `change_type`, `description`, `confirmation_state` | 表达提出、补充、验证和修订，避免覆盖实体正文 |
| `knowledge_relations` | `id`, `from_entity_id`, `to_entity_id`, `relation_type`, `reason`, `confirmation_state` | 关系独立拥有状态和来源；移除关系不删除来源 |
| `source_references` | `id`, `owner_type`, `owner_id`, `source_type`, `source_id`, `locator_json`, `availability` | 只保存来源标识和有界定位，不复制正文 |

外键和索引要求：

- 新增监督者对象使用 UUID；已有文本实体主键按上文兼容映射保留。实体、来源和关系通过稳定 ID 关联，不能只按名称合并。
- `supervision_runs` 按 `created_at`、`scope` 查询；事件按 `story_line_id, occurred_at` 查询。
- 关系对 `(from_entity_id, to_entity_id, relation_type)` 建唯一约束，允许同一实体对存在不同关系类型。
- 删除故事线只删除其组织关系，不删除共享实体、来源或知识库资料；删除知识库资料后来源标为不可用。
- 整理结果、实体变化、关系变化和来源引用在同一 SQLite 事务中提交，提交失败全部回滚。
- 只保存整理结果自身的对象内容与有界来源，不建立原会话、记忆或知识库的完整历史快照和独立向量索引。

叶子模型输出使用严格共享契约，包含 `events`、`entities`、`entityChanges`、`relations`、`summary`、`changeDigest`、`openItems`，事实项保留 `sourceReferenceIds`。Main 校验数量、字符、枚举、ID 所属范围和引用存在性，拒绝未知字段后才保存。导航输出另用[导航合同](./review-scheduling-design.md#已接入的调度与存储)，允许省略空事实数组；该规则不适用于叶子。

## 4. Main、IPC 与 Renderer

新增能力沿用现有边界：Renderer 只传业务输入，Main 重新校验项目、故事线、时间范围、来源和权限。

建议的 IPC 分组：

| 通道 | 用途 |
| --- | --- |
| `supervision:overview` | 工作回顾、运行状态、未解决事项和最近结果 |
| `supervision:run` | 手动开始一次整理，完成后返回包含 runId 的结果 |
| `supervision:activity` | 有界读取真实执行和阶段状态 |
| `supervision:graph` | 按故事线、时间区间和回放时刻分页读取图谱 |
| `supervision:object` | 读取事件、实体、关系及来源详情 |
| `supervision:confirm` | 确认、修订或移除自动关系和实体变化 |
| `supervision:continue-context` | 生成继续讨论前的上下文预览 |
| `supervision:knowledge-preview` | 预览新建或补充本地知识条目 |
| `supervision:knowledge-commit` | 用户确认后调用知识库服务写入 |

IPC 返回图谱查询结果时使用分页和有界字段；详情中的来源正文复用现有会话、笔记和知识库读取路径。不要把完整图谱一次性发送给 Renderer，也不要把模型原始输出暴露为可执行内容。

侧栏反馈通过已有应用状态刷新机制读取结果。首版可以在手动运行完成后主动刷新，心跳完成后发布一个不含私人正文的变更通知，Renderer 再按权限读取摘要；不新增系统通知正文通道。

## 5. 安全与一致性

- 监督者模型调用固定为 `ask` 语义，输入来自 `EvidenceCollector` 的有界快照，工具授权始终拒绝。
- `Global`、Project、多项目和固定 Conversation/Task/Experiment 目标在 Main 冻结；模型不能生成或改变范围。
- 每个来源引用必须属于本次冻结范围，跨范围引用、伪造项目 ID 和不存在的来源 ID 直接使结果失败。
- 心跳运行沿用现有 `heartbeat_runs` 的领取、租约和重试机制；新增监督运行按心跳运行 ID 关联，活动据此合并阶段。没有新增取消协议。
- 同一配置同时触发手动和定时运行时，沿用现有幂等键和运行领取规则；已完成结果不能重复写入。
- 用户确认或修订后的实体、关系不被后续整理静默覆盖；新证据以补充或冲突待核对状态写入。
- 外部知识库只读。图谱可以引用保存到本地的外部片段和定位信息，不调用远端写入、不承诺打开远端原文。
- 来源正文仍由原应用拥有。监督者删除关系、故事线或运行记录时不得删除会话、笔记、任务或知识库资料。

## 6. 实施顺序

### 阶段 A：先把现有心跳变成统一运行入口

- 抽出 `HeartbeatSummarizer` 的有界输入和结构化输出校验，使 `SupervisorService` 可以复用。
- 增加手动运行的统一服务入口，但先只生成现有回顾结果，不改变心跳页面行为。
- 为运行状态、范围冻结、失败保留旧结果补充 Main 单元测试。

### 阶段 B：接入证据引用和阶段回顾

- 实现 `EvidenceCollector`，接入会话、任务、消息已有知识引用和记忆；魔法笔记仍未接入。
- 建立 `supervision_runs`、`supervision_results` 和 `supervision_sources`，保存来源 locator，并通过 `KnowledgeService` 解析本地文档/分块。
- 在现有智能心跳页面增加监督者工作回顾入口；不先改应用名称和导航 ID。

### 阶段 C：实现最小故事线图谱

- 建立事件、实体、实体变化和关系表及查询服务。
- 先完成平铺环绕时间轴、节点详情、来源展开、回放和列表模式；圆形视图继续作为后续布局。
- 同一实体通过稳定 ID 连接多个事件，禁止按每次事件复制实体。
- 用真实整理结果替换 Demo 的模拟数据，并保留 Demo 作为视觉回归 fixture。

### 阶段 D：接入用户确认和知识库双向定位

- 增加关系确认、修订、撤销和实体拆分的最小交互。
- 从图谱返回本地会话资料及引用位置；知识库文档定位依赖来源中存在文档/分块元数据。
- 新建或补充本地条目必须经过预览和确认；外部知识库保持只读。

### 阶段 E：侧栏反馈与增量整理

- 将结果摘要投影到现有右侧助手栏，并沿用当前会话生命周期。
- 心跳只负责触发，监督者根据新证据决定有无变化和是否反馈。
- 在运行去重、用户修订保护和来源失效提示稳定后，再评估更复杂的跨目标固定策略、事件唤醒和自动阶段识别。

## 7. 验证策略

首版每层验证一条可追踪链路：

1. `EvidenceCollector` 测试范围裁剪、字符预算、来源定位和不可用来源。
2. `SupervisorService` 测试模型输出解析、引用完整性、重复运行、取消、失败和部分结果。
3. `AssistantDatabase` 测试迁移、事务回滚、外键、分页、关系移除不删来源。
4. IPC 测试不可信输入、越权 Project/Source ID、确认状态和知识库写入前置预览。
5. Renderer 测试从反馈进入图谱、点击实体高亮多个时间点、回放不显示未来结果，以及窄屏列表访问。
6. 使用一组固定脱敏 fixture 验证“监督反馈 → 实体 → 多个事件 → 来源 → 继续讨论”的完整路径。

首个生产验收不要求模型自动发现所有关系。必须先证明来源可追溯、失败可解释、用户修订不会丢失，以及图谱与工作回顾读取同一结果。

## 8. 暂不实现的内容

- 独立的图数据库、向量图谱或新的知识库正文存储。
- 让监督者拥有通用 Agent 工具执行能力。
- 自动把所有聊天消息变成事件或节点。
- 无依据的实体自动合并、旧观点自动失效和静默覆盖用户确认。
- 应用市场建设作为监督者开发前置依赖。
- 在没有增量和去重证据前实现事件触发、自动阶段识别和全量后台重算。

## 当前剩余差距

- 实体与关系 revoke 保存状态；界面没有 undo 或恢复入口。
- 跨 run identity 依赖同 scope 候选 UUID 的显式引用，不自动合并历史重复实体；模型漏选候选时会创建新身份。
- 结果图谱使用真实事件实体连线，侧栏已按固定目标过滤并支持结果直达图谱；逐事件状态回放和 Experiment 尚未实现。
- 用户暂停已接到排队/在途 signal，并保留已保存批次；源版本变更后的局部重算、完整模型配置冻结及其他限制见分块调度第 0 节。
- 监督知识实体与知识库正文条目仍是不同对象，知识正文只能通过现有条目定位和预览接口处理。
