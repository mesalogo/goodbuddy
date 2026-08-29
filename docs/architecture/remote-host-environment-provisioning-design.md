# SSH Host 远程环境准备与直连下载设计

## 状态

本文记录 2026-08-28 确认的目标设计及当前实施状态。源码已经实现 Host 手动准备、
GoodBuddy 传输、Host 直连下载、control-plane one-shot installer、发布后健康 adoption，
以及项目路径只验证已安装环境。Host 负责 Agent/Runtime 的安装与更新生命周期，项目流程
只消费已经准备好的 Host 环境。

当前源码可以直接使用既有 package format v1 `.gbagent`：归档已经包含固定 Agent 和
Node，installer 由 GoodBuddy 桌面控制面打包并通过固定 SSH prepare channel 单次发送，
不要求归档包含 `agent/lib/package-installer.cjs`，签名目录也不提供或检查额外的
bootstrap 能力元数据。公开直连能力仍须完成本文末尾 GitHub/北京镜像、Linux x64/arm64、
取消和离线 GoodBuddy 传输的真实 Host 验收；本文
不表示这些验收或新的 Agent 发布已经发生。当前实现细节同时以
[SSH 远程主机与 GoodBuddy Agent 实现说明](./remote-host-and-goodbuddy-agent-design.md)
和源码为准。

## 设计结论

将安装和更新从项目切换移到 Host 管理是合理的，原因如下：

- Agent、固定 Node 和 OpenCode Runtime 安装在 SSH 账号 Home 下，由同一 Host/账号上的
  多个项目共享，不属于某一个 Workspace。
- 大文件传输发生在项目切换时会阻塞导航，也把 Host 级故障误显示成项目故障。
- Host Key、认证、平台和架构本来就在新增 Host 时验证，此时继续只读探测并在 Host 卡片
  提供手动准备入口最容易理解。
- 项目只保存 Host ID、远端路径、Runtime 选择和默认工作模式。Agent installation、
  Runtime digest、Workspace identity 和 Host revision 都从当次连接取得，不写入项目；
  “移出安装”不等于“跳过当前环境检查”。

目标职责是：

| 流程 | 职责 |
| --- | --- |
| 新增或重新验证 Host | 验证身份和认证，保存 Host 并探测环境，不传输安装包 |
| Host 管理 | 用户明确刷新目标 Host，并可选择安装、同版本重修、取消和重试 |
| 创建远程项目 | 只读本地 Host 验证记录，保存时连接所选 Host 并验证当前 Agent、Workspace、Runtime 和模型配置，只持久化稳定配置 |
| 切换远程项目 | 只切换本地项目配置，不连接 Host；实际使用 Workspace 或 Runtime 时按需复用 Host 当前环境 |

## 不变量

- Host 配置与远程环境准备是两个事务。SSH 验证成功后先原子保存 Host、凭据和完整 Host
  Key，再开始可能耗时的下载和安装。
- 环境准备失败或取消时保留已保存 Host，显示“未就绪”并允许重试，不创建半完成项目。
- 不把“环境健康”保存为长期可信布尔值。设置页从 Host 的签名 registry 和当前 Host
  identity 派生版本状态；准备完成和实际使用时再执行 bootstrap/health。合法但暂未运行的
  detached Agent 仍可显示为已安装，打开设置不能为了刷新卡片隐式启动或更新它。
- 所有安装继续使用 GoodBuddy-owned staging 和 side-by-side digest 目录。失败不得覆盖
  可用旧安装，也不得删除 Host 上无关文件。
- Renderer 不接收下载 URL、缓存路径、签名 key、digest、SSH 命令或凭据。Main 负责来源
  选择、可信目录解析、操作编排和 IPC 输入校验。
- 产品不提供“自动安装远程环境”开关。保存、重新验证或打开 Host 都不能自动传输
  `.gbagent`；只有用户点击 Host 卡片的主按钮后，Main 才开始准备。
