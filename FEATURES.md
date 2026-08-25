# GoodBuddy 功能矩阵与路线图

本文记录 GoodBuddy 的已提供能力和路线图。未完成项目不代表已包含在当前版本中。

## 状态说明

- [x] 已提供
- [ ] 开发中或规划中，具体以条目标注为准

## 功能总表

### 桌面基础、工作空间与上下文

- [x] **跨平台桌面应用**：支持 Windows、macOS、Linux，以及 `x64`、`arm64` 发布目标。
- [x] **可配置全局快捷唤起**：在“平台功能 / 通用设置”中启停或录制 Electron accelerator；默认保留 `CommandOrControl+Shift+Space`，冲突或保存失败时继续使用上一组已注册快捷键，并显示可处理的状态。
- [x] **Projects、独立对话与会话分支**：按项目隔离上下文，管理会话、附件和 Git 工作区变更；本地会话可在稳定状态下复制当前聊天内容到独立分支，分支持续显示来源徽标且不复制 Task、队列或成果归属；项目选择器区分本地、托管 SSH 与远程消息通道项目，并显示对应目录或来源。
- [x] **文件、截图、窗口、剪贴板上下文**：用户明确选择后才加入模型上下文。
- [x] **富文本回答**：支持 GitHub Flavored Markdown、LaTeX 数学公式和受控 Mermaid 图表；大图可缩放、拖动或查看源码，失败时保留原始图表代码。
- [ ] **项目 Agent Space**（规划中）：在 Project 中统一角色、知识、Skills/MCP、模型、审批策略、预算和超时，并支持模板复用。
- [ ] **通用助手工作栏与执行空间**（规划中）：保留 Task Center 作为 Task 的单例索引，并把监督、Runtime、终端、进程、工作区、浏览器和成果作为始终可访问的应用级能力；除 Task Center 外的可绑定能力由用户选择跟随或固定目标，并逐步支持静态安全 HTML 预览、本机/SSH 执行空间和远程 Agent Runtime。附件与知识库继续由会话输入区管理，未来的记忆与历史执行上下文归入关联 Task。详见 [Feature PRD](./docs/prd/assistant-experience/assistant-workbar-and-execution-spaces-prd.md)。

### Agent Runtime 与模型连接

