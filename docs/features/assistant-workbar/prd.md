# 通用助手工作栏与执行空间 PRD

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中 |
| 版本 | 0.6 |
| 日期 | 2026-08-31 |
| 适用产品 | GoodBuddy 桌面端 |
| 相关设计 | [统一界面设计系统](../../../UI-DESIGN.md)、[SSH 远程主机与 GoodBuddy Agent 实现说明](../remote-host/technical-design.md) |
| 相关能力 | [会话监督](../conversation-supervision/prd.md)、[自动化平台](../../architecture/automation-platform-architecture.md)、[长期助手路线图](../../roadmap/long-term-assistant-roadmap.md) |

## 1. 背景

GoodBuddy 已经在聊天右侧提供任务中心、工作区、浏览器和成果面板，也已经具备
Runtime 事件、Git 变更、文件预览、成果存储、受控浏览器和专家执行等基础能力。后续还
计划增加：

- Conversation、Task 和实验的独立监督。
- OpenCode、Continue 和 DeepSeek Harness 的 Runtime 生命周期监督。
- 用户可直接使用的终端和受管进程。
- HTML 等成果的即时安全预览。
- 本机与 SSH 远程主机上的工作区和 Agent Runtime。

这些能力不能被收束为只面向编程的工作台。监督、Runtime、终端、进程、浏览器和成果
都可以服务于普通问答、内容分析、自动化、数据处理、远程运维、知识整理和软件开发。
同时，能力目录也不能根据当前页面、项目类型或 Runtime 能力无提示地变化，否则用户无法在
需要时主动打开面板并选择目标、主机或运行环境。

本设计把右侧区域定义为应用级的“助手工作栏”，并把本机或远程的目录、终端、进程和
Runtime 统一抽象为“执行空间”。

## 2. 产品定义

### 2.1 助手工作栏

助手工作栏是 GoodBuddy 中始终可访问的应用级工具容器。它提供稳定能力目录，用户从中
查看任务中心，并按需打开一个或多个监督、Runtime、终端、进程、工作区、浏览器和成果
面板实例。稳定的是能力的可发现性，不是八个同时占据界面的固定面板。

工作栏不是：

- 只在编程项目中出现的 IDE 面板。
- 当前聊天消息的附属详情框。
- 根据能力探测结果自动增删入口的动态菜单。
- 绕过 Main、Preload、Ask/Execute 或审批边界的控制台。
- 全系统进程管理器、任意文件浏览器或无边界远程管理工具。

### 2.2 执行空间

执行空间描述工作区、终端、受管进程和 Agent Runtime 实际运行的位置：

```ts
type ExecutionSpaceSelection =
  | {
      kind: 'local'
      rootPath?: string
    }
  | {
      kind: 'ssh'
      hostId: string
      remoteRootPath?: string
    }
```

执行空间可以来自当前项目，也可以由用户在工作栏中临时选择。临时选择不会静默修改项目
设置，也不直接授予文件、终端或 Runtime 能力。Main 必须先把选择草稿验证为绑定窗口、
controller、Host/Workspace identity、信任 revision、能力和 lease 的 opaque 临时 Grant；
后续 IPC 只引用 Grant ID。只有用户显式保存并重新通过 Project 候选验证时才成为项目默认值。

## 3. 核心产品原则

### 3.1 能力目录稳定，面板实例由用户控制

工作栏能力目录提供以下标准能力：

```text
任务中心
监督
Runtime
终端
进程
工作区
浏览器
成果
```

- 应用不得根据当前项目、会话、Runtime、主机或探测结果无提示地增删能力目录项。
- 用户主动打开、关闭、排序和停靠面板实例；应用不默认同时挂载全部能力。
- Task Center 是 Task 的单例应用级索引。每个 Task 只关联一条 Conversation，一条
  Conversation 可以关联多个 Task；Task Center 不复制会话内容，也不显示普通 Conversation、
  Job、Run 或心跳事项。
- 当前能力、连接、数据和空状态可以动态变化。
- 能力不可用时，目录项或已打开面板显示原因、影响和可执行的配置或切换入口，不能只通过隐藏表示。
- 用户可以在设置中调整目录顺序；恢复默认布局恢复标准目录与默认打开面板，不强制打开全部能力。
- 同一能力需要并排比较不同目标时可以创建多个实例，每个实例拥有独立身份和范围绑定。

### 3.2 当前上下文只提供默认值

任务中心作为全局索引不跟随当前会话，也不支持为同一列表打开多个目标实例。其他可绑定
目标的能力使用当前会话、项目、Runtime 和主机帮助新面板实例初始定位，但这些上下文不是
使用门槛：

- 监督默认选择当前会话，用户可以改选其他 Conversation、Task 或实验对象。
- Runtime 默认跟随当前会话或 Task；执行事件可以查看，但 Job/Run 不作为独立选择对象。
- 终端创建时固定到当前项目执行空间，由项目配置自动决定本机或托管 SSH；没有当前项目时
  使用本机 Home。
- 工作区默认显示当前项目目录，用户可以打开其他本机目录或远程目录。
- 成果默认使用当前范围，用户可以切换到项目、全局或其他允许范围。
- 下一次请求的附件和知识库由当前 Composer 展示与管理，不作为工作栏能力。历史执行上下文
  随关联 Task 查看；记忆功能实现后也归入任务中心，而不是新增独立上下文面板。

每个可切换目标的面板实例都提供一致的范围模式：

```text
跟随当前上下文
固定到指定对象
```

固定目标失效时，面板显示“目标不可用”和修复入口，不静默回到其他目标。

### 3.3 用户控制打开、切换和介入

- 后台事件可以更新目录徽标、面板状态和通知，但不得无条件抢占当前面板。
- 只有用户刚刚发起且明确需要面板完成的交互，才可以打开对应面板。
- 浏览器画面、审批、监督警告、Runtime 失败和终端退出默认通过徽标或通知提示。
- 高风险状态必须持续可见，但不以自动切页代替用户选择。
- 用户切换页面、会话或项目时，已固定的面板目标保持不变；跟随模式才更新目标。

### 3.4 入口稳定不等于虚假能力

稳定能力目录和已打开面板必须准确呈现能力差异：

- 当前 Runtime 不支持后台 Job 时，Runtime 能力仍可发现；打开后说明当前可监督的内容。
- 当前执行空间没有 Git 仓库时，工作区文件功能仍可使用，Git 区域显示不可用原因。
- 没有活动进程时，进程面板提供创建终端或启动 Runtime 的入口。
- 没有项目时，终端使用当前用户本机 Home；工作区等允许选择路径的能力仍必须先取得有界
  临时 Execution Space Grant，不能把可选路径直接传给文件、Git、Process 或 Runtime。
- 监督未启用时，监督面板提供目标、模式和“开始监督”，而不是隐藏能力。

不得渲染成排没有解释的禁用按钮，也不得把“进程连通”描述为已经支持完整原生监督。

### 3.5 通用能力与领域能力分层

