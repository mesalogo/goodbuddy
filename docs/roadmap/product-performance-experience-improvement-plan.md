# GoodBuddy 产品、性能与体验综合改进计划

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档类型 | 跨功能实施路线图 |
| 状态 | 规划中 |
| 版本 | 1.0 |
| 日期 | 2026-08-31 |
| 适用范围 | GoodBuddy Desktop、GoodBuddy Agent、发布与质量流程 |
| 评审基线 | Desktop `0.11.13`、Agent lock `0.11.14` |

## 1. 目的

本文把 2026-08-31 对当前仓库进行的功能、性能、体验和交付评审结果整理为一份可分批实施、
持续更新的权威清单。后续每一批工作都从本文选择明确范围，完成后更新状态、验证结果和相关
产品文档，不再维护平行的临时待办。

本计划优先完成已经存在但尚未形成真实用户闭环的能力，其次处理经过测量确认的性能问题，
再安排依赖外部平台或产品选择的增强能力。实施继续遵循以下原则：

1. 先保证完整、可用的生产路径，再扩展能力范围。
2. 性能优化必须有基线、目标和优化后的对比数据。
3. 复用现有合同、IPC、Worker、通知、错误边界和界面组件，不引入不必要的框架。
4. Ask 保持只读；Execute 继续代表当前本机或 SSH 账号的完整授权。
5. 每批只处理列明的范围，不借机进行无关重构。

## 2. 明确排除的工作

本计划**不包含初始 Renderer Bundle 优化**，包括但不限于：

- 不为了缩小入口包继续拆分轻量同级页面。
- 不单独延迟 KaTeX、全局样式或其他入口依赖。
- 不调整现有 Bundle 预算来制造通过或失败。
- 不以 Bundle 大小为理由改变当前页面交互语义。

现有构建预算和按路由拆包继续作为回归保护保留。只有后续获得首屏解析或执行耗时证据，并由
用户单独确认范围后，才重新讨论该项。

## 3. 状态与优先级

### 3.1 状态

| 状态 | 含义 |
| --- | --- |
| 待开始 | 范围已确认，尚未实施 |
| 进行中 | 已进入当前实施批次 |
| 阻塞 | 存在明确外部依赖，已记录解除条件 |
| 已完成 | 代码、真实路径、测试和文档均完成 |
| 不做 | 经重新评审后明确移出范围，并记录原因 |

### 3.2 优先级

| 优先级 | 含义 |
| --- | --- |
| P0 | 影响正式交付、安装或已声明生产路径，发布前处理 |
| P1 | 阻断核心工作流或造成明显错误、卡顿、误导 |
| P2 | 重要增强或规模化问题，可在核心闭环后实施 |

## 4. 分批实施总览

批次表示建议顺序，不表示必须一次完成整批。每次可以从当前批次选择一组边界清晰、能够独立
验收的事项。

| 批次 | 主题 | 事项 | 开始条件 | 完成门槛 |
| --- | --- | --- | --- | --- |
| 0 | 正式交付闭环 | `REL-01` 至 `REL-03`、`QA-03` | 发布资源和目标平台明确 | 正式产物可安装、可启动，版本与验证声明准确 |
| 1 | 核心工作流与恢复体验 | `FUN-01`、`FUN-04`、`UX-01` 至 `UX-12`、`OPS-01` 至 `OPS-03` | 无 | 用户可理解状态、从常见失败中直接恢复，并能导出有界诊断 |
| 2 | 通道、更新和真实 Runtime | `FUN-02`、`FUN-03`、`FUN-05`、`QA-01`、`QA-02` | 对应平台测试配置可用 | 文件办公闭环、更新下载闭环和真实 Runtime E2E 均通过 |
| 3A | 性能基线 | `PERF-01`、`PERF-03`、`PERF-05`、`PERF-07`、`PERF-09` | 固定测试数据和设备 | 形成可重复基线、目标阈值和原始结果 |
| 3B | 已测量性能优化 | `PERF-02`、`PERF-04`、`PERF-06`、`PERF-08`、`PERF-10` | 对应 3A 指标确认存在瓶颈 | 指标改善且功能、取消、恢复语义不回退 |
| 3C | 架构级界面性能改造 | `PERF-11` 至 `PERF-17` | `PERF-11` 完整 App 基线已产生 | 第 7.1 节五条架构规则成立，并由基准和 lint 持续守护 |
| 4 | 增强能力 | `FUN-06` 至 `FUN-09` | 核心闭环稳定；首个电脑控制平台已选定 | 每项形成独立、完整、可真实使用的工作流 |

## 5. 发布与交付

### REL-01 Desktop 与 Agent 版本闭环

- **优先级 / 状态：** P0 / 待开始
- **目标：** 当前 Desktop 源码依赖的 Agent 能从正式渠道取得并完成真实 Host 验证。
- **范围：**
  - 发布并验证 Agent `0.11.14`，或在 Desktop 发布前恢复到已发布 Agent 契约。
  - 验证 Linux x64、Linux arm64 正式候选包。
  - 覆盖安装、Attach、Execute、取消和断线恢复。
  - 覆盖 GitHub、镜像和离线 GoodBuddy 传输路径。
- **验收：**
  - 干净用户目录能获取预期版本。
  - Desktop 到 Agent 的正常路径和恢复路径均使用当前候选产物通过。
  - 发布说明准确标注已验证架构和仍未验证范围。
- **外部依赖：** Agent 发布审批、双架构正式产物、真实 Linux arm64 环境。
- **起始证据：** `package.json`、`agent-runtime-lock.json`、
  `docs/features/remote-host/technical-design.md`。

### REL-02 正式 Latest 签名门槛

- **优先级 / 状态：** P0 / 待开始
- **目标：** 官网正式推荐下载不指向可能被系统默认安全策略阻止的测试产物。
- **范围：**
  - macOS 缺少签名或公证凭据时，不更新正式 Latest。
  - Windows 未签名构建不作为默认推荐安装包。
  - 未签名构建继续作为明确标注的测试 artifact。
- **验收：**
  - 发布工作流在签名条件不满足时不会切换正式 Latest。
  - 正式下载在全新 macOS、Windows 默认安全策略下完成首次启动。
- **外部依赖：** Apple 和 Windows 代码签名凭据。
- **起始证据：** `.github/workflows/packages.yml`、`BUILD.md`、`README.md`。

### REL-03 发布包启动冒烟

- **优先级 / 状态：** P0 / 待开始
- **目标：** 发布成功代表打包应用能够启动，而不只是文件结构完整。
- **范围：**
  - 在对应 CI Runner 启动解包应用。
  - 等待 Main、Preload、Renderer ready 健康标识后退出。
  - Windows x64 接入现有 packaged DeepSeek Harness smoke。
  - 为启动设置总超时，并保留无用户内容的失败诊断。
- **验收：**
  - 缺 DLL、ASAR unpack、Preload 或 Main 启动错误会使发布任务失败。
  - 探针无凭据、无外网也能执行。