- [x] **直连模型 Runtime**：支持问答、知识总结、受控工具执行和图像生成。
- [x] **OpenCode 与 Continue**：使用隔离子进程、环境变量白名单、统一配置、取消、总执行时限、有界流式输出和活动记录；共享进程回收逻辑保留 Windows 完整进程树终止，并对采用独立进程组的 POSIX 子进程执行组回收。交互提问只由前台对话回答，定时任务、远程通道和委派等后台执行遇到提问时会立即失败并提示改为前台运行，避免无限等待。
- [x] **托管 SSH OpenCode 闭环（技术预览）**：该能力由“设置 > 平台功能”中的独立“远程项目（技术预览）”页签控制并默认关闭；关闭时不影响任何本地项目、普通桌面功能或桌面发布。启用后可管理固定 Host Key 的 SSH Host、浏览有界远端目录并创建 Ask/Execute 项目；Ask 在 Runtime 边界通过 bubblewrap 保持 Workspace 只读，Execute 使用所选 SSH 账号的完整权限。Main 通过签名 Agent、私有 Unix socket、ACP v3、持久恢复 cursor 和 Main-only 模型桥维持长任务、重连与会话恢复，模型凭据不进入远端。远端组件不嵌入桌面包，也不会在项目激活时自动下载；用户必须先在该设置页按 Linux x64/arm64 手动下载最新兼容的签名 `.gbagent`，或导入/导出离线包。每个复合包包含 Agent、固定 Node 与由桌面源码统一维护适配的 OpenCode Runtime；在线来源跟随“关于与更新”的 GitHub/北京 OSS 选择，签名累计目录绑定最低桌面版本、Agent 协议、架构、大小、SHA-256 和固定 URL。缺少某架构包只使该架构托管 SSH 不可用。持久化验证继续精确绑定 Agent installation 与签名 Runtime digest；托管 SSH 会话只显示支持的 OpenCode 选择。Windows 到 Linux x64 的安装、provider-free 模型桥、断线重放、Session 续接和零残留清理已完成真实 Host 验证；签名 Agent 0.11.2-e2e.12 与 OpenCode Runtime 1.18.9 已完成一次只提交一遍、只调用一个 Ask 原生 read、无标题轮次且精确返回证据内容的有界真实模型验收，当前源码 lock 已转为正式 Agent 0.11.4。
- [x] **SSH Host 运行环境手动更新**：远程运行环境卡片只读取 Host 已安装 Agent/Runtime 与当前本地复合包所需版本，不会联网。用户显式触发后，Main 按 Agent、Runtime 顺序使用对应 Host 架构的已验证本地 `.gbagent` 强制重新校验并安装，显示阶段进度并允许在最终收尾前取消；尚未下载时提示先到平台功能设置下载或导入。更新期间保留旧版本卡片，失败或取消后刷新实际状态并允许重试；成功后定向清理该 Host 缓存并使引用项目重新验证，不删除 Host 配置、凭据、项目设置或 Workspace 文件。
- [x] **DeepSeek Harness（预览）**：使用 GoodBuddy 固定 Host 和 OpenAI 兼容模型连接；Ask 只允许调用 Host 中真实注册的 `read`、`skill` 以及 Main 管理的 Web Search/Fetch 代理，拒绝插件同名冒充，Execute 放行全部已启用内置及插件工具，并以当前用户权限运行。图像输入跟随所选模型连接的能力声明，文本模型在 Host 或模型调用前拒绝图片，图片模型通过有界内联内容和临时 Attachment Store 接收 JPEG/PNG。
- [x] **DSH npm 插件市场**：市场默认关闭，由用户显式开启后搜索公共 npm 的 `dsh-plugin` 包，使用捆绑 npm 执行精确版本安装和普通 lifecycle scripts，并支持启停、JSON 配置、移除、失败启动自动停用和离线管理已安装插件；关闭市场只隐藏目录与管理界面，不改变已有插件的启停状态，第三方代码不受 Ask 初始化隔离。
- [x] **Ask 与 Execute 工作模式**：Ask 保持只读；Execute 是用户对当前本机或 SSH 账号可用工具、进程、网络和可写路径的完整授权。
- [x] **专家与 Subagent**：支持显式专家、团队分析和最多三个只读专家并行分析；聊天先展示可逐项展开的专家完整输出，再在其下展示总 Agent 的综合结果，并随会话保存。
- [x] **角色绑定模型连接**：每个角色可继承默认模型或选择独立文本模型连接，失效连接安全回退默认模型，综合角色始终继承默认模型。
- [x] **多协议模型配置**：支持 Anthropic Messages、OpenAI Responses、OpenAI Chat Completions、OpenAI Images 和无认证本机模型；“保存并测试模型”会发送有界的真实文本或图片生成请求并校验生成结果，而不是只检查 HTTP 连通性，因此可能产生少量服务商用量费用。
- [x] **上下文用量与自动压缩**：直连模型按每次成功调用更新供应商用量，图片与工具轮次使用同一口径，供应商缺失 usage 时才回退估算；界面明确区分“本次模型调用”和“压缩后对话估算”，压缩线始终根据当前设置与所选模型窗口即时计算，不在每个对话中保存旧配置；压缩标识的前后值使用同一估算口径，运行记录仍保留各次模型调用的供应商 usage。对话与多轮工具 Agent 可在已完成调用越过阈值后自动重复压缩，规划时先为固定提示、工具定义和摘要预留预算；同一回复会分别保留 Agent 工具上下文与对话历史的压缩标识，并在应用重启或较早消息滚出本地历史窗口后继续复用摘要。
- [x] **Main-only 凭据保护**：API Key 使用系统安全存储加密，不暴露给 Renderer。密钥随对应模型连接保存，修改服务地址或临时切换为无需认证不会要求重新输入；只有用户显式清除凭据或删除连接时才移除。
- [x] **OpenCode Runtime 定制**：GoodBuddy 管理的内置 OpenCode 可发现原生 Agents、Tools、Commands、LSP、Formatters、MCP、Skills、Prompts 与 Resources；Tools 单独显示读取、文件修改、命令、网络、Agent 编排等类型、来源及 Ask/Execute 可用性，并隐藏 OpenCode 内部 `invalid` 与 GoodBuddy 临时 MCP 工具。支持保存默认 Agent、每次请求覆盖 Agent、通过原生 SDK 执行 Command、显示上下文用量并调用有总时限的原生 Compact；并发外部 Server 对话的提问使用请求级公开 ID 映射，回答不会串到其他会话。外部 OpenCode Server 只报告连接状态，不宣称原生清单可读。任意插件安装、Session Share、自动 Worktree 和 OpenCode 原生会话持久化仍不开放。
- [x] **Continue Runtime 定制**：提供静态配置中的原生 Rules、Prompt 模板与 MCP 清单，以及可编辑的 GoodBuddy Rules/Prompt 配置预设；聊天可按请求选择预设和填入可继续编辑的 Prompt。当前 Continue Host 没有可信的静态原生 Tool 发现接口，且使用隔离的 `CONTINUE_GLOBAL_DIR`，因此界面明确标记 Tools 不支持静态发现，也不把 Host 实际不会加载的工作区或用户 Skills 冒充原生能力；GoodBuddy 分配的 Skills 仍按请求暂存执行。Continue 临时 Host 不复用原生会话压缩，手动压缩由 GoodBuddy 摘要模型完成并验证持久化摘要覆盖范围；Agent 交互提问转换为统一问答卡片。Resources、Hooks、后台 Job 和 Continue 原生会话管理继续暂缓。
- [x] **Runtime 原生清单语义**：原生能力以 Agents、Tools、Commands、Skills、MCP、Rules、Prompts、Resources、LSP、Formatters 和上下文 11 个页签展示；清单状态独立于 Runtime 连通性，区分完整、部分、不可用、仅连接和不支持。DeepSeek Harness 通过 Host Registry 枚举有界的内置/插件 Tools 与 Skills，显示真实 Ask/Execute 边界，并排除 GoodBuddy 按请求分配的 Skills、Web/MCP 代理。
- [ ] **Runtime 监督栏目**（规划中）：在应用级助手工作栏的固定 Runtime 栏目统一承载 OpenCode、Continue 和 DeepSeek Harness 的 Task 级委派、后台执行、Workflow/Hook、长任务与原生会话监督；用户只选择 Conversation 或 Task，Job/Run 保持内部，不形成树或独立操作对象。
- [ ] **可执行 Subagent**（规划中）：提供显式 Execute 委派，限制嵌套、并行、Token、时间和工具权限，在助手工作栏固定的 Runtime 栏目按 Task 聚合状态、取消入口和审计归属。

