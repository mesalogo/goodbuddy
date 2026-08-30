# GoodBuddy 自维护 DeepSeek Harness Runtime 设计

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档状态 | 实现与发布验收基线 |
| 设计目标 | 将 DeepSeek Harness 作为 GoodBuddy 的第三个 Agent Runtime |
| Runtime 标识 | `deepseek-harness` |
| 当前依赖基线 | 实际使用的 `@deepseek-ai/dsh-*` 底层库，精确锁定 `0.1.0-rc.8` |
| 上游状态 | Developer Preview，允许出现破坏性变更 |
| 上游许可证 | MIT |
| GoodBuddy 目标平台 | Windows、macOS、Linux，x64 与 arm64 |
| 本文性质 | 设计与发布验收约定 |

本文定义 DeepSeek Harness 在 GoodBuddy 中的架构边界、协议、执行策略、插件市场、界面、打包和验收要求。实现必须继续遵守 GoodBuddy 已有的 Main 进程安全边界、Ask/Execute 语义、取消、超时、有界输出和资源回收约定。

## 2. 摘要

DeepSeek Harness 的底层库使用 Cordis 组合服务。GoodBuddy 不采用官方产品 profile，也不允许用户配置覆盖内部 Host 或控制服务；GoodBuddy 自行维护 Host、控制协议和生命周期，同时提供一个由 Main 管理、默认关闭的 npm 插件市场。用户显式开启后，市场只搜索带精确 `dsh-plugin` 关键字的公共 npm 包，不代表 GoodBuddy 审核、推荐或承诺兼容这些包。

用户明确安装并启用的插件以当前用户权限运行。Ask/Execute 只控制模型经过 `tools/execute` 发起的工具调用：Ask 只允许 Host 中真实注册的 `read`、`skill` 和 Main 管理的 Web Search/Fetch 代理，Execute 放行 Host 中全部已注册工具。插件不能用同名工具冒充 Ask 允许项。插件安装脚本和初始化代码不属于模型工具调用，不能由 Ask 限制，因此界面在安装前必须明确确认这一边界。

整体分成两个互相约束的部分：

1. **GoodBuddy Main Control Plane**
   - 运行在 Electron Main 进程。
   - 持有加密设置、模型连接选择、Ask 只读策略、Runtime 生命周期、插件市场状态和审计归属。
   - 通过 Electron `utilityProcess` 启动受控 Harness 子进程。
   - 对环境、输入、输出、超时、取消和进程树执行强制限制，并只把已启用插件的受管入口传给 Host。

2. **GoodBuddy Harness Control Plane**
   - 运行在 Harness 子进程内，是 Host 私有的内部控制组件，不导出 Cordis 插件入口。
   - 使用 ACP 兼容的 JSON-RPC stdio 作为基础控制面。
   - 增加 GoodBuddy 所需的能力握手、每轮权限准备、会话释放、工具事件、推理、用量和安全凭据请求扩展。
   - 与 GoodBuddy Host 一起维护、构建和发布，不设计为独立 npm 包或市场插件；第三方插件只作为显式配置加载。

DeepSeek Harness 不替换 OpenCode、Continue 或直连模型 Runtime。用户可以按全局、项目、会话或消息通道继续选择现有 Runtime。

## 3. 背景与上游能力

### 3.1 已确认的官方能力

- `@deepseek-ai/dsh` 是官方 profile 启动器。
- Harness 插件是导出 `apply(ctx, config)` 的 Cordis 模块。
- npm 包可通过 `dsh.bundle` 声明配置补丁，再通过 `dsh plugin --profile <name> add <package>` 安装。
- ACP 支持：
  - 初始化。
  - 创建多个会话。
  - 发送 Prompt。
  - 按会话取消。
  - 一次性权限选择。
  - 已提交的助手文本。
- 官方本地沙箱支持：
  - Linux：Bubblewrap，或 Landlock 降级。
  - macOS：Seatbelt。
  - Windows：ACL 受限令牌，官方明确标记为部分强制执行。

GoodBuddy 不组合上述 Runtime OS 沙箱。当前产品选择 DSH 本地 Shell 与
Filesystem Provider，以 GoodBuddy 客户端进程的当前用户权限运行工具。

### 3.2 官方通道的缺口

官方 ACP 插件有意只输出已提交文本，不输出推理、工具进度、计划、标题和用量。它也没有标准的会话关闭方法。SDK JSON-RPC 的展示事件更完整，但缺少 GoodBuddy 需要的单轮取消和权限回传。

因此，首版不单独选用其中一个官方通道作为完整实现。GoodBuddy Harness Control Plane 以 ACP 语义为基础，补充有命名空间的扩展方法和事件。

### 3.3 自维护边界

GoodBuddy 自己的 Runtime 和控制面不包装成标准 DSH 插件，也不加载用户 profile 或自定义 Host。只有 GoodBuddy Main 可以启动内部 Host、选择受管插件入口并处理启动失败。公共 npm 市场是第三方扩展来源，不改变 GoodBuddy 对内部 Host、Ask/Execute 语义和协议版本的控制。

## 4. 目标与非目标

### 4.1 首版目标

- 增加 `deepseek-harness` Runtime，并在设置、聊天和消息通道中可选择。
- 使用 GoodBuddy 管理的模型连接，不在 Renderer 或持久化 Harness 配置中写入 API Key。
- 当所选模型连接明确声明支持图像输入时，允许向 DeepSeek Harness 发送有界的 JPEG/PNG；文本模型在启动 Host 或调用模型前拒绝图片。
- Ask 模式在 Runtime 工具分发边界强制只读，阻止 Shell、写入和编辑工具。
- 在 Web Search 能力启用时，通过 Main 代理向 Ask 与 Execute 提供有界的 `web_search` 和 `web_fetch`，Harness Utility 不持有服务凭据。
- Execute 模式使用 DSH 本地 Provider，以当前用户权限执行文件与命令工具；工作区是默认工作目录，不是 OS 权限边界。
- 提供默认关闭的公共 npm DSH 插件市场总开关；用户显式开启后可搜索、查看详情、精确版本安装、启用、停用、配置和移除，首次安装前明确确认当前用户权限。
- 只加载 Main 明确传入的已启用插件；单个插件启动失败不得阻止 Host，并自动停用失败插件。
- 允许 Skills 和自定义 MCP 显式分配给 DeepSeek Harness；自定义 MCP 只在 Execute 中通过 Main 代理。
- 设置页可读取有界的 Host/插件原生 Tool 与 Skill 清单；Tool 元数据显示类型、来源及 Ask/Execute 可用性，并明确排除 GoodBuddy 分配的 Skills、Web/MCP 请求代理。
- 支持多会话、同会话串行、跨会话并行。
- 支持按请求取消、超时、会话释放和应用退出时完整回收。
- 输出文本、推理、工具参数、工具结果、stderr 和协议队列全部有界。
- 使用真实 OpenAI 兼容 Chat Completions 模型验证调用，而不在日志、测试产物或提交中暴露凭据。
- 保留 Windows、macOS、Linux 的 x64 和 arm64 发布能力。

