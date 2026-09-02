# GoodBuddy 功能矩阵与路线图

[English](./FEATURES.md) | **简体中文**

本文记录 GoodBuddy 的已提供能力和路线图。未完成项目不代表已包含在当前版本中。

## 状态说明

- [x] 已提供
- [ ] 开发中或规划中，具体以条目标注为准

## 功能总表

### 桌面基础、工作空间与上下文

- [x] **跨平台桌面应用**：支持 Windows、macOS、Linux，以及 `x64`、`arm64` 发布目标。
- [x] **可配置全局快捷唤起**：在“平台功能 / 通用设置”中启停或录制 Electron accelerator；默认保留 `CommandOrControl+Shift+Space`，冲突或保存失败时继续使用上一组已注册快捷键，并显示可处理的状态。
- [x] **Projects、独立对话与会话分支**：按项目隔离上下文，管理会话、附件和 Git 工作区变更；本地会话可在稳定状态下复制当前聊天内容到独立分支，分支持续显示来源徽标且不复制 Task、队列或成果归属；项目选择器区分本地、托管 SSH 与远程消息通道项目，托管 SSH 项目按 Host 分组并在 Host 标题显示真实 Agent 连接状态，项目行只保留远端路径。
- [x] **文件、截图、窗口、剪贴板上下文**：用户明确选择后才加入模型上下文。
- [x] **富文本回答**：支持 GitHub Flavored Markdown、LaTeX 数学公式和受控 Mermaid 图表；大图可缩放、拖动或查看源码，失败时保留原始图表代码。
- [x] **AI 回复与完整会话复制**：已完成的 AI 回复可从消息底部复制不含推理、工具日志和引用元数据的 Markdown 原文；完整会话复制复用同一条经过 Preload/Main 校验的剪贴板路径。
- [x] **助手工作栏、多终端与可调布局**：右侧工作栏使用持久“+”能力目录和应用 Tab；用户可为当前本机或托管 SSH 项目打开多个独立终端，获得有界输出、调整尺寸、结束与显式重连。关闭终端 Tab 会结束 Shell，应用重启只恢复已结束的 Tab 描述，不自动重启 Shell。主侧栏和魔法笔记列表支持鼠标与键盘调宽，魔法笔记列表可隐藏并记住布局，窄宽度下自动堆叠。
- [ ] **项目 Agent Space**（规划中）：在 Project 中统一角色、知识、Skills/MCP、模型、审批策略、预算和超时，并支持模板复用。
- [ ] **通用助手工作栏与执行空间后续能力**（规划中）：在现有工作栏和多终端基础上继续加入监督、统一 Runtime、受管进程、静态安全 HTML 预览、可固定目标的工作区/浏览器/成果实例、底部停靠与独立窗口。Task Center 保持 Task 的单例索引，附件与知识库继续由会话输入区管理，未来的记忆与历史执行上下文归入关联 Task。详见 [Feature PRD](./docs/features/assistant-workbar/prd.md)。

### Agent Runtime 与模型连接

