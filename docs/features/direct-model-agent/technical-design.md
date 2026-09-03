# 直连模型 Agent 能力技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 已实施 |
| 版本 | 0.3 |
| 日期 | 2026-09-03 |
| 关联 PRD | [PRD](./prd.md) |
| 功能逻辑 | [功能逻辑设计](./logic-design.md) |
| 相关架构 | [助手工作栏与执行空间](../assistant-workbar/prd.md)、[本机工具环境](../local-tool-environment/technical-design.md) |

## 1. 实现基线

当前源码已经实现：

- `ModelAgentRuntime` 的多轮工具调用、上下文压缩、取消、用量和有界结果处理。
- `ModelToolProvider` 的直连模型内置工具、浏览器、Web、知识和自定义 MCP 聚合。
- `WorkspaceAccess` 的本机和远端工作区抽象。
- 跨平台子进程树终止辅助函数。
- 面向用户专家协作的 `SubagentScheduler`、状态事件和只读模型调用。
- OpenCode、Continue 和 DeepSeek Harness 各自的 Shell/Agent 能力。
- 直连模型 `process_execute` 和 `subagent_delegate`。
- 不创建顶层 Task/Conversation 的编程 Subagent actor 与活动归并。

## 2. 总体架构

```text
ModelAgentRuntime
  └─ ModelToolProvider
       ├─ WorkspaceAccess
       ├─ DirectModelProcessService
       │    └─ LocalDirectModelProcessService
       ├─ DirectModelSubagentService
       │    ├─ SubagentScheduler
       │    └─ 同一 ModelAgentRuntime 的临时子会话
       │         └─ 同一 ModelToolProvider（delegationDepth=1 时移除委派）
       ├─ Browser / Web / Knowledge
       └─ assigned MCP
```

OpenCode、Continue 和 DeepSeek Harness 的创建路径不接收
`DirectModelProcessService` 或 `DirectModelSubagentService`。DeepSeek Harness 即使继续使用
`ModelToolProvider` 代理 Web/MCP，也必须通过明确的工具视图排除直连模型专属工具。

## 3. 共享工具目录

`BuiltinModelToolSummary` 增加 `programming` 分组和 Runtime 可见性：

```ts
type BuiltinModelToolSummary = {
  name: string
  displayName: string
  description: string
  access: 'read' | 'write'
  group: 'filesystem' | 'browser' | 'web' | 'programming'
}
```

`process_execute` 标记为 `write`，只在 Execute 清单中出现。
`subagent_delegate` 的实际访问级别由父模式决定：

- Ask 清单中提供只读委派定义。
- Execute 清单中提供继承 Execute 的定义。
- `callTool` 不依赖静态 `access` 单独授权，必须检查父请求上下文。

工具总数和 schema 总字节继续计入直连模型现有 100 个工具与 512 KiB 上限。

## 4. 进程工具契约

### 4.1 输入

```ts
const processExecuteInputSchema = z.object({
  command: z.string().trim().min(1).max(100_000),
  cwd: z
    .string()
    .trim()
    .min(1)
    .max(4_096)
    .optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(10 * 60_000)
    .default(120_000)
}).strict()
```

- `cwd` 只接受相对工作区路径。
- 首版不接受 `env`、`stdin`、`background`、`pty`、`shell` 或任意 executable 参数。
- Shell 选择由执行后端决定，防止模型绕过平台契约启动另一套受管接口。
- 命令字符串仍可以调用当前账号本来有权运行的程序；Execute 不增加命令白名单。

### 4.2 结果

```ts
type ProcessExecuteResult = {
  shell: {
    kind: 'powershell' | 'bash' | 'sh'
    label: string
  }
  cwd: string
  exitCode: number | null
  signal?: string
  terminationReason?: 'timeout' | 'cancelled'
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}
```

`cwd` 返回工作区相对显示值，不把不必要的绝对用户路径送入模型上下文。Shell 在模型结果
中只返回稳定标签；绝对可执行路径只进入 Main 诊断状态。

### 4.3 输出边界

