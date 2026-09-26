# 监督者实施进度

日期：2026-09-24。

当前记录以已验证生产行为为准。监督者尚未覆盖全部 user stories。

## 已验证

### 2026-09-26 移除回顾自动时间预算暂停

对应 FR-S4、FR-S6、FR-S10。生产服务移除提取循环和导航合并中的整次执行期限判断，持续处理至完成；已保存运行中的 `executionSeconds` 继续兼容读取，但不再控制暂停。设置页移除该控件，中英文帮助和活动配置改为持续处理说明。单次模型超时、共享并发、逐批保存、主动暂停及失败续跑保持原路径，具体合同见[生产接线](./review-scheduling-design.md#0-生产接线与剩余边界)。主动暂停仍中断在途请求，仅保留此前已保存批次。

`npx vitest run src/main/assistant/supervision-review.test.ts src/renderer/src/SupervisionReviewSettings.test.tsx`：13 项通过。受控时钟超过保存的执行预算后，三个叶子及两个导航合并仍完成并发布；另验证主动暂停后复用成功批次和原分块配置、中英文设置不再出现整理时长控件。测试使用隔离 SQLite 和可控摘要器，不代表真实模型长时间运行实测。

`npm run typecheck`、六个修改 TS/TSX 文件的定向 ESLint 和 `git diff --check` 通过。未运行全量测试，真实模型调用 0 次。核对 Main 的生产工厂接线，监督使用不携带项目的 `resolveRequestRuntime({ workMode: 'ask' })`；本次仅改变桌面回顾编排，不修改 Agent、远端 Runtime 或桌面到 Agent 协议。未提交或推送。


### 2026-09-24 长摘要与内容区对齐

针对全局七天回顾的 `summary max 2000` 报错，代码确认导航输出 schema 的 `max(2000)`、服务层对叶子及导航的二次 2000 字符检查，以及模型提示词中的同值要求。另发现监督旧摘要通过 SQL `substr` 和 JavaScript `slice` 截断。以上监督路径限制已移除；生成内容和事实集合的合同见[生产调度合同](./review-scheduling-design.md#已接入的调度与存储)。未读取本次 16:03 失败的原始模型响应，不能据此声明该运行的具体失败节点。

生产工厂回归使用隔离 SQLite 和离线 Runtime 流，验证 14,000 字符的叶子及导航摘要完整进入合并输入、存储、历史读取，发布失败后以已保存节点恢复且不再请求模型，叶子长描述仍进入最终图谱。单次超过 100,000 字节的响应明确失败，保留续跑位置。共享契约另覆盖原字段及数组数量边界，仍拒绝导航事实和叶子缺字段；旧身份兼容、跨范围拒绝和六叶合并恢复测试继续通过。IPC 暂停/继续测试改用 3,600 字符摘要，并修正已有 `persistedId` 提示词断言为当前 `candidateRef` 合同。

布局采用共享阅读、dashboard 宽度，范围、工具栏、历史和结果的对齐规则见[UI 设计](./ui-design.md#应用入口)。真实 Electron 加载生产 React 组件，使用隔离 fixture 验证 2000、1440、1024、390px 的浅深主题，覆盖长摘要、活动、运行中、失败共 32 组，并保存 8 张正文末尾截图。无页面横向溢出，正文末尾保留，宽屏阶段行低于 40px，刷新紧邻筛选。另运行既有活动分支，验证原生键盘展开、完整错误滚动、六个叶子及 12 批分页。已人工查看宽窄屏、浅深主题、运行/失败、正文末尾及批次树截图。

截图分别保存在本机临时目录 `opencode/supervision-content-layout` 与 `opencode/supervision-content-activity`。复现命令为设置 `GOODBUDDY_SUPERVISOR_CONTENT_LAYOUT=1` 或 `GOODBUDDY_SUPERVISOR_ACTIVITY=1` 后运行 `npx vitest run tests/supervisor-layout.electron.test.ts`，可用 `GOODBUDDY_SUPERVISOR_ARTIFACTS` 指定保留目录。模型调用 0 次，未改写用户数据库、运行全量测试或提交。

验证记录：首轮服务、分块、历史和工作区 6 文件 68 项通过；补充共享契约、生产工厂、活动存储/preload、心跳中心及工作区共 8 文件 112 项通过。`npx vitest run src/main/ipc.test.ts -t 'supervis'` 为 17 项通过；修正测试等待的 TypeScript 类型后，暂停/继续单项再次通过。最终 `npm run typecheck`、本轮修改 TS/TSX/MJS 的定向 ESLint 和 `git diff --check` 通过。中文变更按 `deai-writing` 清单人工审校。

### 2026-09-24 活动阶段、批次层级与导航输出修复

对应 FR-S4、FR-S6、FR-S10、US-S26。活动记录改为紧凑运行摘要、实际阶段、恢复操作、折叠错误、按需批次层级和次要配置详情。阶段存入既有运行 JSON；叶子与导航分别校验，叶子缺数组仍失败。当前字段与缺失数据规则见[生产调度合同](./review-scheduling-design.md#已接入的调度与存储)，布局见[活动设计](./ui-design.md#活动)。

只读检查 portable 原库的最新失败运行 `f6800335-5765-4163-9f55-a30c8ab18a94`，确认 32 个来源、剩余 0、6 个成功批次、4,515 字符和 1 个已保存导航节点。错误仅包含 `events / entities / entityChanges / relations` 四个缺失数组。旧代码把导航响应交给叶子 schema，且提示词同时要求“只返回摘要字段”和“事实数组必须为空”，合同矛盾已确认。原始失败响应和阶段没有保存，因此该次失败发生在导航解析仍属有数据支持的推断，不能声称取回了原响应。

使用 SQLite 一致性备份和关联笔记副本执行 `scripts/supervision-navigation-replay.ts`。仅私有副本初始化；第一次因缺少关联笔记停止，补齐后完成。生产工厂继续同一 run，复用已存导航节点，4 次离线响应完成剩余合并及发布，6 个叶子逐项未变。回放文本来自该 run 已保存的成功导航，只保留 summary、changeDigest、openItems，以验证缺数组的合法导航形状；它不验证新摘要质量，也不是原失败响应回放。原库只读，原失败 run 前后相同，付费模型调用 0 次。

本轮验证：

- `npx vitest run src/main/assistant/supervision-production.test.ts src/main/assistant/supervision-review.test.ts src/main/assistant/supervisor-service.test.ts src/main/assistant/supervision-activity.test.ts src/preload/supervision-activity.test.ts src/renderer/src/SupervisorActivity.test.tsx src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx`：8 文件、116 项通过。包含六叶零剩余后的合并失败与继续、发布失败后无模型继续、缺数组叶子拒绝、未知来源/实体拒绝、实际阶段呈现、旧阶段缺失、错误与配置折叠、树分页及读取失败重试。
- `npm run typecheck` 和本轮变更 TS、TSX、MJS 文件的定向 ESLint 通过；未运行全量测试。
- `GOODBUDDY_SUPERVISOR_ACTIVITY=1` 下运行 `npx vitest run tests/supervisor-layout.electron.test.ts`：1 项通过。真实 Electron 加载生产 React 组件，以多项目、多会话的隔离数据覆盖 1440×1000、390×1000 和浅深主题，分别截取运行摘要、错误展开、批次树，共 12 张截图。检查原生 Enter 展开、240px 错误滚动、全部六个已保存叶子及 12 批跨页读取，无横向溢出和控制台错误。失败运行摘要高度为桌面 366px、窄屏 476px，两主题一致；已人工查看截图。

私有数据库、回放报告及截图位于 `C:/Users/jiang/AppData/Local/Temp/opencode/activity-incident-20260924/`，截图测量文件为 `screenshots/review-activity-measurements.json`。收尾检查修正成功返回 coverage 沿用合并前阶段的问题，3 个生产服务测试文件共 33 项复验通过，活动与返回结果均使用发布阶段投影。`git diff --check` 通过，仅提示现存行尾转换。中文文档经 deai-writing 扫描与人工复核，本轮新增段落无阻断项；全文件扫描的 7 项阻断均在既有非本轮段落，未改动其内容。

历史缺失 phase 仍显示未记录；树只列成功批次，没有持久化的单任务失败/在途状态，项目和会话数量仅针对本页。收集与发布仍为同步 SQLite 阶段，不保证轮询可见。未修改 Agent、远程 Runtime、传输或凭据逻辑；原暂存及未暂存修改保留，未暂存、提交或替换 portable 构建。

### 2026-09-24 工作回顾与自动报告分区

对应 FR-S2、US-S22 至 US-S24。工作回顾仅阅读统一监督结果，历史选择和精确结果图谱入口移到正文前；手动新回顾控件保持内联，390px 下使用双列。结果常显生成时间、覆盖区间和范围，正文按原始段落及已有结构化字段展示，限制阅读宽度。新请求配置与运行状态不改写旧结果。自动报告、记忆与行动建议全部归入自动监督，保留展开、确认/忽略、带入对话、标记完成和每次追加 20 条；移除独立最近报告副本。五页签当前布局以 [UI 设计](./ui-design.md#应用入口)为准，下方各轮记录保留为历史证据。

- `npx vitest run src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx src/renderer/src/SupervisorActivity.test.tsx`：66 项通过。覆盖非空结果与空自动报告不矛盾、完整建议操作、长内容展开与分页保留、历史精确 ID、变更新请求范围不重标旧结果、运行中保留正文和活动入口。
- `npx vitest run src/renderer/src/App.test.tsx -t 'graph navigation opens the pinned sidebar result|keeps heartbeat plans independent|saves Supervisor timeouts'`：3 项通过，284 项按名称跳过。校正已有设置保存测试的旧字段选择器，保留实际 App 接线验证。
- `npm run typecheck` 与本轮修改的 Renderer、测试及 Electron driver 定向 ESLint 通过。中文 UI 文档经 deai-writing 扫描，无阻断项；复核项涉及既有状态与实现边界，保留事实限定。
- 设置 `GOODBUDDY_SUPERVISOR_RECAP=1` 后运行 `npx vitest run tests/supervisor-layout.electron.test.ts`：1 项通过。现有生产组件 fixture 覆盖 1440×1100、390×1100 的工作回顾与自动监督，含两类结果均非空、自动报告为空、两者均空，共 12 个页面场景；另验证历史结果运行中保持可见及活动跳转。每页一处刷新、横向溢出及正文宽度断言通过。

截图与 `recap-measurements.json` 保存在 `C:/Users/jiang/AppData/Local/Temp/opencode/supervisor-recap/`。已人工查看桌面与窄屏正文、运行中的历史结果、自动报告展开、建议操作和独立空态截图。此次验证使用隔离 fixture，未读取用户数据库，模型调用 0 次，未运行全量测试；未修改 Main、Preload、数据库、Agent 或远程 Runtime。保留已有暂存和未暂存修改，未暂存或提交。

### 2026-09-24 自动监督概览归属修正

对应 FR-S2、US-S22 至 US-S24。当前状态、范围与刷新、成功率、记忆、洞察、行动指标、报告趋势和心跳运行审计已整体移到“自动监督”，与计划列表同页。当前状态下只保留计划列表的创建按钮和未配置说明，点击直接打开原 Modal。活动页只显示统一监督活动、进度、详情及结果入口，计划 ID 筛选、清除、分页和精确结果跳转沿用原路径；活动筛选不改变自动监督概览。当前归属见 [UI 设计](./ui-design.md#应用入口)，下方旧方案的截图与测试记录保留为历史证据。

- `npx vitest run src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisorActivity.test.tsx`：48 项通过。覆盖空/非空时整块归属、唯一创建入口、独立刷新回调、原 Modal 的 X/footer/关闭保护、计划操作、审计分页、同名计划筛选和结果跳转。
- `npx vitest run src/renderer/src/App.test.tsx -t 'keeps heartbeat plans independent of the active project'`：1 项通过，286 项按名称跳过，保留实际 App 的跨项目计划列表与暂停计划 Modal 保存验证。
- `npm run typecheck`、本轮修改的 `HeartbeatCenter.tsx`、`HeartbeatCenter.test.tsx`、`supervisor-layout-driver.mjs` 定向 ESLint 通过；`git diff --check` 无空白错误，仅提示现存行尾转换。
- 设置 `GOODBUDDY_SUPERVISOR_AUTOMATIC_OVERVIEW=1` 和产物目录后运行 `npx vitest run tests/supervisor-layout.electron.test.ts`：1 项通过，约 10 秒，仅运行本轮范围。现有生产组件 fixture 覆盖浅色 1440×1100、390×1100，空/非空计划与自动监督/活动共 8 个页面场景；检查整块归属、唯一创建按钮、横向溢出、原 Modal 打开关闭及精确计划活动筛选。

截图和 `automatic-overview-measurements.json` 位于 `C:/Users/jiang/AppData/Local/Temp/opencode/supervisor-automatic-overview-20260924/`。已查看桌面、窄屏空/非空计划、活动及滚动后的趋势和运行审计截图；桌面指标四列、窄屏单列，内容无横向裁切，活动页无重复心跳列表。本轮中文修改按 deai-writing 清单人工审校。未运行全量测试，模型调用 0 次，未读取用户数据库；未修改 Agent/远程 Runtime、Modal 实现或共享样式，保留已有暂存和未暂存修改，未暂存或提交。

### 2026-09-24 真实失败运行身份修复

只读定位到 `dist/GoodBuddy-windows-x64/data/assistant.sqlite` 中的运行 `db9902ab-22c8-4aae-86ae-7850bfc07b76`。Roaming 库不含该运行。原运行是全局手动回顾，范围为 2026-09-17 14:33:02 至 09-24 14:33:02，开始于 14:33:02，失败于 14:44:52（本机 UTC+8）。保存配置为分页 50、批次文本量 8000、消息数 20、执行预算 300 秒、模型超时 240 秒、并发 1；清单 32 个来源，成功批次 0。

原错误指向 `entities[0].persistedId` 的 UUID 校验。原始模型响应未保存，诊断文件没有该次响应，无法确认原错误值及 710 秒耗时的模型、排队、重试分解。只读候选检查发现 15 个旧实体均使用文本主键；隔离真实调用再次证明，即使模型选择提供的候选，旧主键仍会触发严格 UUID 校验。修复采用候选短引用、Main UUID 别名及旧键精确映射，详细规则见[技术设计](./technical-design.md)。

通过 SQLite 一致性备份复制数据库和关联笔记文件，仅隔离副本运行初始化及生产工厂 `createProductionSupervisorService`、`ModelAgentRuntime`、批次事务和结果保存。首次隔离启动因缺少笔记文件停止，付费调用 0 次；补齐副本后开始模型验证。使用 `.env.deepseek.local` 的 `deepseek-flash`，总计 3 次 HTTP 请求，无自动付费重试或模型回退：

| 验证 | 本机开始时间 | HTTP | 响应耗时 | 结果 |
| --- | --- | --- | --- | --- |
| 原运行首叶提取 | 14:53:57 | 200 | 5.994 秒 | 首次暴露旧键校验失败，响应私存；修复后缓存复验并保存 |
| 真实来源有界回顾 | 14:58:25 | 200 | 4.445 秒 | 2 个来源、402 字符、1 批，完成并发布 2 个实体 |
| 同一来源候选复用 | 14:58:30 | 200 | 4.703 秒 | 完成并复用 2 个既有实体 |

缓存复验要求请求除 Runtime 当前时间外一致，没有新 HTTP。隔离副本中原失败 run 保存 1 批、3 个精确匹配的原文片段、490 字符及 3 个完整来源位置后主动暂停；32 个来源还剩 29 个，不冒充原全局回顾已完成。两个有界回顾分别完成结果发布，实体总数保持 15。手动回顾不写自动检查用的 `review_checkpoints`。只读复核原 run、来源清单及批次逐项未变；副本完整性检查通过，原有 1 个受保护实体保持不变。

私有产物在 `C:/Users/jiang/AppData/Local/Temp/opencode/supervision-incident-real-20260924/`：`incident.private.json`、`candidates.private.json`、3 份请求与 SSE 响应、`live-metrics.json`、`audit.json` 和副本 `assistant.sqlite`。原库只读打开，无初始化、迁移或业务写入；原失败状态及原有数据保留。验证脚本为 `scripts/supervision-incident-{inspect,launch,audit}.cjs` 与 `scripts/supervision-incident-live.ts`，重复付费启动受检查限制。

定向 7 文件共 47 项测试、`npm run typecheck`、本轮改动文件 ESLint 和 `git diff --check` 通过，后者仅提示现存行尾转换。回归包含真实旧键形状、严格 UUID 别名、空值和占位符的新事实保留、未知候选/跨 scope 拒绝、确认字段及图谱端点保护、失败后成功叶子不重算，以及中英文可展开错误详情。活动页显示本地化失败原因，技术错误保留在可选择文本的折叠详情；进度与设置不再直接展示 UTF-16、Unicode 或共享池术语。新增中文文档按 deai-writing 清单人工复核。未运行全量测试，没有提交、暂存或构建替换应用。此修复属于桌面监督身份边界，未修改 Agent 或远程 Runtime 执行实现；正在运行的 portable 和 D 盘安装版均需包含新源码的构建并重启后才会生效。

### 2026-09-24 计划 Modal 标题与操作区统一

对应 FR-S2、US-S22 至 US-S24。`HeartbeatSettings` 复用既有 `custom-task-dialog__header/content/actions` 和按钮样式，标题在左、带本地化可访问名称及工具提示的 X 在右，取消与保存位于右对齐 footer。采用共享 Grid 的固定标题、滚动正文、固定操作区，没有新增 Modal 框架或页面专属 CSS。共享规范见根目录 [表单 Modal](../../../UI-DESIGN.md#615-表单-modal)，计划交互见[自动监督设置](./ui-design.md#自动监督设置)。

本轮验证：

- `npx vitest run src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/CustomTaskDialog.test.tsx`：50 项通过。覆盖中英文创建/编辑结构、X/取消/Escape/遮罩的干净关闭与未保存确认、Tab 循环、焦点恢复、提交锁定、失败草稿及暂停计划保存重试。
- `npx vitest run src/renderer/src/App.test.tsx -t 'keeps heartbeat plans independent of the active project'`：1 项通过，286 项按名称跳过；验证实际 App 的暂停计划编辑提交、Portal 和背景隔离恢复。
- `npm run typecheck` 通过；本轮修改的 Renderer、翻译和 Electron driver 文件定向 ESLint 通过；`git diff --check` 无空白错误。
- `GOODBUDDY_SUPERVISOR_PLAN_MODAL=1`、`GOODBUDDY_SUPERVISOR_ARTIFACTS=C:/Users/jiang/AppData/Local/Temp/opencode/supervisor-plan-modal-standard` 下运行 `npx vitest run tests/supervisor-layout.electron.test.ts`：1 项通过，约 13 秒。创建/编辑 × 浅/深色 × 1440×1100、390×1100、390×480 共 12 个截图场景，测量无横向溢出、标题与底部按钮不随正文滚动，关闭及底部操作可命中；原生 Shift+Tab、Enter、Escape 验证焦点循环、取消确认和返回编辑。首次两次运行暴露测试驱动的 Enter 字符事件缺失及窗口焦点不稳定，补充字符事件和输入前显式聚焦后通过。

截图与 `plan-modal-measurements.json` 保存在上述产物目录。已查看宽窗口、390px 单列及短窗口的浅深主题创建/编辑截图，X 保持右上、取消与保存保持右下，短窗口只滚动正文。fixture 使用现有五页签和生产 React 组件，未读取用户数据库；模型调用 0 次。未运行全量测试，保留原暂存区与工作区改动，未提交或推送。

### 2026-09-24 监督者文案整理

设置帮助删除“提供商 RPM、TPM、Retry-After 控制及费用预算尚未实现”，保留执行软预算到期后保存正在处理的批次、暂停和从活动记录继续的说明。活动说明删除人工修改审计缺失提示；计划帮助改为选择每日或每周时间、保存并启用后运行。图谱说明实体状态以所选回顾结果为准，事实详情提示展开批次并对照来源核对模型内容。中英文同步，不承诺全局限流或完整语义识别。

已检查监督者设置、帮助、空态、错误展示及相关测试。真实运行错误、失败、超时、暂停和来源失效仍按原路径显示，保留恢复操作。根目录 UI-DESIGN 的既有监督者章节记录文案原则，UI 设计和用户故事同步；内部技术设计与验证记录仍保留事实边界。

本轮验证：

- `npx vitest run src/renderer/src/SupervisionReviewSettings.test.tsx src/renderer/src/SupervisorActivity.test.tsx src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx`：4 文件、57 项通过。新增中英文用例覆盖帮助文案、监督并发范围、来源核对提示，以及真实 HTTP 429 / Retry-After 错误、失败状态和继续入口的保留。
- `npx eslint src/renderer/src/SupervisionReviewSettings.tsx src/renderer/src/SupervisionReviewSettings.test.tsx src/renderer/src/SupervisorActivity.test.tsx src/renderer/src/i18n/locales/zh-CN/heartbeat.ts src/renderer/src/i18n/locales/en-US/heartbeat.ts`：通过。`git diff --check` 通过，仅有现存行尾转换提示。
- 中文 UI 文档扫描无阻断项，9 项复核提示均涉及实际行为边界，按事实保留；新增规则和技术记录另经人工审校。未运行全量测试、类型检查、Electron 或真实模型调用，本轮模型调用 0 次。

本轮仅修改监督者 Renderer、i18n、相关测试和文档；Main、Shared 只读核对。保留已有暂存及未暂存修改，未暂存、提交或推送。

### 2026-09-24 persistedId 并行修复记录

此段记录被上文真实旧库修复替代的早期方案。当时静态核对并行 Main 改动：新实体示例省略 `persistedId`，空字符串和 `null` 视为省略，其他格式错误值仍拒绝。该方案未处理真实候选中的旧文本主键，不能证明用户故障已解决。当前合同见[技术设计](./technical-design.md)。原始失败响应的具体坏值仍未知。

用户提供的并行验证结果为 29 项定向测试及另 1 项 IPC 测试通过；两次真实 DeepSeek 请求分别验证创建和复用，实体数保持 2，实体 ID 稳定。本轮仅记录并静态核对修复，没有复跑这些测试或模型请求；此证据不证明全部事实的语义识别，也不替代此前完整会话实验的范围与计数。

### 2026-09-24 五页签与计划 Modal 修正

对应 FR-S2、US-S22 至 US-S24。当前导航为工作回顾、故事线图谱、自动监督、活动记录、设置。计划列表移入自动监督，原有表单移入共享 Modal；设置只保留算法参数。保存失败保留草稿，未保存关闭确认，暂停计划编辑后仍暂停；计划执行记录按 configId 进入活动筛选，数据库在分页前过滤。报告、建议、概览、审计及精确结果跳转按[当前 UI 设计](./ui-design.md#应用入口)归属。

- 六文件定向组最终 61 项通过：HeartbeatCenter、SupervisorWorkspace、SupervisorActivity、SupervisionReviewSettings、Main supervision-activity、Preload supervision-activity。包含计划创建/编辑、失败重试、放弃确认、焦点循环与恢复、同名计划筛选、报告/审计分页，以及真实 SQLite 分页前过滤。新增换计划重置分页和忽略旧响应回归，筛选与清除保留键盘焦点。
- App 筛选 3 项通过：跨项目计划列表与暂停计划 Modal 保存、设置保存后重开、精确结果跳转。IPC 筛选 2 项通过，验证活动 configId 经真实 handler/SQLite 过滤并拒绝空 ID；其余 App/IPC 测试未运行。
- 最终 `npm run typecheck`、`npm run lint` 和 `git diff --check` 通过；按要求未运行全量测试。中文 UI 文档审校无阻断项，复核提示涉及执行限制和未实现边界，按事实保留。
- Electron 生产组件 fixture 测试 1 项通过，约 66 秒，覆盖 1440/1024/390px、浅深主题、五页签归属、Modal 焦点与放弃、390×720 短窗口保存按钮命中、计划活动过滤和原生方向键。首次运行被终端 60 秒上限中断，延长后通过。

截图位于 `C:/Users/jiang/AppData/Local/Temp/opencode/supervisor-five-tabs/`，包括 `menu-plans-light-390.png`、`plan-modal-dark-390-short.png`、各页签浅深主题截图及 `measurements.json`。人工检查计划、Modal 和设置截图，无横向裁切；短窗口长表单内部滚动。fixture 复用实际生产组件与已有模拟数据，未读取用户数据库，未调用模型。此次不修改 Agent/远程 Runtime，无需远程执行验证。

开始检查时 HEAD 为 `7adae97`，监督改动仍在暂存区与工作区，未发现上轮计划提交；本轮保留其他 dirty 修改，未提交、amend 或推送。

### 2026-09-24 菜单归属调整

此段记录上轮四页签方案，已由上文五页签修正替代。当时设置包含自动监督计划、模型超时与并发、回顾算法三个纵向区块；报告与建议迁入工作回顾，运行概览和心跳审计迁入活动记录。以下保留当时验证证据，当前交互以[应用入口](./ui-design.md#应用入口)为准。

本轮验证：

- `npx vitest run src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx src/renderer/src/SupervisorActivity.test.tsx src/renderer/src/SupervisionReviewSettings.test.tsx`：50 项通过，覆盖双语菜单归属、设置无嵌套导航、计划操作、建议确认/忽略、报告及审计分页、页签切换保留展开状态、快捷按钮焦点、图谱来源与持久进度。
- App 按测试名称筛选运行 4 项并通过：页面读取失败重试、侧栏结果跳转与 keepalive、计划独立于当前项目、模型及回顾参数保存后重开。其余 App 测试未运行。
- `npm run typecheck`、本轮修改的 TS/TSX/MJS 文件 ESLint、`git diff --check` 通过；未运行全量测试。
- `npx vitest run tests/supervisor-layout.electron.test.ts`：最终 1 项通过，约 51 秒。保留原图谱、异常状态、设置及活动的 1440/1024/390px 验证，新增非空菜单在 1440/390px 浅深主题的 12 个页面场景、区块归属、报告全宽、设置无范围徽标/刷新行和原生方向键导航检查。人工查看截图后修正了报告遗留双栏宽度，并补全 fixture 下次运行时间。一次复验受终端 60 秒限制中断，延长执行上限后通过。

截图及测量保存在 `C:/Users/jiang/AppData/Local/Temp/opencode/supervisor-menu-20260924/`，菜单截图以 `menu-` 开头，`measurements.json` 包含布局结果。Electron 使用生产 React 组件和隔离 fixture，未读取用户库、调用模型或验证真实模型产出。本轮模型调用 0 次，无提交或推送。

### 2026-09-24 完整会话生产验证与收尾

生产链路已通过一个独立完整会话的真实模型测试；较早的 129 条消息实验仍为未完成，不能据本次成功改写其状态。按用户要求，没有重发此前的两个请求，也没有重新计算其已保存批次。

只读选择器 `scripts/supervision-select-readonly.cjs` 在 `readOnly`、`query_only` 和读取事务下选择另一条完整会话，筛选条件为 21..40 条 user/assistant 消息、8,001..14,000 码点，并排除旧目标 ID。命中会话共 27 条消息、9,677 码点；选取的是整条会话，没有截取其头尾。仅该会话进入外部临时快照及隔离产品库，原用户库未初始化、迁移或写入。

首次请求输出有效 JSON，提供商以 `stop` 结束，但使用输入的 `locator.source` 作为引用，未使用带范围的 fragment ID。生产校验因此拒收。修正为：引用若是本节点提供的 source token，且只匹配一个输入片段，就映射到该片段 ID；同源多片歧义或未知来源仍拒绝。映射不扩展引用范围，不把片段升级为整条消息。针对唯一映射、歧义拒绝补了确定性测试。

原始 SSE 已保存在外部临时目录。继续测试时通过同一生产工厂、`SupervisorService` 和 `ModelAgentRuntime` 重放该响应，校验相同来源快照、运行配置及请求字节数；这是一次本地响应复核，没有新增付费请求。之后只为未调用的第二叶子和导航节点请求 DeepSeek。最终与每条原消息逐字比较，并检查码点区间连续性。

| 实测项 | 结果 |
| --- | --- |
| 完整覆盖 | 27 / 27 条消息，9,677 / 9,677 码点，27 个片段；重建差异及剩余来源均为 0 |
| 生产产物 | 2 个叶子、1 个导航合并、1 个完整发布结果 |
| 叶子记录 | 19 个事件、15 个实体、8 个变化、11 个关系，共 53 条；摘要未替换叶子 |
| HTTP | 本会话共 3 次 HTTP 200：两个叶子和一个导航；另有一次缓存响应复核，HTTP 为 0 |
| 本轮总付费请求 | 较早失败实验 2 次 + 本会话 3 次 = 5 次；无重复付费请求、无自动重试、无回退模型 |
| 配置 | `deepseek-flash`；页大小 17；默认正文批次 8000、默认消息上限 20；模型超时 180 秒、软预算 600 秒、接纳并发 2 |
| 耗时 | 首次 20,164ms，缓存复核及剩余执行 19,584ms；二者不含人工修正间隔 |
| 手动隔离 | 自动 checkpoint 为 0；SQLite integrity_check 为 ok |

产物目录为系统临时目录 `opencode/review-production-complete-20260924`；来源快照在 `opencode/review-production-selected-20260924`。计数见 `metrics.json` 和只读审计入口，响应 `.private.sse` 仅供本机诊断，未进入仓库。模型输入包含完整选中正文，但未进行独立语义召回评估；“覆盖完成”不表示模型识别了每个事实。

最终确定性验证：12 文件定向组 136 项通过，覆盖服务/存储、迁移、设置、Preload 和页面；生产 IPC 筛选 22 项通过，其余 128 项未运行。完整 App 的设置保存及重开 1 项、AssistantDatabase 的监督历史筛选 4 项通过。Electron 使用生产组件，在 1440/1024/390px、浅深主题通过布局测试。首次视觉测试发现脚本仍只选中第一个设置表单，改为测量整个设置面板的可见控件后通过；两个表单同名保存按钮也已分别命名。

收尾新增用例确认 schema 46 已提交的 2,000 码点前缀不重读，只处理后续 1,300 码点；来源变化保留旧批次并要求新 run，后续自动检查不会永久卡在旧版本。来源上下文按已保存 messageId 和片段返回，避免同时间消息误定位或用当前正文冒充历史片段。`npm run typecheck`、本轮修改及新增 TS/TSX/CJS/MJS 文件的定向 ESLint 均通过。没有运行全量测试、提交或推送。

最终定向命令：

```text
npx vitest run src/main/assistant/supervision-review.test.ts src/main/assistant/supervisor-service.test.ts src/main/assistant/supervision-history.test.ts src/main/assistant/supervision-activity.test.ts src/main/assistant/incremental-review.test.ts src/main/assistant/supervision-model-pool.test.ts src/main/application-settings-store.test.ts src/preload/supervision-activity.test.ts src/renderer/src/SupervisorActivity.test.tsx src/renderer/src/SupervisionReviewSettings.test.tsx src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx
npx vitest run src/main/ipc.test.ts -t "supervision|heartbeat enabled gates|admits .*reports before claiming"
npx vitest run src/renderer/src/App.test.tsx -t "saves Supervisor timeouts and concurrency"
npx vitest run tests/supervisor-layout.electron.test.ts
npm run typecheck
```

### 2026-09-24 生产接线与真实模型失败

本节记录首轮生产接线及较大样本失败；最终补充证据见上一节。下方同日的原型、设计及旧 collector 记录是更早阶段证据。

已接线：Main 手动 IPC 与心跳回调共用 `createProductionSupervisorService`；schema 47 保存来源清单、配置、叶子和导航节点；稳定键分页、项目/会话轮转、Unicode 片段、逐批事务、失败/预算后继续、严格发布判定已进入生产服务。活动及 Preload 增加暂停、继续、分页批次详情；设置存储、App 回调和中英文表单已接通页大小、字符/消息批次上限及软预算。应用仍默认关闭。实现合同和未完成项见[生产接线与剩余边界](./review-scheduling-design.md#0-生产接线与剩余边界)。

确定性验证使用隔离 SQLite、生产 IPC 和可控 Runtime，先于真实请求执行。覆盖超过 20 会话/20 消息的 506 条来源、Unicode 精确重建、手动/自动位置隔离、失败后重开、冻结配置、事务回滚、暂停 signal 到 Runtime、成功批次不重算及历史结果来源。后续增加项目轮转、分页大小不改变语义块、发布失败后复用导航节点、Preload 方法和 UI 操作验证。

真实验证入口为 `scripts/supervision-production-live.cjs` / `.ts`，使用与 Main 相同的生产工厂及 `ModelAgentRuntime`，不使用 `review-algorithm.mjs`。输入为已有只读快照中的完整目标会话，截止时间为 2026-09-23 16:09:45.919 UTC，共 129 条消息；逐消息集合 SHA-256 与原探测清单一致。只将选中会话导入临时产品库，没有复制整份用户库，未打开或改写原库及用户设置。

| 实测项 | 结果 |
| --- | --- |
| 配置 | DeepSeek `.env` 中的 `deepseek-flash`；页大小 17、正文批次 16000、消息上限 50、并发接纳 2、模型超时 180 秒、软预算 600 秒 |
| HTTP | 2 次，均 200；无付费重试、无模型回退、无工具 |
| 结果 | 第 1 批校验并保存，第 2 次输出 JSON 无效；逻辑 run 为 failed，没有完整结果 |
| 来源清单 | 129 条消息，54,979 个 Unicode 码点 |
| 已持久化覆盖 | 16,000 码点；28 条完整消息及 1 条部分消息，共 29 个片段；101 个来源未完成 |
| 已保留输出 | 10 个事件、9 个实体、9 个变化、9 个关系，共 37 条结构化记录 |
| 完整发布 / 自动 checkpoint | 均为 0；此次为手动运行，失败批次没有推进位置 |
| 耗时 | 56,775ms；HTTP 测量仅记录响应头延迟，不能当作完整模型耗时 |
| 完整性 | 临时库 `PRAGMA integrity_check` 为 ok |

私有产物位于系统临时目录 `opencode/review-production-20260924`。`metrics.json` 与只读命令 `node scripts/supervision-production-audit.cjs <外部临时目录>/assistant.sqlite` 可核对上述计数；不在仓库保存正文或凭据。失败响应正文没有保存，尚不能确定 JSON 无效是格式问题还是输出截断；不补造原因。按用户要求未重发失败付费请求，**该 129 条消息样本没有完成真实模型全会话覆盖验收**。16000 字符测试上限也不能视为经过可靠性验证的推荐默认。

已完成的定向命令包括：

```text
npx vitest run src/main/ipc.test.ts -t "production supervision IPC|collects supervision within the exact UI timeRange"
npx vitest run src/main/assistant/supervision-review.test.ts src/main/assistant/incremental-review.test.ts src/main/assistant/supervision-history.test.ts src/main/assistant/supervision-model-pool.test.ts src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisionReviewSettings.test.tsx src/preload/supervision-activity.test.ts
npx vitest run src/main/assistant/assistant-database.test.ts -t supervision
```

前述 IPC 3 项、七文件 45 项及数据库历史 4 项通过。更早一次十文件定向运行 116 项通过，2 项因两个表单保存按钮同名失败；已分别命名并复查相关文件。类型检查、最终定向 lint 和收尾验证在本节后续记录。未运行全量测试、提交或推送，保留已有 dirty 改动。此次没有修改 Agent、远程 Runtime 协议或其取消实现；监督父 signal 使用既有 Runtime 接口，本轮不声称完成远程真实验证。

### 2026-09-24 DeepSeek 全目标会话隔离原型

使用 `.env.deepseek.local` 的 `DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`、`DEEPSEEK_API_KEY`；配置模型及 12 次响应的实际模型均为 `deepseek-flash`。直接调用配置端点，没有 GPT 回退、自动付费重试或工具调用。原型复用 `SupervisionModelPool`，实验并发参数设为 2，实测峰值为 2；没有修改应用设置。单请求超时 180 秒，输出预留 16,384 token，12 次均以 `stop` 结束。

启动前核对旧探测的 PID、创建时间、启动记录及命令路径，终止已取消的全会话 GPT 探测。旧尝试记录 10 次已插桩 HTTP 及 2 次未插桩调用，不计入下表的 DeepSeek 12 次。原始消息复用 `review-full-20260924/sources.private.json`，核验冻结消息集合的 SHA-256 及逐消息重建；未沿用旧 GPT 事实或导航。该快照来自既有 `readOnly`、`query_only` 采集入口，本轮没有打开原库，也未初始化、迁移或写入原库。

| 测量 | 结果 |
| --- | --- |
| 完整目标范围 | 1 个会话，129 / 129 条 user/assistant 消息，8 页；截至 2026-09-23 16:09:45.919 UTC 的冻结快照 |
| 正文覆盖 | 54,979 / 54,979 个 Unicode 码点；本样本 UTF-16 单元数相同；135 个片段、7 个叶子批次，每批正文不超过 8,000 UTF-16 单元 |
| 来源核验 | 重建差异 0、覆盖空洞 0、引用码点区间错误 0 |
| 持久化结果 | 354 条叶子事实、503 条引用；其中一个重复短引文保留 2 个明确标为歧义的候选位置，没有猜选唯一位置 |
| 导航 | 18 组完整索引 354 条事实，每条一次；生成导航前后叶子内容散列一致 |
| 真实调用 | 7 次叶子提取 + 2 次独立检查点选择 + 1 次导航 + 2 次语义评分，共 12 次 HTTP 200 |
| 首批速度 | 并发两请求分别 20.376 / 9.236 秒，首轮 20.420 秒；先保存 16,000 码点并正确返回 partial |
| 叶子速度 | 单请求 9.236..20.376 秒；七请求耗时之和 107.334 秒，含并发重叠，不能当作墙钟耗时 |
| 全实验时间 | 四次执行的进程内耗时合计 111.955 秒；首次请求至末次响应约 333.869 秒，包含检查、修改及人工重启间隔；另两次离线验证合计约 38ms |
| token | 提供商报告输入 188,377、输出 56,009；其中叶子提取为 34,771 / 35,852，其余用于评估及导航；未换算货币费用 |
| 续跑与无变化 | 三个已保存叶子在校验失败后复用；失败批次的已有响应重新本地校验，未再次请求。最终重启复用七批，无变化检查 4.362ms、模型调用 0；独立离线验证 19.826ms、模型调用 0 |

目标会话在旧探测后继续增长，先前记录的 119、123 条与本轮 129 条属于不同读取时点，不能混为同一分母。本轮覆盖完整目标会话，不等于覆盖旧全局区间的 830 条消息、63 个会话，也未测试任务、记忆和知识引用的全量采集。

独立检查点选择请求只看到两半完整原文，没有看到叶子结果，也未注入指定引文。模型返回 125 个检查点，超过要求的每半 24..32 个；排除 2 个原消息中不存在的逐字引文后，评分采用 123 个。第二半的消息回执虽有 64 项，但 ID 集合不匹配，因此仅声称全部 129 条已提交给评估器，不以模型回执证明它逐条读懂。

| 独立检查类别 | 有效检查点 | 模型判为保留 | 遗漏 / 失真 |
| --- | --- | --- | --- |
| 决策 | 46 | 46 | 0 / 0 |
| 修正 | 9 | 9 | 0 / 0 |
| 否定约束 | 1 | 1 | 0 / 0 |
| 未解决事项 | 5 | 5 | 0 / 0 |
| 助手陈述归属 | 62 | 62 | 0 / 0 |

模型评分未报告不受引用支持的事实；离线核验 123 项均有原消息的引用，118 项在所引用叶子中保留完整逐字检查引文，另 5 项依赖语义比较。评估器报告导航短摘要遗漏 69 项叶子细节，相关叶子仍完整保留。评估独立性仅指先从原文选择检查点、再比较输出，提取与评分使用同一模型；缺少人工金标准，否定类仅一项，跨两半的修正关系没有单独审计。这些数字不构成全部事实召回率或“无语义遗漏”的证明。

实际出现两次本地校验失败：重复引文导致叶子拒收，以及评估输出违反检查点数量与引用合同。成功批次在失败后仍可读取；原型为重复引文保存全部候选定位，对无效评估引文明确排除并计数。原始响应保留在临时目录，三次缓存读取不产生 HTTP。确定性测试另外覆盖批次失败、截断、取消和预算暂停后的恢复，未刻意制造提供商失败来增加付费调用。

执行入口为 `scripts/review-deepseek.cjs` / `scripts/review-deepseek.mjs`，共享原型为 `scripts/review-algorithm.mjs`。私有正文、来源、模型响应及 SQLite 均位于系统临时目录；仓库仅包含脚本、合成测试和不含正文的测量记录。产物目录：`C:/Users/jiang/AppData/Local/Temp/opencode/review-deepseek-20260924`。可公开计数见 `metrics.json`、`coverage.json`；私有依据见 `batches.sqlite`、`facts.private.json`、`navigation.private.json`、`gold-*.validated.private.json`、`evaluation-*.private.json`。

复现命令如下。`first`、`finish`、`verify` 启动独立进程，须待上一次退出再运行下一条；`status` 仅读取计数。现有输出目录会复用已保存产物；更换输出目录重跑会新增最多 12 次付费调用。

```powershell
$source = "$env:TEMP/opencode/review-full-20260924"
$output = "$env:TEMP/opencode/review-deepseek-20260924"
node scripts/review-deepseek.cjs first $source $output .env.deepseek.local 2
node scripts/review-deepseek.cjs status $output
node scripts/review-deepseek.cjs finish $source $output .env.deepseek.local 2
node scripts/review-deepseek.cjs verify $source $output .env.deepseek.local 2
node --test scripts/review-algorithm.test.mjs
npx vitest run src/main/assistant/supervision-model-pool.test.ts
npx eslint scripts/review-algorithm.mjs scripts/review-algorithm.test.mjs scripts/review-deepseek.cjs scripts/review-deepseek.mjs
```

10 项原型测试、3 项共享池测试及上述定向 ESLint 通过；没有运行全量测试、提交或推送。测试覆盖分页同序键、Unicode 重建和引用位置、空洞、预算暂停、失败后重开、无变化零调用、来源版本变化、输出拒收、取消以及导航不删除冲突叶子。该原型未接生产 IPC/UI、自动 checkpoint、全局多项目调度或多层汇总；真实请求绕过产品 ModelRuntime。生产实现仍存在下节记录的采集遗漏，未来实现边界见[分块调度设计](./review-scheduling-design.md#12-隔离原型的设计结论)。

### 2026-09-24 模型阶段超时、并发与设计边界

- 本次静态核对当前新代码：报告 `heartbeatReportTimeoutSeconds`、监督 `supervisorOrganizeTimeoutSeconds` 已接入共享校验、设置存储、App/设置表单及 Main 摘要器；整数 30..600 秒、默认 240。报告在等待池前冻结值，监督在摘要器入池前读取值，均在获槽及 Runtime 解析后才计时。完整控制及未覆盖环节见[控制清单](./review-scheduling-design.md#当前超时与调度控制清单已实现)。
- `supervisorModelConcurrency` 已接入同一设置链路，整数 1..4、默认 1；报告与监督共用 FIFO 池，普通聊天排除，降限不终止在途项。报告获槽后才领取，每次到期领取最多一条；租约为 `max(300, 报告超时 + 60)` 秒，实际请求开始前按运行 ID、owner、attempt、claimed 和未过期条件校验并刷新。报告提交或无变化后先释放槽位，再进入下游监督。尚无提供商全局并发、RPM、TPM 或监督层 Retry-After 控制。
- 本轮协作提供的新增验证记录：24 项并发相关测试、33 项租约相关测试及 typecheck、lint 通过。本次文档修订仅核对实现，没有重新执行这些测试；记录未附精确过滤命令，不补造命令或与此前批次相加。
- 实现代理报告：87 项测试、App/IPC 聚焦用例、另 19 项取消测试，以及 typecheck、lint 通过。本次文档修订未复跑这些命令，不将数量相加当作独立用例总数，也不推断全量测试已通过。
- 实现代理报告的真实远程取消验证耗时 30.75 秒，清理后本次拥有的进程为 0。该证据验证相应 Runtime 取消/清理路径，不证明完整分页调度、父级取消、批次持久化或跨重启续跑已经实现。
- 真实用户数据探测结果见下节。两次原始失败耗时与旧 240 秒时限一致，但缺少 abort 原因记录，尚不能证明证据规模是超时根因。
- [回顾分块调度设计](./review-scheduling-design.md)已按用户授权加入完整分页、保留叶子事实/来源、成功批次及位置持久化、预算/失败后继续和严格完成判定。上述调度、存储合同、状态及 UI 仍待实现；当前有界单次成功不等于整个时间区间完整覆盖。

### 2026-09-24 真实会话覆盖与模型小样本

原始数据库以 `readOnly` 和 `query_only` 打开，只读事务内分析，未初始化或迁移。用户所述安装路径不存在；实际安装位于 `D:\Program Files (x86)\GoodBuddy`，数据位于用户配置目录。统计使用当前数据库内 9 月 16 至 23 日记录，并非还原该次运行时的数据库快照。

| 测量 | 结果 |
| --- | --- |
| 区间内会话消息 | 830 条、63 个会话、5 个项目 |
| 手动采集器返回 | 202 条消息、70,491 个 UTF-16 单元 |
| 实际进入当前摘要器 | 100 条消息、17,714 个 UTF-16 单元；覆盖 9 个会话 |
| 目标会话 | 区间内 80 条中仅 20 条进入摘要器；正文覆盖 3,693 / 33,247，即 11.11% |
| 离线完整分块审计 | 123 条消息分为 127 块，重建差异为 0；未对这些块执行模型提取 |
| 只读采集耗时 | 手动 182ms、单批增量 375ms、整个探测 805ms |

整条消息遗漏发生在 SQL 数量限制及服务取前 100 项处；本样本进入摘要器的消息未再发生正文裁剪。100 条来源均缺少 `locator.messageId`，现有会话定位不能代替逐消息覆盖凭据。完整分页与消息定位仍为待实现项。

隔离模型实验使用两条已保存的真实样本，共 814 个 UTF-16 单元，经 `createDefaultModelRuntime` 调用 `gpt-6-astra`。3 次 HTTP 请求均为 200，未付费重试；两次提取耗时 34.665 / 35.413 秒，导航概述 6.703 秒，实验总耗时 76.813 秒。模型输入与原消息逐字一致，要求保留的两处引用及消息引用均核验通过，导航引用两项已保留事实；无变化复查耗时 5.99ms，模型请求为 0。原应用设置在完成时逐字节未变。

两处引文已在提示中明确指定，因此该实验仅验证小样本的引文保留、引用正确性与保留产物，不能证明自由提取完整性、全会话无失真或未来调度器性能。实验采用自定义单来源准入及直接模型 Runtime，未经过完整生产 IPC/UI。原库两次失败运行分别耗时 240.211 / 240.216 秒，监督结果仍为 0；样本成功不等于原问题已修复。

复核产物保存在本机临时目录 `opencode/review-fidelity-20260923-current`：`verification-current/coverage.json`、`live-resolved/live-metrics.json`、`verification-current/verification.json`。执行入口为私有临时脚本 `resume-supervision-probe.cjs` 和 `verify-supervision-probe.cjs`；核验退出码为 0。启动器等待曾超时，最终产物记录三次请求完成且进程随后退出，未因此重发请求。此前依赖加载失败均发生在请求发送前。会话正文及配置副本未加入仓库。

### 既有实现

- 共享监督者契约已接入 Main 服务，模型请求包含系统指令；证据总字符预算为 48,000，输出仍限制为 100KB，并校验本次证据集内的来源引用、输出局部实体 ID 和关系端点。手动回顾当前收集会话、任务、消息已有的知识引用和已确认记忆；记忆使用 `memory` 来源类型。
- SQLite schema 43 包含监督运行、结果、来源、故事线、事件、实体、实体关联和关系表，并保存每次结果的实体与关系内容。来源保存本地 library/document/chunk 或外部 locator 元数据；持久化与升级规则见[技术设计](./technical-design.md)。
- 初版监督者入口只有一个页面页头和四项顶层页签，原有计划、概览、建议及报告当时保留在设置页内部。2026-09-24 已按上文菜单调整迁移内容；手动运行仍通过 Supervisor 通道，未绑定自动计划时也可用。
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

### 2026-09-24 算法设置文档补充

已静态核对共享设置合同、设置存储及隔离原型参数，补充[设置配置清单](./review-scheduling-design.md#4-设置配置清单)和 [UI 交互目标](./ui-design.md#算法配置设置目标)。本次仅更新文档；新增分页、分块、预算、续跑及额度控件均未实现，原型值不作为产品默认。未运行代码、测试、探测或模型调用，未修改应用配置和用户数据库。

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

- 对应 US-S22 至 US-S24：当时设置直接显示完整自动监督配置，并保留运行概览、建议、报告与记录次要面板；2026-09-24 已迁移这些面板并移除内部导航。界面统一中英文命名，保留内部 heartbeat 标识和已有内容。无计划时明确显示仅支持手动回顾，填写草稿不触发保存或运行。
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

- 新批次来源读取按 messageId 返回已保存片段及版本；旧历史缺少消息 ID 时保留会话/时间定位。本地知识引用通过现有 `KnowledgeService` 解析文档/分块，失效时显示不可用；外部引用只使用已保存 locator，不调用远端全库。
- 继续讨论和知识库写入使用现有本地会话队列与知识库实体接口，并要求先预览、再由用户确认提交。侧栏已支持结果直达图谱，尚无可编辑的上下文预览。
- 关系移除保留撤销状态及原始来源；界面没有提供恢复入口。
- 候选集最多 100 个实体，复用依赖模型显式选择；不会自动合并历史重复实体或跨 scope 合并。结果级历史内容已保存，事件滑块仍不重建逐事件的实体演变。Experiment 和完整图谱回放尚未实现；批次暂停/继续已接通。

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
