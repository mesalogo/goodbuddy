# 直连模型 Agent 能力 PRD

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 已实施，跨平台 CI 待验证 |
| 版本 | 0.2 |
| 日期 | 2026-09-01 |
| 适用产品 | GoodBuddy 桌面端 |
| 目标平台 | Windows、macOS、Linux，x64 与 arm64 |
| 关联领域 | [Task 与 Job 统一领域模型](../task-and-job/task-and-job-model.md) |

## 1. 背景

GoodBuddy 直连模型已经可以读取、列出和写入工作区文本，使用浏览器、联网搜索、知识库及
分配的 MCP，但没有内置命令执行工具。模型可以生成代码，却不能运行构建、测试、格式化、
Git 或项目脚本，因此无法独立验证结果。

GoodBuddy 也已经有面向用户专家协作的只读 Subagent，但直连模型不能在自己的工具循环中
主动委派一个聚焦的编程子任务。OpenCode、Continue 和 DeepSeek Harness 一般已经提供
Shell、Agent 或 Task 能力，再向它们注入 GoodBuddy 同名工具只会造成重复入口和语义冲突。

本功能只补齐直连模型缺少的基础 Agent 能力：

1. 一个按平台适配的进程执行接口。
2. 一个单层、继承父请求范围的编程 Subagent 接口。

## 2. 产品目标

1. 让直连模型在 Execute 模式完成“读取代码 → 修改 → 运行 → 根据结果修正”的闭环。
2. 在 Windows、macOS 和 Linux 使用同一个模型工具契约，不要求模型调用平台专属工具名。
3. 让直连模型可以把独立工作委派给临时 Subagent，并取得有界、可核验的结果。
4. 保持 Ask 只读、Execute 完整授权、执行空间、取消、有界输出和进程回收语义不变。
5. 不向已有原生执行能力的 Agent Runtime 重复注入 GoodBuddy 进程或 Subagent 工具。

## 3. 核心产品决策

### 3.1 统一工具名，平台适配留在 Main

模型只看到 `process_execute`。GoodBuddy 根据当前平台选择 PowerShell、Bash 或 Sh，并在
工具描述和结果中明确实际 Shell。模型不需要在 Windows 调用 `powershell_execute`、在
macOS/Linux 改用 `bash_execute`。

### 3.2 它是内置能力，不依赖 MCP

进程生命周期、工作目录、取消和执行空间由 GoodBuddy 管理。用户仍可以配置提供其他命令
能力的 MCP，但直连模型的基本编程能力不依赖第三方 MCP 是否安装或在线。

### 3.3 Runtime 能力不重复注入

| Runtime | GoodBuddy `process_execute` | GoodBuddy `subagent_delegate` |
| --- | --- | --- |
| 直连模型 `model` | Execute 提供 | Ask/Execute 提供 |
| OpenCode | 不提供 | 不提供 |
| Continue | 不提供 | 不提供 |
| DeepSeek Harness | 不提供 | 不提供 |

“不提供”只表示不注入本功能工具，不限制 Runtime 自己的 Bash、PowerShell、Task、
Agent 或插件能力。

### 3.4 Subagent 继承，不扩权

Subagent 使用父请求的项目、执行空间、工作模式、直连模型连接和已启用能力快照：

- Ask 父请求只能创建 Ask Subagent。
- Execute 父请求创建 Execute Subagent。
- 子级不能切换项目、目录、Runtime、模型连接或工作模式。
- 子级不再看到 `subagent_delegate`，首版最大委派深度固定为 1。
- 子任务不是新的顶层 Task 或 Conversation，结果先返回父模型。

### 3.5 不新增权限档位

Ask 禁止命令和写入。Execute 是用户对当前执行空间账号的完整授权。进程和 Subagent 不增加
“受控执行”“仅测试”“可信命令”或逐命令风险等级，也不重复弹出第二套确认。

## 4. 功能范围

### 4.1 包含

- 本机 Windows、macOS、Linux 的前台 Shell 命令执行。
- 当前工作区默认工作目录及合法子目录选择。
- Exit Code、标准输出、标准错误、Shell、目录、耗时和截断状态。
- 命令超时、用户取消、进程树停止和应用退出清理。
- 新进程使用当前本机工具环境提供的 Node、Python 和 PATH。
- 直连模型单层 Subagent 委派、排队、运行、部分结果、失败和取消。
- 父子请求的工具、模型用量、活动和成果归属。
- 桌面聊天和选择直连模型的消息通道项目使用相同 Runtime 能力矩阵。

### 4.2 不包含

- 交互式 PTY、终端复用、持续 stdin、密码提示或 TUI 自动化。
- 后台守护进程、任意 PID 枚举、接管或停止用户已有进程。
- Shell Session 持久化，环境变更不会跨 `process_execute` 调用保留。
- 首版远程 SSH 直连模型进程执行。
- 向 OpenCode、Continue 或 DeepSeek Harness 注入本功能工具。
- 递归 Subagent、长期运行的自治 Agent、Workflow、Hook 或恢复未完成子任务。
- 新的权限矩阵、逐命令批准、沙箱档位或命令白名单。
- 自动安装项目依赖；模型可以在 Execute 中显式运行项目已有的安装命令。