- Host 卡片只有一个主按钮，按版本事实显示“安装远程环境”“更新远程环境”或“重新安装”。
  次级 SegmentedControl 选择“自动”“Host 下载”或“GoodBuddy 传输”；默认“自动”，只影响
  下一次操作，不持久化为 Host 配置。
- “自动”只在 operation/prepare 前执行一次 Host capability probe：直连明确可用时选择
  Host 下载，否则选择 GoodBuddy 传输。用户显式选择的方式保持有效；一旦 acquisition
  已选定，prepare、commit 或 adoption 的任何失败都停止本次操作，不跨 acquisition
  自动回退。
- 直连安装只要求已验证 SSH 连接和远端系统工具，不要求现有 Agent daemon。轻量能力探测
  返回确定性缺少工具、空间、权限或来源不可达时说明原因；探测本身异常时仍允许用户点击
  直连安装，由实际安装流程重新解析签名候选并通过 SSH 重试。
- 项目路径不得为了“方便”回退到隐式安装。Host 未就绪时应引导到 Host 设置，不在项目
  切换器中启动大文件传输。

## 新增 Host 流程

新增向导保持现有 Host Key 和认证顺序，并在系统探针之后显示一次只读环境结果：

1. 输入名称、地址、端口、用户名和认证方式。
2. 在发送认证材料前读取并确认 Host Key。
3. 完成 SSH 认证以及平台、架构、Shell、Home 有界探针。
4. 原子保存 Host、加密凭据和完整 Host Key。
5. 读取 Host 已安装的 Agent/Runtime registry，并执行一次轻量下载能力探测。
6. 如果已安装 identity 满足当前 GoodBuddy 要求，显示“版本匹配”并结束；该 badge 不代表
   Agent 正在运行或环境健康。
7. 如果组件缺失或需要更新，显示目标 Agent、Node、Runtime、架构、来源和完整包大小，
   告知用户保存后前往 Host 卡片安装，然后结束新增向导。

新增流程到此结束，不显示自动安装开关，也不自动开始环境安装。保存后的 Host 卡片提供
一个手动准备主按钮，并以次级 SegmentedControl 选择“自动”“Host 下载”或
“GoodBuddy 传输”。主按钮按版本事实显示“安装远程环境”“更新远程环境”或“重新安装”。
本地尚无精确包不要求用户先离开当前页面；选择 GoodBuddy 传输时，同一次操作会取得并
验证候选后继续上传。

探测不得自动下载完整 `.gbagent`。只有用户明确启动安装后才允许传输大包。

## Host 编辑

- 仅修改显示名称不要求重装远端环境。
- 地址、端口、用户名或 Host Key 变化时，旧 Host identity 立即失效，关闭旧连接和对应
  Runtime 缓存。项目记录不含旧组件 identity；下一次打开直接解析新 Host 的当前环境。
  保存新身份后只重新执行环境探测，所需安装由用户在 Host 卡片手动启动。
- 只替换同一目标的认证材料时仍重新认证并读取实际环境；如果签名 identity 和健康状态
  未变化，不重复安装。
- 当前项目引用的 Host 被编辑时，Main 立即失效该 Host 的 identity 和连接缓存；下一次
  Workspace/Runtime 操作按需使用新目标。环境未准备好时该操作失败，不回退旧连接。

## 下载能力探测

探测在 Host Key 已固定且 SSH 认证成功后执行，只检查当前选择的“关于与更新”来源：

- Host 是受支持的 Linux `x64` 或 `arm64`。
- SSH 账号 Home 可写，GoodBuddy-owned staging 可创建。
- 可用空间满足签名目录声明的包大小、解包上限和安全余量。
- Host 可以通过 HTTPS 访问所选 GitHub 或北京镜像 URL。
- 首次安装所需的下载、SHA-256 和运行归档内固定 Node 的能力可用。
- 已安装 Agent 是否报告未来的直连更新能力。

