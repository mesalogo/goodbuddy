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

## 网页预览

`StaticHtmlPreview` 将原始 HTML 编码到 `goodbuddy-html://preview/?html=…`，通过 iframe
的 `src` 加载。Main 在应用 ready 后注册 `html-preview-protocol`，只返回 URL 携带的 HTML，
不读取文件、不保留文档缓存，也不提供应用接口。响应为 UTF-8 HTML，并设置 `no-store`。

独立文档避免 `srcdoc` 继承主界面的 CSP。主界面仅在 `frame-src` 中加入预览协议，自己的
脚本和网络策略保持原样。预览不再清理脚本、事件属性、表单或资源地址，也不注入禁用脚本
和网络的 CSP；作者自己提供的 CSP 仍按浏览器规则生效。

iframe 使用 `sandbox="allow-scripts allow-forms"` 和 `referrerPolicy="no-referrer"`。
脚本、外部资源与 fetch 可运行；不授予 same-origin、popups 或顶层导航权限。网络访问仍
受浏览器 CORS 约束。预览只在回复完成后创建，并使用 lazy loading。

## UI 与无障碍

预览沿用聊天阅读宽度、语义颜色和共享 `icon-button`。`figure` / `figcaption` 表达预览及其
说明，iframe 具有本地化标题。标题右侧是一个 `role="group"` 图标按钮组，与 Mermaid 图表
操作保持一致：源码按钮暴露 `aria-expanded` 与 `aria-controls`，全屏按钮打开 Modal。

嵌入预览高度固定为 480px，超出部分在框内滚动；查看源码面板使用同一数值作为最大高度。
iframe 保持不同源，主文档不读取内部尺寸；全屏预览覆盖需要更多空间的场景。

全屏预览复用 `dialog-focus` 的 `activateModalFocus` 与 `trapTabFocus`，遵循统一 Modal 的
背景 inert、初始焦点落在关闭按钮、Tab 循环、Escape 关闭和关闭后焦点恢复。它渲染的是与
嵌入预览完全相同的文档和权限。切换回复时，源码面板与全屏
预览按当前 source 派生开合状态，不使用会引发级联渲染的重置 effect。

全屏 iframe 提供 `tabIndex=0`，共享焦点候选包含 iframe。关闭按钮的正向 Tab 显式进入
预览，支持没有链接的长文；iframe 后的焦点守卫将原生 Tab 返回到后续 Modal 控件或关闭
按钮。守卫本身不作为焦点循环的首尾，通知关闭按钮仍参与循环。

iframe 内的 Escape 不会冒泡到父文档。`registerWindowIpcHandlers` 只在主窗口直接子
`goodbuddy-html://preview/` frame 获得焦点且收到 Escape keyDown 时，向主 Renderer 发送
`window:preview-escape`。Preload 暴露无参数订阅 `app.onPreviewEscape`；全屏组件仅在
自己的 iframe 当前聚焦且所属 Modal 未被 inert 隔离时关闭。组件卸载移除订阅，窗口 IPC
释放时移除输入监听。此路径不授予同源权限，也不暴露原始键盘事件或 Electron 对象。

## 验证范围

- 应用设置默认值、关闭持久化和版本 10 迁移。
- fenced HTML、完整 HTML、关闭后的源码回退。
- 作者 `<style>` 与 `style` 属性在预览中保留。
- 内联与外部脚本、事件属性、CSS、图片、fetch，以及主应用 DOM/Node/应用接口隔离。
- 源码按钮的 `aria-expanded` 切换，以及全屏预览的初始焦点、背景 inert、Escape 关闭和
  焦点恢复。
- 主 Agent、子 Agent、用户、推理和流式状态边界。
- 真实 Electron 中带链接与纯正文 iframe 的进入、正反向 Tab 返回和内部 Escape；通过生产 Main/Preload 事件订阅完成关闭。
- 从设置 Switch 到当前会话重新渲染的应用级集成路径。