- **起始证据：** `.github/workflows/packages.yml`、`build/build-release.cjs`、
  `build/run-packaged-deepseek-harness-smoke.cjs`。

## 6. 核心与增强功能

### FUN-01 定时任务编辑

- **优先级 / 状态：** P1 / 待开始
- **目标：** 用户无需删除并重建计划任务即可纠正配置。
- **范围：**
  - 新增共享 Update schema、Preload 方法和可信 IPC handler。
  - 复用定制任务创建对话框作为编辑模式。
  - 支持修改名称、Prompt、Ask/Execute、Runtime、首次运行时间和周期。
  - 保留原 Task、Conversation、Schedule 和历史运行关联。
- **验收：**
  - 从任务界面进入编辑，保存后列表和下一次运行时间立即更新。
  - 编辑不产生重复 Task 或 Schedule。
  - 正在运行的实例继续使用启动时快照，后续触发使用新配置。
- **起始证据：** `CustomTaskDialog.tsx`、`TaskScheduleActions.tsx`、`src/main/ipc.ts`。

### FUN-02 企业微信附件收发

- **优先级 / 状态：** P1 / 待开始
- **目标：** 企业微信完成“接收文件或图片、处理、回传成果”的办公闭环。
- **范围：**
  - 接收官方接口支持的图片和普通文件。
  - 将附件接入现有远程消息上下文。
  - 支持回传当前任务生成的图片或文件。
  - 复用 `ChannelMediaAttachment`、现有大小限制和 outbox 清理。
- **验收：**
  - 收到支持的附件不会再返回 `attachment_not_supported`。
  - 任务生成的有界成果能发送到原会话。
  - 超限、下载失败和发送失败提供明确错误且临时文件得到清理。
- **起始证据：** `src/main/channels/wecom-driver.ts`、
  `src/main/channels/wechat-sidecar.ts`。

### FUN-03 钉钉附件收发

- **优先级 / 状态：** P1 / 待开始
- **目标：** 钉钉非文本消息不再静默丢失，并完成文件办公闭环。
- **范围：**
  - 支持官方接口允许的图片和普通文件接收。
  - 支持任务成果附件回传。
  - 对暂不支持的消息类型返回明确说明。
- **验收：**
  - 支持的非文本消息进入对应远程 Conversation。
  - 不支持的消息有可见反馈，不被静默忽略。
  - 收发限制和清理行为与其他通道一致。
- **起始证据：** `src/main/channels/dingtalk-driver.ts`、
  `src/main/channels/dingtalk-channel-driver.ts`。

### FUN-04 浏览器错误分类

- **优先级 / 状态：** P1 / 待开始
- **目标：** 浏览器任务失败后，用户知道失败阶段和下一步操作。
- **范围：**
  - 保留代理、DNS、会话创建、CDP、导航和截图等失败阶段。
  - 增加少量稳定错误码及一句修复建议。
  - 在任务记录和界面中呈现，不建立通用错误协议框架。
- **验收：**
  - 典型失败不再全部显示为“工具执行失败”。
  - 原始敏感内容不进入 Renderer 或诊断日志。
  - 取消继续被识别为取消，而不是错误。
- **起始证据：** `src/main/agent/model-runtime.ts`、
  `docs/status/computer-control-implementation-status.md`。

### FUN-05 更新下载闭环

- **优先级 / 状态：** P1 / 待开始
- **目标：** 用户能在应用中取得当前平台安装文件并确认文件完整。
- **范围：**
  - 从当前更新源读取当前平台产物。
  - 下载到用户选择目录。
  - 使用现有发布清单校验大小和 SHA-256。
  - 校验成功后允许打开文件或所在目录。
  - 安装继续由用户手动触发。
- **验收：**
  - 下载源、版本、架构和当前系统匹配。
  - 损坏或哈希不匹配的文件不会被呈现为可安装。
  - 失败保留目标和错误上下文，可重新下载。
- **起始证据：** `UpdateSettingsSection.tsx`、`src/main/version-checker.ts`、
  `src/main/ipc.ts`。

### FUN-06 定时任务常用周期

- **优先级 / 状态：** P2 / 待开始
- **目标：** 覆盖常见办公日历，而不要求用户编写 Cron。
- **范围：** 增加工作日和每月周期，并持续显示下一次实际执行时间。
- **验收：** 创建、编辑、重启恢复和到期触发均按本地日历执行且不重复。
- **依赖：** `FUN-01`、`FUN-07`。
- **起始证据：** `src/shared/assistant-contracts.ts`、
  `docs/features/task-and-job/scheduled-task-prd.md`。

### FUN-07 时区和错过执行策略

- **优先级 / 状态：** P2 / 待开始
- **目标：** 用户明确控制任务在哪个时区运行，以及错过后是否补跑。
- **范围：**
  - 默认本机 IANA 时区。
  - 支持 `skip` 和 `run_once`。
  - 显示 DST 影响后的下一次实际运行时间。
- **验收：**
  - 重启或系统恢复后不会形成补跑风暴。
  - 时区和策略可创建、编辑、持久化并在界面复现。
- **起始证据：** `src/main/assistant/assistant-database.ts`、
  `docs/features/task-and-job/scheduled-task-prd.md`。

### FUN-08 旧版 Office 文件

- **优先级 / 状态：** P2 / 待开始
- **目标：** DOC、XLS、PPT 能进入聊天附件和知识库解析路径。
- **范围：**
  - 检测本机 LibreOffice。
  - 使用 headless 转换到 OOXML 或 PDF 后复用现有解析器。
  - 未安装时提供明确安装或手工转换建议。
- **验收：**
  - 三种旧格式各用真实文件完成聊天解析和知识库导入。
  - 转换取消、超时和失败后清理 GoodBuddy 临时目录。
  - 不内置第二套文档解析引擎。
- **起始证据：** `src/main/knowledge/document-parser.ts`、
  `DocumentParsingSettingsSection.tsx`。

### FUN-09 首个原生电脑控制适配器

- **优先级 / 状态：** P2 / 待开始
- **目标：** 在一个明确的主要部署平台上真实控制桌面应用。
- **范围：**
  - 首先从 Windows UIA、macOS AX 或 Linux 原生方案中选择一个平台。
  - 完成窗口快照、点击、输入、取消和退出清理。
  - 接入现有 computer-control broker。
- **验收：**
  - 在真实桌面应用完成一次可重复的查看、点击和输入任务。
  - Ask 仍不可执行桌面变更，Execute 路径记录活动。
  - 取消和关闭后不遗留 GoodBuddy 控制会话。
- **外部依赖：** 首个平台产品决策及对应真实设备。
- **起始证据：** `src/main/capabilities/capability-service.ts`、
  `docs/status/computer-control-implementation-status.md`。

## 7. 性能

### PERF-01 启动性能测量

