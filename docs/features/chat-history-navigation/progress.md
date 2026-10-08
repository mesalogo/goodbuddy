# 实施进度

## 2026-10-08

- 已确认 80 条限制由 `ChatHistoryPane` 的 `messageRenderBatchSize` 和 `revealEarlierMessages` 驱动。
- 已确认消息窗口化仍以高度占位和最多约 60 条挂载消息为上限。
- 已建立基线、本阶段和 minimap 阶段的对比测试计划。
- 已将生产会话接线改为直接使用当前已加载消息总数，保留 DOM 窗口化。
- `ChatHistoryPane` 与 `ChatTimeline` 定向测试通过：58/58。
- 改动文件定向 web 类型检查和 lint 通过。
- `npm run build:bundle` 通过。
- `npm run perf:app` 通过。本次 B 组测量中，长会话打开交互延迟为 86.9 ms，长会话滚动帧间隔 p95 为 16.9 ms、无长任务；流式输入场景帧间隔 p95 为 16.9 ms，输入延迟 p95 为 17.1 ms。
- B 组第二次运行仍通过：长会话打开交互延迟为 46.9 ms，长会话滚动帧间隔 p95 为 16.8 ms、无长任务；流式输入场景输入延迟 p95 为 19.1 ms。
- App 测试通过 341/349；剩余 8 个失败集中在既有图片附件异步场景，未出现聊天历史窗口相关失败。
- 全局 `npm run typecheck` 仍被既有 `src/main/desktop-storage-electron-fixture.ts:215-217` 类型错误阻断；全局 lint 仍包含生成的 VitePress cache 错误。
- A 组临时恢复后连续两次在 composer 初始化阶段超时，未进入性能场景，因此没有有效 A 组数据，不能据此推导 A/B 数值差异。B 组代码已恢复并重新完成 bundle、定向类型检查、定向 lint 和 58/58 聊天窗口测试。
- 下一步实现 minimap 前仍需先修复性能驱动在 A 组接线下的 composer 初始化问题，或建立不依赖 composer 的长会话专用 benchmark，再进行严格 A/B 测量。