### 4.2 首版非目标

- 不替换 OpenCode、Continue 或直连模型 Runtime。
- 不开放用户 Cordis profile、cordis.patch.yml 或 $DSH_HOME 全局补丁覆盖。
- 不提供外部 Host、自定义 Harness Control Plane、任意本地模块路径或用户 profile 插件目录。
- 不加载 Harness Web UI、HMR、遥测、自动更新或目录选择器。
- 不提供 Runtime OS 沙箱模式或相关持久设置。
- 不向 Utility 暴露 MCP 凭据或建立直连 MCP Client。只有用户明确分配给 Harness 的 MCP 工具可以通过 Main 代理调用。
- 不在首版向 Harness 暴露 GoodBuddy 浏览器控制、知识库或 Magic Notes。
- 不在首版支持会话恢复、Harness Subagent、后台 Job、Hook、浏览器控制或 Workflow；Web Search/Fetch 只通过 Main 代理提供，不加载 Harness 自有网页服务。上述长生命周期能力未来统一进入右侧 Runtime 监督栏，不进入 Composer 工具栏。
- 不发布独立 npm 包，也不创建上游 PR。
- 不为第三方插件增加权限矩阵、风险等级、逐工具审批、沙箱档位、回滚代际或兼容性背书。

## 5. 核心设计决策

### 5.1 第三个独立 Runtime

`deepseek-harness` 是明确的 Runtime 类型，不伪装成 `model`、`opencode` 或 `continue`。共享契约、设置迁移、Runtime 选择、检测、聊天标签、消息通道和模型用量都使用同一个稳定标识。

### 5.2 受控组合，不启动用户 profile

GoodBuddy 使用自己固定的 Harness Host 入口和只读组合模板，不调用 `dsh web`，也不启动用户已有 profile。运行时禁止以下来源参与组合：

- 当前工作目录的 `.env`。
- 用户 Harness Home 的 `.env`。
- `$DSH_HOME/cordis.patch.yml`。
- 用户 profile 的 `cordis.patch.yml`。
- 任意 `--patch`。
- HMR 和 profile 驱动的动态插件安装。

模型名称、服务地址、工作区、Skills、MCP schema 和已启用插件的规范化入口通过严格校验的 Main 配置传给 Host。API Key 只通过受控凭据通道按需提供，不写入 YAML、命令行、Renderer 或日志。插件配置只来自 GoodBuddy 受管状态，不合并用户 profile 或全局补丁。

### 5.3 双层内部控制面

Harness 子进程内控制面不能取代 Main 控制面，Main 控制面也不能代替进程内的 Session/Tool 适配层：

- Harness Control Plane 最接近 Session、Agent、Tool 和 Usage seam，适合做内部协议转换与 Ask 工具拦截。
- Main 控制面是可信安全边界，适合持有模式授权策略、加密设置、进程控制和 IPC。

任何一侧缺失能力握手时，Runtime 必须报告不可用，不能降级为不受控执行。

### 5.4 GoodBuddy 继续拥有持久会话

首版不启用 Harness JSONL 会话持久化和 SQLite 会话索引。原因如下：

- GoodBuddy 已经持久化对话、消息、活动、工具事件和用量。
- 再写一份 Harness 日志会扩大敏感数据副本和清理范围。
- GoodBuddy 在 Runtime 重启后可以用现有的有界历史创建新 Harness Session。

Harness Session 只在当前 Runtime 进程生命周期内存在。释放 GoodBuddy 会话时必须同步释放对应 Harness Agent。

## 6. 总体架构

```text
Renderer
  │ 显式、经 schema 验证的 preload API
  ▼
Electron Main
  ├─ RuntimeSettingsStore
  ├─ RuntimeExtensionStore / npm Marketplace
  ├─ AgentRuntimeController
  ├─ RuntimeAuthorizer（Ask 拒绝 / Main 代理工具授权）
  └─ DeepSeekHarnessRuntime / Main Control Plane
       │ ACP + goodbuddy/* 扩展，stdin/stdout
       ▼
Electron utilityProcess
  └─ GoodBuddy Harness Host
       ├─ 固定 Cordis 组合
       ├─ GoodBuddy Harness Control Plane（内部组件）
       ├─ DSH Agent 与 LLM seam
       ├─ 按模型能力挂载的有界内存图片存储
       ├─ 本地 Shell / Filesystem Provider
       ├─ 最小工具集与 Main 代理 MCP
       └─ Main 明确启用的第三方 Cordis 插件
             │ HTTP/HTTPS
             ▼
        用户选择的 OpenAI 兼容模型连接
```

### 6.1 信任边界

| 区域 | 信任级别 | 允许持有的内容 |
| --- | --- | --- |
| Renderer | 不可信展示层 | 脱敏设置、状态、用户可见事件 |
| Preload | 窄桥 | 明确方法和共享 schema |
| Electron Main | 可信控制面 | 加密设置、模式授权策略、Runtime 生命周期 |
| npm 安装子进程 | 第三方执行面 | 受管暂存目录、去除模型凭据的有界环境和当前用户权限 |
| Harness utilityProcess | 不可信执行面 | 当前请求、临时凭据、受控工具、第三方插件代码和当前用户权限 |
| Harness 工具子进程 | 最低信任 | 单次命令所需的最小环境和当前用户权限 |

Harness 子进程崩溃、输出异常、拒绝协议或加载错误时，Main 必须失败关闭。

## 7. GoodBuddy Harness Control Plane

### 7.1 内部组件职责

控制面负责：

- 启动 ACP 兼容的 JSON-RPC stdio 服务。
- 创建、查找和释放 Harness Agent。
- 在 Prompt 前应用 GoodBuddy 指定的 Ask/Execute 权限。
- 将 DSH Session 事件转换为有界的 GoodBuddy 事件。
- 将 LLM 用量转换为稳定的模型用量事件。
- 根据 Main 传入的模型能力声明 ACP 图片能力，验证内联图片并转换为 DSH 的不可变 Attachment 引用。
- 在 dispose 时先取消 Agent，再等待子 Agent 和工具清理。
- 保证 stdout 只包含协议帧，诊断只写 stderr。