- 监督判断目标、证据、矛盾、遗漏、质量和风险，不假设目标一定是编程。
- Runtime 监督展示运行生命周期，不假设 Runtime 一定是 OpenCode。
- 终端和进程是通用执行能力，不只服务代码构建。
- 工作区可以是文档、数据、知识或代码目录；Git 是可选区域。
- HTML 预览属于通用成果能力，不只用于网页开发。
- SSH 主机可以承载 Agent、自动化、数据处理和工作区，不只代表远程代码仓库。

## 4. 目标

### 4.1 用户目标

- 从任意主要页面随时发现同一组稳定能力，并按需打开所需面板。
- 自主选择每个可绑定目标的面板实例跟随当前上下文还是固定到指定目标。
- 在不中断主任务的情况下观察监督意见、Runtime、进程和成果。
- 随时创建本机或远程终端，并理解其执行位置和权限。
- 查看 GoodBuddy 管理的进程及其来源、输出和停止状态。
- 对生成的 HTML、Markdown、JSON、图片等成果进行即时安全预览。
- 管理 SSH 主机，并在远程执行空间中运行受控 Agent Runtime。

### 4.2 产品目标

- 建立不依赖具体页面和 Runtime 的应用级工作栏、能力目录和面板实例壳层。
- 建立统一范围、执行空间、生命周期、成果和控制契约。
- 复用现有 Project、Conversation、Task、Artifact、Activity 和 Approval 数据。
- 保持 Renderer 无任意文件、进程、PTY、SSH 或 Electron API 能力。
- 保持 Ask 只读、Execute 审批、取消、超时、输出边界和活动审计。
- 为本机与远程能力提供一致 UI，同时准确表达能力差异。

## 5. 非目标

- 不把 GoodBuddy 改造成完整 IDE。
- 不提供全系统进程枚举和任意 PID 终止。
- 不默认扫描用户全部目录、远程主机或 SSH 配置。
- 不允许 Agent 未经现有 Runtime 边界直接向用户终端注入输入。
- 不自动执行 HTML 中的脚本或访问网络。
- 不让监督器自动替用户发言、批准工具、扩大范围或修改安全策略。
- 不提供以 SSH 连接为生命周期的临时远程 Agent；远程执行必须由用户级常驻 Daemon 承载。
- 不支持任意 ProxyCommand、任意端口转发或 SSH Agent Forwarding。
- 不要求所有 Runtime 提供相同的 Subagent、Job、Hook 或会话能力。

## 6. 信息架构

### 6.1 应用级位置

助手工作栏位于主窗口右侧，但不归属于聊天页面。聊天、知识、魔法笔记、自动化、活动记录
等主要页面都可以打开它。各页面可以提供默认范围，不能维护互不相容的右栏副本。

```text
┌──────────────┬──────────────────────────────┬────────────────────────┐
│ 主导航       │ 当前主任务                   │ 助手工作栏             │
│              │                              │                        │
│ 会话 / 知识  │ 聊天、文档、自动化或数据视图 │ 稳定能力目录           │
│ 自动化 / 活动│                              │ 用户打开的面板实例     │
│ 设置         │                              │ 各实例范围与执行空间   │
└──────────────┴──────────────────────────────┴────────────────────────┘
```

### 6.2 能力目录与面板实例

能力目录不等于同时打开八个面板。当前产品采用“已打开实例 Tab + 持久新增按钮”的工作栏
模型：Tab 行只显示已打开实例，行末“+”始终可见；点击后在工作栏内容区打开稳定能力目录，
用户再创建或激活应用实例。详细交互以
[助手工作栏多终端页签 PRD](./terminal-tabs-prd.md) 为准。

- 每项始终显示稳定图标，并提供可见标签或可持续查看的工具提示。
- 已打开实例使用 `tablist`、`tab`、`tabpanel`；“+”是位于 `tablist` 外的普通命令按钮。
- 应用注册表声明 `single` 或 `multiple`。重复选择单实例应用时聚焦已有实例；选择多实例
  应用时每次创建新实例。
- 支持方向键、Home、End、Enter、Space、关闭面板和正确焦点恢复。
- 徽标显示未解决数量、等待审批或失败状态，并同时提供文字或可访问名称。
- 用户调整目录顺序、打开实例、停靠位置和尺寸后持久化；关闭实例后能力仍可从目录重新打开。
- 默认布局只恢复经过产品确认的少量常用面板，不自动打开全部标准能力。
- 每个实例显示稳定实例 ID、能力名称、跟随或固定状态与当前目标；同能力多实例不能只靠位置区分。

从当前聊天右栏迁移时，Task Center、工作区、浏览器和成果作为默认打开的单实例应用保留；
终端不默认打开，由用户通过“+”创建，并从首期开始支持多实例。Tab 必须单行横向滚动，
不能自动隐藏或缩写到不可辨认，“+”不能随滚动消失。Task Center 继续作为 Task 的现有
入口；审批定位到所属 Task 或 Runtime。智能心跳不作为工作栏页签，其报告、建议、历史和
完整配置统一归属“智能心跳”菜单入口。当前阶段不新增独立自动化中心。

### 6.3 工作栏尺寸

- 所有窗口宽度下工作栏都停靠右侧并参与水平布局回流；展开时主工作区同步收缩，不能覆盖
  或遮罩其内容。
- 分栏计算排除最左侧主导航，主工作区与工作栏使用相同的 `300px` 最小宽度。拖动记录两侧
  在可用分栏宽度中的比例；任一侧达到最小值后停止，窗口缩放后按原比例重新计算并再次
  应用同一最小值约束。
- 最左侧主导航保持全高连续表面；窗口标题栏只覆盖右侧内容框架，不能横跨主导航并把品牌、
  项目切换器和导航整体向下推移。
- 对话内容与输入区始终保留对称的左右安全边距，工作栏边界不得覆盖或裁切输入框、发送
  按钮及主工作区右侧边距。
- 唯一展开与收起开关固定在窗口关闭按钮正下方。工作栏内部不重复关闭入口。开关图标中的
  箭头方向随当前动作切换，按钮不以持续高亮表达展开状态；当前会话没有 Task 时不渲染空
  Task 上下文栏。
- “新建任务”入口位于工作栏“任务索引”标题后方，不在会话 Task 上下文栏重复出现；索引
  状态筛选占满可用宽度并等分各筛选项。
- 终端、宽日志和大型成果允许用户切换到底部停靠或独立窗口。
- 应用只建议适合的布局，不因面板内容自动改变用户已经选择的停靠位置。

## 7. 能力与面板定义

### 7.1 Task Center

Task Center 保留为工作栏中的稳定入口，并在现有基础上适度完善：

- 只索引 Task；每个 Task 只关联一条 Conversation，一条 Conversation 可以关联多个 Task。
- 显示名称、关联 Conversation、Global 或 Project 范围、Ask/Execute、状态、最近进展、
  真实活动时间和需要关注信息。
- 点击 Task 打开其关联 Conversation 并定位 Task。
- 完整消息留在 Conversation；工具、Subagent、审批、错误和成果按 Task 关联到 Runtime、
  活动记录和成果查看器中，不在窄栏复制，也不呈现 Job/Run 树。