- **优先级 / 状态：** P1 / 待开始
- **目标：** 得到冷启动各阶段的可重复耗时，而不是依据代码顺序猜测。
- **指标：** `app.whenReady`、窗口创建、数据库、知识库、Provider/Gateway、Runtime hydration、
  IPC 注册、`loadMainWindow`、`ready-to-show` 和 Renderer 首帧。
- **验收：** 固定设备至少运行五次冷启动，报告中位数和 p95；诊断不包含用户内容。

### PERF-02 启动路径优化

- **优先级 / 状态：** P1 / 待开始
- **目标：** 尽早显示可理解的应用壳，并延后经测量确认的非首屏工作。
- **实施条件：** `PERF-01` 证明具体阶段构成主要延迟。
- **验收：** 首帧和可交互时间达到批次开始时确定的目标，初始化失败仍有明确状态和恢复入口。

### PERF-03 长流式回答基准

- **优先级 / 状态：** P1 / 待开始
- **场景：** 100KB、500KB、1MB Markdown 回答，包含推理、代码块和常见富文本。
- **指标：** React commit 数和 p95、Long Tasks、Markdown 渲染时间、输入延迟、滚动帧率、
  Renderer 堆内存。
- **验收：** 测试数据、运行步骤和原始结果可重复执行。

#### 2026-09-28 Measurement Evidence (Partial)

`npx vitest run tests/streaming-markdown.electron.test.ts` runs the real
MarkdownRenderer in Electron 43.2.0 / Chromium 150.0.7871.129. It compares the
original normalizer with fast paths that skip unchanged text, retaining live
Markdown, math, code and HTML behavior. It also measures a 102,400-byte answer
at six growing prefixes, alternating original/current execution order in the
same page, with one warm-up sweep and three measured sweeps (18 samples each).

| Measurement | Original | Current |
| --- | --- | --- |
| 100KiB growing-prefix render median, isolated run | 54.80 ms | 54.65 ms |
| Same run p95 | 95.50 ms | 106.10 ms |
| Growing-prefix render median, full-suite run | 53.50 ms | 53.10 ms |
| Same run p95 | 93.70 ms | 83.40 ms |

These development-mode measurements include synchronous React rendering, DOM
commit and style/layout, but exclude frame waiting and paint. With 18 samples,
nearest-rank p95 is the maximum sample. The results do not establish an overall
rendering improvement. Smaller 6.4-7.2K-character corpora do show lower normalizer
cost: prose median 33-34 microseconds to below 1 microsecond, and mixed math/code
median 32-35 to 16-20 microseconds. The production changes remain limited to this
preprocessing and memoizing unchanged subagent-derived collections. In the
four-subagent regression, initial render plus six updates builds the lookup map
once instead of seven times; block-dependent scans still run when blocks change.

Validation: 550 prefix normalization comparisons, 1,100 short-prefix DOM
comparisons and 24 long-prefix DOM comparisons passed. The real Electron
terminal-status probe covers cancellation, failure, retry and persistence via
three loopback model-stub requests; the Mermaid viewer covers nine scenarios
and ten PNG downloads. No external model calls were used for these probes.
Full `npm test` passed 459 files / 5,397 tests, with 11 files / 84 tests skipped.
Type checking and scoped lint passed. Full lint remains blocked by the existing
untracked sidebar-final probe files.

This is partial evidence for PERF-03, not completion: full-App input latency,
frame rate, heap measurements and 500KB/1MB scenarios remain unmeasured.

### PERF-04 流式更新合并

- **优先级 / 状态：** P1 / 待开始
- **目标：** 降低长回答期间的状态复制和完整 Markdown 重解析。
- **实施条件：** `PERF-03` 确认 commit 或 Markdown 渲染是瓶颈。
- **范围：**
  - 同一请求的 text/reasoning delta 按 `requestAnimationFrame` 合并。
  - 每帧最多提交一次相关 React 状态。
  - 流结束后再执行完整富文本渲染。
- **验收：** 目标指标改善；事件顺序、停止、重试、引用、工具和 Subagent 块不回退。

### PERF-05 向量检索规模基准

- **优先级 / 状态：** P1 / 耗时基线已完成，取消响应与峰值内存待测
- **场景：** 1k、10k、50k chunks 的全文、向量和混合检索。
- **指标：** 总耗时、`vectorScannedCount`、Main event-loop lag、取消响应和峰值内存。
- **验收：** 固定语料和查询集产生可比较结果，并保留检索质量指标。

#### 2026-10-02 耗时基线

`npm run perf:knowledge`（`build/run-knowledge-perf.cjs`）用 esbuild 打包生产
`KnowledgeDatabase`，在临时 SQLite 中写入确定性随机语料（每文档 100 chunks，每 chunk 80 词，
384 维向量，与内置嵌入模型一致），重开连接后对每个规模各测 15 次 `search`、`vectorSearch`
和 `hybridSearchWithDiagnostics`（图谱关闭）。这些调用是同步的，在 App 中由 Main 线程直接
执行，所以单次耗时就是 Main 被阻塞的时长。同一台设备（Node 24.18），p95：

| chunks | 全文 | 向量 | 混合 |
| --- | --- | --- | --- |
| 5,000 | 14 ms | 54 ms | 93 ms |
| 20,000 | 59 ms | 173 ms | 219 ms |
| 50,000 | 130 ms | 396 ms | 520 ms |

向量扫描与 chunk 数线性相关，FTS 也随规模增长。按 50 ms 预算，约 5k chunks 起混合检索就会
使 Main 可感知地卡顿；5 万 chunks 时每次检索约冻结 Main 0.5 s，期间全部 IPC（包括流式输出、
终端和界面操作）排队。结论：`PERF-06` 的实施条件已满足；检索应先移出 Main（`PERF-06`，
随后并入 `PERF-16`）。取消响应和峰值内存尚未测量。

### PERF-06 向量计算移出 Main

- **优先级 / 状态：** P1 / 待开始
- **目标：** 大知识库向量扫描不阻塞 Electron Main。
- **实施条件：** `PERF-05` 确认 Main event-loop lag 或取消响应不达标。
- **范围：** 优先复用已有 Worker，减少重复扫描和复制；本项不自动引入 ANN。
- **验收：** 检索排序和质量不回退，Main 延迟与取消指标达到目标。

### PERF-07 知识库 Snapshot 测量

- **优先级 / 状态：** P2 / 待开始
- **指标：** SQL 时间、对象数量、structured-clone 估算字节、IPC 往返、Renderer commit 和
  峰值堆内存。
- **场景：** 小型、典型和大型文档与图谱数据集。
- **验收：** 明确首屏实际需要的字段和超过目标阈值的数据规模。

### PERF-08 知识库按需加载

- **优先级 / 状态：** P2 / 待开始
- **实施条件：** `PERF-07` 证明完整 Snapshot 是可见瓶颈。
- **范围：**
  - 首屏只返回列表字段、状态和计数。
  - 文档详情按选择加载。
  - 图实体、关系和证据仅在图谱视图加载。
  - 复用已有列表和 chunk 接口。
