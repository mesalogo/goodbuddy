# Runtime 原生客户端启动方案

日期：2026-09-26  
Status: Local shortcut/coordinator paths and configured-model responses verified on Windows; remote integration and packaged Node delivery remain open.  
范围：Continue、OpenCode 的交互终端，以及 DeepSeek Harness（DS）的官方 Web 客户端。

本文集中维护该新增入口的需求、场景、行为规则、接入设计和验收计划。既有终端行为由
[多终端页签 PRD](./terminal-tabs-prd.md)维护，既有 Runtime 权限和资源边界由
[Runtime 交互边界](./runtime-interactions.md)维护；本文描述新增客户端路径，不宣称它已经具备后台 Runtime 的全部能力。

## 1. 方案选择

在聊天输入区“压缩上下文”左侧增加原生客户端入口。Continue 和 OpenCode 打开 GoodBuddy
工作栏中的交互终端；DS 启动官方 Web 服务并在系统默认浏览器中打开。使用当前项目目录和
当前模型，默认建立独立客户端会话，不自动复制 GoodBuddy 聊天历史。

| 当前 Runtime | 按钮文字 | 打开目标 | 本轮计划范围 |
| --- | --- | --- | --- |
| Continue | 在终端中打开 | 工作栏新终端页签，启动原生 CLI | 本地和托管 SSH 项目 |
| OpenCode | 在终端中打开 | 工作栏新终端页签，启动原生 TUI | 本地和托管 SSH 项目 |
| DeepSeek Harness | 在浏览器中打开 | 系统默认浏览器，访问官方 Web 应用 | 本地项目 |
| 内置模型 | 不显示此快捷入口 | 无 | 保持现状 |

DS 采用官方 `@deepseek-ai/dsh` Web 应用，不开发新的 DS 终端前端，也不在首轮嵌入
GoodBuddy 浏览器工作栏。远程 DS 不在本轮范围：当前共享远程启动契约只接受
`opencode` 和 `continue`，不能通过快捷按钮绕过该范围。

## 2. 调研依据与证据范围

下表保留早期测试报告，作为技术选型线索。2026-09-26 新增的 DS 0.1.7-rc.2
实测单列在表后；Continue、OpenCode 和远程交互终端本轮未复测。

| 历史报告项目 | 报告结果 | 尚需验证 |
| --- | --- | --- |
| Continue 1.5.47 | 标准 Node 与真实 PTY 可显示交互输入、配置和模型名称；直接用 Electron 启动失败 | 启动路径错误、当前模型注入、真实请求和权限 |
| OpenCode 1.18.29 | 随包二进制可显示 TUI，响应终端尺寸变化 | 排除已有用户配置干扰，验证指定模型实际生效 |
| DS Web 0.1.5-rc.3 | Node 24.19.0 启动；Edge 可访问页面及模型设置 | 项目自动选中、模型桥、真实对话、工作模式 |
| DS Windows 依赖 | 首次缺少 Sharp 原生包，补装后可启动 | 正式资源中预先带齐各目标平台依赖 |
| DS 工作目录 | 指定 cwd 后仍要求选择工作区 | 工作区创建及页面选中的完整路径 |
| 终端相关回归 | 报告为 5 个文件、29 项通过 | 新入口尚无回归或端到端验收 |
| 远程 Host | 两条网络路线 SSH 端口可达 | 登录后的当前源码、Runtime、模型桥真实验证 |

