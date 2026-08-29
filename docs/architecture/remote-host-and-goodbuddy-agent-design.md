# SSH 远程主机与 GoodBuddy Agent 实现说明

## 状态

本文记录截至 2026-08-29 的当前代码实现，不定义额外的信任框架。“新增 Host 只探测、Host 卡片手动准备
Agent/Runtime、Host 直接从 GitHub/北京镜像下载、项目始终使用 Host current 环境”已经完成源码接线，
详细事务与验收边界见
[SSH Host 远程环境准备与直连下载设计](./remote-host-environment-provisioning-design.md)；
控制面直连源码可直接使用既有 package format v1 包，不等待携带 installer 的新 Agent
包，也不通过额外目录元数据判断 bootstrap 能力；公开能力仍等待 GitHub/北京镜像、
Linux x64/arm64、取消和离线 GoodBuddy 传输的真实 Host 验收。
Windows 到 Linux x64 的既有安装、
Main-only 模型桥、断线恢复、输出重放、同一 OpenCode Session 续接与终态清理已经在真实
Host 上完成 provider-free 验证。上一轮 Linux x64 验收使用 Agent `0.11.2-e2e.12` 与
OpenCode Runtime `1.18.9` 完成了一次有界真实模型工具调用；加入每 helper 随机 loopback
路径 capability 后，Agent `0.11.7` 已通过独立 workflow 发布 Linux x64/arm64 复合包和
签名累计目录；当前源码准备 `0.11.8`，修复 Host 更新并消除重复 payload 验证。失败的
`agent-v0.11.3` 保持不可变且未发布。

## 产品语义

远程 Host 与项目能力是默认关闭的技术预览。用户在“设置 > 平台功能”的独立
“远程项目（技术预览）”页签启用开关后，Renderer 才显示 SSH Host 管理、托管 SSH 项目创建和已保存
远程项目；Main 在 IPC 边界执行同一开关校验，避免隐藏界面被绕过。关闭开关不删除 Host、
项目或凭据；当前远程项目切回第一个普通本地项目。应用启动仍固定
选择普通本地项目，不会因为保存了远程项目而自动连接 Host。

远程项目只有两种工作模式：

- **Ask**：Runtime 在操作系统边界以只读方式访问项目 Workspace。
- **Execute**：用户已授权使用所选 SSH 账号的完整权限。Runtime 可以使用该账号可访问的文件、进程、网络和工具，不再要求额外 trust tier、consent checklist、逐工具审批或“受控执行”授权。

Execute 不获得 root 或 SSH 账号本身没有的权限。模型 API Key 与 Provider 认证仍保留在 Electron Main，不传给远端 Runtime。

## 组件

