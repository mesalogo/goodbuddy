# Pi Runtime 技术设计

实现 [PRD](./prd.md) 的 FR-1 至 FR-12。通用要求以[接入规范](../../README.md)为准；源码位置
基于 2026-11-16 的 `main`。

## 1. 总体结构

```text
Renderer ──IPC──▶ Main
                   ├─ PiRuntime (AgentRuntime)          src/main/agent/pi-runtime.ts
                   ├─ PiHostLauncher                    src/main/agent/pi-host-launcher.ts
                   ├─ ModelBridgeLoopbackProxy (复用)   真实凭据只在 Main
                   └─ KnowledgeMcpGateway (复用)        内置业务 MCP / 自定义 MCP 授权
                          │ utilityProcess.fork + MessagePort
                          ▼
                  Pi 宿主 (UtilityProcess)              src/main/pi-host-bootstrap.ts
                   ├─ Pi 官方 bundle (dist/bundle/index.js, 动态 import)
                   ├─ ModelRuntime: 仅 goodbuddy provider → 回环模型桥
                   ├─ AgentSession × N（按 GoodBuddy 会话）
                   └─ 官方 MCP 注册与原生交互适配（不补问答 / Todo / 子代理工具）
```

选择 SDK 而非 `pi --mode rpc`：SDK 允许宿主替换设置、资源加载、会话存储和工具集合，且
扩展 UI（select/confirm/input）可以直接映射到问答卡片。宿主仍在独立 UtilityProcess 中运行，
保持与 DSH 相同的崩溃隔离和进程树回收边界。

## 2. 宿主进程与协议

- 启动方式沿用 DSH：`utilityProcess.fork(bootstrap, [], { cwd, env, serviceName, stdio:['ignore','ignore','pipe'] })`
  （参考 `src/main/index.ts:476-491`），退出时按已知 PID 回收进程树。
- 进程复用：按 `pi:<modelProfileId>` 通过 `localRuntimeRegistry` 共享一个宿主，宿主内按
  GoodBuddy 会话持有独立 `AgentSession`。工作区随会话传入，Pi 的 `cwd`、工具路径和会话分组
  都按会话设置。资源归属规则沿用[进程复用](../../design/process-reuse.md)。
- 协议：版本化消息，zod 校验，经 UtilityProcess `postMessage` 传输。不使用 ACP，因为 Pi 本身
  不是 ACP Agent，增加一层转换没有收益。

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| Main→宿主 | `start{protocol, version, bundlePath, agentDir, modelBridge, env}` | 握手；宿主返回 `ready{piVersion, ms}` 或 `fatal{code}` |
| Main→宿主 | `session/open{conversationId, workspace, sessionFile?, skills, mcp, instructions, tools, model, thinking}` | 新建或恢复会话，返回 `sessionId`、`sessionFile` |
| Main→宿主 | `session/prompt{requestId, text, files?}` | 一次前台请求 |
| Main→宿主 | `session/abort{requestId}` | 调用 `session.abort()`，等待 idle 后回 `aborted` |
| Main→宿主 | `session/compact`、`session/release` | 手动压缩；释放会话并 `dispose()` |
| Main→宿主 | `question/answer{questionId, value \| skipped}` | 迟到答案按 questionId 丢弃 |
| 宿主→Main | `event{requestId, parentCallId?, …}` | 见第 4 节 |
| 宿主→Main | `question{requestId, questionId, parentCallId?, title, options, kind}` | 映射 `LiveAgentQuestion` |
| 宿主→Main | `prompt/settled{requestId, stopReason, error?}` | 以 `agent_settled` 为准，不以 `agent_end` 结束请求 |

## 3. 隔离与配置

宿主环境与 Pi 设置全部由 GoodBuddy 生成，不读取用户 `~/.pi`：

| 项 | 设置 |
| --- | --- |
| 配置目录 | `PI_CODING_AGENT_DIR=<userData>/runtimes/pi/agent`，`HOME`/`USERPROFILE` 不改 |
| 网络 | `PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`；禁用模型目录刷新与版本检查 |
| 设置 | `SettingsManager.inMemory({ defaultTools, compaction, retry })`，不写盘 |
| 资源 | `DefaultResourceLoader`：`noExtensions`（不加载发现到的扩展）、`noPromptTemplates`、`noThemes`；`noContextFiles` 待 PRD D-2 决定 |
| Skills | `additionalSkillPaths` = 分配给 `pi` 的 `RuntimeSkillPackage.directory`；`skillsOverride` 只保留这些路径，排除项目 `.pi/skills` 与用户目录 |
| 工具 | Windows `read, powershell, edit, write, grep, find, ls`；其他平台以 `bash` 替代 `powershell` |
| 会话存储 | `SessionManager.create(workspace, <userData>/runtimes/pi/sessions)`；GoodBuddy 会话保存 `sessionFile`，恢复时 `SessionManager.open()` |