控制面不负责：

- 保存 GoodBuddy 设置。
- 持久保存 API Key。
- 决定 Main 的模式授权结果。
- 直接访问 Renderer 或 Electron API。
- 接受任意路径、外部 Host 或 profile 覆盖；插件入口只能来自 Main 的受管清单。
- 自行上传遥测。

### 7.2 第三方插件加载

GoodBuddy 控制面自身不导出 `apply(ctx, config)`，也不提供默认 stdin/stdout 入口或可安装 manifest。第三方插件由 Main 在启动配置中逐项指定：

- Main 只传递受管 Store 中已启用插件的稳定 ID、规范化入口文件和 JSON 配置。
- Launcher 与 Host 对消息结构和绝对入口路径执行严格校验；Host 解析真实路径并要求入口是普通文件。
- Host 动态加载 Cordis 插件并等待激活，每个插件有独立的 5 秒激活超时，完整插件序列最多占用 90 秒。
- Main 的 Host 启动预算使用 10 秒基础预算，加上每个已启用插件 5 秒激活与最多 1 秒失败清理、且整个插件序列最多占用 91 秒，再预留 2 秒保存失败插件状态；显式测试超时仍作为调用方指定的硬上限。
- 插件按清单依次加载；导入、导出形态或激活失败只记录该插件，不阻止其他插件和 Host 启动。失败 Fiber 的清理同样有界。
- 有限但超过预算的同步导入或同步 `apply` 在返回后按超时失败并继续加载后续插件；JavaScript 不能在同一事件循环内抢占永不返回的同步第三方代码，此时由 Main 的独立启动截止时间终止整个 Utility。
- 失败 ID 在 ready 握手中返回 Main；Main 原子写入停用状态和启动错误。
- 插件成功激活后可注册工具或后台生命周期逻辑。Ask 只能拦截模型工具调用，不能撤销初始化阶段已经发生的副作用。

GoodBuddy 不扫描任意目录、不读取用户 profile 插件清单，也不接受 Renderer 直接提供文件路径。
插件安装、升级和移除在目录重命名前写入受管变更日志。Main 下次初始化时以持久
Store 是否已经提交为准，确定性完成新目录或恢复旧目录，并在处理前重新验证受管
目录、入口真实路径、符号链接和根目录包含关系。旧版 `store.json` 继续原地迁移，
不要求用户重新安装插件。

## 8. 协议设计

### 8.1 传输

- stdin/stdout 使用换行分隔 JSON-RPC。
- stdout 不得出现日志、Banner、进度条或调试输出。
- stderr 只允许有界诊断，不得包含 Prompt、工具完整输出或凭据。
- 每一帧、每一字段和每个请求累计输出都必须在解析前或接收时限流。
- 图片只允许作为 ACP 内联 base64 内容传入；拒绝远程 URI，Host 不替用户获取图片 URL。

### 8.2 标准 ACP 方法

首版保留 ACP 的初始化、`session/new`、`session/prompt` 和 `session/cancel` 语义。`promptCapabilities.image` 必须与所选模型连接的 `supportsImageInput` 完全一致，不能仅根据 Provider 或模型名称猜测。标准 ACP 客户端可以使用只读默认行为，但只有完成 GoodBuddy 能力握手的客户端才能启用 Execute。

### 8.3 GoodBuddy 扩展

扩展统一使用 `goodbuddy/` 命名空间：

| 方法或事件 | 方向 | 用途 |
| --- | --- | --- |
| `goodbuddy/handshake` | Main → Control Plane | 交换控制协议、Harness、ACP 版本和能力 |
| `goodbuddy/session/prepare` | Main → Control Plane | 在下一次 Prompt 前设置工作模式和请求标识 |
| `goodbuddy/session/release` | Main → Control Plane | 取消并释放指定 Session |
| `goodbuddy/session/event` | Control Plane → Main | 文本、推理、工具、状态和用量事件 |
| `goodbuddy/credential/resolve` | Control Plane → Main | 按已登记引用请求当前 Runtime 的临时凭据 |
| `goodbuddy/tools/list` | Control Plane → Main | 取得 Main 管理的有界 Web 工具与当前 Execute 请求的 MCP 工具 schema |
| `goodbuddy/tools/call` | Control Plane → Main | 校验活动请求、工作模式、参数和精确注册代理身份后调用 Main Web/MCP 工具 |
| `goodbuddy/native/snapshot` | Main → Control Plane | 从无 Agent scope 的 Host Registry 读取有界的原生 Tool/Skill 元数据，排除 GoodBuddy 分配项与请求级代理 |
| `goodbuddy/shutdown` | Main → Control Plane | 停止接收新请求并有序清理 |

Utility 启动控制协议使用版本 2，严格携带 `supportsImageInput` 与固定 8 MiB 帧上限；版本 1 或缺少该字段的启动消息失败关闭，不能让 Host 自行猜测模型能力。扩展版本独立于 ACP 版本。握手响应至少包含：

```ts
type GoodBuddyHarnessCapabilities = {
  controlProtocolVersion: 1
  harnessVersion: string
  acpProtocolVersion: number
  supports: {
    cancellation: true
    sessionRelease: true
    reasoningEvents: boolean
    toolEvents: boolean
    usageEvents: boolean
    credentialResolution: true
  }
  execution: {
    mode: 'host'
  }
}
```

版本不兼容、必需能力缺失或 `execution.mode` 不是 `host` 时，Main 不得开始模型请求。

### 8.4 每轮权限准备

GoodBuddy 的工作模式属于每个请求，不属于 Runtime 进程全局状态。同一对话可以在 Ask 和 Execute 之间切换。因此：

1. `session/new` 后默认是 Ask。
2. 每个 Prompt 前，Main 发送一次 `goodbuddy/session/prepare`。
3. Harness Control Plane 将准备状态绑定到 `sessionId + requestId`。
4. `session/prompt` 只能消费匹配且尚未使用的准备状态。
5. 缺少准备状态、重复使用、请求标识不匹配时，Control Plane 直接拒绝请求。
6. 同一 Session 只允许一个 Prompt 在途。

### 8.5 事件模型

Harness Control Plane 只发送 GoodBuddy 能稳定解释的字段：

- `status`：简短运行状态。
- `text`：已提交的助手文本分片。
- `reasoning`：可选的有界推理摘要分片。
- `tool`：工具 ID、名称、状态和有界输入/输出摘要。
- `model-usage`：模型、提供方、输入、输出和缓存 Token。
- `done`：停止原因和 Session ID。

