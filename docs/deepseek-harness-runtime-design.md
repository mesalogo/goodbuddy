# GoodBuddy 自维护 DeepSeek Harness Runtime 设计

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档状态 | 实现与发布验收基线 |
| 设计目标 | 将 DeepSeek Harness 作为 GoodBuddy 的第三个 Agent Runtime |
| Runtime 标识 | `deepseek-harness` |
| 首版依赖基线 | 实际使用的 `@deepseek-ai/dsh-*` 底层库，精确锁定 `0.1.0-rc.6` |
| 上游状态 | Developer Preview，允许出现破坏性变更 |
| 上游许可证 | MIT |
| GoodBuddy 目标平台 | Windows、macOS、Linux，x64 与 arm64 |
| 本文性质 | 设计与发布验收约定 |

本文定义 DeepSeek Harness 在 GoodBuddy 中的架构边界、协议、安全策略、界面、打包和验收要求。实现必须继续遵守 GoodBuddy 已有的 Main 进程安全边界、Ask/Execute 语义、授权、取消、超时、有界输出和资源回收约定。

## 2. 摘要

DeepSeek Harness 的底层库使用 Cordis 组合服务。GoodBuddy 不采用官方产品 profile、插件安装或市场机制，也不让用户配置覆盖安全服务，而是增加一个实验性的第三 Runtime，并完全自行维护 Host、控制协议、生命周期和兼容层。上游 DSH 包只是精确锁定并逐次审查的实现依赖，不构成 GoodBuddy 对 DSH 插件 ABI、插件目录或产品路线的承诺。

GoodBuddy 并不迫切于把该能力做成 DSH 插件或进入插件市场。当前优先级是向用户提供稳定、可靠、可审计且可完整回收的 Runtime；只有未来真实用户需求和成熟度证明插件化确有价值时，才重新评估该形态。

整体分成两个互相约束的部分：

1. **GoodBuddy Main Control Plane**
   - 运行在 Electron Main 进程。
   - 持有加密设置、模型连接选择、Ask 拒绝与 Execute 自动授权策略、Runtime 生命周期和审计归属。
   - 通过 Electron `utilityProcess` 启动受控 Harness 子进程。
   - 对环境、输入、输出、超时、取消和进程树执行强制限制。

2. **GoodBuddy Harness Control Plane**
   - 运行在 Harness 子进程内，是 Host 私有的内部控制组件，不导出 Cordis 插件入口。
   - 使用 ACP 兼容的 JSON-RPC stdio 作为基础控制面。
   - 增加 GoodBuddy 所需的能力握手、每轮权限准备、会话释放、工具事件、推理、用量和安全凭据请求扩展。
   - 与 GoodBuddy Host 一起维护、构建和发布，不设计为独立 npm 包、`dsh.bundle` 或市场插件。

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

### 3.2 官方通道的缺口

官方 ACP 插件有意只输出已提交文本，不输出推理、工具进度、计划、标题和用量。它也没有标准的会话关闭方法。SDK JSON-RPC 的展示事件更完整，但缺少 GoodBuddy 需要的单轮取消和权限回传。

因此，首版不单独选用其中一个官方通道作为完整实现。GoodBuddy Harness Control Plane 以 ACP 语义为基础，补充有命名空间的扩展方法和事件。

### 3.3 自维护边界

GoodBuddy 不急于把该 Runtime 包装成标准 DSH 插件，也不以进入官方或第三方插件市场为近期目标。所有入口都随 GoodBuddy 发布，只有 GoodBuddy Main 可以启动并使用内部 Host。是否采用上游新版本或未来重新评估插件形态，只由真实用户价值、安全审查和六平台稳定性决定，不跟随市场机制或上游发布节奏。

## 4. 目标与非目标

### 4.1 首版目标