探测使用小型签名目录或有界请求，不以一次成功 `HEAD` 代替真实安装验证。结果只用于当次
展示，不持久化为永久能力；开始安装前重新检查，因为网络、代理和磁盘状态可能变化。

探测失败不能阻止保存 Host，也不能禁用显式 GoodBuddy 传输或离线导入路径。显式选择
Host 下载时由实际操作报告不可用原因；“自动”只把“直连明确可用”作为选择 Host 下载的
条件，其他结果选择 GoodBuddy 传输。

## 工件选择与来源

Main 继续读取并验证 `agent-catalog.json`、`agent-catalog.sig` 和 production 公钥
registry，按以下条件选择唯一候选：

- Host 平台和架构匹配；
- 最低桌面版本满足；
- Agent protocol major 相同，minor 不高于桌面支持值；
- 使用满足条件的最高 SemVer；
- URL、文件名、大小和 SHA-256 来自签名目录；
- 下载来源跟随“关于与更新”的 GitHub/镜像选择。

远程下载只优化大包的网络路径。Main 仍需先取得并验证小型目录，再通过经过 Host Key
验证的 SSH 控制面传递固定候选元数据。产品不接受 Renderer、项目、Host 文件或用户输入的
任意下载 URL。

## 获取与统一安装事务

首次安装不能假设 Host 已有 GoodBuddy Agent、installer 或系统 Node，也不由既有 Agent
daemon 参与。两种 acquisition 的差别只在于如何把同一个签名 compound `.gbagent` 交付到
固定 operation staging：

- **Host 下载**：控制面通过固定 SSH prepare channel 发送签名目录绑定的 URL、大小和
  SHA-256；Host 有界下载并校验完整归档。
- **GoodBuddy 传输**：显式选择时，在线目录不可用或本地已验证包版本不低于在线候选，
  则优先使用本地包，包括版本更高的离线导入；线上存在更新且可用时仍取得线上新包。
  需要下载时，同一次用户操作会验证 SHA-256 和签名、写入缓存并取得 lease。随后以有界
  流式 SFTP 上传一个 compound archive，以及从该归档中已验证的 bootstrap Node。约
  294 MiB 的完整包不会一次读入 Main `Buffer`，Host 收到后仍再次校验完整包。

交付后两种 acquisition 完全共用一个 control-plane 事务：

1. Main 创建带 operation ID、总时限、输出上限和取消信号的准备操作，并通过固定
   `prepare` channel 发送有界 one-shot installer 与结构化输入。
2. Host 校验归档大小、SHA-256、外层及内层签名、平台、架构、协议和 payload digest，
   只把候选准备到 side-by-side 目录，不改变 current。
3. `prepare` 完成后、`commit` 前按原字节记录 Agent 与 Runtime 的五个
   current/registry metadata 文件，
   同时记录原本缺失的状态。
4. `commit` 终态先持久化到 operation staging。控制通道丢失时，Main 只用同一 operation
   的 `commit-status` 恢复结果，绝不重放 `commit`。
5. commit 后依次完成 Agent activate/health、Runtime activate 和 finalize。任一组件
   adoption 失败都停止候选，并把五个 metadata 文件恢复为原字节或原缺失状态；已经发布的
   side-by-side payload 可以保留，但不能成为 current。
6. Main 确认 adoption 后才显式执行 cleanup，释放 staging、缓存 lease 和操作资源。

这不是两个并行安装管理器，也不存在把 Agent 与 Runtime payload 逐文件走 SFTP 安装的
第二条路径。两种 acquisition 共享相同的 prepare、commit、adoption、finalize 与 cleanup。

Host 缺少可靠的下载、SHA-256 或 ZIP 能力时，不自动安装系统软件，也不要求 root。显式
Host 下载返回明确失败；本次操作不自动切换 acquisition，用户可改选 GoodBuddy 传输后
重新点击主按钮。后续更新和同版本重装复用同一事务，不要求用户先通过项目切换完成
“过渡升级”。