- [x] **直连模型 Runtime**：支持问答、知识总结、受控工具执行和图像生成。
- [x] **直连模型编程 Agent**：本机直连文本模型可在 Execute 模式运行平台 Shell，并可按父请求模式、模型、工作区和能力范围委派一层编程 Subagent；OpenCode、Continue、DeepSeek Harness 和托管 SSH 不重复注入这两个工具。Windows 本机命令与真实模型“修改、测试、修复、复核”闭环已通过，macOS 与 Linux 真机命令仍待对应平台验收。
- [x] **OpenCode 与 Continue**：使用隔离子进程、环境变量白名单、统一配置、取消、总执行时限、有界流式输出和活动记录；共享进程回收逻辑保留 Windows 完整进程树终止，并对采用独立进程组的 POSIX 子进程执行组回收。聊天状态检查使用一次性探测 Runtime 并在返回后立即回收，不进入按模型与项目隔离的执行 Runtime 缓存；执行 Runtime 仍按项目复用，因此不同项目可并行。交互提问只由前台对话回答，定时任务、远程通道和委派等后台执行遇到提问时会立即失败并提示改为前台运行，避免无限等待。托管 Linux ARM Host 切换项目或冷启动时，复用准备阶段已验证的 Runtime 路径、registry 和 manifest，不重复执行 OpenCode 版本探测或二进制检查。
- [x] **托管 SSH OpenCode 闭环（技术预览）**：该能力由“设置 > 平台功能”中的独立“远程项目（技术预览）”页签控制并默认关闭；关闭时不影响任何本地项目、普通桌面功能或桌面发布。启用后可管理固定 Host Key 的 SSH Host、浏览有界远端目录并创建 Ask/Execute 项目；Ask 在 Runtime 边界通过 bubblewrap 保持 Workspace 只读，Execute 使用所选 SSH 账号的完整权限。Agent 通过私有 Unix socket 和 ACP v4 持有 accepted Prompt、Provider/工具轮次、Runtime 进程、稳定模型 ledger 与有界语义 transcript；Desktop 退出、网络中断或本机进程结束后 Host 继续执行，重启后只 attach 原 controller/binding/operation 并把 provenance 原子归并回原对话，不重发 Prompt。模型 profile 与 API Key 只在当前 accepted operation 生命周期内进入 Agent 内存，不写入 Renderer、SSH 参数、远端环境或磁盘。远端组件不嵌入桌面包，项目切换只更新本地选择且不会连接或下载；设置页只读取小型签名目录并按 Linux x64/arm64 显示本地版本、在线最新兼容版本和“有更新/已是最新”，用户点击后才下载签名 `.gbagent`，也可导入/导出离线包。每个复合包包含 Agent、固定 Node 与由桌面源码统一维护适配的 OpenCode Runtime；在线来源跟随“关于与更新”的 GitHub/北京 OSS 选择，签名累计目录绑定最低桌面版本、Agent 协议、架构、大小、SHA-256 和固定 URL。公钥 registry 接受等价 JSON 空白和换行，但仍严格校验 schema、Ed25519 key、环境与撤销；目录、包、manifest、payload 签名和流式 SHA-256 不变。缺少某架构包只使该架构托管 SSH 不可用。项目只保存 Host、远端路径、Runtime 选择和模式；首次实际使用 Workspace/Runtime 时读取 Host current identity，同一进程内其他项目复用已确认 identity 和 Agent 连接。托管 SSH 会话只显示支持的 OpenCode 选择。同一 Host 可并行运行多个项目和对话；恢复进度分别显示网络、Agent、Runtime、已提交事件 cursor、完成或失败/重试，只阻塞受影响项目。Linux x64 真实 Host 已覆盖短/长 detach、本机 harness 强制结束、并发、SSH relay 丢失、取消、确定/不确定 Provider 失败、Agent `SIGKILL`/重启和 reopened Desktop SQLite 恢复；成功工具 START/END 各一次，未发现 Prompt、Provider 或工具重放。当前 Agent 源码 lock 为 `0.11.14`，Desktop 发布候选为 `0.12.0`；正式发布状态以 Agent 与 Desktop 的独立发布渠道为准。
- [x] **SSH Host 手动环境准备源码链路**：Host Key、认证和系统探针成功后先保存 Host，并只读探测共享 Agent/Runtime；保存 Host、打开项目都不自动安装。Host 卡片只有一个按版本事实显示“安装远程环境”“更新远程环境”或“重新安装”的主按钮，次级 SegmentedControl 选择默认且不持久化的“自动”、Host 下载或 GoodBuddy 传输；“版本匹配”badge 不等同环境健康。自动模式只在 operation/prepare 前探测并择一，显式选择保持有效，任何 prepare、commit 或 adoption 失败都不跨 acquisition 自动 fallback。两种方式把同一签名 compound `.gbagent` 交付到固定 staging 后，共用 control-plane prepare、commit、Agent activate/health、Runtime activate、finalize 与显式 cleanup。GoodBuddy 路径可在同一次操作下载并验证缺失候选、缓存并取得 lease，再有界流式 SFTP 上传一个归档和其中已验证的 bootstrap Node，不把约 294 MiB 整包读入 Main `Buffer`；Host 在解包时完成一次完整 payload 校验。未完成操作只记录暂存 cleanup 所需的 operation ID；下次更新尽力清理旧暂存后重新 prepare，不保存远端 metadata 副本，也不让 cleanup 失败阻塞新更新或回滚健康环境。已有项目在实际使用 Workspace/Runtime 时按需解析 Host current identity 并执行固定 `attach-or-bootstrap`，注册后的 health、capabilities 和 prompt 启动不扫描完整 payload。详见 [设计说明](./docs/features/remote-host/environment-provisioning-technical-design.md)。
- [ ] **SSH Host 环境准备真实 Host 验收**：源码已可使用当前 format v1 包；仍需完成 GitHub、北京镜像、Linux x64/arm64、取消和离线 GoodBuddy 传输的真实 Host 验收。当前状态不表示已发布或已完成真实 Host 测试。
- [x] **DeepSeek Harness（预览）**：使用 GoodBuddy 固定 Host 和 OpenAI 兼容模型连接；优先使用管理员提供的连接，否则跟随兼容的默认模型或首个兼容连接，无需单独重复选择。Ask 只允许调用 Host 中真实注册的 `read`、`skill` 以及 Main 管理的 Web Search/Fetch 代理，拒绝插件同名冒充，Execute 放行全部已启用内置及插件工具，并以当前用户权限运行。图像输入跟随所选模型连接的能力声明，文本模型在 Host 或模型调用前拒绝图片，图片模型通过有界内联内容和临时 Attachment Store 接收 JPEG/PNG。
- [x] **DSH npm 插件市场**：市场默认关闭，由用户显式开启后搜索公共 npm 的 `dsh-plugin` 包，使用捆绑 npm 执行精确版本安装和普通 lifecycle scripts，并支持启停、JSON 配置、移除、失败启动自动停用和离线管理已安装插件；关闭市场只隐藏目录与管理界面，不改变已有插件的启停状态，第三方代码不受 Ask 初始化隔离。
- [x] **Ask 与 Execute 工作模式**：Ask 保持只读；Execute 是用户对当前本机或 SSH 账号可用工具、进程、网络和可写路径的完整授权。
- [x] **专家与 Subagent**：支持显式专家、团队分析和最多三个只读专家并行分析；聊天先展示可逐项展开的专家完整输出，再在其下展示总 Agent 的综合结果，并随会话保存。
- [x] **角色绑定模型连接**：每个角色可继承默认模型或选择独立文本模型连接，失效连接安全回退默认模型，综合角色始终继承默认模型。
- [x] **多协议模型配置**：支持 Anthropic Messages、OpenAI Responses、OpenAI Chat Completions、OpenAI Images 和无认证本机模型；新用户默认连接为本机 Ollama 兼容地址，不预置第三方云模型服务。升级时只替换从未配置凭据且仍完全等于旧内置值的历史默认连接，用户显式保存或加密凭据的连接保持不变；已有部署仅使用兼容环境变量提供凭据时继续沿用对应的历史连接参数，通用模型环境变量仍优先。“保存并测试模型”会发送有界的真实文本或图片生成请求并校验生成结果，而不是只检查 HTTP 连通性，因此可能产生少量服务商用量费用。
- [x] **上下文用量与自动压缩**：直连模型按每次成功调用更新供应商用量，图片与工具轮次使用同一口径，供应商缺失 usage 时才回退估算；界面明确区分“本次模型调用”和“压缩后对话估算”，压缩线始终根据当前设置与所选模型窗口即时计算，不在每个对话中保存旧配置；压缩标识的前后值使用同一估算口径，运行记录仍保留各次模型调用的供应商 usage。对话与多轮工具 Agent 可在已完成调用越过阈值后自动重复压缩，规划时先为固定提示、工具定义和摘要预留预算；同一回复会分别保留 Agent 工具上下文与对话历史的压缩标识，并在应用重启或较早消息滚出本地历史窗口后继续复用摘要。
- [x] **持久凭据保护**：API Key 由 Main 使用系统安全存储加密且不暴露给 Renderer。托管 SSH accepted Prompt 只把当前 profile 与密钥放入 Agent 内存，不写入 SSH 参数、远端环境或磁盘；其他路径仍在 Main 内使用。密钥随对应模型连接保存，修改服务地址或临时切换为无需认证不会要求重新输入；只有用户显式清除凭据或删除连接时才移除。
- [x] **有界故障诊断**：Desktop 在用户数据目录中轮转保存启动、Runtime 和远程连接的固定阶段失败，最多 4 个 256 KiB 文件；GoodBuddy Agent 在各 installation 的私有 state 目录中轮转保存 daemon、连接、恢复和 Runtime 生命周期，最多 3 个 64 KiB 文件，并可通过固定 `diagnostics --installation-id` 命令读取。两端都只记录白名单阶段、稳定错误码/类型和固定短消息，不保存 Prompt、凭据、文件内容、路径、环境、SSH 参数或 Provider 原始响应；诊断写入失败不改变正常运行。
- [x] **OpenCode Runtime 定制**：GoodBuddy 管理的内置 OpenCode 可发现原生 Agents、Tools、Commands、LSP、Formatters、MCP、Skills、Prompts 与 Resources；Tools 单独显示读取、文件修改、命令、网络、Agent 编排等类型、来源及 Ask/Execute 可用性，并隐藏 OpenCode 内部 `invalid` 与 GoodBuddy 临时 MCP 工具。支持保存默认 Agent、每次请求覆盖 Agent、通过原生 SDK 执行 Command、显示上下文用量并调用有总时限的原生 Compact；并发外部 Server 对话的提问使用请求级公开 ID 映射，回答不会串到其他会话。外部 OpenCode Server 只报告连接状态，不宣称原生清单可读。任意插件安装、Session Share、自动 Worktree 和 OpenCode 原生会话持久化仍不开放。
- [x] **Continue Runtime 定制**：提供静态配置中的原生 Rules、Prompt 模板与 MCP 清单，以及可编辑的 GoodBuddy Rules/Prompt 配置预设；聊天可按请求选择预设和填入可继续编辑的 Prompt。当前 Continue Host 没有可信的静态原生 Tool 发现接口，且使用隔离的 `CONTINUE_GLOBAL_DIR`，因此界面明确标记 Tools 不支持静态发现，也不把 Host 实际不会加载的工作区或用户 Skills 冒充原生能力；GoodBuddy 分配的 Skills 仍按请求暂存执行。Continue 临时 Host 不复用原生会话压缩，手动压缩由 GoodBuddy 摘要模型完成并验证持久化摘要覆盖范围；Agent 交互提问转换为统一问答卡片。Resources、Hooks、后台 Job 和 Continue 原生会话管理继续暂缓。
- [x] **Runtime 原生清单语义**：原生能力以 Agents、Tools、Commands、Skills、MCP、Rules、Prompts、Resources、LSP、Formatters 和上下文 11 个页签展示；清单状态独立于 Runtime 连通性，区分完整、部分、不可用、仅连接和不支持。DeepSeek Harness 通过 Host Registry 枚举有界的内置/插件 Tools 与 Skills，显示真实 Ask/Execute 边界，并排除 GoodBuddy 按请求分配的 Skills、Web/MCP 代理。
- [ ] **Runtime 监督栏目**（规划中）：在应用级助手工作栏的固定 Runtime 栏目统一承载 OpenCode、Continue 和 DeepSeek Harness 的 Task 级委派、后台执行、Workflow/Hook、长任务与原生会话监督；用户只选择 Conversation 或 Task，Job/Run 保持内部，不形成树或独立操作对象。
- [ ] **可执行 Subagent**（规划中）：提供显式 Execute 委派，限制嵌套、并行、Token、时间和工具权限，在助手工作栏固定的 Runtime 栏目按 Task 聚合状态、取消入口和审计归属。