### Skills、MCP 与知识库

- [x] **Skills 按需接入**：可分配给直连模型、OpenCode、Continue 和 DeepSeek Harness，并使用有界资源和受控 Runtime 边界。
- [x] **内置 MCP 按需接入**：知识库、魔法笔记与 GoodBuddy 配置 MCP 可分别启停，并可分配给直连模型、GoodBuddy 管理的 OpenCode 和 Continue；DeepSeek Harness 在设置中明确显示为暂不支持。内置 MCP 仅通过当前请求的短期本机权限提供，Ask / Execute 读写边界不受用户配置放宽。
- [x] **MCP Tools**：显式启用的自定义 MCP 可按 Runtime 分配给直连模型、GoodBuddy 管理的 OpenCode、Continue Agent Execute 和 DeepSeek Harness，并仅在 Execute 加载；Agent 子进程只获得按请求签发的本机回环权限，MCP 地址、命令和凭据保留在 Main，动态工具仍会重新发现并经过现有执行记录与权限边界。
- [x] **MCP Prompts 与 Resources 元数据**：MCP 测试仅在 Server 声明对应能力时发现有界的 Prompt、参数与 Resource 元数据，不读取 Resource 内容；Runtime 支持的 Prompt 可填入聊天草稿后继续编辑。OpenCode 可报告实验性 Resource 清单，Continue 当前版本明确不支持 Resources。
- [x] **本地知识库**：支持文件、目录和网页导入、SQLite FTS5 检索及来源追溯。
- [x] **知识图谱**：支持规则、模型和混合抽取，以及实体、关系、别名和证据维护。
- [x] **向量模型配置与检索**：可配置兼容 Embeddings 接口并用于语义检索。
- [x] **向量诊断与索引任务**：提供真实向量生成诊断、按文档重建进度、取消、失败状态与重启后结果恢复；每篇成功文档立即可用于检索。
- [x] **混合检索测试台**：支持全文、中文词组、向量和图谱通道诊断，可调 Top K、阈值、权重、本地或学习型重排及上下文预算。
- [x] **分块、维护与评估**：支持固定、结构化和父子分块，分块维护、可取消重建及双语检索评估。
- [x] **受控知识本体**：每个知识库可定义实体、关系、别名和端点约束，保留证据偏移、置信度和抽取来源，并显式提示图谱重建。
- [x] **强制检索与引用上下文**：对话可按需或每次先检索，显示零结果、降级、失败与取消状态，并可查看引用上下文或安全打开来源。
- [x] **魔法笔记 / Magic Notes**：提供本地优先的笔记与待办工作台、范围管理、编辑、筛选和受控 AI 评论；左侧入口可按设置显示未完成待办数量，创建、保存和评论结果使用统一应用通知。
- [ ] **MCP Server Control Plane**（规划中）：统一 MCP 生命周期、健康检查、重连、Schema 缓存、隔离、审批和审计。
- [ ] **可追溯笔记摘录与 AI 编辑**（规划中）：从对话、知识和网页收集带来源的摘录，并提供需确认的总结、改写和整理操作。

