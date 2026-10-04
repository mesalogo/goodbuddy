# 应用导航实施进度

## 2026-10-04：新建本地项目必选目录

对应 FR-14 的项目创建入口，规则见 [PRD](./prd.md#fr-14-项目活动汇总)及[界面设计](./ui-design.md#10-项目活动汇总)。创建表单已增加中英文必填提示、无障碍关联及空目录提交检查；共享创建 schema 拒绝空白路径，更新 IPC 使用独立 schema，保留历史空目录项目的保存能力。

- `npx vitest run --project unit src/renderer/src/ProjectSwitcher.test.tsx src/shared/assistant-contracts.test.ts`：57 项通过，覆盖空白目录、目录选择与取消、正常创建、中英文提示、历史空目录设置保存及既有 SSH 界面回归。
- `npx vitest run src/main/ipc.test.ts -t "requires a directory through project creation IPC"`：1 项通过，172 项未选中。调用生产 IPC handler 和真实内存 SQLite，验证空目录创建不写库、有效目录创建落库，以及历史空目录更新成功。
- `npm run typecheck` 和本次修改的 8 个源码／测试文件的定向 ESLint 检查通过。

本次未运行完整测试集或原生 Electron 目录选择器验收，未修改远程主机文档、Agent 或远程连接流程；模型调用 0 次。

## 2026-10-04：归档恢复与右下角进入项目

对应 FR-14、US-E4。生产菜单左栏底部已接入按需归档列表、搜索和逐项恢复，右下角已接入“进入项目”。恢复复用既有归档 IPC，并在项目重新可选前合并目标项目会话摘要；不自动切换当前项目，不改变 Task 状态或启动远程连接。进入按钮复用带离开检查的选择回调。规则见[活动逻辑](./logic-design.md#9-项目活动汇总)和[界面设计](./ui-design.md#10-项目活动汇总)。

本次验证：

- `npx vitest run --project unit src/renderer/src/WorkspaceMenu.test.tsx src/renderer/src/ProjectSwitcher.test.tsx src/renderer/src/workspace-menu-selectors.test.ts src/renderer/src/WorkspacePrimitives.test.tsx`：90 项通过。包含按需 `list(true)`、分类及远程开关、搜索、加载／恢复失败重试、重复提交锁定、预览不导航及全部项目进入目标。
- App 项目／通道相关筛选首次运行 83 项通过，1 条旧断言未包含此前新增的更新时间。修正该断言后运行 `npx vitest run --project unit src/renderer/src/App.test.tsx -t "keeps cross-project counts independent|restores archived|single guarded Magic Notes discard"`，7 项通过，覆盖本地／远程恢复、真实 `setArchived(id, false)` 接线、摘要读取失败重试、原会话恢复和未保存草稿离开检查。
- `npx vitest run tests/overlay-layering.electron.test.ts -t "keeps nested previews"`：真实 Electron App 用例通过。生产 Preload、IPC、SQLite 验证归档恢复、保留历史正文、恢复不切换及进入不新建替代会话；浅深主题分别覆盖 `1280×800`、`1280×480`、`560×640`、`375×480` 的右下角位置、边界和内部滚动，并保留原生浏览器相交遮挡及同页面恢复检查。模型调用 0 次。
- `npm run typecheck`、`npm run lint`、`git diff --check` 通过。未运行全量测试或实机 SSH 连接；本次没有修改 Agent、SSH 协议或 Runtime 路径。Demo 未修改，生产菜单为本次交付对象。

## 2026-10-04：会话更新时间与菜单下方定位

对应 FR-14、US-E1、US-E2。右栏时间按会话 ID 局部订阅，使用实际 `updatedAt` 及侧栏共用格式；仅有活动而无摘要时省略时间。显示文字与提示未变的流式更新不触发 React 提交，跨显示精度更新只提交时间子组件。菜单按完整按钮底边定位，剩余视口高度限制菜单高度，保留内部滚动。规则见[活动界面](./ui-design.md#10-项目活动汇总)及[技术设计](./technical-design.md#12-项目活动汇总)。

本次实际验证：

- `npx vitest run --project unit src/renderer/src/WorkspaceMenu.test.tsx src/renderer/src/workspace-menu-selectors.test.ts src/renderer/src/ProjectSwitcher.test.tsx src/renderer/src/time-format.test.ts`：4 个文件、52 项通过。覆盖中英文当天／当年／跨年格式、提示和 ISO 时间、访问时间不替代更新时间、缺少摘要不读取详情、局部提交与未变化时零提交。
- `npm run typecheck`：Node、Agent、Web 全部通过。`npx eslint src/renderer/src/WorkspaceMenu.tsx src/renderer/src/workspace-menu-selectors.ts src/renderer/src/WorkspaceMenu.test.tsx tests/support/overlay-paths-main.ts` 通过。
- `npx vitest run --project integration tests/overlay-layering.electron.test.ts -t 'keeps nested previews'`：选中的真实 Electron App 用例通过，其余 3 项未选中。浅深主题分别覆盖 `1280×800`、`1280×480`、`560×640`、`375×480`，验证 `8px` 间隔、按钮两行命中、视口边界、时间与状态位置、原生滚轮内部滚动、End 到末行和 Escape 焦点恢复；连续 12 帧几何一致，并检查菜单打开时缩短及恢复窗口。
- 原生浏览器与菜单相交时隐藏、不相交时保持显示；菜单关闭后恢复同一页面及标记。模型调用 0 次。截图和 JSON 保存在临时 `workspace-menu-validation` 目录，已查看桌面、短窗口深色和窄窗口浅色截图。
- 临时换回旧的按菜单高度上移公式后，Electron 用例在首个桌面场景的间隔断言失败（实际 `6px`，要求 `8px`）；恢复最终代码后复跑通过。未运行全量测试，未修改监督者代码。

## 2026-10-04：双行入口合并为单个按钮

对应 FR-14、US-E1 至 US-E3。项目名和活动摘要现在属于同一个 `60px` 按钮，共用键盘焦点、展开状态和菜单关联。点击任一行默认预览当前项目，全部项目范围在菜单内切换；活动描述和按钮外的恢复反馈通过 `aria-describedby` 关联。移除了独立摘要触发引用与入口范围状态，保留最近 10 条及现有活动计数，没有新增轮询。

本次验证：`ProjectSwitcher`、`WorkspaceMenu`、`WorkspacePrimitives` 共 80 项通过；App 活动、审批、问题队列和流式侧栏相关测试 37 项通过；`npm run typecheck` 与 `npm run lint` 通过。真实 Electron overlay harness 在 `1280×800`、`1280×480`、`560×640` 的浅深主题下通过，验证单按钮、空闲与活动状态的 `60px` 高度、第二行点击、菜单布局和 Escape 焦点恢复，模型调用 0 次。

## 2026-10-04：双行入口与菜单布局调整

本节保留此次单按钮更正前的实现与验证记录；现行入口规则见上节。

对应 FR-14、US-E1 至 US-E3。已核对 `ProjectSwitcher.tsx`、`WorkspaceMenu.tsx` 和 `workspace-menu.css`：左上角控件固定高 `60px`，项目名和全局活动为同级按钮，第二行无活动时显示“暂无活动”；恢复反馈位于控件下方并关联可访问描述。左栏搜索框使用 `border-box` 限制边界，两栏之间使用 `--border-control` 分隔线，全部项目及搜索结果补充分组标题，右栏状态工具栏收紧间距。菜单项目行继续按名称、活动、目录分行显示，高度随内容增长。具体规则见[活动界面](./ui-design.md#10-项目活动汇总)。

以下结果由实现方提供，本次文档更新未重跑产品测试：

- 79 项定向组件测试、68 项项目相关 App 测试通过。
- 完整类型检查与修改范围 lint 通过。
- 真实 Electron 在 `1280×800`、`1280×480`、`560×640` 的浅深主题下验证搜索框边界、分隔线、紧凑工具栏、项目三行信息，以及左上角控件在空闲和活动状态下的固定高度与焦点。
- 模型调用 0 次。

最近会话上限已由 5 条调整为 10 条，生产设计与验收条目已同步。最终运行 `npx vitest run --project unit src/renderer/src/workspace-menu-selectors.test.ts src/renderer/src/WorkspaceMenu.test.tsx src/renderer/src/ProjectSwitcher.test.tsx`，3 个文件共 44 项通过，覆盖最近 10 条、活动不占最近名额、已完成筛选超过 10 条，以及完成后保留历史。Demo 文件未修改，仍保留原型的最近 5 条行为。

## 2026-10-04：生产统一工作空间菜单

本节保留首次接入时的历史实现与验证范围，其中最近 5 条为当时上限，现行调整见上节。

对应 FR-14、US-E1 至 US-E3。已核对生产 `WorkspaceMenu.tsx`、`workspace-menu-selectors.ts`、`ProjectSwitcher.tsx` 与 `App.tsx` 差异：项目入口与活动摘要共用菜单，替代独立 `ProjectActivity` 级联。已接入全部项目优先的分类 PageTabs、悬停预览与点击进入、最近 5 条、同排状态筛选与新建会话、真实项目设置和创建、项目三行信息，以及会话期内上次打开记录。预览只用内存数据，项目和会话列表复用共享窗口化；规则见[活动逻辑](./logic-design.md#9-项目活动汇总)与[技术设计](./technical-design.md#12-项目活动汇总)。

最终源码补充：菜单最近时间取最新消息时间与 Store 会话期访问／状态时间的最大值；`recordActivityStatuses` 首次只建立基线，清除完成提醒不更新时间。项目上次打开 ID 仍只保留在内存，获准后的项目进入及新建回调使用 `commitView`，避免重复离开检查。

以下为实现代理提供的验证结果，本次仅更新文档，未重跑产品测试：

- 82 项定向测试通过。
- 31 项选定 App 测试通过。
- 1 项真实 Electron overlay 测试通过，最终场景也在全量测试运行中通过。
- 最终完整 `npm run typecheck`、`npm run lint` 通过。
- 全量 `npm test` 在 600 秒超时前未完成。已结束的 App 文件共 347 项，346 项通过、1 项监督者设置测试失败；`tests/supervisor-layout.electron.test.ts` 也失败。尚无证据将这些失败归为既有问题，全量测试未通过。
- 首次 200 秒尝试报告 `activity-history-repository` worker 失败；第二次截至超时未报告该处失败。同期有并行性能修改，未确定失败原因，也不据此认定已修复。

本次没有性能基准结论。README 保留未提交的工作空间 Demo 描述，并区分生产菜单与旧演示；下方级联菜单记录保留当时实现和验证范围，不再定义当前生产交互。

## 2026-10-01：设备共享入口

新增 `device-sharing`，启用后应用菜单及管理 Modal 均进入主内容区页面；管理行可排序。
首期初始实现没有启用开关，同日后续改为测试阶段默认关闭、可手动启用，不提供常驻开关。
旧顺序通过现有存储归一化追加新项，保留原设置；权威写入要求五项完整顺序。
ApplicationCenter、ApplicationMenu、设置迁移以及 App 入口／排序回归已通过，真实 Electron
从应用中心进入页面并完成后端流程。精确命令、完整范围及全仓测试记录见
[设备共享实施进度](../device-sharing/progress.md)。下方历史四应用记录保留原验证时的范围。

## 2026-09-28: Composer shortcut initialization follow-up

The composer now retains successful shortcut-settings snapshots independently of
the startup app-info request. A failed or pending app-info read no longer drops a
successful shortcut save, and a late startup response cannot restore a disabled
hint. Registration remains authoritative; no default shortcut is advertised when
registration is unavailable. This preserves the existing [composer rule](../../../UI-DESIGN.md#131-聊天).

The failed/pending read regressions reproduced the missing hint before the fix.
The reported screenshot's actual registration status and IPC result were not
captured, so its specific runtime cause remains unconfirmed.

Validation: App, sidebar layout, main IPC, and shortcut-service suites passed
(500 tests, one skipped); `npm run typecheck`, ESLint on the four changed source
and test files, and `git diff --check` passed. The first broader run hit the
60-second command limit; the rerun completed in 95 seconds. No full-repository
suite, native Electron screenshot reproduction, packaging, or OS registration
probe was run for this follow-up.

## 2026-09-28：新建对话与搜索共用一行

已按[会话搜索](./ui-design.md#会话搜索)接入收起与展开状态，移除列表上方的常驻搜索头部。
沿用会话创建、延迟搜索和项目过滤接口。后续按用户反馈恢复默认按钮的聊天加号图标、原有
字号字重和整体左对齐；搜索展开后保留居中的同一图标。快捷键说明移至聊天输入框原生占位文案，
具体规则见[聊天 UI 规范](../../../UI-DESIGN.md#131-聊天)。

本次调整验证：`App.test.tsx` 与 `AppSidebarLayout.test.ts` 合计 316 项通过；最终长标签换行
调整后，布局 5 项与 `magic-notes-capture.electron.test.ts` 1 项复验通过。Windows Electron
在上述 6 种侧栏组合检查原字号字重、左对齐、图标居中、文字无溢出及搜索交互，并验证
原生输入后占位提示隐藏、清空后恢复。App 回归覆盖中英文、生图提示、macOS 快捷键格式、
全局快捷键缺省以及设置保存后的更新和停用。类型检查、修改文件 ESLint 与差异空白检查通过。
未运行全仓测试、打包或 macOS/Linux 原生窗口验证。模型调用 0 次。

此前搜索展开改动的验证记录：

```text
npm test -- src/renderer/src/App.test.tsx src/renderer/src/AppSidebarLayout.test.ts tests/magic-notes-capture.electron.test.ts
npm run typecheck
```

三文件合计 311 项通过。最终动画边界与文字宽度调整后，布局及 Electron 共 5 项、App 搜索
交互 1 项复跑通过，typecheck 通过。Electron 复用现有 App、生产 Preload、IPC 和临时 SQLite
测试环境，以英文界面检查浅深主题下 220px、420px 侧栏和短窗口抽屉，共 6 种组合；检查
展开过程及结束后的右边缘、列表位置、完整按钮文字、原生鼠标与 Escape、自动聚焦、关闭
焦点恢复、点击列表保留关键词及减少动态效果。中文 App 回归同时覆盖标题、正文、项目
过滤和加号创建。模型调用 0 次。

修改文件的 ESLint 与 `git diff --check` 通过。全仓 ESLint 有 10 个错误，均来自本任务未修改
的未跟踪 `sidebar-final-probe.ts` 和 `sidebar-final-run.mjs`。未跑全仓测试、打包程序或
macOS／Linux 窗口验证。中文新增规则经 deai-writing 扫描无阻断项，并已人工核对。

## 2026-10-02：补齐五秒排序检查

会话列表已接入 `useConversationListOrder`，保留实时行数据，定时调整展示顺序。
交互暂停与即时操作规则见[会话置顶与操作菜单](./ui-design.md#会话置顶与操作菜单)。
本地和消息通道共用此 Renderer 路径，未修改 Agent 执行、同步或持久化。

验证命令：

```text
npx vitest run src/renderer/src/use-conversation-list-order.test.tsx src/renderer/src/chat-conversation.test.ts src/renderer/src/App.test.tsx -t "useConversationListOrder|conversation display order|parallel streaming conversations|summary and detail order|sorts pinned conversations|merges persisted pin metadata|dedicated pin update"
```

3 个文件、23 项通过，覆盖五秒边界、连续增量、交互暂停与恢复、立即增删与置顶、
项目／搜索范围切换、计时器清理，以及 App 中本地／通道摘要更新的实际列表接线。
新增 hook 与相关测试的定向 ESLint、`git diff --check` 通过。未运行 Electron 窗口验证。
全仓检查未通过：typecheck 报并行修改中的 `App.tsx:5436` 缺少 `startTransition`；
ESLint 报打包文件及现有会话视图缓存的 refs 错误；`npm test` 在 120 秒后超时。
额外运行的草稿置顶失败测试未通过，实际显示持久化错误而非预期的置顶错误。

## 2026-09-28：并行会话输出时保持列表顺序

修复多个会话交替输出时，左侧列表随每个增量反复换位的问题。展示顺序统一使用消息创建
时间，摘要查询补充只读 `latestMessageAt`。交互规则见[会话置顶与操作菜单](./ui-design.md#会话置顶与操作菜单)，
时间字段与合并边界见[会话列表读取与前端保留](../assistant-workbar/execution-history-storage.md#会话列表读取与前端保留)。
本地及远程事件的更新时间写入、快照合并判定和增量保存保持原实现。

聚焦验证命令：

```text
npx vitest run src/renderer/src/chat-conversation.test.ts src/renderer/src/App.test.tsx src/main/assistant/assistant-database.test.ts -t "conversation display order|parallel streaming conversations|summary and detail order|sorts pinned conversations|merges persisted pin metadata|lists lightweight history|persists only the changed conversation|preserves live .* across snapshot|loads only the opened history"
```

结果：3 个文件、13 项通过。覆盖并行文字增量与完成后顺序、保存时间继续推进、本地和消息
通道的摘要／详情刷新、新消息前移、置顶合并、同时间固定顺序、空会话回退、摘要附带实时
消息及真实 SQLite 摘要时间。历史加载回归继续验证刷新不重复保存未变化的消息。
修改过的 7 个 TypeScript 文件定向 ESLint 通过。中文文档按 deai-writing 自查清单复核。

本轮验证为 App 组件事件回归与真实 SQLite 测试，未进行 Electron 窗口或真实模型调用。
改动仅涉及桌面展示及桌面 Main 的只读摘要，未改变 Agent 协议或桌面到 Agent 的执行路径，
无需部署 Host。全仓 typecheck、ESLint 和 `git diff --check` 通过；全量测试运行十分钟后
超时，期间报告配置摘要和 Agent 离线安装测试失败，未取得全仓测试通过结果。

2026-09-23 文档校正：当前 `heartbeat` 已作为可选应用管理，默认值与执行边界见[应用启停与执行](../conversation-supervision/logic-design.md#应用启停与执行)，设置与导航契约见[技术设计](./technical-design.md#4-应用导航偏好)。下方日期记录保留当时实现与验证结果；其中“心跳始终显示”“无应用级开关”和旧字段删除说明不再代表当前行为。本次仅核对源码并更新文档，未重新执行功能测试。

## 2026-09-18：窄幅单列应用列表

对应 FR-11、US-B6、US-B7、US-D1。管理概览改为紧凑单列横向列表，概览与详情共用 `640px` 最大宽度；左侧显示图标、名称、状态与可换行用途，右侧放置打开、可用的设置及成组排序箭头。行间使用弱分隔线，窄窗口操作换行。保留四应用保存顺序、箭头和拖动规则、知识库与智能心跳始终显示、本机推理监控默认不常驻。现行尺寸与交互见 [UI 设计](./ui-design.md#4-应用中心与共同设置)，下方历史记录保留当时布局。

验证：ApplicationCenter、ApplicationMenu、WorkspacePrimitives 共 54 项测试通过；`npm run typecheck`、`npm run lint`、`git diff --check` 通过。全量 `npm test` 超过 60 秒未取得汇总，不记为通过。

Windows Electron fixture 重新编译当前组件、生产 CSS 与中文翻译，使用真实 ApplicationSettingsStore 及临时 IPC；浅深主题分别检查 1280、960、720、640、375px 目标窗口，实际 CSS 视口因缩放约多 1px。计算布局均为单列且无横向溢出，桌面 Modal 宽度为 640px，四行共八个箭头且均可拖动。原生键盘排序、磁盘顺序读取、详情返回及关闭后的焦点恢复通过。证据为临时目录 `application-rows-Hl3X55/result.json`。截图捕获持续报 `UnknownVizError`，禁用硬件加速后仍失败，因此未完成截图审阅；此 fixture 不作为完整 App、安装包或原生指针拖放验收。

中文改动按 deai-writing 自查清单复核。未修改模型、OCR、任务中心或 Agent 执行逻辑，未调用模型，未创建提交。

## 2026-09-18：收拢通用应用设置入口

对应 FR-11、US-B9。移除魔法笔记页面及本机推理监控停用状态的通用“应用设置”按钮，启用、常驻和笔记评论配置统一从应用中心卡片进入。保留管理应用、设置详情返回导航、模型与连接设置及原业务控件。删除仅用于页面快捷入口的 Context、跳转回调和初始详情参数；停用时仍保留页面挂载状态。现行入口规则见 [UI 设计](./ui-design.md#41-共同应用设置页)，Demo 已移除页面、停用恢复及全局设置中的重复快捷入口。

验证：App 入口与状态同步定向测试 14 项通过；ApplicationCenter、ApplicationMenu、LocalInferencePage、SettingsPanel 共 128 项通过。首次包含完整 App 文件的运行出现两项既有任务审批失败，以及新增笔记测试未启用 fixture 的失败；修正 fixture 后相关定向测试通过。两项审批失败与上次记录一致，本轮未修改。类型检查、全仓 lint、Demo 语法及 diff 检查通过。本轮未运行全量测试或 Electron 窗口验收，未调用模型，未创建提交；保留已有四应用排序、监控名称和默认不常驻改动。

## 2026-09-18：四应用共享顺序

对应 FR-3、FR-11、FR-12、US-B7。四张管理卡片均提供上下移动和拖动，包含关闭、未常驻以及始终显示的应用；卡片、菜单、侧栏共用 `applicationNavigation.order`。知识库和智能心跳保留无开关的始终启用、常驻行为，位置可调整，标签改为“始终显示”／`Always shown`。当前对话、运行记录、设置仍保持系统位置。搜索中箭头按完整顺序移动，拖动禁用。保留此前 `260px` 自适应网格、本机推理监控名称及默认不常驻。

权威设置返回及写入 schema 接受四个 ID 各一次，拒绝重复、未知和缺失项。仅存储读取补齐旧可选应用顺序及部分默认值，保留已有顺序、显式布尔值和无关设置；规则见[持久化与 IPC](./technical-design.md#43-持久化与-ipc)。没有新增存储版本、应用启用字段或第二份导航状态。

验证：`npm test -- src/main/application-settings-store.test.ts src/shared/goodbuddy-config-contracts.test.ts src/main/goodbuddy-config-service.test.ts src/renderer/src/ApplicationCenter.test.tsx src/renderer/src/ApplicationMenu.test.tsx src/renderer/src/LocalInferencePage.test.tsx src/renderer/src/WorkspacePrimitives.test.tsx` 共 127 项通过；App 排序保存、菜单与侧栏同步、外部事件、重开及入口行为的 9 项定向测试通过。包含完整 `App.test.tsx` 的八文件运行共 390 项通过、2 项失败，失败项是任务中心审批测试在折叠列表中找不到任务行（`App.test.tsx` 的 scheduled approvals 场景），本次没有修改该行为。`npm run typecheck`、`npm run lint` 和 `git diff --check` 通过。全量 `npm test` 运行约七分钟仍未得到汇总，已停止本次测试进程；日志复现上述两项失败，不能宣称全量通过。

Windows Electron fixture 使用当前 ApplicationCenter、生产 CSS／中文翻译、真实 ApplicationSettingsStore 和临时 IPC，从旧两项顺序读取后，移动知识库以及关闭且未常驻的本机推理监控，并用新 Store 实例确认磁盘结果。浅深主题各检查 1280、960、640、375px 目标宽度，实际 CSS 视口因缩放多约 1px；均显示八个排序箭头、四个可拖动卡片，无横向溢出，列数分别为三、三、二、一。详情不含排序，返回搜索焦点和重开顺序通过。最终证据目录为临时 `all-app-order-t0hDya`；已查看桌面浅色及窄屏深色截图。此项是组件与存储验证，未验收完整生产 Main／Preload 启动或安装包，原生指针拖放由组件事件测试之外另行验收。

中文文档运行 deai-writing 扫描，无阻断项；对本次改动的复核候选人工检查，保留明确的产品状态与验收限制。未调用模型，未修改模型管理、GPU 指标或 Agent 执行路径，未创建提交。下方记录保留各次实施时的行为，旧“固定位置”“仅常驻项排序”规则已由本条及现行设计替代。

## 2026-09-18：卡片排序与自适应列数

对应 FR-11、US-B7、US-D1、US-D2。上下移动从设置详情移到常驻可选应用卡片，箭头名称及提示包含应用名；首尾、唯一常驻项和保存锁定时禁用对应操作。拖动也仅允许常驻可选应用，固定应用及未常驻项不参与排序。卡片改用 `auto-fit/minmax`，最小宽度 `260px`，Modal 最大宽度仍为 `960px`；启用、常驻及笔记设置继续使用原详情表单。保留本机推理监控名称及默认不常驻改动。

Windows Electron 组件 fixture 使用当前 ApplicationCenter、生产 CSS／中文 i18n、真实 ApplicationSettingsStore 及临时 IPC。浅深主题各检查 1280、960、640、375px 目标窗口宽度，实际 CSS 视口受缩放约多 1px；分别为三、三、二、一列，均无横向溢出。检查排序持久化、详情无排序及返回搜索焦点，并人工查看桌面浅色、窄屏深色截图。证据位于临时目录 `cards-order-fixture-tucKjv`。完整 App 配合已有 Main／Preload 的两次启动尝试未产生窗口，此次 fixture 不作为完整 App 或安装包验收。

`npm run typecheck`、`npm run lint`、`git diff --check` 通过；`npm test -- src/renderer/src/ApplicationCenter.test.tsx src/renderer/src/ApplicationMenu.test.tsx src/renderer/src/LocalInferencePage.test.tsx src/main/application-settings-store.test.ts` 共 66 项通过，覆盖固定／未常驻项、边界、保存锁定、搜索排序及设置入口。全量 `npm test` 在 60 秒后超时，未取得完整结果。中文改动按 deai-writing 自查清单人工复核。未调用模型、修改模型管理或 GPU 指标，未创建提交。

## 2026-09-18：本机推理监控默认不常驻

对应 FR-11、US-B 的默认值与迁移场景。共享导航默认值改为本机推理监控不常驻；新安装和旧设置缺失整个导航配置时采用此值，应用仍默认启用，可从应用菜单及管理 Modal 打开。默认可选顺序及知识库、智能心跳的固定入口规则保持不变。沿用存储版本 12，已有常驻 `true`／`false` 均保留；旧默认值与主动固定没有来源标记，无法区分，不强制取消已有常驻。Demo 初始状态和恢复默认同步。

验证：设置存储、应用中心、菜单、推理 Modal 共 62 项测试通过，App 入口及设置同步 8 项定向测试通过；`npm run typecheck`、`npm run lint`、Demo 的 `node --check` 和 `git diff --check` 通过。全量 `npm test` 在 60 秒后超时，未取得完整结果。中文改动按 deai-writing 自查清单人工复核。本次未启动 Electron 或调用模型，不涉及 GoodBuddy Agent 或远程执行路径；未创建提交，保留此前未提交的名称调整。

## 2026-09-18：统一名称为本机推理监控

对应 FR-16、US-F3。导航、应用中心、应用设置、Modal 标题及关闭按钮统一使用“本机推理监控”，英文应用名为 Local Inference Monitor。现行功能文档与 Demo 名称同步；`local-inference`、API、组件名及服务行为保持不变，下方历史记录保留当时称谓。

验证：应用菜单、应用中心、Modal 的 27 项测试及 App 入口、设置同步相关的 8 项测试通过；`npm run typecheck`、修改源码 ESLint、Demo 的 `node --check` 和 `git diff --check` 通过。Demo 被 ESLint 既有规则排除。中文改动按 deai-writing 自查清单人工复核，仅同步名称及本条验证事实。本次未运行全量测试或启动 Electron 验收窗口排版。

## 2026-09-18：独立推理进程资源采样

对应 FR-16、US-F3。向量 utility process 已按 PID 接入 Electron 真实 CPU 和工作集内存，服务行显示进程范围、PID、百分比及 MiB。ASR 为主进程线程，OCR 为渲染进程 Web Worker，分别显示不能独立统计的原因。采样口径及基线规则见[技术设计](./technical-design.md)。服务 Modal 继续保持单一列表。

本轮验证：资源采样器、Main 服务、向量 Broker、Modal 共 39 项定向测试通过；IPC 与 OCR Bridge 另有 130 项通过，共 169 项。类型检查、修改范围 ESLint、`git diff --check` 通过。全仓 lint 仅报告未修改的 story-graph Demo 的 22 个 `document` 错误；`npm test` 超过 60 秒未完成，不记为通过。中文功能文档 deai-writing 扫描阻断项为 0，复核项中的采样限制和验证边界按事实保留。

真实 Windows Electron 验证直接调用生产 `createEmbeddingUtilityTransport` 和采样器，使用临时 CPU 工作负载：PID 5892 的工作集从 57,769,984 字节变为 63,090,688 字节，区间 CPU 为 98.71%；退出后返回不可用，重启得到 PID 20532 并重新预热。进程刚 spawn 时指标可能尚未登记，返回等待数据。此验证没有加载推理模型，没有调用模型 API，也没有重新验收完整 App 窗口；macOS、Linux 尚未实机验证。改动仅涉及桌面本机服务监视，不影响 GoodBuddy Agent 或远程执行。

## 2026-09-18：本机推理服务监视简化

对应 FR-16、US-F3、US-F5；US-F4 的 Modal 单任务取消入口退役。`LocalInferencePage` 直接显示服务列表，移除任务页签、历史、外部连接和长说明，保留刷新、模型设置及受支持的服务操作。现行定义见 [UI 设计](./ui-design.md#91-本机推理管理)。

当时没有服务级 CPU／内存采样，统一显示“暂不可用”；这一限制已由上方资源采样实现修正。ASR 模型可用时返回 `unknown`，登记活动请求不再将状态覆盖为 `running`。OCR／向量仍使用各自执行模块的状态。操作失败关闭旧确认并刷新，重试时重新确认当前影响；后端任务清单校验和 OCR 忙碌保护保留。

验证结果：

- 定向运行 LocalInferencePage、Main 服务、向量 Broker、OCR Bridge 和 IPC，5 个文件共 165 项通过；App 的本机推理入口和停用恢复场景 4 项通过。
- `npm run typecheck` 和修改范围 ESLint 通过。`npm run lint` 仍报告无关 `docs/features/story-graph/demo.js` 的 22 个 `document` 错误。
- `npm test` 首次超过 120 秒，再次超过 600 秒，均未完成。第二次报告的 App 失败来自旧页签断言，已改为服务列表并定向复验通过；不将全量测试记为通过。
- 中文功能文档按 deai-writing 扫描，阻断项为 0；复核项中的状态限制和操作清单按产品事实保留。

本轮未启动真实 Electron 或调用模型，未重新验证原生窗口排版。改动仅影响桌面本机服务监视，不涉及 GoodBuddy Agent 或远程执行路径。未创建提交，下方历史记录保留当时的 UI 与验证边界。

## 2026-09-17：应用卡片与紧凑详情

对应 US-B6 至 US-B9、US-F3 至 US-F5。已核对 `ApplicationCenter`、`LocalInferencePage`
及其样式：管理改为桌面双列、窄窗口单列卡片，固定应用仅有打开；可选应用提供打开和设置，
关闭时禁用打开。启用、常驻及上下移动位于最大 `640px` 的详情，卡片拖动排序保留。
详情使用紧凑返回标题栏，进入及返回时滚动归顶。本机推理使用内容高度 Modal，列表状态与操作
分区并响应式排列。现行规则见 [UI 设计](./ui-design.md#4-应用中心与共同设置)。

本轮实现验证结果由实现方提供，本次仅更新文档，未重跑产品测试：

- 59 项组件测试及 8 项选定 App 测试通过；`npm run typecheck`、修改范围 ESLint 和
  `git diff --check` 通过。
- 真实 Electron 使用当前 Renderer、已有 Main/Preload、真实 IPC 和隔离配置，四种尺寸、浅深
  主题共 32 个视图无横向溢出；导航、焦点、Escape、背景隔离及详情滚动重置已检查。
- 实机任务列表为空态；有任务及长名称由组件测试覆盖。模型调用为 0，未重跑全量测试，
  未创建提交；此前全量测试与全仓 lint 的失败记录仍保留，不将整体验收标为完成。

实机报告已核对：`C:/Users/jiang/AppData/Local/Temp/opencode/application-cards-review-cUiVAc/result.json`，
截图位于同目录。下方记录保留各轮当时的布局及验证范围，旧单列管理行和旧 Modal 尺寸不作为现行定义。

## 2026-09-17：本机推理改为独立 Modal

对应 FR-3、FR-5、FR-16、US-B1、US-B6、US-F3 至 US-F5。已核对当前 `App.tsx`、
`LocalInferencePage.tsx`、`local-inference.css` 和 `dialog-focus.ts`：常驻入口、应用菜单及管理
Modal 的“打开”均打开独立本机推理 Modal，保留底层工作区；其他内置应用仍打开主内容区页面。
停止、重启和释放使用嵌套紧凑影响确认，复用背景隔离、焦点循环与恢复，按当前层处理 Escape，
操作提交期间禁止关闭及重复执行。具体行为见 [UI 设计](./ui-design.md#91-本机推理管理)。

以下结果由实现代理提供，本次文档更新未重新运行代码测试：

- 180 项定向测试通过。
- `npm run typecheck` 与修改范围的 ESLint 通过。
- 完整 App 测试运行超时，未取得完整通过结果。
- 全仓 lint 仍有 `docs/features/story-graph/demo.js` 的既有 22 个 `document` 全局声明错误。

随后完成真实 Electron 验证：当前 Renderer 源码配合当日已有 Main/Preload 构建，使用隔离配置，
未模拟 IPC。三个入口均保留同一知识库工作区节点；背景隔离、Escape、焦点恢复及窄窗口侧栏
开关回退通过。使用已有本机资产完成 OCR 模型加载与确认释放，推理请求和模型下载均为零。
浅深主题及窄窗口未出现横向溢出，释放确认框约为 480 × 182 CSS 像素，内边距 16px、按钮高 36px。
修正窄窗口关闭按钮换行后再次通过实机检查和 43 项相关测试。证据位于临时目录
`inference-modal-ui-8KJFgQ/result.json` 及同目录截图；未验证重新打包后的应用。

`npm test` 在 240 秒边界停止，未取得全量通过结果；独立复跑心跳数据库测试为 6 项通过、
2 项失败，均为已有的 `duplicate column name: pinned`。下方旧页面截图不作为 Modal 验收证据。
本轮已同步源码与文档，未修改 Demo，未创建提交。

下方保留各轮当时的实现与验证记录，旧主内容区页面及无 props 描述不作为当前 Modal 的行为定义。

## 2026-09-17：生产界面密度与响应式复核

对应 US-B5 至 US-B9、US-F3。已审阅 `abcd-production-08rUQA` 中 A、B、D 的原生产截图。
应用管理从全宽纵向块改为最大 `960px` 的内容高度 Modal：名称旁标明固定／可选状态，桌面操作
同行，窄屏自然换行且排序箭头成组。共同设置统一标签、说明和开关对齐；本机推理改为弱分隔列表。
菜单只调整共享字体和图标层级。展示规则见 [UI 设计](./ui-design.md#4-应用中心与共同设置)。

最终源码验证：

- 应用中心、应用菜单、本机推理、设置面板和共享 UI 的 5 个定向文件共 148 项通过。
- `npm run typecheck`、改动 Renderer 文件的定向 ESLint、`git diff --check` 通过。
- `npm run build:bundle` 成功；最后一处布局修正后，`npx electron-vite build --logLevel error` 再次成功。
- 全仓 `npm run lint` 仍有 `docs/features/story-graph/demo.js` 的 22 个 `document` 全局声明错误，未改动该文件。
- 完整 `npm test` 用时 `648.80s`：4,454 项通过、67 项跳过、2 项失败。失败仍为心跳数据库
  迁移的 `duplicate column name: pinned`，位于未改动的 `assistant-database.ts:9988`；全量测试
  未通过。完整日志位于临时目录 `abcd-polish-tests-VxXZ34/test.log`。

真实 Electron 使用仓库 package 入口、当前生产 Main／Preload／App 和独立用户目录，未替换 IPC。
最终截图与测量位于临时目录 `abcd-production-m9I4Vy`：`1200×775` 下四行约 `75px` 高，管理
内容区 `scrollHeight` 与 `clientHeight` 均为 `420px`，操作同行；`520×740`、`375×667` 下
管理、共同设置和推理内容无横向溢出。已审阅桌面与窄屏浅深色截图、375px 管理和设置截图。
管理行按钮为 `34px`／`36px`，Switch 标签点击区高 `36px`，评论选项保留共享紧凑分段控件。
生产验证覆盖菜单 End／Escape、Modal 焦点保持、页签方向键，以及 Space 切换常驻后重载 Renderer
确认保存。运行报告为同目录 `result.json`，截图为 `A-menu*.png`、`B-manage*.png`、
`C-settings*.png`、`D-inference*.png` 和 `D-tasks.png`。

此次为界面调整，未改后端生命周期；隔离目录没有安装模型，模型请求为 0，仅检查真实服务快照与任务空态。
日志仍有既有字体 CSP 拦截，未捕获 JavaScript 异常。未验证模型启停、安装包或整个项目的功能验收。
工作区原有 Runtime 与 story-graph 修改保留，未创建提交。

## 2026-09-17：轻量应用菜单与两个固定应用

对应 FR-3、FR-5、FR-11、FR-12、US-B5 至 US-B8、US-D1／US-D2。当前生产源码的底部应用中心向上展开轻量锚定菜单，无模态遮罩，只列已启用应用，不按打开历史或常驻状态筛选。点击应用行关闭菜单并打开主内容区；底部“管理应用”打开既有管理 Modal。

[ApplicationMenu](../../../src/renderer/src/ApplicationMenu.tsx) 与 [AnchoredMenu](../../../src/renderer/src/AnchoredMenu.tsx) 承担菜单及键盘、定位；[App](../../../src/renderer/src/App.tsx) 固定依次显示知识库、智能心跳，再显示已启用且常驻的可选应用。[管理 Modal](../../../src/renderer/src/ApplicationCenter.tsx) 中两个固定应用仅提供“打开”，不提供启用、常驻、排序或通用空设置；原工作区配置及心跳单条计划 enabled 不变。

[设置契约](../../../src/shared/application-settings-contracts.ts) 的可选偏好仅包含 `magic-notes`、`local-inference`。未发布草案中的 `knowledgeEnabled`、`heartbeatEnabled` 已删除，不增加迁移或兼容读取。[Store](../../../src/main/application-settings-store.ts) 持久化后发布权威快照的链路保留，包含配置工具写入；重开刷新期间锁定修改，较新快照使迟到的旧读取和保存响应失效。

本节收录本轮提供的最新验证结果；此次文档编辑未重新运行产品测试或模型请求：

- `npm run typecheck` 通过，`npx eslint src` 通过。
- 完整 `npm test` 已结束：4,448 项通过、67 项跳过、2 项失败。两项仍为心跳数据库迁移的 `duplicate column name: pinned`，相关迁移未改动；全量测试未通过。
- 全仓 `npm run lint` 仍有 `docs/features/story-graph/demo.js` 的 22 个 `document` 全局声明错误，属于无关文档 Demo；全仓 lint 未通过。
- Electron fixture 共 8 个主题／尺寸场景通过，覆盖原生键盘、焦点、菜单几何、原生视图遮挡及实际 `ApplicationSettingsStore` 持久化。此证据验证组件 fixture 和真实设置存储，不是完整生产 App 的端到端验收，也不是安装包验收。

完整生产 App 补充验证：`npm run build:bundle` 成功后，以隔离用户目录启动仓库 package 入口，
使用实际 `out/main/index.js`、生产 Preload 和 App，未替换 IPC handlers。已验证上拉菜单、
“管理应用”Modal、两个固定应用仅有“打开”、笔记常驻切换，以及刷新 Renderer 和磁盘配置的
持久化结果；本机推理页通过真实注册 IPC 取得 ASR、OCR、向量和 TTS 状态。已审阅菜单与管理截图。
证据位于临时目录 `abcd-production-08rUQA` 的 `result.json`、`A-menu.png`、`B-manage.png`、
`D-inference.png` 和 `runtime.log`。生产启动日志有字体被 CSP 阻止的消息，未捕获 JavaScript 异常。
此轮未重启整个应用验证持久化；隔离目录没有安装模型，未执行模型启停或模型请求。

A–D 已接入源码并通过上述生产 App 冒烟检查；不将全量测试、安装包及整个计划标为通过。
D 的真实 ASR、OCR、向量引擎证据及最小 Main 接线限制保留在下方原记录中，本次状态读取不扩大
其模型操作验证范围。本机资源监控仍待实现。Demo 的直接 Modal 和知识库／心跳可选设置已过时，本轮未编辑 Demo 文件。

下方为历史记录，保留当时实现、测试结果及限制，旧应用级开关和旧入口描述不作为现行行为定义。

## 2026-09-16：知识库固定入口与设置同步更正

本节更正下方早期记录的现行行为，历史实现和验证记录原文保留，不作为最新修订已重新通过验证的证据。
A–D 的应用中心 Modal、可选应用共同设置、常驻排序及本机推理均已接入生产源码，整体验收边界仍见各次记录。

本次文档核对的源码证据：

- [共享设置契约](../../../src/shared/application-settings-contracts.ts) 将可编辑 ID 限为魔法笔记、智能心跳、本机推理；知识库不参与启用、常驻或排序。版本 12 为未发布分支格式，`knowledgeEnabled` 已移除，无兼容旧草案要求。
- [应用中心](../../../src/renderer/src/ApplicationCenter.tsx) 的知识库行只有“打开”；[App](../../../src/renderer/src/App.tsx) 在首个可选槽位后插入固定知识库，再过滤可选应用。知识库始终显示，原工作区实际配置保留；旧的禁用知识库请求守卫说明已从现行设计中删除。
- [设置 Store](../../../src/main/application-settings-store.ts) 持久化成功后发布 `onChanged`；[IPC](../../../src/main/ipc.ts) 转发完整快照，覆盖[配置工具服务](../../../src/main/goodbuddy-config-service.ts) 的写入。App 重开中心时刷新并锁定修改，较新的事件使在途旧读取和保存响应失效。
- [向量 Broker](../../../src/main/knowledge/embedding-inference-broker.ts) 区分调用方返回与 Worker 执行结束；取消或超时后，执行记录在 Worker 确认或退出前仍占用在途名额并计入活动任务和服务停止影响。

本次仅更新文档并核对源码、链接和文本一致性，未运行产品测试或实机验证，也未发起模型请求。
README 已标明 Demo 中知识库启停、常驻及通用设置描述待独立同步；本次未修改 Demo 文件。

## 2026-09-16：D 本机推理生产接入

对应 FR-16、US-F3 至 US-F5。`LocalInferencePage` 默认导出、无 props，已与中心代理的
`local-inference` 页面入口对接，未修改 App 生产入口或应用启用契约。真实支持范围见
[技术清单](./technical-design.md#111-本机推理任务与执行服务)。ASR、OCR、向量生产请求均登记
生命周期，服务操作和任务取消独立。内置向量 Broker 按模型目录共享；OCR 直接控制持有模型的
Renderer Worker。没有新增任务持久化、虚构进度、资源值或 PID。

验证证据：

- 原始 Vitest 配置运行 App、IPC、应用中心、设置存储、推理服务、ASR、OCR、向量 Broker、
  Worker 和引擎，共 12 个文件、452 项通过。完整 App 测试使用真实页面模块，没有 resolve 替身。
- 收尾新增 OCR 加载失败恢复用例后，11 个定向文件 202 项通过；加上已通过的完整 App 251 项，
  当前覆盖合计 453 项。最终 `npm run typecheck`、D 源码及测试定向 ESLint、`git diff --check`
  均通过；diff 检查仅有工作区已有换行符提示。验证生成的临时 bundle 已清理。
- Windows Electron 隔离用户目录，加载当前页面与生产 CSS、生产 Preload、实际引擎模块，
  通过临时最小 Main IPC 接线运行已安装的 SenseVoice、PaddleOCR、Granite 模型，未修改模型配置。
  最终一轮：3 次向量请求（含完成/取消竞态）、1 次 ASR 静音采样请求、1 次 OCR 图片请求。
  向量返回 384 维；UI 停止、启动后再次推理成功；隐藏窗口保持服务运行；OCR 识别 `HELLO`，
  UI 加载与释放成功；1080px 和 520px 窗口无横向溢出。未调用外部付费模型。
- 实机取消竞态中执行方自然完成，管理页正确保留完成结果；取消确认和共享进程不被终止的分支
  另由 Broker 回归测试验证。停止失败、启动失败重试、新任务影响清单变化由定向测试覆盖。
- 真实向量验证发现浏览器 ONNX `/wasm` 入口无法 fetch 本地资源；Main 改为 Node 条件入口后
  实机推理通过，具体执行错误可回传任务列表。

限制与阻塞：本轮不是打包安装包验收，也未驱动完整生产 App 的所有入口与原生浏览器视图。
实机测试 Main 使用最小接线，完整生产 IPC 注册和 App 接入由上述原始测试及类型检查覆盖。
全量 `npm test` 在 200 秒预算内未结束；已复现心跳迁移两项 `duplicate column name: pinned`，
独立重跑仍失败，和应用设置 v12 期望值无关，未修改该数据库迁移。全仓 lint 仍被并行工作目录
`docs/features/story-graph/demo.js` 的 22 个 `document` 全局声明错误阻塞。不将全量测试或 lint
标为通过。D 不修改 GoodBuddy Agent 或远程执行链路，无远程主机验证要求；没有创建提交。

本节取代下方早期记录中“缺少 LocalInferencePage”的当前阻塞描述，早期验证范围仍保留供追溯。

## 2026-09-16：应用中心、共同设置与知识联动

对应 US-A2、US-B5 至 US-B9。当前源码接入左下角应用中心和独立设置按钮；中心使用设置 Modal
壳层，包含搜索、打开、常驻、拖动及上下移动。四个稳定 ID 为 `magic-notes`、`knowledge`、
`heartbeat`、`local-inference`。应用启用、常驻和顺序独立持久化，固定入口及右侧工具不参与排序。

`ApplicationSettingsStore` 升为版本 12，保留已有 `false` 和评论单选值，为缺失项补默认值。
笔记页与中心使用 `ApplicationSettingsView`；全局笔记入口已移除。保存期间共用锁，失败后读取
确认值，无法确认时锁定修改并允许重新读取。关闭当前应用保留页面挂载及草稿，显示恢复入口。

知识关闭后移除会话知识控件与摘要，保留各会话关联；Main 交互请求入口在授予知识能力及
检索前裁剪新请求范围，不取消已开始的请求。队列派发重新经过同一入口，本机和托管 SSH
分支消费同一个请求对象。未修改 Skills、MCP、专家或本机推理页面与后端实现。

验证记录：

- 合并定向运行 App、IPC、配置与 Renderer 共 10 个 suite，599 项全部通过；随后新增本机推理
  主内容区入口用例，完整 App suite 251 项通过，合计覆盖 600 项；
  App 仍使用下述临时页面契约替身，其余生产代码未替换。
- `ApplicationCenter.test.tsx`、设置、笔记、更新设置、共享界面与浏览器遮挡及配置契约的
  定向回归共 227 项通过；随后增加的保存失败、缺失笔记配置回归与配置契约共 39 项通过。
- `ipc.test.ts` 和中心回归共 127 项通过，包含新请求禁用、在飞请求继续及重新开启的范围恢复。
- `App.test.tsx` 共 251 项通过；因独立负责的 `LocalInferencePage.tsx` 尚未到位，使用临时
  Vitest resolve 插件提供无 props 空组件，仅用于验证 App 壳层，未替代或写入生产页面。
- Windows Electron 使用当前中心组件、生产 CSS、真实 `ApplicationSettingsStore` 与临时
  最小 IPC 桥接验证常驻、排序、启用及重新读取持久化结果。浅深主题各验证 `1200 × 850` 和
  `680 × 560` 窗口，无水平溢出；搜索初始焦点、Escape、关闭焦点恢复及背景隔离通过。
  已审阅窄浅色和宽深色截图；证据位于本轮临时目录的 `application-center-*.png`。
- 全量 `npm test` 的 JSON 报告为 4,153 项通过、4 项失败、67 项跳过，另有 suite 加载失败。
  其中应用配置契约旧快照已修正并定向通过；其余失败包括心跳旧库迁移两项、工作栏终端标题一项。
  终端标题用例随后单独复跑通过，未修改其实现。
  App suite 因缺少 `LocalInferencePage` 无法在原始配置下加载，不能将全量检查记为通过。
- `npm run typecheck` 当前仅报告缺少 `./LocalInferencePage`；`npm run lint` 当前仅报告
  并行工作目录 `docs/features/story-graph/demo.js` 的 22 个 `document` 全局声明错误。
  本轮修改的生产源文件定向 Lint 通过。

剩余集成验证：接入另一实现负责的默认导出 `LocalInferencePage` 后重跑原始 App 测试与类型
检查；完整应用的原生浏览器遮挡和共享 Linux Host 真实请求尚未实测。本轮真实模型调用为 0。
本节不宣称本机推理后端、管理页或整个计划已交付，也没有生成提交。

## 2026-09-16：设置改为大 Modal

对应 [US-A2](./user-stories.md#us-a2-从固定入口进入设置)。设置入口保留底层工作区，关闭后卸载
设置内容；布局、关闭与分类直达规则见 [设置中心 UI 规范](../../../UI-DESIGN.md#138-设置中心)。

`App.test.tsx`、`SettingsPanel.test.tsx`、`WorkspacePrimitives.test.tsx` 和
`browser-viewport-occlusion.test.ts` 定向回归共 389 项通过。`npm run lint` 通过。
全量 `npm test` 完成时为 4,354 项通过、9 项失败、67 项跳过；失败涉及本地 Runtime 复用超时、
心跳旧库迁移、远程恢复及 ProjectSwitcher。共享工作区存在并行修改，最终 `npm run typecheck`
报错位于非本次修改的 `use-unviewed-completions.test.tsx`，未将全量检查记为通过。

Windows Electron 使用临时用户目录、当前 Renderer 源码和已有 Main/Preload 输出，验证窗口
尺寸 `1440 × 960`、`1024 × 700`、`680 × 560`（系统缩放使实际 CSS 高宽略有偏差）。
浅色与深色检查通过：整窗背景隔离、左右分栏、无内容横向溢出、遮罩点击不关闭、原生 Tab 与
Escape、关闭后保留原知识库组件。截图保存在本轮临时验证目录；没有运行打包构建，也未单独
驱动原生 `WebContentsView`，其遮挡规则通过共享检测测试验证。本次未修改 GoodBuddy Agent
或桌面到 Agent 的执行路径，未额外发起真实模型请求。

## 2026-09-16：已完成保留至查看

对应 [FR-14](./prd.md#fr-14-项目活动汇总)、[US-E3](./user-stories.md#us-e3-完成后保留至查看)。
已核对当前工作区 `use-unviewed-completions.ts`、`conversation-activity.ts` 和 `App.tsx` 的
完成通知接入：Renderer 会话内集合、后台 Task 转换、本地及持久化活动运行成功标记、
三类计数，以及聊天、设置和文档可见性条件。行为定义见[活动逻辑](./logic-design.md#9-项目活动汇总)。

活动汇总、完成通知 Hook、项目活动组件、项目选择器及 App 活动集成定向回归共 77 项通过。
覆盖前台完成、后台完成、持久化完成补齐、失败和取消、普通会话入口及级联菜单进入、
设置覆盖聊天、窗口隐藏、历史完成不提醒、查看后刷新不重复提示和下一轮完成。
实际聊天详情加载完成后才清除提示。最终 `npm run typecheck` 与 `npm run lint` 通过。

全量 `npm test` 用 900 秒预算运行，762.20 秒结束：4,365 项通过、3 项失败、67 项跳过。
失败为 `agent-package.test.ts` 离线依赖清单安装内部 60 秒超时，以及
`heartbeat-database.test.ts` 两项迁移的 `duplicate column name: pinned`。
共享工作区存在并行修改，此项未改动这些文件，不将全量检查记为通过。

Windows Electron 43.2.0 / Chromium 150 的当前组件 fixture 验证浅深主题、1280×800 和
375×667、混合状态及仅完成状态，共 8 个场景、112 项检查通过，8 张 PNG 已审阅。
检查包含完成图标、三类计数、原生方向键与 Space、进入回调及移除后的空闲隐藏。
证据为临时目录 `activity-completion-0916-results.json` 和 `activity-completion-0916-review.md`。
此项使用受控活动数据，未验证完整 Main/Preload 真实模型端到端；模型及知识库请求为 0。
本次只修改 Renderer 展示与状态跟踪，本地和远程均消费已有事件／Task 更新，不改变 Agent 执行路径。

## 2026-09-14：菜单独立高度修正

生产菜单移除共用双栏表面，会话层独立定位到选中项目行。打开较长会话列表时，项目层的位置、
宽度与高度保持不变；会话层独立限制窗口边界和滚动。两侧均无法容纳子菜单时使用同层返回交互。

`npx vitest run src/renderer/src/ProjectActivity.test.tsx` 通过 13 项，类型检查与 Lint 通过。
`npm test` 运行 60 秒后超时，未取得完整结果。

最终源码的 Electron 43.2.0 / Chromium 150 组件 fixture 使用生产样式与中文 i18n、模拟活动数据，
深浅主题共 14 个场景、108 条检查通过，覆盖短/60 条会话、两层独立滚动、底部避让、向左展开、
375px 窄屏及 640px 两侧空间不足。桌面项目层打开前后矩形一致，短窗口会话层底部保留 16px。
此项验证实际组件排版和交互，不代表完整 Main/Preload 端到端验证；未修改远程执行路径。

## 2026-09-13：生产活动入口

对应 [FR-14](./prd.md#fr-14-项目活动汇总)、[US-E1 / US-E2](./user-stories.md#6-epic-e统一工作空间菜单)。
本页只记录项目活动入口，不表示应用中心计划已交付。

`App` 已接入 `ProjectActivity` 常驻摘要和锚定级联菜单。会话和项目计数继续使用现有
`deriveConversationActivity` 结果，点击会话继续调用 `openActivityConversation`。未增加
持久化字段、IPC 或 Runtime 状态。项目选择器分组及计数保持原有行为。

组件与 App 定向回归通过 32 项，覆盖空闲入口、稳定项目及 SSH Host 顺序、待处理优先、
跨项目精确跳转、设置离开检查、实时状态清理、键盘返回、外部关闭和窄侧栏焦点。

Windows Electron 视觉 fixture 使用当前 `ProjectActivity`、生产样式和 i18n，活动数据为
受控样例。浅深主题分别验证 `1280×800`、`960×720`、`720×640`、`640×420`、`375×600`；
原生键盘验证 Enter、上下及右方向键、End、两级 Escape、Tab 退出，另测左侧回退和空闲入口。
此项证明组件的实际 Chromium 排版与交互，不代表完整生产 Main/Preload 的端到端验证。

浏览器遮挡复用共享菜单相交机制，组件测试检查相交和非相交结果；本轮未单独驱动原生
`WebContentsView` 可见性。远程 Agent 执行路径未改动，未发出模型或知识库请求。

提交前复核：`npm run typecheck`、`npm run lint` 通过；单独运行
`npx vitest run src/renderer/src/ProjectActivity.test.tsx`，11 项通过。
`npm test` 在 240 秒后超时，超时前 `tests/agent-package.test.ts` 的
`verifies and installs offline dependency inventories larger than one MiB` 用例失败，未取得完整结果。

Demo 已按最新讨论隐藏空闲摘要并移除会话行箭头；生产空闲摘要在下述非驻留修正中对齐。
后续界面修正已移除生产会话行箭头，并为活动摘要与下方新建会话增加 `8px` 间距。

## 2026-09-14：摘要非驻留修正

生产 `ProjectActivity` 在无活动时返回空内容，活动归零时关闭级联菜单；新活动只恢复摘要。
组件回归 11 项通过，覆盖初始空闲、活动归零关闭菜单及活动恢复后不自动展开。
App 的 `project activity integration` 定向回归 18 项通过，类型检查与 Lint 通过。
本轮 `npm test` 在 60 秒后超时，未取得全量结果；未重新执行 Electron 视觉验证。

## 2026-09-14：0.13.2 候选验证

正式发布准备时再次复现 App 问答用例的时序失败。活动摘要改为常驻后，等待该入口出现
不再意味着会话初始化和 Runtime 状态读取已经完成；测试有时点击仍被禁用的发送按钮，
留下未消费的一次性问答 mock，继而影响后续用例。

测试现等待已加载的会话和可用发送按钮，并在每个用例前重置问答及审批响应 mock。
答案重载用例等待提交后的界面状态，而不只等待 API 被调用。未修改生产交互、
未增加固定延时，也未跳过失败用例。相关 20 项连续三轮通过，完整 App 与 Agent
发布说明检查共 227 项通过。

最终候选 `npm test` 通过 4,155 项、跳过 66 项、失败 0 项；`npm run typecheck`、
`npm run lint` 和 `npm run release:notes:verify` 均通过。发布准备未执行本地生产构建、
打包或安装包启动探针，原生包验收由主分支与标签 CI 完成。
