# 助手工作栏多终端页签 PRD

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 已实施，跨平台验证中 |
| 版本 | 1.1 |
| 日期 | 2026-08-31 |
| 适用产品 | GoodBuddy 桌面端 |
| 界面归属 | [通用助手工作栏与执行空间](./prd.md) |
| 相关设计 | [统一界面设计系统](../../../UI-DESIGN.md) |
| 远程架构 | [SSH 远程主机与 GoodBuddy Agent 实现说明](../remote-host/technical-design.md)、[SSH Host 远程环境准备与控制面直连设计](../remote-host/environment-provisioning-technical-design.md) |

## 1. 文档职责

本文细化助手工作栏中的以下行为：

- 已打开应用以同级 Tab 呈现。
- Tab 行始终提供“+”入口，用户按需打开应用。
- 应用通过统一注册表声明单实例或多实例策略。
- “终端”作为首个多实例应用，自动使用当前项目的本机或托管 SSH 执行空间。
- 本机与远程交互式终端的生命周期、状态、性能和验收要求。

[通用助手工作栏与执行空间 PRD](./prd.md)
继续负责工作栏的应用级位置、稳定能力目录、执行空间、范围绑定和总体产品边界。本文不重新
定义 Host Key、凭据、Agent 安装、Ask/Execute Runtime 或项目持久化契约。

## 2. 背景与当前问题

当前工作栏在聊天页面右侧固定显示“任务中心、工作区、浏览器、成果”四个 Tab。用户不能：

- 通过统一入口按需打开新的工作栏应用。
- 关闭并重新打开一个工作栏应用。
- 为支持多实例的应用创建第二个独立实例。
- 在 GoodBuddy 内使用本机或远程 Host 的交互式 Shell。

当前代码已经具备工作栏右侧回流、宽度调整、Tab 键盘导航、SSH Host Key 固定、加密凭据和
SSH 连接池，但尚不存在工作栏应用实例模型、终端 IPC、终端 Session Manager 或终端模拟器。
`node-pty` 当前只作为其他 Runtime 的间接依赖被打包，不能视为已经存在用户终端能力。

## 3. 产品定义

### 3.1 工作栏应用

工作栏应用是可以在助手工作栏中打开的一个能力，例如任务中心、工作区、浏览器、成果或
终端。每项应用通过统一注册表声明：

- 稳定应用 ID。
- 用户可见名称、图标和说明。
- `single` 或 `multiple` 实例策略。
- 创建实例时可用的默认上下文。
- 当前不可用时的原因和修复入口。

目录中的应用可发现性与实例是否已经打开相互独立。应用不可用时保留入口并说明原因，不以
隐藏代替状态。

### 3.2 工作栏 Tab 实例

工作栏 Tab 是应用的一次打开实例。每个实例具有独立 ID、标题、应用类型和状态。Tab 行只
显示已经打开的实例，不把全部能力同时渲染为 Tab。

### 3.3 终端实例

每个终端 Tab 对应一个独立交互式 Shell Session：

- 本机终端由桌面 Main 进程管理本机 PTY。
- 远程终端通过现有、已验证的 SSH Host 打开直接 SSH PTY。
- 不同终端拥有独立 Shell、工作目录、输入、输出、尺寸和结束状态。
- 创建后固定到当时选择的执行位置，切换项目不会迁移已经运行的终端。

直接 SSH PTY 是用户操作的远程终端，不是连接期临时 GoodBuddy Agent，也不作为 Runtime
stdio fallback。首期远程终端随 SSH Channel 结束，不提供跨 SSH 或桌面重启的进程恢复。

## 4. 已确认的产品决策

1. 工作栏 Tab 行末尾始终显示“+”按钮。
2. “+”是普通命令按钮，不是一个 `tab`。
3. 点击“+”在工作栏内容区显示“新建工作栏应用”选择页；取消后返回原活动 Tab。
4. 选择应用后创建或激活实例，并关闭临时选择页。
5. 单实例应用已经打开时，再次选择只聚焦已有实例，不创建重复 Tab。
6. 多实例应用每次选择都创建新实例。
7. 终端从首期开始就是多实例应用。
8. 任务中心、工作区、浏览器和成果首期保持单实例；后续只需修改应用注册表策略即可开放
   多实例，不重写 Tab 壳层。
