# 会话 HTML 渲染实现进度

## 已实现

- [x] 应用级持久开关，默认开启，并提供旧设置迁移。
- [x] 平台功能通用设置中的共享 Switch。
- [x] 已完成 Agent 回复和子 Agent 输出中的完整 HTML 与 fenced HTML 识别。
- [x] 隔离静态预览、持续安全说明和源码切换。
- [x] 预览保留作者 `<style>` 与 `style` 属性，样式不再被整块丢弃。
- [x] 与 Mermaid 一致的图标按钮组：源码切换与全屏预览 Modal。
- [x] 嵌入预览固定 480px 高度，源码面板同值上限。
- [x] 用户消息、推理、流式回复和关闭状态的源码边界。
- [x] 设置变更后当前会话立即重新渲染。

## 验证记录

2026-09-05：

- `npm run typecheck`：通过。
- 聚焦测试（应用设置、Markdown、会话时间线、设置中心、App 集成）：306 项通过。
- 全量 `npm test`：`3493 passed, 55 skipped`。
- `npm run lint`：通过。
- `npm run build`：Main、Preload、Renderer 与控制面安装器均成功构建。

修复样式丢失后复验：

- 原实现只要 `<style>` 或 `style` 属性中出现 `@import` / `url()` 就整块删除，带渐变或
  背景图的回复因此完全失去样式；现改为保留作者样式，外部资源加载仍由 iframe CSP 拒绝。
- `npx vitest run src/renderer/src/MarkdownRenderer.test.tsx`：`19 passed`。
- 聚焦测试（会话时间线、App 集成、设置中心）：`260 passed`。
- `npm run typecheck`、`npm run lint`：通过。

新增全屏预览与图标化源码按钮后复验：

- 源码按钮改为代码图标并暴露 `aria-expanded`；新增放大图标打开全屏 Modal。
- 嵌入预览高度由 `min-height: 320px` 改为固定 `height: 480px`，源码面板上限同步为 480px。
- 新增回归测试覆盖全屏 Modal 的初始焦点、背景 inert、Sandbox/CSP 与 Escape 焦点恢复。
- 聚焦测试（Markdown、会话时间线、App 集成、设置中心）：`280 passed`。
- `npm run typecheck`、`npm run lint`：通过。
