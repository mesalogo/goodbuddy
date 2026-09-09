# 直连模型 Agent 能力功能进度

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档类型 | 功能进度 |
| 状态 | 已实施，本机验收完成 |
| 版本 | 0.5 |
| 日期 | 2026-09-09 |
| 关联入口 | [直连模型 Agent 能力](./README.md) |

## 当前结论

本机生产路径已经完成源码接线：直连模型 Execute 可运行平台 Shell，Ask/Execute 均可按
父模式委派单层编程 Subagent；长输出可通过 `output_read` 续读。OpenCode、Continue、
DeepSeek Harness 和托管 SSH 路径不注入这些工具。既有功能的 Windows 本机、真实模型和
全量项目验证已通过；本次分页验证记录见下方 2026-09-10 条目。macOS 与 Linux 真机验证
仍需由对应平台完成。

## 已确认的当前基线

- [x] 直连模型当前内置工作区读、目录列表和文本写入，但没有进程工具。
- [x] 内置 MCP 当前没有 Shell；自定义 MCP 不能替代开箱即用的进程能力。
- [x] `ModelAgentRuntime` 已有多轮工具循环、取消、上下文压缩和有界结果。
- [x] DeepSeek Harness 已按 Windows PowerShell、macOS/Linux Bash 注册原生 Shell。
- [x] OpenCode 和 Continue 使用各自原生执行工具。
- [x] 专家协作与直连模型可调用的编程工具是不同入口；当前专家继承父请求 Ask/Execute，
  使用已启用本机直连模型工具并记录工具活动。模式与 authorizer 传递已由
  `subagent-service.test.ts` 覆盖，不把该单元测试作为额外的真实模型或远程执行验收。
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
- [x] 通用工具活动和“设置 > MCP > 直连模型”开发工具目录。
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

## 2026-09-09 高效工作区工具

- [x] 新增 `workspace_rg`，以随包 ripgrep 同时提供内容搜索和文件发现；内部解析 JSON，向
  模型返回紧凑的路径、行号、列号和预览。
- [x] `workspace_read_text` 改为按行分页读取，大文件不再因旧的整文件 256 KiB 上限完全
  不可读。
- [x] 移除搜索表达式、glob 数量、请求结果数、读取行数、补丁大小和目标文件大小的固定上限；
  单次输出继续分页或截断，超长单行可通过 `offsetBytes` 续读。
- [x] 新增 `workspace_apply_patch`，支持一个补丁新增、修改和删除多个 UTF-8 文件，并在
  修改前完成路径和 hunk 验证。
- [x] Ask 工具清单开放工作区搜索和读取，补丁与进程仍只在 Execute 提供。
- [x] 设置中的“文件系统操作”更新为“工作区文件”，“编程能力”更新为“开发工具”。
- [x] 固定 `@vscode/ripgrep` 1.18.0；构建钩子按目标平台/架构从锁定平台包提取二进制，
  安装包携带当前目标的 `rg` 和 MIT 许可证。
- [x] 本次聚焦测试 `212 passed, 1 skipped`；全量 `npm run lint` 和
  `npm run build:bundle` 通过。构建钩子在 Windows x64 实际准备并运行随包
  ripgrep 15.0.0。
- [x] 中文文档审校覆盖本目录 7 个 Markdown 文件，阻断项为 0。
- [ ] 全量 `npm test` 和 `npm run typecheck` 仍受同一工作树中并行开发的浏览器标签页接口及
  测试夹具修改阻塞；当前类型错误位于 `ipc.test.ts` 和 `browser-tabs-electron-e2e.ts`，最终
  全量验证需在这些改动稳定后复跑。

## 2026-09-06 命令工作目录限制修复

- FR-3 / US-A3：移除命令工作目录的工作区范围限制。绝对路径、`..` 和指向工作区外
  的符号链接均按本机文件系统解析，工作区只作为默认目录和相对路径基准。
- 保留目录存在性、本机执行空间绑定、Ask 拒绝命令、取消、超时和进程树回收。
  本次没有改变工作区文件读写工具或远端 Agent 路径。
- `direct-model-process-service.test.ts` 覆盖绝对路径、相对路径、外部目录、符号链接、
  不存在的目录和普通文件；当前 Windows 环境通过。