- **验收：** 首开与切换指标改善，选择、刷新、取消和局部错误状态不回退。

### PERF-09 Keep-alive 压力测试

- **优先级 / 状态：** P2 / 文本会话部分已完成，图片与工具记录待补
- **场景：** 连续打开 12 个会话，每个会话包含 80 条富 Markdown、图片和工具记录。
- **指标：** DOM 节点、Renderer heap、GC pause 和流式 commit。
- **验收：** 明确隐藏会话缓存是否构成实际内存或渲染问题。

#### 2026-10-02 文本会话测量

`npm run perf:app` 在流式场景之后连续打开 24 个未访问过的种子会话（每个 20 条富 Markdown），
每 4 次记录挂载的面板数、DOM 节点数和强制 GC 后的 JS heap（CDP
`HeapProfiler.collectGarbage` + `Runtime.getHeapUsage`）。

| 已访问 | 挂载面板 | DOM 节点 | GC 后 heap |
| --- | --- | --- | --- |
| 0（两次流式之后） | 12 | 39,657 | 54.6 MB |
| 4 / 8 | 12 | 39,656 | 54.6–55.1 MB |
| 12 | 12 | 15,884 | 27.4 MB |
| 16 / 20 / 24 | 12 | 15,884 | 27.3–27.9 MB |

缓存上限 12 个面板有效：两条长流式回答被挤出缓存后，DOM 和 heap 回落并保持不变，后半段
增长为 0。此前观察到的“4 万节点、210 MB”是两条 40 KB 流式回答仍在缓存中时的瞬时值
（未 GC），不是持续泄漏。结论：文本会话场景下 keep-alive 不构成内存问题，`PERF-10` 不需要
调整缓存数量或有效期；含图片和工具记录的会话尚未测。

### PERF-10 Keep-alive 轻量优化

- **优先级 / 状态：** P2 / 已完成输入与热切换渲染隔离，压力测试待完成
- **实施依据：** 2026-09-30 的真实 App 组件回归确认输入和热切换会重复渲染缓存内容；
  `PERF-09` 的 Electron 内存与 GC 压力测试仍待执行。
- **范围：**
  - `ChatHistoryPane`、任务条和 Runtime 清单使用 memo，稳定快捷输入、重试、图片恢复、
    定时任务回调及任务条 JSX。异步草稿操作仍绑定发起时的会话。
  - 仍不达标时才调整缓存数量或一小时有效期。
  - 暂不引入完整虚拟化框架。
- **验收：** 内存和 commit 指标改善，同时保留会话切换位置和快速恢复体验。

`App.test.tsx` 修复前回归记录：运行请求期间连续输入三次，历史面板、任务条、清单各
渲染三次，会话迁移存储读取三次；两个已缓存会话往返一次，Markdown 渲染 324 次。
长会话已展开 160 条消息，另一会话含一条消息，计数包含展开的推理正文。修复后上述
计数均为零。最终用例还覆盖可见且展开的运行中任务条、实时文本与清单更新、停止、
会话草稿、图片素材选择期间切换会话，以及滚动位置和推理展开状态保留。
这些是 jsdom 中真实 App 的渲染次数，使用 mock preload；尚未测量 Electron 输入延迟、
绘制耗时或内存。流式事件未延后，缓存容量和有效期未改变。

### 7.1 架构级界面性能改造（批次 3C）

2026-10-02 的架构评审确认，界面卡顿的主要来源是架构组织方式，而不是 Electron 或 GPU：

- **Renderer 单组件状态：** `App.tsx` 约 11k 行，`App()` 内有 123 个 `useState`、69 个
  `useEffect`。会话、消息、草稿、任务和设置都在其中，输入和每次流式 flush 都会重新执行
  整个 App 函数体；多个大面板未 memo，隐藏的 keep-alive 视图也会参与渲染。
- **Main 同步存储：** 全部 SQLite 访问使用 Main 线程的 `DatabaseSync`，包括全表向量扫描、
  会话列表与搜索、Story Graph 读取；PDF/Office 解析和附件同步文件 IO 也在 Main。
- **全量回写：** 活动记录在任何变化后 250 ms 全量 `replace`；会话每 500 ms 定时保存；
  `*Changed` 通知不带内容，Renderer 再重新查询完整列表。

改造完成后须同时满足以下规则，并由工具守护，避免回退：

1. Main 只负责窗口、生命周期、权限和消息路由，不执行数据库查询、文档解析或批量计算。
2. Renderer 状态按领域拆成外部 store，组件通过 selector 订阅；`App.tsx` 只保留布局壳。
3. 流式文本和终端输出走专用通道，只更新正在显示的行或面板，按帧合并提交。
4. 数据只有一个权威来源，跨进程只传增量；不再全量回写，也不再“通知后重新查全量”。
5. 消息、会话、笔记、文件树等长列表虚拟化，DOM 数量不随数据量增长。

实施方式：先建立 `PERF-11` 基线，再沿 Renderer（`PERF-12`→`PERF-13`→`PERF-14`）和
数据进程（`PERF-15`→`PERF-16`）两条线并行推进，最后由 `PERF-17` 固化守护。每一步完成后
重新运行 `PERF-11` 场景并记录对比；不换技术栈，不一次性重写 `App.tsx`。

### PERF-11 完整 App 交互基准

- **优先级 / 状态：** P1 / 进行中
- **目标：** 在当前生产构建、隔离 profile 和本地假模型下，可重复测量用户能感知的卡顿。
- **运行：** `npm run build:bundle` 后执行 `npm run perf:app`；结果写入
  `GB_PERF_OUTPUT` 或系统临时目录，不含用户内容，不发出外部模型请求。
- **场景：** 空闲基线；Composer 连续输入；切换会话；打开长会话；大量会话列表下的流式
  回答；流式回答期间同时输入。
- **指标：** Renderer Long Tasks（>50 ms）数量与总时长、按键到下一帧延迟、帧间隔 p95 与
  掉帧比例、React commit 无法直接取得时以 DOM mutation 批次近似、Main event-loop 延迟
  （`monitorEventLoopDelay`）、Main 与 Renderer 进程 CPU 和内存、Renderer JS heap。
- **验收：** 同一设备多次运行结果可比较；报告记录源码版本、环境、数据规模和原始样本摘要。

#### 实现

- `build/run-app-perf.cjs`：独立 supervisor。在 `127.0.0.1:11434`（新 profile 默认模型地址）
  启动 OpenAI 兼容假模型，清除 `ELECTRON_RUN_AS_NODE` 和模型环境变量，设置整轮期限（默认
  600 s），汇总报告并删除隔离 profile。端口被占用时直接失败。
