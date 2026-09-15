# 助手工作栏

助手工作栏统一承载本机与远程执行空间、Task、成果、文件、浏览器和终端等持续工作界面。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [通用助手工作栏与执行空间 PRD](./prd.md) | 工作栏整体产品范围、执行空间和各工作面板归属 |
| [多终端页签 PRD](./terminal-tabs-prd.md) | 工作栏应用的固定、可关闭、单实例和多实例策略，以及多终端生命周期 |
| [浏览器多实例技术设计](./browser-tabs-technical-design.md) | 浏览器 Tab 身份、Conversation 绑定、IPC、BrowserService 和 MCP 路由 |
| [实现与验证进度](./progress.md) | 工作区与 Runtime 相关改动的实现事实、验证证据与剩余阻塞 |
| [执行记录存储与升级回收](./execution-history-storage.md) | 子任务差量存储、远程去重、旧库转换、会话摘要与完整历史按需读取、内存引用释放 |
| [Runtime 交互边界](./runtime-interactions.md) | 原生权限、结构化问答、后台拒绝、终端交互、并行与输出、消息请求状态及资源生命周期规则 |
| [Runtime 进程复用技术设计](./runtime-process-reuse-technical-design.md) | 跨 Runtime 资源调研、锁定协议证据、进程与会话拆分、远端模型桥、实施顺序和性能验收 |
| [Runtime 执行清单技术设计](./runtime-checklist-technical-design.md) | OC/CN 原生清单提取、远程 Agent 传递复用、消息恢复与真实部署验收；尚未实现 |

当前尚未拆出独立 User Stories、功能逻辑和 UI 设计文档；产品场景与验收保留在现有 PRD，
Runtime 资源状态规则由交互边界文档维护。浏览器多实例和 Runtime 进程复用涉及不同的
跨进程身份与工具路由，分别使用技术设计文档维护。

执行清单的需求、场景和顶部布局见 [PRD](./prd.md#131-runtime-执行清单)，状态规则见
[Runtime 交互边界](./runtime-interactions.md#runtime-执行清单)。本目录拥有该功能；
[Task 与 Job](../task-and-job/README.md)拥有产品任务领域，
[远程主机](../remote-host/technical-design.md#执行清单接入范围)拥有远程部署与连接边界。
