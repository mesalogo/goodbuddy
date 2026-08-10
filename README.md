# GoodBuddy

面向专业工作与国产化环境的安全桌面智能助手。

GoodBuddy 将模型连接、Agent Runtime、本地知识库、知识图谱、远程消息通道、任务协作和持续成长能力组织在同一个桌面工作空间中。它不是简单的聊天窗口，而是一套可审计、可控制、可长期使用的个人智能工作环境。

![GoodBuddy 工作空间](docs/screenshots/workspace-overview.png)

## 为什么选择 GoodBuddy

### 安全可控的 Agent 执行

GoodBuddy 通过统一的 Agent Runtime 控制层接入直连模型、OpenCode 和 Continue。工具不会被直接暴露给界面，所有执行都受到工作模式、权限策略和运行边界约束。

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

GoodBuddy 按模型协议、消息通道和内网部署能力提供国产化适配。以下内容只列当前代码和发布流程已经提供的能力；具体国产操作系统、整机和外设组合仍应在目标环境完成安装、启动、模型调用和桌面集成验收。

#### 国产模型与私有化服务

GoodBuddy 不把模型厂商写死在客户端中，而是通过标准协议连接用户选择的云端、企业网关或本机服务。下列厂商和模型只有在所用服务提供对应兼容接口时才能接入。

| 接入对象 | 支持状态 | 接入方式 | 可用能力 |
| --- | --- | --- | --- |
| DeepSeek | 协议兼容 | OpenAI 兼容 Chat Completions，或由网关转换为已支持协议 | 对话、推理、受控工具调用 |
| 通义千问 / 阿里云百炼 | 协议兼容 | OpenAI 兼容 Chat Completions | 对话、推理、受控工具调用 |
| 智谱 GLM | 协议兼容 | OpenAI 兼容 Chat Completions | 对话、推理、受控工具调用 |
| Kimi / Moonshot | 协议兼容 | OpenAI 兼容 Chat Completions | 对话、推理、受控工具调用 |
| 豆包 / 火山方舟 | 协议兼容 | OpenAI 兼容 Chat Completions | 对话、推理、受控工具调用 |
| 腾讯混元 | 协议兼容 | OpenAI 兼容接口或企业网关 | 对话、推理、受控工具调用 |
| 百度千帆 / 文心 | 协议兼容 | OpenAI 兼容接口或企业网关 | 对话、推理、受控工具调用 |
| 百川、MiniMax | 协议兼容 | OpenAI 兼容接口或企业网关 | 对话、推理、受控工具调用 |
| 零一万物 Yi、阶跃星辰 Step | 协议兼容 | OpenAI 兼容接口或企业网关 | 对话、推理、受控工具调用 |
| 讯飞星火、华为盘古、商汤日日新 | 可经适配层接入 | 由企业网关转换为 OpenAI Responses、OpenAI 兼容 Chat Completions 或 Anthropic Messages | 按网关实现提供文本、推理和工具能力 |
| 硅基流动等聚合服务 | 协议兼容 | OpenAI 兼容 Chat Completions | 使用聚合服务中可用的文本模型 |
| Ollama | 已验证的本机连接方式 | OpenAI 兼容 Chat Completions，可选择“无需认证” | 本机文本模型，包括 Qwen、DeepSeek、GLM、Yi、MiniCPM 等 Ollama 模型 |
| Xinference、vLLM、LM Studio、LocalAI 等私有服务 | 协议兼容 | 自定义 OpenAI 兼容地址，可使用 API Key 或无需认证 | 本机或内网文本模型 |
| 企业模型网关与国产模型适配层 | 支持自定义连接 | OpenAI Responses、OpenAI 兼容 Chat Completions 或 Anthropic Messages | 按网关实现提供文本、推理和工具能力 |
| 通义万相、豆包图像、智谱 CogView 等国产图像模型 | 可经兼容接口接入 | 服务端或网关提供 OpenAI Images Generations 兼容接口 | 单图生成与本地成果保存 |
| BGE、GTE、text2vec、Qwen Embedding 等国产向量模型 | 可经兼容接口接入 | 使用 Xinference、vLLM、Ollama 或企业网关提供 OpenAI 兼容 Embeddings 接口 | 知识库语义检索、索引重建和 GraphRAG；失败时回退到 FTS5 与证据图谱 |

#### 国产通信、语音与内网能力

