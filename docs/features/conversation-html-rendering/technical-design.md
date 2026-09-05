# 会话 HTML 渲染技术设计

## 进程和设置边界

`conversationHtmlRenderingEnabled` 属于现有 `ApplicationSettings`。Main 继续通过
版本化 JSON 文件持久化应用设置，IPC 继续复用已验证的
`settings:application:get/update` 通道，Preload 只暴露类型化设置方法。

应用设置格式升级到版本 11。版本 10 及更早设置在读取时补入默认值 `true`，无需保留第二份
状态或独立迁移文件。

## Renderer 数据流

1. `App` 启动时读取应用设置，并把当前值传给每个保活的会话视图。
2. 平台功能 Switch 保存成功后立即更新 `App` 状态。
3. `ChatTimeline` 只为 `role === "assistant"` 且 `state === "complete"` 的正文传入
   HTML 渲染权限；推理始终不传入该权限。
4. `MarkdownRenderer` 识别完整 HTML 回复以及 `html` / `htm` fenced code。
5. 关闭权限或回复仍在流式阶段时，HTML 保持代码文本。

## 静态预览

`StaticHtmlPreview` 不使用 `dangerouslySetInnerHTML`。它先用 DOMPurify 清理文档，再通过
`DOMParser` 移除事件属性、非锚点 `href` 和非内联图片的 `src` / `poster`，最后把结果写入
`<iframe sandbox="" srcDoc>`。

作者样式必须保留：`<style>` 元素和 `style` 属性原样传入预览，不按 `@import` 或 `url()`
关键字整块删除，否则任何带渐变或背景图的回复都会退化成无样式文档。外部样式表和远程
字体、图片的实际加载由 iframe 文档的 CSP 拒绝，不需要在清理阶段重复拦截。

iframe 文档注入严格 CSP：

- `default-src 'none'`
- `script-src 'none'`
- `connect-src 'none'`
- `frame-src 'none'`
- `object-src 'none'`
- `form-action 'none'`
- 只允许内联样式以及 `data:` 字体和受支持的内联位图

同时设置 `referrerPolicy="no-referrer"`。Sandbox 不授予 scripts、forms、popups、
same-origin 或 navigation 权限。预览只在回复完成后创建，并使用 lazy loading。

## UI 与无障碍

预览沿用聊天阅读宽度、语义颜色和共享 `icon-button`。`figure` / `figcaption` 表达预览及其
说明，iframe 具有本地化标题。标题右侧是一个 `role="group"` 图标按钮组，与 Mermaid 图表
操作保持一致：源码按钮暴露 `aria-expanded` 与 `aria-controls`，全屏按钮打开 Modal。

嵌入预览高度固定为 480px，超出部分在框内滚动；查看源码面板使用同一数值作为最大高度。
iframe 无法按内容自适应高度，因为 `sandbox=""` 不含 `allow-same-origin` 或 `allow-scripts`，
主文档既读不到内部文档尺寸，也不能接收上报；全屏预览覆盖需要更多空间的场景。

全屏预览复用 `dialog-focus` 的 `activateModalFocus` 与 `trapTabFocus`，遵循统一 Modal 的
背景 inert、初始焦点落在关闭按钮、Tab 循环、Escape 关闭和关闭后焦点恢复。它渲染的是与
嵌入预览完全相同的清理后文档，不额外放宽 Sandbox 或 CSP。切换回复时，源码面板与全屏
预览按当前 source 派生开合状态，不使用会引发级联渲染的重置 effect。

## 验证范围

- 应用设置默认值、关闭持久化和版本 10 迁移。
- fenced HTML、完整 HTML、关闭后的源码回退。
- 作者 `<style>` 与 `style` 属性在预览中保留。
- 脚本、远程资源、表单和事件属性清理，以及 iframe Sandbox/CSP。
- 源码按钮的 `aria-expanded` 切换，以及全屏预览的初始焦点、背景 inert、Escape 关闭和
  焦点恢复。
- 主 Agent、子 Agent、用户、推理和流式状态边界。
- 从设置 Switch 到当前会话重新渲染的应用级集成路径。
