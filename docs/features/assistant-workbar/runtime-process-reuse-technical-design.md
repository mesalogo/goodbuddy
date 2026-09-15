# Runtime 进程复用技术设计

## 1. 状态与结论

| 项目 | 内容 |
| --- | --- |
| 状态 | 已接入本机与 Agent 生产源码，Windows / Linux x64 验证结果及边界已记录，未发布 |
| 日期 | 2026-09-15 |
| 调研源码 | `de14a6157a6c34f1e3ef22619eca374a50a83706`；相关 Runtime 与 Desktop 0.13.2 一致 |
| 需求 | [工作栏 PRD §14.1，FR-RR1–FR-RR6](./prd.md#141-runtime-资源复用) |
| 行为规则 | [Runtime 资源生命周期](./runtime-interactions.md#runtime-资源生命周期) |
| 验证事实 | [实施与验证记录](./progress.md#2026-09-14-runtime-进程复用实施中)，原始调研记录保留在同页 |

**修复对象是进程所有权过细，不是工具太多，也不是历史记录应该删除。** 本机 OpenCode
和 DeepSeek Harness 应在兼容启动配置内共享重型进程，工作区与会话上下文仍各自独立。
远端 OpenCode 必须同时调整 Agent 进程所有权、ACP 连接和模型桥，不能把桌面修复当作远端
修复。Continue 的锁定版本是单会话 Host，不做未经验证的常驻进程池；直连模型没有独立
模型进程，应检查对象、历史和工具资源的生命周期。

“一个进程”指一组兼容启动配置对应一个 Runtime Server/Host，不是把不同 Runtime、
不同 SSH 账号、不同插件组合强行塞入一个进程。正常工具命令产生的短期子进程不属于重复
Server，也不能通过关闭 Shell、子代理或 MCP 来达成进程数指标。

## 2. 修复前证据与缺陷

### 2.1 已测现象和解释边界

Windows 已安装 0.13.2 的只读采样发现两个属于同一 App 的 OpenCode Server：一个原生
数据库为 0 Session / 0 Message，约 527 MiB Private Commit；另一个已有会话并执行请求。
两个 Server 的启动工作区不同。源码能解释“清单查询也可启动按工作区缓存的 Runtime”，
但没有取得能独立证明空 Server 最初由哪一个 UI 操作启动的调用链记录。

该缺陷不等于整个 App 内存的唯一来源。五分钟活跃采样的 App 相关进程 Private Commit
约 3.15–3.78 GiB，CPU 平均占整机约 3.15%；后续一分钟包含新任务，不是空闲回收试验。
数据库五分钟增长约 2.72 MiB，新增子代理负载约 1.49 MiB，重复工具 upsert 为 0。
schema 35 的存储修复与本方案独立，不能回退或删历史来改善指标。

同次源数据检查还发现最近 100 个会话的消息 metadata 合计约 107.75 MiB，
`listConversations()` 会读入这些会话的全部消息详情。它是 Renderer 大对象加载的明确
检查方向，不是堆快照已经证明的泄漏。进程复用不能代替历史按需加载的独立性能工作。

### 2.2 调研基线的源码归属

| 位置 | 已确认行为 | 修复含义 |
| --- | --- | --- |
| [SelectedRuntimeManager](../../../src/main/agent/selected-runtime-manager.ts) | 缓存键包含原始 selection 与 execution-space identity；默认 8 个缓存、16 个保留实例；只在容量压力下淘汰 | 轻量工作区适配器和重型进程不能继续按同一键、同一数量计费 |
| [AgentRuntimeController](../../../src/main/agent/runtime-controller.ts) | `canRetire` 同时要求无请求、无 owned conversation；普通完成不移除会话所有权 | 不能把“已完成请求”和“已释放原生会话”混为一谈 |
| [本机 OpenCode](../../../src/main/agent/opencode-runtime.ts) | 对象私有 Server/client/初始化 Promise；已有多会话映射；多个入口使用固定 `defaultWorkspace` | 仅删除 manager 的 workspace 键会把后续操作送进错误目录 |
| [DeepSeek Runtime](../../../src/main/agent/deepseek-harness-runtime.ts) | 每对象一个 Utility Host；`getStatus()` 调用 `getState()` 启动 Host | manager 的临时状态实例会额外启动、探测并销毁 Host |
| [Harness Host](../../../src/main/deepseek-harness-host.ts)、[控制面](../../../src/main/agent/goodbuddy-harness-control-plane.ts) | 根 Provider 有 cwd 默认值；控制面拒绝与 Host workspace 不同的 `newSession.cwd` | 限制主要在 GoodBuddy 创建入口，不是原生工具缺少会话 cwd |
| [Continue Host Adapter](../../../src/main/agent/continue-host-adapter.ts) | 每次 run 启动临时 Host，最终 `/exit` 与进程树回收；准备结果已在 adapter 内缓存 | 不重复添加已有缓存；研究跨 adapter 重复准备，不直接共享活动 Host |
| [直连模型](../../../src/main/agent/model-runtime.ts) | Main 内 HTTP；历史 Map 按 50 个会话限制，其他归属及工具资源依赖 release/dispose | 没有可合并的常驻模型子进程，按对象和资源检查 |
| [远端 ACP](../../../src/main/agent/acp-remote-runtime.ts)、[Agent backend](../../../src/agent-daemon/runtime-acp-backend.ts) | 会话取得 binding/channel；backend 按 binding 拥有进程并拒绝跨 binding 复用 process identity | 必须拆开会话绑定与进程所有权 |
| [Agent-owned Prompt](../../../src/agent-daemon/agent-owned-acp-prompt.ts)、[模型桥](../../../src/agent-daemon/model-bridge-helper.ts) | owner 一个 ACP connection/session/当前 operation；helper 固定模型和工作模式并串行 dispatch | 共享进程还要求会话路由、请求归属和取消隔离 |

原始 selection 的 `auto`、默认 profile 和显式 profile 可能解析为同一有效配置。当前
已确认“先按原始 selection 建键、后解析配置”的顺序，但尚未证明全部 UI 调用会实际生成
等价重复实例。实施时从 [runtime-selection](../../../src/main/agent/runtime-selection.ts)
和调用者验证，不把可能性记为另一次生产复现。

### 2.3 锁定依赖与协议基础

以仓库 lock 和本机已安装代码为准，不用最新网页替代锁定版本：

| 依赖 | 基线 | 本次核验 |
| --- | --- | --- |
| OpenCode binary / SDK / plugin | 1.18.29 | HTTP API 接受 directory；ACP 接受多个 Session；`chat.headers` 有 sessionID |
| ACP SDK | 0.25.1 | 一条连接关联多个 request ID，session notification/permission 带 sessionId |
| DeepSeek Harness 包族 | 0.1.2-rc.1 | Agent factory/scoped context、Session header.cwd、真实文件与 Shell 工具 |
| Cordis | 4.0.2 | Host 根组件与 Agent scope 的生命周期 |
| Continue CLI | 1.5.47 | 实际受管补丁入口的单 `M.session`、QuizService 和权限状态 |

已通过的三个隔离探针：

1. **OpenCode HTTP**：调用当前生产 Server launcher，只有一次 spawn；同一个 SDK client
   在两个目录创建四个 Session，读取各自的同名文件；删除一个 Session 后其余三个仍可取回。
   没有调用 `Runtime.run`、模型或活动取消。
2. **DeepSeek 工具**：当前 Host composition 和真实 Agent factory 在同一 Node 测试进程中
   创建两个不同 cwd 的原生 Agent；并行执行真正的 `read`、`write` 和 PowerShell，
   同名相对路径各自命中正确目录。另确认生产控制面仍拒绝第二工作区。没有启动 Electron
   Utility、ACP Prompt 或模型流，不能据此声称生产多工作区已经可用。
3. **原生 ACP 与模型归属**：Windows 上一个 1.18.29 `opencode acp` 进程、一条 ACP
   connection、两个工作区 Session；分别选模型并发出并行 Prompt。本机确定性 HTTP
   服务收到两次请求，原生 `chat.headers` 插件传来的 sessionID 分别匹配两个 Session。
   不经过已发布 Agent backend/helper，没有测试真实工具、子代理、Linux 或断线恢复。

三个探针真实模型调用均为 **0**，其中第三个有 **2 次本机合成提供方请求**。
它们证明方案有原生基础，不替代后文的真实开发任务验收。

特别纠正：`dsh-tool-fs` 将 `exec.agent.session.header.cwd` 传给 `fs.resolve`；
`dsh-tool-bash` / `dsh-tool-pwsh` 也从 Session cwd 补全相对 workdir。
`dsh-fs-local` / 本地 Shell 的根 cwd 是非会话调用的默认值，不是工作区隔离边界。
不需要为这个已具备的能力新建一套“每工作区 Filesystem/Shell Provider”。

官方背景资料：[OpenCode Server](https://opencode.ai/docs/server/)、
[DeepSeek Harness](https://www.deepseek.com/harness/en/)、
[Continue CLI](https://docs.continue.dev/cli/quickstart)。
网页只用于核对产品入口；上述版本结论来自本地锁定代码和探针。

## 3. 选定的结构

### 3.1 两层对象，不建立通用进程池框架

```text
SelectedRuntimeManager
  -> 轻量 Runtime adapter（有效 selection + execution space）
       -> OpenCode process owner / Harness Host owner（兼容启动配置）
            -> Session binding（execution space + conversationId）
                 -> 当前 requestId / 原生 sessionId / 工作目录
```

- 保留 Main 已解析、校验的 execution space；adapter 每次将其显式交给共享 owner。
  目录不是 Renderer 新增的任意启动参数，也不依赖 `process.chdir` 或进程级可变 cwd。
- owner 持有唯一启动 Promise、client/connection、子进程、会话映射与关闭逻辑。两个
  工作区同时冷启动时复用同一 Promise；一个调用者取消等待不取消其他使用者的启动。
- adapter 的 `dispose` 只释放其引用，不直接关闭同组进程。会话映射由 owner 持有，避免
  adapter 缓存淘汰丢掉原生续接。会话操作通过 binding 查目录，不从“当前选中项目”反查。
- 设置重建沿用现有 reset/drain：新请求取得新配置，旧请求持有启动时的配置直到结算。
  旧配置不再有在途使用者后释放旧绑定和进程，不能被历史会话 ID 永久钉住。
  IPC 的 Runtime 设置、定制及能力更新不再主动取消全部请求或清空审批；controller
  退役仍允许回答其已拥有的问题，但拒绝新请求和未知问题。
  既有专家调度器仍在配置替换时取消专家子任务，团队父请求一起停止，防止用新模型
  汇总旧 generation 的部分结果；不为该单独生命周期新建通用退役框架。
- 8/16 的旧上限不应继续限制轻量项目 adapter 数量。若保留重型 owner 的容量保护，
  应统计实际进程配置组及退役进程；不靠提高常数掩盖“一项目一进程”。
- 只用进程内 Map、现有 controller、Promise 和普通定时器。会话历史仍以现有 SQLite /
  Agent transcript 为准，不增加数据库表、迁移、持久化池快照、恢复日志或新配额。

### 3.2 兼容键与上下文

先通过 `applyRuntimeSelection` 等现有解析取得有效配置，再生成进程键；公开的 selection
仍按现有语义保存，不能把“跟随默认”永久改写成某个显式 profile。

| 范围 | 参与进程兼容性 | 留在会话/请求 |
| --- | --- | --- |
| 本机 OpenCode | 本机账号、二进制身份、有效模型连接/配置、启动环境、原生配置和插件组合 | 目录、conversation/session、Prompt、模式、当前权限和问答、请求级 MCP/知识 token |
| 本机 Harness | Host/依赖版本、有效模型连接、图片能力、凭据引用、启动环境、启用插件及配置、启动 Skill 集合 | cwd、conversation/session、请求模式、Main Web/MCP 代理与用量归属 |
| SSH OpenCode | 已有 Host/SSH 身份、Agent/Runtime installation identity、模型协议/连接、原生插件与启动配置 | Workspace、binding/session、operation、请求凭据和账本归属 |

第一轮只合并同一有效模型连接及等价默认选择，不顺便支持任意不同模型连接共享：
本机 OpenCode 配置使用固定 provider ID，Harness 用量也读取 Host config，跨 profile
混用会引入另一项真实风险。不同 profile ID 不通过比较或序列化明文 API Key 来合并；
密钥、Header 和插件配置更新通过现有设置失效路径使旧 owner 退役。

调研基线的 SSH launch profile 把 workMode 写入原生启动配置。当前实现把工作模式
放入 Session/当前 Prompt 路由，并设置原生 Session 工具规则，详见 §6.1；
不能仅从兼容键中删除 workMode，也不向用户增加逐工具审批。

## 4. 本机 OpenCode

在 [opencode-runtime.ts](../../../src/main/agent/opencode-runtime.ts) 中抽出重型 owner，
由 [create-runtime](../../../src/main/agent/create-runtime.ts) 的 Main composition 复用。
保留工作区 adapter，逐项替换隐式 `options.defaultWorkspace`：

1. create/get/delete Session、Prompt、历史初始化和压缩。
2. 原生能力、工具、文件、Skill、MCP 查询的 directory。
3. SSE 订阅、父子 Session 归属、待答 question 的 directory 与原生 ID。
4. 权限更新、abort、问题答复/拒绝、MCP 临时注册及最终清理。

会话绑定记录规范化绝对目录及原生 sessionId。同一 conversation 的请求继续串行，
不同 conversation 并行，不引入覆盖整个 Server 的 Prompt 队列。
现有 `snapshot: false` 必须保留。

`mcpMutationTail` 目前属于 Runtime 对象；共享后同一原生目录的变更必须由同一 owner
串行协调。注册名称、工具可见性、knowledge token 和清理仍按请求区分，不能用一个全局
“当前 MCP 列表”覆盖同目录或跨目录的其他请求。探针未覆盖动态 MCP，这是实施验收项。

第一轮保留现有按请求消费事件流和结束清理的方式，扩展目录及 Session 过滤即可。
只有测出重复 SSE 消费是瓶颈时才另做 owner 级事件分发，不同时引入第二套事件总线。
健康检查也读取 owner 的总 activeRequests，不能从一个空闲 adapter 判断整个 Server
无任务后重启。异常退出使该 owner 的全部绑定失效，明确结算受影响请求，不重放已执行工具。

## 5. DeepSeek Harness

### 5.1 共享 Host 的最小改法

- 将 `HarnessState`、Utility 启动 Promise、ACP connection 和事件路由提升到兼容配置
  owner；Runtime adapter 保留请求工作区。
- 每个新 Session 在 Main 解析 `realpath`，Host 校验绝对路径格式，
  不再要求它等于 Host 启动工作区；`meta.cwd` 传入已有 Agent factory。
  不依赖 Windows 大小写字符串猜测，也不取消路径存在性校验。
- 保留一个本地 Filesystem、Subprocess 和平台 Shell Provider。Session 使用原生 cwd
  路由；非 Session 的清单查询显式传入查询工作区，不能回退到第一个项目。
- 保留 `setup(agentCtx)` 注册 Skill 和工具视图、每 Session 的 Ask definition 身份校验、
  `sessionId + requestId` 准备及事件路由。Main 的 Web/MCP callback 按对应请求找
  ToolProvider，不挂到某个最先创建的 adapter 上。
- 第一轮保持同 profile、图片能力和插件组合共享，`queueUsage` 的模型配置因此仍一致。
  给用量加跨会话断言，不借本次改造扩大跨模型 Host 能力。

第三方插件的初始化可能依赖配置中的路径，不能因为内置工具支持 cwd 就声称所有插件
天然多工作区安全。已启用插件组合属于进程配置；对实际产品支持的插件验证它使用
Agent scope/Session cwd。若某插件确实有项目级初始化状态，将该状态显式作为不兼容
启动配置，而不是默认给所有工作区各起一套 Provider 或禁止 Execute 工具。

### 5.2 状态与取消

被动 `getStatus` 改为已有 owner 快照或本地配置/Host 资源检查，不调用 `getState()`。
没有启动过时不能写“握手已验证”，可表示资源已安装、尚未连接。
状态检查不取得执行引用，也不清除或重置无会话 owner 的空闲计时；owner 已回收时，
临时配置检查对象用完即释放，不将其登记成新的执行 owner。
用户显式连接测试与原生清单可启动共享 owner；已有 owner 时只做有界控制检查，最终
释放的是检查引用，不能在 `finally` dispose 掉仍服务其他会话的 Host。

当前取消超时会 terminate 整个 Utility。共享后先取消并释放目标 Session 的 Agent /
工具资源，不因一个请求结算较慢就杀掉仍健康服务其他 Session 的 Host。若真实控制面
已失去响应，保留整个 Host 的有界终止，向受影响会话分别报告中断；不得把它说成
“取消完全不影响其他任务”。同步插件卡死的进程级故障无法在同一 JS 进程中强行隔离，
不为此新增通用恢复框架。普通长工具取消与整 Host 故障必须分开测试。

## 6. SSH OpenCode 与 Agent

本节定义当前源码的共享进程改造；当前已发布版本仍见
[远程技术设计](../remote-host/technical-design.md)。不能删除或绕过其持久 binding、
operation、transcript、ACK 和模型 dispatch 结果不确定性规则。

### 6.1 连接与所有权

将 `RuntimeAcpBackend` 的进程 owner 与 binding 分开：

```text
Agent 当前 Runtime installation + 兼容配置
  -> 一个 process owner / 一条 ACP ClientSideConnection
       -> sessionId -> binding -> 当前 operation / 原始 Prompt Promise
```

- 一条 stdio 流只交给一套 ACP decoder/connection，不能让几个 ClientSideConnection
  竞争读取同一 stdout。消息和 permission 按 sessionId 分派给 binding 的当前 operation。
- `AgentAcpConnection` 统一连接级握手、stdio 解码与退出监听，Prompt
  生命周期仍留在 binding。同一 Session 串行，其他 Session 不等待它完成。
- `closeAcpChannel`、取消和 release 只释放所属 binding/Session；最后一个 binding
  离开后空闲 60 秒关闭进程。关闭 Session 时等待原生 `closeSession` 和原始 Prompt
  结算，不等待排在 backend 控制队列后面的完成回调。只有原生控制面不响应时才有界
  终止共享进程，并向其余请求报告中断，不声称这类故障可以逐 Session 隔离。
- terminal 与物理进程状态分开：取消/失败的 Session 也可返回
  `processTree: running`，表示进程继续服务其他 Session，不能伪报进程树为空。
  Desktop 与 Agent 须使用配套的新契约；原始字节透传 binding 仍保留独占进程规则。
- 共享 stdio owner 不使用单 Prompt 的累积输入和墙钟期限管理整进程；单次写入、
  待写队列、输出背压继续有界，Prompt 输入与截止时间由 binding 管理。
- SSH attach 仍不拥有活动 Prompt，断线不能取消或重发 Agent 已接受的工作。
  历史 binding 的语义和原生 sessionId 保留；内存进程索引从当前安装和已有绑定得出，
  不增加第二份持久进程恢复账本。
- 同一 PID 的多个 binding 不代表同一权限或同一 operation。Host/installation identity
  变化仍使用已有失效和退役规则，不把不同 Host、账号或 Runtime generation 合并。

原生 `chat.message` 在模型请求前设置该 Session 的工具规则：Execute 允许工具；
Ask 只开放原生只读、搜索和读取网络内容的工具，不开放 Shell/编辑/写入。
OpenCode 1.18.29 的 ACP 不转发未注册子 Session 的权限请求，且原生子代理只继承父
Session 的拒绝规则、不继承允许规则，因此子 Session 也按根 Prompt 设置规则，再
保留原生子代理的显式限制。不能只把进程启动配置统一设成 `ask`，否则子代理工具会等待。

### 6.2 模型桥归属

选用锁定 OpenCode 已有的 **`chat.headers` 会话标记**，扩展当前受管
[原生插件](../../../src/agent-daemon/opencode-subagent-plugin.ts)，不靠解析正文、猜测
“当前最新 Prompt”或重写用户模型名来路由：

1. 现有 Agent prepare/start 顺序在 helper 的进程内登记 Session/根 Session 与
   binding、operation；插件从原生 sessionID 及已建立的父子关系取得精确归属。
2. 在请求生成时固定所属 operation，将有界内部归属 Header 加到 loopback 模型请求。
   归属必须覆盖原生子代理、自动/手动压缩，不能等 HTTP 到达后才绑定“目前活动的请求”。
3. helper 检查它是否仍属于已登记的 Prompt，选择对应现有 Agent gateway/凭据上下文。
   转发真实提供方前剥离内部 Header；不将其当作密钥或新增认证体系。
4. 当前 helper 的单 socket/全局 dispatchBusy 改成按 operation 隔离的派发状态；
   每个 operation 的现有轮次、顺序、字节和结果不确定性规则不变，取消 A 只关闭 A 的
   提供方流，不关闭 B 的 socket、response 或待处理请求。
5. Prompt 终态撤销对应映射及凭据；迟到请求不能借用下一轮 operation。保留
   `snapshot: false`、关闭不消费的 title 请求和现有父子问题转交。

普通 ACP 双 Session 的 Header 路由已有探针证据；子代理、压缩和终态竞态的实际
验证结果以进度记录为准。若锁定版本某条实际调用路径不触发 hook，先定位那条原生路径，
不得悄悄用全局串行 Prompt 或一个共享凭据槽冒充并行复用。
内部桥字段如需调整，按既有受管 Agent/Runtime 版本配套交付，不移动发布标签，不给
旧 Agent 宣称具备新行为。

### 6.3 恢复与终态投影

- Agent-owned 语义 Prompt 不一定产生原始 ACP journal 行。binary replay 仍校验现有
  cursor 边界，但不存在 raw cursor 时不向 journal ACK 0；不虚建记录来满足 replay。
- 同一 Agent 断线恢复后，保留的 Session binding 使用新 transport generation，
  Runtime 可以同时接纳新 Session。安装身份已经更换的 attach-only 请求明确失败，
  不能无限重试阻塞项目，也不能借此重发旧 Prompt。
- Desktop 重启时，同项目的可恢复任务并行附加，不能等待一个待答 Prompt 结束才附加
  第二个。live `question`/`question-resolved` 不属于有 provenance 的 transcript，
  使用既有 pending Map，清除时只影响对应 request/question。
- `conversations.list` 将恢复租约的 request/message ID 和待答列表投影为可选
  `activeRequest`，Renderer 合并表单并使 Stop 指向真实请求。保存 header/消息时不保存
  这个实时字段。回答/跳过成功由 Main 按 task → assistant message 归属更新既有
  `answeredQuestions`，不写另一份问题日志，不覆盖流式正文、已完成或失败状态。
- 明确确认的取消使用现有消息/任务终态事务一并结算，避免 Task cancelled 而消息仍
  streaming。仍无法确认的 Stop 保持可恢复；连接中断本身不是已取消或已失败的证据。

## 7. Continue、直连模型与相邻内存问题

### 7.1 Continue

保留每请求 Host 的隔离和最终清理。1.5.47 的单 Session、QuizService/权限队列意味着
“一个 HTTP Server”不等于可安全承载多会话；这一例外有锁定源码依据。

`getPreparedHost()` 已缓存本 adapter 的准备 Promise，磁盘也有按内容确认的补丁产物。
先分别测量读取/哈希/补丁准备、Utility 启动、HTTP ready、首个提供方请求和退出耗时。
若确认跨 adapter 重复准备明显，再将只读准备结果与启动 Promise 按已验证的 CLI
identity/补丁版本放到 Main composition 复用；失败仍允许重试。不得复用临时 config、
token、global dir、活动 Session 或权限/问题队列。设置替换及窗口状态刷新也纳入测量。

不在本次给 Continue 加多 Session 补丁或常驻池。将来只有锁定版本真正支持多 Session
且生产桥验证通过，才替换这一实现。

### 7.2 直连模型及历史详情

- 不新增模型 Utility 或进程池。检查 `conversations`、`knownConversationIds`、
  summary、ToolProvider 与 DirectModelProcessService 的实际引用与 release 调用链。
- 活动请求、会话可续读的有界输出和数据库历史是不同资源。请求结束回收临时闭包/
  callback；会话释放才结束其可续读输出和工具资源，不在工具刚完成时删掉用户可查看结果。
- 当前 50 个会话的 history 限制不是字节上限。先采堆与 retained size，再决定可从
  SQLite 重建的历史缓存是否使用字节约束和 LRU，不能先增加一套持久历史副本。
- Renderer 最近 100 个会话整包 metadata 加载另做列表摘要、当前会话分页、展开后取
  详情的性能改造；本方案只记录依赖，不将这一尚未设计完成的 UI 改造算进进程修复交付。
  必须保持完整历史、搜索、重新打开和当前活动事件可用。
- 旧 Runtime 磁盘缓存可单独评估版本清理策略，不在本次研究或进程 idle 时删除安装、
  用户工作区、数据库、备份或历史。

## 8. 内部实施顺序

| 阶段 | 具体工作 | 必须产出的证据 |
| --- | --- | --- |
| P0 | 固化本次原生探针为聚焦回归；补有效 selection/进程计数和状态启动计数 | 修复前能复现重复启动，失败原因不依赖真实用户配置 |
| P1 | Main composition、兼容键、owner 与 adapter 生命周期；本机 OpenCode 全入口目录化 | 真实 UI 两项目四会话同一 Server，文件/工具/问答/取消不串线 |
| P2 | DeepSeek 共享 Utility、会话 cwd、被动状态、请求级代理及取消收敛 | 实际 Utility/ACP 两项目四会话，原生工具与插件验证，状态刷新无额外 Host |
| P3 | Agent process/session owner、ACP 单连接路由、Header 模型桥、权限和终态清理 | 开发中的真实 Linux x64 Host，含多会话工具、断线/重连和结果不确定性 |
| P4 | 全 Runtime 资源回归；Continue 冷启动分解与有证据的准备复用；直连对象释放检查 | 相同输入的前后进程/内存/CPU/磁盘/延迟报告；没有残留测试进程 |

这是依赖顺序，不是发布一半实现的许可。涉及的正常生产 UI 路径、远端专用修复和下节
验收全部完成后，才能称为 Runtime 复用修复。Continue 测量若没有显示重复准备成本，
明确记录不改；不要为凑齐阶段增加代码。历史 UI 分页是后续独立工作。

## 9. 验收与性能比较

### 9.1 必测场景

| 编号 | 对应需求 | 场景与通过条件 |
| --- | --- | --- |
| V1 | FR-RR1、FR-RR2 | 全新 profile 仅查看状态、切换设置，OpenCode/DSH 重型启动次数为 0；已有 Host 时刷新不新建；清单与首个真实请求并发只有一次初始化 |
| V2 | FR-RR1、FR-RR3 | 同一有效模型连接，两个独立项目各两会话同时自然开发，OpenCode/DSH 各一重型进程；各项目同名不同内容文件、命令 cwd、Git/测试结果都正确 |
| V3 | FR-RR3 | 第二轮复用同一批会话；Ask/Execute 混合，Ask 写入被边界拒绝，Execute 不增审批；Skill、MCP、图片能力、用量和业务问答不串归属 |
| V4 | FR-RR3、FR-RR4 | 一会话取消真实长工具/子代理时另外三会话完成并通过独立项目测试；分别检查请求 abort、SSE、问题映射和工具句柄释放 |
| V5 | FR-RR4 | 关闭面板不取消工作；释放一个会话不关闭共享进程；无会话 owner 空闲后退出；App 退出后本机受管进程无残留，远端按已有 detach 规则保留 Agent-owned 工作 |
| V6 | FR-RR1、FR-RR4 | 等价默认/显式选择复用；不同实际连接/插件配置不串用；配置更新期间旧请求完成，旧 generation 不永久积累；超过八个项目不因轻量 adapter 报重型容量满 |
| V7 | FR-RR5 | 当前源码 Desktop → SSH → 当前开发 Agent → 原生 Runtime，两个项目/四会话；断线、重连、取消、重复 ACK/事件、迟到模型请求不重复调用或跨 operation 归账 |
| V8 | FR-RR6 | Continue 并发请求仍各自正确清理；直连 HTTP 不生出额外模型进程；会话 release 后工具/分页输出资源释放；性能采样不靠删除历史或禁用工具达标 |

V2/V4 必须是正常开发任务，模型可自然调用读写、Shell、测试和已支持的原生子代理；
不是要求模型“不用工具”后回复一行。验证产出应用本身可运行、独立测试通过，模型口头
说完成不算完成。每个 Runtime 只验证它已经支持的能力，不伪造 DSH/Continue 子代理。

### 9.2 采样口径

- 使用同一源码变更前后、同一机器、隔离 profile 与等规模历史副本；不改写用户运行库。
  覆盖至少三次冷启动、五次热请求，以及三轮多项目任务和至少十分钟**确无新任务**的
  空闲观察。分别记录中位数、范围与实际样本数，不从一次采样推断泄漏已消失。
- 记录 Main、Renderer、Runtime 和工具子进程的 Private Commit、工作集/RSS、堆、
  CPU、PID/启动次数、会话数、活动请求、SSE/ACP 订阅与残留句柄。Windows 工作集求和
  会重复计算共享页，Private Commit 也不等于独占物理 RAM。
- 同时报首轮准备、HTTP/ACP ready、首个模型请求、首次可见输出和总耗时。降低进程数
  但把不同会话全局串行化，不能通过验收。
- 数据库/WAL 字节与新增事件负载分开；进程 I/O 包含管道，不能称为物理磁盘读写。
  继续检查未变化工具 upsert 为 0，旧历史读取/搜索/展开正常。
- 核心硬指标是每个兼容组一重型进程、无额外被动启动、无跨会话错误、无结束后持续
  增加的活动句柄、无重复提供方 dispatch。没有证据前不承诺“固定省 527 MiB”或
  “整个 App 降到某个 RAM 上限”；原生 Session 仍保留时必须单独说明其常驻成本。

### 9.3 源码与平台验证

定向覆盖 manager/controller、各 Runtime lifecycle、Harness Host/control plane、
ACP backend/owner、模型桥与插件，随后执行仓库要求的 `npm test`、`npm run typecheck`、
`npm run lint`；生产构建改动在开发阶段按仓库规则构建验证。

凡改变 Agent 或桌面到 Agent 路径，必须在开发期间按
[真实 Host 验证规则](../remote-host/technical-design.md#agent-开发期间的真实-host-验证)
使用当前源码的共享 Linux x64 Host 验证。Windows 原生 ACP 探针、旧版本 Host、mock、
CI 和将来发布测试都不能替代它。Windows PowerShell 与 Linux Bash 的工作目录及取消
分别验证；macOS/Linux arm64 生命周期与原生依赖由可用原生平台和 CI 补齐并明确报告。

当前源码的真实 Linux Host、完整生产 UI 和最终整仓门禁结果均保留在进度记录；
各次失败、修正、模型调用数及未测平台也一并记录，不以本机单测或原生协议探针
替代完整产品验收。完整 App 性能样本保留用户要求的按钮位置调整，属于包含该 UI
差异的实测对照，不是纯 Runtime 单变量实验。