### 工作管理、长期协作与工作流

- [x] **任务、活动与成果**：集中管理任务状态、审计活动和独立成果文件；普通聊天回复只保留在会话中，不再自动复制到成果栏，已有重复聊天 Markdown 从成果列表隐藏但不物理删除。Token 用量按 Runtime 与模型归类，并针对 OpenAI 兼容与 Anthropic Messages 的不同上报口径归一化展示缓存命中率；活动按会话分组并默认收起，避免长历史占满页面。
- [x] **Task 与定制任务体验**：每个产品级 Task 只关联一条 Conversation，一条 Conversation 可承载多个 Task；左侧会话列表通过行首展开按钮显示带共享状态点的 Task 子项，父会话行不重复任务标签，UI 只展示到 Task，不暴露 Job/Run 层级。新建定制任务可关联当前或新 Conversation，默认 Execute 并沿用 Runtime、工具和审批边界；重复触发复用同一 Task，文本结果回写 Conversation，独立文件和图片保留为成果。普通消息与到期 Scheduled Task 共用 Conversation 级持久发送队列，同一会话一次只执行一项；当前回复期间仍可继续发送，队列按顺序续跑，并允许删除或“立即中断并插入”。Task Center 继续作为完整索引，不建设独立 Automation Center。当前计划触发支持单次、每日和每周；高级时区、Cron、事件触发与重试治理仍按 PRD 逐步实现。详见 [Task Center PRD](./docs/prd/task-and-job/task-center-prd.md) 和 [Scheduled Task PRD](./docs/prd/task-and-job/scheduled-task-prd.md)。
- [x] **记忆与智能心跳**：当前提供周期回顾、建议记忆、洞察、后续任务和可审计运行轨迹。
- [x] **智能心跳入口与范围改善**：将“智能心跳 > 心跳计划”作为完整配置的唯一权威入口，支持创建和编辑 Global 或指定一个、多个 Project 的计划；旧单项目配置无损迁移，项目级记忆与行动输出必须显式指定范围内的 Project。Task Center 和设置不再复制心跳表单。“未来分区记忆”仍只是尚待独立设计的长期方向。详见 [智能心跳 PRD](./docs/prd/smart-heartbeat/smart-heartbeat-prd.md)。
- [ ] **通用监督**（规划中）：通过固定监督栏目观察用户选择的会话、任务、自动化或实验对象，提供带证据的评论与人工介入请求，但不自动发言、批准工具或切换 Execute。详见 [会话监督 PRD](./docs/prd/supervision/conversation-supervision-prd.md)。
- [ ] **批量运行与对比实验室**（规划中）：对模型、Prompt、角色和工作流配置执行批量对比，汇总质量、耗时、Token、费用、失败率和成果差异。
- [ ] **时态记忆与事实冲突检测**（规划中）：为记忆和知识图谱增加有效期、当前事实、过期与矛盾检测、事实核验及证据回溯。
- [ ] **可视化受控工作流**（规划中）：提供版本化 DAG、条件分支、审批、取消和恢复，执行节点继续经过 Main Runtime 边界。
- [ ] **统一 Run Graph 与回放**（规划中）：关联任务、Subagent、模型、知识、工具审批、用量和成果，支持失败定位、重试和脱敏导出。

### 浏览器、通信、语音与应用维护

