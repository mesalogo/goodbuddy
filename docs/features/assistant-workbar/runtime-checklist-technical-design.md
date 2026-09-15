# Runtime 执行清单技术设计

状态：设计阶段，尚未实现。需求、场景与顶部布局由 [PRD](./prd.md#131-runtime-执行清单)
维护，替换、隔离和终态规则由 [Runtime 交互边界](./runtime-interactions.md#runtime-执行清单)
维护。研究证据与交付状态见[进度](./progress.md#2026-09-15-runtime-执行清单设计未实现)。

## 1. 原生数据与提取位置

| Runtime / 路径 | 已确认格式与设计接入 |
| --- | --- |
| 本地 OC 1.18.29 | `todo.updated` 与 `session.todo` 返回完整条目列表，字段为 `content/status/priority`，无 item ID；以原生更新事件驱动本轮整份替换 |
| 本地 CN 1.5.47 | 精确原生工具 `Checklist` 的参数 `checklist` 是 Markdown 勾选列表，`- [ ]` / `- [x]` 表示未完成/完成；按一次成功调用提交完整替换 |
| 远程 OC/CN | 先核对实际部署版本、原生输出与 Agent 传递结果；只有格式已确认且来源归属明确的原生 plan entries 或精确清单工具参数可以映射，当前尚无本功能远程实测 |

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
输出。空数组在统一事件中明确表示清除；CN 原生如何表达空清单，以及空白、大小写和
非条目行的实际接受规则，实施时核对后固定解析规则。未确认或无效输入保留旧清单，
不能误当清空。

## 2. 统一事件与消息归属

拟在现有 Runtime 事件联合中增加完整清单事件，承载 `requestId`、条目数组和原生来源；
条目包含 `content`、`status` 及可选 `priority`。最终命名随实现确定，不设计条目级增删
协议或稳定 item ID。空数组必须经过 schema、IPC、消息投影和保存链路，不能被“无内容”
过滤丢弃。

Main 使用现有请求到助手消息的映射投影清单，Renderer 顶部读取该消息的最新有效状态。
同一请求若同时观察到原生清单事件与其工具记录，只以前者更新清单，后者保留活动；不能
提交两次替换。原生父 Session、请求开始/结束边界需共同校验，子 Session 或旧请求事件
不得通过当前活动请求映射到新轮。

优先扩展现有消息 metadata、Runtime 事件和数据库投影，历史清单与所属助手消息一起保存。
远端沿用事件提交、消息投影和 ACK 的既有事务及去重规则；相关存储边界见
[执行记录存储](./execution-history-storage.md)。实施前核对本地会话与远程任务实际落库
字段，选择能复用的最小表示。不新建清单数据库、独立快照系统、恢复日志或持久化服务。
旧消息没有结构化清单时保持缺省，不从已截断工具字符串或状态文案补造历史。

## 3. 远程 Agent 与 ACP 复用

本次源码检查确认以下传递位置，属于设计依据，不是本功能远程验证结果：

1. `AgentAcpConnection` 按原生 `sessionId` 分派 `sessionUpdate`；
   `AgentOwnedAcpPrompt` 校验 Session 后，以 `bindingId/operationId` 将通知写入
   既有 semantic transcript。
2. `ProtocolRemoteRuntimeChannel` 已有 transcript 读取/ACK、身份核对，以及 ACP
   channel 恢复与重放；`AcpRemoteRuntime` 消费 `session-update` 并转换桌面事件。
3. `AcpRemoteRuntime` 当前将 `plan.entries` 及 `plan_update` 的 items 转成 `status`
   字符串；markdown/URI 也只形成状态消息。工具事件按 `toolCallId` 合并 `rawInput`、
   `status` 和结果，再有界保留。清单提取应发生在结构丢失或截断前。

优先复用上述通知和 transcript，不另建远端清单通道。对实际 OC/CN 部署确认过的
`plan.entries`，或已确认等价的 `plan_update` items，校验条目字段和状态后转成统一
清单事件。普通 `status`、plan markdown/URI、`plan_removed` 文案以及泛化工具名均不
触发清单更新；在没有确认对应原生清单身份前，`plan_removed` 也不能清空顶部。

若远程原生输出走精确清单工具，须确认原始参数、调用身份与成功状态确实贯穿 Agent，
再按同一提取规则接入。是否能直接复用原生 entries，或需补充最小 Agent 适配，取决于
真实格式证据，不能根据 ACP 类型定义推断 OC/CN 一定会发送。ACP 是协议，Runtime 身份
仍为 OC 或 CN。

当前托管 SSH 产品及受管安装、校验、创建链路只支持 OC，详见
[远程范围](../remote-host/technical-design.md#执行清单接入范围)。远程 CN 交付需补齐
受管工件、安装与启动、项目选择/校验及原生事件接入，确认 Main 模型桥、请求归属、取消
和已有恢复流程能用于该部署。不能只放开选择菜单或使用本地 CN 调远程模型来宣称完成。

重连按[既有 ACP 与断线规则](../remote-host/technical-design.md#acp-与断线)执行。
已接受 Prompt 使用原 binding/operation 恢复，清单从已提交消息和其后的既有事件恢复；
重复事件不重复展示。连接丢失不表示条目完成，不为恢复清单重新发送 Prompt、模型请求或
工具调用，也不新增独立重连机制。

## 4. 实施与验收

| 阶段 | 必须完成的工作 | 对应需求 |
| --- | --- | --- |
| CL-P1 | 原始层提取、严格格式校验、统一事件及请求归属；保留工具活动 | FR-CL1–FR-CL3 |
| CL-P2 | 消息投影和既有存储恢复、顶部只读布局、空数组清除及终态展示 | FR-CL2–FR-CL4 |
| CL-P3 | 确认远程 OC 原生格式，补齐远程 CN 真实部署与事件接入，复用 Agent 传递和恢复 | FR-CL1、FR-CL4 |
| CL-P4 | 本地与共享 Linux 真实 Host 逐项验收，记录版本、结果、调用口径与剩余阻塞 | FR-CL1–FR-CL4 |

以下均为待执行验收，本次文档工作不运行模型或代码测试：

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