禁止发送原始 Cordis Context、完整环境、内部对象、堆栈中的凭据或无界 Session 日志。

## 9. Runtime 生命周期

### 9.1 进程模型

- 每个活动的 DeepSeek Harness Runtime 实例拥有一个 `utilityProcess`。
- 一个进程可以承载多个 Harness Session。
- 同一 GoodBuddy 对话的 Prompt 串行执行。
- 不同对话可以并行，但受全局并发上限控制。
- Runtime 设置变化时创建新实例，旧实例等待在途请求结束或在宽限期后被取消。

### 9.2 会话映射

Main 保存内存映射：

```text
GoodBuddy conversationId -> Harness sessionId + process generation
```

- 首次请求创建 Session。
- 已有 Session 只发送当前 Prompt。
- 进程重启或映射失效时，创建新 Session，并只在这一次加入 GoodBuddy 提供的有界历史。
- 历史以明确的“不可信会话数据”结构传入，不能拼接成系统指令。
- 用户分配的 Skill 只通过 Main 校验的包路径进入 Host，并在 Agent scope 注册；不得把 Skill 内容伪装成用户 Prompt。

### 9.3 取消与有界控制操作

- 用户取消时立即发送 `session/cancel`。
- 取消等待有界，超时后关闭连接并终止整个 Harness 进程。
- 初始化、握手、请求准备、权限回传和关闭分别使用独立控制超时。
- 生产 Prompt 不设置固定墙钟总时限，由 Harness 自身协议终态或用户取消结束。测试可以
  显式注入短 Prompt 时限验证取消传播，超时错误与用户取消仍不能被宽泛 catch 抹平。
- 取消后仍可接收并丢弃该请求的最终协议结算帧，但不得写入下一请求。

### 9.4 释放与退出

- 原生能力清单通过一次性 Runtime 探测，取得有界快照后立即 dispose，不得因浏览设置或切换项目把 Host 缓存在执行 Runtime 池中。
- 删除或释放对话时调用 `goodbuddy/session/release`。
- Runtime dispose 时先拒绝新请求，再取消所有 Session。
- Harness Control Plane 完成 Agent、工具和会话清理，Host 完成 Cordis Fiber 与子进程的反向清理。
- Main 在宽限期内等待正常退出。
- 超时后终止 utilityProcess，并在平台允许时清理完整进程树。
- 应用退出时中止正在运行的 npm 插件安装并终止其完整进程树，不能让 lifecycle script 在 GoodBuddy 退出后继续运行。
- 应用退出不得因 Harness 清理无限阻塞。

## 10. 权限与主机执行

### 10.1 模式映射

| GoodBuddy 模式 | Host 内置与插件工具 | Main Web Search/Fetch | GoodBuddy 自定义 MCP | 行为 |
| --- | --- | --- | --- | --- |
| Ask | 只允许 Host Registry 中真实注册的 `read` 与 `skill`；其他 Host/插件工具一律拒绝 | 能力启用时注册 Main 的精确代理对象，无逐次审批 | 不注册 | 模型工具调用保持只读 |
| Execute | 放行 Host 中全部已注册的内置与插件工具 | 能力启用时注册 Main 代理 | 按分配注册并经过既有 RuntimeAuthorizer | 不增加插件权限层，以当前用户权限运行 |

### 10.2 Ask 模式

- Harness Control Plane 在 `tools/execute` 分发边界识别当前 Session 和在途请求。
- 采用所有权感知的只读允许列表，只接受 Registry 中真实的 `read`、`skill` 和 Main 注册的 Web 代理对象；`write`、`edit`、Shell、MCP 及任意新插件工具默认拒绝。只比较工具名不足以授权，插件注册同名工具仍会被拒绝。
- Ask 不注册 Main 代理的 MCP 工具。
- Web Search/Fetch 的凭据、传输与结果限制保留在 Main；Utility 只看到有界 schema 和结果。
- 只读不等于无限输出，读取仍受字节和工具结果上限控制。
- 插件安装脚本和 Cordis 初始化生命周期不经过 `tools/execute`。Ask 不能把已启用第三方代码变成沙箱，也不能保证第三方代码没有启动副作用。

### 10.3 Execute 模式

- 工作区来自 Session 创建时的规范化绝对路径，并作为文件与命令工具的默认工作目录。
- DSH 本地 Filesystem、Bash 或 PowerShell Provider 直接使用 GoodBuddy 客户端当前用户的 OS 权限。
- 工作区不是 containment 边界；绝对路径和命令可访问当前用户本来有权访问的主机资源。
- 已启用插件注册的工具与内置工具使用同一分发路径；GoodBuddy 不增加插件权限矩阵或逐工具确认。
- Main 代理的 MCP 工具继续执行分配、schema、活动请求、模式和 RuntimeAuthorizer 校验。
- 所有工具调用仍作为活动事件记录；Ask 和 delegation 路径继续固定拒绝。

### 10.4 Runtime OS 沙箱

- GoodBuddy 不加载 DSH 平台 Sandbox Provider，也不执行启动沙箱探测。
- “安全与数据”不提供 Runtime OS 沙箱开关。
- 握手明确报告 `execution.mode = 'host'`，状态文案明确说明工具使用当前用户权限。
- Electron Renderer、Preload、Browser Session 等应用安全沙箱不在本设计变更范围内。

### 10.5 环境与凭据

- 使用环境变量白名单构造 utilityProcess 环境。
- 不继承 `NODE_OPTIONS`、调试端口、任意 npm 配置、用户 `DSH_*` 覆盖或白名单之外的凭据。
- `DSH_TELEMETRY_DISABLED=1` 必须固定设置。
- Harness Home 指向 GoodBuddy 管理的隔离目录。
- 不调用官方 `loadEnv` 或 `loadLayeredEnv`。
- API Key 由 Main 从加密设置中解析。
- Harness Control Plane 只能用已握手登记的引用通过 `goodbuddy/credential/resolve` 请求当前 Runtime 的凭据。
- 凭据只在模型请求所需的子进程内存中短暂存在，不写磁盘、不进入工具环境、不打印。
- npm 安装使用同一环境白名单并移除模型 Provider 凭据；安装脚本仍拥有当前用户的文件、进程和网络权限。

## 11. 受控 Harness 组合

首版只加载完成文本对话、受控代码操作和用户明确分配能力所需的固定服务：