9. 现有四个应用在升级后仍按当前默认布局打开，避免用户入口突然消失。
10. 用户关闭、切换或重排应用 Tab 后，“+”仍保持可见。
11. 选择“终端”后不再显示第二层目标选择器。存在当前项目时直接绑定该项目，由 Main
    根据项目执行空间自动打开本机或托管 SSH Shell；没有当前项目时打开本机 Home Shell。
12. 远程首期使用直接 SSH PTY。SSH 断线后终端进入“已中断”，重新连接会创建一个新的
    Shell，不伪装为恢复旧进程。
13. 工作栏收起、切换主页面或切换 Tab 不终止终端；显式关闭终端 Tab 才终止对应 Shell。
14. 应用重启不自动启动 Shell。恢复的终端 Tab 显示“会话已结束”，由用户显式重新连接。
15. 终端是用户交互表面。Ask/Execute 继续约束 Agent Runtime，不把用户键盘操作误判为
    Agent 工具调用；Agent、自动化和模型不得未经明确用户操作向终端注入输入。
16. 工作栏继续按上位 PRD 提升为应用级容器；切换聊天、知识、魔法笔记或活动记录等主页面
    不销毁 Tab 实例或终端 Session。

## 5. 目标

### 5.1 用户目标

- 在工作栏中随时通过“+”发现并打开应用。
- 同时打开多个本机或远程终端，并通过 Tab 快速切换。
- 清楚知道每个终端运行在本机还是哪个远程 Host、当前目录和连接状态。
- 在终端断线、退出或目标失效后获得准确状态和明确恢复操作。
- 使用键盘完成打开应用、切换 Tab、操作终端和关闭实例。

### 5.2 产品目标

- 用一个可扩展的应用注册表统一单实例与多实例行为。
- 把现有固定四 Tab 迁移为用户实例，而不回归现有任务中心、工作区、浏览器和成果能力。
- 建立真实的 Main/Preload/Renderer 终端生产链路，而不是用普通文本框模拟终端。
- 复用现有 SSH Host Key、凭据和连接池，不建立第二套 Host 管理。
- 保持终端输入输出有序、响应流畅、内存有界，并可靠清理本机和远程资源。

## 6. 非目标

- 不把 GoodBuddy 改造成完整 IDE。
- 不唤起 Windows Terminal、Terminal.app 等外部终端窗口代替内嵌终端。
- 不扫描或导入用户全部 SSH config、目录、Shell profile 或命令历史。
- 不支持任意 `ProxyCommand`、端口转发或 SSH Agent Forwarding。
- 不在打开远程终端时安装、更新或修复 GoodBuddy Agent。
- 不把 Agent 工具调用、Runtime 日志或自动化输出伪装成用户终端。
- 不允许 Renderer 直接访问 PTY、ChildProcess、SSH Client、凭据或 Node API。
- 首期不提供终端协作、录制、云同步、Shell Session 复用、tmux 管理或跨设备恢复。
- 首期不实现底部停靠和独立窗口；本文保留兼容模型，后续按工作栏总 PRD 扩展。
- 首期不通过 GoodBuddy Agent 恢复远程终端，也不为终端复制 Runtime transcript、
  `outcome_unknown` 或模型调用恢复协议。

## 7. 信息架构与“+”交互

### 7.1 Tab 行

```text
┌──────────────────────────────────────────────┐
│ 任务中心 │ 工作区 │ 终端 1 │ 终端 2 │ + │
├──────────────────────────────────────────────┤
│ 当前活动实例内容                              │
└──────────────────────────────────────────────┘
```

- 已打开实例位于一个语义化 `tablist` 中。
- 每个实例使用独立 `tab` 和 `tabpanel`。
- “+”固定在 Tab 行末尾，但位于 `tablist` 之外。
- Tab 过多时实例区域单行横向滚动，“+”保持可见；不换行、不自动隐藏实例。
- 终端 Tab 默认使用递增标题，例如“终端 1”“终端 2”；状态栏持续显示项目、Host、
  工作目录和 Shell。用户可以重命名终端。
- 当前 Tab 同时使用连续内容表面、选中边框、顶部强调线、图标和较高字重，不能只靠文字颜色。
- Tab、关闭按钮、“+”入口、终端面板外框和终端顶部工具栏按钮使用直角，保持停靠式工具界面
  的连续边界，不使用卡片式圆角。