- stdout 和 stderr 各最多 96 KiB。
- 超限时分别保留前 48 KiB 与最后 48 KiB，中间插入固定截断标记。
- JSON 结果加上元数据后必须低于 `ModelToolProvider` 现有 256 KiB 工具结果上限。
- 流式读取在收到数据时执行边界，不先积累无界 Buffer。
- 输出按 UTF-8 解码，无效序列使用替换字符并保留字节计数。

## 5. 平台执行

### 5.1 Shell 探测

启动直连模型执行服务时解析一次 Shell：

```text
Windows: PATH 中 pwsh → Windows PowerShell powershell.exe
macOS:   /bin/bash → /bin/sh
Linux:   /bin/bash → /bin/sh
```

Shell 不可用时保留直连模型对话能力，但不注册 `process_execute`。设置目录继续展示静态能力
说明，实际 Shell 通过每次请求的工具定义和结果可见；当前不增加独立 Shell 诊断 IPC。
不下载或捆绑新的 Bash/PowerShell。

### 5.2 启动参数

```text
PowerShell:
  <shell> -NoLogo -NoProfile -NonInteractive -Command <command>

Bash:
  /bin/bash -c <command>

Sh:
  /bin/sh -c <command>
```

使用 `spawn(executable, args, { shell: false })`，避免 Node 再增加一层平台 Shell。POSIX 子进程
作为独立进程组启动；Windows 记录根 PID。停止时复用现有
`terminateProcessTreeAndWait`：Windows 使用 `taskkill /T /F`，POSIX 终止本次进程组并等待
有界退出。

### 5.3 环境

进程环境由 Main 构造：

- 继承运行普通项目命令所需的当前用户基础变量。
- 当前使用筛选后的用户 PATH；[本机工具环境](../local-tool-environment/technical-design.md)
  实施后可通过现有 `toolBinDirectory` 注入口把受管 bin 放在 PATH 前面。
- 排除模型 Provider Key、GoodBuddy 加密设置、调试变量和无关应用凭据。
- 不修改 `process.env`，不写系统 PATH 或 Shell Profile。
- 每次调用得到独立环境快照；命令内设置的变量不会进入下一次调用。

## 6. 执行空间绑定

定义一个小型进程后端接口，不把任意进程能力塞进 `WorkspaceAccess`：

```ts
interface ExecutionSpaceProcessExecutor {
  getCapability(): Promise<
    | { available: true; shell: ProcessShellSummary }
    | { available: false; reason: string }
  >
  execute(
    input: ProcessExecuteInput,
    context: {
      workspace: WorkspaceAccess
      signal: AbortSignal
    }
  ): Promise<ProcessExecuteResult>
  dispose(): Promise<void>
}
```

首版只有 `LocalProcessExecutor`。`ExecutionSpaceDescriptor.kind === 'ssh'` 时使用不可用实现，
工具清单不注册进程能力。未来远端实现必须新增 Agent 协议、由 Agent 直接拥有命令进程，并
按远端身份、取消和断线语义验证；不得把 SSH 路径传给本机 executor。

工作目录通过 `WorkspaceAccess.getIdentity()` 和本机真实路径解析共同确认。路径检查与 spawn
之间若目录被外部替换，spawn 失败并返回准确错误；不为此增加持久路径凭据或恢复协议。

## 7. Subagent 工具契约

### 7.1 输入

```ts
const subagentDelegateInputSchema = z.object({
  task: z.string().trim().min(1).max(100_000)
}).strict()
```

首版一次调用只创建一个子任务。不同父请求可以通过全局调度器并发，不增加批量委派 schema。

### 7.2 子请求

`DirectModelSubagentService` 创建临时子请求：

```ts
type DirectModelSubagentContext = {
  parentRequestId: string
  childRunId: string
  projectId?: string
  conversationId: string
  workMode: 'ask' | 'execute'
}
```

- 子 `conversationId` 只用于 Runtime 内存和工具会话隔离，完成后立即
  `releaseConversation`，不保存为用户 Conversation。
- 子 Prompt 使用明确任务和 Main 可信的编程 Subagent 指令，不复制父会话历史。
- 子级使用父请求模型连接，首版不增加单独模型选择设置。
- 子级复用父请求已授权能力快照和知识范围。
- 子级复用父 Provider；Main 写入的 `delegationDepth=1` 同时在清单和调用边界过滤
  `subagent_delegate`。
