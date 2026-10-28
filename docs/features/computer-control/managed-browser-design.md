# 浏览器自动化升级设计

本设计实现[需求](./managed-browser-prd.md)，遵循[性能原则](../../architecture/performance-principles.md)、[维护约束](../../development/agent-feature-maintenance.md)和 [UI 设计系统](../../../UI-DESIGN.md)。

## 原生显示与 Playwright

右侧继续由 Electron `WebContentsView` 直接显示网页，尺寸、系统 DPI、网页缩放、鼠标、输入法和剪贴板均由原生浏览器处理。Renderer 只提交原有视口租约，不传输或解码网页图像，不转发人工键盘鼠标。

自动化使用固定版本 Playwright 1.64.1 的公开 API：`page.ariaSnapshot({ mode: 'ai' })`、`page.getByRef()`、Locator 操作及 AbortSignal。生产路径不再用自研节点边界算法点击网页。

Electron 在 ready 前开启随机端口的本机 CDP 服务。自动化首次使用时读取当前应用 userData 下的 `DevToolsActivePort`，通过 `chromium.connectOverCDP(..., { noDefaults: true })` 连接；不覆盖现有视口、焦点或下载默认设置。端点留在 Main，不传给 Renderer 或模型。

`getOrCreateDevToolsTargetId()` 与 `Target.getTargetInfo` 精确匹配同一 WebContents。模型只能调用绑定 Page 的工具；不以 URL、页面顺序或当前可见标签猜测目标。最后一个自动化 Driver 释放后断开 Playwright 连接，页面仍由 ElectronSession 管理。

官方 MCP 的共享上下文实验通过，但该候选的普通动作未完整传递取消信号。直接使用 Playwright 公共库，可以保留请求取消语义；工具仍通过 GoodBuddy 已有 MCP 网关提供。

## 状态规则

| 规则 | 对应需求 | 实现 |
| --- | --- | --- |
| L-1 | FR-1、4、5 | 原生网页是显示与人工输入的唯一来源；不增加控制模式或人工输入代理 |
| L-2 | FR-7、10 | BrowserService 保留 Conversation、Tab、请求租约和窗口归属；切换可见页不修改请求绑定 |
| L-3 | FR-2、9 | 自动化同页串行，AbortSignal 传入 Playwright；引用按 Driver 和快照代次校验，不重放失败动作 |
| L-4 | FR-5 | 人工操作直接由 Chromium 处理，AI 后续观察当前页面；DOM 变化由上游定位和失效引用错误处理 |
| L-5 | FR-6 | 普通文件选择不拦截；仅 AI 点击期间临时捕获文件选择事件，模型可随后指定文件；下载由所属 Electron partition 记录 |

## 工具、文件和生命周期

保留原有七个工具入口。`browser_action` 补充复杂动作，`browser_tabs` 提供列出、创建、选择与关闭。`browser_type` 替换字段，空字符串清空；人工输入保持原生插入语义。

用户通过网页原有入口选择文件和下载。下载保存到系统下载目录下的 GoodBuddy 目录，文件名包含唯一标识以避免覆盖；记录归属于原会话。关闭标签不删除已保存文件。文件路径属于桌面设备，远端 Runtime 路径不会自动转换成本机路径。

原生 popup 回调同步登记受管标签，异步完成自动化连接。点击工具等待已登记 popup 的初始化后更新请求绑定。关闭页面释放视口、Driver 和使用租约；最后一页释放 partition 与既有网络资源。

Playwright 连接与所有浏览器句柄由 Main 持有，网页继续使用 sandbox、contextIsolation 和禁用 Node 的既有设置。此变更不增加 Renderer 执行权限。依赖与许可随包交付，无运行时 npm 安装。

## 界面与兼容

`NativeBrowserViewport` 从原工作栏提取视口逻辑，保持原有布局和遮挡处理：Modal 出现时隐藏原生子视图，关闭后恢复原页面。没有 Canvas、隐藏输入代理、接管按钮、控制状态条或新增上传下载工具栏。

截图仅供显式模型工具使用，不能决定用户看到的页面分辨率。网页布局使用原生 DIP，设备像素比由 Chromium 跟随系统；面板尺寸改变后更新原生视图 bounds。

曾实现的独立 Chromium＋JPEG 画面方案已撤回。其画面缩放和交互模式未满足普通浏览器体验，相关渲染、输入转发和控制状态代码已删除。

## 验证

`npm run test:browser` 运行真实 Electron、正式 Preload、原生视口和 Playwright 后端，覆盖 100%／150% DPI、无新增控件、中文输入法、粘贴、iframe、自动滚动、取消、文件操作、弹窗绑定和尺寸变化。设置 `GB_BROWSER_TEST_HOST` 后追加真实 Linux Host 经 SSH 转发调用当前桌面 MCP 网关的检查。

原有工作栏与浮层回归继续验证原生视图遮挡、焦点和页面保留。平台、构建和测试证据只在[实施记录](./managed-browser-progress.md)维护。