## 本机传输与离线路径

现有 `.gbagent` 本地缓存、在线下载、离线导入和导出继续保留：

- GoodBuddy 路径在本地缺少精确候选时，于同一次操作完成下载、整包大小与 SHA-256、
  全部签名和 payload 验证、缓存发布及 lease 获取。
- SFTP 有界流式上传单个 compound archive 与其中已验证的 bootstrap Node 到操作自己的
  staging；Main 不把完整归档读入内存，Host 再次校验后进入统一 control-plane 事务。
- Host 无公网、代理/TLS 异常或缺少 bootstrap 工具时，用户可显式使用此路径；离线导入
  后也走同一缓存 lease、上传和 Host 校验流程。
- 本地项目和普通桌面打包不依赖任何远端 Agent 工件。

## 完整包与复用

第一阶段继续发布和下载完整复合 `.gbagent`，不同时引入组件化增量发布：

- 远程直连和 GoodBuddy 本机下载都会传输完整包，其中包含 Agent、固定 Node 和 OpenCode
  Runtime。
- 新 Agent 安装时，如果旧 manifest、registry identity、owner/mode/size 和 Node digest
  全部可验证，并且候选声明同一 Node，则使用硬链接复用，不重新写入 Node 数据。
- 相同 Runtime bundle digest 已存在且完整时只验证并激活，不重复上传或解包。
- Agent 其他文件或变化后的 Runtime 仍按完整候选安装。

只有真实包体和发布频率证明网络成本仍不可接受时，才另行设计 Agent、Node 和 Runtime
独立签名组件目录；本功能不提前引入第二套发布协议。

## Host 准备状态

设置中的 Host 卡片分开表达版本事实和操作结果：

- **未验证**：Host Key、认证或系统探针尚未完成。
- **尚未安装**：Host 可连接，但 Agent 或 Runtime 缺失。
- **需要更新**：已安装 identity 与当前兼容候选不一致。
- **正在准备**：正在探测、下载、验签、安装或健康检查。
- **版本匹配**：版本 badge 只表示 Agent/Runtime identity 与当前兼容候选匹配，不等同于
  进程正在运行或环境健康；设置页普通刷新不会启动已停止的 Agent。
- **准备失败**：保留 Host 和可用旧组件，展示有界错误与重试入口。

主按钮按版本事实显示“安装远程环境”“更新远程环境”或“重新安装”。重新安装失败后，
界面显示本次操作未完成，并以随后重新检查的版本卡片表达当前事实，不在提交结果不确定时
断言旧版本未被替换，也不得把“版本匹配”改称“环境健康”。统一进度以 `探测`、
`下载/传输`、`校验`、`应用环境`、`Agent 激活与健康检查`、`Runtime 激活` 和
`完成设置` 表达用户可理解的阶段。

同一 Host identity 同时只允许一个由用户启动、Main-owned 的准备操作。重复观察者加入
已有操作，不启动第二次发布；窗口关闭、显式取消、Host identity 改变或 Main 退出时执行
有界取消。Main 在 commit 前为该 Host 持久化一个不含凭据的 pending operation 记录；
commit 指令开始后若 SSH 通道、输出或终态丢失，当前操作保留该记录和远端 staging。
下一次重试或应用重启后的首次操作先对同一 Host identity 执行只读 `commit-status` 和
cleanup，不重放未知 commit，也不开始第二条 acquisition；确认清理后删除 pending 记录。
取消在最终原子切换完成后不再伪装成回滚成功。

## 项目创建与切换

- 新建托管 SSH 项目弹窗只读取本地 Host Key/连接验证记录，不逐台连接或刷新版本。只有
  已完成本地验证的 Host 可选；浏览目录或保存时才连接所选 Host，并由保存流程完整检查
  Agent、Workspace 和 Runtime，但不隐式安装。