- `tests/support/app-perf-driver.mjs`：在导入 `out/main/index.js` 前设置 `appPath`、
  `userData`、`sessionData` 和日志目录，然后由生产 Main 创建窗口、注册 IPC 并加载真实
  Preload/Renderer。全部交互使用 `sendInputEvent` 原生输入；数据通过生产
  `conversations.saveLocal` IPC 写入，再 reload 走正常启动加载。
- Renderer 探针只观察：`longtask`、`long-animation-frame`、Event Timing、rAF 帧间隔、
  keydown 到下一帧、MutationObserver 计数、DOM 节点数和精确 JS heap。Main 用
  `monitorEventLoopDelay`，进程用 `app.getAppMetrics()`。
- 默认规模：300 个会话 × 20 条消息，另加一个 2,000 条消息的长会话；输入 120 个字符，
  按键间隔 60 ms；流式回答约 40 KB 混合 Markdown（标题、列表、代码、表格、行内/块级公式、
  引用），每个 SSE 事件 12 个字符，2,000 字符/秒。可用 `GB_PERF_*` 环境变量调整，
  见脚本开头。
- `GB_PERF_PROFILE=1` 为有历史输入和流式场景采集 Renderer CPU profile 并汇总自身耗时
  热点；剖析有开销，只用于归因，不作为基线数据。
- `GB_PERF_CPU_THROTTLE=<倍数>` 用 CDP 降低 Renderer CPU 速度模拟低端设备；
  `GB_PERF_MEMORY_VISITS`（默认 24，0 跳过）控制 `PERF-09` 内存场景。

#### 2026-10-02 基线

源码 `8280158`（工作区含其他未提交改动），Windows x64，Intel Core Ultra X7 358H ×16，
32 GB，Electron 43.2.0 / Chromium 150，DPR 1，内容区 1280×800，GPU 合成与光栅化均启用。
连续运行 3 次，假模型请求每次 2 次，外部模型请求 0 次。帧间隔基线为 8.3 ms（120 Hz）。

| 场景 | Long Tasks 次数 / 总时长 | 帧间隔 p95 | 掉帧比例 | 交互延迟 p50 / p95 | Main lag 最大 |
| --- | --- | --- | --- | --- | --- |
| 空闲（新 profile / 有历史） | 0 / 0 | 8.5 ms | 0% | — | 17–21 ms |
| 输入 120 字（新 profile） | 0 / 0 | 8.5 ms | ≤0.2% | 按键→帧 4.8–5.1 / 8.3–8.5 ms | ≤17 ms |
| 输入 120 字（有历史） | 0 / 0 | 8.5 ms | 0% | 按键→帧 6.5–6.7 / 8.4–8.7 ms | ≤18 ms |
| 首次切换会话 ×15 | 1 / 77–81 ms | 8.6 ms | 3.7–4.5% | 点击→显示 49–50 / 102–105 ms | 29–32 ms |
| 再次切换（缓存命中）×10 | 0 / 0 | 8.6 ms | 3.3–4.1% | 点击→显示 52–53 / 56–59 ms | 19–22 ms |
| 打开 2,000 条消息会话 | 1 / 94–102 ms | 8.5 ms | 1.6% | 点击→显示 134–144 ms | ≤21 ms |
| 滚动长会话 3 s | 0 / 0 | 8.5 ms | 0% | — | ≤17 ms |
| **流式 40 KB 回答** | **126–137 / 8.6–9.3 s** | **83 ms** | **45–48%** | — | 30–36 ms |
| **流式期间输入 100 字** | **128–182 / 8.8–11.9 s** | **83 ms** | **50–52%** | 按键→帧 12.5–13.5 / 35–36 ms | 29–144 ms |

其他观察：

- 启动：窗口创建约 0.58 s，`ready-to-show` 约 1.29 s，Composer 可用约 1.42 s；带 300 个
  会话 reload 到侧栏出现约 0.19 s。
- 流式回答约 20 s，Long Tasks 占记录时间约 40%；按四等分统计为 `0 / 2.5 / 4.7 / 4.6 s`，
  随回答变长而增加，说明每次提交的成本与已生成长度成正比。
- 有历史时侧栏一次渲染全部 302 行，DOM 约 4,400 节点；访问过若干会话后约 1.6 万；两次
  流式后约 4 万，JS heap 最高约 210 MB（keep-alive 缓存持续增长）。
- 长会话只渲染最近 80 条，打开耗时主要是一次约 100 ms 的 Long Task。
- KaTeX 的 `data:` 字体被 CSP 拒绝（缺少 `font-src`），每轮 8 条控制台错误，字体回退
  （已在 `PERF-12` 第一步修复）。
- `app.getAppMetrics()` 的 CPU 百分比在 Windows 上按全部逻辑核归一，只作相对比较。

**归因（剖析运行）：** 流式期间 Renderer 自身 CPU 约 74% 在应用 bundle 中，热点是
`hast-util-from-dom` 的 `parseFragment`/`fromDom`（rehype-katex 把 KaTeX HTML 再解析成
hast）、micromark 分词、hast→React 转换和 React reconcile。对照实验确认根因：默认语料的
块级公式写在一行（`$$...$$`），命中 `MarkdownRenderer.tsx` 的 `unsafeSegmentLine`，
`splitMarkdownSegments` 退回整篇单段，**每次 flush 都重新解析整篇回答并重新渲染全部公式**。
仅把 `$$` 改成独占一行（`GB_PERF_CORPUS=multiline-math`）后，同一流式场景 Long Tasks
从约 130 次 / 9 s 降到 1 次 / 0.15 s，帧间隔 p95 从 83 ms 回到 8.5 ms，流式期间按键→帧
p95 从约 36 ms 降到 15.5 ms。

**结论与对后续批次的影响：**

1. 当前最严重、用户最易感知的卡顿是**流式长回答**，且由 Markdown 分段失效后的整篇重解析
   主导；输入、切换、滚动和空闲在本机均未出现明显问题。`PERF-12` 应优先处理：让分段在
   单行 `$$`、HTML 行、链接定义等情况下也能安全工作或局部回退，并对已完成段缓存渲染结果。
2. 假模型 2,000 字符/秒高于常见真实模型输出速度，但成本随长度线性增长，真实速度下回答
   足够长时同样会出现。
3. 会话首次切换 p95 约 100 ms、打开长会话约 140 ms，可在 `PERF-13`/`PERF-14` 中改善，
   优先级低于第 1 项。
4. 本机为高性能设备；低端设备上的绝对值会更差，后续应补一台低配 Windows 设备基线。

### PERF-12 流式与输入快速止血

- **优先级 / 状态：** P1 / 进行中（Markdown 分段已完成）
- **范围：** 流式 delta 在 Renderer 按 `requestAnimationFrame` 合并后提交，并以 transition
  降低优先级；缓存 Markdown 预处理结果；`RightAssistantSidebar`、`ProjectSwitcher` 和
  keep-alive 路由使用 memo 并稳定回调；滚动跟随只在需要时执行。
