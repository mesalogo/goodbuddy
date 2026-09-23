# GoodBuddy 功能矩阵与路线图

[English](./FEATURES.md) | **简体中文**

本文记录 GoodBuddy 的已提供能力和路线图。未完成项目不代表已包含在当前版本中。

## 状态说明

- [x] 已完成
- [ ] 待实现

状态表示功能实现情况，不等同于版本已发布或全部测试已执行。验证记录单独列出，不作为第三种功能状态。

## 功能总表

### 桌面基础、工作空间与上下文

- [x] **跨平台桌面应用**：支持 Windows、macOS、Linux，以及 `x64`、`arm64` 发布目标。
- [x] **信创软硬件覆盖**：正式 Linux 安装包覆盖国产 `x64` 与 `arm64` 架构，可用于统信 UOS、银河麒麟及海光、兆芯、鲲鹏、飞腾等兼容环境。龙芯 LoongArch 另行提供 `loong64` 实验预览版，不属于正式发布矩阵，也未纳入自动更新；`0.13.8` 不构建该预览。这里的覆盖范围不等同于厂商或整机兼容认证，具体状态与限制见[龙芯预览版构建说明](./docs/development/loongarch-preview-build.md)。
- [x] **可配置全局快捷唤起**：在“平台功能 / 通用设置”中启停或录制 Electron accelerator；默认保留 `CommandOrControl+Shift+Space`，冲突或保存失败时继续使用上一组已注册快捷键，并显示可处理的状态。
- [x] **Projects、独立对话与会话分支**：按项目隔离上下文，管理会话、附件和 Git 工作区变更；本地会话可在稳定状态下复制当前聊天内容到独立分支，分支持续显示来源徽标且不复制 Task、队列或成果归属；项目选择器区分本地、托管 SSH 与远程消息通道项目，托管 SSH 项目按 Host 分组并在 Host 标题显示真实 Agent 连接状态，项目行只保留远端路径。
- [x] **跨项目会话活动**：统一入口汇总各项目正在运行和需要处理的对话，保留仍有活动的较早会话。锚定的“项目 → 会话”菜单支持键盘导航和精确打开对话，不再使用整块活动弹窗；空闲时隐藏摘要，长会话子菜单独立滚动，项目选择器继续显示活动数量。
  后台会话成功完成后，在本次客户端运行期间保留完成提示，直到对应聊天可见且加载完成；提示不跨重启保留。
