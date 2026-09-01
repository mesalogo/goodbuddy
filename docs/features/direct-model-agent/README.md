# 直连模型 Agent 能力

本目录是 GoodBuddy“直连模型 Agent 能力”的唯一文档入口。本功能为直连文本模型补齐
跨平台进程执行和编程 Subagent，使其能够在 Execute 模式完成读取、修改、运行和验证组成的
编程闭环，同时避免向已经拥有原生 Shell 或 Agent 能力的 Runtime 重复注入工具。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [PRD](./prd.md) | 用户问题、产品范围、功能需求、非目标和产品验收 |
| [User Stories](./user-stories.md) | 本机开发、失败恢复、委派和 Runtime 边界场景 |
| [功能逻辑](./logic-design.md) | 能力矩阵、不变量、状态转换、继承规则和失败结果 |
| [UI 设计](./ui-design.md) | 设置能力目录、聊天活动、Subagent 状态和无障碍行为 |
| [技术设计](./technical-design.md) | Main 服务、工具契约、平台适配、Subagent、生命周期和测试 |
| [功能进度](./progress.md) | 当前实现事实、待实施阶段、阻塞项和验证证据 |

## 术语

| 术语 | 定义 |
| --- | --- |
| 直连模型 | Runtime provider 为 `model`、由 GoodBuddy 直接调用模型协议的文本模型 |
| 进程执行 | GoodBuddy 在当前执行空间启动一个前台 Shell 命令并返回有界结果 |
| 平台 Shell | Windows 上的 PowerShell，macOS/Linux 上的 Bash 或 POSIX Sh |
| 编程 Subagent | 由直连模型临时委派、使用直连模型 Runtime 执行一个有界子任务的执行者 |
| 父请求 | 发起进程调用或 Subagent 委派的当前直连模型请求 |
| 子任务 | 父请求内部的一项委派工作，对应 Job/Subjob 语义，不是新的顶层 Task |

Task、Job、Subjob、Run 和 Subagent 的对象关系以
[Task 与 Job 统一领域模型](../task-and-job/task-and-job-model.md) 为准。本功能不重新定义
这些对象。

## 功能边界

- `process_execute` 和 `subagent_delegate` 是 GoodBuddy 直连模型内置工具，不是外部 MCP。
- OpenCode、Continue 和 DeepSeek Harness 继续使用各自原生执行与委派能力。
- Ask 不允许进程执行；Subagent 若在 Ask 中使用，只能继承 Ask 的只读能力。
- Execute 表示用户授权当前执行空间账号的完整能力，不增加第二套工具审批或权限档位。
- 首版跨平台指桌面本机 Windows、macOS 和 Linux。托管 SSH 项目当前继续使用远端
  OpenCode；未来若向远端直连模型开放本工具，命令必须由 Host Agent 执行，绝不能回退到
  桌面本机。

## 相关功能

- [本机工具环境](../local-tool-environment/README.md)：为新进程提供 Node、Python 和 PATH。
- [助手工作栏与执行空间](../assistant-workbar/prd.md)：定义本机/SSH 执行位置和活动归属。
- [远程主机与远程执行](../remote-host/README.md)：定义当前托管 SSH Runtime 边界。
- [DeepSeek Harness Runtime](../deepseek-harness/README.md)：已经拥有平台 Shell 的独立 Runtime。
