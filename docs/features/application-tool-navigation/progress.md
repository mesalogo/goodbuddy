# 项目活动级联实施进度

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

对应 [FR-14](./prd.md#fr-14-项目活动汇总)、[US-E1 / US-E2](./user-stories.md#6-epic-e项目活动级联)。
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
