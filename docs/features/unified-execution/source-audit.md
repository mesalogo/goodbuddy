# 统一执行：Ask/Execute 源码审计

研究日期：2026-10-04。研究对象：当前含未提交修改的工作树。

## 研究范围与证据

本文记录产品工作模式的源码落点、移除时必须联动的接口，以及尚未解决的支持缺口。
审计覆盖 Main、Renderer、共享合同、受管 Runtime、原生客户端、Agent daemon、启动器与模型桥。
依据为调研时的源码阅读、符号搜索、依赖版本及已有测试文件；调研阶段未实施模式移除，未运行产品测试、真实模型请求或远程 Host 验证。后续实施已启动，下文源码行为是调研基线，不能当作最终实现或验证结论。
工作树中的既有修改属于本次研究基线，不能将本文描述直接归属于某个发布版本或干净提交。
文件链接用于定位实现；函数名和行为比易变的行号更适合作为后续核对依据。

目标是移除 GoodBuddy 自有 Ask/Execute 及其隐含工具限制，由已启用、已分配的能力设置决定工具接入。
不得用固定 Execute、改名后的工作模式或另一份硬编码工具白名单代替移除。
用户已追加授权删除“安全”设置分类和 `toolApproval` 策略，包括一般工具审批等待；清除本地数据移到通用设置并保留确认。上传许可、覆盖选项和原生结构化提问仍按业务合同处理，现有不支持的 Runtime 能力不因此补齐。
本报告不提出新权限框架，不承诺新增原生逐工具开关。

文档分工：[prd.md](./prd.md) 定义范围，[technical-design.md](./technical-design.md) 定义方案，[progress.md](./progress.md) 记录实施证据。
UI 细节归 [ui-design.md](./ui-design.md)，主数据迁移归 [data-migration.md](./data-migration.md)；本文仅给出源码交接点。
下文保留移除前的源码调研基线；当前主要改造、schema 60、设置 22、runtime/acp 6 和 Harness 协议 2 的实现及验证证据见进度，不能把旧符号或版本当作现行合同。

## 设置覆盖与未决问题

| 入口 | 已有源码行为 | 审计判断 |
| --- | --- | --- |
| [CapabilityService](../../../src/main/capabilities/capability-service.ts) | `getResolvedMcpServers` 按 enabled、assignments 取自定义 MCP；`getEnabledBuiltinMcpServerIds` 处理内置服务 | 服务启用及 Runtime 分配是现有接入依据 |
| [capability-contracts](../../../src/shared/capability-contracts.ts) | 内置服务、Skills、自定义 MCP 有开关或分配合同 | 不等价于每个原生工具都有设置 |
| [McpSettingsSection](../../../src/renderer/src/McpSettingsSection.tsx) | Web 有开关；filesystem/programming 分组主要展示工具说明 | 展示清单不能算原生逐工具控制 |
| [CapabilitiesAndToolsSettingsSection](../../../src/renderer/src/CapabilitiesAndToolsSettingsSection.tsx) | tools 页签进入工具环境配置 | 环境选择不构成工具授权开关 |
| [builtin-mcp-servers](../../../src/shared/builtin-mcp-servers.ts) | knowledge、notes、config、browser、Obsidian、Story Graph 声明支持的 Runtime | 必须保留真实支持范围，不能统一标成可用 |

原生工具没有统一逐项设置映射，这是当前设置粒度。此次沿用 Runtime 正常能力，不新增逐工具开关，也不以其作为移除模式的前置条件。
实现评审需要区分已有服务开关、Runtime 自带工具和动态扩展工具，不能声称 MCP 设置已经覆盖后两类。
工具目录是否展示、调用是否执行是两个检查点；只改变模型可见目录会遗漏直接调用及旧会话路径。
能力 token、请求归属和当前设置检查各有职责，源码中存在这些机制不证明跨路径设置行为已经验证。

## 本机受管 Runtime 与原生工具

### 公共包装层

[runtime.ts](../../../src/main/agent/runtime.ts) 的 `AgentExecutionRequest` 携带 `workMode`；`RuntimeAuthorizer` 是另一个合同。
[runtime-controller.ts](../../../src/main/agent/runtime-controller.ts) 的 `run` 用 Execute 计算 `toolsAllowed`，Ask 注入固定拒绝的 authorizer。
同一函数还有 `requiresToolApproval` 的整轮审批和 `supportsToolExecution` 检查；应分别辨认模式依赖与真实能力限制。
[create-runtime.ts](../../../src/main/agent/create-runtime.ts) 构造各 Runtime、工具提供者及无工具模型实例，是能力来源的核对入口。

