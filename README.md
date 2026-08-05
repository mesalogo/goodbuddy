# GoodBuddy

面向专业工作与国产化环境的安全桌面智能助手。

GoodBuddy 将模型连接、Agent Runtime、本地知识库、知识图谱、任务协作和持续成长能力组织在同一个桌面工作空间中。它不是简单的聊天窗口，而是一套可审计、可控制、可长期使用的个人智能工作环境。

![GoodBuddy 工作空间](docs/screenshots/workspace-overview.png)

## 为什么选择 GoodBuddy

### 安全可控的 Agent 执行

GoodBuddy 通过统一的 Agent Runtime 控制层接入直连模型、OpenCode 和 Continue。工具不会被直接暴露给界面，所有执行都受到工作模式、权限审批和运行边界约束。

- `Ask`：只读问答，不调用工具。
- `Execute`：选择该模式即授权当前交互运行使用已启用的受控工具。
- 可在设置中禁止直连模型执行所有工具；工具调用仍记录到活动。
- 统一处理取消、超时、输出边界、进程退出和异常恢复。

### 数据主权与本地优先

- 会话、任务、成果、记忆、知识库和图谱保存在本地 SQLite。
- API Key 通过系统安全存储加密，不以明文写入配置。
- Electron Main、Preload、Renderer 严格分层，Renderer 仅能使用类型化 IPC。
- 子进程使用环境变量白名单，避免继承无关凭据。
- 默认不依赖 GoodBuddy 云端账户，也不代理用户的模型流量。

### 面向国产化环境交付

- 支持 Windows、macOS 与 Linux。
- 支持 Linux `x64` 和 `arm64`。
- 提供适用于麒麟、统信 UOS 等 Debian 系桌面的 `deb` 安装包。
- 提供 AppImage，便于免安装验证与便携分发。
- 支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Images 与无认证本机模型。
- 可连接企业网关、私有模型服务和国产模型适配层。

## 核心功能

### 一体化智能工作空间

- Projects 与独立对话上下文。
- 专家角色和最多三个只读专家并行分析。
- 任务、活动、成果、记忆和自动化集中管理。
- 支持文件、桌面截图、应用窗口、剪贴板和语音上下文。
- 显示真实 Git 工作区变更。
- 支持远程任务委派与持久化结果发件箱。
- Skills 与 MCP 能力按需接入。

### 本地知识库与知识图谱

文件、目录和网页内容可以按知识库独立管理。GoodBuddy 会完成解析、索引、检索和图谱构建，并保留可追溯的来源与证据。

![GoodBuddy 知识工作区](docs/screenshots/knowledge-workspace.png)

- SQLite FTS5 全文检索与有界上下文召回。
- 支持规则、模型和混合图谱抽取。
- 支持实体、关系、别名、证据与来源位置追溯。
- 图谱可搜索、筛选、缩放和拖动节点。
- 支持实体编辑、合并以及关系维护。
- 文档解析包含压缩包展开限制、路径校验和敏感字段过滤。

![GoodBuddy 知识图谱](docs/screenshots/knowledge-graph.png)

### 智能心跳

智能心跳让 GoodBuddy 不只响应当前问题，还能定期回顾近期工作，沉淀长期记忆，发现风险，并将洞察转化为可处理的建议。

![GoodBuddy 智能心跳](docs/screenshots/smart-heartbeat.png)

- 按项目或全局配置周期回顾计划。
- 展示心跳健康、记忆沉淀、洞察发现和行动转化。
- 提供成长趋势、最新报告和可审计的运行轨迹。
- 建议记忆可确认或忽略。
- 后续任务可带入 Ask 对话、标记完成或忽略。
- 支持手动运行、暂停、恢复和安全删除计划。

### 多 Runtime 与模型连接

| 能力 | 适用场景 | 控制方式 |
| --- | --- | --- |
| 直连模型 | 问答、知识总结、受控工具执行、图像生成 | Ask 只读；Execute 自动授权已启用的工作区、浏览器与 MCP 工具，可设置为全部禁止 |
| OpenCode | 完整编码与工作区任务 | Execute 不弹 GoodBuddy 审批，保留 Runtime 自身权限、取消和活动记录 |
| Continue | Agent 编码与工作区任务 | Execute 不弹 GoodBuddy 审批，使用独立宿主、取消和活动记录 |

## 隐私说明

模型请求只会发送到用户选择的模型连接。本地数据保存在当前系统的应用数据目录中；远程委派仅在用户显式配置 HTTPS 端点和令牌后启用。