## 5. 功能需求

### FR-1 直连模型专属可用性

- 两个工具只由 Runtime provider `model` 注册。
- Agent Runtime 切换为 OpenCode、Continue 或 DeepSeek Harness 后不再显示这两个工具。
- 图像生成连接不获得文本 Agent 工具。
- 能力不可用时返回准确原因，不以其他 Runtime 或本机 Shell 静默代替。

### FR-2 跨平台进程执行

- 使用统一的 `process_execute` 工具契约。
- Windows 选择 PowerShell；macOS/Linux 选择 Bash，Bash 不可用时可使用 POSIX Sh。
- 每次调用启动一个前台进程树，完成后返回结构化结果。
- 非零退出码是可观察的命令结果，不自动转成模型请求失败。
- Shell 启动失败、非法参数或执行后端不可用才属于工具失败。

### FR-3 工作目录和执行位置

- 默认目录是父请求当前工作区。
- 可选工作目录必须解析为当前工作区本身或其子目录。
- 本机执行只能发生在当前桌面执行空间。
- 当前请求绑定 SSH 执行空间且没有远端进程后端时不注册工具，绝不在桌面目录回退执行。

### FR-4 Ask/Execute

- Ask 工具清单不包含 `process_execute`。
- Runtime 边界必须再次拒绝 Ask 发起的伪造命令调用。
- Execute 命令使用 GoodBuddy 客户端当前用户权限，不声称 Runtime OS 沙箱。
- 消息通道的直连模型 Execute 继续服从该通道既有工具策略。

### FR-5 Subagent 委派

- `subagent_delegate` 接受一个清晰的任务说明，不要求用户预先创建专家。
- 子级默认使用父请求选择的直连模型连接。
- 子级继承父请求的工作模式和能力上限，但不获得再次委派能力。
- 子级最终输出、部分输出、错误、用量和状态返回父请求。
- 父模型负责综合结果并向用户作最终回答。

### FR-6 Subagent 领域归属

- 子任务使用 Job/Subjob 语义，不创建 Task Center 条目或独立 Conversation。
- UI 对象层级继续止于用户 Task；活动可以显示 Subagent 状态卡，但不显示 Job/Run 树。
- 子任务产生的工具、成果和用量可追溯到父请求及子任务标识。

### FR-7 生命周期和资源边界

- 父请求取消必须传播到活动 Subagent 和其当前进程。
- Runtime 替换、会话释放和应用退出必须停止 GoodBuddy 创建的活动子进程。
- 命令、标准输出、标准错误、Subagent 提示、结果、队列和并发全部有界。
- 截断必须明确标记，不能把不完整输出伪装为完整结果。

### FR-8 环境和凭据

- 新进程使用筛选后的当前用户环境和本机工具环境 PATH。
- 模型 Provider 凭据、GoodBuddy 加密设置和无关桌面会话变量不进入命令环境。
- 首版不接受模型提交任意环境变量映射；需要的普通变量由 Shell 命令在单次调用中设置。

### FR-9 状态与活动

- 进程活动显示等待、运行、成功、非零退出、超时、取消和失败。
- Subagent 显示排队、运行、完成、失败和取消。
- 命令和子任务失败保留可操作错误及已有部分输出。
- 同一事件不同时显示页内错误和应用通知。

### FR-10 兼容

- 现有模型连接、MCP 分配、专家设置和 Runtime 选择无需迁移。
- 不改变现有 Agent Runtime 的工具清单或权限语义。
- 不修改系统 PATH、Shell Profile 或用户终端会话。

## 6. 产品验收

- [ ] Windows 直连模型 Execute 使用 PowerShell 创建文件、运行测试并读取退出码。
- [ ] macOS/Linux 直连模型 Execute 使用 Bash/Sh 完成同一工作流。
- [ ] Ask 中模型看不到进程工具，伪造调用也在 Main 边界失败。
- [ ] 直连模型可以委派编程子任务，子级运行命令并把结果返回父模型。
- [ ] Ask Subagent 保持只读；Execute Subagent 不增加第二套批准。
- [ ] Subagent 不能递归委派，不能切换父请求工作区、模式或模型。
- [ ] 切换到 OpenCode、Continue 或 DeepSeek Harness 后不出现本功能工具。
- [ ] 非零退出、超时、取消和输出截断均准确展示。
- [ ] 取消父请求和退出应用后没有残留 GoodBuddy 命令进程。
- [ ] 本机工具环境选择对新命令生效，Main 持有的模型凭据不进入子进程。
- [ ] 子任务不进入 Task Center，不创建独立可导航 Conversation。
- [ ] 全量测试、类型检查、Lint 和生产构建通过。
