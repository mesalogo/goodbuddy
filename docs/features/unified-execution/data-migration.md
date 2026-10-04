# 统一执行的数据迁移设计

状态：桌面主库 schema 60 与 Runtime 设置版本 22 已实现并通过合成回归；真实旧库验证尚未开展。更新日期：2026-10-04。
本文负责旧工作模式与 `toolApproval` 数据的删除规则、升级入口、内容保留和迁移验证。
执行行为见[逻辑设计](./logic-design.md)，模块改造见[技术设计](./technical-design.md)，
用户验收见[用户故事](./user-stories.md)，实施与验证证据见[进度](./progress.md)。
数据库操作遵循[数据库迁移与大数据升级指南](../../development/database-migrations.md)。

## 1. 范围与审计基线

用户已批准全局移除 Ask/Execute、“安全”设置分类及 `toolApproval` 策略，包括界面、运行逻辑、原生工具清单和历史字段。
升级后的业务合同与持久化数据不保留固定 `execute`、默认模式或等价占位字段。
迁移删除工作模式元数据，保留消息、任务、成果、附件、执行记录及其引用关系。
旧记录所表示的执行事实不得因删除模式字段而被改写为一次新的执行。

审计对象为存在并发修改的工作树，数据库、IPC、Runtime 和 Renderer 文件均有未提交变化。
下列链接定位源码文件和函数职责，不代表冻结提交；实施前须复核最终合并后的定义。
审计与本次验证未打开用户生产数据库；转换证据来自合成夹具，未统计真实历史记录中各形状的数量。

[共享合同](../../../src/shared/assistant-contracts.ts)已删除工作模式类型与 schema。
历史数据可能包含 `ask`、`plan`、`execute`；迁移按字段归属删除，不按属性值筛选。
不得把历史 `plan` 转成 `ask` 或 `execute` 后永久保留。
`continueMode` 的 `chat/agent`、子代理 `routingMode`、知识检索模式、知识图谱策略中的
`ask` 和文档云解析许可均有独立含义，不按名称或字符串批量删除。
`toolApproval` 虽不属于工作模式字段，已由用户明确纳入移除范围，按第 5 节定向迁移。

## 2. 已核实的桌面持久化路径

桌面主库为 `userData/assistant.sqlite`，路径由 [Main 入口](../../../src/main/index.ts)装配。
下表引用的 `DB` 指 [AssistantDatabase](../../../src/main/assistant/assistant-database.ts)。
JSON 路径只表示已核实的应用自有字段，不授权递归删除同名用户数据。

| 表、列或 JSON 路径 | 写入、读取入口 | 设计转换 |
| --- | --- | --- |
| `projects.default_work_mode` | DB 项目创建、更新、通道项目与远程项目保存；项目行投影 | 删除列及其约束，覆盖归档、默认、通道和 SSH 项目 |
| `conversations.work_mode` | 旧版 DB 对话替换、局部保存、分支、通道及定时对话创建 | schema 60 删除列及其约束，新写入不再携带模式 |
| `conversations.context_state_json` 的 `$.workMode` | DB `serializeConversationContextState`、`parseConversationContextState`、`toConversationSnapshot` | 仅删除该属性，保留知识范围、检索设置、图谱开关、指标与压缩状态 |
| `tasks.work_mode` | DB `createTask`、任务投影、定时任务、内部任务与 `listRecoverableRemoteTasks` | 删除列；同步取消远程恢复对模式值的要求 |
| `schedules.task_template_json` 的 `$.workMode` | DB 定时任务创建、`toSchedule`；IPC 定时派发 | 删除属性，保留提示词、标题、历史 Runtime 选择和调度配置 |
| `conversation_queue_items.payload_json` 的 `$.input.workMode` | IPC 入队写入 `{input, serializedContexts}`；DB 保存和领取 | 删除请求属性，保留队列状态、顺序与附件上下文 |
| 同列旧格式的 `$.workMode` | IPC `parseConversationQueueUserPayload` 兼容裸请求 | 在严格合同校验前转换旧格式，不能漏掉未包装请求 |
| `task_events.payload_json` 的 `$.workMode` | DB 初始任务事件、`appendTaskEvent`、远程事件插入 | 删除生命周期和子代理事件自有属性，保留事件行 |
| `messages.metadata_json` 的 `$.subagents[*].workMode` | Renderer 子代理事件投影、消息保存；DB 恢复投影和读取 | 删除数组成员的模式属性，保留身份、路由、过程、输出和错误 |
| `activity_history_records.record_json` 的 `$.detail` | Renderer 生成子代理活动说明；ActivityHistoryRepository 保存和分页读取 | 仅处理可确认来源的生成式模式标签，规则见第 6 节 |