### OpenCode

[opencode-runtime.ts](../../../src/main/agent/opencode-runtime.ts) 同时处理受管本机实例和配置的外部 Server。
`readOnlyPermissionRules` 默认拒绝；`executePermissionRules` 默认允许，随后叠加 Skills 与请求级 MCP 规则。
Ask 路径调用 `client.tool.ids`，将原生工具逐项设为 false，仅恢复指定代理和 Skills；因此限制覆盖全部返回的原生工具。
这包含文件读写、搜索、Shell、Web、问题交互、任务委派及上游或插件新增工具，不能只核对 MCP。
图片绑定、自定义 MCP 注册、`permission.asked` 回复和原生工具 inventory 还各有模式分支。
移除目标包括模式选择的权限集合、工具 overrides 和可用性标签；临时 MCP 名称隔离、会话归属及清理仍有独立用途。
外部 Server 的配置、工具目录和权限 API 也需核对；本机受管路径的源码行为不能证明任意外部版本兼容。

### Continue

[continue-runtime.ts](../../../src/main/agent/continue-runtime.ts) 的 `run` 计算 `execute`，据此绑定图片、自定义 MCP，并选择 adapter 的 agent/chat。
其 authorizer 允许 Execute，或 Ask 中特定 scoped read 工具；这与工具目录过滤是两层限制。
[continue-host-adapter.ts](../../../src/main/agent/continue-host-adapter.ts) 的 `createRunConfig` 拒绝 Ask 自定义 MCP，并在部分 Ask 场景丢弃原生配置中的 MCP。
`run` 使用 `--allow <scoped tool> --exclude '*'`、`--auto` 或 `--readonly`，会影响 CLI 原生工具整体。
核对范围包括原生 Read/List/Search/Fetch/Diff、文件修改、Bash、后台任务、Skills、AskQuestion 和动态工具。
源码内的固定只读名称并非上游完整目录；验收需检查所用版本实际注册的工具，不能将该名称集合变成新白名单。
adapter 还修补上游 bundle 的权限参数初始化、优先级和 `/permission` 处理；其中协议及 Windows 修复不能随模式分支整段删除。

### DeepSeek Harness

[deepseek-harness-host.ts](../../../src/main/deepseek-harness-host.ts) 注册 LocalSubprocess、LocalFileSystem、ToolFs、LocalBash/LocalPwsh、ToolBash/ToolPwsh 与扩展。
所用 DSH 包包含 `read`、`write`、`edit`、`read_image`、`bash`、`pwsh`；Host 还接入原生 `skill` 及启用插件注册的工具。
`trustedAskToolDefinitions` 只收集受信任 read 定义，不能据此推断其他原生工具不存在。
[goodbuddy-harness-control-plane.ts](../../../src/main/agent/goodbuddy-harness-control-plane.ts) 的 `observeSessions` 在 `tools/execute` 比对 Ask 工具定义身份。
`askToolDefinitions`、`inflight.mode`、`preparation.mode`、模式提示词和 `GOODBUDDY_PREPARE` 参数均是移除目标。
控制面还主动返回 `currentModeId: 'ask'` 及 Ask availableModes，这是 GoodBuddy 自有字段使用。
[deepseek-harness-runtime.ts](../../../src/main/agent/deepseek-harness-runtime.ts) 的 `boundedProxyToolCatalog`、`handlePermission`、`GOODBUDDY_TOOLS_LIST/CALL` 有额外模式限制。
Main 代理中的 Web/Story Graph、自定义 MCP 和图片需分别核对，保留活动请求及参数校验。
插件初始化和安装脚本不经过模型 `tools/execute`；模式移除不能被描述成新增或取消 OS 沙箱。

## 直连模型工具提供者

[builtin-model-tools.ts](../../../src/shared/builtin-model-tools.ts) 定义以下目录；它包含原生实现和由 Main 代理的能力。

| 类别 | 工具 |
| --- | --- |
| 文件与搜索 | `workspace_rg`、`workspace_read_text`、`workspace_apply_patch` |
| 进程与子任务 | `process_execute`、`output_read`、`subagent_delegate` |
| Web | `web_search`、`web_fetch` |
| 浏览器 | `browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_select`、`browser_back`、`browser_screenshot` |
| 图片 | `generate_image`、`save_image` |