- 智能心跳的报告、建议、历史和配置不进入任务中心。

任务中心是单例索引，不使用其他能力的“跟随 / 固定目标”多实例模型。后台状态可以更新
徽标和排序，但不能自动打开面板或抢占用户当前工作。

主侧栏最近会话为关联 Task 提供轻量入口：父会话行只显示行首展开按钮，Task 子项使用
任务图标和本地化摘要，展开层级只到 Task；点击 Task 子项打开同一 Conversation 并定位。
新建定制任务使用 Modal 选择当前或新
Conversation，默认 Execute，并持续显示 Runtime、Project、工作目录、工具和审批摘要。

详细产品边界以 [Task Center PRD](../task-and-job/task-center-prd.md) 和
[Task 与 Job 统一领域模型](../task-and-job/task-and-job-model.md) 为准。

### 7.2 监督

监督是通用观察与评论入口，详细行为以
[会话监督 PRD](../conversation-supervision/prd.md) 为准。

监督能力在目录中稳定可发现；用户打开面板实例后可以选择：

- 普通会话。
- Task。
- 实验或实验结果。
- 后续支持的文档分析和其他可监督对象。

监督面板包含：

- 当前目标与范围。
- 开启状态、监督模式、触发方式和预算。
- 评论、警告、人工复核请求和证据。
- 未解决、已查看、已解决、忽略和误报状态。
- “带入输入框”“查看证据”“追问”“停止当前回复”等用户介入操作。

“采纳”只生成可编辑草稿或显式会话操作，不自动发送、执行、切换 Execute 或批准工具。

### 7.3 Runtime

Runtime 能力统一监督直连模型、OpenCode、Continue、DeepSeek Harness 和后续 Runtime。
能力在目录中稳定可发现，打开的面板实例依据所选 Runtime 的真实能力显示状态。
远程实现先只交付 OpenCode 官方 ACP 闭环；Continue 与 DeepSeek Harness 后续复用同一
面板和通道契约。产品不为并行建设多套后端而增加用户可见模式或临时入口。

共同区域：

- Runtime、模型连接、Conversation 或 Task 身份。
- 活动请求、状态、耗时、用量和取消。
- 工具、审批、问题、上下文压缩和错误。
- 跳转完整活动记录和持久设置。

可选区域：

- Task 级委派状态和取消。
- Task 级后台执行进度、结果和终止。
- Todo、Workflow 和 Hook 运行。
- 原生会话、暂停、恢复、压缩或释放。

可选区域不可用时，用一段有操作路径的状态说明替代空卡片。用户可以在面板中切换 Runtime
或 Conversation / Task 目标，不要求先回到聊天 Composer。内部 Job/Run 事件按 Task
聚合，不提供 Job/Run 选择器、树、页面或独立操作菜单。

### 7.4 终端

终端面板允许用户通过工作栏“+”主动创建和管理多个本机或 SSH 终端。详细产品行为、首期
直接 SSH PTY 技术选择、生命周期和验收以
[助手工作栏多终端页签 PRD](./terminal-tabs-prd.md) 为准。

- 新建、重命名、切换、关闭和重新连接终端。
- 创建时自动绑定当前项目执行空间、权威工作目录和平台默认 Shell，不显示重复目标选择。
- 显示本机或远程主机、目录、Shell 和连接状态。
- 支持复制、粘贴、搜索、清屏、滚动和调整终端尺寸。
- 支持将终端切换到右侧、底部或独立窗口。

终端属于用户交互表面。Agent 工具调用可以产生独立受管进程和日志，但不能伪装成用户终端，
也不能在没有明确授权的情况下向现有终端发送按键或命令。

### 7.5 进程

进程面板只展示 GoodBuddy 创建、托管或明确接管的进程：

- 用户终端 Shell。
- Runtime Host、Server、Utility 和远程 GoodBuddy Agent。
- Runtime 后台 Job。
- 用户通过工作栏显式启动的长运行命令。
- 浏览器或自动化中属于 GoodBuddy 的受管子进程摘要。

每项显示：

- 名称和有界命令摘要。
- 来源、执行空间、项目或会话归属。
- 启动时间、状态、退出码和资源摘要。
- 有界 stdout/stderr 或结构化日志。
- 正常终止、必要时强制终止和打开关联对象。

Renderer 不接收任意系统 PID 控制能力。控制动作引用 Main 签发的受管进程 ID，并由 Main
重新验证所有权、当前状态和允许操作。

### 7.6 工作区

工作区面板允许用户选择：

- 当前项目目录。
- 其他本机目录。
- 已配置 SSH 主机上的远程目录。

面板提供：

- 有界目录树和文本文件预览。
- 当前选择、规范化路径和执行空间。
- 可选 Git 状态、Diff 和仓库信息。
- 显式打开、下载副本或在终端中打开。
- HTML 文件的源码与安全预览。

本机和远程访问都必须由 Main 或远程 GoodBuddy Agent 在对应文件系统上执行路径规范化、相对路径和
符号链接边界检查。Renderer 只能提交受约束的相对路径和已授权范围 ID。

### 7.7 浏览器

浏览器能力在目录中稳定可发现，打开面板后允许用户：

- 创建新的 GoodBuddy 隔离浏览器会话。
- 选择当前会话或其他受控浏览器会话。
- 查看状态、当前 URL、有界画面和错误。
- 通过顶部浏览器工具栏返回、刷新或停止加载、编辑地址并前往。
- 进入明确的交互模式或关闭浏览器。

顶部工具栏按“返回、刷新/停止加载、地址输入、前往、交互、关闭浏览器”组织。“刷新”在
页面加载期间原位切换为“停止加载”；“关闭浏览器”是清楚独立于导航的会话生命周期操作，
必须与“停止加载”在文案和视觉上明确区分。现有“停止浏览器”语义统一改名为“关闭浏览器”。

浏览器面板和 Agent 操作同一条按 Conversation 归属的浏览器会话，不创建用户预览专用的
第二个页面。用户执行前往、返回或刷新会有意改变 Agent 下一步读取和操作的页面。所有
前往、返回和刷新请求都进入 `BrowserService`，并与 Agent 发起的浏览器操作串行执行；不在
Renderer 建立第二套导航队列、抢占规则或恢复状态机。

浏览器工具栏读取的权威状态至少包含：

```ts
type BrowserToolbarState = {
  committedUrl: string
  loading: boolean
  canGoBack: boolean
  sessionActivity: 'inactive' | 'creating' | 'ready' | 'agent_action' | 'full_interaction'
}
```

`committedUrl` 是浏览器已经提交的权威 URL。地址输入在未编辑时与它同步；获得编辑意图后，
输入文字保持为 Renderer 本地草稿，画面、加载状态和 URL 更新不得覆盖草稿，直到用户“前往”
或放弃编辑。用户提交未带 `http://` 或 `https://` 的裸域名时，Renderer 自动补上
`http://`，再通过既有浏览器 URL 策略提交。地址草稿不属于浏览器会话持久状态，也不需要
恢复或版本化机制。