- Ask 子级使用 Ask 清单；Execute 子级使用 Execute 清单。

### 7.3 调度和结果

- 复用 `SubagentScheduler` 的取消、并发和队列模式。
- 全局最大并发 3，队列最大 20。
- 单个子任务最长 10 分钟；父请求更早取消时立即停止。
- 文本结果最多 192 KiB，错误最多 2 KiB，连同结构化字段保持在 256 KiB 工具结果上限内。
- 模型用量逐事件归属父请求和 `childRunId`，不能只算入父模型最后一轮。
- 子级失败和取消返回结构化终态及部分输出，让父模型决定下一步。

### 7.4 领域持久化

当前 `SubagentService` 为历史专家流程创建隐藏 Child Task。新编程 Subagent 不复制该行为：

- 运行身份使用内部 `childRunId`。
- 父消息通过现有 `subagent` 活动块保存终态和结果摘要。
- 若通用 Job/Subjob 表已经实现，则记录为所属父 Task/请求的 Subjob/Run。
- 若通用 Job/Subjob 表尚未实现，首版只保存现有消息活动和模型用量，不先创建另一套持久
  子任务表、恢复日志或兼容读取器。

可以提取现有 Scheduler、事件归并和用量转发逻辑，但不能把旧数据库字段当成新的产品模型。

## 8. ModelToolProvider 接入

`ModelToolCallContext` 增加不可伪造的运行上下文：

```ts
type ModelToolCallContext = {
  conversationId: string
  requestId: string
  runtimeTarget: 'model'
  workMode: 'ask' | 'execute'
  executionSpaceIdentity: string
  delegationDepth: 0 | 1
  knowledgeCapabilityToken?: string
}
```

要求：

- `listTools` 根据模式、执行空间能力和深度生成快照。
- `getApproval` 不为两个工具创建第二套逐次确认；沿用父 Execute 授权和现有通道工具策略。
- `callTool` 再次检查 `runtimeTarget`、模式、执行空间 identity、深度和请求是否活动。
- `releaseConversation` 取消并释放该会话拥有的浏览器、Subagent 和进程。
- `dispose` 等待有界清理，不因模型或子进程不响应而阻塞应用退出。

DeepSeek Harness 的 Main 工具代理必须使用仅包含分配 MCP 和 Web 的 Provider 视图，不能因为
共享 `ModelToolProvider` 类而自动看到直连模型编程工具。

## 9. 事件与活动

### 9.1 进程事件

继续使用现有 Runtime `tool` 事件：

- `pending`：参数已接收。
- `running`：Shell 已成功启动。
- `completed`：返回 exit 0 或非零退出结果。
- `failed`：启动或契约失败。
- `cancelled`：父请求取消。

结果摘要包含 Shell、相对目录、退出码、耗时和截断标记。完整有界 stdout/stderr 进入工具
输出字段，不写应用诊断日志。

### 9.2 Subagent 事件

复用现有 `subagent` 公开事件和消息块，增加 `routingMode: 'native'` 表示模型主动委派。
`expertId` 不再作为编程 Subagent 必填身份；共享 schema 应改为执行者 discriminated union，
而不是伪造一个专家记录：

```ts
type SubagentActor =
  | { kind: 'expert'; expertId: string; expertName: string }
  | { kind: 'direct-model'; label: '编程 Subagent' }
```

迁移只需让读取器接受旧专家事件和新联合类型，不重写既有消息。

## 10. 错误处理

| 情况 | 结果 |
| --- | --- |
| 命令非零退出 | 正常 `ProcessExecuteResult` |
| 命令不存在 | Shell 非零退出及 stderr |
| Shell 无法启动 | 工具失败 |
| cwd 无效或越界 | 工具调用前失败 |
| 超时/取消 | 终止进程树，返回已有输出和原因 |
| 直连模型瞬时网络错误/请求超时，尚无可见输出 | 500 ms、1 s、2 s 退避，最多自动重试 3 次 |
| 直连模型失败，已有文本或推理输出 | 保留部分输出并失败，不自动重放 |
| 子级模型失败 | 返回 `failed`、部分输出和错误 |
| 子级工具失败 | 由子模型处理；最终无法完成时返回子级失败 |
| 父请求已终止 | 拒绝新调用，丢弃迟到内容并清理 |