- Tab 关闭按钮默认不争夺视觉注意力，仅在鼠标悬停或键盘焦点进入对应 Tab 时出现；
  粗指针或无悬停设备始终显示，出现与隐藏不得引发布局位移。

### 7.2 新建应用选择页

点击“+”后：

1. 保留当前实例及其运行状态。
2. 在工作栏内容区显示“新建工作栏应用”。
3. 列出稳定应用目录，每项显示名称、说明、单/多实例提示和当前可用状态。
4. 初始焦点进入第一个可用应用；Escape 或“取消”返回原活动实例和“+”按钮。
5. 选择单实例应用时，若实例已存在，直接聚焦该 Tab。
6. 选择终端时直接解析当前项目执行空间，创建新 Tab 并聚焦终端输入，不再要求用户
   重复选择本机或远程目标。

选择页是“+”触发的临时界面，不进入实例顺序，不持久化，也不占用一个普通 Tab。

### 7.3 首期应用注册表

| 应用 | 实例策略 | 升级后默认状态 | 再次从“+”选择 |
| --- | --- | --- | --- |
| 任务中心 | `single` | 打开 | 聚焦已有 Tab |
| 工作区 | `single` | 打开 | 聚焦已有 Tab |
| 浏览器 | `single` | 打开 | 聚焦已有 Tab |
| 成果 | `single` | 打开 | 聚焦已有 Tab |
| 终端 | `multiple` | 不打开 | 每次创建新 Tab |

实例策略是应用注册数据，不能分散硬编码在多个点击处理器中。

### 7.4 Tab 操作

- 点击或使用方向键切换实例不会暂停或终止后台实例。
- 支持左右方向键、Home、End 和 roving `tabindex`。
- 关闭非活动 Tab 后焦点保持在当前活动 Tab。
- 关闭活动 Tab 后激活右侧相邻实例；没有右侧实例时激活左侧实例。
- 关闭最后一个实例后显示明确空状态和“打开应用”，Tab 行仍保留“+”。
- 关闭正在运行的终端需要确认“关闭终端将结束 Shell 及其子进程”；取消是初始焦点。
- 已退出或已中断的终端可以直接关闭，不重复确认。

## 8. 终端创建流程

### 8.1 自动目标解析

- 当前项目是本地项目时，创建目标为公开 Project ID，Main 从权威项目记录解析本机根目录。
- 当前项目是托管 SSH 项目时，创建目标仍为公开 Project ID，Main 再解析项目 Host、
  固定 Host Key、凭据和远端根目录。
- 没有当前项目时使用本机目标和当前用户 Home。
- Host 未验证、凭据不可用或不支持交互式 Shell 时，终端 Tab 就地显示失败原因和恢复入口，
  不静默切换到本机或其他 Host。

### 8.2 本机终端

- 当前项目是本地项目时，默认工作目录为项目根目录。
- 没有本地项目目标时，默认工作目录为当前用户 Home。
- Windows 优先使用可用的 PowerShell 7，其次 Windows PowerShell，最后使用系统
  `COMSPEC`。
- macOS 和 Linux 优先使用当前用户有效的 `$SHELL`，不可用时使用平台常规 Shell fallback。
- 首期自动选择默认 Shell，不提供任意可执行文件路径输入。
- Main 只向 Shell 传递正常交互所需的筛选环境，不注入模型 API Key、GoodBuddy 内部
  Token 或其他产品凭据。

### 8.3 远程终端

- 当前项目是托管 SSH 项目时，自动使用项目 Host 和远端项目根目录。
- Main 复用现有 Host store、完整 Host Key 固定、认证方式和 SSH connection pool。
- 远端通过 SSH PTY 打开账号的登录 Shell，并支持输入、ANSI 输出和窗口尺寸同步。
- 活动终端持有专用 Channel lease，不得被连接池空闲回收。
- 不把密码、私钥、认证头或 GoodBuddy 模型凭据发送给 Renderer 或写入终端环境。
- Host 地址、用户、凭据或 Host Key generation 变化时，旧 Session 进入“已中断”，新建
  Session 必须使用 Host store 中的当前身份。

### 8.4 创建结果

创建成功后：