旧版对话模式存在 SQL 列和上下文 JSON 两份表示；schema 60 同时删除两处字段。
定时执行的任务列和模板 JSON 也分别清理。
`schedule_runs` 保留触发时间、任务引用与执行状态，不因本次转换重建发生记录。
定时队列当前保存 `{}` 并引用任务和计划，不需要为其新增请求快照。

具体写入边界包括 [IPC](../../../src/main/ipc.ts) 的 `parseConversationQueueUserPayload`
及入队处理、[对话保存](../../../src/renderer/src/conversation-persistence.ts) 的
`toLocalConversationHeader`、`toConversationMessage`，以及
[事件处理](../../../src/renderer/src/agent-event-handler.ts)中的子代理投影。
[附件上下文](../../../src/main/context-manager.ts)的 `serializeForQueue` 保存附件内容；
`serializedContexts` 不属于模式字段，须原样保留其语义和附件引用。

## 3. Schema 与启动升级顺序

实施前确认 `ASSISTANT_DATABASE_SCHEMA_VERSION = 59`，末次迁移增加执行计时结构。
本次新增 schema 60，覆盖 schema 59 的已升级用户与通过历史迁移链升级的旧库。
DB `migrate` 已拒绝高于客户端支持版本的数据库；保留此行为，不回写版本号支持降级。

升级复用 [prepareAssistantStorage](../../../src/main/assistant-storage-startup.ts)、
[assistant-storage-worker](../../../src/main/assistant-storage-worker.ts)和
[assistant-storage-upgrade](../../../src/main/assistant/assistant-storage-upgrade.ts)。
启动顺序要求如下；主库转换由 `AssistantDatabase.migrate` 的版本 60 分支执行：

1. 先修改新写入、读取、IPC 和 Runtime 合同，使新请求不生成工作模式字段。
2. 启动时只读检查 schema 和待转换内容，确认升级需求后进入现有升级页面与 Worker。
3. 在业务连接、恢复处理、队列消费和调度启动之前，完成必要的既有版本迁移。
4. 按已核实路径分批转换历史 JSON，提交一批后报告进度；同一转换规则用于导入与重放。
5. 在 SQLite 事务中删除模式列及约束；全部所需转换完成后提交目标 `user_version`。
6. 通过完整性检查和目标内容检查后，开放正常业务入口；失败则保持升级失败页面。

旧迁移 22、25 等仍读取或写入模式字段，须在最终删除之前完成。
实现保留历史迁移链，仅将历史模式类型与归一化表达式留在旧迁移内部。
schema 60 在启动恢复解析消息之前完成，避免严格子代理合同拒绝尚未转换的旧对象。

转换依次扫描对话上下文、计划模板、队列、任务事件、消息元数据，每批最多 32 行，
按 `rowid` 有界读取。每批独立提交后报告进度；没有目标字段的 JSON 保留原始字符串。
只删除表中列明的路径，保留相邻未知属性和嵌套工具参数。无效 JSON、非对象元数据、
非对象队列 `input` 或无效子代理数组使当前批次回滚；错误只包含表、列和行号。
先前批次可以保留，重试重新扫描并跳过已清理数据，不需要额外进度表。

最后在同一事务内执行三个 `ALTER TABLE ... DROP COLUMN` 并提交 `user_version = 60`。
取消或转换失败时仍保留旧版本和模式列，业务恢复不会提前开始。本次迁移不请求空间回收。

优先使用 SQLite 支持的删除列操作，并核对约束、索引和依赖。
确有依赖阻止删除时，仅重建受影响表，保留外键、索引及业务使用的行顺序。
不重建全部用户数据，不通过导出当前 DTO 再导入的方式替换原库。
迁移不新增通用框架、持久化阶段日志、收据、影子快照或回滚引擎。
重试根据已提交数据和缺省字段继续；退出或失败至少回滚未提交批次。

大表转换使用有界批次和缓存，不在 Main 或 Renderer 同步扫描全库。
保留事务、同步落盘与 checkpoint；不为提速关闭约束。
模式字段删除不自动触发 `VACUUM`，空间回收须另有实际旧内容转换与测量依据。
重启后不能仅凭空闲页再次整理或回收，也不承诺磁盘上旧字节的取证级擦除。

## 4. 旧版导入、事件重放与内容保留

