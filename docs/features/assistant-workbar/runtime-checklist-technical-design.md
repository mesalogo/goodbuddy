# Runtime 执行清单技术设计

状态（2026-09-19）：本地与远程 OC/CN 提取、统一事件、消息保存和顶部展示已实现。
默认开发组包同时携带 OC/CN，远程 CN 已通过 Windows 桌面到 Linux x64 的真实模型
更新、取消、重启恢复及续发验证。验证范围与调用数见
[远程记录](../remote-host/runtime-checklist-validation.md#2026-09-19-联合包与完整桌面验收)。
需求、场景与顶部布局由 [PRD](./prd.md#131-runtime-执行清单)
维护，替换、隔离和终态规则由 [Runtime 交互边界](./runtime-interactions.md#runtime-执行清单)
维护。研究证据与交付状态见[进度](./progress.md#2026-09-15-runtime-执行清单设计未实现)。

## 1. 原生数据与提取位置

Implemented local behavior:

- OC sends a native-sortable `messageID` with both prompt and command submissions.
  Only assistant messages whose `parentID` matches that request can own checklist
  calls. Parent Session identity is checked independently of child-session routing.
  OC 1.18.29 emits `pending`, `todo.updated`, then `running` with complete arguments.
  The adapter retains native snapshots only while an owned call is active and
  submits a snapshot once its validated items match that call's original input.
  Calls and pending snapshots are request-local; no `session.todo` polling is used.
- CN extracts the exact `Checklist.checklist` argument in the patched native start
  callback and in native history before display truncation. Candidates survive
  success frames without input. A completed call commits once per call ID; failed
  calls and startup history do not commit. Ordinary tool events retain their limits.
- CN accepts blank lines and `- [ ]`, `- [x]`, `- [X]` entries with nonempty content.
  Empty or whitespace-only strings clear the list. Other nonempty lines invalidate
  the entire update. Native 1.5.47 accepts a string without Markdown validation;
  these are GoodBuddy's explicit projection rules, not additional native guarantees.

| Runtime / 路径 | 已确认格式与设计接入 |
| --- | --- |
| 本地 OC 1.18.29 | `todo.updated` 与 `session.todo` 返回完整条目列表，字段为 `content/status/priority`，无 item ID；以原生更新事件驱动本轮整份替换 |
| 本地 CN 1.5.47 | 精确原生工具 `Checklist` 的参数 `checklist` 是 Markdown 勾选列表，`- [ ]` / `- [x]` 表示未完成/完成；按一次成功调用提交完整替换 |
| 远程 OC/CN | OC 1.18.29 通过原生 todo.updated，CN 1.5.47 通过成功 Checklist 参数进入 Agent transcript；Linux x64 清单与重放已实测，CN 同时验证取消后续发，见[远程记录](../remote-host/runtime-checklist-validation.md) |

`opencode-runtime.ts` 当前将普通工具 input 经 `boundedToolDetail(..., 4_000)` 转成
展示字符串。接入应在 SDK 原始事件层消费 `todo.updated`；如需核对 `todowrite` 参数，
必须在该截断之前处理。`session.todo` 是 Session 当前快照，读取结果必须与请求生命周期
关联；不在每轮开始时无条件读旧快照充当新清单，也不轮询代替事件。

CN 的提取位置在 `continue-host-adapter.ts`：宿主产生工具事件、HTTP 状态合并及输入
校验均存在 4,000 字符展示限制，不能等到 `continue-runtime.ts` 收到截断字符串后再解析。
宿主应在最早的原始参数层提取 `checklist`，按工具调用 ID 保留候选，结合最终成功状态
提交；成功帧省略参数时使用同次调用的候选，失败不得提交。普通工具事件继续沿现有路径
流转。超出 4,000 字符的清单需要独立验证完整性，但不扩大所有普通工具输入的展示上限。

Markdown 解析只适用于已确认的 CN `Checklist.checklist`，不扫描助手正文或其他工具
输出。空数组在统一事件中明确表示清除；CN 空字符串或仅空白的字符串表示清空。
解析规则见上文；无效输入保留旧清单，不能误当清空。

## 2. 统一事件与消息归属

The shared contract is `src/shared/runtime-checklist.ts`: `runtimeChecklistSchema`
and `RuntimeChecklist { source: 'opencode' | 'continue', items }`. Each item has
`content`, `status: pending | in_progress | completed | cancelled`, and optional
`priority: low | medium | high`. `AgentEvent` carries
`{ type: 'checklist', requestId, checklist }`; conversation messages carry optional
`runtimeChecklist`. Empty arrays are valid replacements. Existing IPC event
transport forwards them without a separate channel or tool-input parsing.

本地 Renderer 按请求映射更新助手消息并沿既有保存入口落库；远程 Main 使用既有事务
投影更新消息。顶部读取所属请求消息的最新有效状态。
同一请求若同时观察到原生清单事件与其工具记录，只以前者更新清单，后者保留活动；不能
提交两次替换。原生父 Session、请求开始/结束边界需共同校验，子 Session 或旧请求事件
不得通过当前活动请求映射到新轮。

The existing message metadata serializer and every database message reconstruction
retain `runtimeChecklist`, including remote event projection and terminalization.
No SQLite schema migration or separate checklist store is needed.
历史清单与所属助手消息一起保存。
远端沿用事件提交、消息投影和 ACK 的既有事务及去重规则；相关存储边界见
[执行记录存储](./execution-history-storage.md)。实施前核对本地会话与远程任务实际落库
字段，选择能复用的最小表示。不新建清单数据库、独立快照系统、恢复日志或持久化服务。
旧消息没有结构化清单时保持缺省，不从已截断工具字符串或状态文案补造历史。

## 3. 远程 Agent 与 ACP 复用

远程传递复用以下实现：

1. `AgentAcpConnection` 按原生 `sessionId` 分派 `sessionUpdate`；
   `AgentOwnedAcpPrompt` 校验 Session 后，以 `bindingId/operationId` 将通知写入
   既有 semantic transcript。
2. `ProtocolRemoteRuntimeChannel` 已有 transcript 读取/ACK、身份核对，以及 ACP
   channel 恢复与重放；`AcpRemoteRuntime` 消费 `session-update` 并转换桌面事件。
3. OC 插件转发原生 `todo.updated`，CN 宿主将成功清单写入 `_meta.goodbuddyChecklist`；
   `AcpRemoteRuntime` 校验归属和结构后产生统一清单事件。标准 OC `plan.entries` 也有
   映射，但 OC 1.18.29 实测走插件事件。Markdown、URI 和普通状态文字不生成清单。

优先复用上述通知和 transcript，不另建远端清单通道。对实际 OC/CN 部署确认过的
`plan.entries`，或已确认等价的 `plan_update` items，校验条目字段和状态后转成统一
清单事件。普通 `status`、plan markdown/URI、`plan_removed` 文案以及泛化工具名均不
触发清单更新；在没有确认对应原生清单身份前，`plan_removed` 也不能清空顶部。

若远程原生输出走精确清单工具，须确认原始参数、调用身份与成功状态确实贯穿 Agent，
再按同一提取规则接入。是否能直接复用原生 entries，或需补充最小 Agent 适配，取决于
真实格式证据，不能根据 ACP 类型定义推断 OC/CN 一定会发送。ACP 是协议，Runtime 身份
仍为 OC 或 CN。

受管安装、校验、项目创建与聊天选择已接入 CN；Agent 在 Host 运行固定 CN HTTP 宿主，
复用本地适配器和已有模型桥、请求归属、取消及恢复。开发包与 Linux 验证、联合分发和
完整桌面验收的剩余范围见[远程记录](../remote-host/runtime-checklist-validation.md)。

重连按[既有 ACP 与断线规则](../remote-host/technical-design.md#acp-与断线)执行。
已接受 Prompt 使用原 binding/operation 恢复，清单从已提交消息和其后的既有事件恢复；
重复事件不重复展示。连接丢失不表示条目完成，不为恢复清单重新发送 Prompt、模型请求或
工具调用，也不新增独立重连机制。

## 4. 顶部布局

`ConversationTaskStrip` 与 `RuntimeChecklistStrip` 共用顶部容器，任务在上、清单在下，
各自展开和折叠。没有 Task 时清单仍可显示；远程会话也保留清单入口。总高度不超过
45vh，各自展开内容不超过 20vh 并内部滚动，标题不收缩。清单内容区可用键盘聚焦和滚动。

状态文字与条目首行按文字基线对齐，状态图标单独居中。CN 不推断进行中或优先级。
新轮先选择本轮消息，再读取清单，不回溯寻找旧轮非空清单。后台更新保持展开状态和焦点。

## 5. 实施与验收

| 阶段 | 必须完成的工作 | 对应需求 |
| --- | --- | --- |
| CL-P1 | 原始层提取、严格格式校验、统一事件及请求归属；保留工具活动 | FR-CL1–FR-CL3 |
| CL-P2 | 消息投影和既有存储恢复、顶部只读布局、空数组清除及终态展示 | FR-CL2–FR-CL4 |
| CL-P3 | 确认远程 OC 原生格式，补齐远程 CN 真实部署与事件接入，复用 Agent 传递和恢复 | FR-CL1、FR-CL4 |
| CL-P4 | 本地与共享 Linux 真实 Host 逐项验收，记录版本、结果、调用口径与剩余阻塞 | FR-CL1–FR-CL4 |

以下为产品验收范围；已执行项和未覆盖项分别记录在进度与远程验证记录中：

- 本地 OC/CN 各经桌面正常发送路径产生并连续修改清单，检查新增、修改、重排、删除、
  重复文本、有效清空及超过 4,000 字符的完整内容；CN 成功才替换，失败保留前值。
- 同会话连续两轮、并行会话、切换 Runtime/项目/执行空间、旧轮迟到事件和子会话事件
  不串数据；完成、失败、取消不改写条目状态。默认 DS、任意 status/Markdown/list
  工具不生成伪清单，工具活动仍可查。
- 本地会话重新打开及应用重启恢复历史；顶部折叠、键盘操作、浅深主题、窄窗口和 200%
  缩放符合 PRD，保存与重放后的空清单不会恢复旧内容。
- 在共享 Linux x64 真实 Host 使用开发中的 Agent 与实际部署的 OC/CN，分别从远程项目
  完成原生清单更新、取消、断线续接及历史恢复。沿用
  [Agent 开发验证规则](../../../AGENTS.md#goodbuddy-agent-development-validation)，
  LAN/VPN 是同一机器的两条路径，不能计作两台 Host。
- 逐个记录 OC/CN 的安装、启动、模型请求、清单传递、顶部显示、取消和重连结果；基础
  Runtime 成功不等于清单通过。任一步未执行写“待验证”，被外部条件阻塞则记录原因，
  不以 mock、协议 fixture 或本地成功代替远程验收。
