# 监督者实施进度

日期：2026-09-23。

当前记录以已验证生产行为为准。监督者尚未覆盖全部 user stories。

## 已验证

- 共享监督者契约已接入 Main 服务，模型请求包含系统指令；证据总字符预算为 48,000，输出仍限制为 100KB，并校验本次证据集内的来源引用、输出局部实体 ID 和关系端点。手动回顾当前收集会话、任务、消息已有的知识引用和已确认记忆；记忆使用 `memory` 来源类型。
- SQLite schema 43 包含监督运行、结果、来源、故事线、事件、实体、实体关联和关系表，并保存每次结果的实体与关系内容。来源保存本地 library/document/chunk 或外部 locator 元数据；持久化与升级规则见[技术设计](./technical-design.md)。
- 监督者入口只有一个页面页头和四项顶层页签：工作回顾、故事线图谱、活动、设置。原有计划、概览、建议及报告内容保留在设置页内部；手动运行仍通过 Supervisor 通道，未绑定自动计划时也可用。
- 工作回顾显示结果自身冻结的 scope/time range。故事线视图使用真实数据库结果，外围事件按实际时间逆时针排列并保留缺口，事件实体连线和来源过滤来自 Main 查询投影，图形不可用时仍可通过事件/实体/关系列表操作。
- `HeartbeatService` 在定时或手动心跳成功落库后调用同一个 `SupervisorService`，按心跳范围和回顾窗口自动保存监督结果；投影失败不会改写已经成功的心跳状态。
- 监督图谱提供 Main/Preload IPC 的来源读取、实体确认/修订/撤销和关系确认/移除；关系移除保存 `revoked` 状态，不删除来源，后续自动 run 不恢复相同身份的关系。
- 右侧助手栏已读取监督反馈，支持来源查看、继续讨论预览与确认发送，以及本地知识库实体写入预览和确认提交。
- 本地会话来源可按会话 ID 和发生时间读取上下文；没有当前会话时，继续讨论操作明确禁用。
- 应用中心已增加监督者开关，继续复用 `heartbeat` 导航 ID；关闭后已打开页面显示关闭状态并禁用工作区操作，不删除既有心跳计划或历史数据。导航显示同时遵守 enabled 和 pinned 语义。默认值及执行边界以[应用启停与执行](./logic-design.md#应用启停与执行)为准。

## 验证证据

### 2026-09-23 Desktop 0.13.13 侧栏布局回归

- 固定目标与刷新改用标题旁的共享图标按钮；目标显示会话/任务名称，缺失名称使用未命名文案。
  对应 US-S25，行为见[会话侧栏](./ui-design.md#会话侧栏)，未改变监督运行或取消逻辑。
- `RightAssistantSidebar.resize.test.tsx` 66 项和 `SupervisionCard.test.tsx` 4 项通过。
  `tests/supervisor-layout.electron.test.ts` 的常规工作区场景通过，额外设置
  `GOODBUDDY_SUPERVISOR_SIDEBAR=1` 后的侧栏场景也通过：480/300/200px、
  浅深主题、长标题、34px 按钮、键盘焦点与无横向溢出，共 6 种布局。
- 完整 typecheck、lint 通过，真实模型调用 0 次。使用隔离组件 fixture，不代表真实
  用户数据库端到端验收；发布验证范围见[候选记录](../../development/release-preparation-0.13.13.md)。

### 既有实现验证

- `npx vitest run src/renderer/src/SupervisorWorkspace.test.tsx src/renderer/src/HeartbeatCenter.test.tsx`：17 个测试通过，覆盖统一页签、无计划手动回顾、加载状态、图谱真实连线与来源过滤。
- `npx vitest run src/main/assistant/supervisor-service.test.ts src/main/assistant/assistant-database.test.ts src/main/application-settings-store.test.ts src/renderer/src/ApplicationCenter.test.tsx`：166 个测试通过。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `git diff --check`：通过；仅有现有文件的行尾转换提示。

### 2026-09-23 页面与视觉验证

- 生产页面按 [UI 设计](./ui-design.md) 使用三栏工作台、真实实体名称、逆时针事件环、实际关联连线、选中强调与来源详情。颜色复用现有图谱令牌，未修改全局主题。密集数据按批显示，列表保留全部返回记录；事件浏览不还原历史实体状态。
- 设置只保留一个一级标题，缺少监督者 bridge 不再回退旧概览；无计划手动回顾、项目/时间范围、来源关联过滤均有组件回归。来源异步读取期间切换事件时，迟到正文不会出现在无关联事件下。
- `npx vitest run tests/supervisor-layout.electron.test.ts src/renderer/src/SupervisorWorkspace.test.tsx src/renderer/src/HeartbeatCenter.test.tsx src/main/assistant/supervisor-service.test.ts src/main/assistant/assistant-database.test.ts`：134 项通过。Main 测试使用隔离数据库和注入摘要器；视觉入口渲染生产 React 组件，未读取真实用户数据或调用付费模型。
- Electron 实测 1440、1024、390px 与浅深主题，页面、壳层和内容容器均无横向溢出；1440px 三栏实测为 216 / 863 / 280px。窄屏画布内部滚动保留可读字号，缩放后 SVG 文字不低于 11px；另验证 9 个容器临界宽度、长标题、80 个同时间事件、40 个实体、来源详情、设置表单、加载/空/错误/缺 bridge 状态。
- 截图与 `measurements.json` 输出到本次指定的临时目录 `opencode/supervisor-visual`。代表文件为 `selected-source-1440.png`、`light-1024.png`、`light-390.png`、`dark-1440.png`、`dense-selected.png`、`selected-source-390.png`、`settings-plans-390.png`。可复用的验证和交互预览入口见 UI 设计末段。
- 全量 `npm test`：416 个文件通过、9 个跳过、1 个失败；4902 项通过、67 项跳过、1 项失败。失败为 `local-runtime-reuse.test.ts` 的十项目 OpenCode 压缩断言（`compacted: false`），单独复跑该文件的 2 项均通过。本次未改动 Runtime 实现，未将这次全量运行记为全绿。
- 页面收尾后重新执行 `npm run typecheck`、`npm run lint` 通过。App 已在上述全量测试中通过；一次包含 App 的额外定向命令超过终端 120 秒限制，随后缩小到上述 5 个相关文件完成验证。

## 当前边界

### 2026-09-23 Main 与侧栏定向修复

- 已修复：继续讨论不再把数组写入要求字符串的 `serializedContexts`；请求省略 Runtime 时复用会话选择。真实 SQLite 入队后，生产队列解析器成功派发请求。
- 已修复：每次结果独立分配实体和来源 UUID，映射事件、关系、实体变化及来源引用。两次重叠 run 和跨项目相同模型 ID 均有 SQLite 回归，用户修订的名称和说明保留，所有结果均可读取自己的来源及 locator。schema 41 升级并重复打开后保留旧记录和确认状态。
- 已修复：知识库预览与提交均检查本地库及实体所属库；侧栏确认框展示实际返回内容，取消与写入失败后可重新预览。测试覆盖真实本地实体读写，外部只读及提交前归属变化由注入状态验证。
- 定向验证：`npx vitest run src/main/assistant/assistant-database.test.ts src/main/ipc.test.ts src/renderer/src/RightAssistantSidebar.resize.test.tsx src/main/assistant/supervisor-service.test.ts -t 'supervision|shares bounded evidence'`，4 个文件中选中的 9 项通过，其余 289 项未运行。本轮未运行全量测试、typecheck、lint 或真实模型请求；前文历史验证不能代替本轮验证。
- 当时未修复的双边时间范围及记忆背景语义已由下节定向修复覆盖。跨 run 实体识别由本轮候选身份实现补齐；旧实现已经覆盖或忽略的历史内容无法从现有记录自动还原。

### 2026-09-23 第 4 问题：双边时间范围

- 已接通真实 `supervisionRun` IPC handler → collector → SQLite → 摘要输入 → 结果保存。监督者显式传递请求时间区间，不再扩大到一小时；消息与会话在 LIMIT 前按闭区间筛选，任务按创建或完成时间筛选。所选项目复用存在且 active 的检查；普通 Heartbeat 不传明确区间时仍使用原下界行为。
- 记忆证据使用真实 `updated_at`，locator 保留 `created_at`/`updated_at` 并标明当前背景；摘要指令禁止据此推断历史内容。任务的当前状态也不作为历史状态快照。实现规则与剩余容量边界见[技术设计](./technical-design.md)。
- 定向验证：`npx vitest run src/main/ipc.test.ts src/main/assistant/heartbeat-database.test.ts -t 'collects supervision within the exact UI timeRange|builds one bounded snapshot across only the selected projects'`，2 个文件中选中的 3 项通过，133 项未运行。两项新 IPC 测试分别覆盖 global/projects：15 分钟精确范围与端点、25 条区间后消息及 21 个区间后会话不挤掉区间消息、旧任务期间完成、期内创建但期后完成的任务选用创建时间、记忆非采集时刻、archived 项目拒绝。已有 Heartbeat 项目快照用例通过。
- 首两次定向运行因新增测试 fixture 缺少 `description`、消息 `state` 失败，补齐实际契约后通过。本轮所改 tracked 文件的 `git diff --check` 通过，仅有行尾转换提示。验证使用真实隔离 SQLite 与生产 IPC/collector，模型 Runtime 为测试替身；未运行 UI/Electron、全量测试、typecheck 或 lint，真实模型调用为 0。未改 Renderer/CSS、数据库 schema、远端 Agent/Runtime，不涉及独立远程执行逻辑；未提交。

### 2026-09-23 结果定位、目标过滤与候选身份

- 对应 US-S02、US-S05、US-S10、US-S13、US-S25：overview 返回稳定结果/故事线 ID；Main 校验 graph 请求归属，并按结果读取当次事件、对象与来源。历史选择和图谱共享结果定位，请求序号阻止迟到响应覆盖新选择。
- 侧栏 overview 通过类型化 Conversation/Task 目标查询；SQLite 在 LIMIT 前同时校验匹配来源和项目范围。无匹配结果不展示全局第一条。卡片展示结果范围和时间区间，目标切换清空来源与预览并忽略旧请求。
- tasks 工作栏实例新增可持久化的会话/任务监督绑定；固定、切换聊天、取消固定均连接到实际卡片查询，任务列表仍使用原项目范围。继续讨论预览展示真实发送目标，回调显式传会话 ID，Main 复用该会话配置。固定任务找不到关联会话时不启用发送。
- 模型只能用 `persistedId` 引用 Main 提供的同 scope 候选 UUID；服务与保存事务分别校验。未显式引用候选的实体和所有来源继续分配新 UUID。SQLite 回归覆盖重复 run 复用、不同项目拒绝、裸模型 ID 不合并、确认/修订字段及关系理由保护、移除关系后不自动恢复。
- schema 43 升级保存现有可定位的结果成员，后续 run 不改写旧结果内容；测试从 schema 42 升级并重复打开，比较历史图谱与来源，包括没有直接来源引用、但两端实体归属明确的关系。已有 schema 41 保留数据用例继续通过。缺失归属、曾被覆盖的描述仍无法重建。
- 定向测试共覆盖 32 个不同用例，最终均通过。主命令为 `npx vitest run src/main/assistant/supervision-history.test.ts src/main/assistant/assistant-database.test.ts src/main/assistant/supervisor-service.test.ts src/main/ipc.test.ts src/renderer/src/SupervisorWorkspace.test.tsx src/renderer/src/SupervisionCard.test.tsx src/renderer/src/RightAssistantSidebar.resize.test.tsx src/renderer/src/HeartbeatCenter.test.tsx -t '[sS]upervis'`：29 项通过，2 项失败来自新增同步 IPC 拒绝断言误用 `.rejects`。修正后仅复跑 `src/main/ipc.test.ts src/shared/workbar-contracts.test.ts -t '[sS]upervis'`，5 项通过，包含新增工作栏绑定契约用例。期间修正了旧侧栏 fixture 缺少目标、迁移比较未忽略成员顺序和图谱按钮查询歧义。
- 收尾增加同来源但项目范围不匹配的过滤断言，以及无直接来源引用的关系迁移断言；仅复跑 `src/main/assistant/supervision-history.test.ts src/main/assistant/assistant-database.test.ts -t supervision`，5 项通过，其余 103 项未运行。
- `npm run typecheck` 运行一次，通过。对本轮涉及的 TS/TSX 执行一次定向 ESLint，0 error、1 条 ref 清理 warning；调整后仅复查该文件及新增契约测试，迁移收尾只复查数据库与对应测试，均为 0 error、0 warning。未重复检查整个 App。`git diff --check` 通过，仅有现有行尾转换提示。
- 本轮未跑全量测试或 App 整文件，未启动 Electron 或调用真实模型；模型请求数为 0。验证包含生产 IPC/collector 与真实隔离 SQLite，以及真实 React 组件的异步交互测试，不能据此声称已完成真实模型或完整桌面端到端验收。未修改 Agent/远程执行协议或 Runtime 生命周期；此次改动在桌面 Main 的监督者输入、存储和查询层生效。全部 dirty 改动保留，未提交。

### 2026-09-23 侧栏结果直达图谱

- 对应 US-S25：SupervisionCard 有匹配结果时提供中英文“在图谱中查看 / View in graph”原生按钮。App 通过显式回调接收 resultId，遵守现有离页检查并打开 heartbeat 路由，向 HeartbeatCenter / SupervisorWorkspace 传递类型化导航请求；没有新增页面或 window 事件。沿用 schema 43 与现有 graph IPC，未改 Main、Preload 或存储。
- 图谱页签、键盘焦点和历史结果选择共用现有页面状态；同一结果再次点击、不同结果切换及 keepalive 再进入均重新定位，固定监督目标保持。导航切换立即清空旧图谱和详情；overview、graph、来源及操作的迟到响应不会改写新选择。overview 没有返回指定结果时仍按该 ID 请求图谱；失败可重试原 ID，不回退默认最新结果。
- 新增 7 个定向用例，最终均通过。首轮命令：`npx vitest run src/renderer/src/SupervisionCard.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/App.test.tsx -t 'graph navigation'`，3 项通过、2 项因测试使用旧文案失败。修正为实际“工作栏”“历史结果”文案并补充两项竞态测试后，仅运行 `src/renderer/src/SupervisorWorkspace.test.tsx src/renderer/src/App.test.tsx -t 'graph navigation'`，5 项通过、296 项未运行。请求状态收尾后仅复跑 SupervisorWorkspace 的同一筛选，4 项通过、11 项未运行。
- 测试覆盖真实 React 组件与 App 路由接线：首次只请求侧栏结果、固定目标、同结果重复点击、不同结果、keepalive 页面实例不变、历史选择同步、页签方向键及焦点、中英文/空态入口、旧 overview/graph/来源迟到、指定 ID 不在 overview 和失败重试。IPC 在这些 UI 测试中为替身，未声称真实桌面端到端验收。
- 本轮涉及的 10 个 TS/TSX 文件定向 ESLint 通过，0 error、0 warning。`npx tsc --noEmit -p tsconfig.node.json` 与 `npx tsc --noEmit -p tsconfig.web.json` 各一次有效源码检查通过；此前附加 `--incremental false` 的启动因 composite 配置报 TS6379，未执行源码检查。`git diff --check` 通过，仅有现有行尾提示。
- 未运行 App 整文件、全量测试、全量 lint、Agent typecheck、Electron 或真实模型请求；模型调用为 0。此次仅修改桌面 Renderer 导航和异步展示，不影响 Agent/远程 Runtime。保留全部其他 dirty 改动，未提交。

### 2026-09-23 自动监督设置

- 对应 US-S22 至 US-S24：监督者设置直接显示完整自动监督配置，运行概览、建议、报告与记录保留为次要面板。界面统一中英文命名，保留内部 heartbeat 标识和已有内容。无计划时明确显示仅支持手动回顾，填写草稿不触发保存或运行。
- 核对共享 recurrence 合同及实际调度器后，仅展示已支持的每日、每周指定时间；页面明确说明不支持分钟间隔。编辑保留原时区和暂停状态，计划列表显示范围、周期、时区、回顾窗口与保留期限，继续提供编辑、暂停、恢复、运行及确认删除。
- 已核对 App、Preload、Main 和 HeartbeatService 的既有 CRUD 接线，本轮未修改调度器或创建默认计划。保留工作区原有默认关闭及 Main 启用检查改动。
- 定向测试：`HeartbeatCenter.test.tsx` 23 项、`application-settings-store.test.ts` 50 项通过；`heartbeat-recurrence.test.ts`、`heartbeat-service.test.ts`、`heartbeat-database.test.ts` 合计 17 项通过；`ipc.test.ts -t 'heartbeat enabled gates'` 4 项通过、128 项未运行。覆盖中英文直接入口、每日/每周提交、多项目、无效窗口、失败保留草稿、时区及暂停状态、各项计划操作，以及默认关闭、无计划不运行和启停行为。首轮整文件运行发现原有顶层图谱测试未清理 DOM，补充文件级 cleanup 后通过。
- `tests/supervisor-layout.electron.test.ts` 通过：生产 React 组件的自动监督设置在 1440、1024、390px 和浅深主题下测量无横向溢出，周频表单全部控件边界可达，默认配置页及未配置说明存在。该测试使用隔离 fixture；未将其表述为真实模型或用户数据库端到端验收。
- `npm run typecheck` 通过；本轮 9 个 TS/TSX 文件及 Electron driver 的定向 ESLint 通过。按要求未运行全量测试，真实模型调用 0 次；没有 Agent 或远程 Runtime 改动，未提交或推送。

### 2026-09-23 活动页签

- 对应 FR-S10、US-S26：schema 45 复用运行表保存监督开始、完成和失败，并按真实心跳 ID 合并报告和下游监督。手动失败、报告完成但下游运行中/失败、回调失败、应用重开后的未完成记录均有真实 SQLite 测试。没有新的执行引擎或取消协议。
- 类型化活动 IPC/Preload 已接入生产页面；关闭应用不查询，页签或路由离开停止刷新并忽略迟到响应。每页 50 条，串行轮询，读取失败可重试。历史结果通过 resultId 定位，保留现有自动监督设置。
- `npx vitest run src/main/assistant/supervision-activity.test.ts src/main/assistant/supervisor-service.test.ts src/main/assistant/heartbeat-service.test.ts src/preload/supervision-activity.test.ts src/renderer/src/SupervisorActivity.test.tsx src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx`：7 个文件、58 项通过。
- `npx vitest run src/main/assistant/supervision-activity.test.ts src/main/assistant/heartbeat-database.test.ts src/main/assistant/supervision-history.test.ts`：3 个文件、14 项通过，包含 schema 44 升级及重开保留。
- `npx vitest run src/main/ipc.test.ts -t 'supervision|heartbeat enabled gates'`：8 项通过、124 项未运行。新增活动查询首次运行暴露 UNION 排序列缺少别名，修正后真实 SQLite 和 IPC 均通过。
- `npx vitest run tests/supervisor-layout.electron.test.ts`：1 项通过，新增活动页 1440、1024、390px 浅深主题测量，长错误、元数据和操作无横向溢出，短窗口页签保持高度。测试使用生产组件和隔离 fixture，没有读取用户库。
- `npm run typecheck` 通过；定向 ESLint 通过。未跑全量测试或真实模型，模型调用 0 次。没有修改 Agent/远程 Runtime；工作区其他改动保留，未提交或推送。
- App 定向命令 `npx vitest run src/renderer/src/App.test.tsx -t 'Supervisor|graph navigation'`：5 项通过、281 项未运行。刷新互斥及焦点收尾后，`SupervisorActivity.test.tsx`、`HeartbeatCenter.test.tsx`、`supervisor-service.test.ts` 合计 31 项通过；22 个相关 TS/TSX/MJS 文件的定向 ESLint 为 0 error、0 warning。
- 结束时间收尾：手动心跳使用真实报告完成时间，下游失败单独记录结束时间。`npx vitest run src/main/assistant/supervision-activity.test.ts src/main/assistant/heartbeat-service.test.ts src/main/assistant/heartbeat-database.test.ts src/main/assistant/supervision-history.test.ts`：4 个文件、21 项通过，新增受控时钟用例区分 10:00 开始、10:02 报告完成、10:03 下游失败。随后 Node typecheck 和这 3 个改动源码/测试文件的 ESLint 通过。
- 已存在的手动失败无法补回；旧心跳没有冻结范围和关联 ID，保留缺失提示。心跳仍按原保留期限清理，监督结果独立保存。取消和人工修改时间序列审计未实现；`no_change` 的后续接入见下节。

### 其他边界

- 来源读取对本地会话可精确定位到会话和时间；本地知识引用通过现有 `KnowledgeService` 解析文档/分块，失效时显示不可用；外部引用只使用已保存 locator，不调用远端全库。
- 继续讨论和知识库写入使用现有本地会话队列与知识库实体接口，并要求先预览、再由用户确认提交。侧栏已支持结果直达图谱，尚无可编辑的上下文预览。
- 关系移除保留撤销状态及原始来源；界面没有提供恢复入口。
- 候选集最多 100 个实体，复用依赖模型显式选择；不会自动合并历史重复实体或跨 scope 合并。结果级历史内容已保存，事件滑块仍不重建逐事件的实体演变。Experiment、完整图谱回放和取消状态尚未贯通生产链路。

## 2026-09-23 自动增量验证

对应 FR-S4、FR-S10、US-S27。自动心跳报告与下游监督均已接入来源版本和处理位置；无变化跳过模型并保存 `no_change`。消息修订、任务状态、知识引用变化分别参与增量判定，已确认记忆只作背景。实现、预算和删除语义见[自动增量收集](./technical-design.md#自动增量收集)。

- schema 46 增加最小来源进度与消息版本，扩展已有心跳状态 CHECK。来源片段进度与对应结果原子保存，模型或事务失败不推进。未送入模型的来源及正文余段保留待处理资格。
- `incremental-review.test.ts` 使用真实 SQLite 和生产服务，覆盖重开数据库、重复零调用、消息修订后复用实体 ID、105 个长来源分批读完、模型及结果事务失败、任务状态、范围排序、记忆背景、知识引用、报告保存失败和 schema 45 有数据升级。
- 真实模型使用已有加密默认文本配置，经 `RuntimeSettingsStore` 和 Electron `safeStorage` 读取隔离副本，生产 `createDefaultModelRuntime`、`HeartbeatService`、`SupervisorService` 和 SQLite 执行。`tests/incremental-review-live.electron.test.ts` 于本日通过：首次自动运行 2 次 HTTP 请求，重复自动运行 0 次，修改消息后的监督回顾 1 次，再次监督检查 0 次，总计 **3 次真实文本请求**。工具与附件均为 0。
- 真实输出通过结构、来源及实体引用校验，修改后的 Atlas 实体至少复用一个原持久化 ID；无变化检查前后图谱相同。测试检查原设置字节未变、外键与数据库完整性。隔离数据库、配置快照和加密 Local State 随测试目录删除，未改用户计划或数据库。
- 实时测试命令：设置 `GB_REVIEW_LIVE_SETTINGS` 为已有运行时配置路径后，执行 `npx vitest run tests/incremental-review-live.electron.test.ts`。无该环境变量时跳过；每次测试最多 3 个真实请求，不记录凭据。
- 最终聚焦验证：10 个服务、SQLite、Preload 和 Renderer 测试文件共 76 项通过；`npx vitest run src/main/ipc.test.ts -t 'supervision|heartbeat|application enable'` 另有 9 项通过，124 项按过滤条件跳过。`npm run typecheck`（Node、Agent、Web）和本次改动的 19 个 TypeScript 文件 scoped ESLint 均通过。

真实测试覆盖来源较短的单次自动回顾、重复检查及修改后的实体复用。长正文和大量来源预算由确定性 SQLite 回归验证；没有执行全量测试或真实用户数据库升级。事件驱动、清空或重建图谱和语义近似去重不在本次实现范围。
- 知识正文条目与监督实体仍是两个模型，当前不会把监督实体当作知识正文条目。