[App](../../../src/renderer/src/App.tsx)仍读取 `goodbuddy.conversations.v1`，
其已核实目标为 `$[*].workMode` 和 `$[*].messages[*].subagents[*].workMode`。
在快照校验和写入前应用转换，仅在内容成功持久化后移除该 localStorage 项。
不得清空全部 localStorage；布局、主题、语言和其他草稿不属于本次迁移。
现有导入具有长度、数量及重复 ID 处理规则，验收须核对被跳过的数据，不能只比成功行数。

[activity-store](../../../src/renderer/src/activity-store.ts)读取
`goodbuddy.activity-records.v1`，通过 `queueLegacyMigration` 写回 SQLite。
该入口也须采用第 6 节标签规则，防止升级后导入重新带回旧标签。
从旧活动 schema 升级时，先完成既有记录格式转换，再处理目标字段。

[子代理过程存储](../../../src/main/assistant/subagent-progress-storage.ts)保存累计或差量过程。
`compactSubagentPayload` 和 `restoreSubagentPayload` 会保留其他事件属性，
因此差量压缩不会自动删除 `workMode`；转换须保持过程可还原，不丢块、不重排。
DB `insertRemoteTaskEventOnce` 比较原 JSON 或还原后的子代理载荷。
历史删除和新到达的旧格式事件须采用相同定向规范化，再进行去重、比较和插入。
已实现的 DB 事件写入在序列化、子代理压缩和远程去重比较前删除顶层 `workMode`，
与版本 60 的清理范围一致。正文、过程块及其嵌套属性不参与字段删除。
保留 `remote_binding_id`、`remote_operation_id`、`remote_semantic_sequence`、
`remote_event_index`，不能将合法重放误判为冲突或再次生成任务与消息。

转换保留稳定 ID、顺序、创建及完成时间、任务父子关系、状态、错误和恢复游标。
提示词、正文、推理、工具参数与输出、成果、附件及未知相邻属性不因清理模式而删除。
对于应由应用解析的 JSON，若语法或必要结构损坏，须停止相关迁移并显示可重试的失败。
保留损坏源记录，日志仅记录定位信息和统计，不输出正文；不得统一替换为 `{}` 或删行。
仅含合法模式属性的事件在删除属性后可以成为 `{}`，此情况与损坏数据恢复必须区分。

## 5. Agent、协议和设置

以下为已核实的 Agent 存储结构，实际旧载荷形状仍按第 7 节补证据。
[runtime-composition](../../../src/agent-daemon/runtime-composition.ts)装配运行与语义库，
[daemon](../../../src/agent-daemon/daemon.ts)装配 `journal/events.sqlite`。

| 文件或表 | 已核实表示、写读与现有入口 | 设计要求 |
| --- | --- | --- |
| `semantic-prompts.sqlite` 的 `semantic_prompt_operations` | `prepare` 保存并比较 `preparation_digest`，未存完整准备请求 | 保留摘要和操作身份，不能从缺失的准备信息重算历史摘要 |
| 同库 `semantic_prompt_events.payload_json` | `append`、`page` 保存与读取通用语义事件 | 只转换经证明属于模式元数据的路径，保持序号与 ACK，字节变化时同步计数 |
| `journal/events.sqlite` 的 `journal_events.payload`、`acp_frames.payload` | BLOB 原始载荷；追加按字节比较，重放读取原字节；有 usage 修复入口 | 不当作普通 JSON 递归清理，保持流、epoch、序号、终态与字节统计一致 |
| `runtime-owners.sqlite` 的 `active_runtime_owners.process_identity_json` | RuntimeOwnerRegistry 保存进程身份并有旧记录修复入口 | 未发现模式字段，保留归属和进程清理依据 |
| `model-calls.sqlite` 的 `agent_model_calls` | AgentModelCallLedger 保存调用摘要、派发与交付状态 | 未发现模式列，不清空防重复派发记录 |
| 桌面 `runtime_session_bindings.binding_json` | SqliteRuntimeSessionBindingStore 按严格合同写读完整 binding | 合同未含 `workMode`，保留会话身份与恢复游标 |
| `agent-diagnostics.jsonl` 及轮转文件 | formatVersion 1 的每行顶层 `$.workMode`；日志写入、读取与轮转 | 停止新增字段，在无并发写入和轮转时定向删除历史顶层属性 |

