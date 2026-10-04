# 助手工作栏

助手工作栏统一承载本机与远程执行空间、Task、文件、浏览器、终端和笔记等持续工作界面。
成果页已移除；项目文件统一在工作区查看和导入，会话图片继续由消息引用读取。

“笔记”为应用级、可关闭的单实例 Tab，新布局默认不打开。它提供搜索、浏览和快速追加文字，
与主页面魔法笔记共用存储；会话采集、来源跳转与草稿规则由
[魔法笔记文档](../magic-notes/README.md)维护。该应用已接入并通过真实 Electron 验收；
全仓验证未全绿，聚焦复跑与执行时失败见[笔记验证进度](../magic-notes/progress.md)。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [通用助手工作栏与执行空间 PRD](./prd.md) | 工作栏整体产品范围、执行空间和各工作面板归属 |
| [多终端页签 PRD](./terminal-tabs-prd.md) | 工作栏应用的固定、可关闭、单实例和多实例策略，以及多终端生命周期 |
| [浏览器多实例技术设计](./browser-tabs-technical-design.md) | 浏览器 Tab 身份、Conversation 绑定、IPC、BrowserService 和 MCP 路由 |
| [实现与验证进度](./progress.md) | 工作区与 Runtime 相关改动的实现事实、验证证据与剩余阻塞 |
| [执行记录存储与升级回收](./execution-history-storage.md) | 子任务差量存储、远程去重、旧库转换、会话置顶、摘要与完整历史按需读取、内存引用释放 |
| [工作区文件导入与时间](./workspace-files.md) | 真实文件来源、导入操作、排序、图片存储边界及本机和远程实现 |
| [Runtime 交互边界](./runtime-interactions.md) | 原生权限、结构化问答、后台拒绝、终端交互、并行与输出、消息请求状态及资源生命周期规则 |
| [Runtime 进程复用技术设计](./runtime-process-reuse-technical-design.md) | 跨 Runtime 资源调研、锁定协议证据、进程与会话拆分、远端模型桥、实施顺序和性能验收 |
| [Runtime 原生客户端启动方案](./runtime-native-client-proposal.md) | Local terminal/DS Web shortcut requirements, startup rules, current integration, validation boundaries and remaining remote/resource work |
| [Runtime 执行清单技术设计](./runtime-checklist-technical-design.md) | OC/CN 原生清单提取、远程 Agent 传递复用、消息恢复与真实部署验收；尚未实现 |
| [移除 Ask / Execute 工作模式](../unified-execution/README.md) | 跨入口统一执行、历史字段迁移及清除数据入口；主要源码已落地，定向 UI/Host 通过，完整验收待完成 |

当前尚未拆出独立 User Stories、功能逻辑和 UI 设计文档；产品场景与验收保留在现有 PRD，
Runtime 资源状态规则由交互边界文档维护。浏览器多实例和 Runtime 进程复用涉及不同的
跨进程身份与工具路由，分别使用技术设计文档维护。

执行清单的需求、场景和顶部布局见 [PRD](./prd.md#131-runtime-执行清单)，状态规则见
[Runtime 交互边界](./runtime-interactions.md#runtime-执行清单)。本目录拥有该功能；
[Task 与 Job](../task-and-job/README.md)拥有产品任务领域，
[远程主机](../remote-host/technical-design.md#执行清单接入范围)拥有远程部署与连接边界。
