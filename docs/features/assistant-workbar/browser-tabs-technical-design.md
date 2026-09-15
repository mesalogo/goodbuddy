# 浏览器多实例技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 基础多实例已实施，Agent 多 Tab 工具待需求 |
| 版本 | 1.0 |
| 日期 | 2026-09-13 |
| 关联 PRD | [通用助手工作栏与执行空间 PRD](./prd.md) |
| 页签策略 | [助手工作栏多终端页签 PRD](./terminal-tabs-prd.md) |

## 1. 目标与边界

浏览器改为可关闭的多实例工作栏应用。每个工作栏浏览器实例对应一个独立 Browser Tab，拥有
独立页面、导航状态、操作队列、画面状态和元素引用空间。同一 Conversation 下的多个 Tab
共享隔离存储与代理上下文，使登录状态符合常规浏览器预期。

本设计不把多个工作栏 Tab 实现为同一页面的重复入口，不允许用户切换 Tab 后改变正在执行的
Agent 工具目标，也不在首期要求模型主动管理多个 Tab。

## 2. 改造前限制

改造前的链路以 `conversationId` 作为唯一浏览器身份：

- Renderer 只保存每个 Conversation 的一份 `BrowserLiveState`。
- Browser IPC、Preload API 和 `BrowserService` 操作只携带 `conversationId`。
- Main 每个 Conversation 只创建一个 Session、一个 `WebContentsView` 和一个 CDP Driver。
- 请求级 MCP 能力只保存 `browserConversationId`。
- snapshot 元素 `ref` 只在一个 Driver 的引用空间内有效。

因此只把工作栏注册策略改成 `multiple` 会导致多个 Tab 控制同一页面，并产生 viewport、清理和
元素引用竞态，不能作为可交付实现。

## 3. 身份与所有权

```ts
type BrowserTabId = string

type ConversationBrowserContext = {
  conversationId: string
  partitionId: string
  tabs: Map<BrowserTabId, BrowserTab>
  primaryTabId?: BrowserTabId
}

type BrowserTab = {
  id: BrowserTabId
  conversationId: string
  view: WebContentsView
  driver: CdpBrowserDriver
  state: BrowserLiveState
}
```

- Conversation Browser Context 拥有隔离 partition、代理配置和全部 Tab。
- Browser Tab 拥有页面、Driver、串行操作队列、snapshot 代次、idle 状态和可见 viewport。
- `BrowserTabId` 是 Main 签发的不透明 ID。Renderer 和 Runtime 不能自行选择或复用。
- 工作栏实例保存公开的逻辑实例 ID 和 Conversation 绑定；进程重启后不恢复旧
  `WebContentsView`，首次使用时由 Main 为该逻辑实例创建新的 Browser Tab。
- 删除 Conversation 时关闭该 Context 下全部 Tab；关闭一个工作栏浏览器实例只关闭对应
  Browser Tab，不得调用 Conversation 级 Runtime 释放路径。

## 4. Renderer 与 viewport

Renderer 状态改为：

```ts
Record<ConversationId, Record<BrowserTabId, BrowserLiveState>>
```

每个浏览器工作栏实例持有自己的 `browserTabId`。只有当前可见实例可以提交 viewport。每次
获得可见权时生成新的 UUID `leaseToken`；提交请求携带 `browserTabId` 和 token，清理请求必须
回传同一个 token。Main 只接受当前 token 的清理，避免已隐藏实例的延迟 cleanup 隐藏新实例，
也避免 Renderer 重载后从零开始的数字序列无法覆盖旧租约。

非活动 Browser Tab 保持页面和状态，但隐藏 `WebContentsView` 并停止非必要画面采集。工作栏
收起、切换主页面和窗口隐藏时采用相同规则，不销毁 Tab。
普通导航、快照与页面操作只同步轻量导航状态，不自动截图、等待画面或传输 JPEG；只有显式
`browser_screenshot` 调用生成图片。

`BrowserViewport` 统一观察 body Portal 的插入、移除和可见属性变化，以及浮层尺寸、
窗口尺寸、滚动和过渡结束。`browser-viewport-occlusion.ts` 按共享语义识别
`aria-modal="true"`、dialog、alertdialog、menu 和应用通知：可见应用级 Modal 始终释放
viewport，其余浮层只在与浏览器区域相交时释放。隐藏节点和隐藏祖先不阻塞浏览器。
最后一个遮挡消失后，只有当前活动实例恢复同一 viewport 租约；网页、历史和页面状态不变。
终端关闭确认复用此机制，不再维护单独的隐藏条件。页面无需逐个登记弹窗，也不能靠提高
CSS `z-index` 覆盖原生子视图。此逻辑仅涉及 Desktop Renderer 的显示租约，不改变
Runtime、MCP 或远端 Agent 的请求、导航与生命周期。

浏览器应用声明 `visibleAcrossContextSwitches: true`，打开的 Tab 跨项目、会话切换继续显示。
切换活动 Conversation 不改变当前选中的浏览器或其 `targetRef.conversationId`；用户在会话 B
查看会话 A 的浏览器时，viewport 和手动导航仍指向 A 的原 Tab。新建实例绑定 B。仅未绑定的
默认或恢复实例可在首次使用时取得当前会话绑定。