### Skills、MCP 与知识库

- [x] **Skills 按需接入**：可分配给直连模型、OpenCode、Continue 和 DeepSeek Harness，并使用有界资源和受控 Runtime 边界。
- [x] **本机工具执行环境源码链路**：在“能力与工具 > 工具执行环境”中为本机 Skills 与 stdio MCP 选择 GoodBuddy 托管 Node.js、按需安装的托管 Python，或经过真实验证的自定义解释器；提供独立的原生地址/OSS 镜像选择、诊断、安装进度、取消和删除。新的本机 Runtime 与 stdio MCP 获得不可变 PATH 快照，不修改普通终端、系统环境或远程 Host。Windows x64 托管 Node 与原生地址 Python 已通过真实安装验证。
- [ ] **本机工具执行环境发布验收**：六个平台/架构的 OSS 镜像对象已完成字节、大小和 SHA-256 公开回读验证。托管 Python 保持按需下载，不向 Desktop 发行包额外带入许可证文件。每个标准打包任务使用目标架构原生 Runner，并在打包前真实安装托管 Python，验证 SSL、pip 与 venv；`0.12.0` 候选仍须通过该矩阵。真实 Skill/MCP、自定义解释器和运行中进程协调仍是待完成验收；完成适用检查前不宣称六平台发布验收通过。
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
- [x] **Task 与定制任务体验**：每个产品级 Task 只关联一条 Conversation，一条 Conversation 可承载多个 Task；左侧会话列表通过行首展开按钮显示带共享状态点的 Task 子项，父会话行不重复任务标签，UI 只展示到 Task，不暴露 Job/Run 层级。新建定制任务可关联当前或新 Conversation，默认 Execute 并沿用 Runtime、工具和审批边界；重复触发复用同一 Task，文本结果回写 Conversation，独立文件和图片保留为成果。普通消息与到期 Scheduled Task 共用 Conversation 级持久发送队列，同一会话一次只执行一项；当前回复期间仍可继续发送，队列按顺序续跑，并允许删除或“立即中断并插入”。Task Center 继续作为完整索引，不建设独立 Automation Center。当前计划触发支持单次、每日和每周；高级时区、Cron、事件触发与重试治理仍按 PRD 逐步实现。详见 [Task Center PRD](./docs/features/task-and-job/task-center-prd.md) 和 [Scheduled Task PRD](./docs/features/task-and-job/scheduled-task-prd.md)。
- [x] **记忆与智能心跳**：当前提供周期回顾、建议记忆、洞察、后续任务和可审计运行轨迹。
- [x] **智能心跳入口与范围改善**：将“智能心跳 > 心跳计划”作为完整配置的唯一权威入口，支持创建和编辑 Global 或指定一个、多个 Project 的计划；旧单项目配置无损迁移，项目级记忆与行动输出必须显式指定范围内的 Project。Task Center 和设置不再复制心跳表单。“未来分区记忆”仍只是尚待独立设计的长期方向。详见 [智能心跳 PRD](./docs/features/smart-heartbeat/prd.md)。
- [ ] **通用监督**（规划中）：通过固定监督栏目观察用户选择的会话、任务、自动化或实验对象，提供带证据的评论与人工介入请求，但不自动发言、批准工具或切换 Execute。详见 [会话监督 PRD](./docs/features/conversation-supervision/prd.md)。
- [ ] **批量运行与对比实验室**（规划中）：对模型、Prompt、角色和工作流配置执行批量对比，汇总质量、耗时、Token、费用、失败率和成果差异。
- [ ] **时态记忆与事实冲突检测**（规划中）：为记忆和知识图谱增加有效期、当前事实、过期与矛盾检测、事实核验及证据回溯。
- [ ] **可视化受控工作流**（规划中）：提供版本化 DAG、条件分支、审批、取消和恢复，执行节点继续经过 Main Runtime 边界。
- [ ] **统一 Run Graph 与回放**（规划中）：关联任务、Subagent、模型、知识、工具审批、用量和成果，支持失败定位、重试和脱敏导出。