项目 `.pi/` 下的设置和扩展不加载，因此不涉及 Pi 的 project trust 提示。安全边界仍是统一执行
规则：Pi 工具不逐次审批（`requiresToolApproval = false`），与 DSH 一致。

## 4. 模型与凭据

- 复用 `ModelBridgeLoopbackProxy`（`src/main/agent/native-terminal-client.ts:152-186` 已用于原生终端），
  宿主只拿到回环地址和 `MODEL_BRIDGE_SDK_AUTH_SENTINEL` 占位密钥。转发走 Electron `net.fetch`，
  因而继承系统代理与已有的自定义 header/body 处理。
- Pi 模型注册：写入 `agentDir/models.json` 中唯一的 `goodbuddy` provider，或在宿主内调用
  `modelRuntime.registerProvider('goodbuddy', …)` 避免落盘（实现时优先后者，需补测）。

| GoodBuddy 协议 | Pi `api` |
| --- | --- |
| `openai-chat-completions` | `openai-completions` |
| `openai-responses` | `openai-responses` |
| `anthropic-messages` | `anthropic-messages` |

- 推理档位映射为 Pi `thinkingLevel`（`off/minimal/low/medium/high/xhigh/max`），模型不支持时
  按[选择合同](../../contracts/selection.md)处理，不自行回退。
- 用量来自 assistant `message_end.message.usage`，按请求归属发出 `RuntimeModelUsageEvent`
  （`runtime: 'pi'`）。

## 5. 事件映射

| Pi 事件 | GoodBuddy `AgentEvent` |
| --- | --- |
| `message_update` / `text_delta` | `text` |
| `message_update` / `thinking_delta` | `reasoning` |
| `tool_execution_start` | `tool{state:'running', callId, name, input}` |
| `tool_execution_update` | `tool{state:'running', output 预览}` |
| `tool_execution_end` | `tool{state: isError ? 'failed' : 'completed', output}` |
| `message_end`（assistant） | 用量；`stopReason=error` 记录错误文本 |
| `compaction_start/end` | `context-compression` |
| `agent_settled` | 结束请求：`stop`→`done`，`aborted`→`error{cancelled}`，`error`→`error{failed}` |

工具输出预览沿用现有截断规则；Pi 对超长 MCP 文本已有中间截断并保存临时文件，全文读取能力
首版不声明。

## 6. 能力映射

### 6.1 Skills 与 MCP

- Skills：Pi 的 `SKILL.md` frontmatter 与 GoodBuddy 技能包格式兼容，验证中模型可在系统提示
  中看到技能位置并读取。Skill 预算与命名约束沿用 `capability-service` 的现有检查。
- 自定义 MCP 与内置业务 MCP：在 GoodBuddy 扩展中调用 `pi.registerMcpServer(name, { url, headers, exposure })`，
  不把 Bearer token 写入 `mcp.json`。连接目标是 `KnowledgeMcpGateway` 的回环端点，令牌由
  `grantCustomMcp` / `grantScopedDataCapability` 按请求签发并在结束时撤销（参考 Continue：
  `continue-runtime.ts:451-489`）。`supportsScopedDataTools = true`。
- 暴露方式：分配的服务器使用 `direct`，避免依赖 codemode/tool_search；工具名为
  `mcp__<server>__<tool>`。全局禁用后，下一次 `session/open` 或请求前同步注册列表。
- stdio 自定义 MCP 也由同一网关代理，宿主不直接启动 MCP 子进程，保持 MCP 进程归属在 Main。

### 6.2 问答

仅适配原生流程实际发出的 `select/confirm/input` 交互，不新增 `goodbuddy_ask_user` 工具。
UI 协议存在不等于模型拥有结构化提问能力；普通文字提问继续使用聊天消息。

跳过返回明确的工具结果文本；取消请求时 abort signal 结束等待并发出 `question-resolved`；
迟到答案按 `questionId` 丢弃。

### 6.3 Todo

Pi 默认无 Todo 工具，不注册 `goodbuddy_todo_write`，不增加 checklist source。
官方 Todo 示例和历史探针均不作为产品能力来源。

### 6.4 子代理