Tab 的跨会话可见性与 MCP 授权分开处理。B 的请求不能选择属于 A 的可见 Tab；A 已取得的
capability 在用户切到 B 后仍固定路由至 A 的原 Tab；使用租约不阻止用户关闭该 Tab。
内部点击实例只同步应用类型，不再次按当前 Conversation 改选实例。Main 状态携带对应的
`workbarInstanceId`，Renderer 据此绑定请求创建的同一 Tab，而不是另建空白页。收到 `stopped`
后清除该实例的旧 Tab 绑定，下一次使用通过原逻辑实例重新创建，保留地址草稿。
刷新可用性读取 Main 的已提交 URL，不使用地址草稿或仅凭 `sessionActive` 判断。
侧栏操作错误以当前工作栏实例和面板展开状态为作用域；切换或关闭时清空，旧作用域的
异步回调不再写入错误，即使用户随后返回同一实例。
请求创建的实例也遵守现有 32 个工作栏页签上限；满额时保留 Main 页面及其状态，并就地提示
关闭一个可关闭页签。释放位置后再绑定该页面，不写入超限布局或丢弃 Agent 页面。

## 5. IPC 与服务接口

共享契约增加有界操作：

```ts
browser.createTab({ conversationId, workbarInstanceId })
browser.listTabs({ conversationId })
browser.closeTab({ conversationId, tabId })
browser.setViewport({ conversationId, tabId, leaseToken, bounds })
browser.navigate({ conversationId, tabId, url })
browser.back({ conversationId, tabId })
browser.reload({ conversationId, tabId })
browser.stopLoading({ conversationId, tabId })
```

Main 必须验证 `tabId` 属于同一 `conversationId` 和当前窗口。BrowserService 将现有
Conversation 级 slot 拆为 Context 与 Tab 两层；同一 Tab 内操作继续串行，不同 Tab 可以并行，
但仍受窗口级和 Conversation 级有界数量限制。

现有 Conversation 级 `stop/release` 保留为销毁完整浏览器上下文的操作，不能用作关闭单个
Browser Tab。

## 6. Agent 与 MCP 路由

### 6.1 兼容阶段

第一阶段不修改模型可见的现有浏览器工具参数。模型请求开始时，Main 按以下顺序选择并冻结
`boundBrowserTabId`：

1. 当前可见且绑定该 Conversation 的 Browser Tab。
2. 该 Conversation 的 `primaryTabId`。
3. 预留 primary Browser Tab 身份，首次实际浏览器操作时才创建页面与 Conversation Context。

未使用浏览器的请求只持有随请求释放的内存预留，不创建 Chromium 资源、不触发浏览器 UI、
也不占用活动浏览器会话名额。物化后使用同一 Tab 身份和工作栏实例归属；取消、能力撤销及
服务关闭释放未使用的预留，不保存到磁盘。编程 Subagent 继承父请求的 Browser Tab 与浏览器
Conversation 归属，不新建租约或把页面重新归属到子级对话。

直连模型上下文和请求级 MCP capability 同时保存 `conversationId` 与
`boundBrowserTabId`。请求执行期间，用户切换、创建或关闭其他工作栏 Tab 不改变工具目标；
用户可直接关闭模型正在使用的 Tab。关闭释放该 Tab 的页面和使用租约，中止其浏览器操作，
不取消整个模型请求、不撤销 MCP capability，也不关闭同级 Tab。系统不得把进行中的操作改投其他 Tab。

关闭后，快照等非导航工具返回“浏览器标签页已关闭，请调用 browser_navigate 打开新标签页”，
不自动创建页面或使用现有 primary/sibling。只有显式且参数有效的 `browser_navigate` 才创建
专用替代 Tab 并绑定后续工具；旧 Tab 身份与元素引用不复用。Gateway 与直连 Provider 均隔离
单次工具取消信号、Tab 使用租约信号和请求信号，取消一次工具调用不终止后续调用。

该阶段 MCP transport、endpoint 和 token 生命周期不变，只扩展服务端 capability 内容和内部
路由。工具调用使用当前请求绑定的 Tab；显式导航恢复和下述点击开窗会更换绑定。

### 6.2 Page-created tabs

`target="_blank"` and `window.open` create managed `WebContentsView` tabs through Electron's
`setWindowOpenHandler.createWindow`. Chromium retains the original request and opener relationship,
including a blank window followed by a script-assigned location. These tabs share the Conversation
partition, proxy and permission restrictions. HTTP(S) URL checks remain in the session and filtering
proxy; `about:blank` is permitted only as the initial empty popup. Unsupported URL schemes remain denied.

BrowserService reserves capacity before creating the native view, assigns a new Tab/workbar identity,
and owns initialization, the Driver and cleanup. Initialization failure or Conversation disposal releases
the popup. Closing the opener leaves an already created popup alive. A popup's `window.close()` releases
its service slot and usage leases; Renderer removes its workbar instance and returns to the opener when
it is still available. No separate unmanaged BrowserWindow is created.

