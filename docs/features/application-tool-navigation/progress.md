# 项目活动级联实施进度

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