- 新 Tab 插入当前活动 Tab 右侧并立即激活。
- 焦点进入终端输入区域。
- 状态栏显示“本机”或 Host 名称、工作目录、Shell 和连接状态。
- 终端尺寸使用内容区计算出的首个有效 `cols/rows`，不是固定默认值覆盖实际布局。

创建失败时在终端 Tab 保留错误上下文并提供重试；不得留下不可回收 Session 或显示为已经连接。

## 9. 终端交互与状态

### 9.1 基础交互

首期支持：

- 真实 TTY 输入与 ANSI 输出。
- 中文输入法、组合字符和常规键盘快捷键。
- 复制、粘贴、全选、搜索、清屏和滚动。复制与粘贴通过桌面 Main 进程访问系统文本剪贴板，
  不依赖 Renderer 的浏览器剪贴板权限。
- 工作栏宽度或窗口尺寸变化后的 PTY resize。
- 终端重命名。
- 显式关闭、退出后重新打开和远程中断后重新连接。

浏览器原生页面快捷键与终端按键冲突时，终端聚焦期间优先交给终端；应用级保留快捷键必须
有明确规则和可访问说明。

### 9.2 状态模型

```ts
type TerminalSessionState =
  | 'starting'
  | 'running'
  | 'exited'
  | 'interrupted'
  | 'closing'
  | 'failed'
```

- `starting`：正在创建本机 PTY 或 SSH Channel。
- `running`：允许输入和 resize。
- `exited`：Shell 正常或带退出码结束，显示退出码或信号。
- `interrupted`：远程连接、Host identity 或桌面生命周期导致会话失效。
- `closing`：已拒绝新输入，正在回收进程或 Channel。
- `failed`：Session 未成功开始或发生不可恢复错误。

高频输出不逐行进入 live region。只播报连接成功、连接失败、已中断和 Shell 已退出等重要
状态变化。

### 9.3 重新连接

- 本机或远程 Session 结束后，“重新打开”在同一 Tab 中创建全新的 Shell Session。
- 远程断线后的按钮文案为“重新连接并新建 Shell”，不能暗示恢复旧进程。
- 新 Session 使用 Host store 和项目中的当前有效配置，不复用旧 Host identity。
- 重新连接前清空旧终端画面，并保留可见说明“这是新的 Shell 会话”。

## 10. 实例、Session 与持久化

工作栏实例与运行 Session 分离：

```ts
type WorkbarAppDefinition = {
  id: 'tasks' | 'workspace' | 'browser' | 'results' | 'terminal'
  instancePolicy: 'single' | 'multiple'
}

type WorkbarTabInstance = {
  id: string
  appId: WorkbarAppDefinition['id']
  title: string
  targetRef?: {
    type: 'project' | 'local'
    id?: string
  }
}
```

- 持久化工作栏打开状态、Tab 顺序、活动实例、应用 ID、自定义标题、公开目标引用和宽度比例。
- 不持久化终端正文、未执行输入、凭据、环境变量、PTY PID、SSH Channel 或派生 Host
  identity。
- Main 创建终端后返回新的不透明 Session ID；Renderer 不能选择 PID 或 Channel。
- 应用重启恢复终端 Tab 描述，但状态为“会话已结束”，不自动建立 SSH 连接或启动本机
  Shell。
- 运行期间切换项目不会改变已经创建的终端目标。用户需要新目标时通过“+”创建新终端。

## 11. 生命周期与关闭语义

| 用户或系统动作 | Tab | Shell Session |
| --- | --- | --- |
| 切换 Tab | 保留 | 继续运行 |
| 收起工作栏 | 保留 | 继续运行，停止非必要高频 UI 工作 |
| 切换主页面 | 保留 | 继续运行 |
| 切换项目 | 保留并显示原目标 | 继续在原目标运行 |
| 关闭运行中的终端 Tab 并确认 | 删除 | 结束 Shell 和子进程 |
| Shell 自行退出 | 保留 | 标记 `exited` |
| SSH 断线 | 保留 | 标记 `interrupted` |
| 删除或修改目标 Host | 保留 | 关闭旧 Channel 并标记 `interrupted` |
| Renderer 销毁或应用退出 | 下次恢复描述 | 在总关闭截止时间内回收 |