- Agent、Session、LLM 和 Tool Registry 基础服务。
- GoodBuddy Harness Control Plane。
- OpenAI 兼容 Chat Completions LLM 适配器。
- 仅在所选模型声明图片能力时挂载的进程内 Attachment Store；它完整解码图片、校验格式/尺寸/摘要，以内容寻址引用保存，并随 Session 或 Host 释放。
- DSH 本地 Subprocess、Filesystem 和平台 Shell Provider。
- Token Meter 和必要的上下文压缩。
- 有界的读取、写入、编辑和 Shell 工具。
- Agent scope 的 Skill Registry 与 `skill` 工具。Skill 目录由 Main 选择并在 Launcher 和 Host 两次规范化、校验。
- Main 代理的 Web 与 MCP schema 工具。Utility 不持有 Web/MCP URL、凭据或 Transport。
- Main 明确传入的第三方 Cordis 插件及其 JSON 配置。

首版明确不加载：

- Web UI、HMR、Host API 和目录选择器。
- Harness 遥测。
- Settings File 和 Local Credentials。
- 用户 profile 与全局补丁。
- Harness 自有 Web Search/Fetch、Utility 直连 Web/MCP、Hooks。
- Subagent、Workflow、Ralph、后台 Job。
- JSONL Session Persistence 和 SQLite Session Query。
- 自动技能发现、任意目录扫描和 profile 市场状态。

如果某个首版工具依赖被排除服务，启动审计必须失败，而不是自动加载更大的默认 bundle。

## 12. 模型配置

### 12.1 配置来源

DeepSeek Harness 首版只使用符合下列边界的 GoodBuddy 模型连接：

- 协议必须是 `openai-chat-completions`。
- 认证必须是 API Key。
- 服务地址支持 HTTP 和 HTTPS，不根据主机位置、端口、凭据、查询参数或片段增加额外限制。
- 模型名称不限制为 DeepSeek 品牌，由所选 OpenAI 兼容服务决定。
- 模型名称和服务地址由 Main 传入受控 Host。
- 图片能力只读取所选 GoodBuddy 模型连接的 `supportsImageInput`；Main、Utility 启动配置、ACP 能力和 Pi-AI 模型输入模态必须使用同一个布尔值。
- API Key 继续保存在 GoodBuddy 加密设置中。
- 启动环境提供的部署连接只由 Main 自动解析，不在 Renderer 中显示为可选来源。

不允许选择 Harness 自有的用户配置文件或自定义 Host。Runtime 始终使用随当前 GoodBuddy 版本发布的内置 Host，并通过完整内部能力握手。

### 12.2 设置变化

模型、凭据、Skill、MCP 分配或插件安装、启停、配置、移除变化时，GoodBuddy 创建新 Runtime 实例。Harness Host 路径始终由当前 GoodBuddy 构建提供，不能由设置或环境变量替换。旧实例按现有 Runtime Controller 语义退役，不在一个活动进程内热替换配置。

### 12.3 输入限制

- 文本始终可用；图片是否可用完全取决于所选模型连接是否显式声明 `supportsImageInput: true`。
- 文本模型收到图片时必须在启动 Host 或发起模型网络调用前返回明确错误，不能静默丢弃图片。
- 图片模型只接受内联 JPEG/PNG，不接受 URL、文件路径、ACP `uri` 或其他媒体类型。
- Main 已通过 `nativeImage` 解码用户选择的图片并生成有界模型输入；Utility 仍须独立执行严格 base64、签名、容器结构、CRC（PNG）、完整解码、尺寸和摘要校验，不能把 Main 校验当作跨进程信任替代。
- 每条消息最多 8 张图，单图编码后最多 1 MiB，图片合计最多 2 MiB，单边最长 8,192 px，单图最多 1,600 万像素，累计解码像素最多 3,200 万（重复引用也计入预算）。进程内 Store 另设 32 MiB、256 个唯一对象的总上限。
- Attachment Store 只服务当前非持久 Harness Session；引用按 Session 释放，Host 退出时清空，不写入磁盘或 GoodBuddy 第二份会话日志。
- GoodBuddy 历史、Prompt、系统指令分别保持不同信任层。
- 任何用户文本都不能进入 Cordis 配置表达式或模块名。

## 13. 输出和资源边界

建议首版默认限制：

| 项目 | 默认上限 |
| --- | --- |
| 单个 JSON-RPC 帧 | 8 MiB |
| 单图 / 单条消息图片 | 1 MiB / 8 张且合计 2 MiB |
| 单图尺寸 / 单条消息解码像素 | 单边最长 8,192 px 且 1,600 万像素 / 3,200 万像素 |
| Host 临时图片存储 | 32 MiB 且最多 256 个唯一对象 |
| 单个文本或推理事件 | 64 KiB |
| 单次请求累计协议输出 | 4 MiB |
| 工具输入摘要 | 4,000 字符 |
| 工具输出摘要 | 4,000 字符 |
| 待处理事件数 | 1,000 |
| stderr 累计 | 64 KiB |
| Host 启动 | 10 秒基础预算 + 每插件 5 秒激活与最多 1 秒失败清理，插件序列最多 91 秒；Main 另预留 2 秒持久化失败状态 |
| ACP 初始化与内部握手 | 每阶段 10 秒 |
| 单次 Prompt | 无固定墙钟总时限，由 Harness 终态或用户取消结束 |
| 有序关闭宽限期 | 2 秒 |

超过限制时应取消当前请求。协议帧、队列或 stderr 持续异常时，应终止 Runtime 进程，避免继续信任已失控的通道。

## 14. Runtime 检测与状态

### 14.1 检测

检测只验证：

- 内置 Host 路径是规范化文件。
- 版本可读取且在支持范围内。
- 内部控制面能力握手成功。

检测不得调用付费模型，也不得读取或输出 API Key。真实模型测试是单独的显式操作。

### 14.2 设置界面

Agent Runtime 使用共享 `SegmentedControl` 展示 OpenCode、Continue 和 DeepSeek Harness。DeepSeek Harness 必须标记为“开发者预览”，并说明上游 RC 可能发生破坏性变更。

Runtime 的概览、模型配置和检测信息放在同一张详情卡中。当前单独显示的一行“已就绪”应移入卡片，与路径、版本号归为同一组：

```text
Runtime：       GoodBuddy 内置 DeepSeek Harness
模型配置：      跟随 GoodBuddy · 企业网关（qwen-plus）
状态：          已就绪
路径：          <受控 Host 路径>
版本：          0.1.0-rc.8
执行权限：      当前用户权限

Host 始终由当前 GoodBuddy 版本提供，不存在自定义 Host 入口。
```