- 项目保存验证 Host 当前 revision 与 Host Key generation、当前 Agent、Workspace、
  Runtime、模型 profile 和 Ask/Execute 配置；SQLite 事务只写入 Host ID、规范远端路径、
  Runtime 选择和默认工作模式。
- 打开或切换已有项目只提交本地项目选择，不执行 SSH、registry、Workspace 或 Runtime
  检查。首次实际使用远程 Workspace 或 Runtime 时才解析 Host 管理的当前 Agent/Runtime，
  并建立或复用当前 Agent 连接。已安装 Agent 暂未运行时，
  固定 `attach-or-bootstrap` 命令幂等启动 registry 中的 current identity；这里的
  bootstrap 只启动进程，不安装组件，也不重新读取、哈希或验签完整 payload。
  Agent 进程读取 Host 管理已提交的 registry 和匹配 manifest 元数据，不重新验签或扫描
  完整安装 payload。
- Workspace 和 Runtime 使用当前 Agent 连接产生的 live handle/lease。项目不保存或核对
  历史 Workspace/Runtime identity；当前 registry、连接状态或 capability 无效时停止并
  引导到 Host 管理，不在项目流程中下载或安装。
- 桌面更新导致 Host 组件过旧时，项目保持未切换并提示前往 Host 设置。应用启动仍进入
  第一个普通本地项目，不自动连接或更新远端 Host。
- Host 环境更新成功后，Main 定向失效该 Host 的 Agent/Runtime identity、连接和 Runtime
  会话缓存。所有项目在下一次实际操作时自然使用新的 current 环境；无需改写项目记录。
- 环境准备失败时不改变已有项目绑定。Host identity 编辑失败时则继续保持 fail-closed，
  因为旧身份不能替代用户刚保存的新身份。
- 项目管理入口与项目选择分离。项目选择器中的浮动管理按钮直接打开目标项目设置；删除
  不访问 Workspace、Agent 或 Host，因此远端目录已删除或 Host 不可达都不能阻止本地
  项目记录清理。删除当前项目或 Host 级联删除当前项目时只回退到普通本地项目。
- Host 删除确认使用本地数据库列出全部引用项目，包括归档项目；确认后级联删除本地项目
  及其会话、任务、成果、记忆、计划和心跳关联，再删除本地 Host 与凭据。整个流程不发起
  SSH，也不删除远端内容；跨 Host 设置文件与 SQLite 的普通失败会恢复已写入的一侧。

项目切换不展示远程激活进度，也不阻塞项目导航。`Host`、`Agent`、`Workspace`、`Runtime`
和 `Saving` 进度只属于新建或显式保存项目；实际 Workspace/Runtime 操作使用正常的局部
加载和错误反馈。

## 实现结构

当前实现复用现有机制，没有新增平行的安装管理器：

- 扩展当前 Host 系统探针和远程环境 inspector，返回瞬时下载准备能力。
- 让当前 `RemoteEnvironmentUpdateService` 演进为 Host 环境准备编排器，统一用户手动
  启动的首次安装和后续更新、自动 acquisition 选择、进度、取消和最终失效。
- Host 管理使用安装管理器完成准备、更新和完整验证。项目切换不调用安装管理器；
  Workspace 和执行路径按需解析 current identity，并在当前进程内复用已确认 identity 和
  Agent 连接；Host 编辑或环境更新定向清空这些缓存。这些路径不会取得安装包或发布组件。
- Host 卡片即使显示相同版本也保留显式重装操作，用于修复 registry、签名或 payload
  identity 异常；若同一 digest 的 GoodBuddy-owned 目录校验失败，重装会先隔离旧目录，
  完整发布并验证新目录，失败时恢复旧目录。重装不要求删除 Host、凭据或项目，也不会处理
  所有者异常、符号链接或非 GoodBuddy 管理路径。
- 由桌面控制面打包有界 one-shot installer，并通过固定短命令 `exec sh -s` 和 stdin
  发送脚本及结构化输入，避免 SSH command 长度限制；既有 package format v1 归档内固定
  Node 负责解码和运行它。