源码分别见 [SemanticPromptStore](../../../src/agent-daemon/semantic-prompt-store.ts)、
[EventJournal](../../../src/agent-daemon/event-journal.ts)、
[RuntimeOwnerRegistry](../../../src/agent-daemon/runtime-owner-registry.ts)、
[AgentModelCallLedger](../../../src/agent-daemon/agent-model-gateway.ts)、
[binding 存储](../../../src/main/agent/runtime-session-binding-store.ts)和
[诊断日志](../../../src/agent-daemon/diagnostic-log.ts)。诊断记录的时间、事件、结果和错误码须保留。
这些 SQLite 存储当前未设置 `user_version`，新库保持默认 0；实际旧文件版本尚未读取。
不能假定桌面 schema 升级覆盖 Agent，也不能直接套用桌面版本号。
确需转换已发布 Agent 数据时，在现有构造或启动入口安排事务与版本检查，避免旧进程并发打开。
仅分支内未发布、可重建的内部记录可按既有清理逻辑处理，不据此删除用户历史或未确认结果。

[Agent 协议](../../../src/shared/agent-protocol/contracts.ts)观察版本为 2.0。
[远程合同](../../../src/shared/remote-agent-contracts.ts)的 preparation、acceptance 必填 `workMode`，
[启动合同](../../../src/shared/remote-runtime-launch-contracts.ts)也携带该字段。
[runtime-acp-backend](../../../src/agent-daemon/runtime-acp-backend.ts)对准备请求求摘要并检查重复操作。
删除字段改变严格合同和摘要输入，桌面、Agent、helper 与运行包必须按现有兼容机制协同升级。
旧操作保留原摘要用于身份判断，不把新请求套入旧 operation ID，也不伪造摘要迁移。
新旧协议组合的拒绝或升级路径须明确，不能靠永久发送 `execute` 维持假兼容。
[远程委派](../../../src/main/assistant/remote-delegation-service.ts)另有必填 `workMode: ask` 外部合同，
须协调服务端；其结果 outbox 不等于输入任务快照，不能混同迁移。

设置审计版本为 Runtime 21、应用 12、通道 3、Runtime 扩展状态 2。
见 [Runtime 设置](../../../src/main/runtime-settings-store.ts)、[应用设置](../../../src/main/application-settings-store.ts)、
[通道设置](../../../src/main/channels/channel-settings-store.ts)和[扩展存储](../../../src/main/agent/runtime-extension-store.ts)。
这些已声明结构及凭据载荷未发现工作模式字段；项目默认模式实际位于主库。
但 Runtime 设置明确持久化顶层 `toolApproval`，本次必须升级其设置版本并清理磁盘文件，不能仅在读取时忽略字段。

Runtime 设置已升级到版本 22。版本 1 至 21 的历史 schema 继续读取旧策略，迁移终点删除顶层 `toolApproval`，覆盖 `always/session/workspace/policy`。这些历史 schema 原本要求该属性存在，本次不新增缺省策略。新默认值、读取投影、更新合同及保存路径均不再生成该字段；`getPolicySettings` 仅保留智能路由开关。

复用现有设置加载与保存入口，保留其他设置及加密凭据的原字节，不为删除策略解密再加密凭据。验证旧版本加载、新版本落盘、再次保存和重启均不会恢复字段；失败沿用既有可见错误与重试机制，不重置整份设置。应用、通道与 Runtime 扩展设置未发现本次目标字段，不因此提升它们的版本。“清除本地数据”仅移动界面入口，不在升级中触发数据清除。
加载旧版本后通过现有原子写入保存版本 22，不等待用户再次保存设置。写入失败向调用方报告，
落盘成功后才发布内存缓存，以便下次读取重试，不把写入故障当作文件损坏而隔离原件。
已为版本 22 的文件不会仅因读取而重写。
用户自定义请求体、MCP 配置中的同名字段不属于应用模式元数据。

## 6. 原生工具、生成文件与历史标签

[原生工具合同](../../../src/shared/runtime-customization-contracts.ts)已删除 `tools[*].ask/execute`，
能力合同也已删除 `availableIn` 模式列表。Runtime 清单生成与
[清单 UI](../../../src/renderer/src/RuntimeCustomizationSection.tsx)的配套改造由各模块负责。
[native-terminal-client](../../../src/main/agent/native-terminal-client.ts)生成模式插件和启动权限参数，
[DS Web 策略](../../../src/main/agent/native-dsh-web-policy.ts)生成 `config.workMode`，
[DS Web 启动器](../../../src/main/agent/native-dsh-web-client.ts)写入 `goodbuddy-mode.mjs`、`cordis.patch.yml`。
删除或重生成应用自有启动材料，保留原生历史、用户 profile 和工作区文件。
Harness 的 `params.mode`、ACP 模式列表和注入提示词属于同一旧概念，不能因字段名不同遗漏；
见 [Harness 控制面](../../../src/main/agent/goodbuddy-harness-control-plane.ts)。
通道 `/ask`、`/execute` 等前缀的行为改造见逻辑设计，历史消息正文不回写。