```text
Renderer
  -> 窄 Preload / Main IPC
Main
  -> SSH Host 与 Host Key 管理
  -> SSH connection pool
  -> 签名 Agent / Runtime 安装
  -> 远程项目当前环境准备与稳定配置 SQLite 事务
  -> Main-owned model bridge
SSH attach
  -> 远端私有 Unix socket
Detached GoodBuddy Agent
  -> Workspace / Git 协议
  -> OpenCode ACP channel
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

- Agent bundle 通过 manifest、Ed25519 签名、payload digest、平台和架构校验。
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
  它们不取得安装包、不发布组件，也不通过 SFTP 重读或哈希 payload。
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
  commit 终态持久化；通道丢失时 `commit-status` 读取终态，或从已认证准备状态幂等完成
  中断的目录/metadata 发布，不重新下载或准备包。prepare
  完成后、commit 前快照 Agent/Runtime 五个 metadata 文件，任一组件 adoption 失败都恢复其原字节或原缺失
  状态；已经发布的 side-by-side payload 可以保留但不能成为 current。确认 adoption 后
  才显式 cleanup；cleanup 失败只保留维护重试，不回滚健康环境。Host 在 prepare 解包时
  完成一次完整 payload 校验，commit 和后续注册检查不再遍历包体。首次 bootstrap 不依赖
  既有 Agent daemon，也不要求 format v1 归档携带 `agent/lib/package-installer.cjs`。
- 即使版本号均为当前版本，Host 卡片仍提供同版本“重新安装”，用于修复 registry、签名
  或安装 identity 异常。GoodBuddy-owned 同 digest 目录损坏时先隔离后替换，并在发布或
  激活失败时恢复；不要求删除 Host、凭据或引用项目。
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
  [Host 环境准备设计](./remote-host-environment-provisioning-design.md) 为准。
- 打开新建/项目设置弹窗只读取本地 Host 验证记录，不并发检查所有 Host；目录浏览或保存
  才连接所选 Host。
- 项目选择器中的管理操作默认浮动隐藏，在悬停、键盘焦点或触屏环境显示。管理任意已保存
  项目不先激活项目，因此 Host 不可达或远端目录已不存在时仍可删除其本地记录。
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
- 文件预览、搜索、Git diff、目录项和显式文件传输保持字节、条目数和路径长度上限。

## Runtime

首个远程 Runtime 固定为签名 OpenCode ACP bundle。
托管 SSH 项目的 Composer Runtime 菜单只显示当前配置的 OpenCode 和管理入口，不显示
直连模型、Continue 或 DeepSeek Harness。激活旧远程会话时，若其保存了其他 Runtime
selection，Renderer 会恢复为当前 OpenCode 配置；Main 的远程请求校验仍是最终边界。

### Ask

Ask 使用系统 `bwrap`：

- Workspace 和 Runtime bundle 只读 bind；
- 独立可写 scratch HOME、TMPDIR 和 XDG 目录；
- 固定环境名和固定 Runtime argv；
- 通过只读边界阻止 Workspace 修改。
- ACP 权限请求只有在工具种类为原生 `read` 且 Runtime 提供 `allow_once` 选项时才允许；
  search、edit、execute、未知工具以及只提供持久授权的请求全部拒绝。

`allow_once` 只解决 OpenCode 发起原生读取前的 ACP 协商，真正的文件系统边界仍是只读
`bwrap` bind。Host 缺少 `bwrap` 时 Ask 不可用。

### Execute

Execute 不经过 Ask 的 bubblewrap profile：

- 直接启动已签名 Runtime entrypoint；
- 使用 Main-only 模型桥时，签名 Agent launcher 会 `exec` 候选 manifest 锁定的
  Node Runtime；进程 owner 校验最终 Node executable，而不是已经被替换的 shell
  launcher 路径；
- `cwd` 为项目 Workspace；
- 继承 SSH 账号的正常环境、文件系统、进程和网络能力；
- 不进行 T2/T3、confinement attestation、approval bridge 或逐工具批准。

两种模式都保留请求 deadline、输入/输出字节上限、取消和进程组清理。

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
- 同一 detached Agent 存活时，短暂 SSH 断线依次执行 `controller/resume`、`runtime/resumeAcpChannel` 和 `runtime/replayAcpChannel`，从 Main 已确认的 cursor 后只重放 Agent 到 Main 的已记录输出。重复 frame 会被确认但不会再次交给上层。若上一代连接只留下没有活动请求的 detached binding，完成精确 controller takeover 后会先有界停止并核对遗留 Runtime process，再用新 channel epoch 重新打开同一 binding 并恢复已有 ACP session；其他 controller、未证明 takeover 或仍有活动请求的 binding 仍被拒绝。
- Main 到 Runtime 的 ACP 输入、模型请求、工具请求和 blob 不自动重放。
- 无法确认外部 Provider 是否已处理的模型调用保持结果未知，避免重复计费或重复副作用。
- 只有远端返回 identity 匹配且 `closed: true` 时，Main 才删除持久化 binding；传输失败或未确认 close 会保留 recovery identity。
- 终态 close 由 Agent 在一个事务中为两个方向记录 sequence high-water tombstone，删除剩余 frame 和 active channel，并归零对应 journal quota。tombstone 用于拒绝迟到的旧 epoch frame，因此当前不会按时间自动裁剪。
- 断线不主动终止正在运行的 Runtime。用户取消、deadline、显式关闭或 Agent shutdown 才触发停止。
- Agent 失联期间继续把 Runtime 输出写入本机 journal；重新连接只校验 controller
  identity、恢复 binding，并从 Main 最后确认的 cursor 后同步缺失数据。已接受的
  指令和结果不确定的 Provider 请求都不自动重放。

## 模型桥

- Provider URL、API Key 和认证头只存在于 Main。
- 远端 OpenCode 通过 GoodBuddy Agent helper 和每次 Prompt 的私有 Unix socket 使用模型桥。
- Main 校验固定模型 profile、协议、请求路径和有界传输格式，并记录 Provider
  返回的实际 usage；不限制 Prompt 内的模型调用轮数、工具调用次数、累计 Token
  或单次模型输出 Token。取消、Runtime deadline、请求/响应字节上限和结果不确定时
  禁止自动重放仍然保留。
- helper 可以接收同一 Prompt 内并发到达的模型桥请求；它在单一稳定模型桥上按到达
  顺序等待并交付，不返回本地 `bridge-busy`，每个响应只有在 HTTP 完整 flush 后才
  发送 delivery ACK。
- GoodBuddy 自己管理会话标题，因此传给 OpenCode 的配置禁用 title Agent；一次用户
  Prompt 不会额外触发标题模型请求。
- 一条模型桥消息编码为一个 canonical JSON blob frame；blob frame 最大 2 MiB，
  Provider 请求与响应 body 仍各自限制为 768 KiB。每条模型消息只调用一次 SSH
  write，不再二次分片、等待逐帧 credit 或合并多个协议帧。凭据不进入 Renderer、
  SSH 命令参数或远端环境。
- Unix socket 接收端按 `readableLength` 中已经缓冲的字节增量排空一个声明长度的帧，
  不会在部分大响应到达时反复请求尚未缓冲的完整剩余长度；短读、连接结束、错误和取消
  都会使当前交换失败。原生 Linux 回归覆盖至少 256 KiB 的 broker 响应。
- Renderer 把相邻 text/reasoning delta 合并为消息 block 时始终替换最后一个 block，
  不修改既有 React state 对象。这样开发环境 StrictMode 重复调用 state updater 时，
  block metadata 与 canonical 消息正文保持一致。

## 已完成的 E2E 验收记录

- 2026-08 的本地 fixture 完整验证 Linux x64 Agent `0.11.2-e2e.12`、Node `24.19.0`
  和 Agent protocol `2.0`；当时没有 arm64 fixture，因此该记录不能作为当前独立发布
  的双架构验收。Agent `0.11.7` 后续已由原生 workflow 发布并公开验证双架构工件；
  当前源码 lock 是修复候选 `0.11.8`。
- 正常 Host 更新路径把 Linux x64 Host 的 Agent 更新为 `0.11.2-e2e.12`，并确认
  OpenCode Runtime 已安装版本与所需版本均为 `1.18.9`。
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

实时 Runtime 创建只接受 OpenCode，使用当前解析后的模型 profile 建立 Main-only 模型桥，
从当前 Agent 连接和 Runtime registry 取得会话 identity，并在该连接上打开 Workspace 和
ACP channel。Host 编辑或环境更新会定向失效 Agent 连接与 Runtime 缓存，下一次请求自然
重新取得 current 环境；无需修改项目。Ask/Execute 权限继续由每次 Prompt 的 ACP Runtime
边界执行。

Renderer 在用户主动打开已有托管 SSH 项目时立即切换，不显示远程激活状态。Host、Agent、
Workspace、Runtime 和 Saving 进度仅用于新建或显式保存项目；进行中可显式取消并禁用会
产生冲突的项目创建和设置入口。远端 RPC 拒绝只向
Renderer 暴露固定方法名、数字 RPC code 和有界 service code，不转发 Host 私有错误详情。
`runtime/preparePrompt` 在远端明确拒绝且尚未接受 Prompt 时会关闭对应 Main binding，
不会把确定性失败错误保留为 `outcome-unknown`。

不持久化 T2/T3、consent、approval bridge、confinement 或组件验证结果。数据库 schema
v31 保留项目及关联用户数据，但重建执行空间表为 `project_id/kind/root_path/ssh_host_id`
四列，并删除旧 Runtime 验证表。

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

## 发布前验证

1. `npm test`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run build`
5. 用测试签名复合包验证在线下载源选择和离线导入/导出；正式 Agent 候选还需公开校验
   双架构 production 包与签名目录。
6. 在已固定 Host Key 的 Linux x64 测试 Host 上验证 attach-or-bootstrap。
7. 在 GoodBuddy 专用测试目录验证 Ask 无法修改文件。
8. 验证 Execute 可以写文件、启动进程和访问网络，同时不触碰无关 Host 文件。
9. 运行一次有界的真实模型调用，确认凭据只由 Main 使用。
10. 中断并恢复 SSH，确认活动 Runtime 不被网络抖动终止。