创建会话、Agent 操作和完整交互窗口期间，返回、刷新、地址提交、前往、交互和关闭浏览器
控件禁用，避免与同一会话并发操作。例外是活动导航处于加载中时，“停止加载”保持可用，
可中断当前页面加载；
它只取消页面加载，不销毁浏览器会话、不执行“关闭浏览器”，也不释放当前 Runtime 上下文。
“关闭浏览器”沿用现有停止会话的生命周期语义。

没有浏览器会话时仍显示工具栏。活动 Conversation 可以直接在地址栏输入非空 URL 并“前往”，
由 `BrowserService` 通过 Agent 浏览器相同的能力检查和 URL 策略创建会话并导航；不得为这一
空状态增加旁路 WebView 或宽松 URL 入口。没有活动 Conversation 时说明需要先选择或创建会话。
模型或后台浏览器活动可以更新徽标，但不得无条件打开面板或切换用户当前面板。

浏览器面板只管理 GoodBuddy 受控浏览器，不表示可以控制用户已安装的浏览器。

### 7.8 成果

成果面板统一显示全局、项目、Conversation、Task 执行和监督显式产生的独立成果：

- Markdown、纯文本和 JSON。
- 图片和图表。
- HTML 安全预览。
- 后续的 PDF、Office、表格和其他受支持格式。

普通聊天回复只保留在会话消息流中，不自动复制为成果。只有 Runtime 或受管工具显式声明的
Artifact、自动化和监督生成的独立输出，以及用户手动导入或明确保存的内容进入成果面板。
升级前已经自动保存的普通对话 Markdown 可以从成果列表中隐藏，但不应通过升级迁移物理
删除用户数据库内容。

用户可以切换范围、搜索、预览、查看来源、导出或打开关联对象。成果必须保留项目、
Conversation、Task、内部 Run、创建者、MIME、大小、校验值和时间等可用归属；界面按
Task 呈现来源，不把 Run 作为导航对象。

#### HTML 即时预览

- Runtime 或受管工具通过显式 Artifact 事件声明成果，不能让 Renderer 猜测任意路径。
- Main 验证成果属于当前授权执行空间，限制大小、类型和读取范围后再持久化。
- HTML 使用 `iframe sandbox=""` 和严格 CSP 进行脚本关闭、网络关闭的静态预览。
- 清理脚本、事件属性、嵌套 frame、object、embed、base、link、meta refresh、表单和活动 URL。
- 提供“预览 / 源码”切换，并持续标注“静态安全预览，脚本和网络已禁用”。
- 不使用 `dangerouslySetInnerHTML`，不启用 Electron `webviewTag`。
- 外部打开是明确的用户操作，并说明外部浏览器可能执行脚本或联网。

### 7.9 Composer 与任务上下文

工作栏不提供独立“上下文”能力。用户准备下一次模型请求时：

- 附件、图片、文档提取结果以及知识库范围在 Composer 中展示与管理。
- Composer 提供与发送行为直接关联的预览、移除和清空操作，不在工作栏重复入口或状态。
- 浏览器、工作区文件、授权目录以及 Runtime 或自动化绑定内容由各自能力展示。
- Task 的历史执行上下文作为不可变快照随 Task 查看。
- 记忆功能实现前不展示占位内容；实现后在任务中心按关联 Task 展示和管理。

## 8. 范围和选择模型

### 8.1 通用目标引用

各面板实例使用不包含敏感内容的目标引用：

```ts
type WorkbarCapabilityId =
  | 'supervision'
  | 'runtime'
  | 'terminal'
  | 'processes'
  | 'workspace'
  | 'browser'
  | 'results'

type WorkbarTargetRef =
  | { type: 'conversation'; id: string }
  | { type: 'task'; id: string }
  | { type: 'experiment'; id: string }
  | { type: 'project'; id: string }
  | { type: 'workspace'; id: string }
  | { type: 'runtime-session'; id: string }
  | { type: 'terminal'; id: string }
  | { type: 'managed-process'; id: string }
  | { type: 'browser-session'; id: string }
  | { type: 'artifact'; id: string }
```

Renderer 选择目标后，Main 必须重新验证对象存在、归属范围和当前用户可见性。不能把目标 ID
直接转换为文件、进程或远程控制权限。

### 8.2 跟随与固定

```ts
type WorkbarScopeBinding =
  | { mode: 'follow'; source: 'active-context' }
  | { mode: 'pinned'; target: WorkbarTargetRef }

type WorkbarPanelInstance = {
  id: string
  capability: WorkbarCapabilityId
  binding: WorkbarScopeBinding
  dock: 'right' | 'bottom' | 'window'
}
```

- 每个面板实例独立保存绑定方式；同一能力的多个实例不能共享可变选择状态。
- 绑定只包含公开 ID，不包含路径、凭据、Token 或日志。
- 删除固定目标后保留失效状态，直到用户选择新目标或恢复跟随。
- 工作栏重新打开、页面切换和窗口重建后恢复用户打开的实例与选择。

## 9. 主机管理与远程执行空间

本节定义产品入口和用户行为。Host Key、凭据、远程 Agent 协议、模型请求代理、签名更新、
断线和 Runtime 适配的技术边界以
[SSH 远程主机与 GoodBuddy Agent 稳定终态设计](../remote-host/technical-design.md)
为准。

### 9.1 设置入口

设置中心“平台功能”提供独立“远程项目（技术预览）”页签及开关，默认关闭。关闭时不显示
“主机与远程执行”分类、托管 SSH 项目创建选项和已保存远程项目，Main IPC 同时拒绝新的
SSH/远程项目操作；已有 Host、项目和凭据保持不变。若当前项目已经是远程项目，则切回
项目列表中的第一个普通
本地项目。重新启用后恢复完整入口和既有数据。

启用后，设置中心显示“主机与远程执行”分类，管理：

- 主机名称、地址、端口和用户名。
- 认证方式和凭据配置状态。
- Host Key 算法与 SHA-256 指纹。
- 引导式身份/认证验证、远程系统和架构。
- GoodBuddy Agent、Runtime 和能力状态。
- 删除、重新验证或更新 Host Key。

主机配置是全局资源。项目或工作栏只引用主机 ID，不能复制凭据。
删除 Host 前列出所有引用它的本地项目记录，包括归档项目；确认后仅删除本机 Host、凭据、
项目和关联数据，不建立 SSH 连接，也不删除远端目录或内容。若当前项目被删除，界面切回
普通本地项目。

当前实施状态：设置中心已经实现主机 CRUD 和模态验证向导。新增或目标/认证编辑依次完成
连接信息、认证前 Host Key 核对、密码/系统 SSH Agent 认证和平台/架构/Shell/Home 有界
探针，全部成功后才原子保存主机、加密凭据和完整 Host Key。认证失败可在弹窗内修改凭据
重试；取消或失败不保留新主机。Key 变化显示旧/新指纹并要求显式高风险确认。项目创建和
设置现可选择托管 SSH、已保存 Host、远端工作目录、OpenCode 和 Ask/Execute，不要求
额外 trust tier 或 consent checklist。候选完成签名 Agent/Runtime、Workspace、ACP、模型桥
和文本模型 profile 验证后原子提交。私钥导入仍未开放。旧流程已保存但
没有成功探针记录的主机继续读取，但在完成新向导前显示为“需要重新验证”。