- 增加 `deepseek-harness` Runtime，并在设置、聊天和消息通道中可选择。
- 使用 GoodBuddy 管理的模型连接，不在 Renderer 或持久化 Harness 配置中写入 API Key。
- Ask 模式在 Runtime 边界强制只读，并禁止任何权限升级。
- Execute 模式下的工具权限请求由 Main 自动给予单次授权，不弹出交互审批；默认文件模式仍为 `workspace-write`，越界仅允许在真实沙箱拒绝后对完全相同操作单次重试。
- 支持多会话、同会话串行、跨会话并行。
- 支持按请求取消、超时、会话释放和应用退出时完整回收。
- 输出文本、推理、工具参数、工具结果、stderr 和协议队列全部有界。
- 使用真实 DeepSeek 模型验证调用，而不在日志、测试产物或提交中暴露凭据。
- 保留 Windows、macOS、Linux 的 x64 和 arm64 发布能力。

### 4.2 首版非目标

- 不替换 OpenCode、Continue 或直连模型 Runtime。
- 不开放用户 Cordis profile、cordis.patch.yml 或 $DSH_HOME 全局补丁覆盖。
- 不提供外部 Host、自定义 Harness Control Plane、DSH 插件安装或市场入口。
- 不加载 Harness Web UI、HMR、遥测、自动更新或目录选择器。
- 不支持 `danger-full-access` 作为会话默认值或持久设置。
- 不向 Utility 暴露 MCP 凭据或建立直连 MCP Client。只有用户明确分配给 Harness 的 MCP 工具可以通过 Main 代理调用。
- 不在首版向 Harness 暴露 GoodBuddy 浏览器控制、知识库或 Magic Notes。
- 不在首版支持图像输入、会话恢复、Harness Subagent、后台 Job、Hook、Web Search 或 Workflow。
- 不发布独立 npm 包，也不创建上游 PR。

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
- HMR 和动态插件安装。

模型名称、服务地址、工作区和非秘密策略通过严格校验的 Main 配置传给 Host。API Key 只通过受控凭据通道按需提供，不写入 YAML、命令行、Renderer 或日志。

### 5.3 双层内部控制面

Harness 子进程内控制面不能取代 Main 控制面，Main 控制面也不能代替进程内的 Session/Tool 适配层：

