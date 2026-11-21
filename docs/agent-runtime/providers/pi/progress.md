# Pi Runtime 验证进度

## 2026-11-21：接入范围修正

用户确认以 Pi 原生能力为边界，不为对齐其他 Runtime 补扩展。以下历史测试中的
`goodbuddy_ask_user`、`goodbuddy_todo_write`、`goodbuddy_subagent` 是探针自建工具，
其通过结果不代表 Pi 默认支持，也不纳入产品实现。脚本保留用于复现历史实验。
官方提供的相关扩展示例不默认加载；原生 UI 交互协议与模型提问工具分开声明。
OMP 对标仅评估公开扩展接口的可能性，未决定启用扩展或修改 Pi 核心。
本次只修正文档范围，未重新执行历史模型测试。

## 2026-11-16：SDK 宿主可行性验证

**范围**：上游探针，不是产品接入验收。没有修改产品代码，没有接入 Runtime 选择器。

| 项 | 值 |
| --- | --- |
| 平台 | Windows x64 |
| Pi | `@earendil-works/pi-coding-agent@1.5.2`（npm latest），官方 `dist/bundle` |
| 宿主 | Electron `44.5.1` UtilityProcess（内置 Node `24.21.0`） |
| 运行资源 | 精简候选 14.56 MiB（bundle、主题与导出资源、`jiti`、`photon-node`；无 sourcemap/类型） |
| 脚本 | [validate-pi.mjs](../../../../../scripts/validate-pi.mjs)、[main](../../../../../scripts/validate-pi-main.mjs)、[host](../../../../../scripts/validate-pi-host.mjs) |

宿主按[技术设计](./technical-design.md)的隔离方式运行：独立 `PI_CODING_AGENT_DIR`，
`PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`，内存设置，`noExtensions`，
Skills 只来自夹具目录。MCP 为本地 streamable HTTP 夹具服务器，带 Bearer 校验。
问答、Todo、子代理由探针中的 GoodBuddy 扩展工具实现。

### 确定性模型（本地 Chat Completions 夹具，外部请求 0 次）

```text
node scripts/validate-pi.mjs
```

16 项全部通过，25 次本地模拟请求。脚本自行安装 Pi 到任务目录，复制精简候选后运行。

| 场景 | 结果 |
| --- | --- |
| 宿主启动 | bundle 加载到会话就绪约 0.18–0.2 秒；就绪时 RSS 约 89–93 MiB |
| 流式文本、多轮 | 多个 `text_delta`；`agent_settled` 到达；第二轮正确回忆 |
| PowerShell | 工具执行并返回输出 |
| 文件读写 | `read` 读取夹具，`write` 写入，内容核验通过 |
| Skill | 系统提示包含技能位置，`read` 读取后得到独有标记 |
| MCP | `mcp__probe__echo` 调用成功，Bearer 校验无拒绝 |
| 问答 | 扩展 UI `select` 投递问题和选项；回答 `blue` 回到模型；跳过返回明确结果 |
| Todo | 一次 `goodbuddy_todo_write` 产生一次完整清单，状态顺序正确 |
| 子代理 | 子会话事件带父调用 ID 回传 4 条，父回复得到子结果 |
| 上游 HTTP 400 | `stopReason=error`，错误文本可读；下一轮恢复 |
| 在途命令取消 | `stopReason=aborted`，PowerShell 工具 `failed`；Node 后代进程已退出，10 秒后未写出延迟文件 |
| 取消后继续 | 同一会话正常回答 |
| 宿主重启恢复 | 新 UtilityProcess 用 `SessionManager.open()` 打开同一会话文件，历史可回忆 |

### 真实模型（GoodBuddy 默认 `gpt-6-astra` / OpenAI Responses）

```text
node scripts/validate-pi.mjs --live --max-calls=14
```

7 项全部通过，**13 次真实上游请求，均为 HTTP 200**。凭据在 Electron Main 内解密，经回环
转发器用 `net.fetch` 发送；宿主只拿到占位密钥。次数不代表计费次数。

| 场景 | 结果 |
| --- | --- |
| 文本 | 精确返回 `PI-LIVE-OK`，5 个文本增量 |
| PowerShell | 模型调用 `powershell` 并返回命令输出 |
| Skill | 模型读取技能文件并返回标记 |
| MCP | 模型调用 `mcp__probe__echo`，返回精确输出 |
| 问答 | 模型调用 `goodbuddy_ask_user`，收到 1 个问题，回答后返回 `COLOR=blue` |
| Todo + 子代理 | 先更新 Todo，再委派子代理，子事件 8 条，父回复返回子结果 |

每次运行后任务目录已删除，用户 GoodBuddy 设置文件未变化。

### 未验证范围

- 产品路径：选择器、设置迁移、能力分配、问答卡片、顶部待办、子代理展示均未实现。
- 模型协议：只测了 Chat Completions（夹具）与 Responses（真实）；Anthropic Messages 未测。
- MCP 通过 `pi.registerMcpServer()` 注册（设计采用，避免令牌落盘）未测；探针使用 `mcp.json`。
  经 `KnowledgeMcpGateway` 的内置业务 MCP 与 stdio MCP 代理未测。
- 模型通过 `modelRuntime.registerProvider()` 注册未测；探针使用 `models.json`。
- 复用 `ModelBridgeLoopbackProxy` 未测；探针使用独立转发器。
- Linux/macOS 的 Bash 工具与取消后代回收未测。
- 多会话并发共享宿主、手动压缩、推理档位、图片输入、子代理取消与子代理问答未测。
- 严格断网审计未做；`PI_OFFLINE` 的效果只按上游文档声明，没有抓包确认。
- 同条件安装包体积、安装后占用与空闲内存对比未做；14.56 MiB 为资源文件合计。