界面要求：

- 不再在卡片外重复一行检测结果。
- 使用语义化键值结构，路径允许换行，不截断关键信息。
- 状态不能只依靠绿色表达，必须同时有文字。
- 检测中和不可用分别显示明确文案。
- 高级设置默认收起。
- DSH 插件市场提供共享 Switch 样式的总开关并默认关闭。关闭时不请求公共 npm 目录且隐藏市场管理界面，但不修改已有插件的逐项启停状态；因此已启用插件继续随 Host 加载，重新开启后恢复原有管理状态。
- 同一 Runtime 页面提供紧凑的 DSH 插件市场：客户端筛选名称、包名、描述和许可证，已安装插件优先显示。
- 安装前使用一个明确 Checkbox 确认 npm 安装脚本、插件初始化和 Execute 工具均使用当前用户权限；不展示权限矩阵或逐工具审批。
- 已安装插件使用共享 Switch 启停，并提供 JSON 配置、明确移除确认和启动失败信息。
- npm 目录离线时仍显示并允许管理已安装插件；目录错误就地显示并可重试。
- 安装、启停、配置和移除的短期结果通过应用通知显示，不重复保留页内成功提示。
- DSH 不提供独立的“允许图片”开关。Runtime 连接选择只引用“模型连接”中维护的图片能力声明，避免同一模型出现两份冲突配置。

聊天顶栏只显示简短 Runtime 状态，不显示文件路径和版本。完整诊断只在设置页展示。

### 14.3 Agent Runtime 交互表面归属

OpenCode、Continue 和 DeepSeek Harness 的后续能力按操作生命周期放置，不按上游产品分别堆叠入口：

| 表面 | 负责内容 | 不负责内容 |
| --- | --- | --- |
| Composer 通用行 | 附件、语音、知识范围、专家、Ask/Execute、Runtime 和发送 | Session 监督、后台进度、历史任务管理 |
| Composer Runtime 专属行 | 仅对当前消息生效且需要高频选择的 Agent、预设、Prompt/Command 快捷操作 | Task 级委派、后台执行、Workflow/Hook 生命周期 |
| 助手工作栏固定“Runtime”栏目 | 用户所选 Conversation 或 Task 的 Runtime 状态、Task 级委派与取消、后台执行进度/结果、Workflow/Hook 运行、长任务暂停/恢复/终止和会话监督；不显示 Job/Run 树 | 持久模型、程序路径、默认 Agent/预设配置 |
| 设置 > Agent Runtime | 持久 Runtime 配置、默认值、插件管理、能力清单和连接诊断 | 某次活动会话的实时控制 |

Runtime 栏目入口始终存在，并采用统一监督模型；内部再按用户所选目标及其 Runtime 的真实能力
显示 OpenCode、Continue 或 DSH 的具体区域。未支持能力不渲染空卡片或一排禁用按钮，而是
在用户需要理解缺口时显示原因和可执行入口。跟随模式切换 Runtime、Conversation 或 Task
时必须清理上一归属的聚合执行状态，固定目标则保持不变。完整工作栏契约见
[通用助手工作栏与执行空间 PRD](../prd/assistant-experience/assistant-workbar-and-execution-spaces-prd.md)。

所有未来的 Subagent、Job、Workflow、Hook 和会话操作仍须经过 Main 的 Runtime 边界，保留取消、超时、权限、Task/Job/Subjob 层级、用量和活动审计。高风险动作在侧栏就地确认，运行结果进入活动与成果记录，不以 Composer 按钮代替监督面板。DeepSeek Harness 首版仍不加载这些服务，本节只确定未来跨 Runtime 的产品位置和协议归属。

## 15. IPC 与共享契约

共享 schema 需要覆盖：

- `deepseek-harness` provider 和 Runtime ID。
- Runtime 选择中的 `deepseekHarness` 分支。
- 检测结果中的路径、版本、详情和主机执行模式。
- GoodBuddy 模型连接选择。
- 从所选模型连接解析并传到 Host 的 `supportsImageInput`，以及 ACP 图片能力的一致性。
- DeepSeek Harness 模型用量归属。
- Skill 与 MCP 对 `deepseek-harness` 的显式分配。
- 插件市场总开关、目录、已安装状态、启停状态、JSON 配置和有界启动错误。
- 插件 `set-marketplace-enabled`、`install`、`set-enabled`、`configure`、`remove` 五类严格 action。

Renderer 只接收公开 npm 元数据和受管插件状态。任何凭据、完整环境、npm 子进程参数、内部 Host 配置或任意插件文件路径都不能由 Renderer 提交；安装 action 只能引用当前目录中的精确包名与版本。

已有设置迁移必须：

- 对没有新字段的用户使用安全默认值。
- 新建或没有已安装插件的旧 Store 将市场迁移为关闭；已有安装记录的旧 Store 保持开启，避免升级后隐藏用户正在管理的插件。
- 保留 OpenCode、Continue 和模型连接选择。
- 修复失效的 DeepSeek Harness 模型引用时给出可报告的迁移警告。
- 不把旧 Runtime 自动迁移为 DeepSeek Harness。

## 16. 打包与供应链

### 16.1 版本策略

- 官方 RC 包全部精确锁定，不使用 `^` 或 `~`。
- 同一 Harness 核心包族必须保持同一 RC 版本。
- 升级前检查 release diff、协议 diff、工具执行语义和依赖闭包。
- 内部握手同时检查锁定的 Harness 基线和 GoodBuddy 控制协议版本。

### 16.2 插件市场安装

- 目录来自 npm 公共搜索 API，只保留包含精确 `dsh-plugin` 关键字的包，最多读取 1,000 项并短期缓存。
- 安装时再次读取精确版本 packument，不信任搜索结果替代版本清单。
- GoodBuddy 精确锁定并随发布包携带 npm `11.19.0`；Electron 以 `ELECTRON_RUN_AS_NODE=1` 启动该 CLI 和受管 `node` shim，不要求用户另装 Node.js 或 npm。
- npm 使用普通依赖解析并运行包及依赖声明的 lifecycle scripts。安装确认必须准确说明这些脚本以当前用户权限运行。
- 安装在 Store 的暂存目录中完成，校验包名、精确版本、`dsh.bundle` 声明、入口文件和 lockfile integrity 后才原子替换当前版本。
- 市场关闭时拒绝新安装且不请求目录，但 `getEnabledExtensions()` 继续按逐项启停状态返回已安装插件。
- 首次安装默认启用。更新保留既有启停状态和 JSON 配置；失败更新保留原安装。
- 每个插件只有一个受管目录和一条状态记录；Store 同时持久化市场总开关。状态写入原子化且 mutation 串行。
- JSON 配置限制为对象根、64 KiB、16 层、每个容器 256 项和 4,096 个节点，避免 IPC、持久化和 Host 启动载荷无界增长。
- Renderer 不接收受管入口路径；Main 只接受目录中的插件 ID 与精确包版本，不能由 IPC 指定 tarball URL、文件路径或命令。