[model-tool-provider.ts](../../../src/main/agent/model-tool-provider.ts) 的 `assertToolAuthorizedForWorkMode` 同时被 `getApproval` 与 `callTool` 调用。
`getScopedTools`、`getProcessTool`、`listTools` 按模式过滤写入、进程、浏览器、自定义 MCP 和图片；进程调用分支另查 Execute。
[model-runtime.ts](../../../src/main/agent/model-runtime.ts) 的工具循环对 Ask 文件读取、scoped read、Web、委派有免 authorizer 分支，其他调用走审批回调。
`run` 还根据 mode 选择工具循环或普通文本请求；应保留由 `noModelTools` 表达的内部无工具用途。
[direct-model-ripgrep.ts](../../../src/main/agent/direct-model-ripgrep.ts) 的 `checkAskArguments` 限制 cwd、路径、模式文件及符号链接访问。
Ask 禁止 `--pre`、`--hostname-bin`、`--follow`、`--search-zip`、`-L`、`-z`；这些检查与 workMode 参数需作为一组审查。
`searchWorkspaceWithRipgrep` 的原生 argv、`--no-config`、退出码、取消和分页输出不依赖产品模式语义。
provider 的 `rgModeError` 与“切换 Execute”恢复建议也需清理。
[direct-model-process-service.ts](../../../src/main/agent/direct-model-process-service.ts) 管理进程、cwd、输出保留和退出清理，不是工作模式入口。
`workspace_read_text` 与 `workspace_apply_patch` 的工作区相对路径合同仍是这些 API 的语义，不能因移除 Ask 自动扩大范围。
远程 workspace 下 provider 当前只保留文件读取；本机进程检查 execution identity。移除模式不会补出远程直连 Shell 或 patch。

## MCP、应用配置与图片

[ipc.ts](../../../src/main/ipc.ts) 的 `grantScopedDataCapability` 按 enabledServers 授予知识、笔记、配置、浏览器、Obsidian 和 Story Graph。
交互与调度调用者仍按 workMode 生成 configAccess、magicNotesAccess、browserAccess、Obsidian access，需一起审查。
[knowledge-mcp-gateway.ts](../../../src/main/agent/knowledge-mcp-gateway.ts) 维护请求能力与调用范围；不能把移除模式理解成取消知识库选择或会话归属。
[goodbuddy-config-tools.ts](../../../src/shared/goodbuddy-config-tools.ts) 有 Execute 专用描述；[goodbuddy-config-service.ts](../../../src/main/goodbuddy-config-service.ts) 的计划有效期、单次应用及部分失败语义独立保留。
自定义 MCP 的 enabled/assignments、服务实际工具目录与动态工具选项仍需按原合同处理，`readOnlyHint` 不应成为新模式替代物。
Web 的 Exa 工具绑定检查及 MCP annotations 属于提供者合同，不能全局删除包含 readOnly 的字段。

[image-generation-service.ts](../../../src/main/agent/image-generation-service.ts) 的 `bind`、describe、save、`regenerate`、`submit` 检查绑定 mode 和实时 mode 回调。
[image-tool-binding.ts](../../../src/main/agent/image-tool-binding.ts) 与 [image-generation-contracts.ts](../../../src/shared/image-generation-contracts.ts) 也携带模式依赖。
[protocol-remote-runtime-channel.ts](../../../src/main/remote-agent/protocol-remote-runtime-channel.ts) 仅为 Execute 发送图片说明。
[main-image-tool-session.ts](../../../src/main/remote-agent/main-image-tool-session.ts) 在远程生成和保存请求再次检查模式，Agent backend 与 OpenCode 插件还有下游检查。
移除时仍需保留图片模型会话访问设置、输入能力、制品归属、内联数据限额、覆盖文件规则及 Host 写入位置。
配置检测成功不能证明生成成功；本报告未执行图片生成。

## 原生客户端与生成包装代码