不要用宽泛 catch 抹掉取消、超时、Provider HTTP 状态或进程退出上下文。

模型请求重试由 `ModelAgentRuntime` 的统一流式请求边界处理，覆盖普通问答、工具轮次和复用
同一 Runtime 的上下文摘要。重试分类检查错误及有界 `cause` 链中的 Node/Undici 网络错误
码；每次尝试创建独立超时信号。退避等待监听父请求取消。只有完整模型轮次返回后才执行
工具，因此未产生可见文本或推理内容的重试不会重复执行工具。

## 11. 性能

- Shell 探测按执行服务实例缓存，不在每轮模型调用重复探测。
- stdout/stderr 边读边界定，避免大日志进入内存后再截断。
- 子级共享父请求已解析的模型配置和工具服务，不复制 MCP 配置或持久状态。
- 不增加持久 Shell、后台 daemon、工作区快照或恢复状态机。
- 命令执行不使用 PTY，避免普通构建和测试承担终端渲染成本。

## 12. 测试策略

### 12.1 单元测试

- 工具可见性矩阵和 Runtime target 过滤。
- Ask 伪造进程调用拒绝。
- Windows PowerShell、POSIX Bash/Sh 选择和参数。
- cwd 默认、合法子目录、越界、符号链接越界和不存在。
- exit 0、非零退出、spawn 失败、超时、取消和输出截断。
- 环境筛选、本机工具 PATH 优先且模型凭据不进入进程。
- 子级模式、模型、项目、执行空间和能力继承。
- 深度 1 过滤、并发 3、队列 20、取消传播和部分输出。
- 编程 Subagent 不创建 Task/Conversation。
- DeepSeek Harness/OpenCode/Continue 不获得本功能工具。
- TLS 建连 `ECONNRESET`、Undici 连接超时、单次请求超时、三次重试上限和退避取消。
- 已产生文本或推理增量后发生网络错误时不自动重放。

### 12.2 本机集成测试

- Windows PowerShell 创建临时文件、运行 Node/Python、非零退出和进程树取消。
- macOS/Linux Bash/Sh 执行相同场景。
- 直连模型工具循环执行“修改 → 测试失败 → 修复 → 测试通过”。
- 父模型委派子级修改或验证专用临时项目，并正确综合结果。
- Runtime 切换后工具清单刷新且没有重复 Shell。
- 应用退出后无残留 GoodBuddy 命令进程。

所有测试只在专用临时工作区创建文件，不删除或覆盖用户工作。

### 12.3 真实模型验证

使用一个最小真实直连文本模型请求：

1. Execute 创建一段有缺陷的小程序。
2. 调用进程工具运行聚焦测试并观察失败。
3. 修改程序并再次运行到通过。
4. 委派一个 Subagent 检查实现或补充测试。
5. 父模型读取子级结果并给出最终结论。

每个平台一次完整场景即可，不进行批量或高成本调用。记录准确模型调用次数，不记录 API Key。

### 12.4 项目验证

源码完成后运行：

```text
npm test
npm run typecheck
npm run lint
npm run build
```

跨平台进程实现必须由 Windows、macOS、Linux x64 和 Linux arm64 CI 验证。首版不改变
GoodBuddy Agent 或桌面到 Agent 生产路径，因此不要求远端 Host 验证；未来增加远端 executor
时必须按远程主机技术设计执行共享 Linux Host 真机验证。

## 13. 实施顺序

1. Shared 工具摘要、schema 和 Runtime target 过滤。
2. 本机 Shell 探测、进程执行、输出边界和进程树取消。
3. `ModelToolProvider` Execute 接入及 UI 活动。
4. 编程 Subagent 服务、过滤 Provider、事件和用量。
5. 设置能力目录与状态诊断。
6. 三平台真实命令、真实模型和完整项目验证。

每一步都必须保持直连模型正常问答可用；Shell 不可用不能阻止普通对话。