### 16.3 原生依赖

受控组合可能需要：

- `node-pty`，用于受管理的工具子进程。
- `koffi`，用于本地 Filesystem 在 Windows 上保持文件 ACL 和原子替换。
- `@napi-rs/canvas` 及当前平台二进制，用于在 Utility 内完整解码并复核 JPEG/PNG；原生模块必须从 ASAR 解包并通过目标架构校验。

构建 GoodBuddy 自身时不得广泛批准依赖安装脚本；只允许生产组合实际需要、来源已审查、版本已锁定的脚本。这与用户确认后由市场插件执行自身 lifecycle scripts 是两个不同阶段。六个平台的构建必须验证：

- 对应架构的原生文件存在。
- Electron Utility Process 可加载原生模块。
- spawn helper 的权限正确。
- 包中没有混入其他平台不需要的可执行内容，除非上游包无法拆分且已记录。

### 16.4 生产闭包

发布包包含受控 Host、锁定的 npm 安装 Runtime 和许可证。应尽量避免把 Harness Web profile、HMR 和其他未加载产品面带入生产闭包。若 npm 依赖结构无法拆分，必须：

- 确认这些模块不会被加载。
- 评估它们带来的 audit 和体积风险。
- 在后续上游版本允许时改为最小包族。
- 确认 `tests/fixtures` 以及 Web3D 测试 Skill/MCP 不进入正式发布资源。

### 16.5 漏洞门禁

当前安装后的 `npm audit` 报告不能直接用 `npm audit fix --force` 处理。每项漏洞需要区分：

- GoodBuddy 既有依赖。
- Harness 新增生产依赖。
- 仅开发或打包依赖。
- 未加载但被带入的 Web 依赖。

进入 Harness 执行路径且有可利用条件的高危问题必须在发布前修复、替换或移出生产闭包。

### 16.6 发布验证

`build/build-release.cjs` 需要验证：

- Harness Host 和受控配置存在。
- GoodBuddy Host、内部控制协议与 Harness 依赖版本清单存在。
- 平台原生 PTY/Koffi 依赖架构正确。
- Harness、ACP SDK 和其他新增第三方许可证已打包。
- `app.asar` 外需要执行或动态加载的资源位于预期目录。
- 独立的 npm Runtime 及其捆绑依赖闭包存在，并可通过当前 Electron Node Runtime 启动和执行生命周期脚本。
- Web3D Skill/MCP 等测试 fixture 不在 `app.asar` 或 `extraResources` 中。

## 17. 测试策略

### 17.1 单元测试

- Runtime 选择、设置迁移和失效引用修复。
- 二进制检测、版本解析和路径规范化。
- ACP 握手、事件转换和请求关联。
- 每个会话单请求、跨会话并行。
- Ask 在工具分发边界只允许真实注册的 `read`、`skill` 与 Main Web 代理，并拒绝同名冒充和任意新插件工具；Execute 放行插件工具。
- 握手只接受明确的 `execution.mode = 'host'`。
- 未分配 Skill/MCP 不可见；分配后的 Skill catalog 可调用 `skill` 加载。
- 原生能力快照只包含 Host/插件原生 Skills，不包含 GoodBuddy 分配的 Skills 或 MCP。
- Ask 不注册 MCP 工具；Web 代理可用于 Ask 与 Execute；Execute 每轮刷新有界 MCP schema，并在调用前再次校验活动请求、模式、参数和 RuntimeAuthorizer 结果。
- MCP URL、启动命令和凭据不进入 Utility 启动配置或协议结果。
- 未知授权结果失败关闭。
- 超时、取消、迟到帧和进程意外退出。
- 协议帧、事件队列、工具摘要和 stderr 上限。
- 文本模型在 Host 启动前拒绝图片；图片模型的能力声明、ACP 图片块、Pi-AI 模态和 Attachment Store 保持一致。
- 图片 base64、格式签名、PNG CRC、完整解码、尺寸、单图/单消息/Store 上限、内容摘要、Session 释放和 Host 清空。
- release 和 dispose 的幂等性。
- 状态卡中的状态、路径、版本和当前用户执行权限。
- 插件 action 与目录 schema 接受严格的市场总开关并拒绝权限、回滚、任意路径和非精确版本等未支持字段。
- Store 的原子安装、失败更新保留、串行 mutation、离线管理、配置、移除和启动失败停用。
- npm 分页、精确关键字、捆绑 CLI 调用、lifecycle 参数、包身份、入口和 integrity 校验。
- Renderer 的搜索、权限确认、Switch、JSON 配置、移除确认、离线目录和通知反馈。

### 17.2 本地集成测试

使用无网络的假控制面/模型验证：

- utilityProcess 管道。
- 多 Session。
- Session 释放。
- Runtime 替换。
- 进程树回收。
- 本地 Filesystem 与 Shell Provider 使用规范化工作区作为默认工作目录，且不报告沙箱强制模式。
- 受控配置不会读取工作区 `.env` 和用户 DSH 配置。
- 插件导入或激活失败相互隔离，成功插件继续加载，失败 ID 返回 Main。
- IPC 只接受严格插件 action，可信 Renderer 操作后触发 Runtime 重建。

### 17.3 真实模型测试

真实测试已经获得用户授权，但必须由显式环境门禁启用。Web3D Skill 和 MCP 仅作为 `tests/fixtures` 下的测试资产使用，不属于内置发布能力。至少验证：

1. 文本问答成功，并记录正确 Runtime 和模型用量。
2. Ask 可以读取工作区，但写入被拒绝，且不会弹出权限对话框。
3. 启用 Web Search 后，Ask 可以调用 Main 管理的 `web_search` 与 `web_fetch`，插件同名工具仍被拒绝。
4. Execute 可以在工作区创建测试文件。
5. Execute 工具确实以当前用户权限运行，且状态和握手不宣称 OS 隔离。
6. Ask、delegation 和无活动请求不能绕过工具分发检查。
7. 取消长请求后不再产生文本，并可继续使用其他 Session。
8. 两个 Session 可并行，事件不会串线。
9. 释放会话和关闭应用后没有残留 Harness 或工具进程。
10. 从全新用户设置流程启用一个 3D 游戏 Skill 和实际本地或开放 MCP，工具事件能够证明二者确实被调用。
11. Harness 生成的 3D 游戏项目可以安装、启动和实际游玩，包含 3D 渲染、玩家控制、目标和反馈，浏览器无关键错误。
12. 使用公共 npm 搜索，通过 GoodBuddy 捆绑的 npm 安装经审查的最小第三方插件，Host 成功加载并执行其真实工具。
13. 实际 ACP 路径中 Ask 拒绝该插件工具，Execute 允许该工具，不出现 GoodBuddy 逐工具确认。