- Preload 只暴露明确的 Host 探测、准备、取消和进度方法，不暴露 URL 或任意 SSH 命令。
- 现有 Agent/Runtime side-by-side、Node 硬链接复用、Host identity 二次核对、Host 端
  发布后复验、连接失效和项目稳定配置事务继续作为唯一实现。

## 迁移

- 已保存 Host 打开设置时只显示本地记录，不自动连接或检查版本；用户点击对应 Host 的
  “刷新版本”后才执行只读状态探测。项目切换不依赖该按钮，也不建立连接。
- 数据库升级保留远程项目、Host ID、远端路径、Runtime 选择及关联会话/任务，并删除旧的
  Agent/Runtime/Workspace/Host 验证列和 Runtime 验证表。下一次实际远程操作从 Host
  current 环境重新取得所有 live identity。
- 如果 Host 未就绪或版本不兼容，项目仍可在本地选择，但实际远程操作失败；不再走旧的
  隐式安装。
- 已下载或导入的本地 `.gbagent` 保持可用，不能因加入远程直连而迁移或删除。
- 远程直连继续使用现有 package format version 1，不要求归档携带 installer，也不要求
  目录声明额外的 bootstrap 能力元数据。

## 验收标准

1. 新 Host 保存和探测完成后不会自动下载、上传或安装任何包，也不存在自动安装开关；
   再次进入 Host 设置不会逐台连接，只有显式“刷新版本”才探测目标 Host。
2. Host 卡片只有一个按版本事实命名的主按钮；次级 SegmentedControl 提供默认且不持久化的
   “自动”及显式“Host 下载”“GoodBuddy 传输”。没有预装 Agent、Node 或 Runtime 的 Host
   可以完成准备；远程下载不可用时可手动改用 GoodBuddy 传输。
3. 探测不下载完整包，失败不阻止保存 Host；非确定性探测失败不禁用直连重试，安装失败
   或取消后 Host 仍可重试。
4. 直接下载严格匹配签名目录中的 URL、大小和 SHA-256；GoodBuddy 传输可在同一次操作中
   下载并验证缺失候选，以有界流式 SFTP 上传完整归档和已验证 bootstrap Node。Host 对
   两者完成相同的外层与内层签名、路径、架构、协议和 payload 校验。
5. 相同 Node 在可验证且支持硬链接时不重复传输或写入；相同 Runtime digest 不重复安装。
6. 创建、打开和切换项目不会产生 `.gbagent` 下载、Agent payload SFTP 上传或安装目录发布。
7. 未就绪 Host 不能创建远程项目；已有项目仍可本地选择，但远程操作失败并引导到 Host 设置。
8. Host 编辑或更新后，引用项目使用 Host 管理的当前连接和 current registry，不读取项目
   中的旧 Host/Agent/Runtime/Workspace identity；当前环境无效时才停止并要求在 Host 管理
   中修复。
9. Host 地址、用户或 Host Key 在准备期间变化时停止候选发布，旧身份不会被重新启用。
10. GitHub、北京镜像、无公网 Host、取消、应用退出、磁盘不足、损坏下载和不支持架构均有
   明确结果，且不触碰 GoodBuddy-owned 目录之外的文件。
11. Linux x64 和 arm64 均通过 GitHub/北京镜像、取消、离线 GoodBuddy 传输，以及项目使用
    Host current 环境执行 Workspace/Runtime 操作的真实 Host 测试；这些真实 Host 验收当前
    仍待完成。
12. Host 不可达或远端目录不存在时，用户仍可从项目浮动管理入口删除本地项目；删除 Host
    会列出并本地清理全部关联项目，但不会连接 Host 或删除任何远端目录和内容。
13. commit 终态可在通道丢失后用 `commit-status` 只读恢复且不重放；Agent 或 Runtime
    adoption 失败恢复五个 metadata 文件的原字节/原缺失状态，确认 adoption 后显式 cleanup。