### 浏览器、通信、语音与应用维护

- [x] **直连模型内置浏览器**：使用 GoodBuddy 内置的隔离 Chromium，不控制客户端已安装的浏览器；用户通过独立总开关决定是否提供给 Execute，开启后不逐次询问。浏览器工作栏与 Agent 共用同一条按 Conversation 归属的会话和串行操作路径，支持返回、刷新/停止加载、地址输入、前往、交互和关闭；停止加载不会关闭会话，用户导航会改变 Agent 下一步看到的页面。
- [x] **客户端电脑控制工具**：与内置浏览器分开管理，并保留范围、取消、超时、输出边界和执行记录。
- [x] **远程消息通道项目**：微信 ClawBot、企业微信和钉钉分别拥有系统管理的项目、独立远程会话、工作目录、处理后端、默认 Ask/Execute 模式及任务活动归属；完整回复交由各通道按平台能力控制长度与分段，不再由公共服务统一截断。
- [x] **微信 ClawBot 扫码与媒体**：通过独立 Sidecar 完成本机扫码、验证码、加密凭据和文字收发；支持个人微信私聊图片与文件，单条消息最多 4 个附件、解密后合计不超过 12MB。
- [x] **微信安全回传**：支持返回当前任务生成的图片，或在用户明确要求时将本次最终文本生成为 Markdown 附件；不自动读取或发送已有工作区文件。
- [x] **企业微信与钉钉连接**：支持 Main-only 加密设置、环境变量只读覆盖、连接测试、动态启停、发送者范围和状态诊断。
- [x] **受管本地模型下载源**：在“平台功能 / 通用设置”中为后续语音输入与 OCR 模型下载全局选择 ModelScope（默认）或 Hugging Face；所选来源缺少完整已验证文件时明确不可用，不静默换源或混合文件。
- [x] **可选本地语音模型管理**：应用不内置模型权重；提供校验下载、进度与取消、来源链接、ZIP 或本地目录导入、切换和删除。
- [x] **本地录音与离线转写**：采集麦克风音频并使用已选择的本地模型离线转写，支持停止、取消、状态反馈和资源释放。
- [x] **版本检查与镜像节点**：在“关于与更新”中选择 GitHub（默认）或镜像节点；手动检查、启动时检查和下载页使用同一选择，并只读取固定可信的发布索引，不自动下载或安装。
- [x] **应用内反馈**：在“关于与更新”中直接提交问题、建议或体验反馈，支持可选邮箱和单张截图；默认不上传诊断，用户可主动附加有界的最近桌面诊断摘要。失败后保留草稿、诊断选择和同一请求编号；不会附加对话、Prompt、凭据、文件内容、路径、Provider 原始响应或远端 Agent 日志。
- [x] **内网兼容模式**：默认开启；允许应用内 HTTP 与无效、自签名或过期的 HTTPS 证书，关闭后恢复严格地址和证书校验。