- **验收：** `PERF-11` 流式与输入场景的 Long Tasks 和输入延迟下降；事件顺序、停止、重试、
  工具与 Subagent 块不回退。该项吸收 `PERF-04` 的范围。

#### 2026-10-02 第一步：Markdown 分段与 KaTeX 字体

- **分段（`MarkdownRenderer.tsx`）：** `splitMarkdownSegments` 按 micromark-extension-math
  的实际规则识别块级公式：`$$` 等两个以上 `$` 开头、其后不含 `$` 的行才开启公式块，并需要
  不短于开启长度的 `$` 行关闭；`$$x^2$$` 这类单行公式按普通段落处理，不再使整篇退回单段。
  链接定义和脚注改为逐行检查，位于顶格代码围栏内的行视为字面内容。原始 HTML 行、`\r`、
  缩进围栏内的定义仍整篇退回。
- **字体（`electron.vite.config.ts`）：** Renderer 构建不再把字体内联为 `data:` URL。CSP
  没有 `font-src`，原先 4 个小于 4 KB 的 KaTeX 字体被拒绝并回退；现在 60 个 KaTeX 字体
  全部作为同源文件输出，CSP 不变。
- **等价性验证：** 现有逐前缀对照语料新增单行公式、长 `$` 围栏、代码围栏内的定义等用例；
  新增 1,200 份确定性随机文档（半数取随机前缀）对照，要求分段渲染与整篇渲染的 DOM 完全
  一致。开发期另跑了约 4.8 万份随机文档与前缀，其中约 6,300 份走分段路径，全部一致。
- **`npm run perf:app` 对比（同机，各 3 次，`80579ee` + 本改动）：**

| 场景 | 改动前 | 改动后 |
| --- | --- | --- |
| 流式 40 KB：Long Tasks | 126–137 次 / 8.6–9.3 s | 1 次 / 0.16 s |
| 流式 40 KB：帧间隔 p95 / 掉帧 | 83 ms / 45–48% | 8.6–8.9 ms / 3–5% |
| 流式期间输入：按键→帧 p50 / p95 | 12.5–13.5 / 35–36 ms | 11.7–11.9 / 19–21 ms |
| 流式期间输入：掉帧 | 50–52% | 7.7–8.5% |
| KaTeX 字体 CSP 错误 | 每轮 8 条 | 0 |

  输入、切换、长会话和滚动场景与基线持平。流式期间输入仍有约 8% 掉帧、按键 p95 约 20 ms，
  剩余开销属于 App 级重渲染，留给 `PERF-12` 后续项和 `PERF-13`。
- **剩余：** 流式 delta 按帧合并、大面板 memo、滚动跟随优化仍待实施。

#### 2026-10-02 低端设备模拟（Renderer CPU 4× 降速）

`GB_PERF_CPU_THROTTLE=4 npm run perf:app` 通过 CDP `Emulation.setCPUThrottlingRate` 把
Renderer 主线程降速 4 倍（Main 不降速，每次 reload 后重新应用），源码 `5dc6545`
（含 `PERF-12` 第一步），同一设备。不降速一栏为同一轮构建的对照。

| 场景 | 不降速 | 4× 降速 |
| --- | --- | --- |
| 输入 120 字（新 profile）按键→帧 p95 | 8.7 ms | 42 ms，掉帧 21% |
| **输入 120 字（有 300 个会话）** | 0 Long Task，p95 9 ms | **37 次 / 3.2 s，p95 355 ms，最大 483 ms** |
| **首次切换会话 ×15** 点击→显示 p50 / p95 | 52 / 117 ms | **434 / 922 ms** |
| 再次切换（缓存命中）p50 / p95 | 55 / 66 ms | 482 / 534 ms |
| 打开 2,000 条消息会话 | 140 ms | 1.2 s |
| 滚动长会话 | 帧 p95 8.5 ms | 帧 p95 17 ms，正常 |
| **流式 40 KB** | 1 次 / 0.17 s，帧 p95 17 ms | **156 次 / 16.7 s，帧 p95 183 ms，掉帧 100%** |
| **流式期间输入** 按键→帧 p50 / p95 | 11.5 / 17 ms | **575 / 1,513 ms** |

高性能机上不可见的问题，在降速后全部暴露：

- 新 profile 输入只到 42 ms，有 300 个会话后升到 355 ms，差异来自**每次按键重新渲染整个
  App 和完整侧栏**。降速剖析：`resizeComposerTextarea`（每次输入同步读 `scrollHeight` 强制
  布局）约 8%；i18next `formatLanguageCode`/`translate` 约 12%（`Intl.getCanonicalLocales`
  每次调用 `t()` 都执行，侧栏 302 行各自多次调用）；其余是 App 与侧栏行的 React 渲染。
- 流式期间约 18% 是 `ChatHistoryPane` 每次 flush 的滚动跟随 layout effect（读布局后
  `scrollTo`），i18next 约 8%，Markdown 解析与 React reconcile 其余。
- 缓存命中切换也约 0.5 s，说明慢的不是挂载新面板，而是切换触发的 App 级整体重渲染。

**结论：** 低端设备上输入、切换和流式都会明显卡顿，主因是 App 级重渲染和侧栏全量渲染，
证实 `PERF-13`（领域 store）和 `PERF-14`（侧栏虚拟化）有必要。`PERF-12` 剩余项应先做三处
低成本热点：Composer 高度改为只在需要时测量、`t()` 结果或 i18next 语言码规范化做缓存、
滚动跟随按帧合并且只在贴底时执行。

#### 2026-10-02 第二步：三处低成本热点

- **Composer 高度（`App.tsx` `resizeComposerTextarea`）：** 记住上次的值与高度。值未变不测量；
  在原文本末尾追加时不再先设 `height: auto`（只会变高），已到最大高度直接跳过测量；删除、
  替换、清空仍按原方式重置并测量。
- **i18next 语言码（`i18n/index.ts`）：** i18next 25 每次 `t()` 都经
  `toResolveHierarchy`→`formatLanguageCode` 调用 `Intl.getCanonicalLocales`。初始化后对
  `languageUtils.formatLanguageCode` 加按输入缓存（结果只取决于代码与静态初始化选项，上限
  64 项），翻译结果不变。
- **滚动跟随（`ChatHistoryPane.tsx`）：** 激活面板时仍同步滚到底；之后内容更新时改为每帧最多
  一次 `requestAnimationFrame` 中读取 `scrollHeight` 并 `scrollTo`，回调里再次确认仍贴底；
  卸载时取消。读者离开底部时不滚动，恢复阅读位置逻辑不变。
- **测试：** 新增“流式三次更新只滚动一帧”（旧实现 3 次，失败）、Composer 追加与删除的测量
  次数、`t()` 不再调用 `Intl.getCanonicalLocales`。全量测试 5,621 通过，2 失败与本改动
  无关（真实 OpenCode 集成测试因免费额度返回 403；Supervisor 超时设置用例此前已失败）。