Live state includes `openerTabId`. A popup from the visible browser is selected even when the active chat
has switched to a different Conversation. Other workbar panels and viewport occlusion rules retain their
existing behavior. The existing workbar capacity notification still applies when all 32 slots are occupied.

During `browser_click`, the service collects popup registrations from that Tab and waits for their
initialization. The result identifies the last created popup. BrowserModelTools binds subsequent tools to
that Tab and asks the model to obtain new references with `browser_snapshot`; the MCP gateway also replaces
its capability binding and usage lease. Switching visible tabs does not alter this binding. Closing the
popup retains the existing explicit `browser_navigate` recovery behavior. A page may still be loading
when the click returns. Popups requested asynchronously after the click has completed are displayed as
managed tabs, but are not attributed to that completed tool call.

The remote ACP Runtime exposes its separately scoped image MCP server, not this desktop browser gateway;
this change does not add browser access to the deployed GoodBuddy Agent.

### 6.3 Agent 多 Tab 阶段

只有明确需要 Agent 管理多个页面时，才增加：

- `browser_tab_list`
- `browser_tab_open`
- `browser_tab_close`

导航、snapshot、back 和 screenshot 增加可选 `tabId`；省略时使用请求绑定的默认 Tab。
`browser_snapshot` 返回 `tabId` 和 snapshot 代次。click、type 和 select 必须校验 capability、
`tabId`、引用代次和元素 `ref` 属于同一 Driver，禁止跨 Tab 猜测或解析引用。

## 7. 工作栏创建与快捷入口

- 从“+”选择浏览器时始终创建新工作栏实例，并默认绑定当前 Conversation。
- 没有活动 Conversation 时创建待绑定实例，不创建无归属 Main Browser Context。
- 主侧栏浏览器快捷按钮优先激活绑定当前 Conversation 的最近使用实例；没有匹配实例时创建
  一个。没有活动 Conversation 时激活最近使用的浏览器实例；完全不存在时创建待绑定实例。
- New browser instances use a numbered browser label followed by the active Conversation title, when
  available. The number avoids existing titles; restoring the layout preserves each saved title.
  The address bar shows only that instance's page URL. Binding a numbered instance does not overwrite
  its title; the default unbound browser receives the Conversation label when first bound.
- 关闭工作栏 Browser Tab 只释放对应 Browser Tab。关闭浏览器上下文是独立危险操作，需要
  明确说明会影响该 Conversation 下的全部 Tab 和 Agent 浏览器状态。

## 8. 持久化与恢复

`createTab` reuses a live tab only for the same Conversation and workbar instance ID. A new workbar
instance can adopt the primary tab only when its request creates the Conversation context. An existing
primary, including one opened by an Agent, is not adopted by a new instance. New sibling tabs start at
`about:blank` with no navigation history and share the Conversation's cookie partition.

持久化工作栏实例 ID、顺序、自定义标题和公开 Conversation 绑定，不持久化页面进程、CDP
引用、snapshot、viewport lease、Cookie、Token 或 Main `BrowserTabId`。应用重启后实例显示
未启动状态，展开浏览器面板或 Agent 首次使用时按原绑定创建新 Tab。

绑定的 Conversation 已删除或不可见时保留实例并显示目标失效，不自动绑定当前 Conversation。

## 9. 限制与验收

- 分别限制每个 Conversation 的 Tab 数和每个窗口的总活动 Tab 数；达到上限时在创建前反馈。
- 两个 Tab 的地址、历史、加载状态、截图和元素引用互不覆盖。
- 同一 Conversation 的 Tab 共享登录状态，不同 Conversation 保持隔离。
- 延迟 viewport cleanup 不能隐藏另一个已激活 Tab。
- 一个 Tab 的元素 `ref` 不能在另一个 Tab 中执行。
- 用户切换工作栏 Tab 不改变进行中模型请求的 MCP 浏览器目标。
- 关闭一个 Tab 不释放 Conversation Runtime，也不关闭同一 Conversation 的其他 Tab。
- 关闭已租用 Tab 后，同一 MCP 会话仍可列出工具；旧目标快照报错且不创建页面，显式导航创建
  不同身份的替代 Tab，同级页面、导航状态与其他 Conversation 的可见 viewport 保持不变。
- 旧版无 `tabId` 的模型工具调用仍操作请求绑定的默认 Tab。

## 10. 实施顺序

1. 引入 Browser Context 与 Browser Tab 两层身份，拆分 partition 和页面生命周期。
2. 扩展 Shared、Preload、IPC 与 BrowserService 的 `tabId` 和 viewport `leaseToken`。
3. 改造 Renderer 状态与工作栏实例，开放浏览器 `multiple` 策略和单 Tab 关闭。
4. 将直连模型与 MCP capability 绑定到请求开始时确定的 Browser Tab。
5. 完成跨 Tab 引用隔离、并行队列、共享 Cookie、关闭和恢复测试。
6. 有明确 Agent 多页面需求后再开放模型可见的 Tab 管理工具。