活动 `detail` 将来源、模式、原因和错误拼成文本，缺少独立模式槽位。
只在记录种类、关联子任务和已知生成格式足以确认时删除对应标签片段。
不得全局替换正文中的 Ask、Execute 或 plan，不得删除用户原因、错误原文及工具输出。
无法区分生成标签与用户内容的旧记录须保留源文本并列入待核验项，不能宣称已清除。

## 7. 历史证据缺口与待验收项

`runs.execution_snapshot_json`、`runs.checkpoint_json` 已确认建表，未找到当前生产写读函数。
其历史 JSON 路径须从已发布夹具或真实旧行核实，不预设 `$.request.workMode` 等嵌套结构。
源码未发现独立 `jobs` 模式表，现有后台执行使用 tasks、schedules、runs 和队列表示。
Agent 不透明载荷、原生 Runtime 自有历史中的模式表示及已发布协议组合仍待取样验证。
摘要本身无法反推出原字段；没有证据时不新增“兼容快照”补造历史。

真实旧库验证尚未开展，以下要求仍须在真实样本和完整产品路径中验收：

- 在应用关闭或 SQLite 一致性备份条件下制作独立副本，记录 WAL、大小、源版本和校验值。
- 覆盖新库、观察版本 59、旧版 `plan`、schema 34/35 子代理过程及活动记录旧结构。
- 覆盖归档对话、内部任务、禁用计划、队列两种格式、附件、localStorage 导入及重复 ID。
- 比较迁移前后用户内容、稳定 ID、顺序、时间、引用和远程来源；差异仅限确认的模式元数据。
- 覆盖 Runtime 设置版本 21 及更早支持版本的旧策略值；版本 21 的差异仅限设置版本和顶层 `toolApproval`，其他设置及加密凭据字节保持不变。更早版本仍执行各自已有迁移。
- 验证损坏 JSON 可见失败、事务回滚、退出续跑、同次启动重试、再次启动和旧客户端拒绝打开。
- 验证远程未 ACK 重放不冲突、不重复执行；原生工具界面和新生成文件不再携带模式。
- 运行完整性检查并记录耗时、内存、主库与 WAL 大小；不要以行数相同替代内容核对。
- 实施后执行仓库要求的测试、类型检查、lint 与受影响的真实 Agent 路径验证。

测试命令、样本版本、失败记录及未解决的数据形状写入进度文档；设计审查通过不等于迁移完成。

## 8. 本地存储验证

2026-10-04，Windows 本地执行：

```text
npx vitest run src/shared src/main/assistant/assistant-database.test.ts src/main/assistant/assistant-storage-upgrade.test.ts src/main/assistant/assistant-execution-stats.test.ts src/main/assistant/heartbeat-database.test.ts src/main/runtime-settings-store.test.ts
```

44 个文件、538 项通过。新增 schema 59 夹具覆盖 `ask`、`execute`、`plan` 和缺省 JSON 字段，
检查三列删除、队列两种格式、子代理消息、计划时间、用户文本及嵌套同名字段保留。
远程事件的行号、来源身份和序号保持不变，旧格式重放返回已存在而不重复插入。
另有 70 行事件夹具验证已提交批次的取消续跑、损坏 JSON 的批次回滚、源记录保留和修复后重试。
迁移后执行 `integrity_check` 与 `foreign_key_check`；重复打开不再触发升级。

版本 21 设置的四种策略夹具检查迁移前后完整对象，仅允许版本号和顶层策略变化。
通过加解密调用监测确认读取智能路由设置并落盘升级时没有处理凭据明文，
请求体内的同名用户字段保持原样。写入失败夹具确认源文件保留，下一次读取重新升级。
历史版本的既有回归继续执行，执行计时与心跳持久化夹具也已适配无模式合同。
本次修改文件的 ESLint 与 `git diff --check` 通过；Node 类型检查仍有其他模块的旧字段调用错误，
本次负责的共享合同、主库与设置文件没有类型诊断。完整应用类型检查仍待并发改造合并后验收。
这些证据不覆盖用户生产库、Renderer 导入、活动标签清理或真实 Agent Host。
