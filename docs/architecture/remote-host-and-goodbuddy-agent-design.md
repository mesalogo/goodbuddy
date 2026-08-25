# SSH 远程主机与 GoodBuddy Agent 实现说明

## 状态

本文记录当前代码实现，不定义额外的信任框架。Windows 到 Linux x64 的安装、Main-only 模型桥、断线恢复、输出重放、同一 OpenCode Session 续接与终态清理已经在真实 Host 上完成 provider-free 验证。上一轮 Linux x64 验收使用 Agent `0.11.2-e2e.12` 与 OpenCode Runtime `1.18.9` 完成了一次有界真实模型工具调用；加入每 helper 随机 loopback 路径 capability 后，当前源码 lock 已转为正式 Agent `0.11.2`，尚未复用旧版本号。远程 OpenCode 功能仍处于发布前验证阶段；公开签名 key registry 已供应，当前发布门槛是通过独立 Agent workflow 正式发布并公开验证 Linux x64/arm64 复合包和签名累计目录。

## 产品语义

远程 Host 与项目能力是默认关闭的技术预览。用户在“设置 > 平台功能”的独立
“远程项目（技术预览）”页签启用开关后，Renderer 才显示 SSH Host 管理、托管 SSH 项目创建和已保存
远程项目；Main 在 IPC 边界执行同一开关校验，避免隐藏界面被绕过。关闭开关不删除 Host、
项目或凭据；进行中的激活允许取消，当前远程项目切回第一个普通本地项目。应用启动仍固定
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
  -> 远程项目验证与 SQLite 事务
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
- Host 地址、用户或 Host Key generation 变化时关闭旧连接，并定向退役依赖旧 Host identity 的 Workspace 和 Runtime 会话。保存开始后，所有引用该 Host 的项目保持“需要重新激活”状态；当前项目立即执行完整激活并原子刷新 Host revision 等验证结果，其他项目在下次选择时刷新。激活失败或取消不会恢复发送能力，Composer 和来自 Main 持久队列的用户消息都要等待后续成功激活；排队消息会退回原队列，并在成功后通过既有 queue-ready 流程继续。用户重新选择当前 SSH 项目也会显式触发相同验证，而不是复用旧项目快照。

## Agent 安装与生命周期

- Agent bundle 通过 manifest、Ed25519 签名、payload digest、平台和架构校验。
- 安装使用当前 SSH 用户目录中的 GoodBuddy-owned 路径和 side-by-side digest 目录。
- Agent 代码与固定 Node Runtime 是独立 payload。升级时如果当前 Host Agent 的签名
  manifest、registry identity、owner/mode/size 和 Node digest 都可验证，且候选
  manifest 声明完全相同的 Node，安装器直接在新的 side-by-side 目录中复用该 Node；
  否则正常上传候选 Node。Agent 不匹配不会阻止升级，也不会覆盖旧安装。
- 桌面包只携带版本 lock 与 production 公钥，不携带远端 payload。用户必须先在设置中显式下载最新兼容的目标架构复合包，或导入离线 `.gbagent`；项目激活不会联网下载。每个复合包绑定 Agent、固定 Node 与桌面维护的 OpenCode Runtime 精确工件。应用重启固定进入第一个普通本地项目，不自动连接上次远程项目；用户主动切换托管 SSH 项目时，Main 从本地验证缓存选择 Host 架构工件，Host 尚未安装该 identity 时上传并启动。相同 Renderer 对同一项目的并发激活共享一个 Main 操作。
- Agent、Workspace 和 Runtime 全部验证成功后，Main 才在同一 SQLite 事务中刷新项目保存的 Agent/Runtime evidence，然后把项目设为当前项目。上传、启动、验证或事务失败时，项目继续绑定旧 identity，不能用未提交的新 identity 绕过持久化绑定校验。
- SSH 连接先尝试 attach；Agent 不存在或未运行时执行幂等 bootstrap，然后重新 attach。
- Agent 是按需启动的 detached process，不注册开机服务，不依赖 systemd、D-Bus 或 Linger。
- 每个模型桥 helper 都为 loopback HTTP 入口生成一次性随机路径 capability；只有写入当前 OpenCode 子进程配置的 URL 可以访问该入口，其他本机用户即使发现临时端口也不能提交模型请求。
- Agent 监听当前用户拥有的私有 Unix socket。SSH 中断只关闭 relay，不拥有 Agent 和活动 Runtime 的生命周期。
- SSH Host 设置通过固定探针和有界 SFTP 显示 Host 已登记的 Agent/OpenCode 版本，并与当前 GoodBuddy 所需版本比较；打开设置或“刷新版本”只读取状态，不安装或切换远端组件。
- “平台功能 > 远程项目”中的本地 Agent 包清单与 Host 状态分离。Main 对用户数据目录中
  Linux x64/arm64 `.gbagent` 分别执行外层可信签名、桌面/协议兼容性、内部 Agent/Runtime
  签名、架构与完整 payload 校验；Renderer 只得到版本、架构、远端 Runtime 版本、协议和
  `verified | not-downloaded | invalid`，不得到缓存路径、key ID 或 digest。在线下载只由
  用户点击触发，并使用“关于与更新”选择的 GitHub 或北京 OSS 来源；离线导入/导出通过
  Main 管理的文件对话框完成。