[native-client-coordinator.ts](../../../src/main/agent/native-client-coordinator.ts) 从项目/会话推导 mode，将其计入配置身份，并改变能力读写范围及自定义 MCP 接入。
其 `launch` 明确要求 local execution space；不能将远程 Runtime 支持表述成远程原生客户端已可启动。
[native-terminal-client.ts](../../../src/main/agent/native-terminal-client.ts) 内有 OpenCode/Continue 固定只读工具集合。
该文件给 Continue bundle 注入执行拦截，并选择 `--auto` 或 `--readonly --allow ... --exclude '*'`。
OpenCode 路径生成 `tool.execute.before` 插件及 build/plan permission 配置；原生终端不经过聊天页的全部包装逻辑。
[native-dsh-web-policy.ts](../../../src/main/agent/native-dsh-web-policy.ts) 生成 `goodbuddy-native-mode`，在 `tools/execute` 检查 mode 和 readOnlyTools，覆盖委派 agent。
[native-dsh-web-client.ts](../../../src/main/agent/native-dsh-web-client.ts) 写入并加载该插件；配置身份、插件文件生成和 readOnlyTools 传递需同时核对。
DSH patch 另设 `sandbox-policy: danger-full-access`、`approval: never`、禁用 `ui-permission`。
这些上游配置与 GoodBuddy mode hook 不同；整段删除可能恢复上游默认审批或工作区限制，必须单独确定保留行为。
Electron renderer sandbox、Main 凭据存储、IPC 校验和取消清理不属于产品模式移除目标。

## 远程 Agent 链路

| 层次与源码 | 模式落点 |
| --- | --- |
| [acp-remote-runtime](../../../src/main/agent/acp-remote-runtime.ts) | ActivePrompt、prepare 输入、`handlePermission`、按 Execute 传 authorizer |
| [remote-agent-contracts](../../../src/shared/remote-agent-contracts.ts) | preparation/acceptance 必填 workMode，`assertRemotePromptAcceptanceMatchesPreparation` 比对模式 |
| [remote-runtime-launch-contracts](../../../src/shared/remote-runtime-launch-contracts.ts) | Runtime 启动合同携带 workMode |
| [runtime-acp-backend](../../../src/agent-daemon/runtime-acp-backend.ts) | binding mode、图片限制、独占进程模式不可变检查、prepare/acceptance、启动传递 |
| [agent-owned-acp-prompt](../../../src/agent-daemon/agent-owned-acp-prompt.ts) | `start`、`prepareSession`、活动 mode、`#handlePermission` |
| [agent-acp-connection](../../../src/agent-daemon/agent-acp-connection.ts) | `setModelRoute` 传 session/operation/mode |
| [model-bridge-helper](../../../src/agent-daemon/model-bridge-helper.ts) | session route mode 校验、共享会话 Ask 默认值、OpenCode provider permission |
| [opencode-runtime-profile](../../../src/agent-daemon/opencode-runtime-profile.ts) | mode 生成 permission、Continue helper 的 `--work-mode` |
| [continue-acp-helper](../../../src/agent-daemon/continue-acp-helper.ts) | 路由或默认 mode、Execute/Story Graph 放行；下层仍复用 ContinueHostAdapter |
| [opencode-subagent-plugin](../../../src/agent-daemon/opencode-subagent-plugin.ts) | `chat.message` 设置父子 Session 权限、原生只读列表与图片模式限制 |
| [cli](../../../src/agent-daemon/cli.ts) | 必填 `--work-mode` 参数及 ask/execute 值校验 |
| [runtime-composition](../../../src/agent-daemon/runtime-composition.ts)、[process owner](../../../src/agent-daemon/direct-linux-stdio-process-owner.ts) | 将 launch/profile mode 传到真实启动路径 |

桌面 ACP Ask 回调仅放行 read；Agent-owned 回调放行 read/search，说明两处已有不同规则。
OpenCode 插件注明原生 ACP 仅转发已注册根 Session 的权限；子代理必须检查原生 Session 规则，不能只改根回调。
请求级图片端点隔离、子会话归属和撤销清理有独立用途，不能连同模式条件删除。
远程通用自定义/内置 MCP 分配尚未与本机路径等价；图片和 Story Graph 专门通道不能证明任意 MCP 可用。
[remote-runtime-lock.json](../../../remote-runtime-lock.json) 仅列 OpenCode、Continue；远程 DSH 和远程原生客户端缺口不会随模式移除解决。
[workspace-protocol-methods.ts](../../../src/agent-daemon/workspace-protocol-methods.ts) 的部分写入 API 当前返回只读服务不可用，这是服务支持限制。

## 工具审批移除与子任务