Pi 默认无子代理工具，不注册 `goodbuddy_subagent`，不加载官方 subagent 示例。
历史探针的子会话实验只证明 SDK 可扩展，不构成当前接入要求。

## 7. 取消与资源回收

- `session.abort()` 中止模型流和正在运行的工具。Windows PowerShell 工具的命令后代在取消后
  被回收，已在验证中确认（第 3 节测试 `cancel-command`）；Linux Bash 路径需补测。
- 请求取消后会话可继续（已验证）。`session/release` 调用 `dispose()`；宿主空闲且无会话时按
  注册表规则退出。应用退出时 Main 回收宿主进程树。
- 宿主崩溃：进行中的请求以 `failed` 结束，下一次请求重新拉起宿主并按 `sessionFile` 恢复。

## 8. 打包

- 运行资源：`@earendil-works/pi-coding-agent/dist/bundle`、`dist/core/export-html`、
  `dist/modes/interactive`（主题与资源）、`package.json`，外加 `jiti`、`@silvia-odwyer/photon-node`。
  去除 sourcemap 与类型声明后 14.56 MiB。
- 这些文件以原样放入 `app.asar.unpacked`（bundle 内有 Worker 与动态 import，不能从 asar 读取，
  也不交给 electron-vite 重新打包）。由 `build/runtime-hooks.cjs` 的准备步骤复制，
  `build/verify-desktop-runtimes.cjs` 校验文件存在与版本。
- 宿主 bootstrap 由 electron-vite 构建为稳定文件名（同 DSH，`electron.vite.config.ts:62-74`）。
- 若 PRD D-1 选择应用市场，则同一组文件作为可选资源包，宿主路径由安装管理提供，其余设计不变。
- 与 DSH 的 `pi-ai`：官方 bundle 内已包含 Pi 自身依赖，不与 DSH 共享，体积数据已按此计算。

## 9. 注册改动清单

| 范围 | 位置 |
| --- | --- |
| Provider 与选择 | `src/shared/runtime-selection-contracts.ts`（providers、schema、`allowedRuntimeProviders`、兼容判断、`configuredGlobalModel`）；`src/main/agent/runtime-selection.ts` |
| 设置 | `src/shared/contracts.ts`（`runtimeProviderSchema`、`piModelSource`、状态/检测类型）；`src/main/runtime-settings-store.ts` 新版本与迁移 |
| 能力分配 | `src/shared/capability-contracts.ts`（`runtimeTargetSchema`，`capabilityAssignmentsSchema.max(4)` 调整为 5）；`src/shared/builtin-mcp-servers.ts`；`src/main/capabilities/capability-service.ts` |
| 工厂与上下文 | `src/main/agent/create-runtime.ts`；`src/main/index.ts`（启动器、能力上下文）；`src/main/ipc.ts`（`isAgentRuntime`、用量/图像判断） |
| 资源 | `src/main/agent/bundled-runtimes.ts`、`runtime-discovery.ts`、`package.json` build 配置 |
| Renderer | `SettingsPanel.tsx`、`McpSettingsSection.tsx`、`SkillsSettingsSection.tsx`、`ProjectRuntimeSelector.tsx`、`RuntimeModelPicker.tsx`、`ActivityPanel.tsx` 用量标签、`App.tsx` 原生入口（首版隐藏） |
| i18n | `app.ts`、`integrations.ts`、`settingsSections.ts`、`settings.ts`、`activity.ts`（中英文） |
| 远程 | 不改：`remote-runtime-launch-contracts.ts` 等保持 opencode/continue |

## 10. 实施顺序与验收

1. 资源准备与宿主：bootstrap、协议、启动器、打包与 `verify-desktop-runtimes`；单元测试参照
   `deepseek-harness-utility-launcher.test.ts`。
2. 注册与设置：provider、迁移、能力分配上限、Renderer 选择器与 i18n；更新
   `ProjectRuntimeSelector.test.tsx` 等断言 provider 列表的测试。
3. `PiRuntime`：会话、事件、取消、恢复、用量；集成测试使用确定性模型（参照
   [validate-pi](../../../../../scripts/validate-pi-main.mjs) 的脚本模型）。
4. 能力：Skills、官方 MCP 经网关、原生 UI 交互；不补 Todo、子代理或模型提问工具。
5. 产品验收：真实 UI 提交、三种模型协议、全局能力变更同步、取消/重启、Linux 本地路径，
   以及同条件安装包体积与内存对比；结果写入[验证进度](./progress.md)和能力矩阵。