| 类别 | 已支持项 | 说明 |
| --- | --- | --- |
| 个人微信 | 微信 ClawBot | 本机扫码绑定；支持私聊文字、图片和文件，单条消息最多 4 个附件、解密后合计不超过 12MB |
| 企业通信 | 企业微信、钉钉 | 支持加密凭据、环境变量只读覆盖、连接测试、动态启停、发送者范围和状态诊断 |
| 远程 Runtime | 直连文本模型、OpenCode、Continue | 每个通道使用系统管理项目和独立远程会话，支持 Ask / Execute 与活动审计 |
| 中文离线语音 | SenseVoiceSmall INT8 | 从 ModelScope 固定版本校验下载；支持中文、粤语、英语、日语和韩语，适合本地 CPU |
| 多语言离线语音 | Whisper Tiny INT8 | 从 ModelScope 固定版本校验下载；支持中文、英语及其他语言 |
| 中文界面 | 简体中文、内置 Noto Sans SC Variable | 字体随应用打包，不依赖远程字体服务 |
| 本地数据 | SQLite、FTS5、本地知识库与知识图谱 | 会话、任务、成果、记忆和知识数据默认保存在本机 |
| 内网模型与网关 | 自定义 HTTP(S) 地址、API Key 或无需认证 | 可连接本机、局域网、企业网关和私有模型服务 |
| 内网兼容模式 | HTTP、自签名证书、无效或过期证书 | 默认开启，可关闭并恢复严格校验；微信凭据和媒体端点不适用该放宽策略 |
| MCP | `stdio`、Streamable HTTP、SSE | 可接入本机或内网 MCP Server；远程连接支持 Bearer Token |
| Agent Runtime | 内置 OpenCode、Continue | 支持自定义程序路径、配置路径、模型来源和服务地址；Linux 内置 OpenCode 可使用 bubblewrap 严格沙箱 |
| 发布校验 | 六组系统与架构目标、SHA-256 清单 | Windows、macOS、Linux 的 `x64` / `arm64` 包均由发布流程构建和校验 |

> “协议兼容”表示 GoodBuddy 已实现对应协议，并允许配置自定义服务地址，不等同于对每个厂商、模型版本或套餐逐一完成认证。工具调用、图片输入、思维过程和上下文长度还取决于具体服务端实现。

## 核心功能

### 一体化智能工作空间

- Projects 与独立对话上下文。
- 专家角色和最多三个只读专家并行分析。
- 任务、活动、成果、记忆和自动化集中管理。
- 支持文件、桌面截图、应用窗口、剪贴板和语音上下文。
- 显示真实 Git 工作区变更。
- 支持远程任务委派与持久化结果发件箱。
- Skills 与 MCP 能力按需接入。

### 远程消息通道与微信 ClawBot

微信 ClawBot、企业微信和钉钉分别使用系统管理的通道项目。远程发送者拥有独立会话，任务、活动和成果持续归属于对应通道与项目。

- 微信 ClawBot 使用本机扫码绑定，支持个人微信私聊文字、图片和文件。
- 单条微信消息最多 4 个附件，解密后合计不超过 12MB；图片和支持的文档进入现有受控上下文。
- 通道可选择直连文本模型、OpenCode 或 Continue。OpenCode/Continue 始终跟随“Agent Runtime”中的全局配置，不在通道中维护第二套 Runtime 配置。
- 远程消息支持 Ask 与 Execute。Execute 不显示通道专属逐次审批，但仍受发送者范围、项目目录、Runtime、沙箱、能力开关和活动审计约束。
- 当前任务生成的图片可以返回微信；明确要求文件时可将本次最终文本生成为 Markdown 附件，不自动发送已有工作区文件。
- “断开本机绑定”只停止本机收发并清除本地凭据，不会删除通道项目、远程会话或历史，也不承诺解除微信服务端授权。

完整设计、安全边界和联调状态见[远程消息通道项目与微信 ClawBot 集成 PRD](docs/features/wechat-clawbot-channel-project-prd.md)。

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

消息通道选择 OpenCode 或 Continue 时只选择 Runtime 类型，具体模型来源、自有配置、可执行文件和服务地址统一复用“Agent Runtime”设置，并在每次远程请求开始时解析当前全局配置。

## 功能矩阵与路线图

以下为仓库首页的简要路线图；完整能力说明、状态和重大规划统一记录在 [FEATURES.md](FEATURES.md)。

- [x] [跨平台桌面工作空间与安全上下文](FEATURES.md#桌面基础工作空间与上下文)
- [x] [多 Runtime、模型连接、Skills 与 MCP](FEATURES.md#agent-runtime-与模型连接)
- [x] [本地知识库、向量检索与知识图谱](FEATURES.md#skillsmcp-与知识库)
- [x] [任务、成果、记忆与智能心跳](FEATURES.md#工作管理长期协作与工作流)
- [x] [微信 ClawBot、企业微信与钉钉消息通道](FEATURES.md#浏览器通信语音与应用维护)
- [x] [本地录音与离线转写](FEATURES.md#浏览器通信语音与应用维护)
- [x] [魔法笔记 / Magic Notes](FEATURES.md#知识工作空间与魔法笔记)：本地优先的笔记与待办工作台，支持受控 AI 评论。
- [ ] [Agent 框架、受控工作流与团队协作](FEATURES.md#agent-框架与协作能力)
- [ ] [多云远程沙盒 Agent](FEATURES.md#多云远程沙盒-agent)

`[x]` 表示当前已提供，`[ ]` 表示开发中或规划中；未完成项目不代表已包含在当前发布版本中。

## 隐私说明

模型请求只会发送到用户选择的模型连接。本地数据保存在当前系统的应用数据目录中；远程委派仅在用户显式配置端点和令牌后启用。面向纯内网部署的“内网兼容模式”默认开启，允许 HTTP 并接受无效、自签名或过期的 HTTPS 证书；可在“安全与数据”中关闭并恢复严格校验。微信凭据和媒体端点不受该兼容模式放宽，始终只允许经过校验的腾讯微信 HTTPS 主机与重定向。