早期文档整理和依赖升级报告的真实模型调用为 0 次。本轮核查另发现临时目录
`dsh-017-live` 的 7 次历史 dispatch 记录；本轮在独立 `dsh-017-verify` 目录新增
9 次，两个计数分别保留。测试过程和结果以 [DS 实现进度](../deepseek-harness/progress.md#2026-09-26-真实模型与官方-web-验证)为准。

本轮直接检查了以下仓库材料：

- `src/main/terminal/terminal-session-manager.ts`：已有本地与 SSH 会话创建、窗口归属、事件转发和关闭管理，当前创建路径启动普通终端。
- `src/shared/remote-runtime-launch-contracts.ts`：远程 Runtime 枚举包含 Continue 和 OpenCode。
- `UI-DESIGN.md`：规定 Composer 元信息区、工作栏、通知、键盘及响应式规则。其聊天章节仍写远程只支持 OpenCode，与当前共享契约不一致；实施时需沿 UI 到执行路径核实并同步修正，不能单凭枚举认定远程交互已可用。

上游参考：[官方仓库](https://github.com/deepseek-ai/deepseek-harness)、
[CLI 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)、
[使用指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md)。
这些链接随上游变化；实施时须为选定包版本补充对应源码 revision、启动参数和接口依据。
历史测试版本是候选版本，不作为未经复测的最终发布版本。

2026-09-26 仓库内后台 DS Runtime 已升级至 `0.1.7-rc.2`，Cordis 升级至
`4.0.4`，验证记录见 [DS 实现进度](../deepseek-harness/progress.md)。此版本来自
npm `next` 标签；查询时 `latest` 仍为较旧的 `0.1.0-rc.6`。本轮另用官方
`@deepseek-ai/dsh@0.1.7-rc.2` 验证 Web。Prepared Web resources and backend validation are recorded in section 9.1.

### 2.1 DS 0.1.7-rc.2 实测结论

Windows x64、标准 Node 24.19.0、Edge 154.0.4258.37 下，官方 Web 可承接当前
工作区和已配置模型，完成页面真实对话。Main 使用 safeStorage 解密隔离副本中的模型
配置，经现有 managed model bridge、AgentModelGateway 和 loopback proxy 转发。
浏览器与 DS 只取得本地桥接信息，原始 `runtime-settings.json` 测前测后逐字节一致。

| 实测路径 | 结果 | 供应商 HTTP dispatch |
| --- | --- | ---: |
| 后台 Ask → `read` | 返回文件中未写入 prompt 的随机校验码，收到工具完成及用量事件 | 2 |
| 同一后台会话切 Execute → `write` | 创建测试文件，内容校验通过 | 2 |
| Execute → `pwsh` | PowerShell 读回该文件，结果正确 | 2 |
| 官方 Web → 当前模型 → 文件读取 → 回答 | 页面返回另一随机校验码，刷新后保留结果 | 3 |
| 合计 | 请求中的模型均为 `deepseek-flash`，HTTP 均为 200 | 9 |

`0.1.7-rc.2` 是 Harness/Web 包版本；`deepseek-flash` 是实际配置和请求中的模型 ID。
Web 的 3 次请求包含 1 次未携带工具的请求，计数没有只按用户提交次数计算。
后台使用当前源码的真实 ACP、Host、控制面和供应商流式响应，但 Host 在测试进程内组合；
该结果不等于重新验收 GoodBuddy 完整 UI 或 Utility Process。Web 使用真实 CLI 子进程和
浏览器自动化，未通过尚未实现的快捷按钮。测试继承了环境中的
`NODE_TLS_REJECT_UNAUTHORIZED=0`，因此没有验证严格 TLS 证书校验。

工作区和模型自动准备已验证；官方 Web 到 GoodBuddy Ask/Execute 的工具执行适配、
Skills/MCP 承接、取消和产品生命周期仍待实现与验证。此次可行性验证不要求完成按钮。

## 3. 产品需求

| ID | 要求 | 用户可见的验收结果 |
| --- | --- | --- |
| FR-1 | 在压缩按钮左侧提供 Runtime 对应入口 | 无历史、无压缩能力时仍能打开客户端 |
| FR-2 | 按项目执行空间启动 | 本地使用本地目录，SSH 使用绑定 Host 与远端目录；目录失效时说明原因 |
| FR-3 | 注入点击时选定模型 | 客户端首轮直接使用该模型，无需重复输入供应商密钥 |
| FR-4 | 创建独立客户端会话 | 不修改原聊天历史，不把打开操作伪装成当前聊天的续接 |
| FR-5 | 保持所选工作模式的执行边界 | Ask 的 AI 工具路径只读；Execute 使用相应账号已有权限 |
| FR-6 | 管理启动、重开和关闭 | 不因收起工作栏或切换项目中断；关闭对应客户端资源时释放其桥接 |
| FR-7 | 保留可处理的失败信息 | 启动、模型和远程错误可区分，允许修正后重试，不清空聊天草稿 |
| FR-8 | 明确原生能力与 GoodBuddy 能力差异 | 已分配的 Skills、MCP 等逐项接入并验证；未接入项有明确说明 |
| FR-9 | 交付可直接运行的客户端资源 | 用户无需自行运行 npx、补装 Sharp 或查找 Node |

聊天附件、知识范围、专家提示及历史不自动移入独立客户端。首轮不提供聊天双向同步、
Task 关联恢复或客户端历史导入。原生客户端产生的历史由对应客户端保存，不能在 GoodBuddy
活动记录中显示为已经同步的聊天内容。

FR-8 的实施清单须区分原生工具、GoodBuddy 分配的 Skills、自定义 MCP、内置 MCP、知识工具
以及遵循当前工作模式授权的配置工具。配置应用不再额外要求 GoodBuddy 原生确认，Ask 仍只读。
支持情况以真实调用为准；现有 DS 宿主插件能力不能
直接算作 DS Web 能力。发现现有分配无法承接时，在实施评审中明确差异和处理方式，不能默默忽略。

## 4. 场景与状态规则

### 4.1 用户场景

| ID | 前提与动作 | 预期结果 | 需求 |
| --- | --- | --- | --- |
| US-1 | 本地项目选中 Continue 或 OpenCode，点击入口 | 展开工作栏，新建带 Runtime 与项目名称的终端，进入可输入的原生界面 | FR-1～4 |
| US-2 | 本地项目选中 DS，首次点击入口 | 服务就绪后打开浏览器，当前项目已选中、模型可直接使用 | FR-2～4、9 |
| US-3 | 在支持的 SSH 项目点击终端入口 | 使用已保存 Host 连接，在远端项目目录启动对应 Runtime | FR-2、3 |
| US-4 | 启动期间连续点击 | 同一启动只创建一次；按钮显示启动中 | FR-6 |
| US-5 | 已打开客户端后切换项目或模式 | 旧客户端保持原项目和启动模式；新操作使用新选择 | FR-5、6 |
| US-6 | 启动失败或模型请求失败 | 保留原因与可操作的重试方式；聊天内容和草稿不变 | FR-7 |
| US-7 | Ask 下从原生界面请求写文件、执行写命令或使用写入 MCP | AI 执行边界拒绝写入，不能通过客户端模式开关绕过 | FR-5、8 |
| US-8 | 关闭终端、停止 DS 服务或退出 GoodBuddy | 对应进程和桥接释放，其他会话不受影响；原生历史保留 | FR-4、6 |

### 4.2 行为决策

启动参数按点击时的项目、执行空间、Runtime、模型和工作模式确定。界面后续切换不修改已运行
客户端。这里只需保留进程运行所需的内存记录，不增加持久启动快照、恢复日志或数据库迁移。

Continue 和 OpenCode 启动成功后，每次新的点击创建独立终端。启动中的重复点击合并到同一
进行中操作。终端会话数量沿用现有管理器规则，不新增一套数量控制。

DS 按项目、模型配置及工作模式匹配运行服务。配置相同且服务可用时重新打开原服务；配置变更后
新建匹配实例，保留原实例直到用户停止或应用退出，避免在已有页面中静默改变模型和权限。
同一匹配项并发启动只执行一次。服务已退出则清除内存记录，下一次点击重新启动。

| 事件 | 处理 | 关联场景 |
| --- | --- | --- |
| 启动中切换项目 | 操作仍属于原项目；完成时不抢占新项目的工作栏焦点 | US-4、5 |
| 收起工作栏、切换页面 | 保留终端与其模型桥 | US-5 |
| 关闭终端页签 | 停止该 PTY/远端进程，释放相应配置和桥接 | US-8 |
| 关闭 DS 浏览器标签 | 不推断服务已停止；再次点击可重开 | US-2、8 |
| 用户停止 DS 服务 | 停止该服务和桥接；浏览器页面失去连接；保留原生历史 | US-8 |
| GoodBuddy 退出 | 清理自己创建的进程与桥接，不停止用户其他进程 | US-8 |
| SSH 断开 | 显示断开；收束对应请求，重试时重建连接，不宣称原会话已恢复 | US-3、6 |
| 系统浏览器打开失败 | 保留可重开的就绪服务，通知用户重试；不复制含令牌地址到普通日志 | US-6 |
| 服务启动失败 | 清理本次创建的临时资源，再允许重试；不删除用户原生历史 | US-6 |

Ask 沿用现有 Runtime 按工具命令名判断的只读规则，不改变用户手动终端的已有权限。
DS 后台的 `read` 和原生 `skill` 可在 Ask 执行；`write`、`edit`、`pwsh`/`bash`
在 Ask 拒绝，在 Execute 放行，代理工具沿用现有分类。工具出现在模型请求目录中不等于
获准执行，判断仍在 `tools/execute` 路径。Web 接入复用这些规则，不增加 Shell 文本分析、
目录围栏、逐工具二次确认或新的权限等级。Execute 使用当前账号已有的文件、进程和网络权限。

官方 `dsh-plan-mode@0.1.7-rc.2` 的 Plan 只改变规划提示和状态，工具目录不随之变化；
权限预设由另外的 sandbox/approval 组件处理。因此不能把 Plan 名称当成 Ask 实现，
也不能把官方默认“工作区内修改”当成 GoodBuddy Execute。接入时将启动模式接到现有
工具名规则，原生页面的模式选择保持同一语义。

这些规则覆盖普通启动、使用、关闭和已知失败。尚需技术验证的项目见第 7 节；它们不构成新增
授权层级或通用恢复框架的理由。

## 5. 界面设计

输入区下方从左到右排列“在终端中打开／在浏览器中打开”“压缩上下文”和现有用量信息。
两个按钮独立判断可用性。采用同一轻量操作组，避免两组绝对定位相互覆盖；窄输入区允许
操作组换行，保留模式说明、用量信息和对称边距。稳定预留元信息高度的实现应与
[统一 UI 规范](../../../UI-DESIGN.md)一起更新并验证。

按钮使用原生 `button`、共享主题令牌和焦点环，支持 Tab、Enter 与 Space。打开终端后焦点
进入新终端；外部浏览器由系统处理焦点。启动期间保留按钮宽度并显示“正在打开…”，完成后
恢复原文案。缺少项目目录时在相关位置提供选择目录的操作；其他异步失败进入全局通知视口。

DS 服务运行后，在入口旁提供轻量菜单“重新打开”“停止此服务”；操作指向当前匹配服务。
若正在生成，停止前说明会中断该服务中的请求。输入区不常驻显示独立会话和服务生命周期说明。不在每次启动时增加确认弹窗。

按钮快捷入口根据所选 Runtime 显示，不改变工作栏“+”中的普通终端和浏览器入口。已有服务
的停止入口应在切换回来后仍可找到。

## 6. 技术接入

### 6.1 进程职责

Renderer 仅提交当前会话或项目标识及选择标识。Main 重新解析项目、模型配置、工作模式与
程序路径，通过共享 Zod 契约和显式 preload 方法完成调用。保留已有可信发送方校验，供应商
密钥留在 Main 加密设置和模型请求路径中。

建议新增小型原生客户端启动服务，负责配置准备、启动去重和资源释放。终端会话仍由
`TerminalSessionManager` 管理；DS 服务只需内存中的子进程、地址和桥接引用。不要新建平行
终端管理器或通用进程恢复引擎。

共享接口应返回可供界面使用的启动状态、终端标识或 DS 服务标识。外部 URL 由 Main 打开，
不允许 Renderer 提交任意程序、命令行、凭据或任意服务地址。错误保留组件、阶段和脱敏原因。

DS Web 随包依赖通过 `build/native-dsh-resources.cjs` 保留 npm 的嵌套布局。
复制时原样保留相对符号链接，不能将 CLI 链接改写成构建机的绝对路径；
经过 electron-builder 资源复制后，即使移除原始安装和暂存目录，链接仍须能解析到包内文件。
这一交付约束覆盖 FR-9；不改变 Agent 的独立 Runtime 打包路径。

### 6.2 Continue 与 OpenCode

Continue 使用已解析的标准 Node 启动固定版本 CLI，不能直接假定 Electron 的
`process.execPath` 等于 Node。OpenCode 使用已有平台对应可执行资源，启动交互 TUI。
两者均复用现有配置生成机制，但单独验证原生交互模式可接受的参数、模型 ID、环境变量及
Skills/MCP 配置，避免继承测试机器的全局默认模型。

本地 PTY 创建需接受 Main 生成的可执行路径、参数、环境和 cwd，不能先打开普通 Shell 再
模拟键入一段含凭据的启动命令。退出 CLI 后是否保留终端输出沿用既有终端体验；其桥接应
随 CLI 生命周期收束，不等到整个聊天结束。

Continue 的共享宿主适配器在 `GOODBUDDY_DISABLE_CONTINUE_UPDATES=1` 时，直接让更新服务保持 idle，并显示 `Continue CLI`，不进入 checking 状态。仅跳过底层版本查询仍会短暂显示 `Checking for updates`，因此服务入口和版本查询两处都需跳过。本地原生终端与 Agent Continue helper 使用同一适配器；已有缓存按补丁内容哈希重新生成。实测范围见[更新提示验证记录](./progress.md#2026-09-27-continue-update-status)。

模型桥作为客户端会话资源保持有效。复用前检查当前桥接是否依赖单轮请求、单一消息 ID
或短时授权；必要时只提取所需的会话级资源接口。真实供应商密钥不写入 CLI 配置，客户端
仅获得桥接所需的局部连接信息。

### 6.3 DS Web

使用固定版本的官方 Web 包，通过标准 Node 在回环地址启动。以下命令已在
`@deepseek-ai/dsh@0.1.7-rc.2`、Windows x64、Node 24.19.0 下启动成功：

```text
<managed-node> <resolved-dsh-cli> web --no-open --host 127.0.0.1 --port 0
```

生产环境直接使用已准备的资源，不在用户点击时执行不固定版本的 `npx`。Web 资源与当前
DeepSeek Harness 后台 Host 依赖分开管理，避免为了 Web UI 升级而隐式替换后台 Agent 库。
沿用既有受管工具环境和资源分发机制，不新增下载体系。若需在线分发，按该功能文档规范
明确下载源设置范围、固定版本、大小和 SHA-256；镜像与原地址使用相同字节内容。

使用 GoodBuddy 管理的独立 `DSH_HOME`，与用户已有 DS 安装隔离。原生历史和用户设置属于
持久数据，服务退出只删除可重建启动配置。多个运行实例不得共享不支持并发访问的数据库；
在验证官方存储行为后确定按项目及配置分目录的最小方案。

启动后经官方支持的配置/API 创建或查找项目工作区，初始化模型连接，再打开已选中目标
工作区的页面。仅设置 cwd 或成功创建后台工作区都不足以完成该步骤。不得直接修改未经
确认的 DS 私有数据库结构。

本轮验证使用 `$DSH_HOME/cordis.patch.yml` 配置 `llm-pi-ai` 的 `goodbuddy` provider，
设置 `api: openai-completions`、本地桥 `baseURL`、`apiKeyEnv` 和模型列表；
`agent-default-model` 指向同一 provider/model。环境变量中只放本地桥接标识。
官方 CLI 的 `profile-boot` 代码将该 patch 作为用户配置层加载。

取得官方启动地址并建立认证 cookie 后，调用 `POST /api/workspace/create`，请求形态为：

```json
{
  "type": "client-request",
  "rpcId": "<uuid>",
  "method": "workspace/create",
  "payload": { "args": { "request": { "path": "<project-directory>" } } }
}
```

该接口在首次运行返回 `created: true`，重开同一测试目录时返回 `created: false`。
随后访问根页面，两次均自动选中 `workspace` 和 `deepseek-flash`，没有手动选择模型或
再次输入供应商密钥。此证据覆盖单项目、独立 `DSH_HOME`；多项目共享服务的选中规则未测。
首次页面保留官方“内测声明”的“继续”操作；测试通过原生按钮继续，没有伪造接受记录。
官方默认权限显示“工作区内修改”，本轮只验证读取；权限适配按第 4.2 节另行接入。

Main 检查服务就绪后，使用 Electron `shell.openExternal` 打开官方规定的访问地址。
如地址带认证令牌，沿用官方认证方式，不写入普通日志。浏览器只访问本机服务；模型请求
通过 Main 中的桥接到达供应商。HTTP、流式响应、取消和错误映射都需实测。

### 6.4 远程 Continue / OpenCode

沿用 SSH Host 身份、凭据存储和 SSH PTY，并通过既有 GoodBuddy Agent 部署资源定位远端
Runtime。远端配置与模型桥需要客户端生命周期，不能直接复用一次聊天请求结束即释放的
桥接实例。远端使用已有模型桥协议及传输路径，是否需要补充生命周期接口由源码验证决定。

开发时必须在共享 Linux x64 Host 上运行当前改动，按
[远程主机技术设计](../remote-host/technical-design.md)执行真实启动、模型请求、取消、
断开和清理。端口可达不等于验证通过；若 Host 不可达，应记录阻塞，不能宣布远程功能完成。

远程 DS 将来若扩展，可评估远端 Web 加 SSH 本地端口转发；本轮不修改 DS 远程能力声明。

## 7. 实施顺序与技术验证

| 阶段 | 工作与应提交证据 | 通过条件 |
| --- | --- | --- |
| P1 原生配置验证 | 固定三个客户端版本；保存脱敏命令、环境与程序路径；隔离已有全局配置 | Continue/OpenCode 使用指定模型；DS 自动选中目标项目 |
| P2 模型与模式 | 每个客户端发送最小真实请求；验证流式、取消、Ask 写入拒绝及 Execute 专用目录写入 | 请求确实经过 GoodBuddy 模型桥；客户端模式切换不能破坏 Ask 边界 |
| P3 生命周期接入 | 配置、PTY、DS 进程和模型桥接入现有管理路径 | 重开、失败重试、关闭及退出能释放对应资源，原生历史保留 |
| P4 远程验证 | 在共享 Host 部署当前代码，验证 Continue/OpenCode 的 SSH PTY 与模型桥 | 启动、请求、取消、断开和重试均有真实 Host 证据 |
| P5 UI 与交付资源 | 接入按钮、通知、停止 DS 服务；完善平台资源与文档 | 从真实按钮到客户端完成对话，无手动补依赖步骤 |

P1、P2 是实施前段的实验任务，完成后继续交付完整入口，不将实验程序或不可用按钮作为最终功能。

DS 单项目工作区选中和当前模型桥协议已通过本轮验证。后续优先接入三个客户端的既有
Ask/Execute 工具规则、Skills/MCP 配置及客户端生命周期，再完成快捷入口和交付资源。
官方 DS 首次预览声明保留原生“继续”流程，模型配置提前准备。

## 8. 验收计划

| 验收面 | 检查内容 | 需求与场景 |
| --- | --- | --- |
| 实际使用 | 每个本地客户端从 GoodBuddy 按钮进入当前项目，使用当前模型完成一轮真实对话 | FR-1～4、US-1、2 |
| 配置隔离 | 预置另一套全局模型后，仍使用当前选择；两个项目不串目录或配置 | FR-2、3、US-5 |
| 工作模式 | Ask 尝试文件写入、Shell 写入和 MCP 写入均不执行；Execute 在专用测试目录成功写入 | FR-5、8、US-7 |
| 能力复用 | 为声明支持的 Skills、MCP 各验证实际加载及最小调用；列出未承接能力 | FR-8 |
| 生命周期 | 连点启动、切项目、隐藏工作栏、关闭页签、重开 DS、停止服务及退出 | FR-6、US-4、5、8 |
| 已知失败 | Node/原生依赖缺失、失效目录、模型错误、浏览器打开失败、SSH 中断 | FR-7、9、US-6 |
| 远程 | 当前源码在共享 Linux x64 Host 上完成 Continue/OpenCode 的 Ask/Execute、模型和断开场景 | FR-2、3、5、US-3 |
| UI | 浅深色、键盘操作、窄输入区、无压缩按钮、空对话、200% 文字缩放 | FR-1、US-1、2 |
| 平台资源 | 对实际交付的 Windows、macOS、Linux 架构逐项验证 Node、PTY、CLI 和 DS 原生依赖 | FR-9 |

完成源码后执行 `npm test`、`npm run typecheck`、`npm run lint`。修改生产构建资源时再按
仓库开发规则执行构建验证。单元测试覆盖行为和回归，不能代替真实按钮、模型和远程 Host 路径。
每份实测报告记录日期、源码 commit、包版本、平台、结果、脱敏证据位置及实际模型调用次数。

## 9. 文档交付状态

本轮完成 DS 后台真实模型与官方 Web 主流程验证，更新方案和
[DS 进度证据](../deepseek-harness/progress.md#2026-09-26-真实模型与官方-web-验证)。
P1 中 DS 单项目启动、模型预配置和工作区选中，以及 P2 中 DS 模型桥请求已实测。
The DS Web backend implementation and its focused validation are recorded below. Current local shortcut evidence is recorded in [workbar progress](./progress.md#2026-09-27-local-native-client-validation); full Electron UI acceptance remains separate.
后续入口交付事实写入工作栏 [progress.md](./progress.md)，按 FR、US 和阶段编号关联本方案。

实施时同步更新工作栏产品范围、终端规范、Runtime 交互边界及根 UI 规范；DS Web 的版本、
依赖与兼容性写入 [DeepSeek Harness 文档](../deepseek-harness/README.md)，远程部署事实写入
[远程主机文档](../remote-host/README.md)。保持各自职责，不复制多个相互冲突的支持矩阵。

### 9.1 DS Web Backend, 2026-09-26

`src/main/agent/native-dsh-web-client.ts` exports `NativeDshWebClientService`.
Construct it with `rootDirectory`, an async `resolveLaunchEnvironment` returning
`{ nodeExecutablePath, environment }`, and `resourcesPath` in packaged builds.
`start({ projectId, workspace, profile, workMode, configurationKey?, skillDirectories?, mcpServers? })`
returns `{ id, url }`. Main opens this URL with `shell.openExternal`; it must not
log the token-bearing URL or pass it to Renderer. `stop(id)` and `dispose()` close
the owned process tree and bridge. A browser-open failure leaves the service ready
for another call. Matching concurrent starts reuse one instance; changed model
credentials, project, mode, or capability assignments create a separate instance.

The service uses the existing managed model bridge, AgentModelGateway, and loopback
proxy. Provider credentials stay in Main. Each matching configuration has its own
persistent DSH_HOME. Shutdown removes launch configuration and the bridge ledger,
while retaining native history and settings. Startup authenticates through the
official launch URL and calls `workspace/create` before returning.

The host-level `tools/execute` hook permits native `read` and `skill` in Ask.
Assigned MCP servers supply their already-classified `readOnlyTools` as raw MCP
tool names; all other tool names are denied in Ask. Execute uses native full-access
permissions with no additional approval. The native permission picker is hidden;
changing Plan or creating another native session does not change the launch policy.
Skill directories and stdio/streamable-HTTP MCP configurations use official plugins.
Knowledge, built-in MCP, and GoodBuddy confirmation/configuration tools require a
caller-owned MCP adapter and are not automatically exposed by this service.

`@deepseek-ai/dsh@0.1.7-rc.2` is a pinned build dependency. The existing packaging
hook copies its installed dependency tree, including frontend assets and nested
dependency versions, to `resources/runtimes/dsh` outside ASAR. Target Sharp and
Koffi packages come from exact lockfile entries through the existing artifact
preparation code. The Web package itself needs no click-time npm install. The
coordinator now honors the current custom Node selection from the local tool
environment. Its managed fallback still installs `node-<platform>-<arch>@22.22.0`
through npm; this does not yet satisfy the prepared-resource delivery requirement
in section 6.3. No new download setting was added.

Focused tests use standard Node 24.19.0 on Windows x64 and the prepared resource
tree. They exercise Web startup, authentication, project creation, reuse,
mode isolation, stop/restart, retained history, and real Web API tool execution.
Deterministic model responses travel through the production model bridge: Ask
rejects writes, Execute creates the expected file, assigned skills load, read-only
MCP executes, and writing MCP is rejected before dispatch in Ask. These backend
tests make zero external model-provider calls. This evidence does not claim a
signed installer, other platforms, or the complete shortcut UI has been verified.

Validation: seven focused tests passed against the prepared resource tree;
the copied Sharp 0.35.4 native module encoded a PNG successfully; Main TypeScript
checking and `npm run build:bundle` passed. Full `npm run build`/typecheck and
`npm run lint` encountered concurrent Renderer errors in App.test.tsx and
RightAssistantSidebar.tsx; the backend files passed focused lint. Remote Agent
launch paths are unchanged because this service supports local DS Web only.

### 9.2 Local Coordinator Integration

The production coordinator resolves the saved conversation/project and current
settings for both `get` and `open`. Matching includes the selected model profile
and credentials, work mode, capability assignments, knowledge scope, Obsidian
settings and local Node selection. Ready services keep their MCP gateway after an
OS browser-open error and can be reopened or explicitly stopped by their owner.
The coordinator passes its configuration key into the service's existing match
hash, so the inner DS reuse decision also observes updated skill digests and
launch settings even when directory paths are unchanged.

For DS Ask, the built-in gateway's existing read grant supplies the allowed raw
tool names; the Web adapter maps these through the official MCP naming contract.
Custom MCP is exposed in Execute, matching the existing Runtime behavior; custom
`readOnlyHint` annotations do not introduce a separate Ask permission rule.
Assigned skill directories containing `SKILL.md` load through the official skill
plugin. Continue/OpenCode native Ask now retain Main-bound endpoints and map the
granted read-tool names through both native permissions and execution hooks.
OpenCode prefixes names with the bound MCP server name; Continue uses raw names.
Story Graph additionally rechecks Supervisor enablement on every call.

The coordinator remains local-only at this checkpoint. The remote implementation
is being developed separately and must be connected and verified on the shared
Host before remote shortcut support can be claimed. Current checks and exact
supplier counts are maintained in the workbar progress record linked above.