当前源码已把 Agent/Runtime 生命周期归入 Host 管理。新增或重新验证 Host
在身份、认证和系统探针成功后先保存 Host，再只读探测实际组件状态和瞬时下载能力，然后
结束新增向导。产品不提供自动安装开关，也不在保存后传输包。Host 卡片只有一个按版本
事实显示“安装远程环境”“更新远程环境”或“重新安装”的主按钮；次级 SegmentedControl
选择“自动”“Host 下载”或“GoodBuddy 传输”，默认“自动”且不持久化。版本匹配 badge
不代表环境健康。环境准备失败或取消保留 Host 并显示可重试状态；重新安装失败时显示
本次操作未完成，并以随后重新检查的版本卡片表达当前事实，不对不确定提交宣称旧版本
未被替换。详细技术契约见
[SSH Host 远程环境准备与直连下载设计](../remote-host/environment-provisioning-technical-design.md)。

进入或切回“主机与远程执行”页面只读取本地 Host 列表，不逐台建立 SSH 连接。版本和瞬时
下载能力仅在用户点击某台 Host 的“刷新版本”时探测，成功结果在当前 Renderer 进程内按
Host 持久化缓存，切换页面或重启应用后返回直接显示；Host 编辑、删除或开始更新远程环境后
不复用旧结果。该动作不是项目连接前置条件；用户
切换已有远程项目只更新 Renderer 的本地项目选择，不建立 Host/Agent 连接。
新建远程项目弹窗同样只读取本地 Host 验证记录，不扫描所有 Host；浏览目录或保存时才连接
所选 Host。版本号相同时仍允许用户显式重新安装，以修复 registry、签名或 identity 异常，
且不删除 Host、凭据或项目。由远程主机安装只使用 SSH 和远端系统工具，不依赖已有 Agent；
“自动”仅在操作开始时探测：直连明确可用才选 Host 下载，否则选 GoodBuddy 传输；用户
显式选择不被改写，prepare、commit 或 adoption 失败后不在同次操作中切换 acquisition。

项目选择器中每个项目的管理按钮默认隐藏，在悬停、键盘焦点或触屏环境显示。该入口直接
打开目标项目设置而不先切换项目，因此 Host 不可达或远端目录已不存在时仍可删除本地项目
记录；删除操作从不删除远端项目内容。

应用重启后固定进入项目列表中的第一个普通本地项目。用户主动打开已有托管 SSH 项目时只
切换本地项目配置；首次实际使用 Workspace 或 Runtime 时，Main 才通过 Agent/Runtime
安装管理器解析 Host current identity，执行固定 `attach-or-bootstrap`，并使用同一 Agent
连接。
项目数据库不保存 Agent installation、Host revision、Workspace identity 或 Runtime
digest。当前 registry、连接或 capability 无效时项目保持未切换，并提示到 Host 管理显式
修复。当前进程缓存每个 Host 已确认的 Agent/Runtime identity，并复用 Agent 连接；Host
编辑或环境更新会定向清空。Agent 的 attach/按需启动只读取 Host 管理已提交的 registry 与
匹配 manifest 元数据，不重新验签或哈希完整 Agent payload。项目切换器立即提交本地选择，
不展示远程激活进度；完整进度和取消只属于新建或显式保存项目。

项目只持久化 Host ID、规范远端路径、Runtime 选择和默认工作模式。新建和保存验证当前
Workspace/Runtime，但不写入组件 identity；普通切换不做远程验证。未就绪或版本过旧时，
实际 Workspace/Runtime 操作显示错误。桌面更新造成组件版本变化时，用户先在 Host 管理中
准备环境；项目切换本身不连接、不下载、不扫描、不安装，也不改写项目。

已保存 Host 的地址、用户或固定 Host Key 变化后，Main 关闭旧连接并定向退役该 Host 的
Runtime 缓存。引用项目下次选择时使用 Host 管理的当前 revision、Host Key 和用户执行固定
attach 并读取 current registry，不存在项目中的旧 Host revision 或组件 identity；
当前环境无效时才要求显式修复。

新建托管 SSH 项目时，远端工作目录既可手工输入，也可通过文件夹按钮打开 Main 管理的
只读、有界 SFTP 目录选择器。选择器从 SSH 账号 Home 或当前有效绝对路径开始，只返回目录，
支持上级、刷新、取消和选择当前目录；Host 变化、连接错误或取消都保留草稿，选择结果不会
绕过正常项目验证与保存事务。

### 9.2 凭据和主机验证

- 优先支持系统 SSH Agent 或 OpenSSH 证书。
- 导入私钥或密码时使用 Electron `safeStorage` 加密。
- 凭据绑定主机 ID、地址、端口、用户名和认证类型。
- Renderer 只接收 `credentialConfigured`、来源和错误状态。
- Host Key 检查使用 Main 内五分钟有效、目标绑定的临时候选，检查阶段不接收认证凭据；
  认证和系统探针成功前不持久化新增主机，取消或失败不留下主机或密码。
- 首次连接必须在发送密码、私钥签名或 SSH Agent 签名前取得并展示 Host Key 算法和
  SHA-256 指纹，由用户显式接受；持久化完整 Host Key 或可信 Host CA，不能只保存展示指纹。
- Host Key 变化硬失败，并通过独立高风险流程替换。
- 禁止 `StrictHostKeyChecking=no` 和默认 SSH Agent Forwarding。
- 命令参数、URL、日志、SQLite 明文和 IPC 响应中不得出现私钥或密码；用户在受信任表单
  输入的密码只通过严格校验的单用途 IPC 请求交给 Main，Renderer 不得读取已保存密码。

### 9.3 远程 GoodBuddy Agent

远程能力通过版本化 GoodBuddy Agent 提供：

- 安装到远程当前用户的 GoodBuddy-owned 目录，不要求 root。首次连接先 attach，Agent
  不存在或未运行时幂等 bootstrap 为 detached process，再重新 attach；不注册开机服务，
  不依赖 systemd、D-Bus 或 `Linger=yes`。
- SSH 负责 Host Key、认证、固定 bootstrap、可选 SFTP 安装和 `goodbuddy-agent attach`
  中继；attach 只连接用户私有 Unix socket。SSH relay 断开不终止 Agent 或活动 Runtime。
- Host 环境准备可让远端按签名目录固定的 GitHub/北京镜像 URL、大小和 SHA-256 下载完整
  `.gbagent`，也可由 GoodBuddy 下载、完整验证后通过有界流式 SFTP 传输一个 compound
  archive 和归档中已验证的 bootstrap Node；完整包不一次读入 Main `Buffer`，Host 仍再次
  校验。两种 acquisition 交付到固定 operation staging 后共用
  `prepare → commit → Agent activate/health → Runtime activate → finalize → cleanup`。
