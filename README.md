# GoodBuddy

[English](README.en.md) | 简体中文

安全、跨平台、本地优先的桌面 AI 助手与 Agent 工作空间。

![GoodBuddy 工作空间](docs/screenshots/workspace-overview.png)

## 核心能力

- **安全执行**：`Ask` 保持只读；`Execute` 仅运行已启用且受边界约束的工具，并保留活动记录。
- **本地优先**：会话、任务、成果、记忆、知识库和图谱保存在本地 SQLite；API Key 由系统安全存储加密。
- **多 Runtime**：支持直连模型、OpenCode、Continue 和预览版 DeepSeek Harness，统一处理取消、超时、输出限制和进程退出；原生能力清单将 Tools 与 Commands、LSP、Formatters 分开，并显示来源及 Ask/Execute 可用性。内置 OpenCode 提供 Agent、Tool、Command 与原生 Compact，Continue 提供 Rules、Prompt 预设、结构化提问与 GoodBuddy 手动摘要压缩，并明确标记当前版本无法静态发现原生 Tools。
- **开放连接**：支持 OpenAI Responses、OpenAI 兼容 Chat Completions、Anthropic Messages、OpenAI Images、Embeddings、跨 Runtime Skills 与自定义 MCP，以及默认关闭、由用户显式开启的 DeepSeek Harness npm 插件市场。MCP 测试可读取有界 Prompt/Resource 元数据，但不会读取 Resource 内容。
- **知识工作区**：支持文件、目录和网页导入，以及全文、词组、向量和图谱混合检索。
- **工作管理**：集中管理 Projects、对话、任务、活动、成果、记忆、魔法笔记和智能心跳。
- **远程通道**：支持微信 ClawBot、企业微信和钉钉，每个发送者使用独立远程会话。
- **桌面上下文**：可选择文件、截图、应用窗口、剪贴板和语音作为上下文。
- **离线语音**：支持 SenseVoice、Paraformer 和 Whisper 本地模型。
- **富文本回答**：支持 Markdown、LaTeX 公式和受控 Mermaid 图表。

![GoodBuddy 知识工作区](docs/screenshots/knowledge-workspace.png)

![GoodBuddy 知识图谱](docs/screenshots/knowledge-graph.png)

![GoodBuddy 魔法笔记](docs/screenshots/GoodBuddy_MFSGeK0NoT.gif)

![GoodBuddy 智能心跳](docs/screenshots/smart-heartbeat.png)

完整功能和路线图见 [FEATURES.md](FEATURES.md)，产品、架构、设计与质量文档见
[文档导航](docs/README.md)。

## 安装

从 [GitHub Releases](https://github.com/mesalogo/goodbuddy/releases) 下载：

| 系统 | 架构 | 格式 |
| --- | --- | --- |
| Windows | `x64`、`arm64` | NSIS、便携 ZIP |
| macOS | `x64`、`arm64` | DMG、ZIP |
| Linux | `x64`、`arm64` | AppImage、DEB |

当前尚未配置代码签名和 macOS notarization，系统可能显示安全提示。

## 从源码运行

需要 Node.js 24 和 npm：

```bash
git clone https://github.com/mesalogo/goodbuddy.git
cd goodbuddy
npm ci
npm run dev
```

构建与打包说明见 [BUILD.md](BUILD.md)。

## 隐私与安全

- 模型请求只发送到用户选择的服务。
- 本地数据默认保存在系统应用数据目录。
- Renderer 不接触原始 Electron API 或模型凭据。
- DeepSeek Harness 插件市场默认关闭；开启并安装第三方插件后，其安装脚本、初始化和 Execute 工具以当前用户权限运行。关闭市场只隐藏目录和管理界面，不会停用或卸载已有插件；安装前会明确确认。Ask 只允许 Host 原生 `read`/`skill` 与 Main 管理的 Web Search/Fetch，不允许调用第三方插件工具，也不能限制插件初始化代码。
- 远程委派仅在用户配置端点和令牌后启用。
- 内网兼容模式允许应用内 HTTP 和非标准 HTTPS 证书；微信凭据和媒体端点仍执行严格校验。

## 参与贡献

欢迎提交 Issue 和 Pull Request。请先阅读 [AGENTS.md](AGENTS.md)，提交前运行：

```bash
npm test
npm run typecheck
npm run lint
```

## 社区交流

目前采用微信群的方式供大家高效交流，大家可以微信扫码进入社区群：

<img width="1279" height="1306" alt="056bfac87840a95547f9805a8122fc2d" src="https://github.com/user-attachments/assets/b3342635-60a1-484c-959c-f90ba3c39d69" />



## 开源许可

GoodBuddy 的原创代码采用 [0BSD License](LICENSE)，可自由使用、修改、分发和商用。第三方组件和资源遵循各自许可证。