- `model-runtime.test.ts` 新增两个生产工具链回归：模型协议响应提供绝对或相对外部
  `cwd`，经 `ModelAgentRuntime → ModelToolProvider → LocalDirectModelProcessService`
  启动真实 PowerShell，在专用工作区外测试目录复制文件并读回验证。模型响应为本机
  测试替身，没有外部模型调用；不将此记录为真实模型或 macOS/Linux 真机验收。
- 最终聚焦验证：`opencode-runtime`、`opencode-runtime-lifecycle`、
  `direct-model-process-service`、`model-tool-provider`、`model-runtime` 五个测试文件
  `182 passed, 1 skipped`；`npm run typecheck` 和 `npm run lint` 通过。
- 本次共享工作区的全量 `npm test` 为 `3542 passed, 57 skipped, 1 failed`。唯一失败是
  `App.test.tsx` 的 `opens the global assistant sidebar and switches work tabs`，
  仍期望“项目工作区”标题，单独复测同样失败；该侧栏处于其他会话的修改范围，本次未改动。
  因此本次全量验证不能记录为全部通过。

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

## 2026-09-05 移除直连模型响应字节上限

- 直连模型不再对流式响应总量、单个流式块、非流式回复、模型工具参数、工具请求上下文、
  聚合工具结果和累计回答长度设置字节上限；长回复和大工具结果由请求超时、取消和上下文
  压缩控制。用户不再看到“模型接口流式响应超过安全限制”。
- 图像生成响应仍按可解码图片大小校验，Provider 错误响应仍读取有界文本。
- 回归测试改为验证超过旧上限的长流式回复可以完整返回，以及超过 1 MB 的图片工具结果会
  进入下一轮模型请求。
- `npx vitest run src/main/agent/model-runtime.test.ts`：`74 passed, 1 skipped`。
- 全量 `npm test`：`3493 passed, 55 skipped`。
- `npm run typecheck`、`npm run lint` 和 `npm run build`：通过。

## 2026-09-10 进程与 Subagent 完整输出续读

- FR-7 / US-A6：`PagedOutputStore` 完整写入临时输出文件，进程和 Subagent 返回前缀预览
  与续读引用。JSON 转义计入预览预算，避免 Provider 二次裁剪后丢失续读位置。
- `ModelToolProvider` 已注册并分发 `output_read`，Ask/Execute 均可读取所属会话输出。
  工具数量预留一个槽位，页结果不再裁剪。详细字段以 [技术设计](./technical-design.md#44-输出续读)
  为准。
- Provider、进程、Subagent、分页存储及共享工具目录五个测试文件共 `73 passed`。
  覆盖真实 PowerShell stdout/stderr、Subagent 父会话归属、JSON 转义、Unicode 小页面前进、
  句柄失效、活动调用取消和资源清理。`npm run typecheck`、`npm run lint` 通过。
- `runtime-e2e.manual.test.ts` 新增真实模型边界场景：运行一次输出超过 96 KiB 的 Node
  脚本，随机中间与结尾标记均不在预览中；模型经 `output_read` 读到 EOF 后准确返回两个标记。
  最终带报告的运行 `1 passed, 19 skipped`，上游模型请求精确为 4 次，进程调用 1 次，续读
  调用 2 次。先前同场景也通过，但其控制台计数未保留，不据此推算两次运行的精确累计调用数。
- 真实调用使用现有 `RuntimeSettingsStore` 与 Electron `safeStorage` 解密已配置文本连接，
  凭据仅经测试子进程环境传递。`GOODBUDDY_E2E_OUTPUT_REPORT` 可记录不含凭据、Prompt
  或输出正文的调用计数；测试工作区和输出存储在结束后释放。
- 本目录中文文档已按 `deai-writing` 审校，扫描阻断项为 0；保留技术枚举、权限限制和历史
  验证记录中的明确边界。本次未运行全量测试或生产构建，也不作为其他平台真机验收。

## 进度维护要求

- 只有真实生产路径完成并验证后才能勾选实施项。
- 平台模拟单元测试不能替代对应平台真实命令测试。
- 真实模型验证必须记录准确调用次数且不得记录凭据。
- 需求变化回写 PRD、User Stories 和功能逻辑；实现事实只写本文件。
