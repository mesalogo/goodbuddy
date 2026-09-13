# 知识库实施进度

## 已验证实现

截至 2026-09-05 的本地知识库验证记录如下。外部知识库当前实现和验证范围见后文
2026-09-13 记录。

- 知识库选择按 Conversation 持久化，新对话默认空范围。
- 创建流程默认只展示名称和描述，高级存储与图谱设置折叠。
- 知识库汇总区分可检索、处理中和需处理文档。
- 文档行展示全文、向量和图谱状态，并支持打开原始来源和重新处理失败文档。
- 移除来源需要确认并说明级联影响。
- 检索高级参数默认折叠，“高级设置”提供问答效果入口。
- 向量未配置状态可直接前往模型设置。
- 有效 DOCX 与多页 PDF 已通过磁盘文件导入、解析、分块和检索生产链路。

## 验证证据

### 2026-09-13 知识库布局与自动名称修复

- 创建类型的共享分段控件被长表单压缩，修复共享不收缩规则，不添加页面专属高度。
  长名称卡片增加零最小宽度的 Grid 轨道，名称单行省略、图标保持 15px；详情名称允许换行。
  合成长名称实测列表横向溢出为 0；详情修复前溢出 658px，修复后为 0。
- 连续选择两个目录项时，未修改过的自动名称原先停留在第一个目标。回归先失败再修复，
  现在跟随选择，手动名称和已保存名称不自动覆盖。规则见
  [创建与编辑](./external-knowledge-logic-design.md#5-创建与编辑)。
- 当前完整 App 的真实 UI → Preload → Main → SQLite 路径完成实例保存、两个目录项
  切换、零结果检索后添加绑定、详情展示和配置草稿保留。上游是 loopback Dify 合成服务，
  不是真实知识平台；没有调用模型，也不能据此声称真实检索质量或远端验收。
- 本轮合成服务共收到 8 次请求：1 次初始目录、2 次初始详情、2 次检索（测试与保存）、
  2 次后续详情、1 次后续目录；真实模型和真实知识服务请求均为 0。
- 创建类型在浅深主题、目标 1280×800、960×720、720×640、640×420 的八组尺寸中
  检查控件高度至少 34px，并保存 PNG。实际审阅浅色 1280、深色 640 及最终添加后的
  长名称详情 PNG，确认 Tab 不再成为窄缝，卡片边框和图标完整，详情无横向滚动条。
- 同期修复和通用验证结果见[工作栏进度](../assistant-workbar/progress.md#2026-09-13-原生浏览器与应用浮层修复)。
  临时脚本与合成 profile 在提交后清理，不把它们作为长期依赖；用户在另一测试窗口
  手工创建的实例与绑定不属于本轮合成数据，不随清理删除。

### 2026-09-13 检索路径与绑定查询简化

对 `3b560c9..ca4a58c` 的复查发现三处与本功能相关的实现问题，已按 KISS 与性能优先修正：

| 修正项 | 修正前行为 | 修正后行为 |
| --- | --- | --- |
| 生产检索入口 | 对话检索复用 `testRetrieval`，把用户问题传入 `testQuery`，并对 RAGFlow 额外发一次 detail 请求 | 新增 `ExternalKnowledgeService.retrieve` 作为生产路径，只发一次检索请求；能力预检仅保留在 `testRetrieval` |
| 配置变更检测 | 5 处 `JSON.stringify` 前后快照对比，抛出 `EXTERNAL_KB_CONFIG_CHANGED` | 全部删除，改由既有 `AbortController` 取消覆盖；被取消的探测抛 `EXTERNAL_KB_CANCELLED` 且不写回探测结果 |
| 绑定查询 | `requireLibrary`（30+ 调用点，其中一处在循环内）与 `getKnowledgeSnapshot` 每次全表 `listBindings()` | 新增 `getBinding`/`hasBinding`/`getBindingsForInstance` 主键查询；快照改为单次 `Map` 构建 |

修正过程中被测试拦下两次行为回退，已记录为当前不变量：

- 被取消的连接测试必须抛出且不写回 `probeStatus`，不能记为 `failed`；用户停用实例不等于探测失败。
- `testRetrieval` 的 RAGFlow 能力预检必须与检索共用绑定配置的 `requestTimeoutMs`，不能各自计时。

同时删除确认无生产引用的死代码：`probeStatus` 的 `'healthy'` 取值、`external.transportConfirm`
与 `external.states` 的 `remote-missing`/`config-invalid` 文案、`KnowledgeService.searchHybridMany`、
`ExternalKnowledgeRemoteResult.sourceUrl`。`externalKnowledgeLocatorSchema` 的 `sourceUrl`
保留，因为它解析已持久化的引用数据。

| 验证 | 结果 |
| --- | --- |
| `npx vitest run src/main/knowledge src/main/agent/knowledge-mcp-gateway.test.ts` | 21 个文件通过、1 个跳过；288 项通过、1 项跳过 |
| `npm test` | 348 个文件通过、9 个跳过；4,088 项通过、66 项跳过 |
| `npm run typecheck`、`npm run lint` | 通过 |

`npm test` 的唯一失败为 `src/main/agent/opencode-runtime-lifecycle.test.ts:120`
（"Matcher did not succeed in time"）。已用 `git stash` 在同一 `HEAD` 上复现同样失败，
确认早于本次修正且与知识库无关，未计入上表。

### 2026-09-13 当前工作区实现与分组验证

三家 Provider 已通过生产服务、本机 HTTP MCP 与生产 IPC 的短答案生成检查，Dify 另已
从完整 App 输入区完成真实回答和引用点击。后续 UI 修正后的聚焦测试、全量回归、类型
检查、lint、工作区及暂存区 diff 检查均已通过；下表区分早期结果与最终结果。

| 需求范围 | 当前代码落点与行为 |
| --- | --- |
| `EK-FR-01` 至 `EK-FR-05` | `ExternalKnowledgeService`、`ExternalKnowledgeStore`、数据库 v12 迁移和类型化 IPC 已接入；支持加密保存实例、启停、目录分页、详情和手工 ID 检索验证 |
| `EK-FR-06` 至 `EK-FR-10` | `ExternalKnowledge.tsx` 与 `KnowledgeWorkspace.tsx` 已提供四种创建类型、两栏绑定表单、Provider 配置、统一列表和外部详情；参数只保存在本地绑定 |
| `EK-FR-11` 至 `EK-FR-14` | `KnowledgeService.retrieve` 按绑定分派；`retrieveMany` 已供聊天预检索和 MCP 搜索使用；外部定位、逐库失败和历史引用已接入共享契约与会话持久化 |
| `EK-FR-15`、`EK-FR-16` | 实例引用保护、本地移除确认、固定只读端点和有界请求已实现；传输与交互的实际限制见技术、UI 设计，不能视为原草案全部验收项已满足 |

实施代理与 owner 回报的测试记录如下，本轮文档核对没有重新执行这些测试：

| 分组 | 回报结果 | 证据边界 |
| --- | --- | --- |
| Client | 35 项测试通过 | 包含 FastGPT 响应包装、数组评分及取消等客户端契约修正 |
| Service 组 | 96 项测试通过 | 服务及关联集成分组结果，不单独推断每个文件的测试数量 |
| UI 组 | 107 项测试通过 | 组件及关联界面分组结果，不能替代 Electron 桌面操作验收 |
| 后续集成组 | 11 个 suite、403 项通过 | 后于上述分组；不与早期计数相加 |
| 中间全量测试 | 4,021 项通过、4 项失败、66 项跳过 | 历史结果；原失败已修正，最终回归通过 |
| 中间 App + Citation | 216 项通过、2 项失败 | 历史结果；原生控件测试交互已修正 |
| UI 复验前完整 App 测试 | 215 项通过 | owner 回报，覆盖整个 App 测试文件 |
| UI 复验前全量回归 | 347 个文件通过、9 个文件跳过；4,039 项通过、66 项跳过 | `npm test -- --maxWorkers=1 --reporter=verbose`；退出码 0，Vitest 耗时 677.40 秒 |
| UI 复验前类型检查 | 通过 | 当时最后代码修改后执行 `npm run typecheck`，owner 回报 |
| UI 复验前 lint | 通过 | 当时最后代码修改后执行 `npm run lint`，owner 回报 |
| UI 复验前 diff 检查 | 通过 | 当时最后代码修改后检查通过，owner 回报 |
| 最终聚焦测试 | 245 项通过 | 完整 App 与两个 Agent 测试文件，owner 回报 |
| 当前 UI 修正后最终全量回归 | 349 个文件通过、9 个文件跳过；4,081 项通过、66 项跳过 | `npm test -- --maxWorkers=1 --reporter=verbose`；退出码 0，Vitest 耗时 598.33 秒 |
| 最终类型检查与 lint | 通过 | `npm run typecheck`、`npm run lint`，owner 回报 |
| 最终工作区与暂存区 diff 检查 | 通过 | owner 回报；本轮另检查文档 diff |

各次测试覆盖有重叠，不合并为去重后的全仓总数。后续源码已确认 `retrieveMany` 按 rank
跨库轮转分配预算；App 引用事件使用共享 `knowledgeReferenceKey`，保留远端 ID 不同的
引用并去除重复项；引用弹窗的定位只显示一次。

UI 复验前全量证据来自临时目录中的 `goodbuddy-native-controls-fix-full.log` 和
`goodbuddy-native-controls-fix-full.result.json`，日志汇总与结果文件退出码已核对。
owner 确认 `App.tsx`、`App.test.tsx` 的哈希在整轮运行期间保持不变，最后代码修改后的
类型检查、lint 和 diff 检查均通过。之后用户要求重新检查 UI 并执行真实模型与知识库验证，
外部界面又有修改，因此该通过记录不自动覆盖当前源码。

原失败涉及 Preload 测试顺序沿用旧计数、原生选项控件的延迟焦点交互，以及并发导航；
相应修正已完成，并发导航由协作代理处理。引用去重与重复定位修正也已纳入最终回归。
精确自动测试计数仅在本文维护，其他设计文档和脱敏摘要引用本记录。

当前最终全量证据为 `goodbuddy-binding-selector-fix-full.log` 和
`goodbuddy-binding-selector-fix-full.result.json`，日志汇总和退出码已核对。最后一项 App
测试修正把旧原生 Select 操作改为实际富信息菜单的可访问交互，没有修改产品源码。
其他 Agent 测试失败由并发 owner 在其最新代码中解决，本轮未修改这些文件。
owner 确认 App 测试、两个 Agent 测试和 `ExternalKnowledge` 在整轮执行期间保持稳定，
不再追加源码修改。当前通过结果已覆盖后续 UI 版本，早期结果继续作为历史记录保留。

### 2026-09-13 生产服务与桌面验证

已读取脱敏的 `kb-strict-validation/report.json` 和
`kb-desktop-ui-validation-20260913/report.json`，并在
[产品验证摘要](./external-knowledge-validation-2026-09-13.json)归档必要字段。报告检查
当前生产实现，与下述 2026-09-09、2026-09-10 历史探测分开计证。

严格验证在真实 Electron 43.2.0 中运行生产 `KnowledgeService`、客户端和本机 HTTP MCP。
四个配置均完成绑定保存、凭据持久化后重开、响应 Schema 和引用映射检查；每个配置执行
绑定、服务检索、HTTP MCP 三次检索，共 12 次请求与 12 次响应。

| 配置编号 | 传输 | 目录 / 详情 | 服务结果 / MCP 引用 | 结论范围 |
| --- | --- | --- | --- | --- |
| Dify 1 | HTTPS，严格证书校验 | 成功 / HTTP 405 | 0 / 0 | 详情不兼容仍可绑定与检索，零命中是成功；没有非空证据 |
| Dify 2 | HTTPS，严格证书校验 | 成功 / 成功 | 2 / 2 | 非空服务检索与本机 HTTP MCP 成功 |
| FastGPT | HTTPS，严格证书校验 | 成功 / 成功 | 2 / 2 | 非空服务检索与本机 HTTP MCP 成功，未覆盖桌面 Provider 专属操作 |
| RAGFlow | HTTP，不涉及 TLS | 成功 / 成功 | 1 / 1 | 非空服务检索与本机 HTTP MCP 成功，未覆盖桌面图谱等专属操作 |

这些编号来自本轮报告，不由历史版本号推断。`safeStorage` 可用且真实加解密往返成功，
四个配置保存的凭据均在重开后可用。HTTPS 结论只覆盖表中三个 HTTPS 配置。

Dify 桌面验证使用当前 Main、Preload、Renderer、真实 BrowserWindow 和生产 IPC。
实例保存时，验证程序仅在 Main 的保存 Handler 边界替入已有测试密钥。已验证目录选择、
真实检索后绑定、本地参数保存和隔离桌面配置重启；保存参数为返回 2 条、超时 15 秒、
单片段 200 字符。14 次只读请求均为 HTTP 200，其中目录 4 次、详情 4 次、检索 6 次。

窗口按 1440、900、700 宽度检查，报告实际 viewport 为 1439、899、699，均无 body 横向
溢出；宽屏参数两栏、窄屏单栏及窄屏列表可见。原生 ArrowRight 切换并激活检索页签。
桌面凭据记录采用 `electron-safe-storage`，解密匹配且明文未写入被检查的凭据记录；
BrowserWindow 保持 sandbox、contextIsolation 开启和 nodeIntegration 关闭。

生产 `knowledge.search` 返回两条真实引用，验证程序通过 `conversations.saveLocal`
保存带测试标记的会话后重载，再打开生产引用弹窗。已检查片段、Provider、快照说明和
弹窗内焦点，未出现本地上下文或打开来源按钮。这里验证的是历史引用保存与阅读，
没有生成模型答案，也未证明模型会在真实回答中使用或引用证据。隔离配置和构建已清理。

截至上述早期验证，已知检索请求 30 次，上界 42 次：未保留诊断的首轮为 0 至 12 次、此前已确认
12 次、严格验证 12 次、桌面 6 次。首轮准确数量无法恢复。模型生成调用为 0；Provider
侧 Embedding、重排及审计用量不据此记为零。该计数不合并 9 月 9 日、10 日的历史探测。

Linux 测试 Host 的 LAN 与 VPN TCP 均可达，但验证程序读取已有 SSH 凭据时发生
`E_SAFE_STORAGE_DECRYPT_FAILED`，在认证 SSH 之前阻断。因此真实远程 forced-preflight
未执行；本机 HTTP MCP 成功不能替代远程生产路径验收。

### 2026-09-13 UI 修正与真实生成复验

用户指出原界面不符合要求，并要求真实模型与知识库一起验证。当前 `ExternalKnowledge.tsx`
与 CSS 已修正 Portal 移出工作区后丢失字段作用域的问题，改用共享 `.field`；实例弹窗收为
560px，密码使用眼睛图标，新建直接填凭据、编辑才选择保留或替换或清除。开关、粘附底部
操作区、带地址和凭据状态的实例菜单、EmptyState 与键盘行为均已更新。实现细节见
[UI 设计](./external-knowledge-ui-design.md#当前实现与验收边界)。

本轮读取 `kb-real-generation/report.json`、`kb-full-app-live/report.json` 和
`external-visual-0913/results.json`，脱敏摘要归档在
[UI 与真实生成复验](./external-knowledge-follow-up-2026-09-13.json)。摘要不保存模型端点、
私有配置标识、密钥、业务正文、生成答案或内容哈希。

| 验证层 | 实际覆盖 | 结果与边界 |
| --- | --- | --- |
| 生产 IPC 与真实模型 | 真实 Electron、Preload、已注册 IPC 和 ModelAgentRuntime；Dify/FastGPT/RAGFlow 的 `always`，以及 Dify `auto` | 最终场景均有非空短答案、依据匹配、引用标记、单库范围与文本/外部引用持久化证据；Renderer 是隔离验证 DOM，不是完整 App |
| 完整 App | 真实 Main、Preload、Renderer；从界面创建 Dify 实例及非空绑定，在输入区选择知识库并点击发送，Ask + `always` | 真实模型生成并保存答案，检索片段进入模型请求，点击引用后片段和远端文档/片段 ID 匹配，焦点在弹窗内；无伪造会话、引用或 Agent 事件 |
| 视觉与键盘 fixture | 当前组件和样式、真实 body Portal 与 Electron 原生键盘；IPC 为本地假数据 | 56 张截图、138 项检查通过，errors 为空；覆盖浅深主题及 1280×800、960×720、720×640、640×420，不作为真实 Provider 业务调用证据 |

生产 IPC 首轮 FastGPT/RAGFlow 已有非空、依据匹配和引用，但验证程序直接在序列化请求
字符串内寻找原片段，导致 `retrievedSnippetInBody=false`、`passed=false`。改为解码 Provider
请求及其中的证据 JSON 后，两家重跑均通过。归档保留首轮失败和修正后结果，不把首轮
改写为通过，也不把这次断言修正记成产品检索修复。Dify `auto` 通过进程内
`ModelToolProvider → KnowledgeMcpGateway` 执行 `knowledge_search`，不是 HTTP MCP 会话。

模型使用用户已保存的默认配置，凭据在 Main 用 safeStorage 解密。完整 App 检查确认原
模型设置未改变；Dify/FastGPT 请求使用严格 HTTPS，RAGFlow 和所用模型保留已配置的 HTTP。
完整 App 中的测试知识库密钥仅在 Main 保存 IPC 边界替入，报告没有公开实际密钥。

完整 App 另检查浅深主题的 Portal 编辑器：宽度 560px、字体与字号继承共享控件、背景
随主题变化，窗口内无横向溢出。视觉 fixture 检查了密码显隐前后布局、原生 Tab/Space、
开关、底部保存按钮、焦点循环与恢复、菜单跳过禁用项、页签、凭据替换和清除确认。

| 本轮请求 | 模型 | KB 全部 | KB 检索 | 目录 | 详情 |
| --- | --- | --- | --- | --- | --- |
| 生产 IPC 生成报告 | 7 | 12 | 9 | 3 | 0 |
| 完整 App 报告 | 1 | 5 | 3 | 1 | 1 |
| 合计 | 8 | 17 | 12 | 4 | 1 |

计数是本轮应用实际发出的 HTTP 请求，包含绑定验证和断言修正后的重跑；不推断上游代理
内部请求或 Provider Embedding、重排用量。生产 IPC 的检索含绑定验证 3 次、强制预检索
5 次、按需检索 1 次；完整 App 含创建验证 2 次、输入区发送触发 1 次。本轮采用精确增量，
不沿用生成报告中漏计早期桌面请求的累计字段。

“生成未经验证”已在上述短答案范围内解决。检查证明选中知识库的真实片段进入模型并
产生带依据和引用的短答案，不证明长文、多库冲突、复杂推理或广泛问答质量。完整 App
仍只覆盖 Dify；FastGPT/RAGFlow 完整桌面与专属参数、Linux 远程路径继续待验收。
当前 UI 修改后的聚焦测试、全量回归及相关检查已通过，精确结果见前文自动测试记录；
早期通过记录保持原时间范围。

### 历史验证记录

2026-09-10 官方 API 核对与真实实例复测：

- 官方资料链接与版本差异见[技术设计第 9 节](./external-knowledge-technical-design.md#9-provider-映射)。
  已修正 Dify 默认配置优先级、FastGPT 端点响应与数组评分说明、RAGFlow 新旧候选数参数边界。
- 使用现有本地测试配置与脚本默认查询，执行基础 14 次、扩展 19 次，共 33 次只读请求，
  其中检索 17 次。未调用远端内容写入、聊天或生成端点；检索所用 Embedding、重排及审计
  用量由远端服务处理，不据此推断底层模型调用次数。
- 两轮均在独立 Node 进程显式设置 `NODE_TLS_REJECT_UNAUTHORIZED=1`。两个 Dify 实例与
  FastGPT 的 HTTPS 请求通过严格证书校验；RAGFlow 使用 HTTP。
- [基础报告](./external-knowledge-probe-2026-09-10-strict.json)和
  [扩展报告](./external-knowledge-probe-2026-09-10-extended.json)保留脱敏状态、数量、字段结构
  和耗时。每个实例只对目录选出的一个库执行检索，未遍历全部库。

| 实例 | 目录与详情 | 检索结果 |
| --- | --- | --- |
| Dify 0.15.8 | 目录 3 项；详情 HTTP 405 | 默认与显式当前配置请求均成功，均为 0 条；非空结果尚未验证 |
| Dify 1.17.0 | 目录 1 项；详情成功 | 默认与显式当前配置均为 3 条非空结果 |
| FastGPT，版本未确认 | 根目录 1 个 Dataset；详情 HTTP 200、业务码 200 | 向量 8 条、全文 2 条、混合 7 条、混合加重排 9 条；重排响应明确为启用；检索包装为 `data.list`，`score` 为数组 |
| RAGFlow，版本未确认 | 目录 29 项；详情成功；18 项配置图谱、16 项有完成证据 | 基础 2 条、图谱 3 条、知识编译开关 2 条；请求均 HTTP 200、业务码 0，但没有知识编译配置证据 |

- 修正探测脚本将 Dify/RAGFlow 失败记成零命中的问题，增加实际调用与成功标记，统一
  FastGPT 地址规范化并记录分数结构、响应中的重排状态。未修改产品客户端；旧 FastGPT
  检索数组包装、数组评分映射及上一轮发现的取消分类问题在当时仍待处理；当前客户端已修正，
  当前服务和本机 HTTP MCP 的真实 Provider 复验见 2026-09-13 记录，旧包装等特定响应变体
  仍不能仅凭成功计数认定覆盖。
- 三组探测测试共 43 项通过，包含两份新报告的脱敏与只读操作检查；`npm run typecheck`、`npm run lint` 通过。
  `npm test` 在该历史轮次先后达到 60 秒和 240 秒执行时限，均未输出汇总；当前最终全量
  已通过，见 2026-09-13 记录。
- 本轮未验证真实 401/403/404/429、超时、取消、Scoped Key、分页、元数据过滤或候选数
  参数效果。探测脚本不打包到桌面或 GoodBuddy Agent，本次未改变远程 Runtime 生产路径。

2026-09-09 外部知识库适配基础验证：

- 使用本机未入库的测试配置累计执行 107 次只读请求，其中更新后的最终归档脚本执行 19 次；脚本
  调试产生的结果只写入批准的临时目录。三套目录、FastGPT 详情和 RAGFlow 详情均成功；
  Dify `0.15.8` 详情 GET 返回 405，Dify `1.17.0` 详情 GET 返回 200。验证过程未输出 API
  Key、知识库名称和业务正文。
- Dify 响应头确认两个版本为 `0.15.8` 和 `1.17.0`。1.17 默认与显式当前配置检索均返回
  3 条非空结果，已验证 `segment/document` 字段；详情新增 Metadata、多模态、摘要索引和
  Pipeline 能力字段。FastGPT 与 RAGFlow 响应未提供产品版本。实测还确认
  FastGPT 列表 `data` 为直接数组、结果 `a` 可缺失，RAGFlow 文档名字段为
  `document_keyword`。详细基线见[外部知识库技术设计 9.0 节](./external-knowledge-technical-design.md#90-真实实例验证基线)。
- 新增 `scripts/external-knowledge-probe.mjs`，可重复生成
  不含地址、凭据、远端 ID、名称、查询和正文的能力报告。最终报告归档在
  [`external-knowledge-probe-baseline.json`](./external-knowledge-probe-baseline.json)。
- FastGPT 的 embedding、fullTextRecall、mixedRecall 和 mixedRecall + Rerank 均返回非空
  结果。RAGFlow 当前 28 个库中 17 个配置 GraphRAG、15 个存在完成证据；已完成库在基础
  检索为零结果时，图谱检索返回 1 条结果。当前没有库提供 Knowledge Compilation 配置证据。
- 新增 `src/main/knowledge/external/external-knowledge-client.ts`，固定实现三种 Provider 的
  只读目录和检索端点、地址规范化、超时、响应大小限制、HTTP 错误分类和结果标准化。
- `npx vitest run src/main/knowledge/external/external-knowledge-client.test.ts`：1 个测试文件、
  5 项测试通过。
- `npx vitest run tests/external-knowledge-probe-report.test.ts src/main/knowledge/external/external-knowledge-client.test.ts`：
  2 个测试文件、7 项测试通过；覆盖归档报告脱敏、只读操作和特色能力证据。
- `npx eslint src/main/knowledge/external/external-knowledge-client.ts src/main/knowledge/external/external-knowledge-client.test.ts`：通过。
- `npm run typecheck`：被当前工作区已有的 `src/main/ipc.test.ts:7694` tuple 类型错误阻断；
  新增适配器、探测脚本和报告测试的定向测试与 ESLint 已通过。
- 当前 Node 测试环境设置了 `NODE_TLS_REJECT_UNAUTHORIZED=0`，Dify 和 FastGPT 请求实际
  使用了放宽的 TLS 校验。产品接入不能继承该进程级默认，保存或测试实例时仍需按技术设计
  明确处理传输风险。

2026-09-05 最终验证：

- `npm test`：325 个测试文件、3511 项测试通过；8 个文件、55 项手动或集成测试按既有
  配置跳过。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm run build`：Electron Main、Preload、Renderer 生产构建及控制面安装包检查通过。
- `npx vitest run src/main/knowledge/knowledge-service.test.ts -t "imports real DOCX and PDF files from disk into searchable chunks"`：
  有效 Open XML DOCX 与两页原生文本 PDF 均通过生产 `KnowledgeService.importPaths`
  导入、解析、分块和全文检索。

2026-09-06 对话知识库选择补充验证：

- `App.test.tsx` 覆盖点击名称、文档数量和行本身时切换选中状态，以及空目标失焦时
  弹层不提前卸载。Windows 隔离桌面实际点击名称后选中、点击数量后取消，弹层保持打开。
- 本轮全量校验结果见[工作栏验证记录](../assistant-workbar/progress.md)；本项验证未调用模型。

## 剩余工作

- 完成 FastGPT/RAGFlow 桌面专属配置及实际参数效果检查；补充混合库、真实聊天
  `always`/`auto` 的多库与复杂问答、停用和本地删除、未覆盖的主题及键盘路径。三家生产 IPC
  短答案、Dify 完整输入区真实回答与引用，以及已检查的主题/尺寸/键盘不再列为首次待验收。
- 解决验证程序对已有 SSH 凭据的解密问题后，执行真实 Linux forced-preflight；网络已可达，
  当前阻断点是认证前凭据读取。
- 三家服务已完成真实检索与本机 HTTP MCP。FastGPT/RAGFlow 部署版本、Dify 1 非空结果、
  Scoped Key 和真实错误矩阵等仍需补证；旧探测不证明当前桌面配置效果。
- 原设计中的分项探测、版本能力展示、地址确认、请求取消交互和详细诊断与当前实现有差异，
  具体范围见[技术设计](./external-knowledge-technical-design.md)和
  [UI 设计](./external-knowledge-ui-design.md#当前实现与验收边界)。这些差异需由功能 owner 核对验收，
  本轮仅改文档，不补产品代码或扩大架构。
- 扫描 PDF 的真实 OCR 验收依赖用户已安装并校验的 OCR 模型；本次 DOCX/PDF 回归覆盖
  原生文本 PDF，不宣称覆盖扫描件 OCR。
- PDF.js 在测试环境会提示未配置 `standardFontDataUrl`；文本、页码定位与检索结果不受
  影响。