关闭操作必须安全处理竞态。Main 停止接受新输入，关闭 stdin/Channel，先正常结束，再在既有
应用关闭截止时间内升级清理；一个卡死终端不能无限阻塞应用退出。关闭后的迟到 ACK 视为已
完成，input、resize 或重复 close 返回 Session 不存在，不操作其他 Session。

## 12. 技术生产路径

### 12.1 Shared

新增独立终端契约，至少覆盖：

- `create`：目标引用、初始 `cols/rows`。
- `write`：Session ID 和有界输入。
- `resize`：Session ID、`cols/rows`。
- `close`：Session ID。
- `snapshot`：目标、状态、Shell、目录和终态。
- `event`：带 Session ID 和单调序号的输出、状态、退出与错误事件。

所有 Schema 使用 Zod 严格校验，并限制 ID、标题、输入、尺寸、事件块、会话数和缓冲字节。

### 12.2 Main

新增统一 `TerminalSessionManager`：

- Session 按所属 `webContents` 和不透明 ID 隔离。
- 将现有间接 `node-pty` 提升为 GoodBuddy 直接生产依赖，并用于启动平台 Shell。
- 远程使用现有 `SshConnectionPool` 打开交互式 PTY Channel。
- 统一处理 write、resize、close、exit、连接中断和应用退出。
- 终端输出只发送给所属窗口。
- 复用现有子进程树终止思路，但针对 PTY 验证 Windows 与 POSIX 的实际回收行为。

### 12.3 Preload 与 IPC

- `DesktopApi` 只暴露显式 `terminal.create/write/resize/close/getSnapshot/onEvent`。
- Main Handler 对每个调用执行可信 sender 检查和共享 Schema parse。
- Preload 管理事件订阅释放，不暴露 `ipcRenderer`、PTY、SSH Client 或 Node API。

### 12.4 Renderer

- 使用 `@xterm/xterm` 6 和官方 fit/search addon 处理 ANSI、光标、选择、IME、搜索、
  滚动和可访问输入，不自行实现终端转义状态机。
- 终端首次打开时按需加载；支持 WebGL2 时使用官方 WebGL renderer，初始化失败或 Context
  丢失时释放 WebGL addon 并回退到 xterm 默认 renderer。
- xterm 使用解析后的跨平台系统等宽字体栈，不能把未解析的 CSS `var(...)` 交给 Canvas。
- Tab 壳层只管理实例与焦点，不持有 PTY 或 SSH 对象。
- `ResizeObserver` 只在有效非零布局后发送去重后的 `cols/rows`。
- 组件卸载时退订画面事件；只有显式关闭终端才调用 Session close。
- 终端样式复用全局语义颜色、边框、焦点和字体令牌，不创建另一套工作台设计系统。

### 12.5 输出顺序与背压

- 输出按 Session 分区并携带单调序号。
- Main 合并小块输出，限制单事件大小、待发送条目和总字节。
- Renderer 确认已经消费的序号；慢消费者达到上限时暂停 PTY/SSH stream，消费后恢复。
- 不通过丢弃中间输出维持界面响应，因为丢失字节会破坏终端状态。
- Renderer 只保留有界滚动历史；清屏不改变 Main Session 生命周期。

## 13. 权限与边界

- 用户终端以当前本机账号或所选 SSH 账号的正常权限运行，不增加额外虚构的 trust tier。
- Ask/Execute 是 Agent Runtime 模式，不自动改变用户直接操作终端的 OS 权限。
- UI 必须持续将其标注为“用户终端”，避免被理解为 Ask Runtime 的只读输出。
- Agent、模型、监督器和自动化不能调用终端 write，也不能把指令注入已有 Session。
- 终端输出不会自动进入对话上下文、模型 Prompt、成果或活动记录。
- Renderer 只能引用项目和 Session 的公开 ID；Main 从权威 store 解析目录、Host、凭据和
  当前 Host identity。
- 不接受 Renderer 提交任意 Shell 可执行路径、SSH 命令、PID、环境变量集合或原始凭据。
- 保持 Electron `contextIsolation`、sandbox 和禁用 Renderer Node integration。

## 14. 错误与反馈