- 当任一组件缺失或不是当前版本时，用户可显式选择“更新版本”。Main 使用同一个取消信号依次强制执行 Agent、Runtime 安装器，并把 Agent、Runtime、Finalizing 阶段只发送给发起更新的 Renderer。更新启动仍受技术预览开关和可信 Sender 校验约束；取消不受开关约束，确保操作开始后即使关闭功能也能停止。
- 更新成功后才定向清理该 Host 的 Agent 连接和 Runtime 选择缓存，并让当前引用项目重新激活；失败或取消保留 Host 配置、凭据、项目、Workspace 和可继续验证的旧组件，Renderer 刷新实际版本并允许重试。同一 Renderer 同时只更新一个 Host，窗口销毁或 Main 退出会取消活动更新并执行有界收尾。
- 显式 stop、升级、身份冲突或进程退出时清理 GoodBuddy 自己的 socket、状态和子进程；不得删除或覆盖无关 Host 文件。

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
  Node Runtime；完全相同且已验证的 Node 可在 Agent 版本间复用。进程 owner 校验
  最终 Node executable，而不是已经被替换的 shell launcher 路径；
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
- 同一 detached Agent 存活时，短暂 SSH 断线依次执行 `controller/resume`、`runtime/resumeAcpChannel` 和 `runtime/replayAcpChannel`，从 Main 已确认的 cursor 后只重放 Agent 到 Main 的已记录输出。重复 frame 会被确认但不会再次交给上层。
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
  的双架构验收。当前源码 lock 是正式版本 `0.11.2`，需要由新的复合包发布流程另行验证。
- 正常 Host 更新路径把 Linux x64 Host 的 Agent 更新为 `0.11.2-e2e.12`，并确认
  OpenCode Runtime 已安装版本与所需版本均为 `1.18.9`。
- 一条新的 Ask 用户操作只提交一次。OpenCode 先在 build 模型轮次请求一个原生
  `read`，读取专用测试 Workspace 中的证据文件，再在第二个 build 模型轮次生成最终
  回答；没有 title 模型轮次，也没有第二个工具调用。
- 两个模型轮次都记录已交付，远端 helper 保持休眠且 Unix socket 没有未读响应积压。
  持久化的 canonical 助手正文精确为 `GOODBUDDY_REMOTE_TOOL_4C6B9D8A`。验收操作没有
  重放任何结果未知或已经完成的 Provider 请求。

## 项目保存

远程项目持久化稳定配置和当前验证结果：

- Host ID、Host revision 与 Host Key generation；
- 远端工作目录和 Workspace identity；
- Agent installation identity；
- Runtime selection、bundle digest、adapter digest；
- `ask | execute`。

打开托管 SSH 项目会从这些已保存字段重建验证输入，不接受 Renderer 回传的旧项目草稿。桌面更新后，用户先显式准备兼容复合包，第一次打开才可安装对应 Agent/Runtime 并原子刷新以上字段，同时保留项目名称、说明、Host、远端工作目录、Runtime selection 和默认工作模式。

请求前置校验只要求 Workspace 验证与 Runtime 验证来自同一个当前 Agent
installation。它不比较激活时保存的模型 profile 或默认工作模式与当前会话选择，
因为这些不是签名远端 Runtime 的身份；切换当前模型配置或 Ask/Execute 不需要重新激活
项目。实时 Runtime 创建仍只接受 OpenCode，使用当前解析后的模型 profile 建立 Main-only
模型桥，并再次精确核对 Agent identity、Runtime bundle/adapter digest、架构、capability
和连接身份。Ask/Execute 权限继续由每次 Prompt 的 ACP Runtime 边界执行。

Renderer 在用户主动打开托管 SSH 项目时订阅同一次 Main 保存操作的进度，依次显示
Host、Agent、Workspace、Runtime 和 Saving。操作完成、失败或取消后会清除阻塞进度；
进行中可显式取消，并禁用会产生冲突的项目切换、创建和设置入口。远端 RPC 拒绝只向
Renderer 暴露固定方法名、数字 RPC code 和有界 service code，不转发 Host 私有错误详情。
`runtime/preparePrompt` 在远端明确拒绝且尚未接受 Prompt 时会关闭对应 Main binding，
不会把确定性失败错误保留为 `outcome-unknown`。

不持久化 T2/T3、consent、approval bridge 或 confinement 证明。数据库迁移可以保留旧列以安全读取历史数据库，但新 domain object 不再暴露这些字段。

## 资源与发布

- 所有桌面构建（包括 `portable` 与 `release:package`）只携带
  `agent-runtime-lock.json`、`remote-runtime-lock.json` 与公开的
  `agent-release-keys.json`，不嵌入 `.agent-resources`、
  `.remote-runtime-resources` 或任何可安装 Linux 远端 payload。
- `build/agent-package.cjs` 在对应原生 Linux 架构组装确定性 `.gbagent`，外层签名覆盖
  描述符和每个内部文件身份；内部 Agent 与 Runtime 仍分别使用既有签名 manifest 和 lock
  校验。`build/agent-catalog.cjs` 为双架构包生成签名累计目录，拒绝同一版本/架构改变字节。
- `.github/workflows/agents.yml` 只使用进程内临时测试 key 做分支/PR 原生验证，不发布。
  `.github/workflows/agent-release.yml` 才可在 annotated `agent-v<version>` 标签和受保护
  `agent-signing` Environment 中构建 production 包。Agent GitHub Release 必须
  `--latest=false`；北京 OSS 先写 `agent-releases/v<version>/`，GitHub 公开后才切换
  单一 `agent-releases/latest.json` 指针，使客户端始终从同一不可变版本目录读取目录与签名。
- Main 的本地缓存只发布完整验证成功的内容。在线目录和包都绑定固定 GitHub/OSS URL、
  大小和 SHA-256；选取规则是桌面最低版本满足、Agent protocol major 相同且 minor 不高于
  当前支持值的最高 SemVer。缺少某架构仅使该架构 Host 的托管 SSH 无法激活。

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