测试不得打印、快照或提交 API Key。测试创建的文件只能位于专用临时工作区，并在确认可再现后清理。

### 17.4 项目验证

源码完成后必须运行：

```text
npm test
npm run typecheck
npm run lint
npm run build
```

涉及发布资源后，还要按可用原生平台运行聚焦的 `release:package` 验证。无法在当前主机执行的目标必须由六平台 CI 验证。

## 18. 验收标准

功能只有同时满足以下条件才算完成：

- `deepseek-harness` 可被保存、选择、检测和显示。
- Runtime 详情卡内显示状态、路径、版本和当前用户执行权限。
- Skills 与自定义 MCP 设置可把能力分配给 DeepSeek Harness；请求级 GoodBuddy 内置 MCP 当前不支持分配，并在内置 MCP 卡片中以置灰、未选择状态明确显示。布局、键盘语义、文案和保存回显通过真机检查。
- DSH 市场初始关闭且不加载 npm 目录；显式开启后可以搜索、安装、启停、配置和移除插件，安装前只出现一次准确的当前用户权限确认。关闭市场后已有启用插件继续运行，重新开启后管理状态不变。
- Ask 写入测试在 Runtime 边界失败。
- Ask 可使用已启用的 Main Web Search/Fetch，且插件无法通过同名工具绕过所有权校验。
- Ask 拒绝任意插件工具，Execute 可调用全部已启用插件工具。
- Runtime 原生清单只显示 Host/插件原生 Skills，不显示 GoodBuddy 分配项。
- Execute 工作区内写入成功。
- Runtime OS 沙箱设置、平台 Runner、启动探测和原生沙箱打包产物均不存在。
- 取消、超时、切换 Runtime 和退出应用均能回收进程。
- 多会话不串流、不串权限请求、不串用量。
- 用户 DSH 配置、`.env`、遥测和 Web UI 未被加载。
- 一个插件启动失败时 Host 仍可用，失败插件自动停用并在设置中显示。
- 发布包携带可执行的锁定 npm CLI，安装插件不依赖系统 Node.js/npm。
- API Key 不进入 Renderer、配置文件、日志、错误文本或测试产物。
- 全量测试、类型检查、Lint 和生产构建通过。
- 真实 OpenAI 兼容 Chat Completions 请求成功。
- 真实请求调用已分配 Skill 和 MCP，并生成、启动和实际游玩一个可用的 3D 游戏项目。
- 新增第三方许可证和发布校验完整。

## 19. 已知限制

- DeepSeek Harness 底层库当前是 RC，但 GoodBuddy 不自动跟随升级；每次升级都可能要求同步修改内部控制面。
- Harness 文件和命令工具没有 Runtime OS 隔离，会继承 GoodBuddy 客户端当前用户能够访问的主机资源。
- 首版不恢复 Harness 原生 Session，Runtime 重启后由 GoodBuddy 历史重建。
- 图片输入仅在所选模型连接明确声明支持时可用；首版仍不支持知识库、浏览器控制和 Harness Subagent。Web Search/Fetch 仅使用 Main 代理，MCP 仅支持用户分配、Main 代理和 Execute 自动单次授权路径。
- Harness Subagent、后台 Job、Workflow、Hook 和原生会话监督尚未实现；未来按 Task 聚合到右侧 Runtime 监督栏，不扩张 Composer 工具栏或暴露 Job/Run 层级。
- 推理、工具和用量扩展属于 GoodBuddy 协议，不是标准 ACP 保证。
- 市场来自公共 npm 关键字搜索，不是精选目录；包的质量、兼容性和维护状态由发布者负责。
- 插件安装、初始化、后台生命周期和 Execute 工具使用当前用户权限，不受 Runtime OS 沙箱保护；Ask 只控制模型工具调用。
- 不支持用户 profile、自定义 Host、任意本地插件路径或 profile patch。

## 20. 自维护与升级策略

GoodBuddy 对该 Runtime 采用内部维护策略：

1. 当前通过验证的 Host、控制协议和依赖锁定随 GoodBuddy 一起版本化。
2. 不自动跟随 DSH RC、插件 ABI、profile 格式或市场元数据变化；目录只反映 npm 当前精确版本。
3. 升级前审查实际用户收益、上游 diff、主机工具语义、协议行为、依赖闭包和许可证。
4. 六个平台的单元、假模型、UtilityProcess、主机执行和真实模型门禁全部通过后才能更新基线。
5. 若上游方向不再满足 GoodBuddy 用户需求或安全边界，允许维护兼容补丁、替换单个底层包，或逐步移除 DSH 依赖；`goodbuddy/*` 内部协议保持由 GoodBuddy 控制。
6. GoodBuddy 自身不以进入官方插件目录或服务非 GoodBuddy 客户端为目标；第三方市场兼容仅限当前受测 Cordis 导出和 `dsh.bundle` 声明。

## 21. 备选方案记录

### 21.1 每次调用 `dsh --profile headless`

未采用。它适合一次性任务，但不能满足流式事件、多会话、细粒度取消、权限回传和低延迟复用。

### 21.2 只使用官方 ACP 插件

未采用。取消和一次性权限选择符合需求，但缺少工具、推理、用量和会话释放事件。

### 21.3 只使用官方 SDK JSON-RPC

未采用。事件更完整，但单轮取消和权限回传能力不足。

### 21.4 把全部安全逻辑放进 Harness 子进程

未采用。Harness 子进程属于不可信执行面，不能拥有最终模式授权策略、加密设置和进程回收权限。

### 21.5 把全部控制适配放在 Main

未采用。Main 无法可靠观察 Cordis 内部 Session、Tool、Usage 和权限 seam，只能得到不完整的外部进程行为。

当前选择让双层内部控制面保持 GoodBuddy 私有，同时允许 Main 从受管 Store 向固定 Host 注入标准 Cordis 插件；插件扩展面不会取代 GoodBuddy 的可信 Main 控制权。