### 开源、构建与发布

- [x] **0BSD 开源许可**：原创代码可自由使用、复制、修改、分发和商用；第三方组件和资源仍遵循各自许可证。
- [x] **可复现依赖安装与源码构建**：使用锁定依赖、Node.js 24 和统一的测试、类型检查、Lint、生产构建命令。
- [x] **六平台原生发布矩阵**：Windows、macOS、Linux 的 `x64`、`arm64` 目标由原生 Runner 构建，并提供发布清单和 SHA-256 哈希；Linux 同时生成 AppImage、DEB 和 RPM。

### 开放接口、团队协作与远程执行

- [x] **远程任务委派**：仅在用户显式配置端点和令牌后启用，按全局内网兼容模式使用 HTTP(S)，结果进入持久化发件箱。
- [ ] **Headless Runtime API**（规划中）：提供本机优先的任务、事件、状态和成果 API，以及有范围、有效期、限流和撤销能力的令牌。
- [ ] **GoodBuddy Team Hub**（规划中）：以可选服务提供组织、RBAC、项目共享、远程 Agent、策略下发和租户审计。
- [ ] **SSH 主机与远程执行空间发布验收**：主机 CRUD、Host Key、加密凭据、Project UI、Workspace、OpenCode ACP v4、Agent-owned Prompt/gateway/transcript、Ask 只读、Execute 完整账号权限、取消、detached Agent 精确重连和 release-only 双架构资源校验已经接线。Linux x64 当前源码已用真实模型与工具通过 detach、进程结束、relay 丢失、并发、取消、Provider 异常、Agent 重启和 Desktop SQLite 恢复矩阵；最终 `0.11.14` 测试签名包再次验证两个已交付模型轮次、一个工具、一个终态、`latest=ACK` 与零 owner/journal 残留。公开 signing key registry 已供应。控制面直连源码不等待新 installer-bearing 包，但仍需公开核对当前 Linux x64/arm64 正式签名工件矩阵，并完成 GitHub/北京镜像、双架构和离线 GoodBuddy 传输的发布验收；门槛未满足时不宣称该路径已发布或通过正式发布验收。
- [ ] **多云远程沙盒 Agent**（规划中）：通过云厂商 API 和 SSH Agent 管理专用 Linux 沙盒；凭据留在 Main 进程，高风险控制面操作单独确认。

## 规划原则

规划中的工作流、Subagent、MCP、远程 API 和沙盒能力不得绕过现有 Main Runtime、Ask/Execute、权限、取消、超时和审计边界。