[ipc.ts](../../../src/main/ipc.ts) 交互直连 authorizer 对 `toolApproval === 'policy'` 拒绝，其他值自动允许；普通 Agent 路径不传通用 authorizer。
调度路径另有 Ask 拒绝、delegation 拒绝、Harness 自动允许、channel 策略，以及进入 `ToolApprovalBroker` 的分支。
调研时的 `src/main/tool-approval-broker.ts` 管理等待、session grant、超时和事件；该文件现已删除。用户追加授权后，一般工具审批的等待、授权状态、事件和回应入口均纳入删除范围。任务取消、超时和原生结构化问题仍需保留。
[contracts.ts](../../../src/shared/contracts.ts) 的 toolApproval 值为 always/session/workspace/policy；[runtime-settings-store.ts](../../../src/main/runtime-settings-store.ts) 单独持久化。
该持久化需从审计版本 21 升至下一可用版本并删除顶层字段，规则见[数据迁移](./data-migration.md#5-agent协议和设置)。不能保留为独立策略或固定自动允许值。
直连读取、Web 和委派存在绕过通用 authorizer 的分支，因此现有 policy 也不能直接称为全工具关闭开关。
[continue-permissions.ts](../../../src/main/agent/continue-permissions.ts) 的 ask 是上游 YAML 权限字段；审计未找到生产导入，需按真实引用判断。
[computer-control/broker.ts](../../../src/main/computer-control/broker.ts) 与 risk-policy 是另一套机制；搜索未发现生产构造调用，不能据此认定浏览器有同样审批。

[direct-model-subagent-service.ts](../../../src/main/assistant/direct-model-subagent-service.ts) 与 provider/model-runtime 传播父 mode；应检查能力继承、输出归属和取消。
[subagent-service.ts](../../../src/main/assistant/subagent-service.ts) 专家/团队继承 mode 和 authorizer；`synthesize` 明确为无工具综合用途。
App 的 `supportsSubagentSmartRouting` 与 IPC 的路由分支仅允许 Ask，属于产品模式耦合。
[supervision-production.ts](../../../src/main/assistant/supervision-production.ts)、[magic-note-analyzer.ts](../../../src/main/magic-notes/magic-note-analyzer.ts) 等内部请求写死 Ask。
删除这些字段时，应核对其无工具 provider 和用途限制；不能把内部摘要、监督、笔记分析默认升级为通用工具任务。

## 外部合同与版本

| 合同 | 当前证据 | 兼容性关注 |
| --- | --- | --- |
| Desktop / Agent | [package.json](../../../package.json) 0.15.10；[agent-runtime-lock](../../../agent-runtime-lock.json) Agent 0.15.3 | 发布号不等于每个未提交实现已经发布 |
| Agent wire | [agent-protocol/contracts](../../../src/shared/agent-protocol/contracts.ts) 2.0 | 与 Runtime capability 版本分开处理 |
| Runtime ACP capability | [control-contracts](../../../src/shared/agent-protocol/control-contracts.ts) `RUNTIME_ACP_CAPABILITY_VERSION = 5` | managed-remote-acp-runtime 使用 exactVersion；旧 schema 必填模式 |
| 远程 Runtime profile | remote-runtime-lock 中 protocol 1.0 | argv/helper/profile 必须配套 |
| OpenCode / Continue | 1.18.29 / 1.5.47 | SDK/plugin、Session PATCH、动态 MCP 名称、bundle patch marker 和 CLI flag |
| DSH / Cordis | 0.1.7-rc.2 / 4.0.4 | 原生工具 hook、插件装载、Web patch、MCP 名称归一化 |
| ACP | SDK 0.25.1，安装包协议常量 1 | 保留初始化、权限答复、问题交互、取消的上游语义 |
| Harness 扩展 | [deepseek-harness-protocol](../../../src/main/agent/deepseek-harness-protocol.ts) 1 | `goodbuddy/session/prepare` 当前必需 mode；握手精确校验 |
| Harness utility 控制 | [deepseek-harness-control-protocol](../../../src/main/agent/deepseek-harness-control-protocol.ts) 3 | 与 ACP 扩展版本不同，按实际变更合同判断 |
| 模型桥 | [model-bridge-contracts](../../../src/shared/model-bridge-contracts.ts) goodbuddy-model-bridge-v1 | helper route payload 与模型 HTTP 转发合同需区分 |
| MCP | 安装 SDK 1.30.0；最新协议 2025-11-25，默认协商 2025-03-26 | 另支持 2025-06-18、2024-11-05、2024-10-07；保留协商与工具结果合同 |

删除必填 preparation/acceptance 字段会破坏旧 Agent 调用，不能只改桌面类型或永久发送 execute 掩盖差异。
兼容处理应由技术设计明确更新双方 API、能力版本及最低可用组合；此处没有已验证的旧端兼容结论。
Continue 的 `mode: 'agent'/'chat'`、OpenCode primary/subagent/all 与 build/plan、DSH Plan 均属上游概念。
上游 permission 的 ask，以及 ACP allow_once/allow_always/reject/cancelled 答复，也不是产品 Ask。
文件权限 mode、TypeScript readonly、MCP readOnlyHint 不可全局替换；自有 workMode 和 GoodBuddy 注入模式需逐符号处理。

## UI、存储与 daemon 保留状态交接

UI 交接点包括 App/Composer、ProjectWorkModeFields/ProjectSwitcher、ChannelProjectSettingsFields、会话历史、任务条、子代理标签和 ImageCapabilityNotice。
[assistant-contracts.ts](../../../src/shared/assistant-contracts.ts) 的 WorkMode 系列、项目默认值、请求/任务/调度字段，以及 [channel-contracts.ts](../../../src/shared/channel-contracts.ts) 的 literal ask 需同步处理。
[remote-channel-routing.ts](../../../src/main/channels/remote-channel-routing.ts) 识别 /ask、/execute、/exec 和中文前缀；WeChat/WeCom/DingTalk driver 也注入 Ask。
[context-manager.ts](../../../src/main/context-manager.ts) 和 [runtime-conversation-history.ts](../../../src/main/agent/runtime-conversation-history.ts) 传播或剥离历史模式指令。
主存储交接为 [assistant-database.ts](../../../src/main/assistant/assistant-database.ts)、conversation-persistence、conversation-selectors：SQL 列、模板 JSON、导入导出和旧值归一化另行审计。
Agent 的 BindingState、活动 prompt、model route 在内存保留 mode；生成配置、启动参数和 [diagnostic-log.ts](../../../src/agent-daemon/diagnostic-log.ts) 也承载它。
[semantic-prompt-store.ts](../../../src/agent-daemon/semantic-prompt-store.ts) 没有专用 work_mode 列，但 preparation digest 间接包含模式，permission-decision 写入 transcript。
[runtime-owner-registry.ts](../../../src/agent-daemon/runtime-owner-registry.ts) 持久化进程身份及归属，没有独立产品模式字段；不应据此新增 daemon 持久模式设置。

## 回归核对清单

以下为已有测试落点和待验证目标，均不表示本次执行通过。

| 测试文件所在目录与名称 | 后续核对内容 |
| --- | --- |
| src/main/agent：runtime-controller.test、model-runtime.test、model-tool-provider.test | 缺省字段、目录与真实调用一致、旧策略及一般工具审批移除、内部无工具任务 |
| 同目录：direct-model-ripgrep.test、direct-model-process-service.test | 原生参数、cwd、退出码、分页、取消、进程回收 |
| 同目录：opencode-runtime.test、opencode-runtime-permissions.test | 全部实际原生目录、写入/Shell/Web/Skills/子代理/动态插件，外部 Server API |
| 同目录：continue-runtime.test、continue-host-adapter.test、continue-runtime-permissions.test | 实际 argv、配置合并、bundle patch、原生问题交互 |
| src/main 及 agent：deepseek-harness-acp-e2e.test、goodbuddy-harness-control-plane.test、deepseek-harness-third-party-plugin.e2e.test | Host 原生及扩展工具、prepare 握手、Main 代理 |
| src/agent-daemon：runtime-acp-backend.test、agent-owned-acp-prompt.test、continue-acp-helper.test、opencode-subagent-plugin.test、cli.test | 协议 5 变更、共享/独占进程、子会话、旧端不兼容、重连 |
| src/main/agent：native-terminal-client.e2e.test、native-dsh-web-client.test、native-client-coordinator.test | 生成包装代码、上游 sandbox/approval 配置、复用实例设置 |
| agent、agent-daemon、assistant：image-runtime-integration.test、image-generation-service.test、image-tool-mcp.test、subagent-service.test、direct-model-subagent-service.test | 图片本机/Host 保存、模型开关、子任务能力继承与无工具综合 |

验收应按 Runtime、入口、已有能力启用/分配状态组织，覆盖交互、调度、通道、子代理和原生客户端；不能仅测试 MCP。
涉及 Agent 的实现需按仓库规则以当前源码验证真实 Host 链路；源码搜索、token 校验和模拟测试均不能证明全部生产路径可用。
根 AGENTS.md 按用户授权更新目标规则；各 Runtime 技术文档、README/FEATURES、模式和安全设置文案及验证脚本需按最终实现与验证更新。跨功能入口暂以目标设计标注；历史发布记录保留其当时语义。