- [x] **会话置顶与完整历史**：常用会话可置顶，重启后保留。列表和搜索不再限于最近 100 个会话，连续发送不再截断超过 500 条的已保存历史；模型上下文限制仍有效，已丢失的历史无法恢复。
- [x] **按需上下文帮助**：页面和设置中的补充说明使用标题或字段旁的共享帮助入口，支持鼠标与键盘；关键操作后果和错误提示保持可见。
- [x] **紧凑会话控件**：输入选项集中在紧凑设置面板，Runtime、工作模式、发送和队列操作保持可用；会话搜索提供内嵌清除按钮，清除后恢复当前范围列表并把焦点返回输入框。
- [x] **会话历史按需加载**：列表只加载轻量摘要，不再一次读入全部会话的过程元数据；已打开和活动会话保留完整详情，搜索、复制、导出、续聊和远程待答问题保持可用。图片合并不会重新发送未变化消息，已确认保存的空闲详情随现有视图缓存释放。详见[历史读取与保留规则](./docs/features/assistant-workbar/execution-history-storage.md#会话列表读取与前端保留)。
- [x] **文件、截图、窗口、剪贴板上下文**：用户明确选择后才加入模型上下文。聊天输入框支持 `Ctrl+V` 粘贴一个或多个本地支持文件并自动添加为附件，沿用附件按钮的解析进度与限制；普通文本和截图仍可直接粘贴。详见[聊天附件规则](./docs/features/document-processing/prd.md#321-聊天附件入口)。
- [x] **图片型 PPTX 文字识别**：配置本地 OCR 并选择启用 OCR 的解析方式后，可识别内嵌 PNG、JPEG 和 WebP 图片，保留原生文字与幻灯片定位。OCR 在没有活动或排队任务时空闲 60 秒自动释放模型内存，下次按需重载；快速文本/索引模式仍跳过 OCR。详见[解析行为与真实文件验证](./docs/features/document-processing/chat-attachments-technical-design.md)。
- [x] **HTTP OCR 与附件持久预览**：在“设置 / 文档解析”配置 HTTP PaddleOCR-VL，供聊天文档和知识库导入共用。保存原件与插图，提供正文/图片/详情预览、显式图片文字提取，以及选图加入指定会话草稿。普通图片默认走图片输入，发送与入队检查实际模型和 Runtime。Windows、直连视觉输入和共享 Linux Host 托管 OpenCode 已有真实验证；部署高级 OCR 模型及其他 Runtime 组合需分别测试。本机推理监控只管理本地服务，不新增应用中心入口，详见[范围与证据](./docs/features/document-processing/README.md)。
- [x] **工作区单文件差异**：变更文件可分别查看已暂存和未暂存差异，覆盖删除、重命名和未跟踪文件；刷新会重读当前差异、当前浏览目录和已展开目录，超过 50 项变更可继续加载。
- [x] **工作区文件与 Git 管理**：支持文件和目录的新建、重命名、移动、删除、属性查看，以及本地/远程分支搜索与切换、新建分支、显式 Fetch、提交历史和单文件提交差异。工具按文件/Git 视图分组，分支搜索使用统一紧凑表单，子目录保留文字导航而根目录不再显示孤立图标。提交历史贴底，首次展开占 Git 内容区一半，支持调整比例、独立滚动和统一刷新；切换项目自动检测 Git，不沿用其他项目状态。移动限于工作区内，删除须确认，分支冲突不自动 stash 或丢弃改动；托管 SSH 操作需要 Agent `0.11.23`。
- [x] **富文本回答**：支持 GitHub Flavored Markdown、LaTeX 数学公式、受控 Mermaid 图表和会话内 HTML 静态预览。Mermaid 大图放大后可滚动到各个边缘，并可导出完整 PNG，不受当前缩放和拖动位置影响。Agent 完成回复后，完整 HTML 与 HTML 代码块可在原位置预览，并通过图标按钮查看源码或打开全屏预览；该能力默认开启，可在“平台功能 / 通用设置”关闭，预览不执行脚本、联网、表单提交或窗口操作。
- [x] **AI 回复与完整会话复制**：已完成的 AI 回复可从消息底部复制不含推理、工具日志和引用元数据的 Markdown 原文；完整会话复制复用同一条经过 Preload/Main 校验的剪贴板路径。
- [x] **助手工作栏、多终端与可调布局**：工作栏开关位于明暗主题按钮旁；右侧工作栏使用持久“+”能力目录和应用 Tab，任务中心与工作区为不可关闭的单实例，浏览器可打开多个独立实例。任务中心可切换当前项目和所有项目，范围随布局保存；无项目任务在所有项目中标注“未绑定项目”。用户可为当前本机或托管 SSH 项目打开多个独立终端，获得有界输出、调整尺寸、结束与显式重连。关闭终端 Tab 会结束 Shell，应用重启只恢复已结束的 Tab 描述，不自动重启 Shell。主侧栏和魔法笔记编辑器的 AI 评论栏支持鼠标与键盘调宽；AI 评论栏记住显示状态及宽度，窄窗口下移至编辑器底部。
- [ ] **项目 Agent Space**（规划中）：在 Project 中统一角色、知识、Skills/MCP、模型、审批策略、预算和超时，并支持模板复用。
- [x] **应用中心与导航**：底部应用中心向上展开轻量锚定菜单，无模态遮罩，只列已启用应用，不按打开历史或常驻筛选。点击应用行关闭菜单，本机推理监控打开保留底层工作区的独立 Modal，其余应用打开主内容区；底部“管理应用”打开可搜索卡片及设置详情，布局与交互见 [UI 设计](./docs/features/application-tool-navigation/ui-design.md)。四张应用卡片均支持上下移动和拖动排序，不受启用或常驻状态限制；卡片、菜单和经过过滤的侧栏共用一份保存顺序。知识库和智能心跳始终启用并常驻，标注“始终显示”，提供“打开”和排序，不提供启用、常驻开关或通用空设置；原工作区配置和心跳单条计划 enabled 不变。可选启用、常驻和共同设置仅适用于魔法笔记、本机推理监控。旧可选应用顺序补齐默认项并保留已有相对顺序；未发布的 `knowledgeEnabled`、`heartbeatEnabled` 已移除，不增加开关键迁移。设置持久化后的事件同步各入口，包括工具配置写入；重开中心刷新期间锁定修改，新快照覆盖迟到的旧读取。`local-inference` Modal 直接显示服务列表，不展示任务历史或外部连接；向量服务显示独立进程 CPU 与工作集内存，ASR／OCR 说明共享进程无法独立统计的原因。ASR 就绪状态未知，不从活动请求推断运行中。受支持的服务操作保留影响确认，失败后刷新列表并要求重新确认；TTS 显示不可用。取消中的推理在 Worker 确认或退出前仍计入活动任务及服务停止影响。实现已接入生产 App；验收记录分别列出完整 App、组件 fixture、真实本地引擎和剩余平台／安装包覆盖，不以历史失败代替当前全量结果，详见[验证进度](./docs/features/application-tool-navigation/progress.md)。
- [ ] **私有化应用市场**（规划中）：在应用管理基础上提供组织自己的目录与应用分发。当前只管理内置应用，尚无市场浏览或安装能力，详见 [FR-15](./docs/features/application-tool-navigation/prd.md#fr-15-私有化市场与-yaml-交换后续)。
- [ ] **通用助手工作栏与执行空间后续能力**（规划中）：在现有工作栏和多终端基础上继续加入监督、统一 Runtime、受管进程、静态安全 HTML 预览、可固定目标的工作区/浏览器/成果实例、底部停靠与独立窗口。Task Center 保持 Task 的单例索引，附件与知识库继续由会话输入区管理，未来的记忆与历史执行上下文归入关联 Task。详见 [Feature PRD](./docs/features/assistant-workbar/prd.md)。
- [ ] **ShareServer Office 协同编辑**（设计中）：通过可选 ShareServer 集成 ONLYOFFICE Docs，在助手工作栏中以文件名打开多个文档 Tab，支持 DOCX、XLSX、PPTX 的人工编辑、保存、撤销、源文件冲突保护和后续 AI 选区修改。Office 正文会由所选 ShareServer 和编辑引擎处理；Desktop 不内置或启动 Document Server，未配置服务时不宣称离线编辑。详见[设计文档](./docs/features/office-document-editing/README.md)。

### Agent Runtime 与模型连接

- [x] **子任务历史去重与空间回收**：本机与托管 SSH 子任务事件只存变化，不再反复保存完整进度。首次升级自动转换旧记录并回收空间，显示进度且支持退出重试；保留聊天、执行详情、结果和远程事件去重。已随 0.13.2 发布的 schema 35 补修还会整理升级到 0.13.1 后重复写入的工具块，不删除事件；终态及时释放写入缓存，远程重复重放不重建已释放的缓存。旧客户端不能打开升级后的数据库，具体规则见[执行记录存储与升级回收](./docs/features/assistant-workbar/execution-history-storage.md)。

- [x] **直连模型 Runtime**：支持问答、知识总结、受控工具执行、图像生成，以及通过支持 OpenAI 兼容图片编辑接口的服务商进行参考图编辑。连续请求自动复用最近一次成功生成的图片和文字历史，已保存会话重开后仍可继续修改，本轮显式附图优先；上游明确不支持编辑时继续按文字生成，仅在回复底部提示未使用参考图。编辑使用 multipart 上传图片，结果仍只接受经过校验的内联图片，不下载服务商返回的图片 URL。详见[图片生成与连续修改](./docs/features/image-generation/README.md)。
- [x] **当前会话图片工具**：为图片模型开启会话调用后，支持工具调用的聊天模型可在 Execute 中生成图片、修改上传图片或历史成果，无需另开会话或手动切换图片模型。直连文本模型、本地 OpenCode、Continue、DeepSeek Harness 和托管远程 OpenCode 复用统一服务，Runtime 分配由模型设置派生；图片请求可能产生费用，编辑需服务商支持。详见[实现与验证记录](./docs/features/conversation-media-generation/progress.md)。
- [x] **跨项目 Runtime 进程复用**：兼容配置的本地 OpenCode 和 DeepSeek Harness 共享重型进程，托管 OpenCode 会话在同一 Host 上复用进程。项目适配器及会话的工作区、模型、工具、问答和取消仍独立路由；远程待答问题和任务状态可在重连或桌面重启后恢复，不重发已接受请求。新的远程行为需要 Desktop `0.13.5` 与 Agent `0.13.0` 配套更新，详见[设计与实测](./docs/features/assistant-workbar/runtime-process-reuse-technical-design.md)。
- [x] **直连模型编程 Agent**：本机直连文本模型可在 Execute 模式运行平台 Shell，并可按父请求模式、模型、工作区和能力范围委派一层编程 Subagent；OpenCode、Continue、DeepSeek Harness 和托管 SSH 不重复注入这两个工具。Windows 本机命令与真实模型“修改、测试、修复、复核”闭环已通过，macOS 与 Linux 真机命令仍待对应平台验收。
- [x] **高效直连模型工作区工具**：直连模型使用随包 ripgrep 紧凑地发现文件和搜索内容，按行分页读取大型 UTF-8 文件，并在 Execute 中应用多文件补丁。Ask 可以搜索和读取，但不能应用补丁或运行命令；用户无需另行安装 ripgrep。可处理的读取或搜索错误允许模型调整参数后继续，部分搜索结果保留并明确提示覆盖不完整。
- [x] **长上下文与工具输出分页**：历史消息、长回复和文档解析文本不再采用旧的固定截断限制。直连模型可分页续读已保存的命令和 Subagent 输出；所选模型的上下文窗口及传输边界仍然有效。
- [x] **OpenCode 与 Continue**：使用隔离子进程、环境变量白名单、统一配置、取消、启动与控制请求时限、有界流式输出和活动记录；共享进程回收逻辑保留 Windows 完整进程树终止，并对采用独立进程组的 POSIX 子进程执行组回收。聊天状态检查使用一次性探测 Runtime 并在返回后立即回收，不进入按模型与项目隔离的执行 Runtime 缓存；本机 GoodBuddy 管理的 OpenCode 在该被动检查中只确认所选路径和模型凭据，不启动用后即毁的 Server，设置中的显式连接测试和原生能力清单仍执行完整启动及健康检查，原生能力清单随后与首次实际请求复用同一个执行 Runtime，不再重复冷启动；执行 Runtime 仍按项目复用，但 OpenCode 配置依赖和按内容摘要生成的 Skill 快照在所有本机项目间全局复用，会话数据、工具输出及请求级 MCP 状态继续隔离。本机 GoodBuddy 管理的 OpenCode 只对同一会话内的请求保持顺序，不同会话即使属于同一项目也可并行，不同项目同样可并行；请求级动态 MCP 通过默认通配禁用和当前请求精确放行保持隔离。托管的本机和远端 OpenCode 跳过界面未使用的自动 Git 快照，避免同步差异计算拖住会话，文件工具、子代理与工作区 Git 差异保留；Continue 持续排空不用展示的宿主 stdout，防止控制台输出填满管道。这些调整随新启动的 Runtime 生效，不改写外部 OpenCode Server 配置。OpenCode 与 Continue 不再按固定工具调用数或活动数中止单次运行，已观察到的工具与 Subagent 活动全部保留在本地会话，不再在原生任务继续执行时丢弃后续详情。交互提问只由前台对话回答，定时任务、远程通道和委派等后台执行遇到提问时会立即失败并提示改为前台运行，避免无限等待。本机 OpenCode 启动时直接使用已选择的绝对路径，不预先检查文件或运行 `--version`，路径失效时由实际启动返回错误；托管 Linux ARM Host 激活 Runtime 时复用准备阶段已验证的 registry 和 manifest，不重新哈希或检查完整 OpenCode 二进制。
- [x] **托管 SSH OpenCode 与 Continue（技术预览）**：该能力由“设置 > 平台功能”中的独立“远程项目（技术预览）”页签控制并默认关闭；关闭时不影响本地项目、普通桌面功能或桌面发布。支持 Linux x64、Linux arm64 和 macOS arm64 Host，不支持 Intel Mac；通过 SSH 按需启动 detached Agent，不要求开机服务。Ask 在 Runtime 工具边界保持只读，Execute 使用所选 SSH 账号的完整权限。Agent 持有 Prompt、模型和工具轮次、Runtime 进程及语义 transcript，Desktop 断开后重新 Attach 原操作而不重发 Prompt；模型凭据仅在当前操作内存中使用，不写入 Renderer、SSH 参数、环境或磁盘。设置页按平台和架构显示包状态，用户显式下载、更新或导入/导出包含 Agent、固定 Node、OpenCode 和 Continue 的签名 `.gbagent`；三个目标共用一个签名 catalog，继续校验签名和 SHA-256。Continue 需要更新后的联合包与配套 Desktop。首次发布混合 catalog 前需先升级 Desktop，旧版 Linux-only 目录读取器无法解析包含 Darwin 的目录。历史 macOS OpenCode 原生安装、生命周期、Attach、真实 Ask/Execute 和独立进程组工具取消已在真实 Host 验证，不代表 Continue 的同等实机覆盖或新版本已经发布。当前源码候选为 Agent `0.13.2`、Desktop `0.13.8`；详细运行边界和 Linux 历史回归证据见[远程主机技术设计](docs/features/remote-host/technical-design.md)，正式发布状态以独立发布渠道为准。
- [x] **SSH Host 手动环境准备源码链路**：Host Key、认证和系统探针成功后先保存 Host，并只读探测共享 Agent/Runtime；保存 Host、打开项目都不自动安装。Host 卡片只有一个按版本事实显示“安装远程环境”“更新远程环境”或“重新安装”的主按钮，次级 SegmentedControl 选择默认且不持久化的“自动”、Host 下载或 GoodBuddy 传输；“版本匹配”badge 不等同环境健康。自动模式只在 operation/prepare 前探测并择一，显式选择保持有效，任何 prepare、commit 或 adoption 失败都不跨 acquisition 自动 fallback。两种方式把同一签名 compound `.gbagent` 交付到固定 staging 后，共用 control-plane prepare、commit、Agent activate/health、Runtime activate、finalize 与显式 cleanup。GoodBuddy 路径可在同一次操作下载并验证缺失候选、缓存并取得 lease，再有界流式 SFTP 上传一个归档和其中已验证的 bootstrap Node，不把约 294 MiB 整包读入 Main `Buffer`；Host 在解包时完成一次完整 payload 校验。未完成操作只记录暂存 cleanup 所需的 operation ID；下次更新尽力清理旧暂存后重新 prepare，不保存远端 metadata 副本，也不让 cleanup 失败阻塞新更新或回滚健康环境。已有项目在实际使用 Workspace/Runtime 时按需解析 Host current identity 并执行固定 `attach-or-bootstrap`，注册后的 health、capabilities 和 prompt 启动不扫描完整 payload。详见 [设计说明](./docs/features/remote-host/environment-provisioning-technical-design.md)。
- **SSH Host 环境准备验证记录**：当前源码已在隔离 Linux x64 环境通过包安装、Ask/Execute、原生子代理工作区外写入、重连及 stop/bootstrap。现有记录未覆盖 Host 卡片的完整 GitHub、北京镜像、Linux x64/arm64、取消和离线 GoodBuddy 传输矩阵，候选 CI/原生打包与系统休眠唤醒也尚未验证；开发记录不代表版本已经发布。
- [x] **远程工作区与长任务更新**：Agent `0.11.23` 新增远程文件/Git 管理和可选模型限额，随包 Runtime 不再施加固定十分钟 Prompt 时限；无限请求时长仍保留独立连接超时。请先升级 Desktop 至 `0.12.11`，再下载并更新 Host 上的 Agent。
- [x] **远程原生问答与取消修复**：Agent `0.11.24` 修复远程原生问答转交和取消待答后同一会话续发，需要先升级 Desktop 至 `0.13.0`。
- [x] **DeepSeek Harness（预览）**：使用 GoodBuddy 固定 Host 和 OpenAI 兼容模型连接；优先使用管理员提供的连接，否则跟随兼容的默认模型或首个兼容连接，无需单独重复选择，设置页显示实际管理员或回退模型来源。Ask 只允许调用 Host 中真实注册的 `read`、`skill` 以及 Main 管理的 Web Search/Fetch 代理，拒绝插件同名冒充，Execute 放行全部已启用内置及插件工具，并以当前用户权限运行。图像输入跟随所选模型连接的能力声明，文本模型在 Host 或模型调用前拒绝图片，图片模型通过有界内联内容和临时 Attachment Store 接收 JPEG/PNG。Windows Host 启动和 ACP 会话共用规范工作区路径，同目录不同写法可复用正常 Runtime，不再因路径不一致而创建会话失败。
- [x] **DSH npm 插件市场**：市场默认关闭，由用户显式开启后搜索公共 npm 的 `dsh-plugin` 包，使用捆绑 npm 执行精确版本安装和普通 lifecycle scripts，并支持启停、JSON 配置、移除、失败启动自动停用和离线管理已安装插件；关闭市场只隐藏目录与管理界面，不改变已有插件的启停状态，第三方代码不受 Ask 初始化隔离。
- [x] **Ask 与 Execute 工作模式**：Ask 保持只读；Execute 是用户对当前本机或 SSH 账号可用工具、进程、网络和可写路径的完整授权，包括工作区外路径及原生子代理工作。
- [x] **Runtime 原生交互转交**：OpenCode 与 Continue 的选择、yes/no、自由文本回答和跳过使用现有问答卡片，本机与托管 SSH OpenCode 同时转交属于当前请求的子会话提问。托管 SSH OpenCode 问答需要 Desktop `0.13.0`、Agent `0.11.24` 和新启动的托管 Runtime，不扩展到任意 ACP 服务。回答或跳过成功后在原位置保留问题与答案，支持多轮记录和本地会话重载；旧版本已丢弃的答案不能恢复。并行问题按顺序等待回答，重复事件保留草稿，提交失败可重试；取消远程待答后可在同一会话继续发送。Execute 权限确认自动处理，不等待第二次审批；具体支持范围见[交互边界](./docs/features/assistant-workbar/runtime-interactions.md)。
- [x] **原生执行清单**：OpenCode 和 Continue 在对话顶部更新只读执行清单，进度随会话保存。显式清空和远程重放保留请求归属，取消不把未完成条目标成完成；远程交付需要配套 Agent，详见[清单契约](./docs/features/assistant-workbar/runtime-checklist-technical-design.md)。
- [x] **专家与 Subagent**：支持显式专家、团队分析和最多三个专家并行分析。专家继承父请求 Ask/Execute 模式，可使用已启用的本机直连模型工具，Ask 仍只读；这些工具不是远程 OpenCode 子会话。聊天先展示可逐项展开的专家完整输出，再在其下展示总 Agent 的综合结果，并随会话保存。
- [x] **OpenCode 子代理过程与最终结果**：子代理卡片按顺序显示文字、推理和工具过程，最终结果独立展示。远程实时过程需要 Agent `0.11.20`，旧包仍显示最终结果但不补造缺失过程。
- [x] **OpenCode 事件连接回收**：聊天与原生上下文压缩在结束事件迭代前关闭各自订阅，覆盖完成、失败、取消和消费方提前结束，不取消其他并行会话。
- [x] **准确的消息底部状态**：区分请求准备、等待重试、开始重试、工具活动、待回答和终态；本机 OpenCode 使用原生重试次数和计划时间，直连模型显示自身退避阶段。消息底部状态点保持静态，未接入的 Runtime 重试不编造提示，会话列表闪点及发送、停止行为不变。
- [x] **直连模型命令工作目录**：Execute 命令可通过绝对路径、相对路径或符号链接使用工作区外目录；工作区仍为默认目录和相对路径基准，Ask 保持只读。
- [x] **简化 Runtime 选择**：会话与项目菜单不再枚举每个 Runtime 与模型的组合，Runtime 模型在系统设置中配置；已保存的项目固定模型仍可使用，并明确显示其固定模型。
- [x] **角色绑定模型连接**：每个角色可继承默认模型或选择独立文本模型连接，失效连接安全回退默认模型，综合角色始终继承默认模型。
- [x] **多协议模型配置**：支持 Anthropic Messages、OpenAI Responses、OpenAI Chat Completions、OpenAI Images 和无认证本机模型；新用户默认连接为本机 Ollama 兼容地址，不预置第三方云模型服务。升级时只替换从未配置凭据且仍完全等于旧内置值的历史默认连接，用户显式保存或加密凭据的连接保持不变；已有部署仅使用兼容环境变量提供凭据时继续沿用对应的历史连接参数，通用模型环境变量仍优先。“保存并测试模型”会发送有界的真实文本或图片生成请求并校验生成结果，而不是只检查 HTTP 连通性，因此可能产生少量服务商用量费用。
- [x] **模型请求定制**：每个 LLM 连接可填写有界 JSON 自定义请求头和顶层请求体。直连与 Continue 支持两者；本地 OpenCode 和 DeepSeek Harness 只使用各自原生支持的请求头，受管 SSH OpenCode 模型网关支持两者。Runtime、协议和认证字段始终优先，这些普通连接设置不能用于保存 API Key 或其他密钥。详见[模型连接请求定制](./docs/features/model-connections/README.md)。
- [x] **上下文用量与自动压缩**：直连模型按每次成功调用更新供应商用量，图片与工具轮次使用同一口径，供应商缺失 usage 时才回退估算；界面明确区分“本次模型调用”和“压缩后对话估算”，压缩线始终根据当前设置与所选模型窗口即时计算，不在每个对话中保存旧配置；压缩标识的前后值使用同一估算口径，运行记录仍保留各次模型调用的供应商 usage。对话与多轮工具 Agent 可在已完成调用越过阈值后自动重复压缩，规划时先为固定提示、工具定义和摘要预留预算；同一回复会分别保留 Agent 工具上下文与对话历史的压缩标识，并在应用重启或较早消息滚出本地历史窗口后继续复用摘要。
- [x] **持久凭据保护**：API Key 由 Main 使用系统安全存储加密且不暴露给 Renderer。托管 SSH accepted Prompt 只把当前 profile 与密钥放入 Agent 内存，不写入 SSH 参数、远端环境或磁盘；其他路径仍在 Main 内使用。密钥随对应模型连接保存，修改服务地址或临时切换为无需认证不会要求重新输入；只有用户显式清除凭据或删除连接时才移除。
- [x] **有界故障诊断**：Desktop 在用户数据目录中轮转保存启动、Runtime 和远程连接的固定阶段失败，最多 4 个 256 KiB 文件；GoodBuddy Agent 在各 installation 的私有 state 目录中轮转保存 daemon、连接、恢复和 Runtime 生命周期，最多 3 个 64 KiB 文件，并可通过固定 `diagnostics --installation-id` 命令读取。两端都只记录白名单阶段、稳定错误码/类型和固定短消息，不保存 Prompt、凭据、文件内容、路径、环境、SSH 参数或 Provider 原始响应；诊断写入失败不改变正常运行。
- [x] **OpenCode Runtime 定制**：GoodBuddy 管理的内置 OpenCode 可发现原生 Agents、Tools、Commands、LSP、Formatters、MCP、Skills、Prompts 与 Resources；Tools 单独显示读取、文件修改、命令、网络、Agent 编排等类型、来源及 Ask/Execute 可用性，并隐藏 OpenCode 内部 `invalid` 与 GoodBuddy 临时 MCP 工具。支持保存默认 Agent、每次请求覆盖 Agent、通过原生 SDK 执行 Command、显示上下文用量并调用有总时限的原生 Compact；并发外部 Server 对话的提问使用请求级公开 ID 映射，回答不会串到其他会话。外部 OpenCode Server 只报告连接状态，不宣称原生清单可读。任意插件安装、Session Share、自动 Worktree 和 OpenCode 原生会话持久化仍不开放。
- [x] **Continue Runtime 定制**：提供静态配置中的原生 Rules、Prompt 模板与 MCP 清单，以及可编辑的 GoodBuddy Rules/Prompt 配置预设；聊天可按请求选择预设和填入可继续编辑的 Prompt。当前 Continue Host 没有可信的静态原生 Tool 发现接口，且使用隔离的 `CONTINUE_GLOBAL_DIR`，因此界面明确标记 Tools 不支持静态发现，也不把 Host 实际不会加载的工作区或用户 Skills 冒充原生能力；GoodBuddy 分配的 Skills 仍按请求暂存执行。Continue 临时 Host 不复用原生会话压缩，手动压缩由 GoodBuddy 摘要模型完成并验证持久化摘要覆盖范围；Agent 交互提问转换为统一问答卡片。Resources、Hooks、后台 Job 和 Continue 原生会话管理继续暂缓。
- [x] **Runtime 原生清单语义**：原生能力以 Agents、Tools、Commands、Skills、MCP、Rules、Prompts、Resources、LSP、Formatters 和上下文 11 个页签展示；清单状态独立于 Runtime 连通性，区分完整、部分、不可用、仅连接和不支持。DeepSeek Harness 通过 Host Registry 枚举有界的内置/插件 Tools 与 Skills，显示真实 Ask/Execute 边界，并排除 GoodBuddy 按请求分配的 Skills、Web/MCP 代理。
- [ ] **Runtime 监督栏目**（规划中）：在应用级助手工作栏的固定 Runtime 栏目统一承载 OpenCode、Continue 和 DeepSeek Harness 的 Task 级委派、后台执行、Workflow/Hook、长任务与原生会话监督；用户只选择 Conversation 或 Task，Job/Run 保持内部，不形成树或独立操作对象。
- [ ] **Subagent 高级监督**（规划中）：在工作栏固定 Runtime 栏目按 Task 聚合，提供可配置的嵌套、并行、预算和生命周期控制。基础专家模式继承与单层直连模型编程委派已经可用。

### Skills、MCP 与知识库

- [x] **Skills 按需接入**：可分配给直连模型、OpenCode、Continue 和 DeepSeek Harness，并使用有界资源和受控 Runtime 边界。
- [x] **本机工具执行环境源码链路**：在“能力与工具 > 工具执行环境”中为本机 Skills 与 stdio MCP 选择 GoodBuddy 托管 Node.js、按需安装的托管 Python，或经过真实验证的自定义解释器；提供独立的原生地址/OSS 镜像选择、诊断、安装进度、取消和删除。新的本机 Runtime 与 stdio MCP 获得不可变 PATH 快照，不修改普通终端、系统环境或远程 Host。Windows x64 托管 Node 与原生地址 Python 已通过真实安装验证；托管 Python 归档按目标文件系统验证，Linux 保留大小写不同的合法路径，所有目标仍拒绝完全重复路径和不安全条目。
- **本机工具执行环境验证记录**：六个平台/架构的 OSS 镜像对象已完成字节、大小和 SHA-256 公开回读验证。托管 Python 保持按需下载，不向 Desktop 发行包额外带入许可证文件。每个标准打包任务使用目标架构原生 Runner，并在打包前真实安装托管 Python，验证 SSL、pip 与 venv。不可变的 `v0.12.0` 尝试在发布前通过 Windows 与 macOS，但暴露了 Linux TAR 大小写处理问题；`v0.12.1` 在同步 Agent 发布时于原生打包前取消。已发布的 `v0.12.2` 随后通过全部六个原生打包任务及其托管 Python 安装探针。现有记录未覆盖真实 Skill/MCP、自定义解释器和运行中进程协调。
- [x] **内置 MCP 按需接入**：知识库、魔法笔记、GoodBuddy 配置与内置浏览器 MCP 可分别启停，并可分配给直连模型、GoodBuddy 管理的 OpenCode 和 Continue；DeepSeek Harness 在设置中明确显示为暂不支持。内置 MCP 仅通过当前请求的短期本机权限提供，Ask / Execute 读写边界不受用户配置放宽。
- [x] **MCP Tools**：显式启用的自定义 MCP 可按 Runtime 分配给直连模型、GoodBuddy 管理的 OpenCode、Continue Agent Execute 和 DeepSeek Harness，并仅在 Execute 加载；Agent 子进程只获得按请求签发的本机回环权限，MCP 地址、命令和凭据保留在 Main，动态工具仍经过发现、执行记录与权限边界。直连模型与 Harness 的健康调用复用当前请求已发现的工具清单，不在每次调用前重复发现。
- [x] **MCP Prompts 与 Resources 元数据**：MCP 测试仅在 Server 声明对应能力时发现有界的 Prompt、参数与 Resource 元数据，不读取 Resource 内容；Runtime 支持的 Prompt 可填入聊天草稿后继续编辑。OpenCode 可报告实验性 Resource 清单，Continue 当前版本明确不支持 Resources。
- [x] **本地知识库**：支持文件、目录和网页导入、SQLite FTS5 检索及来源追溯。知识范围按对话保存，新对话默认不选择知识库；创建与检索高级参数默认折叠。文档区分可用、处理中和失败，支持打开来源、失败重试及移除来源前确认。
- [x] **外部知识库接入**：在知识库页面管理 Dify、FastGPT 和 RAGFlow 实例，通过目录或手工 ID 验证并绑定远端知识库，保留 Provider 专属检索配置和引用；对话支持按需检索及每次回答前检索。外部系统只负责知识检索，不接入其 App、Chat、Workflow 或 Agent，也不批量同步、本地索引或修改远端内容。被回答引用的有界检索片段随会话保存在本机。详见[外部知识库接入 PRD](./docs/features/knowledge-base/external-knowledge-prd.md)。
- **外部知识库验证记录**：三家 Provider 已通过真实服务、本机 HTTP MCP 和生产 IPC 短答案检查，Dify 另通过完整 App 输入区到回答及引用的链路。现有记录未覆盖 FastGPT/RAGFlow 桌面专属参数、复杂多库问答和远程回答前检索，详见[验证记录](./docs/features/knowledge-base/progress.md)。
- [x] **知识图谱**：支持规则、模型和混合抽取，以及实体、关系、别名和证据维护。
  模型抽取不再额外限制为 8192 tokens；OpenAI 使用服务商上限，Anthropic 使用模型连接的输出设置。
- [x] **向量模型配置与检索**：可配置兼容 Embeddings 接口并用于语义检索。
- [x] **向量诊断与索引任务**：提供真实向量生成诊断、按文档重建进度、取消、失败状态与重启后结果恢复；每篇成功文档立即可用于检索。
- [x] **混合检索测试台**：支持全文、中文词组、向量和图谱通道诊断，可调 Top K、阈值、权重、本地或学习型重排及上下文预算。
- [x] **分块、维护与评估**：支持固定、结构化和父子分块，分块维护、可取消重建及双语检索评估。
- [x] **受控知识本体**：每个知识库可定义实体、关系、别名和端点约束，保留证据偏移、置信度和抽取来源，并显式提示图谱重建。
- [x] **强制检索与引用上下文**：对话可按需或每次先检索，显示零结果、降级、失败与取消状态，并可查看引用上下文或安全打开来源。
- [x] **魔法笔记 / Magic Notes**：提供本地优先的笔记与待办工作台、范围管理、编辑、筛选和受控 AI 评论。笔记从自适应卡片总览打开；独立待办页提供搜索、状态筛选、分组列表和直接勾选，宽屏列表稳定在左侧，任务说明、来源记录及 AI 评论在右侧同一区域显示，窄屏按需显示详情并提供返回列表。紧凑页签放在页头新建按钮左侧，筛选放在搜索右侧。打开原笔记再返回可恢复任务上下文；切换任务不会混入上一项的来源内容，读取失败使用应用通知并提供就地重试，来源缺失有明确提示。左侧入口可按设置显示未完成待办数量，创建、保存和评论结果使用统一应用通知。Agent / MCP 写入后，已打开的工作台自动更新，并保留当前选择与未保存草稿。
- [x] **连续记录工作区**：笔记详情连续展示全部记录，左侧索引默认 168px，可拖动右边界或用键盘在 140–320px 内调宽，并记住偏好；索引与右侧 AI 评论独立收起。每条画布记录显示真实首页缩略图、页数和时间，文字记录显示摘要；点击索引只滚动定位，保留当前编辑器和草稿。打开笔记就在标题下方显示空白输入区，保留文字/画布选择和保存操作；新增保存后清空，供下一条记录使用，旧记录通过编辑入口修改。空白输入区和保存后未再修改的记录返回时不提示；保存失败和真实修改仍受保护。窄屏索引使用固定宽度折叠抽屉，不显示调宽分隔条，AI 评论移至底部。
- [x] **分页画布笔记**：已集成 PeopleLib Fabric + Quill 编辑器，支持跨页正文、笔迹、高亮、对象选择及变换、浮动文字、图片和纸张模板。PDF 可作为分页底版导入并提取原生文字；正文和批注可导出为栅格 PDF，导出文件不保留可搜索文字层。用户手动保存后，记录正文与二进制资源存入本地笔记文件，SQLite 保留元数据、索引、修订、待办和评论。备份须协调保存 SQLite 与笔记目录，产品无一键备份入口。撤销/重做限当前批注页或 Quill 模式，不提供全局文档撤销、无限画布或 PNG 下载按钮。草稿、已保存记录和来源为画布的待办按默认模型图像输入能力使用页面图像加文字，或明确标注仅文字降级；“发送画布页数”可选 1～8，默认 1，按当前顺序发送前 N 页，文字和图片范围一致，保存与导出仍支持 50 页。纯视觉记录/草稿需要支持图像输入的模型。即时评论模式提供手动画布分析，保存后自动分析失败不阻断或回滚保存。提取文字不变时保留文字评论；布局变化使视觉评论失效，并在保存后自动评论模式下重新分析。MCP 禁止以纯文字覆写画布记录。实现已完成，最终验证状态见[功能进展](./docs/features/magic-notes/progress.md)。
  编辑与只读画布均支持 25%–300% 视图缩放、100% 还原及随视口调整的“适应宽度”，不改变保存内容或导出尺寸。
  首次升级将历史正文迁移到文件，并随附件变更把数据库升级至 schema 39；旧客户端不能再打开，回退需使用升级前备份。
- [ ] **MCP Server Control Plane**（规划中）：统一 MCP 生命周期、健康检查、重连、Schema 缓存、隔离、审批和审计。
- [ ] **可追溯笔记摘录与 AI 编辑**（规划中）：从对话、知识和网页收集带来源的摘录，并提供需确认的总结、改写和整理操作。

### 工作管理、长期协作与工作流

- [x] **任务、活动与成果**：集中管理任务状态、审计活动和独立成果文件；普通聊天回复只保留在会话中，不再自动复制到成果栏，已有重复聊天 Markdown 从成果列表隐藏但不物理删除。运行记录改由 Main SQLite 保存，不再受旧 Renderer 的 500 条、单详情 4,000 字符或约 2 MB 上限影响，页面按批继续显示；不再常驻旧缓存截断警告，但不会恢复此前已丢失的历史。Token 用量按 Runtime 与模型归类，并针对 OpenAI 兼容与 Anthropic Messages 的不同上报口径归一化展示缓存命中率；活动按会话分组并默认收起，避免长历史占满页面。
- [x] **紧凑会话工具记录**：逐项展开工具记录即可查看和复制结果、错误及输入参数；会话与子任务进度使用简洁行，减少重复 Runtime 摘要。OpenCode、Continue、DeepSeek Harness 和直连模型可显示已有文件路径、命令或搜索摘要，并在工具完成和会话重载后保留。
- [x] **Task 与定制任务体验**：每个产品级 Task 只关联一条 Conversation，一条 Conversation 可承载多个 Task；左侧会话列表通过行首展开按钮显示带共享状态点的 Task 子项，父会话行不重复任务标签，UI 只展示到 Task，不暴露 Job/Run 层级。新建定制任务可关联当前或新 Conversation，默认 Execute 并沿用 Runtime、工具和审批边界；重复触发复用同一 Task，文本结果回写 Conversation，独立文件和图片保留为成果。普通消息与到期 Scheduled Task 共用 Conversation 级持久发送队列，同一会话一次只执行一项；当前回复期间仍可继续发送，队列按顺序续跑，并允许删除或“立即中断并插入”。Task Center 继续作为完整索引，不建设独立 Automation Center。当前计划触发支持单次、每日和每周；高级时区、Cron、事件触发与重试治理仍按 PRD 逐步实现。详见 [Task Center PRD](./docs/features/task-and-job/task-center-prd.md) 和 [Scheduled Task PRD](./docs/features/task-and-job/scheduled-task-prd.md)。
- [x] **记忆与智能心跳**：当前提供周期回顾、建议记忆、洞察、后续任务和可审计运行轨迹。
- [x] **定时消息沿用会话**：定时消息使用会话当前历史、Runtime、工作模式和已保存的知识检索设置；任务详情显示实际运行模式，当前 occurrence 未结束时禁止重复“立即运行”。
  任务中心通过状态数量和筛选定位运行中及待处理任务，审批操作保留在对应任务卡片中。
- [x] **智能心跳入口与范围改善**：将“智能心跳 > 心跳计划”作为完整配置的唯一权威入口，支持创建和编辑 Global 或指定一个、多个 Project 的计划；旧单项目配置无损迁移，项目级记忆与行动输出必须显式指定范围内的 Project。Task Center 和设置不再复制心跳表单；按分区回顾、候选生成和唤起条件仍待设计。详见 [智能心跳 PRD](./docs/features/smart-heartbeat/prd.md)。
- [ ] **通用监督**（规划中）：通过固定监督栏目观察用户选择的会话、任务、自动化或实验对象，提供带证据的评论与人工介入请求，但不自动发言、批准工具或切换 Execute。详见 [会话监督 PRD](./docs/features/conversation-supervision/prd.md)。
- [ ] **批量运行与对比实验室**（规划中）：对模型、Prompt、角色和工作流配置执行批量对比，汇总质量、耗时、Token、费用、失败率和成果差异。
- [ ] **时态记忆与事实冲突检测**（规划中）：为记忆和知识图谱增加有效期、当前事实、过期与矛盾检测、事实核验及证据回溯。
- [ ] **可视化受控工作流**（规划中）：提供版本化 DAG、条件分支、审批、取消和恢复，执行节点继续经过 Main Runtime 边界。
- [ ] **统一 Run Graph 与回放**（规划中）：关联任务、Subagent、模型、知识、工具审批、用量和成果，支持失败定位、重试和脱敏导出。

### 浏览器、通信、语音与应用维护

- [x] **Runtime 共享内置浏览器**：使用 GoodBuddy 内置的隔离 Chromium，不控制客户端已安装的浏览器；用户通过内置 MCP 总开关和 Runtime 分配决定是否提供给 Execute，开启后不逐次询问。关闭 Agent 浏览器能力不影响用户继续在浏览器工作栏中手动前往、返回、刷新、停止加载、交互或关闭浏览器。直连模型、GoodBuddy 管理的 OpenCode 和 Continue 通过请求级权限共享按 Conversation 归属的会话和串行操作路径，用户导航会改变 Agent 下一步看到的页面。
- [x] **浏览器多页签与按需资源**：同一对话可打开多个共享登录状态、页面与导航独立的浏览器页签，模型请求固定使用开始时绑定的目标。未使用的请求预留不创建浏览器资源，已释放页面可重新打开；保留显式截图，普通操作不再触发无用的自动截图。
- [x] **浏览器关闭与刷新**：AI 使用中的页签也可关闭，不取消整个请求；后续显式导航会创建独立替代页。空白页不能刷新，切换或关闭面板后清除旧操作错误。
- [x] **客户端电脑控制工具**：与内置浏览器分开管理，并保留范围、取消、超时、输出边界和执行记录。
- [x] **远程消息通道项目**：微信 ClawBot、企业微信和钉钉分别拥有系统管理的项目、独立远程会话、工作目录、处理后端、默认 Ask/Execute 模式及任务活动归属；完整回复交由各通道按平台能力控制长度与分段，不再由公共服务统一截断。
- [x] **微信 ClawBot 扫码与媒体**：通过独立 Sidecar 完成本机扫码、验证码、加密凭据和文字收发；支持个人微信私聊图片与文件，单条消息最多 4 个附件、解密后合计不超过 12MB。
- [x] **微信安全回传**：支持返回当前任务生成的图片，或在用户明确要求时将本次最终文本生成为 Markdown 附件；不自动读取或发送已有工作区文件。
- [x] **企业微信与钉钉连接**：支持 Main-only 加密设置、环境变量只读覆盖、连接测试、动态启停、发送者范围和状态诊断。
- [x] **受管本地模型下载源**：在“平台功能 / 通用设置”中为后续语音输入与 OCR 模型下载全局选择 ModelScope（默认）或 Hugging Face；所选来源缺少完整已验证文件时明确不可用，不静默换源或混合文件。
- [x] **可选本地语音模型管理**：应用不内置模型权重；提供校验下载、进度与取消、来源链接、ZIP 或本地目录导入、切换和删除。
- [x] **本地录音与离线转写**：采集麦克风音频并使用已选择的本地模型离线转写，支持停止、取消、状态反馈和资源释放。
- [x] **版本检查与镜像节点**：在“关于与更新”中选择 GitHub（默认）或镜像节点；手动检查、启动时检查和下载页使用同一选择，并只读取固定可信的发布索引，不自动下载或安装。
- [x] **窗口恢复入口**：渲染失败时显示本地化的重新加载页面，渲染进程崩溃时提供原生恢复确认；重新加载可能丢失未保存输入。详见[窗口恢复说明](./docs/development/window-recovery.md)。
- [x] **应用内反馈**：在“关于与更新”中直接提交问题、建议或体验反馈，支持可选邮箱和单张截图；默认不上传诊断，用户可主动附加有界的最近桌面诊断摘要。失败后保留草稿、诊断选择和同一请求编号；不会附加对话、Prompt、凭据、文件内容、路径、Provider 原始响应或远端 Agent 日志。
- [x] **内网兼容**：允许应用内 HTTP 与无效、自签名或过期的 HTTPS 证书；反馈、微信凭据与媒体等固定平台服务仍保持严格证书校验。

### 开源、构建与发布

- 当前源码候选为 Desktop `0.13.9`、Agent `0.13.2`，OpenCode 固定为 `1.18.29`、Continue 为 `1.5.47`；正式发布状态以独立发布渠道为准。
- Desktop `0.13.9` 修复已有文件格式笔记时，正常写入后重启仍重复进入迁移的问题。Agent 与存储格式均不变；候选仍需主分支 CI 和原生发布打包，本次不构建 LoongArch 预览。
- Agent `0.13.2` 同时携带 OpenCode 和 Continue，并交付原生执行清单；复合包要求 Desktop `0.13.8`，请先升级 Desktop，再更新 Host 环境。Node 保持 `24.19.0`。
- 验证记录与功能状态分开。存储已有本地及 Linux x64 Host 真实工具任务、多项目多会话、取消和无损迁移验证；进程复用有 Windows 完整 App 与 Linux x64 Host 证据，PPTX OCR 与空闲内存释放有 Windows 真实文件证据。图片工具已有真实服务商生成/编辑及 Host 传输证据，这些记录未覆盖完整界面自然语言调用和本地/远程切换。候选仍需主分支 CI 及原生发布打包，详见[Runtime 验证记录](./docs/features/assistant-workbar/progress.md)与[图片工具验证记录](./docs/features/conversation-media-generation/progress.md)。
- 发布准备前，`9836a4c` 已通过本地 4,858 项测试（67 项跳过）、完整类型检查和 lint；真实服务商画布分析仍未验证。该提交的三个原生 Agent CI 构建通过；桌面 CI `35485936807` 为 4,875 项通过、8 项 Electron 测试失败，均因 Linux 沙箱辅助程序未配置，在页面断言前退出。候选配置该程序并在 Xvfb 下运行测试，不关闭沙箱；候选本地验证、主分支 CI 与原生标签打包分别记录，不在发布准备中运行本地生产构建或打包。
- [x] **0BSD 开源许可**：原创代码可自由使用、复制、修改、分发和商用；第三方组件和资源仍遵循各自许可证。
- [x] **可复现依赖安装与源码构建**：使用锁定依赖、Node.js 24 和统一的测试、类型检查、Lint、生产构建命令。
- [x] **六平台原生发布矩阵**：Windows、macOS、Linux 的 `x64`、`arm64` 目标由原生 Runner 构建，并提供发布清单和 SHA-256 哈希。Windows 提供 NSIS 与 portable ZIP，macOS 仅 DMG，Linux 提供 AppImage、DEB 和 RPM，共 12 个安装包、20 个发布资产。
- [x] **桌面 Runtime 包校验**：OpenCode 离线依赖复制避开 electron-builder 对源根目录 node_modules 的排除，DSH 会话投影组件打入解包后的 Host。最终包逐文件核对离线依赖并拒绝外部 DeepSeek 导入；Windows x64 CI 还会导入包内 OpenCode 插件、验证真实 DSH UtilityProcess 握手，通过后才发布。
- [x] **DMG-only 更新清单**：当前 Desktop 和官网读取器同时接受仅 DMG 与历史 DMG/ZIP 清单。旧版 macOS 的 GitHub 更新检查及所有旧版镜像更新检查需要从下载页手动升级。

### 开放接口、团队协作与远程执行

- [x] **远程 Continue 交付**：已接入 CN 1.5.47 受管包、Agent HTTP-to-ACP 适配、模型路由、项目选择和原生清单。默认包同时携带 OC/CN；Windows 桌面到 Linux x64 已通过安装、真实模型清单更新、长清单、取消及重启恢复验证。Execute 会话 MCP 已通过真实文本模型 Host 往返，图片服务使用替代接收端，不代表真实生图验证。候选 Agent `0.13.2` 需要 Desktop `0.13.8`；正式发布及原生平台验收与 Linux 开发证据分开，详见[验证记录](./docs/features/remote-host/runtime-checklist-validation.md)。

- [x] **远程任务委派**：仅在用户显式配置端点和令牌后启用，按全局内网兼容模式使用 HTTP(S)，结果进入持久化发件箱。
- [ ] **Headless Runtime API**（规划中）：提供本机优先的任务、事件、状态和成果 API，以及有范围、有效期、限流和撤销能力的令牌。
- [ ] **GoodBuddy Team Hub**（规划中）：以可选服务提供组织、RBAC、项目共享、远程 Agent、策略下发和租户审计。
- **SSH 主机与远程执行空间验证记录**：主机 CRUD、Host Key、加密凭据、Project UI、Workspace、OpenCode ACP v5、Agent-owned Prompt/gateway/transcript、Ask 只读、Execute 完整账号权限、取消、detached Agent 精确重连和 release-only 双架构资源校验已经接线。Linux x64 当前源码已用真实模型与工具通过 detach、进程结束、relay 丢失、并发、取消、Provider 异常、Agent 重启和 Desktop SQLite 恢复矩阵；当前源码测试签名 Agent `0.11.17` 又通过两个并发 Ask 读取、一次 Execute 写入并读回，以及 6 次带自定义 Header 和 Body 的真实受管网关模型请求，未发现 Provider 请求重放，隔离 Agent state 中也没有 API Key 或自定义请求值。公开 signing key registry 已供应。控制面直连源码不等待新 installer-bearing 包；现有记录未覆盖当前 Linux x64/arm64 正式签名工件的完整公开核对及 GitHub/北京镜像、双架构和离线 GoodBuddy 传输矩阵，发布结果另行记录。
- [ ] **多云远程沙盒 Agent**（规划中）：通过云厂商 API 和 SSH Agent 管理专用 Linux 沙盒；凭据留在 Main 进程，高风险控制面操作单独确认。

## 规划原则

规划中的工作流、Subagent、MCP、远程 API 和沙盒能力不得绕过现有 Main Runtime、Ask/Execute、权限、取消、超时和审计边界。