- 创建失败、断线、Shell 退出和目标失效保留在终端面板，提供就地重试。
- 不与全局通知重复显示同一终端错误。
- 非局部错误，例如无法保存工作栏布局，可以进入应用通知。
- 错误文案说明发生了什么、当前 Shell 是否仍在运行、用户可以做什么。
- Host Key 变化沿用现有 Host 管理流程；终端只显示“主机身份已变化，请重新验证”，不在
  终端内复制凭据或 Host Key 修改流程。
- 目标不可用时保留 Tab 名称和目标，不静默切换到本机或其他 Host。

## 15. 性能与资源要求

- 工作栏切换和终端输入在正常负载下保持即时反馈，持续输出不能阻塞主界面导航。
- 同一窗口的活动终端数量必须有明确上限；达到上限时阻止新建并说明先关闭不用的终端。
- 每个 Session 的输出队列、Renderer 滚动历史和 IPC 单事件均有硬上限。
- 工作栏不可见时可以降低渲染刷新频率，但不能丢失终端协议字节或暂停 Shell 本身。
- 应用退出复用现有总清理截止时间，不因终端新增无界等待。
- 生产构建必须实际加载本机 PTY 原生模块；不能只验证文件存在。
- 远程终端不能使 SSH connection pool 的空闲项、Channel 或监听器泄漏。

具体数值在共享契约和性能测试中确定，以现有 IPC、窗口和关闭预算为上限，不在多个进程中
维护不同常量。

## 16. 无障碍与响应式

- Tab 使用 `tablist/tab/tabpanel`；“+”使用带可访问名称“打开工作栏应用”的普通按钮。
- 应用选择页使用可键盘操作的列表或菜单语义，不使用 `SegmentedControl`；终端没有重复的
  目标选择页。
- 每个终端 Tab 的可访问名称包含自定义名称或位置，多个终端不能都只读作“终端”。
- Tab 关闭后焦点移动到确定的相邻 Tab；取消创建后焦点返回“+”。
- 工作栏收起后焦点返回唯一工作栏开关，不增加焦点陷阱或遮罩。
- 终端高频输出不逐行播报；只播报连接、退出、失败和中断。
- 200% 文字缩放时，目标、Shell、目录、状态和关闭操作仍可访问。
- Tab 单行横向滚动，终端内容随工作栏尺寸变化并同步 PTY，不把 Tab 换成下拉框。
- 深色和浅色主题都使用设计系统语义令牌，并保持终端文本、选择和光标可辨。

## 17. 实施顺序与多代理工作包

功能必须以完整的本机和远程用户流程交付。以下是可并行的开发工作包，不表示可以发布只有
Schema、假数据终端或不可用入口的中间产品。

### 17.1 依赖顺序

```text
契约冻结
  ├─ 工作栏实例壳层
  ├─ 本机 PTY 后端
  ├─ SSH PTY 后端
  └─ 终端 Renderer
          ↓
单一集成负责人完成 Main/Preload/App 接线
          ↓
完整验证、真实 Host 验收与文档同步
```

### 17.2 文件所有权

| 工作包 | 主要职责 | 建议文件所有权 | 不应修改 |
| --- | --- | --- | --- |
| 契约与注册表 | Workbar/Terminal Schema、状态、测试 | 新建 `src/shared/workbar-contracts.ts`、`terminal-contracts.ts` 及测试 | `App.tsx`、`ipc.ts`、Preload |
| 工作栏壳层 | 动态实例 Tab、“+”、选择页、单/多实例和焦点 | 新建工作栏组件及其测试 | PTY、SSH、Main IPC |
| 本机终端后端 | 本机 PTY、输入、resize、退出和进程树清理 | 新建 `src/main/terminal/` 本机文件及测试 | Renderer、远程 Agent |
| SSH 终端后端 | SSH PTY、lease、resize、断线和 Channel 清理 | 新建 `src/main/terminal/` 远程文件及聚焦测试 | 工作栏 UI、Agent 协议 |
| 终端 Renderer | 模拟器、IME、搜索、复制粘贴、状态栏和 resize | 新建终端组件、样式和测试 | Main、SSH、中心 IPC |
| 集成 | 依赖、IPC channel、DesktopApi、Preload、Main 注册、`App` 接线与关闭顺序 | `package.json`、lock、`ipc-channels.ts`、`contracts.ts`、`preload/index.ts`、`main/ipc.ts`、`App.tsx` | 不重写各包已验收内部逻辑 |
| 验收与文档 | E2E、跨平台构建检查、真实 Host、最终文档 | 测试与相关文档 | 不用假实现替换生产路径 |