- **`npm run perf:app` A/B（同机，改动前为临时 worktree 中的 `983cdd4` 构建，交替运行）：**

| 场景（4× 降速，3 轮） | 改动前 按键/点击 p50 / p95 | 改动后 |
| --- | --- | --- |
| 输入 120 字（新 profile） | 28–80 / 33–361 ms | 19–36 / 24–57 ms |
| 输入 120 字（有 300 个会话） | 265–2,372 / 1,486–4,266 ms | 27–161 / 32–346 ms |
| 首次切换会话 | 442–761 / 1,063–1,384 ms | 360–398 / 820–1,334 ms |
| 再次切换（缓存命中） | 472–749 / 501–1,143 ms | 390–420 / 456–951 ms |
| 流式 40 KB：Long Tasks 总时长 | 15.9–20.6 s | 15.1–17.4 s |
| 流式期间输入 | 432–6,778 / 1,146–9,634 ms | 96–466 / 297–1,567 ms |

  不降速时（2 轮）两版各场景持平，输入 p95 均约 9 ms，流式 1 个 Long Task。4× 降速下
  方差很大（同版本轮间可差数倍），应看量级：有历史时输入从秒级回到百毫秒内，切换略有改善，
  流式本身仍是每帧卡顿——剩余成本是 App 级重渲染与 Markdown/React 提交，需 `PERF-13`。
- **剩余：** 流式 delta 按帧合并后以 transition 提交、大面板 memo 仍待实施；之后进入
  `PERF-13`。

### PERF-13 Renderer 领域 Store 迁移

- **优先级 / 状态：** P1 / 待开始
- **顺序：** 流式缓冲 → Composer 草稿 → 会话与消息 → 任务与通知 → 设置及其余界面状态。
- **每个领域的完成步骤：** 建立 store 并把 IPC 订阅移入 store；调用方改为 selector；删除
  App 中对应 state/ref 同步代码；运行测试与 `PERF-11`。
- **验收：** 输入和流式更新不再重新渲染 App 根组件；`App.tsx` 最终降到布局壳规模。

### PERF-14 长列表虚拟化

- **优先级 / 状态：** P2 / 待开始
- **实施条件：** `PERF-13` 完成会话与消息迁移，行组件 props 已稳定。
- **范围：** 消息时间线和会话侧栏优先；保留滚动位置、跳转、展开状态和“加载更早消息”语义。
- **验收：** 5,000 条消息和 1,000 个会话场景下 DOM 节点数有界，滚动与切换指标改善。

### PERF-15 存储接口异步化

- **优先级 / 状态：** P1 / 待开始
- **范围：** 在原进程内把 `AssistantDatabase`、`KnowledgeDatabase` 等对外接口改为异步，
  调用方全部 `await`；会话列表只返回摘要，搜索下推到 SQL，活动记录改为增量追加。
- **验收：** 行为与测试不变；`PERF-11` Main event-loop 延迟不变差。

### PERF-16 数据进程

- **优先级 / 状态：** P1 / 待开始
- **实施条件：** `PERF-15` 完成，调用方已全部异步。
- **范围：** 新增独占 SQLite 的 `utilityProcess`，承接会话、知识库、向量检索、Story Graph、
  活动记录及文档解析；Main 只转发；保证同一时刻只有一个写入方。吸收 `PERF-06` 的范围。
- **验收：** 大知识库检索、会话列表和文档导入期间 Main event-loop 延迟达到批次目标；取消、
  崩溃恢复和迁移语义不回退。

### PERF-17 架构守护

- **优先级 / 状态：** P2 / 待开始
- **范围：** lint 禁止 `src/main` 使用同步文件 API 和在数据进程外引用 `DatabaseSync`；禁止
  组件直接订阅 `window.goodbuddy.*.on*`；限制 `App.tsx` 规模；`PERF-11` 关键指标设置回归阈值。
- **验收：** 违反规则的改动在 lint 或基准阶段失败。

## 8. 体验与可访问性

### UX-01 统一 Ask/Execute 文案

- **优先级 / 状态：** P1 / 已完成
- **范围：**
  - 删除“Execute 高风险操作仍需审批”的冲突说明。
  - 统一表达为使用当前账号完整权限执行，调用记录到活动。
  - 同步定时任务、Composer、Runtime、帮助文案及中英文资源。
- **验收：** 所有入口对 Ask/Execute 的描述与真实 Runtime 契约一致。

### UX-02 Runtime 显式状态

- **优先级 / 状态：** P1 / 已完成
- **范围：** 顶栏以状态点和 Runtime/模型名称紧凑表达状态：就绪为绿色，连接中为黄色，
  不可用为灰色；不重复显示状态文字，并通过 `aria-describedby` 暴露完整原因。
- **验收：** 三种状态均不重复显示状态文字；发送不可用原因仍由发送控件的可访问说明提供。

### UX-03 等待审批实时通知

- **优先级 / 状态：** P1 / 已完成
- **范围：** 审批卡首次出现时用 polite live region 播报等待状态和工具名；不抢焦点。
- **验收：** 屏幕阅读器能发现新审批，右侧栏数量变化也有可访问状态。

### UX-04 长任务阶段播报

- **优先级 / 状态：** P1 / 已完成
- **范围：** 低频阶段使用 `role="status"`，失败终态使用 `role="alert"`，不逐字播报正文。
- **验收：** 准备、等待、完成和失败可被辅助技术理解，流式输出不会形成播报风暴。

### UX-05 Composer 错误关联

- **优先级 / 状态：** P1 / 已完成
- **范围：** 附件和上下文错误使用稳定 ID、`role="alert"`、`aria-describedby` 和适当的
  `aria-invalid`。
- **验收：** 键盘和屏幕阅读器用户能知道发送失败原因及对应操作区域。

### UX-06 设置离开确认焦点

- **优先级 / 状态：** P1 / 已完成
- **范围：** 确认出现时滚动到可见区域并聚焦“继续编辑”，或改用共享确认对话框。
- **验收：** 在长设置页底部切换分类、关闭设置和应用导航时均不会出现不可见确认。

### UX-07 SSH Host 读取失败状态

- **优先级 / 状态：** P1 / 已完成
- **范围：** 读取失败与真实空列表分开，失败状态提供重新读取。
- **验收：** 暂时读取失败不会诱导用户重复添加 Host，重试成功后恢复原列表。

### UX-08 工作区预览重试

- **优先级 / 状态：** P2 / 已完成
- **范围：** 加载使用 `role="status"` 和 `aria-busy`；失败保留路径并提供重新读取。
- **验收：** 网络抖动后无需返回目录重新查找文件即可恢复预览。

### UX-09 最近对话空状态

- **优先级 / 状态：** P2 / 已完成
- **范围：** 区分首次为空、搜索无结果和加载失败，分别提供新建、清除搜索和重试。
- **验收：** 三种状态文案和操作互不混用。

### UX-10 共享加载状态语义