- 直连首次 bootstrap 不依赖已安装 Agent daemon。GoodBuddy 桌面控制面通过固定 SSH
  prepare channel 发送有界 one-shot installer；Host 先验证目录绑定的归档大小和 SHA-256，
  再由 format v1 归档内固定 Node 解码并运行 installer。归档无需包含
  `agent/lib/package-installer.cjs`，目录不提供或检查额外的 bootstrap 能力元数据。
- Agent 与 Runtime 各自维护版本，签名摘要标识精确工件。Host 在解包到准备目录的同一遍
  处理中完成完整 payload 校验，commit 只复核签名 metadata 并原子替换 side-by-side
  目录，不重新读取归档、扫描旧目录或使用跨安装硬链接。
- Main 只保存清理 operation staging 所需的 operation ID。控制通道中断或 adoption 失败
  后，下次更新尽力清理旧暂存并重新 prepare，不保存或恢复 Agent/Runtime metadata 副本。
  新 Agent/Runtime 各自最多完整验证一次；注册后的
  health、capabilities 和 prompt 启动只检查 registry、签名 manifest 与入口 metadata。
  确认 adoption 后显式 cleanup，cleanup 失败不回滚健康环境，也不阻塞下一次 fresh prepare。
- 握手报告 installation、Daemon boot identity、协议、系统、架构、用户监督器和能力。
- 在远程执行路径规范化、Git、文件、PTY、进程组和 Runtime 管理。
- 持久化有界 Agent 到 Main 输出；SSH 断开后 Agent 继续运行，同一 Agent 重连时只恢复
  可确认的输出。Main 到 Runtime 的输入、工具、模型和 blob 请求不自动重放。
- 对有副作用的请求使用稳定 operation ID 和 payload digest 去重；结果无法证明时进入
  `outcome-unknown`，禁止自动重放。
- 对事件、日志、journal、文件、帧、超时、并发、缓存和总传输量设置硬上限。
- Daemon、Runtime、受管进程和用户终端分别具有明确 lease、取消、drain 和回收语义。
- Agent 不可用或身份不匹配时远程执行失败，不退化为 SSH stdio Runtime。

Host Key、远端用户或目标变化会关闭旧连接，并使绑定旧 Host identity 的 Workspace 和
Runtime 会话失效。产品不维护 T1/T2/T3 等附加信任层级。

### 9.4 远程 Runtime

- Runtime 在远程执行空间内运行，不能让本机 Runtime 对远程路径进行伪本地操作。
- Main 保持可信控制面，远程 GoodBuddy Agent 只接受有范围、有期限的请求。
- GoodBuddy 控制协议负责 Agent、Workspace、Git、Process、Blob 和 Runtime supervision；
  Runtime Session、stream、tool、permission、usage 和取消优先复用 ACP。
- Ask 的只读限制在远程 GoodBuddy Agent 和 Runtime 适配层共同强制。
- Execute 是用户对所选 SSH 账号完整权限的授权，直接以该账号可用的文件、进程、网络和
  工具能力运行，不要求逐工具审批或第二个“受控执行”模式。取消、超时、输出上限和活动
  记录继续保留。
- GoodBuddy 模型凭据和 Provider URL 必须留在 Main。远程 Runtime 只获得不含凭据的模型
  policy、私有 Unix socket、隔离 loopback endpoint 和 Prompt-bound blob channel；
  Main 按 durable round、profile digest、调用次数、最坏输出 token 预留和最终 delivery ACK
  代发，不得把原始 API Key 或认证头发送到远端。
- 不向远程 Runtime 暴露通用本机 MCP、浏览器、文件系统或其他未分配能力。

## 10. Runtime 与进程统一生命周期

需要新增统一、受限的生命周期模型：

```ts
type ManagedLifecycleState =
  | 'starting'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'reconciling'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'outcome_unknown'
```

每个 Runtime 会话、Task 级执行、终端或受管进程公开：

- GoodBuddy 受管 ID。
- 类型、来源和父子关系。
- 执行空间和范围。
- 状态、开始与结束时间。
- 支持的控制动作。
- 有界进度、用量和日志游标。

控制动作按能力声明：

```ts
type ManagedControl =
  | 'cancel'
  | 'terminate'
  | 'force-terminate'
  | 'pause'
  | 'resume'
  | 'reconnect'
  | 'release'
```

界面不能因为状态枚举中存在某个动作就假设所有 Runtime 都支持。Main 根据当前受管对象和
能力重新验证动作。内部 Job/Run 快照可以支持聚合与审计，但不能成为
`WorkbarTargetRef` 或独立 UI 对象。

## 11. 数据与契约建议

### 11.1 共享 Zod 契约

建议新增：

- `workbar-contracts.ts`
- `managed-process-contracts.ts`
- `terminal-contracts.ts`
- `remote-host-contracts.ts`
- 通用 Artifact Event 和 Preview 契约
- Runtime Inspector Snapshot 和 Control 契约

所有输入严格限制字符串、数组、日志、帧、路径、端口和事件数量。公开快照不得包含：

- 凭据和认证头。
- 完整环境变量。
- 任意本机或远程绝对路径，除非该路径本身是用户当前可见对象。
- 未经限制的 stdout/stderr、文件或 Runtime 响应。
- 可直接传给系统 kill、spawn、Shell 或 SSH 的自由参数。

### 11.2 持久化

建议增加：

```text
workbar_preferences
remote_hosts
terminal_sessions
managed_processes
runtime_sessions
runtime_jobs
remote_agent_installations
remote_operations
```

其中：

- 工作栏偏好只保存能力目录顺序、面板实例、停靠布局、尺寸和目标引用。
- 主机表只保存非敏感元数据和加密凭据引用。
- 应用重启后先通过远程 Daemon 的 journal、lease、boot identity 和 event cursor 核对活动
  终端、进程与 Runtime；无法确认时标记 `interrupted` 或 `outcome_unknown`。
- 日志使用有界环形缓冲或分页持久化，不能无限写入 SQLite。
- Artifact 继续作为成果的权威实体，不把完整成果复制进工作栏状态。
- 当前 Renderer `localStorage` 活动记录不能作为 Runtime、监督或进程的权威来源。

### 11.3 IPC 与 Preload

Renderer 只通过显式方法访问：

- 工作栏偏好和目标绑定。
- 主机 CRUD、临时 Host Key 检查、验证并原子保存。
- 终端创建、输入、调整大小、关闭和有界输出订阅。
- 受管进程列表、日志和允许的控制动作。
- Runtime Inspector 快照、事件和允许的控制动作。
- 工作区、成果、浏览器和监督的既有或扩展服务。

每个 Main Handler 都必须验证可信发送者、Zod 输入、对象归属和当前状态。不得暴露 raw
Electron、ChildProcess、PTY、SSH Client、Socket 或文件句柄。

## 12. 安全边界