- [x] **直连模型内置浏览器**：使用 GoodBuddy 内置的隔离 Chromium，不控制客户端已安装的浏览器；用户通过独立总开关决定是否提供给 Execute，开启后不逐次询问。
- [x] **客户端电脑控制工具**：与内置浏览器分开管理，并保留范围、取消、超时、输出边界和执行记录。
- [x] **远程消息通道项目**：微信 ClawBot、企业微信和钉钉分别拥有系统管理的项目、独立远程会话、工作目录、处理后端、默认 Ask/Execute 模式及任务活动归属；完整回复交由各通道按平台能力控制长度与分段，不再由公共服务统一截断。
- [x] **微信 ClawBot 扫码与媒体**：通过独立 Sidecar 完成本机扫码、验证码、加密凭据和文字收发；支持个人微信私聊图片与文件，单条消息最多 4 个附件、解密后合计不超过 12MB。
- [x] **微信安全回传**：支持返回当前任务生成的图片，或在用户明确要求时将本次最终文本生成为 Markdown 附件；不自动读取或发送已有工作区文件。
- [x] **企业微信与钉钉连接**：支持 Main-only 加密设置、环境变量只读覆盖、连接测试、动态启停、发送者范围和状态诊断。
- [x] **受管本地模型下载源**：在“平台功能 / 通用设置”中为后续语音输入与 OCR 模型下载全局选择 ModelScope（默认）或 Hugging Face；所选来源缺少完整已验证文件时明确不可用，不静默换源或混合文件。
- [x] **可选本地语音模型管理**：应用不内置模型权重；提供校验下载、进度与取消、来源链接、ZIP 或本地目录导入、切换和删除。
- [x] **本地录音与离线转写**：采集麦克风音频并使用已选择的本地模型离线转写，支持停止、取消、状态反馈和资源释放。
- [x] **版本检查与镜像节点**：在“关于与更新”中选择 GitHub（默认）或镜像节点；手动检查、启动时检查和下载页使用同一选择，并只读取固定可信的发布索引，不自动下载或安装。
- [x] **应用内反馈**：在“关于与更新”中直接提交问题、建议或体验反馈，支持可选邮箱和单张截图；失败后保留草稿并按同一请求编号重试，不自动附加对话、日志、文件、配置或凭据。
- [x] **内网兼容模式**：默认开启；允许应用内 HTTP 与无效、自签名或过期的 HTTPS 证书，关闭后恢复严格地址和证书校验。

### 开源、构建与发布

- [x] **0BSD 开源许可**：原创代码可自由使用、复制、修改、分发和商用；第三方组件和资源仍遵循各自许可证。
- [x] **可复现依赖安装与源码构建**：使用锁定依赖、Node.js 24 和统一的测试、类型检查、Lint、生产构建命令。
- [x] **六平台原生发布矩阵**：Windows、macOS、Linux 的 `x64`、`arm64` 目标由原生 Runner 构建，并提供发布清单和 SHA-256 哈希；Linux 同时生成 AppImage、DEB 和 RPM。

### 开放接口、团队协作与远程执行

- [x] **远程任务委派**：仅在用户显式配置端点和令牌后启用，按全局内网兼容模式使用 HTTP(S)，结果进入持久化发件箱。
- [ ] **Headless Runtime API**（规划中）：提供本机优先的任务、事件、状态和成果 API，以及有范围、有效期、限流和撤销能力的令牌。
- [ ] **GoodBuddy Team Hub**（规划中）：以可选服务提供组织、RBAC、项目共享、远程 Agent、策略下发和租户审计。
- [ ] **SSH 主机与远程执行空间发布验收**：主机 CRUD、Host Key、加密凭据、Project UI、Workspace、OpenCode ACP、Main-only 模型桥、Ask 只读、Execute 完整账号权限、取消、detached Agent 重连和 release-only 双架构资源校验已经接线。Windows 到 Linux x64 的真实 Host provider-free 安装、metadata-only Portable 复用与项目保存、桥接、断线恢复、输出重放、同 Session 续接与清理已经通过；Agent 0.11.2-e2e.12 与 OpenCode Runtime 1.18.9 的真实模型 Ask 验收也已通过，单次用户操作只执行一个原生 read，两个 build 模型轮次均完成交付，没有 title 轮次或请求重放。公开 signing key registry 已供应。剩余门槛是生成并导入 Linux x64/arm64 当前发布版本的正式签名工件完整矩阵。门槛未满足时不提供未验证 SSH fallback。
- [ ] **多云远程沙盒 Agent**（规划中）：通过云厂商 API 和 SSH Agent 管理专用 Linux 沙盒；凭据留在 Main 进程，高风险控制面操作单独确认。

## 规划原则

规划中的工作流、Subagent、MCP、远程 API 和沙盒能力不得绕过现有 Main Runtime、Ask/Execute、权限、取消、超时和审计边界。