中心文件只能由集成负责人修改，避免多个代理同时编辑 `App.tsx`、`main/ipc.ts`、
`shared/contracts.ts`、`preload/index.ts`、`package.json` 和 lockfile。

### 17.3 并行开发门槛

契约负责人先冻结：

- 应用注册和实例策略。
- Terminal request、snapshot、event 和 error code。
- Session 所有权和关闭语义。
- 输出序号、ACK 与容量常量。

其他代理基于冻结契约工作。接口偏差由集成负责人统一修正，不由多个代理分别修改共享中心
文件。

## 18. 验收标准

### 18.1 工作栏应用与实例

- [ ] Tab 行末始终显示“+”，包括没有任何打开实例时。
- [ ] 点击“+”显示稳定应用目录，取消后返回原实例并恢复焦点。
- [ ] 选择已打开单实例应用只聚焦已有 Tab。
- [x] 连续选择终端会创建多个互相独立的终端 Tab。
- [ ] 关闭、切换和重排实例后，“+”仍保持可用。
- [ ] Tab 溢出时单行横向滚动，不隐藏“+”或把 Tab 换成下拉框。
- [x] 关闭活动 Tab 后激活正确的相邻 Tab 并恢复焦点。
- [x] 当前 Tab 的背景、边框、顶部指示和字重清晰可辨；关闭按钮仅在悬停、焦点或无悬停
  设备上出现，且不引发布局位移。
- [ ] 升级后现有任务中心、工作区、浏览器和成果仍按默认布局打开且行为不回归。
- [ ] 在所有主要页面都能打开工作栏；切换主要页面不会销毁 Tab 实例或终端 Session。

### 18.2 本机终端

- [x] 从“+ → 终端”直接打开当前本机项目的真实交互式 Shell，工作目录为项目根。
- [ ] 没有项目时从用户 Home 打开本机 Shell。
- [ ] `pwd` / `Get-Location`、交互输入、ANSI 颜色、中文 IME、复制和粘贴工作正常。
- [ ] 调整工作栏和窗口尺寸会更新 PTY `cols/rows`，全屏 TTY 程序正确重绘。
- [ ] 多个本机终端的输入、输出、目录和退出状态互不串线。
- [ ] Shell 有活动子进程时关闭 Tab，确认后回收完整进程树；取消后 Session 继续运行。
- [ ] 退出后的 Tab 显示退出码，并可在同一 Tab 显式创建新 Shell。

### 18.3 远程终端

- [ ] 从“+ → 终端”直接为当前托管 SSH 项目打开真实 SSH PTY。
- [ ] 终端持续显示 Host、远端目录、Shell 和连接状态。
- [ ] 使用现有固定 Host Key 和已存凭据，Renderer、日志和命令参数不出现凭据。
- [ ] 输入、ANSI、中文、复制粘贴和 resize 在真实 Host 上工作正常。
- [ ] 活动远程终端不会被 SSH connection pool 空闲回收。
- [ ] SSH 断线立即标记“已中断”并拒绝继续输入，不显示为仍在运行。
- [ ] “重新连接并新建 Shell”明确创建新 Session，不宣称恢复旧远端进程。
- [ ] Host 删除、地址/用户/凭据或 Host Key generation 变化会中断旧 Session；新 Session
  使用当前 Host identity。

### 18.4 生命周期、性能和边界

- [ ] 收起工作栏、切换主页面、切换 Tab 或切换项目不会终止已有终端。
- [ ] 终端不会随项目切换静默迁移执行位置。
- [ ] 应用重启只恢复终端 Tab 描述，不自动连接或启动 Shell。
- [ ] 输出顺序在持续大输出下保持正确，Main 和 Renderer 内存保持有界，主界面仍可操作。
- [ ] 慢 Renderer 触发暂停和恢复，不丢弃中间终端字节。
- [ ] Renderer 不获得 raw PTY、ChildProcess、SSH Client、PID、环境变量或凭据。
- [ ] Agent、模型和自动化不能向已有用户终端注入输入。
- [ ] 窗口销毁和应用退出在既有关闭截止时间内回收本机进程、SSH Channel 和监听器。
- [ ] 重复 close、迟到 input/resize 和退出竞态不会操作其他 Session 或导致进程泄漏。