1. 工作栏能力目录项和面板实例不授予任何能力；权限只由 Main 中的范围和控制契约产生。
2. Ask 在本机和远程 Runtime 边界保持只读。
3. Execute 继续经过现有 Runtime 和审批控制，工作栏不能直接放宽。
4. 用户终端和 Agent 工具执行使用不同身份和事件来源。
5. 进程面板只控制 GoodBuddy 受管对象，不接受任意 PID。
6. 本机和远程路径分别在对应文件系统上 canonicalize 并验证符号链接边界。
7. HTML 默认静态、无脚本、无网络、无 Electron API。
8. Supervisor 不接收授权回调，不能批准工具或替用户发送消息。
9. SSH Host Key 必须固定，凭据保留在 Main 加密存储。
10. 远程端只获得请求级、可撤销、最小范围能力。
11. 关闭面板或切换目标、主机或 Runtime 时，旧订阅必须取消；其他固定实例的订阅明确保留。
12. 通知、徽标和日志不得包含密钥、私人正文或未脱敏提供商响应。

## 13. 状态、错误和恢复

每个面板实例区分：

- 尚未选择目标。
- 目标为空。
- 正在连接或加载。
- 正常可用。
- 部分可用。
- 当前能力不支持。
- 连接失败。
- 权限不足或只读。
- 目标已失效。
- 操作已取消或中断。

错误必须保留用户选择、终端缓冲、输入草稿、范围和可重试上下文。短期成功和非局部错误使用
应用通知；预览失败、终端断线、Host Key 变化、监督证据失效等需要本地恢复的错误留在面板
内。同一事件不得同时重复显示为面板警告和应用通知。

## 14. 性能与资源边界

- 工作栏关闭或面板实例关闭时停止对应非必要画面和高频日志推送，但保留 Main 中的受管运行。
- 每个打开的面板实例只订阅其跟随或固定目标，不进行全局无界监听。
- 终端和日志使用增量序号、环形缓冲和背压。
- HTML、文件、目录、浏览器画面和远程传输沿用或收紧现有大小限制。
- Runtime Snapshot 与事件流分离，重新打开时先取权威快照，再接增量事件。
- 监督使用独立低优先级并发池和预算，不延迟前台回答。
- 应用退出时停止新操作并让用户选择取消、等待或 detach；关闭 SSH attach 不卸载或终止
  用户级 GoodBuddy Agent Daemon。依赖 Main 模型网关、审批或本机工具的 Run 不能被描述为
  可以无人值守继续。

## 15. 无障碍与响应式

- 能力目录、所有面板实例、目标选择器、终端控制和进程操作可用键盘完成。
- 能力目录与面板标题具有稳定可访问名称，徽标不是唯一状态信号。
- 终端需要独立可访问说明，并允许关闭动画和声音提示。
- 进程和 Runtime 高频日志不逐行进入实时区域，只播报重要状态变化。
- 监督证据定位后将焦点移动到对应对象，并提供返回监督记录的方式。
- HTML iframe 有明确标题、静态安全说明和源码替代视图。
- 窄窗口下能力目录仍完整可达，不因空间不足隐藏能力。
- 文字缩放到 200% 时，当前目标、执行空间、风险状态和停止操作不能被裁切。

## 16. 分阶段实施

本节只表示内部依赖顺序，不表示可以发布临时架构。SSH 远程执行只使用用户级 Daemon，
不发布连接期 stdio Agent。OpenCode Ask、OpenCode Execute 和后续 Runtime 分别通过自身的
安装、权限、取消和重连门槛后开放，未完成的能力继续显示不可用。

### 阶段 0：应用级工作栏壳层

- 将当前聊天专属右栏提升为应用级壳层。
- 建立稳定能力目录和用户打开、关闭、排序、停靠的面板实例模型。
- 建立实例级跟随、固定和失效目标语义。
- 保留现有任务中心、工作区、浏览器和成果行为；附件与知识库继续由 Composer 管理。
- 将 Task Center 明确为 Task 的单例索引，并补齐范围、状态、最近进展、需要关注和直接打开 Conversation。
- 审批在所属任务或 Runtime 中持续可见，不新增独立审批面板。
- 智能心跳菜单入口承接完整配置和范围后，再从任务中心移除重复表单；不得移除任务中心本身。

### 阶段 1：成果与 Runtime 可观测性

- 通用 Artifact Event。
- HTML 工作区和成果的静态即时预览。
- Runtime Inspector Snapshot 与事件。
- OpenCode 会话、子会话、Todo、工具、用量和取消；本地与托管 SSH 的原生 Task 调用在
  Conversation 中统一显示为可追踪的 Subagent 状态，而不是普通工具参数卡。
- 直连模型、OpenCode 原生 Subagent 及现有 GoodBuddy Subagent 的统一展示。

### 阶段 2：监督、终端与受管进程

- 普通会话手动监督和右栏评论流。
- 工作栏持久“+”、应用注册表和单/多实例 Tab。
- 本机 PTY 与直接 SSH PTY 多终端。
- 受管进程注册、日志和终止。
- 自动回复后监督、节流和独立预算。
- 用户选择终端停靠位置。

### 阶段 3：Runtime 原生长期能力

- Continue 会话级 Host。
- Continue Background Job、Subagent 和 Hook 的有界适配。
- DeepSeek Harness 后续服务的能力握手。
- Runtime Job、Workflow 和会话恢复契约。

### 阶段 4：SSH 主机与远程执行空间

- [x] 引导式主机管理、先验证后保存、密码安全存储、系统 SSH Agent、Host Key 固定和
  有界系统探针。
- [ ] 私钥与受限 OpenSSH config 导入。
- 签名、side-by-side GoodBuddy Agent 安装和按需 detached Daemon。
- SSH connection pool、固定 attach relay、Agent 控制协议、Agent 本地 ACP 日志和断线重连同步。
- 远程工作区、Git、终端和受管进程。
- 先完成签名 OpenCode bundle、Ask bubblewrap、Execute 直接进程、官方 ACP channel、
  Main 模型网关、取消、超时和活动记录。
- OpenCode 闭环稳定后，Continue 与 DeepSeek Harness 复用相同面板和通道契约逐个接入。
- 新增或重新验证 Host 时只保存并探测 Agent/Runtime，不自动安装。用户在 Host 卡片用
  单一主按钮启动，并用次级控件选择自动、Host 下载或 GoodBuddy 传输；Host 保存与环境
  准备是两个可独立重试的事务。
- 控制面直连源码直接使用既有 package format v1 包；不等待发布携带 installer 的新
  Agent 包，也不通过额外目录元数据判断 bootstrap 能力。GitHub/北京镜像、
  Linux x64/arm64、取消和离线 GoodBuddy 传输仍须真实 Host 验收，不能据此声称已发布或已完成
  真实 Host 测试。
- 一次远程项目保存请求完成 Host/Agent/Workspace/Runtime 当前环境验证和 SQLite 原子
  提交，但只持久化 Host、路径、Runtime 选择和模式，也不获取或安装组件。