- Harness Control Plane 最接近 Session、Agent、Tool、Usage 和权限 seam，适合做内部协议转换。
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
  ├─ AgentRuntimeController
  ├─ RuntimeAuthorizer（Ask 拒绝 / Execute 自动单次授权）
  └─ DeepSeekHarnessRuntime / Main Control Plane
       │ ACP + goodbuddy/* 扩展，stdin/stdout
       ▼
Electron utilityProcess
  └─ GoodBuddy Harness Host
       ├─ 固定 Cordis 组合
       ├─ GoodBuddy Harness Control Plane（内部组件）
       ├─ DSH Agent 与 LLM seam
       ├─ DSH Sandbox Policy
       ├─ 沙箱 Shell / Filesystem
       └─ 最小工具集
             │ HTTPS
             ▼
        用户选择的 DeepSeek 兼容模型连接
```

### 6.1 信任边界

| 区域 | 信任级别 | 允许持有的内容 |
| --- | --- | --- |
| Renderer | 不可信展示层 | 脱敏设置、状态、用户可见事件 |
| Preload | 窄桥 | 明确方法和共享 schema |
| Electron Main | 可信控制面 | 加密设置、模式授权策略、Runtime 生命周期 |
| Harness utilityProcess | 不可信执行面 | 当前请求、临时凭据、受控工具和工作区权限 |
| Harness 工具子进程 | 最低信任 | 单次命令所需的最小环境和沙箱能力 |

Harness 子进程崩溃、输出异常、拒绝协议、加载错误或沙箱不可用时，Main 必须失败关闭。

## 7. GoodBuddy Harness Control Plane

### 7.1 内部组件职责

控制面负责：

- 启动 ACP 兼容的 JSON-RPC stdio 服务。
- 创建、查找和释放 Harness Agent。
- 在 Prompt 前应用 GoodBuddy 指定的 Ask/Execute 权限。
- 将 DSH Session 事件转换为有界的 GoodBuddy 事件。
- 将权限请求转发到 Main，并只接受一次性结果。
- 将 LLM 用量转换为稳定的模型用量事件。
- 在 dispose 时先取消 Agent，再等待子 Agent 和工具清理。
- 保证 stdout 只包含协议帧，诊断只写 stderr。

控制面不负责：

- 保存 GoodBuddy 设置。
- 持久保存 API Key。
- 决定 Main 的模式授权结果。
- 直接访问 Renderer 或 Electron API。
- 接受用户提供的插件、Host 或 profile 覆盖。
- 自行上传遥测。

### 7.2 非插件约束

控制面不导出 `apply(ctx, config)`，不提供默认 stdin/stdout 入口，不包含 `dsh.bundle`、`cordis.patch.yml` 或可安装 manifest，也不接受 Host 之外创建的 transport。它可以保留清晰的内部模块边界以便测试和维护，但该边界不是公开扩展点。

若未来确有来自 GoodBuddy 真实用户、经过研究验证的扩展需求，应先重新完成产品需求、威胁模型和兼容策略评审；不得因为上游已经提供插件或市场机制而默认开放。

## 8. 协议设计

### 8.1 传输

- stdin/stdout 使用换行分隔 JSON-RPC。
- stdout 不得出现日志、Banner、进度条或调试输出。
- stderr 只允许有界诊断，不得包含 Prompt、工具完整输出或凭据。
- 每一帧、每一字段和每个请求累计输出都必须在解析前或接收时限流。

### 8.2 标准 ACP 方法

首版保留 ACP 的初始化、`session/new`、`session/prompt` 和 `session/cancel` 语义。标准 ACP 客户端可以使用只读默认行为，但只有完成 GoodBuddy 能力握手的客户端才能启用 Execute。

### 8.3 GoodBuddy 扩展

扩展统一使用 `goodbuddy/` 命名空间：

| 方法或事件 | 方向 | 用途 |
| --- | --- | --- |
| `goodbuddy/handshake` | Main → Control Plane | 交换控制协议、Harness、ACP 版本和能力 |
| `goodbuddy/session/prepare` | Main → Control Plane | 在下一次 Prompt 前设置工作模式和请求标识 |
| `goodbuddy/session/release` | Main → Control Plane | 取消并释放指定 Session |
| `goodbuddy/session/event` | Control Plane → Main | 文本、推理、工具、状态和用量事件 |
| `goodbuddy/credential/resolve` | Control Plane → Main | 按已登记引用请求当前 Runtime 的临时凭据 |
| `goodbuddy/tools/list` | Control Plane → Main | 取得用户分配给 Harness 的有界 MCP 工具 schema |
| `goodbuddy/tools/call` | Control Plane → Main | 通过当前 Execute 请求、schema 校验和自动单次授权调用 MCP |
| `goodbuddy/shutdown` | Main → Control Plane | 停止接收新请求并有序清理 |

扩展版本独立于 ACP 版本。握手响应至少包含：

```ts
type GoodBuddyHarnessCapabilities = {
  controlProtocolVersion: 1
  harnessVersion: string
  acpProtocolVersion: number
  supports: {
    cancellation: true
    sessionRelease: true
    oneShotApproval: true
    reasoningEvents: boolean
    toolEvents: boolean
    usageEvents: boolean
  }
  sandbox: {
    provider: string
    enforcement: 'full' | 'partial'
  }
}
```

版本不兼容、必需能力缺失或 `sandbox.enforcement` 不满足设置要求时，Main 不得开始模型请求。

### 8.4 每轮权限准备

GoodBuddy 的工作模式属于每个请求，不属于 Runtime 进程全局状态。同一对话可以在 Ask 和 Execute 之间切换。因此：

1. `session/new` 后默认是 `read-only + never`。
2. 每个 Prompt 前，Main 发送一次 `goodbuddy/session/prepare`。
3. Harness Control Plane 将准备状态绑定到 `sessionId + requestId`。
4. `session/prompt` 只能消费匹配且尚未使用的准备状态。
5. 缺少准备状态、重复使用、请求标识不匹配时，Control Plane 使用只读且禁止授权的安全默认值，或直接拒绝请求。
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

### 9.3 取消与超时

- 用户取消时立即发送 `session/cancel`。
- 取消等待有界，超时后关闭连接并终止整个 Harness 进程。
- 初始化、握手、Session 创建、Prompt、权限回传和关闭分别使用独立超时。
- Prompt 超时与用户取消使用不同错误类型，不能被宽泛 catch 抹平。
- 取消后仍可接收并丢弃该请求的最终协议结算帧，但不得写入下一请求。

### 9.4 释放与退出

- 删除或释放对话时调用 `goodbuddy/session/release`。
- Runtime dispose 时先拒绝新请求，再取消所有 Session。
- Harness Control Plane 完成 Agent、工具和会话清理，Host 完成 Cordis Fiber 与子进程的反向清理。
- Main 在宽限期内等待正常退出。
- 超时后终止 utilityProcess，并在平台允许时清理完整进程树。
- 应用退出不得因 Harness 清理无限阻塞。

## 10. 权限与沙箱

### 10.1 模式映射

| GoodBuddy 模式 | DSH 文件模式 | DSH 权限策略 | 行为 |
| --- | --- | --- | --- |
| Ask | `read-only` | `never` | 允许受控读取，不允许写入，不允许升级 |
| Execute | `workspace-write` | `ask` | 允许工作区与受控临时目录写入；权限请求由 Main 自动单次授权，不弹出交互审批 |

`danger-full-access` 只能作为某个已被沙箱拒绝的完全相同操作的一次性、更宽重试。Main 仅对该次重试自动返回 `allow-once`；它不能保存为默认值、复用于后续操作，或通过“始终允许”返回。

### 10.2 Ask 模式

- Main 即使收到权限请求也固定拒绝。
- Harness Control Plane 禁止 `sandbox_permissions` 升级。
- 文件写入和 Shell 写入都由 DSH 共享 Sandbox Policy 强制拒绝。
- 只读不等于无限输出，读取仍受路径、字节和工具结果上限控制。
- 首版不向 Ask 暴露 GoodBuddy 的可变数据工具。

### 10.3 Execute 模式

- 工作区根来自 Session 创建时的规范化绝对路径。
- 工具不能自行更换工作区根。
- 工作区内操作按 DSH `workspace-write` 执行。
- 只有真实沙箱拒绝后的同一操作，才可请求一次升级。
- Main 不调用 `ToolApprovalBroker`，而是对当前 Execute 请求自动返回 `allow-once`；界面不进入等待审批状态，也不弹出审批对话框。
- 所有工具调用仍作为活动事件记录；Ask 和 delegation 路径继续固定拒绝。
- Harness Control Plane 不接受 `allow_always`，也不把未知结果解释为允许。

### 10.4 沙箱可用性

- `strict`：要求完整强制执行。仅有 `partial` 或无 Runner 时 Runtime 不可用。
- `auto`：允许官方报告的 `full` 或 `partial`，但必须在状态卡显示实际强制程度。
- `off`：不允许 Harness 退化到无限制工具执行。首版将 Execute 标记为不可用，Ask 仍只能在可强制只读时运行。

Windows ACL 和旧 Linux Landlock 可能只报告 `partial`。界面和诊断必须如实显示，不能写成“完全隔离”。

### 10.5 环境与凭据

- 使用环境变量白名单构造 utilityProcess 环境。
- 不继承 `NODE_OPTIONS`、调试端口、任意 npm 配置、用户 `DSH_*` 覆盖或白名单之外的凭据。
- `DSH_TELEMETRY_DISABLED=1` 必须固定设置。
- Harness Home 指向 GoodBuddy 管理的隔离目录。
- 不调用官方 `loadEnv` 或 `loadLayeredEnv`。
- API Key 由 Main 从加密设置中解析。
- Harness Control Plane 只能用已握手登记的引用通过 `goodbuddy/credential/resolve` 请求当前 Runtime 的凭据。
- 凭据只在模型请求所需的子进程内存中短暂存在，不写磁盘、不进入工具环境、不打印。

## 11. 受控 Harness 组合

首版只加载完成文本对话、受控代码操作和用户明确分配能力所需的固定服务：

- Agent、Session、LLM 和 Tool Registry 基础服务。
- GoodBuddy Harness Control Plane。
- DeepSeek 兼容 LLM 适配器。
- Sandbox Policy 与平台 Sandbox Provider。
- 平台对应的受沙箱 Shell。
- 受沙箱 Filesystem。
- 一次性权限请求服务。
- Token Meter 和必要的上下文压缩。
- 有界的读取、写入、编辑和 Shell 工具。
- Agent scope 的 Skill Registry 与 `skill` 工具。Skill 目录由 Main 选择并在 Launcher 和 Host 两次规范化、校验。
- Main 代理的 MCP schema 工具。Utility 不持有 MCP URL 凭据或 Transport。

首版明确不加载：

- Web UI、HMR、Host API 和目录选择器。
- Harness 遥测。
- Settings File 和 Local Credentials。
- 用户 profile 与全局补丁。
- Web Search、Fetch、Utility 直连 MCP、Hooks。
- Subagent、Workflow、Ralph、后台 Job。
- JSONL Session Persistence 和 SQLite Session Query。
- 自动技能发现和市场技能加载。

如果某个首版工具依赖被排除服务，启动审计必须失败，而不是自动加载更大的默认 bundle。

## 12. 模型配置

### 12.1 配置来源

DeepSeek Harness 首版只使用 GoodBuddy 模型连接：

- 协议必须是 `openai-chat-completions`。
- 认证必须是 API Key。
- 服务地址必须是 `https://api.deepseek.com`，且不得包含用户信息。
- 模型名称和服务地址由 Main 传入受控 Host。
- API Key 继续保存在 GoodBuddy 加密设置中。
- 启动环境提供的部署连接只由 Main 自动解析，不在 Renderer 中显示为可选来源。

不允许选择 Harness 自有的用户配置文件或自定义 Host。Runtime 始终使用随当前 GoodBuddy 版本发布的内置 Host，并通过完整内部能力握手。

### 12.2 设置变化

模型、凭据、沙箱、Skill 或 MCP 分配变化时，GoodBuddy 创建新 Runtime 实例。Harness Host 路径始终由当前 GoodBuddy 构建提供，不能由设置或环境变量替换。旧实例按现有 Runtime Controller 语义退役，不在一个活动进程内热替换安全配置。

### 12.3 输入限制

- 首版只支持文本。
- 图片输入应在发起网络调用前返回明确错误。
- GoodBuddy 历史、Prompt、系统指令分别保持不同信任层。
- 任何用户文本都不能进入 Cordis 配置表达式或模块名。

## 13. 输出和资源边界

建议首版默认限制：

| 项目 | 默认上限 |
| --- | --- |
| 单个 JSON-RPC 帧 | 1 MiB |
| 单个文本或推理事件 | 64 KiB |
| 单次请求累计协议输出 | 4 MiB |
| 工具输入摘要 | 4,000 字符 |
| 工具输出摘要 | 4,000 字符 |
| 待处理事件数 | 1,000 |
| stderr 累计 | 64 KiB |
| 初始化 | 10 秒 |
| 单次 Prompt | 10 分钟 |
| 有序关闭宽限期 | 2 秒 |

超过限制时应取消当前请求。协议帧、队列或 stderr 持续异常时，应终止 Runtime 进程，避免继续信任已失控的通道。

## 14. Runtime 检测与状态

### 14.1 检测

检测只验证：

- 内置 Host 路径是规范化文件。
- 版本可读取且在支持范围内。
- 内部控制面能力握手成功。
- 必需 Sandbox Provider 可用并报告强制程度。

检测不得调用付费模型，也不得读取或输出 API Key。真实模型测试是单独的显式操作。

### 14.2 设置界面

Agent Runtime 使用共享 `SegmentedControl` 展示 OpenCode、Continue 和 DeepSeek Harness。DeepSeek Harness 必须标记为“开发者预览”，并说明上游 RC 可能发生破坏性变更。

Runtime 的概览、模型配置和检测信息放在同一张详情卡中。当前单独显示的一行“已就绪”应移入卡片，与路径、版本号归为同一组：

```text
Runtime：       GoodBuddy 内置 DeepSeek Harness
模型配置：      跟随 GoodBuddy · dsv4flash（deepseek-v4-flash）
状态：          已就绪
路径：          <受控 Host 路径>
版本：          0.1.0-rc.6
安全强制：      完整 / 部分

Host 始终由当前 GoodBuddy 版本提供，不存在自定义 Host 入口。
```

界面要求：

- 不再在卡片外重复一行检测结果。
- 使用语义化键值结构，路径允许换行，不截断关键信息。
- 状态不能只依靠绿色表达，必须同时有文字。
- 检测中、不可用和部分强制分别显示明确文案。
- 高级设置默认收起。

聊天顶栏只显示简短 Runtime 状态，不显示文件路径和版本。完整诊断只在设置页展示。

## 15. IPC 与共享契约

共享 schema 需要覆盖：

- `deepseek-harness` provider 和 Runtime ID。
- Runtime 选择中的 `deepseekHarness` 分支。
- 检测结果中的路径、版本、详情和沙箱强制程度。
- GoodBuddy 模型连接选择。
- DeepSeek Harness 模型用量归属。
- Skill 与 MCP 对 `deepseek-harness` 的显式分配。

Renderer 只接收脱敏状态。任何凭据、完整环境、启动参数或内部 Cordis 配置都不能进入共享契约。

已有设置迁移必须：

- 对没有新字段的用户使用安全默认值。
- 保留 OpenCode、Continue 和模型连接选择。
- 修复失效的 DeepSeek Harness 模型引用时给出可报告的迁移警告。
- 不把旧 Runtime 自动迁移为 DeepSeek Harness。

## 16. 打包与供应链

### 16.1 版本策略

- 官方 RC 包全部精确锁定，不使用 `^` 或 `~`。
- 同一 Harness 核心包族必须保持同一 RC 版本。
- 升级前检查 release diff、协议 diff、沙箱 diff和依赖闭包。
- 内部握手同时检查锁定的 Harness 基线和 GoodBuddy 控制协议版本。

### 16.2 原生依赖

受控组合可能需要：

- `node-pty`，用于受管理的工具子进程。
- `koffi`，用于 Windows ACL 或相关本地能力。
- `@deepseek-ai/node-addon-landlock-run` 的平台包。

不得广泛批准所有安装脚本。只允许生产组合实际需要、来源已审查、版本已锁定的脚本。六个平台的构建必须验证：

- 对应架构的原生文件存在。
- Electron Utility Process 可加载原生模块。
- Runner 或 spawn helper 的权限正确。
- 包中没有混入其他平台不需要的可执行内容，除非上游包无法拆分且已记录。

### 16.3 生产闭包

发布包只包含受控 Host 需要的插件和许可证。应尽量避免把 Harness Web profile、HMR 和其他未加载产品面带入生产闭包。若 npm 依赖结构无法拆分，必须：

- 确认这些模块不会被加载。
- 评估它们带来的 audit 和体积风险。
- 在后续上游版本允许时改为最小包族。

### 16.4 漏洞门禁

当前安装后的 `npm audit` 报告不能直接用 `npm audit fix --force` 处理。每项漏洞需要区分：

- GoodBuddy 既有依赖。
- Harness 新增生产依赖。
- 仅开发或打包依赖。
- 未加载但被带入的 Web 依赖。

进入 Harness 执行路径且有可利用条件的高危问题必须在发布前修复、替换或移出生产闭包。

### 16.5 发布验证

`build/build-release.cjs` 需要验证：

- Harness Host 和受控配置存在。
- GoodBuddy Host、内部控制协议与 Harness 依赖版本清单存在。
- 平台原生 Sandbox/PTY 依赖架构正确。
- Harness、ACP SDK 和其他新增第三方许可证已打包。
- `app.asar` 外需要执行或动态加载的资源位于预期目录。

## 17. 测试策略

### 17.1 单元测试

- Runtime 选择、设置迁移和失效引用修复。
- 二进制检测、版本解析和路径规范化。
- ACP 握手、事件转换和请求关联。
- 每个会话单请求、跨会话并行。
- Ask 固定拒绝升级。
- Execute 权限请求由 Main 自动返回单次授权，Ask 与 delegation 固定拒绝。
- 未分配 Skill/MCP 不可见；分配后的 Skill catalog 可调用 `skill` 加载。
- Ask 不注册 MCP 工具；Execute 每轮刷新有界 schema，并在调用前再次校验活动请求、模式、参数和自动单次授权。
- MCP URL、启动命令和凭据不进入 Utility 启动配置或协议结果。
- 未知授权结果失败关闭。
- 超时、取消、迟到帧和进程意外退出。
- 协议帧、事件队列、工具摘要和 stderr 上限。
- release 和 dispose 的幂等性。
- 状态卡中的状态、路径、版本和强制程度。

### 17.2 本地集成测试

使用无网络的假控制面/模型验证：

- utilityProcess 管道。
- 多 Session。
- Session 释放。
- Runtime 替换。
- 进程树回收。
- 受控配置不会读取工作区 `.env` 和用户 DSH 配置。

### 17.3 真实模型测试

真实测试已经获得用户授权，但必须由显式环境门禁启用。至少验证：

1. 文本问答成功，并记录正确 Runtime 和模型用量。
2. Ask 可以读取工作区，但写入被拒绝，且不会弹出权限对话框。
3. Execute 可以在工作区创建测试文件。
4. Execute 越界操作先被拒绝，再对完全相同的重试自动给予单次授权，全程不弹出审批。
5. 不匹配的重试、Ask 和 delegation 不能换路径或重复绕过。
6. 取消长请求后不再产生文本，并可继续使用其他 Session。
7. 两个 Session 可并行，事件不会串线。
8. 释放会话和关闭应用后没有残留 Harness 或工具进程。
9. 从全新用户设置流程启用一个 3D 游戏 Skill 和实际本地或开放 MCP，工具事件能够证明二者确实被调用。
10. Harness 生成的 3D 游戏项目可以安装、启动和实际游玩，包含 3D 渲染、玩家控制、目标和反馈，浏览器无关键错误。

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
- Runtime 详情卡内显示状态、路径、版本和沙箱强制程度。
- Skills 与 MCP 设置页可把能力分配给 DeepSeek Harness，布局、键盘语义、文案和保存回显通过真机检查。
- Ask 写入测试在 Runtime 边界失败。
- Execute 工作区内写入成功。
- 越界写入只有同一操作获得自动单次授权后才能执行一次，且不弹出审批。
- 取消、超时、切换 Runtime 和退出应用均能回收进程。
- 多会话不串流、不串权限请求、不串用量。
- 用户 DSH 配置、`.env`、遥测和 Web UI 未被加载。
- API Key 不进入 Renderer、配置文件、日志、错误文本或测试产物。
- 全量测试、类型检查、Lint 和生产构建通过。
- 真实 DeepSeek 请求成功。
- 真实请求调用已分配 Skill 和 MCP，并生成、启动和实际游玩一个可用的 3D 游戏项目。
- 新增第三方许可证和发布校验完整。

## 19. 已知限制

- DeepSeek Harness 底层库当前是 RC，但 GoodBuddy 不自动跟随升级；每次升级都可能要求同步修改内部控制面。
- Windows ACL 和部分 Linux Landlock 环境只能提供部分强制执行。
- 首版不恢复 Harness 原生 Session，Runtime 重启后由 GoodBuddy 历史重建。
- 首版不支持图片、知识库、浏览器工具和 Harness Subagent；MCP 仅支持用户分配、Main 代理和 Execute 自动单次授权路径。
- 推理、工具和用量扩展属于 GoodBuddy 协议，不是标准 ACP 保证。
- 不支持 DSH 插件、市场包、用户 profile 或自定义 Host。

## 20. 自维护与升级策略

GoodBuddy 对该 Runtime 采用内部维护策略：

1. 当前通过验证的 Host、控制协议和依赖锁定随 GoodBuddy 一起版本化。
2. 不自动跟随 DSH RC、插件 ABI、profile 格式或市场元数据变化。
3. 升级前审查实际用户收益、上游 diff、沙箱与工具语义、协议行为、依赖闭包和许可证。
4. 六个平台的单元、假模型、UtilityProcess、沙箱和真实模型门禁全部通过后才能更新基线。
5. 若上游方向不再满足 GoodBuddy 用户需求或安全边界，允许维护兼容补丁、替换单个底层包，或逐步移除 DSH 依赖；`goodbuddy/*` 内部协议保持由 GoodBuddy 控制。
6. 不以进入官方插件目录、适配市场机制或服务非 GoodBuddy 客户端作为目标。

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

当前选择的双层内部控制面放弃标准 DSH 插件形态，只复用锁定的底层库，并维持 GoodBuddy 的可信 Main 控制权。