- **优先级 / 状态：** P2 / 已完成
- **范围：** 为共享 `EmptyState` 增加 loading 变体，并迁移知识库、智能心跳和 SSH Host。
- **验收：** 加载状态统一输出 `role="status"`、`aria-live="polite"` 和 `aria-busy="true"`。

### UX-11 更新检查错误反馈

- **优先级 / 状态：** P1 / 已完成
- **范围：**
  - 启动检查失败进入去重后的全局错误通知。
  - 保留来源、网络和有界 HTTP 错误上下文。
  - 打开下载页失败也显示通知。
- **验收：** 不再以空 `catch` 静默丢失用户可处理的更新错误。

### UX-12 更新源与自动检查解耦

- **优先级 / 状态：** P2 / 已完成
- **范围：**
  - 关闭启动检查后仍可选择 GitHub 或镜像。
  - 手动检查和下载继续使用所选来源。
  - 同步修订 `UI-DESIGN.md` 当前相反的规则。
- **验收：** “关闭自动检查、切换镜像、手动检查”流程通过测试。

## 9. 诊断与质量

### OPS-01 桌面端有界诊断日志

- **优先级 / 状态：** P1 / 已完成
- **范围：** 轮转记录最近启动和 Runtime 失败的时间、组件、阶段和稳定错误码。
- **限制：** 不记录 Prompt、凭据、文档正文或 Provider 原始响应。
- **验收：** 重启后仍可定位最近一次人为制造的数据库或 Runtime 启动失败。

### OPS-02 远端 Agent 有界诊断日志

- **优先级 / 状态：** P1 / 已完成
- **范围：** Detached Agent 保存有界轮转诊断，覆盖 Runtime 启动、退出、连接和恢复阶段。
- **验收：** 人为制造远端失败后可导出根因阶段；关闭和轮转不会遗留无界文件。
- **限制：** 不记录 accepted Prompt、模型密钥或完整模型配置。

### OPS-03 反馈可选附加诊断

- **优先级 / 状态：** P1 / 已完成
- **范围：** 用户主动勾选后才附加诊断，提交前说明类别，保留现有截图和草稿重试。
- **验收：** 默认反馈不附加诊断；勾选后只包含允许的有界记录。
- **依赖：** `OPS-01`；本批明确不自动读取或附加 `OPS-02` 的远端 Agent 记录，
  远端记录通过 Agent 固定 CLI 独立导出。

### QA-01 真实 Runtime E2E

- **优先级 / 状态：** P1 / 待开始
- **范围：**
  - 直连模型一次有界真实请求。
  - Bundled OpenCode 启动并执行文件任务。
  - Continue 启动并完成一次任务。
  - MCP 工具写入生产路径。
- **验收：** 受保护发布候选任务运行通过，并记录精确模型调用次数和费用边界。

### QA-02 本地兼容 Provider E2E

- **优先级 / 状态：** P1 / 待开始
- **目标：** 常规 CI 无需公网或真实模型凭据也能覆盖打包 Runtime 启动和工具路径。
- **范围：** 提供最小本地 OpenAI 兼容测试 Provider，覆盖流式响应和工具调用。
- **验收：** SDK、Runtime 二进制、Provider 适配或工具写入回归会使常规 CI 失败。

### QA-03 Windows ARM64 覆盖纠正

- **优先级 / 状态：** P1 / 待开始
- **范围：**
  - 文档明确 Windows ARM64 当前为交叉打包。
  - 在真实设备验证 Electron、node-pty、Koffi、Canvas、OCR 和 Runtime 加载。
  - 有可用 ARM64 Runner 后再声明原生 CI。
- **验收：** 文档和发布声明不再把文件架构验证描述为原生运行验证。
- **外部依赖：** 真实 Windows ARM64 设备或 Runner。

## 10. 每批完成标准

一个事项只有同时满足以下条件才可标记为“已完成”：

1. 正常 UI 操作到达生产实现并产生预期结果，不以 mock、注入 fake 或禁用入口代替。
2. 已覆盖本事项声明的可达失败场景，用户输入和可恢复上下文不会被静默丢弃。
3. 新增或更新聚焦测试；功能变化后运行：

   ```text
   npm test
   npm run typecheck
   npm run lint
   ```

4. 生产构建或发布脚本变化后运行 `npm run build`。
5. 改动涉及 GoodBuddy Agent 或 Desktop-to-Agent 生产路径时，按 `AGENTS.md` 在共享 Linux x64
   Test Host 验证当前源码或候选包；Host 不可达时明确记录阻塞，不能标记完成。
6. 检查并更新受影响的 PRD、架构、设计、功能矩阵、构建和运维文档。
7. 在批次记录中填写实际验证命令、结果、剩余限制和对应提交。

## 11. 批次记录模板

开始一个批次时，在本节末尾复制以下模板：

```markdown
### 批次 N：标题

- 状态：进行中
- 范围：ITEM-01、ITEM-02
- 明确不包含：
- 开始日期：
- 完成日期：
- 外部依赖：

#### 验收结果

- [ ] 正常生产路径
- [ ] 声明的失败与恢复路径
- [ ] 聚焦测试
- [ ] npm test
- [ ] npm run typecheck
- [ ] npm run lint
- [ ] npm run build（如适用）
- [ ] 真实 Host 或目标平台验证（如适用）
- [ ] 相关文档更新

#### 结果与剩余限制

- 提交：
- 验证：
- 剩余限制：
```

### 批次 1A：体验一致性与 P1 诊断

- 状态：已完成
- 范围：`UX-01` 至 `UX-12`、`OPS-01` 至 `OPS-03`
- 明确不包含：`REL-*`、`FUN-*`、`PERF-*`、`QA-*`，以及初始 Renderer Bundle 优化
- 开始日期：2026-08-31
- 完成日期：2026-08-31
- 外部依赖：无

#### 验收结果

- [x] 正常生产路径
- [x] 声明的失败与恢复路径
- [x] 聚焦测试
- [x] `npm test`
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm run build`
- [x] 共享 Linux x64 Host 的当前源码 Agent 候选验证
- [x] 相关文档更新

#### 结果与剩余限制

- 提交：尚未提交
- 验证：306 个测试文件、3322 项测试通过，49 项按既有条件跳过；Node/Web TypeScript、
  完整 ESLint、生产构建和 Renderer Bundle 预算均通过。共享 Linux x64 Host 使用隔离
  installation 完成 bootstrap、attach、断开重连、controller resume、Runtime 进程启动、
  CLI 诊断导出、重启读取、权限和诊断写失败隔离；真实文本模型调用 0 次。
- 剩余限制：真实 Host 本次没有通过 Agent-owned model bridge 执行 Prompt，因此未在该
  Host 上覆盖 Prompt 期间的 `runtime.starting/runtime.started` 诊断；三文件真实轮转仍由
  聚焦测试覆盖。正式发布、功能增强、性能基线和 QA 路线均不属于本批。
