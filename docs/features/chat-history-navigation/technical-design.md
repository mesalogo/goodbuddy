# 技术设计与测试计划

## 当前边界

`ChatHistoryPane` 当前有两层机制：`messageRenderBatchSize = 80` 控制向上滚动时可访问的历史窗口；`maxRenderedMessageCount = 60` 控制实际挂载的消息组件。当前工作区处于 C 组实验：生产接线直接使用已加载消息总数，并用基于高度估算的 canvas minimap 替代消息区原生滚动条；DOM 窗口化、消息高度占位和锚点恢复保持不变。

minimap（`ChatMinimap.tsx`）的更新路径不经过 React：`scroll` 事件和 `ResizeObserver` 回调同步写入滑块 `transform`，只有滚动区尺寸、消息或行高测量变化时才重绘 canvas；悬停展开改写 `data-expanded` 后重绘一次。React 只在 `ChatHistoryPane` 自身提交时刷新消息数据。

已加载历史的消息数组仍由会话 store 提供。带 `messageSummary` 的会话继续先显示加载状态，由现有 `loadHistory` 路径取得完整历史。这样本实验测量的是滚动历史窗口的变化，不混入存储或 IPC 改造。

## 实验分组

| 组别 | 历史窗口 | DOM 窗口 | minimap |
| --- | --- | --- | --- |
| A 基线 | 每次增加 80 条 | 保留 | 无 |
| B 本阶段 | 当前已加载消息全部可访问 | 保留 | 无 |
| C 下一阶段 | 当前已加载消息全部可访问 | 保留 | 有 |

A 组是已记录的生产基线；B 组是无 minimap 的历史导航实验；C 组是当前工作区实验，待多轮对比和低端机模拟完成后再决定发布范围。

## 功能测试计划

- 100 条消息：打开会话后直接滚到第一条，不出现加载按钮。
- 500 条消息：从底部连续滚到顶部，检查消息顺序、首尾消息和滚动位置。
- 2,000 条消息：在中部、顶部和底部来回滚动，确认高度占位和锚点不跳动。
- 消息交互：展开 reasoning/tool details、输入答案、选择文本、打开附件后滚出再滚回，确认状态保留。
- 流式消息：生成过程中滚动、暂停跟随底部，再回到底部，确认自动跟随行为不变。
- 摘要会话：打开只有 `messageSummary` 的会话，确认仍然先加载历史，不把摘要误当作完整消息。

## 性能测试计划

每个规模至少运行 5 次，分别记录冷打开和已经打开后的滚动表现。低端机模拟沿用已有性能测试配置，结果记录中注明运行环境。

记录指标：

- 会话打开到首屏可交互的耗时；
- 首次滚到顶部的耗时；
- 连续滚动期间长任务和掉帧；
- Renderer 内存峰值和测试结束后的回收情况；
- 实际挂载消息数量；
- 流式输出时输入延迟。

通过条件：B 组功能测试全部通过，实际挂载消息数量仍受窗口上限控制；相对 A 组没有明显的输入、流式输出或滚动回归。C 组还需在同一批数据上确认 minimap 的定位行为和增量性能成本。当前 A/B/C 数据记录在 `progress.md`。

## 验证命令

```text
npm exec vitest run src/renderer/src/ChatHistoryPane.test.tsx src/renderer/src/ChatTimeline.test.tsx
npm run typecheck
npm run lint
npm run perf:app
```

`perf:app` 的具体参数和输出以仓库脚本当前实现为准；无法在自动化环境观察的内存和掉帧指标，需要补充 Electron 手工记录。
