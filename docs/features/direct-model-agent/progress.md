# 直连模型 Agent 能力功能进度

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档类型 | 功能进度 |
| 状态 | 已实施，本机验收完成 |
| 版本 | 0.3 |
| 日期 | 2026-09-03 |
| 关联入口 | [直连模型 Agent 能力](./README.md) |

## 当前结论

本机生产路径已经完成源码接线：直连模型 Execute 可运行平台 Shell，Ask/Execute 均可按
父模式委派单层编程 Subagent；OpenCode、Continue、DeepSeek Harness 和托管 SSH 路径不注入
这两个工具。Windows 本机、真实模型和全量项目验证已通过；macOS 与 Linux 真机验证仍需
由对应平台完成。

## 已确认的当前基线

- [x] 直连模型当前内置工作区读、目录列表和文本写入，但没有进程工具。
- [x] 内置 MCP 当前没有 Shell；自定义 MCP 不能替代开箱即用的进程能力。
- [x] `ModelAgentRuntime` 已有多轮工具循环、取消、上下文压缩和有界结果。
- [x] DeepSeek Harness 已按 Windows PowerShell、macOS/Linux Bash 注册原生 Shell。
- [x] OpenCode 和 Continue 使用各自原生执行工具。
- [x] 当前专家 Subagent 是只读协作流程，不是直连模型可调用的编程工具。
- [x] Task/Job 领域文档已经明确 Subagent 不是新的顶层 Task 或 Conversation。
- [x] 当前跨平台进程树清理已经覆盖 Windows `taskkill /T /F` 和 POSIX 进程组。

## 已完成设计

- [x] 工具只注入直连模型，不注入 Agent Runtime。
- [x] 统一 `process_execute` 契约和三平台 Shell 决策。
- [x] Ask/Execute、执行空间、工作目录和非零退出规则。
- [x] 输出、超时、取消、环境和进程树边界。
- [x] 单层 `subagent_delegate`、继承规则、并发和结果模型。
- [x] 不创建 Child Task/独立 Conversation 的领域归属。
- [x] 设置能力目录、聊天活动、错误和无障碍行为。
- [x] 本机、真实模型和项目验证方案。

## 实施状态

### 阶段 1：进程服务

- [x] Shared 工具和 schema。
- [x] 本机 Shell 探测与能力状态。
- [x] 工作目录解析。
- [x] 跨平台前台进程、输出边界、超时和取消。
- [x] 当前筛选 PATH 和凭据环境过滤。

### 阶段 2：直连模型接入

- [x] `ModelToolProvider` 注册与调用。
- [x] Ask/Execute、Runtime target 和本机执行空间双重检查。
- [x] DeepSeek Harness、OpenCode 和 Continue 隔离。
- [x] 通用工具活动和“设置 > MCP > 直连模型”编程能力目录。
- [x] 普通问答、工具轮次和上下文摘要的瞬时网络错误及请求超时最多自动重试 3 次。
- [x] 递增退避、重试状态、取消传播和已显示输出不重放。

### 阶段 3：编程 Subagent

- [x] 编程 Subagent 服务和同 Provider 深度过滤。
- [x] 父子模式、模型、执行空间和能力继承。
- [x] 深度、全局并发、队列、超时和取消。
- [x] 新 Subagent actor 契约和旧专家事件兼容读取。
- [x] 用量、部分输出、实时活动和终态归并。

### 阶段 4：端到端验收

- [x] Windows PowerShell 真实命令。
- [ ] macOS Bash/Sh 真实命令。
- [ ] Linux x64/arm64 Bash/Sh 真实命令。
- [x] 直连模型“修改 → 测试 → 修复”真实闭环。
- [x] 假模型端到端 Subagent 编程委派、真实本机命令和父模型综合。
- [x] 真实模型 Subagent 编程委派和父模型综合。
- [x] Runtime 隔离、取消、会话释放和进程树回收聚焦测试。
- [x] 全量测试、类型检查、Lint 和生产构建。

## 当前阻塞项

- 当前没有实现阻塞项。
- 本机工具环境仍处于计划阶段；在其实施前，进程工具可以使用当前筛选 PATH，但不能宣称
  GoodBuddy 托管 Node/Python 已可用。
- 远端直连模型进程执行不在首版，后续需要独立增加 Agent 进程协议和真机验证。

## 2026-09-01 至 2026-09-02 实施与验证证据

- 新增 `direct-model-process-service.ts`：PowerShell/Bash/Sh 探测、工作区目录校验、96 KiB
  首尾输出、超时、取消、进程树回收和环境过滤。
- 新增 `direct-model-subagent-service.ts`：单层委派、共享并发 3、队列 20、10 分钟上限、
  192 KiB 输出、父请求取消和临时会话释放。
- `ModelToolProvider` 只在直连模型上下文注册工具；Ask 隐藏进程工具，深度 1 隐藏委派工具，
  远端工作区拒绝本机进程。
- `ModelAgentRuntime` 复用同一已解析模型和 Tool Provider 运行子级，并把子级工具、用量和
  Subagent 活动实时归并到父请求。
- 新 actor 联合类型兼容既有专家/OpenCode 记录；编程 Subagent 不创建 Assistant Task。
- 聚焦验证：
  - 进程、Provider、Runtime、共享契约与聊天 UI：`290 passed, 1 skipped`。
  - 设置与 Runtime 隔离：`216 passed`。
  - Main/Shared 聚焦持久化与 Subagent：`188 passed, 1 skipped`。
  - Node 与 Web TypeScript no-emit 检查通过。
- 假模型端到端场景实际启动 Windows PowerShell，子级运行命令后返回父模型；该场景的
  Runtime 模型调用数为 4 次。
- 真实 DeepSeek 兼容连接端到端通过：模型创建失败程序、观察非零退出、修复并观察退出码
  0、委派编程 Subagent 再次运行最终程序并综合结果；最终源码成功验收运行包含 8 次真实
  模型调用。
- BigToken 连接的首次验收在 TLS 建立前被 `ECONNRESET` 中断，未进入模型工具路径；切换
  到仓库已有的 DeepSeek 连接后完成验证。2026-09-03 已针对该故障补充统一模型请求重试。

## 2026-09-03 模型请求重试验证证据

- `ModelAgentRuntime` 对普通问答、工具轮次和上下文摘要统一处理瞬时 Node/Undici 网络错误
  与请求超时；首次失败后最多重试 3 次，退避为 500 ms、1 s、2 s。
- 聚焦测试覆盖嵌套 `fetch failed` → `ECONNRESET` 恢复、工具轮次恢复、四次尝试后终止、
  退避取消，以及已显示部分流式输出时不重放。
- `npm test -- --run src/main/agent/model-runtime.test.ts`：
  `72 passed, 1 skipped`。
- 全量 `npm test`：`3484 passed, 51 skipped`。
- `npm run typecheck`、`npm run lint` 和 `npm run build`：通过。
- 最小真实直连文本模型验证：`1 passed, 13 skipped`，实际模型调用 1 次。

- 全量 `npm test`：`3410 passed, 50 skipped`。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm run build`：Main、Preload、Renderer 和控制面安装器均成功构建。2026-09-02 按产品
  决策移除未对应实际性能问题的 Renderer bundle 基线门禁后复验通过。

## 进度维护要求

- 只有真实生产路径完成并验证后才能勾选实施项。
- 平台模拟单元测试不能替代对应平台真实命令测试。
- 真实模型验证必须记录准确调用次数且不得记录凭据。
- 需求变化回写 PRD、User Stories 和功能逻辑；实现事实只写本文件。
