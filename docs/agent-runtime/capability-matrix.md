# Runtime 能力矩阵

本表基于 2026-10-22 的源码核对，并更新至 2026-10-23 的取消修复，按[统一接入规范](./README.md)组织。
“已实现”只表示存在生产调用路径，未在本次文档整理中重跑端到端验证。具体测试版本与
范围以所属 progress/validation 文档为准。Droid 的独立脚本结果不记为产品实现。

## 聊天与执行

| 能力 | 直连模型 | OpenCode | Continue | DeepSeek Harness | Droid |
| --- | --- | --- | --- | --- | --- |
| 本地聊天 | 已实现 | 已实现，受管/外部 Server | 已实现，适配 Host | 已实现，固定 Host | 上游已测，未接入 |
| 托管 SSH | 已接通；模型循环在桌面，工作区工具在 Agent，见[验证记录](./providers/direct-model/progress.md#2026-10-25-远端直连模型) | 已实现 | 已实现 | 不支持 | 设计中 |
| GoodBuddy 模型连接 | 已实现，文本/图像生成分开 | 受管模式已实现 | 已实现 | 兼容 API-key Chat Completions | Responses 已测，未接入 |
| 自有模型配置 | 不适用 | 支持，外部 Server 使用自身配置 | 支持 | 依赖解析到兼容平台 profile，非任意 DSH 配置导入 | 计划由 GoodBuddy 管理 BYOK |
| 本地聊天自定义 body | 支持 | 未透传 | 支持 | 未透传 | 未接入 |
| 结构化问答 | 当前未接入专用原生问答 | 本地/托管 SSH 已实现 | 已实现 | 不支持，普通文本提问另计 | 原生已测，未接入 |
| 顶部 Todo | 无该 source | 已实现 | 已实现 | 无该 source | TodoWrite 已测，未接入 |
| 跨主回复原生后台管理 | 无统一接口；进程/委派工具另计 | 有子代理过程，未接通用独立管理 | 未接通用独立管理 | 未接通用独立管理 | daemon 子代理已测，未接入 |
| 手动压缩 | 本地/SSH 的 GoodBuddy 摘要；外部消息通道只读会话不提供 | 本地受管原生 compact | GoodBuddy 摘要 | 不支持 | 未接入 |

模型请求参数必须按路径核对：OpenCode 本地聊天与原生 TUI/远程网关不是同一条模型配置
路径；原生客户端模型桥的透传能力不能用来宣称本地聊天已支持全部参数。
统一推理档位 UI 尚未实现，不能把自定义 body 或上游模型字段当成已有统一控件。

## 能力与定制

| 能力 | 直连模型 | OpenCode | Continue | DeepSeek Harness | Droid |
| --- | --- | --- | --- | --- | --- |
| 全局 Skills/自定义 MCP 分配 | 已实现 | 已实现 | 已实现 | 已实现 | 上游已测，产品分配未接入 |
| 内置业务 MCP | 按分配和业务范围 | 按受管/scoped 支持 | 按分配和业务范围 | 当前能力服务仅接 Story Graph | 未接入 |
| 原生 inventory | 不适用 | 受管本地较完整，外部 Server 仅连接信息 | 配置导出的规则/模板/MCP；工具资源清单受限 | Host 工具与原生 Skills；无 agent/command 等价清单 | 原生接口已测，未接入 |
| 原生执行控制 | 不适用 | 受管本地 agent 与 command | preset/template，不等价于 OpenCode command | 未提供等价控制项 | 未接入 |

Skill 预算、名称约束及业务范围可能使已分配能力不可注入；应说明原因。聊天与原生客户端
的内置数据工具绑定也不完全相同，不能用同一个“支持 MCP”概括。
全局启停不是项目级启停；Droid 上游 Project toggle 不支持不构成该产品需求的缺陷。

## 子任务与进程实测

以下结果来自 [2026-10-22 本地实测](./validation/subagents-and-processes-2026-10-22.md)，
取消行为已按[后续修复验证](./validation/cancellation-fixes-2026-10-23.md)更新。
模型是确定性夹具，Runtime/工具/进程实际执行；不代表真实 UI、远程或所有上游功能已验收。

| 能力 | 直连模型 | OpenCode 1.19.3 | Continue 1.5.47 | 受控 DSH 0.2.1-rc.2 | Droid 0.245.1 |
| --- | --- | --- | --- | --- | --- |
| 子代理/委派 | 真实服务/调度器/child Runtime 执行命令通过 | 原生 Task 并发、父子归属和子问答通过 | 本轮目录无委派工具 | 固定 Host 目录无子代理工具 | 原生 Task/daemon 测试通过 |
| 跨父回复存活 | 本轮委派等待结果，无统一后台合同 | 本轮 Task 等待结果，无后台参数 | Bash 被等待，有 CheckBackgroundJob 但无已验创建/停止合同 | pwsh 被等待，无 job 工具 | detached 子任务可在父轮结束和中断后继续 |
| 定向停止子代理 | 调度/AbortSignal，非通用原生 child RPC | native abort 映射 cancelled，本地/Agent 通过；尚无统一按钮操作 | 不适用本轮目录 | 不适用固定 Host | daemon interruptSession 与 TaskStop 均验证 |
| 在途命令取消 | PID 退出、兄弟继续、超时和 release 通过 | 本轮未单独验在途 shell 取消 | 后代回收已修复，Windows utility/Linux helper 验证通过 | 后代回收已修复，Windows PS7 与实际 utility 验证通过 | 在途 Execute 取消未验证；退出错误可读，服务 OS 停止另计 |
| 常驻服务 | 在途 localhost 服务随 release 停止并释放端口 | 未验证 | 未验证 | 未验证 | fireAndForget 服务在 CLI 退出后仍存活，Execute 调用 OS 操作可停止 |
| 交互输入 | process_execute 不接受 stdin/pty | bash 本轮无该接口 | 本轮目录无该接口 | pwsh 本轮无该接口 | 未验证；不能由终端能力推定 |
| 输出 | 原生进程分页与委派输出跨轮读取通过 | 原生子历史完整，适配器预览 16,000 字符，产品全文未验 | exit 7 错误结果省略 stdout | exit 7 内容保留，但工具事件为 completed | 子消息和服务日志可读，显式 shell 传播后 exit 7 保留 |

DSH 官方 Web 实际目录另有 subagent 和 job_list/job_output/job_kill，但本轮仅检查目录，
未执行其生命周期；不能将其计入固定 Host 聊天能力。Droid 停止 OS 服务经由模型工具
Execute，不等于可直接绑定 UI 的 shell-stop API。

## 原生客户端

| Runtime | 当前入口 | 实际执行空间 | 会话语义 | 主要前提 |
| --- | --- | --- | --- | --- |
| 直连模型 | 无 | 不适用 | 不适用 | 无原生 CLI |
| OpenCode | 在终端中打开 | 本地 | 独立 TUI 会话，不接续聊天 | 可执行文件及具体 GoodBuddy 文本模型 profile |
| Continue | 在终端中打开 | 本地 | 独立 CLI 会话，不接续聊天 | 标准 Node、准备好的 CLI 与模型 profile |
| DeepSeek Harness | 打开 DSH Web | 本地 | 独立原生历史；匹配存活服务可重开 | 标准 Node、官方 Web 资源与模型 profile |
| Droid | 未实现 | 未声明已支持 | 应先对齐独立客户端合同；续接需另行验收 | 不能由 CLI 存在推断入口已可用 |

现有 [native-client 设计](./design/native-client.md)包含远程目标范围，但当前
`NativeClientCoordinator` 只接受本地执行空间。普通终端支持 SSH 不改变此结论。
Continue 的标准 Node 回退可能在点击时下载安装，尚未达到完整的预备离线资源交付。

## 待对齐项与源码依据

本节记录现状缺口，不因文档集中自动修改产品行为。

| 问题 | 依据 | 对齐方向 |
| --- | --- | --- |
| OpenCode/Continue 原生入口未按执行空间限制，但 Main 拒绝远程 | [App](../../src/renderer/src/App.tsx)、[coordinator](../../src/main/agent/native-client-coordinator.ts) | 统一按实际路径计算可用性；远程接入前不能让入口承诺远程启动 |
| 聊天可选择自有配置，但 native terminal 需要具体 profile | [native-terminal-client](../../src/main/agent/native-terminal-client.ts) | 分开声明原生入口与聊天的配置前提 |
| Runtime 增加一个枚举值不足以完成注册 | [selection](../../src/shared/runtime-selection-contracts.ts)、[Main resolver](../../src/main/agent/runtime-selection.ts)、[capability contracts](../../src/shared/capability-contracts.ts) | 核对默认分支、分配数量、状态/用量/清单及远程合同 |
| 历史 Checklist 记录含未实现阶段 | [interactions](./contracts/interactions.md)、[实现](../../src/shared/runtime-checklist.ts) | 当前合同已更新为现有映射；历史状态须按日期与验证范围使用 |
| 前台结束会清理问答/子任务，不能直接承载长期后台工作 | [controller](../../src/main/agent/runtime-controller.ts)、[事件投影](../../src/renderer/src/agent-event-handler.ts) | 明确会话级工作归属，沿用已有 owner 扩展 |
| provider 能力不等于所有路径参数一致 | [factory](../../src/main/agent/create-runtime.ts)、[模型桥](../../src/main/remote-agent/managed-model-bridge.ts) | 聊天、远程、原生客户端分别验证 |
| OpenCode 原生定向 child abort 缺少统一 UI 控制入口 | [取消修复验证](./validation/cancellation-fixes-2026-10-23.md#opencode) | 终态已修正 cancelled；前端控制入口仍须独立接入验收 |

选择继承文档与 resolver 的边界行为需在后续对齐时一起核对；本次目录迁移不改变已发布
选择规则。Droid 设计中的错误/回退要求也必须遵循共享选择合同，不自行增加独立解析规则。

## 证据入口

- OpenCode/Continue：[工作栏进度](../features/assistant-workbar/progress.md)、[进程复用](./design/process-reuse.md)、[远程验证](./validation/remote-checklist.md)。
- DeepSeek：[实现进度](./providers/deepseek-harness/progress.md)。
- 直连模型：[实现进度](./providers/direct-model/progress.md)。
- Droid：[协议验证](./providers/factory-droid/progress.md)，尚不是产品接入验收。
- 远程生命周期：[Host 技术设计](../features/remote-host/technical-design.md)。
- 子任务/后台命令/服务：[跨 Runtime 实测](./validation/subagents-and-processes-2026-10-22.md)。
- 取消与回收修复：[本地及 Host 验证](./validation/cancellation-fixes-2026-10-23.md)。