### 18.5 设计、无障碍和跨平台

- [ ] 仅使用键盘可以打开应用、创建终端、切换和关闭 Tab、复制、粘贴及重新连接。
- [ ] Tab、“+”、选择页和关闭确认使用正确语义并有可见焦点。
- [ ] 终端输出不逐行进入 live region，关键状态变化可被辅助技术感知。
- [ ] 浅色、深色、200% 文字缩放和窄窗口下可以完成核心流程。
- [ ] Windows、macOS、Linux x64 和 Linux arm64 的正式构建实际启动本机 PTY。
- [ ] 远程链路在共享 Linux x64 真实 Host 上完成创建、输入、resize、断线、重连、关闭和
  应用退出验证；若 Host 不可达，远程终端不得标记为完成。

## 19. 验证计划

### 19.1 自动验证

- 共享 Zod Schema 和边界值测试。
- 单/多实例注册策略、Tab 顺序、关闭焦点和“+”选择页组件测试。
- 本机 PTY Session Manager 的输入、resize、退出、幂等关闭和进程树测试。
- SSH PTY 的 Host identity、lease、断线、resize 和关闭测试。
- Main trusted sender、Session 所有权、IPC 输入边界和事件路由测试。
- Terminal Renderer 的 IME、键盘、ResizeObserver、订阅释放和状态测试。
- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run build`

### 19.2 真实路径验证

- 在当前开发平台通过产品 UI 完成本机终端全流程。
- 在共享 Linux x64 Host 通过现有 Host 配置完成远程终端全流程。
- 真实运行需要 TTY 的程序，验证 ANSI、光标和 resize，不只运行非交互命令。
- 持续输出并主动减慢 Renderer 消费，验证背压和内存上限。
- 分别在本机和远程启动带子进程的命令，关闭 Tab 和应用后核对无 GoodBuddy 所属遗留资源。
- 生产构建在各受支持平台实际加载 PTY 原生模块，不以单元测试或包内文件存在代替。

### 19.3 当前开发验证记录

2026-09-01 已通过生产 `SshConnectionPool` 和 `createSshTerminalSession` 在共享 Linux x64
Host 完成直接 SSH PTY 验证：使用已有固定 Host Key 和测试凭据，以远端项目目录启动登录
Shell，验证交互输入、ANSI、UTF-8 中文、`80×24` 到 `101×37` resize、连接销毁后进入
`interrupted`、重新连接创建新 Shell，以及 Session close 和 connection pool dispose
回收远端 Shell。验证只创建一个
`$HOME/.goodbuddy/terminal-smoke-<UUID>` 临时目录，结束后已删除并确认无遗留 Shell 进程。

同日使用最新生产构建完成工作栏视觉检查：活动 Tab 使用连续内容表面、顶部强调线和应用
图标；关闭按钮默认不可见，悬停后以 overlay 显示且 Tab 宽度不变；横向滚动继续可用但不
显示滚动条，“+”保持独立可见。

本记录不替代尚未勾选的完整产品 UI、剪贴板、macOS、Linux arm64 和各平台本机 PTY 验收。

本 PRD 不改变 Agent 协议，因此首期远程终端无需 Agent package 更新。若实现期间改为
Agent-owned PTY，必须先修订本文的远程生命周期和恢复语义，并按 Agent 开发规则在共享
Linux x64 Host 验证当前源码或候选包。

## 20. 相关文档职责

- [通用助手工作栏与执行空间 PRD](./prd.md)：
  工作栏应用级位置、稳定能力目录、执行空间和总体范围。
- 本文：持久“+”、应用实例策略、工作栏动态 Tab、自动项目目标、本机与直接 SSH 多终端。
- [统一界面设计系统](../../../UI-DESIGN.md)：Tab、菜单、布局、主题、焦点和无障碍规则。
- [SSH 远程主机与 GoodBuddy Agent 实现说明](../remote-host/technical-design.md)：
  Host Key、凭据、连接池、Agent 和远程项目现状。
- [SSH Host 远程环境准备与控制面直连设计](../remote-host/environment-provisioning-technical-design.md)：
  Host 保存、环境准备和项目使用之间的职责。
