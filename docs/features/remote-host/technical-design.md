# SSH 远程主机与 GoodBuddy Agent 实现说明

## 状态

本文记录截至 2026-09-10 的当前代码实现，不定义额外的信任框架。“新增 Host 只探测、Host 卡片手动准备
Agent/Runtime、Host 直接从 GitHub/北京镜像下载、项目始终使用 Host current 环境”已经完成源码接线，
详细事务与验收边界见
[SSH Host 远程环境准备与直连下载设计](./environment-provisioning-technical-design.md)；
控制面直连源码可直接使用既有 package format v1 包，不等待携带 installer 的新 Agent
包，也不通过额外目录元数据判断 bootstrap 能力；公开能力仍等待 GitHub/北京镜像、
Linux x64/arm64、取消和离线 GoodBuddy 传输的真实 Host 验收。
Windows 到 Linux x64 的安装、Agent-owned Prompt、Agent 本地模型 gateway、断线恢复、
同一 OpenCode Session 续接、取消和终态清理已经使用真实模型与工具验证。Agent
`0.11.14` 已通过独立 workflow 发布 Linux x64/arm64 复合包和签名累计目录；当前源码
候选为 Agent `0.11.23`、Desktop `0.12.11`，新增远程文件/Git 管理接口和可选模型限额，
并修复无限请求时长下的连接超时。Agent `0.11.23` 要求先升级至 Desktop `0.12.11`；
新包内的 Runtime 不再设置固定十分钟 Prompt 时限，显式请求期限与取消仍有效。
正式发布状态以 Agent 与 Desktop 独立发布渠道为准。
现有源码显示本地与远端 OpenCode 原生 Task，并取消 GoodBuddy 对生产 Prompt 的
固定墙钟总时限。失败的 `agent-v0.11.3` 保持不可变且未发布。

## 产品语义

远程 Host 与项目能力是默认关闭的技术预览。用户在“设置 > 平台功能”的独立
“远程项目（技术预览）”页签启用开关后，Renderer 才显示 SSH Host 管理、托管 SSH 项目创建和已保存
远程项目；Main 在 IPC 边界执行同一开关校验，避免隐藏界面被绕过。关闭开关不删除 Host、
项目或凭据；当前远程项目切回第一个普通本地项目。应用启动仍固定
选择普通本地项目，不会因为保存了远程项目而自动连接 Host。

远程项目只有两种工作模式：

- **Ask**：Runtime 在操作系统边界以只读方式访问项目 Workspace。
- **Execute**：用户已授权使用所选 SSH 账号的完整权限。Runtime 可以使用该账号可访问的文件、进程、网络和工具，不再要求额外 trust tier、consent checklist、逐工具审批或“受控执行”授权。

Execute 不获得 root 或 SSH 账号本身没有的权限。托管 SSH Prompt 会把当前选中的文本模型
profile 和凭据作为有界、逐 Prompt 的控制消息交给 Agent；该凭据不进入命令参数、环境变量、
语义日志或模型调用账本，并在 Prompt 终态清除。此行为只适用于用户已明确启用的可信组织
网络和已认证 SSH Host。

## 组件

```text
Renderer
  -> 窄 Preload / Main IPC
Main
  -> SSH Host 与 Host Key 管理
  -> SSH connection pool
  -> 签名 Agent / Runtime 安装
  -> 远程项目当前环境准备与稳定配置 SQLite 事务
  -> 永久项目、对话、Task 与已同步事件 SQLite
SSH attach
  -> 远端私有 Unix socket
Detached GoodBuddy Agent
  -> Workspace / Git 协议
  -> Agent-owned OpenCode ACP Prompt Promise
  -> Prompt-scoped Provider gateway / model-call ledger
  -> 有界语义 transcript / page / ACK
  -> 有界私有诊断记录
  -> 直接拥有的 Runtime 进程
```

不提供把远端路径交给本机 Runtime 的伪本地模式，也不提供 SSH stdio Runtime fallback。

## SSH Host

- Renderer 只管理脱敏 Host 快照，不接触密码、密文、SSH Client 或任意命令接口。
- Main 在认证前取得 Host Key，展示算法与 SHA-256 指纹，并保存完整 key blob。
- 首次连接需要用户确认。Host Key 变化展示旧/新值并要求显式替换。
- 密码使用 Electron `safeStorage`；系统 SSH Agent 认证不启用 Agent forwarding。
- Host 地址、用户或 Host Key generation 变化时关闭旧连接，并定向退役依赖旧 Host identity 的 Workspace 和 Runtime 会话。下一次选择使用 Host 管理的当前连接记录解析 current Agent/Runtime，不读取项目中的旧 revision 或组件 identity；当前 registry、连接或 capability 无效时才要求显式修复。