- 桌面更新后，用户先在 Host 管理中更新当前签名 Agent/Runtime；远程项目下一次实际使用
  Workspace/Runtime 时直接使用新的 current 环境，无需刷新项目绑定。应用启动和项目切换
  本身都不连接 Host，也不下载或安装组件。
- SSH、Main、Daemon、Runtime 和远端重启后的核对、恢复与 `outcome_unknown`。
- 支持平台的安装、Ask、Execute、取消和重连冒烟测试通过后开放对应 OpenCode 能力。

### 阶段 5：开放后的扩展

- 更多远程系统和架构。
- PDF、Office 和数据成果预览。
- Conversation、Task 和实验的完整监督。
- 用户可导入导出工作栏布局和主机非敏感配置。

## 17. 验收标准

### 17.1 稳定能力目录与用户控制

- [ ] 八个标准能力在所有主要页面的目录中始终可发现，但不会默认同时打开。
- [ ] Task Center 继续作为 Task 的单例索引，不删除入口、不复制会话，也不混入 Job、Run 或心跳事项。
- [ ] 项目、会话、Runtime 或主机变化不会无提示地增删能力目录项。
- [ ] 用户可以按需打开、关闭、排序和停靠面板实例。
- [ ] 用户可以独立设置每个可绑定目标的面板实例跟随或固定目标，并为同一能力打开多个目标实例。
- [ ] 固定目标失效后显示修复状态，不静默切换。
- [ ] 后台事件不会无条件打开面板或抢占用户当前实例。
- [ ] 用户可一键恢复标准能力目录和默认的少量打开面板。

### 17.2 通用使用

- [ ] 没有项目时仍可创建终端、选择工作区、打开浏览器和查看成果。
- [ ] 监督可以作用于普通 Conversation、Task 和后续实验对象，不假设编程语境。
- [ ] 工作区不是 Git 仓库时仍可浏览文件。
- [ ] Runtime 不支持某项原生能力时仍可从目录打开面板并获得准确说明。

### 17.3 安全与控制

- [ ] Renderer 没有任意文件、Shell、进程、PTY、SSH 或 Electron API。
- [ ] Agent 不能未经授权向用户终端注入命令。
- [ ] 进程面板不能枚举或终止任意系统进程。
- [ ] Ask 在本机和远程执行空间均无法调用写入或外部副作用工具。
- [ ] HTML 预览无法执行脚本、联网、打开窗口、提交表单或访问 Electron API。
- [ ] Supervisor 不能自动发送消息、批准工具、切换工作模式或扩大范围。
- [ ] SSH 首次连接和 Host Key 变化均经过明确验证流程。
- [ ] 凭据不进入 Renderer、日志、SQLite 明文或命令参数。
- [ ] Host 地址、用户或 Host Key 变化会关闭旧连接，并使旧 Workspace 和 Runtime 会话失效。

### 17.4 生命周期与恢复

- [ ] Runtime、终端、Task 级执行和进程具有权威 Main 快照和有序增量事件。
- [ ] 取消、终止、失败、断线和应用退出都有确定终态。
- [ ] 远程执行只通过按需 detached Daemon 提供，SSH attach 断开不销毁 Daemon 状态。
- [ ] 重连先恢复 event cursor 并查询 operation；有副作用操作不会自动重放，无法确认的
  结果显示为 `outcome_unknown`。
- [ ] Agent side-by-side 更新支持所需签名版本的健康切换，失败时保留旧项目绑定。
- [x] 新增 Host 只探测远端下载能力，不提供自动安装开关，也不传输完整包；Host 卡片用
  一个按版本事实命名的主按钮与不持久化的 acquisition SegmentedControl 启动准备。
- [x] 创建、保存、打开和切换托管 SSH 项目都从 Host current registry 与当前 Agent
  连接验证环境；项目只保存稳定配置，且这些流程不下载 `.gbagent`、上传 payload 或发布
  安装。
- [ ] 切换跟随目标后不显示上一对象的过期状态。
- [ ] 固定目标的订阅在页面切换后保持，关闭时正确释放。
- [ ] 日志、终端、文件、成果和远程传输均有明确上限和背压。

### 17.5 可用性

- [ ] 宽、中、窄窗口均可访问完整能力目录和用户打开的面板实例。
- [ ] 工作栏在宽、中、窄窗口展开时都推动主工作区回流，不覆盖、遮罩或隔离主内容；唯一
  开关始终固定在窗口关闭按钮正下方。
- [ ] 仅使用键盘可以选择能力、面板实例、目标、执行空间和控制动作。
- [ ] 状态不只依赖颜色，徽标具有文字或可访问名称。
- [ ] 终端、HTML、监督证据和高频日志具有可访问替代或降噪行为。
- [ ] 浏览器 Tab 顶部工具栏始终清楚区分“停止加载”和“关闭浏览器”；地址编辑草稿不会被
  权威状态刷新覆盖，用户与 Agent 的导航通过同一 `BrowserService` 会话串行执行。
- [ ] 创建中、Agent 操作中和完整交互期间禁用浏览器其余工具栏控件；活动加载仍可单独停止，
  且停止加载不会关闭会话或释放 Runtime 上下文。
- [ ] 活动 Conversation 没有浏览器会话时，可从同一地址栏按 Agent 相同 URL 策略启动会话。

## 18. 相关文档的职责

- 本文是助手工作栏稳定能力目录、用户面板实例、范围控制和执行空间的产品总契约。
- [助手工作栏多终端页签 PRD](./terminal-tabs-prd.md) 定义持久“+”、应用实例策略、
  动态 Tab 以及本机与直接 SSH 多终端。
- [Task 与 Job 统一领域模型](../task-and-job/task-and-job-model.md) 定义 Task、Conversation、
  Job、Subjob、Run 与 Subagent。
- [Task Center PRD](../task-and-job/task-center-prd.md) 定义应用级 Task 索引。
- [智能心跳 PRD](../smart-heartbeat/prd.md) 定义心跳入口、范围和长期边界。
- [会话监督 PRD](../conversation-supervision/prd.md) 定义监督判断、证据、预算和介入边界。
- [自动化平台总体设计](../../architecture/automation-platform-architecture.md) 定义 Plan、Job、Run、监督、预算和记忆。
- [长期助手路线图](../../roadmap/long-term-assistant-roadmap.md) 记录整体长期能力与实施背景。
- [DeepSeek Harness Runtime 设计](../deepseek-harness/technical-design.md) 定义该 Runtime 的具体适配边界。
- [SSH Host 远程环境准备与直连下载设计](../remote-host/environment-provisioning-technical-design.md)
  定义 Host 级组件获取、首次准备、更新、回退和项目只验证边界。
- [统一界面设计系统](../../../UI-DESIGN.md) 定义视觉、语义、响应式和无障碍规则。

若其他文档把工作栏描述为八个同时固定显示的栏目、根据项目或 Runtime 自动裁剪的动态入口，
或仅属于当前聊天的附属区域，以本文“能力目录稳定、面板实例由用户打开、当前上下文只提供
默认值”的产品决策为准。
