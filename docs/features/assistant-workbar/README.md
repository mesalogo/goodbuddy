# 助手工作栏

助手工作栏统一承载本机与远程执行空间、Task、成果、文件、浏览器和终端等持续工作界面。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [通用助手工作栏与执行空间 PRD](./prd.md) | 工作栏整体产品范围、执行空间和各工作面板归属 |
| [多终端页签 PRD](./terminal-tabs-prd.md) | 工作栏应用的固定、可关闭、单实例和多实例策略，以及多终端生命周期 |
| [浏览器多实例技术设计](./browser-tabs-technical-design.md) | 浏览器 Tab 身份、Conversation 绑定、IPC、BrowserService 和 MCP 路由 |
| [实现与验证进度](./progress.md) | 工作区与 Runtime 相关改动的实现事实、验证证据与剩余阻塞 |
| [Runtime 交互边界](./runtime-interactions.md) | 原生权限、结构化问答、后台拒绝、终端交互、托管 Runtime 并行与输出及消息底部请求状态的适配范围 |

当前尚未拆出独立 User Stories、功能逻辑和 UI 设计文档；相关内容仍保留在两份现有 PRD
中。浏览器多实例涉及跨进程身份和工具路由，单独使用技术设计文档维护。