## Agent 安装与生命周期
- 托管 OpenCode 的直接 ACP profile 与模型桥最终配置都设置 `snapshot: false`，避免
  GoodBuddy 不使用的自动 Git 快照摘要阻塞原生执行；策略和保留的文件、Git、子代理能力
  见 [Runtime 并行与输出边界](../assistant-workbar/runtime-interactions.md#托管-runtime-的并行与输出)。
  此设置随新启动的 Agent Runtime 生效，不改写用户仓库或已运行进程的配置。

- Agent bundle 通过 manifest、Ed25519 签名、payload digest、平台和架构校验。
- 外层 `agent-package.json` 描述符上限为 4 MiB，覆盖包含 OpenCode 离线依赖的实际包
  （2026-09-08 Linux x64 验证包为 1,101,863 字节）。Desktop 解包、Host prepare/commit
  与目录生成器使用相同上限；其余元数据仍为 1 MiB，签名、文件数量、归档大小和完整性校验不变。
- Runtime 组包使用的 OpenCode 离线依赖缓存按插件版本复用，安装与替换规则见 [Runtime 资源](../../../BUILD.md#runtime-资源)。复制进 Runtime 包的依赖仍属于签名 manifest 的 payload。
- 安装使用当前 SSH 用户目录中的 GoodBuddy-owned 路径和 side-by-side digest 目录。
- Agent 代码与固定 Node Runtime 一起位于签名 compound payload。显式安装或重装从本次
  已完整校验的准备目录原子发布整个 Agent，不扫描旧安装、不创建跨版本 Node 硬链接；
  Agent 不匹配不会阻止升级，也不会覆盖 GoodBuddy-owned 路径以外的内容。
- 桌面包只携带版本 lock 与 production 公钥，不携带远端 payload。Host 卡片只有一个按
  版本事实显示“安装远程环境”“更新远程环境”或“重新安装”的主按钮；次级
  SegmentedControl 选择“自动”“Host 下载”或“GoodBuddy 传输”，默认“自动”且不持久化。
  每个复合包绑定 Agent、固定 Node 与桌面维护的 OpenCode Runtime 精确工件。添加或重新
  验证 Host 只保存并探测，不自动传输完整包。
- Host 管理独占 Agent/Runtime 的包准备、更新和完整 payload 验证。已有项目的打开和切换
  只更新本地项目选择。Workspace 和执行路径按需读取 Host current registry，
  执行固定 `attach-or-bootstrap` 并复用当前 Agent 连接；同一进程内复用已确认 identity。
  它们不取得安装包、不发布组件，也不通过 SFTP 重读或哈希 payload；已登记 Runtime
  的能力读取和 Prompt 启动只核对 registry 与 manifest 元数据，不再次执行、读取或检查
  OpenCode 二进制。
- Agent 的固定 attach/按需启动命令只读取 Host 管理已提交的 installation registry 和
  与其 digest 匹配的有界 manifest 元数据，不在每次项目切换时重新验签或哈希完整 payload。
  完整验签、payload 扫描和 registry 写入仍只发生在显式 Host 准备/更新流程。
- 项目切换不执行远程核对，立即选择本地项目配置。Workspace 或 Runtime 首次实际使用时
  才通过当前 Agent 连接核对所需能力；失败只影响该操作。新建或显式保存项目仍执行完整
  准备，并只事务写入 Host、路径、Runtime 选择和工作模式。
- SSH 连接先尝试 attach；Agent 不存在或未运行时执行幂等 bootstrap，然后重新 attach。
- Agent 是按需启动的 detached process，不注册开机服务，不依赖 systemd、D-Bus 或 Linger。
- 每个模型桥 helper 都为 loopback HTTP 入口生成一次性随机路径 capability；只有写入当前 OpenCode 子进程配置的 URL 可以访问该入口，其他本机用户即使发现临时端口也不能提交模型请求。
- Agent 监听当前用户拥有的私有 Unix socket。SSH 中断只关闭 relay，不拥有 Agent 和活动 Runtime 的生命周期。
- 私有握手的 HMAC 响应按固定 32 字节的规范 Base64URL 校验，不套用要求字母数字开头
  的应用 ID 规则；health nonce 使用固定前缀。读取握手时，流结束或关闭都立即失败，
  不留下未结算 Promise；Host Key、同 UID 校验和 HMAC 验证保持不变。
- SSH Host 设置通过固定探针和有界 SFTP 显示 Host 已登记的 Agent/OpenCode 版本，并与当前
  GoodBuddy 所需版本比较。进入或切回该设置页只读取本地 Host 列表，不连接任何 Host；
  用户点击“刷新版本”后才探测对应 Host，探测不安装或切换远端组件。项目切换与此按钮
  解耦且不建立连接；实际远程操作才建立或复用 SSH/Agent 连接。
- “平台功能 > 远程项目”中的本地 Agent 包清单与 Host 状态分离。Main 对用户数据目录中
  Linux x64/arm64 `.gbagent` 分别执行外层可信签名、桌面/协议兼容性、内部 Agent/Runtime
  签名、架构与完整 payload 校验；首次打开和手动刷新还会读取“关于与更新”所选来源的
  小型签名目录。Renderer 只得到本地/在线版本、是否有更新、架构、远端 Runtime 版本、
  协议和本地状态，不得到缓存路径、key ID 或 digest。目录检查不下载 `.gbagent`，在线
  包下载只由用户点击带目标版本的操作触发；离线导入/导出通过 Main 管理的文件对话框完成。
- GitHub 来源按每页 10 条读取 Release 元数据，最多检查原有的 100 条历史发布，
  找到首个有效 Agent 目录及签名地址后立即停止。每次响应仍保留 1 MiB 上限，
  避免一次读取全部历史正文和资产详情导致目录检查失败；签名、URL 与包校验不变。
  2026-09-06 使用当前 Main 目录读取实现验证公开 GitHub 与北京镜像，两者均可读取
  Agent `0.11.19` 的 Linux x64、Linux arm64 和 macOS arm64 条目，未下载或安装包。
- “自动”只在 operation/prepare 前用 Host capability probe 选择 acquisition：直连明确
  可用才选 Host 下载，否则选 GoodBuddy 传输；显式选择不被改写。prepare、commit 或
  adoption 失败后都不跨 acquisition 自动 fallback。
- Host 下载由桌面控制面通过固定 SSH prepare channel 和结构化 stdin 发送候选信息，
  Host 取得 compound `.gbagent` 并核对大小与 SHA-256。显式 GoodBuddy 传输在在线目录
  不可用，或本地已验证包版本不低于在线候选时优先租用本地包，包括更高版本离线导入；
  线上存在更新且可用时仍取得线上新包。需要下载时，同一次操作会验 SHA-256 与签名、
  缓存并取得 lease，再以有界流式 SFTP 上传一个 compound archive 和归档中已验证的
  bootstrap Node；约 294 MiB 完整包不会一次读入 Main `Buffer`，Host 仍再次校验完整包。
- 两种 acquisition 交付到固定 operation staging 后，完全共用 control-plane
  `prepare → commit → Agent activate/health → Runtime activate → finalize → cleanup`。
  Main 只保存清理 operation staging 所需的 operation ID。中断或 adoption 失败后，下次
  更新尽力清理旧暂存并重新 prepare，不保存或恢复 Agent/Runtime metadata 副本。确认
  adoption 后才显式 cleanup；cleanup 失败不回滚健康环境，也不阻塞下一次 fresh prepare。
  Host 在 prepare 解包时
  完成一次完整 payload 校验，commit 和后续注册检查不再遍历包体。首次 bootstrap 不依赖
  既有 Agent daemon，也不要求 format v1 归档携带 `agent/lib/package-installer.cjs`。
- 即使版本号均为当前版本，Host 卡片仍提供同版本“重新安装”，用于修复 registry、签名
  或安装 identity 异常。GoodBuddy-owned 同 digest 目录损坏时先隔离后替换，并在发布或
  原子 commit 失败时恢复；commit 成功后的激活失败保留新发布内容，下次点击重新安装时
  清理旧暂存并重新 prepare/adopt。不要求删除 Host、凭据或引用项目。
- Host 卡片的“版本匹配”badge 只表达版本事实，不代表 Agent 正在运行或环境健康。重新安装
  失败时明确显示本次操作未完成，并以随后重新检查的版本卡片表达当前事实；提交结果
  不确定时不声称旧版本未被替换。
- 更新成功后才定向清理该 Host 的 Agent 连接和 Runtime 选择缓存。引用项目再次打开时
  解析新的 current registry 并建立当前连接，无需刷新项目记录；当前环境无效时要求用户
  显式修复，但不在项目切换中下载或安装。失败或取消保留 Host 配置、凭据、项目、
  Workspace 和旧组件。
- 显式 stop、升级、身份冲突或进程退出时清理 GoodBuddy 自己的 socket、状态和子进程；不得删除或覆盖无关 Host 文件。

### Host 级环境生命周期

- Agent、Node 和 Runtime 是 Host/SSH 账号级共享环境。新增或重新验证 Host 后先保存 Host
  并只读探测，不自动安装；用户随后在 Host 卡片明确选择安装或更新方式，失败保留 Host
  并允许重试。
- Host 可以按签名目录固定的 URL、大小和 SHA-256 直接从当前 GitHub/北京镜像来源下载
  完整 `.gbagent`，也可使用 GoodBuddy 本机下载、流式 SFTP 传输和离线导入。自动模式只在
  操作开始时择一；执行失败不会在同一次操作中切换 acquisition。
- 项目只保存 Host ID、远端路径、Runtime 选择和默认模式。创建或保存时验证 Host current
  环境；打开或切换只读取本地配置。Workspace/Runtime 实际使用时从 Host current registry
  和当前 Agent 连接取得 live identity，不再扫描、下载、上传或发布 Agent/Runtime。完整
  事务、兼容边界和验收要求以
  [Host 环境准备设计](./environment-provisioning-technical-design.md) 为准。
- 打开新建/项目设置弹窗只读取本地 Host 验证记录，不并发检查所有 Host；目录浏览或保存
  才连接所选 Host。
- 项目选择器中的管理操作默认浮动隐藏，在悬停、键盘焦点或触屏环境显示。管理任意已保存
  项目不先激活项目，因此 Host 不可达或远端目录已不存在时仍可删除其本地记录。
- “远程项目”在选择器中按已保存 SSH Host 轻量分组。Host 标题显示 Main 已持有的真实
  Agent 连接状态（未连接、连接中、就绪或异常），读取和展示状态本身不连接 Host；
  项目副标题只显示远端路径，不重复“托管 SSH”类型。
- 删除 Host 时确认框列出所有引用它的本地项目记录，包括归档项目。确认后只删除本机
  Host、凭据、项目及其关联记录，不连接 Host、不删除远端目录或内容；Host 设置写入或
  项目事务失败时恢复另一侧，避免只删掉其中一类本地记录。

## Workspace

Main 传入已规范化的绝对 POSIX root。Agent 返回 Workspace identity、访问模式、Git 状态和有界能力。

- 创建项目时，用户可以直接输入远端工作目录，或通过输入框右侧的文件夹按钮浏览并选择目录。
- 项目保存前的目录浏览使用 Main 管理的只读、有界 SFTP，只返回目录；每次请求重新解析并校验当前 Host revision 与 Host Key generation，不安装 Agent、不暴露任意 shell/SFTP 接口。
- 浏览从 SSH 账号 Home 或当前有效绝对路径开始，限制扫描次数、返回条目和总时限；取消、Host 变化、超时或连接失败时关闭 SFTP 并保留用户原先输入。
- 选择目录只更新项目草稿，仍需通过正常的 Agent、Workspace、Runtime 验证和项目保存事务才会持久化。
- Ask Workspace handle 不暴露写入方法。
- Execute Workspace handle 可读写，但这不是 Execute 的唯一权限面；Execute Runtime 本身使用 SSH 账号的正常权限。
- 文件预览按有界页面传输并保持 UTF-8 字符边界；超过单页大小时先返回当前页，用户可继续加载，不把单页传输上限误作文件总预览上限。搜索、Git diff、目录项和显式文件传输继续保持各自的字节、条目数和路径长度上限。

## Runtime

首个远程 Runtime 固定为签名 OpenCode ACP bundle。
托管 SSH 项目的 Composer Runtime 菜单只显示当前配置的 OpenCode 和管理入口，不显示
直连模型、Continue 或 DeepSeek Harness。激活旧远程会话时，若其保存了其他 Runtime
selection，Renderer 会恢复为当前 OpenCode 配置；Main 的远程请求校验仍是最终边界。
本机配置的 SKILL 包和 stdio MCP Server 不上传或分配给远程 Runtime；远程 ACP Session
继续使用空 MCP Server 列表。Node.js、Python 等工具执行环境同样不修改或同步到 Host，
完整边界见[工具执行环境](../local-tool-environment/README.md)。

### Ask

Ask 与 Execute 一样直接启动已签名 Runtime，不要求 Host 安装额外的进程隔离命令：

- `cwd` 为项目 Workspace，并继承 SSH 账号的正常环境；
- ACP 权限请求只有在工具种类为原生 `read` 且 Runtime 提供 `allow_once` 选项时才允许；
  search、edit、execute、未知工具以及只提供持久授权的请求全部拒绝。
- Ask 启动时同时注入 OpenCode 顶层和 build Agent 的 `permission: "ask"`；Agent
  工具权限分发边界只批准上述原生读取请求。该双重边界不另加文件系统 confinement，
  也不改变 Runtime 的直接启动方式。
- Execute 的直接启动与模型桥启动均显式设置顶层和 build Agent 的 `permission: "allow"`，
  避免继承 OpenCode 默认的 `external_directory` 询问；项目目录只是默认工作目录。
  原生子代理同样使用当前 SSH 账号可访问的路径。仍出现的 ACP 权限请求由 Agent 按
  当前 Prompt 模式自动答复，不增加 Desktop 人工审批，也不依赖日志解析。

### Execute

Execute 直接启动已签名 Runtime：

- 直接启动已签名 Runtime entrypoint；
- 使用 Agent 本地模型 gateway 时，签名 Agent launcher 会 `exec` 候选 manifest 锁定的
  Node Runtime；进程 owner 校验最终 Node executable，而不是已经被替换的 shell
  launcher 路径；
- `cwd` 为项目 Workspace；
- 继承 SSH 账号的正常环境、文件系统、进程和网络能力；
- 不注入 OpenCode Ask 权限配置；
- 不进行 T2/T3、confinement attestation、approval bridge 或逐工具批准。

两种模式都保留输入字节上限、用户取消和进程组清理；输出只用有界内存队列与 journal
配合背压，不按 Prompt 累计输出量停止 Runtime。生产 Prompt 不设置固定墙钟总时限；
只要 Runtime 尚未按自身协议结束，Main 和 Agent 就允许其持续运行。启动、握手、单个
控制 RPC、重连尝试和关闭清理仍使用独立的有界超时，测试可以显式注入短 Prompt 时限
验证取消升级，但该覆盖值不是生产默认。无界 Prompt 继续复用已发布的必填
`deadlineAt` 字段，以 year-9999 哨兵表达；Main 与 Agent 必须同时理解该哨兵，Agent
`0.11.10` 及更早版本仍会按其 manifest 上限夹紧，因此桌面启用这一语义前必须配套更新
到 Agent `0.11.13` 或更高版本。

## ACP 与断线

- 管控面只负责有界 JSON-RPC：连接、查询、启动、取消、关闭和重连。数据面只负责
  ACP/blob 数据与 Agent 本机 journal。二者共享同一个经过 Host Key 校验和认证的
  SSH attach 字节流，但不共享生命周期：管控连接关闭不会隐式取消 Agent 已接受的
  Runtime 动作。
- 帧只保留连接 identity、channel identity、单调 sequence、类型和长度。Main 与
  Agent 都按调用顺序 FIFO 写入，输入队列达到固定字节或条目上限时暂停 SSH stream。
  顺序、可靠传输、分包和网络背压全部交给 SSH；协议不实现 credit/window、优先级
  调度、跨 channel 超车、批发送或第二套拥塞控制。
- Agent 在把 Main 输入交给 Runtime 前、以及把 Runtime 输出交给 Main 前，先把 ACP frame 写入本机 journal。ACK 只推进 cursor 并裁剪已确认 frame，不表示 channel 已终止。
- Main 持久化 binding identity 和单调 cursor；保留中的 connection lease 即使处于 offline/reconnecting，也可以先把新 cursor 落盘。重连提交不能覆盖 resume 过程中并发落盘的更新。
- Runtime 事件仍对协议定义的单项传输字段应用既有边界，但不按固定工具调用数或 Desktop
  累计展示量中止 Prompt；待消费事件达到阈值时通过 ACP 入站暂停施加背压，不取消原生
  Runtime。Main 和 Renderer 不再按 500 条工具/子 Agent 活动或 2,000 个交错展示块丢弃
  对话详情；独立运行记录也改由 Main SQLite 完整保存并按批渲染。旧版已经触发本地上限的
  历史继续显示可能不完整的提示，不能通过迁移隐藏既有数据缺口。
- OpenCode 原生 Task 工具按 `subagent_type`、`description`、`prompt` 和稳定 tool call ID
  解析为子 Agent 事件。本地 OpenCode SDK 与远端 ACP 增量工具事件复用同一转换；ACP
  首帧缺少参数时可以先显示普通工具活动，后续参数确认其为 Task 后必须替换为子 Agent
  状态卡，并持久化任务说明、终态与输出。卡片展开后分为“执行过程”和“最终结果”：
  正文、折叠思考与可展开工具记录按收到的顺序显示，工具状态原位更新；完成后仅在最终
  结果区显示与末尾正文完全相同的返回结果，避免重复。失败或取消保留已有过程，未终结
  工具不再显示进行中。
- 本地 SDK 通过 Task `metadata.sessionId` 关联子会话，复用稳定消息块 ID 保存过程。
  固定 OpenCode 1.18.29 的 ACP 不转发子会话，因此 Agent 的模型桥 helper 在受管临时目录
  写入事件插件，并通过既有 ACP `session/update` 的 `_meta.goodbuddySubagentEvent`
  转发到所属 Task；不新增端口，不修改签名 Runtime 包。插件文件随 helper 退出清理，
  事件继续经过既有 Agent transcript、ACK 和 Desktop 消息持久化路径。
- ACP 工具结果同时支持文本 `content` 和 `rawOutput.output`，移除 OpenCode 的
  `<task><task_result>` 外层包装后渲染正文。恢复已有子代理时使用 ACP 所带的所属
  `toolCallId` 继续路由，不等待新的父 Task metadata，也不重放模型请求。
  远端实时过程需要包含该插件的 Agent；旧 Agent 的最终结果仍可查看，历史未采集过程
  不会被补造。
- 本机 OpenCode SDK 路径允许不同会话并行，同一会话仍按请求顺序执行。每个请求独立拥有
  SSE 事件订阅，并在正常完成、错误、取消或消费方结束迭代时主动关闭自己的响应流，
  不关闭其他会话的订阅或共享 Server。取消导致事件迭代结束时保留原取消原因，不改报
  “事件流意外结束”。这一清理规则属于本机 SDK 路径，不改变远端 Agent 持有 ACP Prompt
  的断线继续执行语义。
- 同一 detached Agent 存活时，短暂 SSH 断线依次执行 `controller/resume`、`runtime/resumeAcpChannel` 和 `runtime/replayAcpChannel`，从 Main 已确认的 cursor 后只重放 Agent 到 Main 的已记录输出。重复 frame 会被确认但不会再次交给上层。若上一代连接只留下没有活动请求的 detached binding，完成精确 controller takeover 后会先有界停止并核对遗留 Runtime process，再用新 channel epoch 重新打开同一 binding 并恢复已有 ACP session；其他 controller、未证明 takeover 或仍有活动请求的 binding 仍被拒绝。
- Main 到 Runtime 的 ACP 输入、模型请求、工具请求和 blob 不自动重放。
- 无法确认外部 Provider 是否已处理的模型调用保持结果未知，避免重复计费或重复副作用。
- 只有远端返回 identity 匹配且 `closed: true` 时，Main 才删除持久化 binding；传输失败或未确认 close 会保留 recovery identity。
- 终态 close 由 Agent 在一个事务中为两个方向记录 sequence high-water tombstone，删除剩余 frame 和 active channel，并归零对应 journal quota。tombstone 用于拒绝迟到的旧 epoch frame，因此当前不会按时间自动裁剪。
- 断线不主动终止正在运行的 Runtime。用户取消、显式关闭或 Agent shutdown 才触发停止；
  输出队列和 journal 达到容量时暂停读取并等待 ACK 释放容量，不把展示或传输容量转换为
  Runtime 取消。连接恢复只受当前用户取消信号和单次重连控制超时约束，不把 Prompt 已运行
  时长当作停止条件。
- Agent 失联期间继续把 Runtime 输出写入本机 journal；重新连接只校验 controller
  identity、恢复 binding，并从 Main 最后确认的 cursor 后同步缺失数据。已接受的
  指令和结果不确定的 Provider 请求都不自动重放。

### Agent-owned Prompt 与 Desktop 恢复

- 托管 SSH 的生产 Prompt 从一开始就由 Agent 持有 ACP `ClientSideConnection`、原始
  Prompt Promise、Provider 轮次和 Runtime 进程。SSH relay 或 Desktop 进程不属于该
  Promise 的生命周期，因此正常退出、强制结束 Desktop 或本机网络中断后，Host 仍能继续
  后续模型/工具轮次。该路径现在要求 `runtime/acp` capability v5；v5 同时保证 Agent
  能理解 Prompt-scoped 模型连接的自定义 Header/Body，旧 v4 Agent 由现有受管更新流程
  升级后再运行。
- Agent 把 ACP session update、permission decision 和唯一 Prompt 终态写入有界语义
  transcript。Main 不恢复旧 JSON-RPC Promise，也不重发 `session/prompt`；Fresh Desktop
  只对同一 controller/binding/operation 执行 takeover、attach 和 ACK-exclusive page。
- 每个 Agent 语义 sequence 在 Main 映射为零到多个公开事件，最后追加内部 checkpoint。
  Desktop 在同一 SQLite 事务中去重 provenance、归并原 assistant message，并在 checkpoint
  时提交 Task 终态；事务成功后生成器才继续并向 Agent ACK。断电发生在同一 sequence
  中间时会重读该 sequence，已写事件按 `(binding, operation, sequence, eventIndex)` 去重，
  未写事件继续归并，不会重复 Provider 或工具执行。
- 远程 context metrics 与对话级压缩后的估算值按本次请求实际使用的 Runtime 选择写入
  `context_state_json`。实时接收与恢复入口都传入请求的选择；数据库在未传入时按对话、
  项目、auto 顺序解析。继承项目设置的对话保持 `runtime_selection_json = NULL`，
  不为接收 usage 固定对话 Runtime；去重和消息/指标写入仍在同一 SQLite 事务中完成。
- ACK 后 Agent 删除已确认事件，只保留小型操作终态与游标用于幂等核对；未 ACK 输出继续
  保留。Main 按 transcript page 的最高连续 sequence ACK，终态仍立即 ACK。单事件、单页、
  单 Prompt 总字节和事件数都有上限；Agent 始终为唯一终态预留一个事件和最大事件字节，
  避免配额耗尽后无法记录终态或无法重启。已 ACK 终态操作和已交付模型 ledger 在 daemon
  运行期间也按固定上限裁剪，不依赖重启。Agent 重启不能重建内存中的 Runtime/Prompt
  Promise，因此启动时把遗留 nonterminal 记录变为 `outcome-unknown`，Desktop 只同步该
  终态而不自动重放。
- prepare 已接受但 start RPC 未到达时，Agent 使用两分钟 prepare-to-start watchdog 清除
  进程和 Prompt 凭据并记录 `outcome-unknown`，避免无界 Prompt 哨兵造成永久悬挂。
- Desktop SQLite 仍是永久可见项目/对话数据的权威；Agent transcript 只是尚未同步事件的
  权威。启动后 Renderer 先订阅恢复进度，再触发每项目恢复。项目选择器依次显示网络、
  Agent、Runtime、cursor、完成或失败/重试；只阻塞受影响项目的发送和队列，已有历史与
  其他项目保持可用。
- 正常应用退出对已接受托管 SSH 请求执行 detach，不等待远端完成；本地请求和尚未接受的
  请求仍按原行为取消。用户显式“停止”始终发送稳定 operation cancellation，并等待 Agent
  语义终态。已进入 Agent-owned `run` 但 start/attach 响应仍不确定的请求继续保留为
  `interrupted + remote_recoverable`，并自动走 exact attach；不会因为尚未收到第一个公开
  事件而丢失恢复身份。

## Agent 本地模型 gateway

- Main 在 `runtime/preparePrompt` 中发送当前解析后的有界 profile；Agent 只在该 operation
  的内存状态中持有 Provider URL、API Key 和认证信息。OpenCode 仍通过 Prompt 私有 Unix
  socket 发出模型请求，但 HTTP Provider dispatch、响应交付和稳定 call ledger 全部位于
  Agent，因此 Desktop 断电后可以继续下一轮。
- Agent 校验固定 model、协议和 API path，拒绝 background/store、provider web search、
  provider MCP、持久 conversation、非文本 modality 和其他可独立计费能力；请求/响应 body
  各保留 64 MiB 的内存传输上限，用于容纳长上下文和图片输入，响应同时核对声明长度与短读。
  Desktop blob 模型桥保留已发布 v1 的 canonical JSON 字节，不添加尾随换行。单条消息按
  最多 2 MiB 的帧发送，接收端逐帧消费流量额度，跟踪 JSON 结构并在消息上限内组装；
  已发布端的单帧消息可直接接收，多帧大消息要求两端均使用更新后的实现。每个
  `(binding, operation, roundIndex)` 只 dispatch 一次；已 dispatch 但未证明完整交付的调用
  变为 `outcome-unknown`，不会自动重试。
- Agent 不按固定模型调用次数或 Prompt 累计输出 Token 数停止 Runtime；每次 Provider
  请求遵循所选模型 profile 的单次输出设置；未设置时保留 Runtime 请求中的 Token 参数，
  更新后的 Agent 不补入固定 32,000 Token，也不再按 60 秒或桥接层的 120/150/180 秒
  总时长中止请求。它通过非 critical 的 `runtime/model-bridge-optional-limits` v1 capability
  声明支持省略 profile limits；Main 在建立托管 Runtime 时按实际连接的 capability 选择
  profile。锁定的已发布 Agent `0.11.22` 不支持省略这两个字段，Main 对该路径保留原有
  32,000 Token、60,000 ms 默认值及 1,000,000 Token、300,000 ms schema 上界；这些兼容
  值不应用于声明支持省略 limits 的 Agent。
  显式请求超时、Prompt deadline、用户取消和连接关闭仍会中止对应操作。模型桥协议不包含 Prompt
  调用次数或累计 Token 配额字段。实际 usage 在语义 transcript 中同步回 Desktop 的
  usage/task 数据。
- 新组包的 Runtime manifest 将 `maximumPromptRuntimeMilliseconds` 设为 `0`，表示由
  Prompt 自身的 deadline 决定时长，不再额外截为十分钟。旧 manifest 中的正数限制仍按其
  声明执行。进程 owner 使用真实剩余时长安排 Prompt deadline；启动与停止等待的有界
  超时不再缩短 Prompt。
- helper 可以接收同一 Prompt 内并发到达的模型桥请求；它在单一稳定模型桥上按到达
  顺序等待并交付，不返回本地 `bridge-busy`，每个响应只有在 HTTP 完整 flush 后才
  发送 delivery ACK。
- GoodBuddy 自己管理会话标题，因此传给 OpenCode 的配置禁用 title Agent；一次用户
  Prompt 不会额外触发标题模型请求。
- Agent gateway 不再把 Provider 请求往返 Desktop；legacy blob bridge 只保留给旧的
  非 Agent-owned 测试/兼容路径。凭据不进入 Renderer、SSH 命令参数或远端环境。
- Unix socket 接收端按 `readableLength` 中已经缓冲的字节增量排空一个声明长度的帧，
  不会在部分大响应到达时反复请求尚未缓冲的完整剩余长度；短读、连接结束、错误和取消
  都会使当前交换失败。原生 Linux 回归覆盖至少 256 KiB 的 broker 响应。
- Unix broker 的请求超时 `0` 表示不设置请求总时限，不等于零毫秒连接等待。
  连接仍有独立的默认 5 秒超时；只有显式正数请求时限才与连接时限取较小值，
  用户取消仍关闭连接并中止 dispatch。
- Renderer 把相邻 text/reasoning delta 合并为消息 block 时始终替换最后一个 block，
  不修改既有 React state 对象。这样开发环境 StrictMode 重复调用 state updater 时，
  block metadata 与 canonical 消息正文保持一致。

## Agent 开发期间的真实 Host 验证

2026-09-10 Desktop `0.12.11` / Agent `0.11.23` 候选复测：共享 Linux x64 Host 的当前
源码通过工作区协议重命名保护、字面路径/重命名/合并提交差异、Unix 桥接 256 KiB 往返及取消，
以及继承 Runtime 指标的数据库重开与去重。隔离 Agent 报告版本 `0.11.23`，桌面 managed ACP
经真实 SSH、Agent 和既有已安装 OpenCode 各完成一次 Ask、Execute；共 2 次真实模型请求，
全部 HTTP 200、completed 且已交付，指标持久化后未固定继承选择。首次连接准备超时，未发送
模型请求；重试成功后清理测试进程与目录，并按本轮 bundle 摘要确认、清理一次遗留上传目录。
本次为当前源码复测，不是正式 `0.11.23` 复合包安装验收；三个原生包由发布 CI 构建和验证。
本地发布回归为 3845 项通过、66 项跳过，发布说明校验、typecheck、lint 通过；发布准备未执行
本地桌面生产构建或打包。

本轮 `020a9ad` 工作树修复使用当前源码在共享 Linux x64 Host 验证：默认 Unix broker
完成 256 KiB 响应并传递取消；生产 AssistantDatabase 在临时库中写入继承项目的指标，
重开后去重重放，未固定对话选择。当前 Workspace 协议的目标存在/同名/硬链接重命名
保护、字面路径 diff、重命名 diff 和 merge commit diff 均通过，Git 使用 Host 已配置身份。
当前 Desktop `createManagedRemoteAcpRuntime` 经真实 SSH attach、隔离 Agent、OpenCode
和 Agent gateway 完成 Ask 与 Execute，均得到两字符回答和 done。Execute 的真实
model-usage 转换为指标后通过生产数据库持久化与去重，继承设置保持未固定。
共 3 次真实 Provider 调用（2 次 Ask、1 次 Execute），均 HTTP 200、completed 且已交付；
前两次运行在模型完成后被测试 harness 的 usage 元数据/事件名断言拦截，并非产品失败。
未修改产品来适配 harness：构建时直接解析 ACP SDK 的 ESM 入口，凭据只通过既有
safeStorage 与模型控制协议使用。各次隔离 Agent 停止后剩余所属进程数为 0，测试目录和
上传文件均已回收，原 Host registry 与已安装组件未改变。此次不覆盖 UI 点击或安装升级。

2026-09-10 已发布模型桥兼容修复：从 `agent-v0.11.22` 读取的源码与当前源码分别在共享
Linux x64 Host 启动隔离 Agent daemon。当前 Main 的 `createManagedRemoteAcpRuntime`
经真实 SSH attach、Agent protocol、OpenCode 和 Agent gateway，在两版 Agent 上各完成
一次 Ask、一次 Execute，均返回 `OK`；模型账本共 4 次调用，全部 completed 且已交付。
旧 Agent 未声明 optional-limits capability，当前 Agent 声明该能力。使用既有加密设置和
固定 Host identity，凭据仅经协议进入内存；测试 daemon、Runtime 和运行目录已回收。
本次覆盖托管 Runtime 入口，未执行 UI 点击、安装升级或长时间 Provider 等待。
6 个聚焦测试文件共 77 项通过；另用真实 tag codec 验证四种消息双向互通。typecheck、lint
通过；全量 `npm test` 为 3,739 项通过、4 项失败、64 项跳过，失败涉及发布/便携包夹具、
DSH MCP 暴露和 Runtime 发现，未扩展修复范围。

2026-09-10 模型桥限制修复：共享 Linux x64 Host 使用当前源码构建的 gateway、Unix
broker 和 loopback helper，通过 2 MiB 请求/响应往返，并确认客户端取消传到 broker。
使用 GoodBuddy 加密设置中的模型凭据、既有固定 SSH identity 和 OpenCode `1.18.29`
运行 Ask、Execute，两个模式均收到 HTTP 200 并返回 `OK`。共发出 3 次真实 Provider
请求：Ask 成功，首次 Execute 的最终结果因本地命令采集超时未保留，单独复测 Execute
成功。运行中测试凭据只经 SSH stdin 进入内存；测试进程和临时目录由测试运行回收。
本次实机检查覆盖当前源码的模型桥与 Runtime helper；未重装共享 Agent，也未重跑完整
Desktop attach/bootstrap。Prompt 长时运行和精确 deadline 使用假时钟回归验证。
最终聚焦回归为 14 个文件、193 项通过、5 项平台跳过；typecheck、lint 和开发 build
通过。此前全量 `npm test` 为 3,703 项通过、22 项失败、63 项跳过，失败分布在 Runtime
发现、发布/便携包夹具、DSH ACP、模型设置和内置工具分类；该次全量结果来自并行修改中的
工作区，未据此修改其他任务的文件，也未把聚焦通过等同于全量通过。

2026-09-09 已在隔离 Linux x64 Host 验证当前源码的快照配置修复：桌面
`ManagedRemoteExecutionServices` 经 managed ACP、真实 detached Agent 和模型桥启动
OpenCode `1.18.29`，Ask 完成原生读取，Execute 完成 4,000 行文件的 CRLF → LF 转换。
4 次实际 Provider 请求全部为 HTTP 200，最终原生配置在两种模式均为 `snapshot: false`，
权限仍为 `ask`/`allow`，transcript ACK 分别为 15/15 和 12/12。测试 Agent、模型桥、
Runtime 与 relay 均已回收，原有 Host registry 未改变。这是实际链路和关闭验证，
不是 Linux 前后性能对照，也未注入取消；不代替正式发布资产校验。

任何会改变已部署 GoodBuddy Agent 或桌面到 Agent 生产链路的源码改动，都必须在开发期间
使用共享 Linux x64 真实测试 Host 验证。适用范围包括 Agent daemon、Agent protocol
及共享 contract、Agent 组包与安装、attach/update、Runtime 启动与进程归属、Workspace、
model bridge，以及生命周期和恢复逻辑。单元测试、mock、fixture、CI 或正式发布前回归
都不能替代这一步；不得等到准备发布时才首次运行受影响的真实链路。

测试 Host 有两个网络入口：

- `192.168.0.23`：局域网入口，在本地网络可达时优先使用；
- `10.7.0.23`：VPN 入口，局域网入口不可达时使用。

两者指向同一台物理 Host，只代表两条访问路由，不能计为两个独立 Host、两种架构或两份
覆盖结果。测试只使用已固定的 Host identity 和 GoodBuddy 已有凭据存储；地址不得写入
产品行为或默认配置，用户名、密码、私钥等凭据不得写入源码、文档、命令、日志或测试输出。

开发时应在改动链路达到可运行状态后尽早执行真实 Host 验证，并在最终相关改动后重复受
影响的场景。必须使用当前源码构建或当前候选包，不能只验证 Host 上已经发布的旧 Agent。
按改动范围至少选择以下场景：

1. Agent 组包、安装或升级：验证当前候选的 attach-or-bootstrap、安装/更新、版本切换及
   随后的连接。
2. Runtime profile、进程启动/归属或 Ask/Execute 边界：通过桌面生产入口启动真实 Runtime，
   验证受影响模式；Ask 权限改动必须验证只读边界，Execute 权限改动必须验证所需写入、
   进程和网络能力。
3. Agent protocol、RPC、stream、model bridge 或模型消息链路：执行最小有界真实模型调用，
   禁用非必要工具和附件，并记录实际调用次数；大消息或工具链路改动还应覆盖对应的真实
   payload/工具场景。
4. 会话、owner、取消、超时、断线或恢复逻辑：执行与改动直接相关的中断、取消、Agent/
   Runtime 重启、SSH 断开或重连序列，并确认不会错误重放结果未知的操作。
5. Workspace 或 Host 文件路径：只在 GoodBuddy 专用测试目录操作，验证真实路径和权限，
   不得读取、覆盖或删除无关 Host 文件。

停止或修改远端进程前必须先核对其启动身份、PID/进程组和 GoodBuddy 归属。若两个入口均
不可达，应立即把真实 Host 验证报告为开发阻塞，保持该验证未完成，不能把 Agent 改动表述
为已完成，也不能把首次真实验证推迟到发布阶段。

## 离线配置缓存简化验证（2026-09-08）

`npm test -- tests/opencode-config.test.ts src/main/agent/opencode-runtime.test.ts src/main/agent/bundled-runtimes.test.ts tests/remote-runtime-bundle.test.ts tests/agent-bundle.test.ts --testTimeout=30000` 通过 108 项；`npm run typecheck`、`npm run lint` 和 `npm run build` 通过。
全量 `npm test -- --testTimeout=30000 --hookTimeout=120000` 当次结果为 3556 项通过、28 项失败、58 项跳过；其中离线配置路径断言随后修正并通过上述聚焦测试，未重跑全量。其余失败涉及 Agent 包元数据大小限制、Darwin 组包超时、Runtime 探测、DSH 和打包夹具。
测试 Host 的 SSH 端口可达，但候选复合包验证受元数据大小限制阻塞，未部署或执行实机安装/更新验收；本次真实模型调用 0 次。
以上为缓存简化阶段的历史记录，不代表后续发布前修复的最终结果。

## 发布前修复实机验证（2026-09-08）

共享 Linux x64 Host 上使用当前源码、锁定 Node 与 OpenCode `1.18.29`、进程内临时签名
身份组包，签名目录读取、生产 `preparePackage/commitPackage`、adopt、Runtime activate
与 health 通过。所有写入位于独立 GoodBuddy 测试 HOME，未修改共享安装。

真实 Desktop 协议客户端已通过 Ask 文本回复、Execute 原生 Task 子代理在 Workspace 外
的专用测试目录写文件、读回校验、关闭连接后重连同一 daemon，以及 stop/bootstrap 后
health。首轮发现握手 Base64URL 误拒绝后完成上述修复；最终源码复测通过，独立 Unix
endpoint 连续 20 次握手也通过。两轮模型账本各 5 次 completed，本轮合计 10 次真实文本
模型调用，没有发布工件、签名目录或 release tag。

最终自动化回归与尚未覆盖的系统休眠场景见
[工作栏进度](../assistant-workbar/progress.md)。

## 已完成的 E2E 验收记录

### macOS arm64 Host 支持

`agents.yml` 增加 `macos-15` / `darwin-arm64` 的原生 CI 组包任务，使用临时测试
签名校验 Agent、固定 Node、Koffi 和 OpenCode，并比较两次组包的字节摘要。
构建输入与检查的权威说明见 [BUILD.md 的 Agent 原生 CI 策略](../../../BUILD.md#agent-原生-ci-策略)。
此 CI 任务不发布工件。生产 lock、`agent-release.yml`、安装器、Desktop 包管理和
SSH Host 链路现支持 `linux-x64`、`linux-arm64`、`darwin-arm64`，三个目标共用
原有 catalog JSON 和签名格式，不增加 Mac 专用目录。旧版 Linux-only Desktop
读取器不能解析混合目录，首次发布 Darwin 条目前需先升级 Desktop。

macOS 保持 SSH 按需启动 detached Agent，不要求 launchd、开机服务或管理员权限。
私有 socket 使用 `/private/tmp`，通过 `getpeereid` 核对 UID；进程身份、启动标识和
进程组通过系统原生 API 获取。取消前枚举 Runtime 的实际后代并核对 PID、启动时间
和可执行文件，停止独立进程组中的工具，再停止 Runtime，避免只杀主进程组留下工具。

2026-09-06 当前源码在真实 macOS arm64 Host 的隔离目录通过生产安装器
`preparePackage` / `commitPackage`、adopt、health、Runtime activate、stop、
bootstrap 和再次 health。实际 Desktop 协议客户端通过 Attach、只读 Workspace
打开、真实 Ask 输出、Execute 写入并读回测试文件、取消工具并验证子进程退出，以及
重新连接同一 daemon。两个 Darwin 原生进程测试通过，其中一个覆盖独立进程组子进程。
共享 Linux x64 Host 同时通过当前源码组包、生产安装、生命周期、真实 Ask 和重连。
这些验证没有发布 catalog 或工件；GitHub Actions 和正式下载渠道的发布验收尚未执行。
最终本地 typecheck、lint、开发 build 和 diff whitespace 检查通过。最终全量
`npm test` 为 3520 通过、57 跳过、0 失败（326 个测试文件通过、9 个跳过）。
此前 ActivityPanel 的批量记录用例超时、App 的实时浏览器用例未观察到预期调用，
分别复跑后通过；未修改这两个用例或放宽超时，随后完整测试套件通过。
隔离测试 ledger 统计 Mac 模型请求 7 次，Linux 首轮
1 次；最终 Linux 源码重装后又完成 1 次最小 Ask，总计 9 次真实模型请求。

以下为较早的仅构建阶段记录，摘要不代表上述最终源码产物：

2026-09-06：在真实 macOS 26.5.2 / arm64 Host 的独立测试目录运行当前源码
`build/agent-ci-bundle.cjs --platform darwin --arch arm64`，退出码为 0。
测试使用固定 Node 24.19.0、OpenCode 1.18.29 和内存临时签名密钥；Node 官方
归档 SHA-256、OpenCode integrity、Mach-O 架构、内外层签名和两次组包摘要比较
通过，Agent CLI 加载、Koffi 原生模块加载与 OpenCode `--version` 检查通过。
生成 `goodbuddy-agent-0.11.18-darwin-arm64.gbagent`，本次测试包 SHA-256 为
`9c63ba080def56ebd371a622f2650b89d0c652444077bd6ee19c4bd51b60f6ff`。
临时签名每次独立运行都会变化，因此该摘要只标识本次测试产物，不是发布输入。
源码压缩传输 529,624 字节，大依赖由 Host 直接下载并复用 npm 缓存。
真实模型调用为 0 次；没有安装 Agent 服务，没有修改在线 catalog 或发布工件。

该仅构建阶段的聚焦测试为 53 项通过、1 项平台跳过，typecheck、lint 和开发生产
bundle 构建通过；这组历史结果不替代完整 Host 支持改动后的最终验证。

### Linux 历史验收

- 2026-09-06 使用当前源码隔离 Agent 验证原生子代理过程插件。最终场景收到 37 条 ACP
  插件事件，桌面侧从已保留活动重建跟踪器后仍接收后续文本与工具；子代理和父请求正常
  完成，最终模型调用账本为 4 次 completed。此前成功场景另 4 次，两轮真实 Host 共
  8 次模型请求。
- 同日 Windows 隔离桌面实际发送 OpenCode 原生 Task，展开卡片可看到进行中的正文与
  read 工具，取消后已有过程保留且工具显示已取消；正确工作区场景完成后显示测试文件
  内容，最终结果不重复留在过程末尾。本机有界代理共记录 10 次模型请求（含错误路径、
  取消和成功场景）；另外 2 次使用原生测试配置的请求返回 401，改选显式测试模型后通过。
  未改动正常用户设置，也未发布 Agent 包。全量静态与测试结果见
  [本轮验证记录](../assistant-workbar/progress.md)。

- 2026-08 的本地 fixture 完整验证 Linux x64 Agent `0.11.2-e2e.12`、Node `24.19.0`
  和 Agent protocol `2.0`；当时没有 arm64 fixture，因此该记录不能作为当前独立发布
  的双架构验收。Agent `0.11.10` 后续已由原生 workflow 发布并公开验证双架构工件；
  当前源码 lock 固定为 `0.11.21`；正式发布状态以独立 Agent Release 与签名 catalog 为准。
- 2026-08-30 在共享 Linux x64 Host 的隔离测试 HOME 中验证当前 `0.11.13` 源码候选：
  签名 Runtime 清单的测试墙钟上限为 1 秒，模型桥首轮故意延迟 2.515 秒后 Prompt 仍在
  5.770 秒正常完成；随后 OpenCode 原生 Task 依次产生 `running`、`completed` 子 Agent
  事件并完成父请求。测试结束后隔离 Agent、Runtime、socket 和 Workspace 已全部清理，
  Host current Agent 仍为 `0.11.10`。
- 2026-08-31 使用隔离 Linux x64 Agent `0.11.14` 候选完成 remote-authoritative 矩阵：
  15 秒短 smoke、2 分钟正常 detach、5 分钟本机 harness 强制结束、并发对话、SSH relay
  丢失、显式取消、确定性 Provider 错误、2 秒 Provider 结果未知、Agent `SIGKILL`/重启，
  以及 reopened Desktop SQLite 恢复。成功工具的 START/END sentinel 都各出现一次；
  Provider 结果未知与 Agent 重启只提交 `outcome-unknown`，未重放 Prompt、模型调用或工具。
- 同一矩阵中的 Desktop schema v32 实际恢复保持原 project/conversation/request/
  assistant-message 身份，在同一事务中提交语义 provenance、消息与 cursor；重新打开
  `assistant.sqlite` 后消息和 Task 都完整，重复 provenance 返回 false，recoverable Task
  归零。
- 最终源码复核后重新构建测试签名 package：
  SHA-256 `39307fd1dccd638dcb723027591bcd83deab7057d550c99eff6f037e339829f4`，
  installation `agent-2cad05acfebe853394807e3a11f7befcd9f47215c2cf3a33a03d5f644b45716e`，
  Runtime `1.18.29` / bundle
  `sha256:6c7fc975415ef2547d3729bc4772d3e78362c2e76c05d1fc24968a0468fcb7ba`。
  最终 15 秒 detach/recovery 使用两个模型轮次、一个工具和一个终态，ledger 两轮均
  `completed + delivered`，语义 `latest=ACK=41`，保留事件、Runtime owner、ACP channel/
  frame 都为 0，START/END 各一次。最终取消另使用一个模型轮次、一个工具和一个 cancelled
  终态，语义 `latest=ACK=29`，清理计数同样为 0。最终补充验证共 3 次真实文本模型调用。
  采证后已按 PID/starttime/executable 停止精确隔离 daemon 并删除隔离 Host 测试根目录；
  `/root/.goodbuddy` 下的共享 Agent 安装和进程未被修改。
- 2026-08-31 使用当前工作树短期测试签名 Linux x64 候选，在全新隔离 HOME 和 installation
  中验证有界诊断：bootstrap、detached daemon、attach、relay 断开与同 controller 重连、
  `controller/resume`、Runtime candidate 激活和 OpenCode ACP 进程启动均通过；新
  `diagnostics --installation-id` 命令在 daemon 重启后读取到 23 条完整 JSONL。诊断目录
  为 `0700`、文件为 `0600`，单文件 3719 bytes，未超过 64 KiB。六类测试哨兵覆盖 Prompt、
  密钥、环境、SSH 参数、用户文件内容和原始错误消息，CLI 输出与磁盘均未出现哨兵。把隔离
  diagnostics 目录临时设为不可写后，Attach 和 `agent/status` 仍正常；随后已恢复权限。
- 2026-09-02 使用后续锁定为 `0.11.15` 的当前源码 Agent bundle 在共享 Linux x64 Host 的唯一
  `/tmp/goodbuddy-e2e-no-reverify-*` 隔离 HOME 验证已登记 Runtime 的快速激活路径。测试
  复制 Host current Runtime registry 与 bundle，在副本 OpenCode 二进制追加哨兵字节后，
  `runtime activate` 仍依据匹配的 registry 与 canonical manifest 成功返回
  `activated=true`，确认普通激活不重新哈希 payload 或执行 OpenCode 版本探测。本次没有
  模型调用；harness 成功后已删除整个隔离目录，未修改共享 Agent/Runtime 安装或进程。
  本次未注入模型凭据或执行 Prompt，真实文本模型调用 0 次；三文件轮转继续由聚焦测试覆盖。
  测试结束前按 PID、UID、starttime、executable 和唯一 installation 核对并停止所有本次
  daemon，本地及 Host 临时目录均已清理，共享 current Agent 和 `/root/.goodbuddy` 未修改。
- 2026-09-03 协调发布候选将上述已验证源码锁定为 Agent `0.11.15`，并将 Desktop 最低
  版本同步为 `0.12.2`；Agent protocol `2.0`、固定 Node 与 OpenCode Runtime lock 均未
  改变。Agent bundle/package/catalog/workflow、Runtime 注册加载、Desktop package
  workflow 与 Release Notes 聚焦测试 `106/106` 通过、1 项平台用例跳过；全量
  `npm test` 为 `3478` 通过、`51` 跳过，typecheck 与 lint 通过。本轮没有新增模型调用，
  也未在本地运行 production build、package 或安装探针。
- 2026-09-03 使用包含当前 Runtime capability 修复的源码 harness，在共享 Linux x64 Host
  的唯一 `/tmp/goodbuddy-e2e-runtime-capability-*` 隔离 HOME 中读取签名 Runtime 副本。
  Agent 成功报告已登记 OpenCode Runtime；最终源码又在唯一
  `/tmp/goodbuddy-e2e-direct-modes-*` 隔离 HOME 中分别直接启动 Ask 与 Execute，两个模式
  都未经过外部进程隔离命令。Runtime owner 和隔离目录均已清理，未修改 Host current
  Agent/Runtime。本次只验证能力声明和真实进程启动，没有发送 Prompt，真实文本模型调用
  0 次。
- 2026-09-03 使用包含本次模型轮次与输出背压修复的当前源码 Agent，在共享 Linux x64
  Host 的唯一 `/tmp/goodbuddy-e2e-*` 目录完成 Runtime 激活和 Agent 本机模型 gateway
  验证。模型 gateway 通过所选 Anthropic 连接返回预期随机哨兵，HTTP 状态为 200，实际
  文本模型调用恰好 1 次；Host 临时目录随后删除，共享 Agent/Runtime 安装和进程未修改。
- 2026-09-04 使用当前源码 Desktop 和共享 Linux x64 Host 的既有 Agent/Workspace
  生产链路验证分页文件预览。专用测试文本共 262,166 bytes，首个 256 KiB 页面在三字节
  UTF-8 字符前回退并显示 262,143 bytes；继续加载后完整追加剩余文本，页面不再显示加载
  按钮且没有错误。测试未调用模型；专用远端文件、目录和本机隔离用户数据均已清理。
- 正常 Host 更新路径把 Linux x64 Host 的 Agent 更新为 `0.11.2-e2e.12`，并确认
  OpenCode Runtime 已安装版本与所需版本均为 `1.18.29`。
- 一条新的 Ask 用户操作只提交一次。OpenCode 先在 build 模型轮次请求一个原生
  `read`，读取专用测试 Workspace 中的证据文件，再在第二个 build 模型轮次生成最终
  回答；没有 title 模型轮次，也没有第二个工具调用。
- 两个模型轮次都记录已交付，远端 helper 保持休眠且 Unix socket 没有未读响应积压。
  持久化的 canonical 助手正文精确为 `GOODBUDDY_REMOTE_TOOL_4C6B9D8A`。验收操作没有
  重放任何结果未知或已经完成的 Provider 请求。

## 项目保存

远程项目只持久化稳定配置：

- Host ID；
- 规范远端工作目录；
- Runtime selection；
- `ask | execute` 默认模式。

Agent installation、Host revision/Host Key generation、Workspace identity、Runtime
bundle/adapter digest 和 capability generation 都属于 live connection/lease，不进入项目
domain object 或 SQLite。打开托管 SSH 项目不接受 Renderer 回传的旧项目草稿，而是从 Host
store 解析当前连接目标，通过 Agent/Runtime 安装管理器的 current/activate 读取路径取得
registry identity，再用同一个 Agent 连接验证 Workspace 路径和 Runtime capability。该流程
不会扫描完整 payload、取得安装包或发布组件。

实时 Runtime 创建只接受 OpenCode，使用当前解析后的模型 profile 准备 Agent 本地 gateway，
从当前 Agent 连接和 Runtime registry 取得会话 identity，并在该连接上打开 Workspace 和
ACP channel。Host 编辑或环境更新会定向失效 Agent 连接与 Runtime 缓存，下一次请求自然
重新取得 current 环境；无需修改项目。Ask/Execute 权限继续由每次 Prompt 的 ACP Runtime
边界执行。

Renderer 在用户主动打开已有托管 SSH 项目时立即切换，不显示远程激活状态。Host、Agent、
Workspace、Runtime 和 Saving 进度仅用于新建或显式保存项目；进行中可显式取消并禁用会
产生冲突的项目创建和设置入口。远端 RPC 拒绝只向
Renderer 暴露固定方法名、数字 RPC code 和有界 service code，不转发 Host 私有错误详情。
`runtime/preparePrompt` 在远端明确拒绝且尚未接受 Prompt 时会关闭对应 Main binding，
不会把确定性失败错误保留为 `outcome-unknown`。未确认终态的 Prompt 仍不会自动重放；
同一当前 Agent identity 上的 `prompt-running` binding 会阻止不同的新 operation，直到
原 operation 恢复或取消，避免遗留 Host 工作与新 Prompt 并行。只有 Host/Agent/Runtime
identity 已变化且旧 authority 无法恢复，或原 binding 已有 `outcome-unknown` 终态时，显式
新 Prompt 才替换旧 binding。新 ACP session 的首次 Prompt 会把 Desktop 已持久化的有界
会话历史作为不可信数据一并发送；成功加载或恢复原 ACP session 时不会重复注入历史。
Ask 和 Execute 的 Linux Runtime 进程都直接启动已签名 Runtime 或 Agent model bridge
helper；监督器核对启动后的最终 executable，再登记为运行中进程。

不持久化 T2/T3、consent、approval bridge、confinement 或组件验证结果。数据库 schema
v32 保留项目及关联用户数据，并加入 remote-recoverable Task/message/provenance/cursor；
执行空间表保持 `project_id/kind/root_path/ssh_host_id`
四列，并删除旧 Runtime 验证表。

## Agent 有界诊断

Detached Agent 不依赖 stdio 留存故障证据。每个 installation 在固定私有目录
`~/.goodbuddy/state/<installationId>/diagnostics/` 中维护
`agent-diagnostics.jsonl`、`.1` 和 `.2`，每个文件不超过 64 KiB，目录权限为 `0700`，
文件权限为 `0600`。记录覆盖 daemon 启停、detached 启动、连接、恢复和 Runtime
启动/退出；每条只包含固定事件、时间、PID、可选工作模式、固定原因和白名单错误码。

诊断写入使用最多 64 条的有界异步队列。连接、恢复和 Runtime 回调只把已经归一化的固定
记录入队，不等待磁盘；原始 `Error` 不进入队列。队列满、目录不可写或轮转失败只丢弃诊断，
不得改变 Attach、协议、Runtime 或退出结果。daemon 停止和 bootstrap 生命周期结束时执行
有界 flush。多个 Agent 进程通过 GoodBuddy 私有短期锁协调 append 和轮转，不把长期锁作为
运行前提。

已安装 Agent 提供只读固定命令：

```text
goodbuddy-agent diagnostics --installation-id <installationId>
```

该命令只能从 installation 对应的固定 state 目录读取上述有界文件，并逐行输出已验证 JSONL；
不接受任意路径，也不扩展 Agent protocol。诊断不得包含 accepted Prompt、模型输入输出、
模型密钥、完整配置、环境变量、SSH 参数、用户文件内容、路径或原始错误消息。应用内反馈的
“附加最近桌面诊断记录”只读取 Desktop 诊断，不会自动取得或上传这些远端 Agent 记录。

## 资源与发布

- 所有桌面构建（包括 `portable` 与 `release:package`）只携带
  `agent-runtime-lock.json`、`remote-runtime-lock.json` 与公开的
  `agent-release-keys.json`，不嵌入 `.agent-resources`、
  `.remote-runtime-resources` 或任何可安装 Linux 远端 payload。
- `build/agent-package.cjs` 在对应原生 Linux 架构组装确定性 `.gbagent`，外层签名覆盖
  描述符和每个内部文件身份；内部 Agent 与 Runtime 仍分别使用既有签名 manifest 和 lock
  校验，但所有 production 层统一使用一组 GoodBuddy 通用发布身份并通过签名域区分用途，
  不要求内部 Runtime 单独配置密钥。`build/agent-catalog.cjs` 为双架构包生成签名累计目录，
  拒绝同一版本/架构改变字节。
- `.github/workflows/agents.yml` 只使用进程内临时测试 key 做分支/PR 原生验证，不发布。
  `.github/workflows/agent-release.yml` 才可在 annotated `agent-v<version>` 标签和受保护
  `agent-signing` Environment 中构建 production 包。Agent GitHub Release 必须
  `--latest=false`；北京 OSS 先写 `agent-releases/v<version>/`，GitHub 公开后才切换
  单一 `agent-releases/latest.json` 指针，使客户端始终从同一不可变版本目录读取目录与签名。
- Main 的本地缓存只发布完整验证成功的内容。在线目录和包都绑定固定 GitHub/OSS URL、
  大小和 SHA-256；选取规则是桌面最低版本满足、Agent protocol major 相同且 minor 不高于
  当前支持值的最高 SemVer。缺少某架构仅使该架构 Host 的托管 SSH 无法激活。
- `agent-release-keys.json` 读取时按 UTF-8 JSON 解析并严格验证 schema、唯一 key ID、
  规范 Base64、有效 Ed25519 key、环境和撤销列表，不把 CRLF/LF 或普通 JSON 空白作为
  信任条件。上传到 Host 前重新序列化为确定性 LF JSON。签名目录、描述符、manifest 和
  payload 仍按原始签名字节及 SHA-256 验证。

## 发布前完整回归（不能替代开发验证）

以下清单只用于复核开发期间已经在真实 Host 上通过的链路，不得作为 Agent 改动的首次
真实 Host 验证：

1. `npm test`
2. `npm run typecheck`
3. `npm run lint`
4. 发布候选的生产构建由 main 分支 CI 验证；发布前不在本地执行生产构建或打包，详见
   [发布手册](../../development/release-runbook.md)。
5. 用测试签名复合包验证在线下载源选择和离线导入/导出；正式 Agent 候选还需公开校验
   双架构 production 包与签名目录。
6. 在已固定 Host Key 的 Linux x64 测试 Host 上验证 attach-or-bootstrap。
7. 在 GoodBuddy 专用测试目录验证 Ask 无法修改文件。
8. 验证 Execute 可以写文件、启动进程和访问网络，同时不触碰无关 Host 文件。
9. 运行一次有界的真实模型调用，确认凭据不进入 Renderer、SSH 参数、远端环境或磁盘，
   只在当前 accepted operation 生命周期内进入 Agent 内存。
10. 中断并恢复 SSH，确认活动 Runtime 不被网络抖动终止。
