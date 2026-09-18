# 本机专用推理架构与任务控制评估

## 记录范围与状态

评估日期：2026-09-18。本文记录 ASR、OCR、内置 embedding 的执行边界、任务控制缺口和后续优化依据，供语音输入、文档解析、知识检索与索引共同使用。

现状依据本次工作区源码核对，包含尚未提交的变更，不等同于已发布版本或实机验收结论。本次仅整理文档，未运行引擎性能测试、复现故障或实施迁移。下文“建议”是评估方向，“待办”均未在本次实施，也没有约定交付日期。

产品 Task、Job、Run 的定义沿用 [Task 与 Job 领域模型](../features/task-and-job/task-and-job-model.md)。本文的“推理任务”指一次引擎请求及其执行记录，不自动等同于产品 Task，不据此新增产品对象、持久化日志或全局调度器。本机推理管理的现有界面和接入清单见[应用导航技术设计](../features/application-tool-navigation/technical-design.md#111-本机推理任务与执行服务)；本文负责跨功能架构评估及优化待办。

## 当前执行边界

| 能力 | 源码现状 | 所有权与释放 | 评估建议 |
| --- | --- | --- | --- |
| ASR | 录音结果就绪后提交完整 PCM；Main 创建 `node:worker_threads` Worker，以 sherpa-onnx WASM 执行离线识别；服务一次只接受一个请求 | 每请求创建识别器；超时或 abort 调用并等待 `worker.terminate()`；正常结果路径的清理确认存在缺口，见 TC-4 | 保留请求级 Worker，适合间歇语音输入；常驻化需流式需求或测量支持 |
| OCR | Main 排队后发往主窗口 Renderer；Renderer 复用 Web Worker，运行 `ppu-paddle-ocr/web` 与 `onnxruntime-web` WASM；文档串行处理，PDF 逐页处理 | Renderer 模块持有 Worker；活动请求取消或单页超时会终止 Worker；无活动和排队请求时空闲 60 秒释放 | 当前保留 Web Worker；独立于 UI 的持续任务可评估专用后台 Renderer 加 Worker |
| 内置 embedding | Main 按模型目录共享引用计数 Broker；transport 使用 `utilityProcess.fork`，Granite tokenizer 和 ONNX session 首次请求懒加载并复用 | 多使用方共享进程；最后一个 provider 释放时 shutdown；也支持显式启停，停止等待 child exit | 保留共享 utilityProcess；优先核对取消后的容量回收与加载失败重试 |

### ASR 的证据与边界

[App.tsx](../../src/renderer/src/App.tsx) 在 `recording.result` 完成后调用 `speech.transcribe`；[录音模块](../../src/renderer/src/speech-recognition.ts)负责采样与重采样。[SpeechTranscriptionService](../../src/main/speech/speech-transcription-service.ts) 的 `active.size` 拒绝并发识别，`runSherpaTranscription` 为每次请求创建 Worker，转移音频缓冲区，使用 `createOfflineRecognizer` 同步 decode。Worker 创建后的识别超时为 120 秒，不包含此前模型解析的等待时间。

[package.json](../../package.json) 固定 `sherpa-onnx` 为 1.13.4；本次同时核对已安装包的 `index.js`，其入口加载 `sherpa-onnx-wasm-nodejs.js`。因此这里记录的是 Node Worker 内的 WASM 路径。Node Worker 与 Main 共享 OS 进程，线程隔离不能视为独立进程故障边界。

Worker 先 `postMessage`，再在 `finally` 中调用 `stream.free()` 和 `recognizer.free()`。Main 收到结果后以 `finish(..., false)` 结算、移除监听和超时，不等待 Worker exit；随后 `active` 删除请求，推理记录转为终态。这证明结果完成与资源清理确认之间存在记账间隙，但尚未证明实际泄漏或清理耗时。

### OCR 的浏览器依赖

[OCR Worker](../../src/renderer/src/document-ocr-worker.ts) 显式选择 WASM provider、`canvas-native` 图像处理，当前 `ort.env.wasm.numThreads = 1`。PDF 路径使用 `pdfjs-dist`、`OffscreenCanvas` 和 `convertToBlob`。本次核对的依赖链为 `ppu-paddle-ocr/web/platform.web.js` 到 `ppu-ocv/canvas-web`；后者的 `platform/web.js` 使用 `createImageBitmap` 解码图片。包依赖以 [package-lock.json](../../package-lock.json) 为准，依赖升级后需重新核对此结论。

这些能力与浏览器执行环境有关。直接迁到 Node utilityProcess，需要另行验证图像解码、Canvas、PDF 渲染及打包资源路径，不能只替换进程创建 API 就宣称等价。

[DocumentOcrBroker](../../src/main/document-ocr-broker.ts) 最多保留 4 个 pending 请求，一次派发一个；总超时从派发时开始，不覆盖 Main 排队等待。其预算为 `min(10 分钟, max(单页预算, 60 秒 + 单页预算 × 页数))`。[Renderer bridge](../../src/renderer/src/document-ocr-bridge.ts) 另有串行 Promise 队列，Worker 就绪超时为 120 秒，就绪后按单页预算计时，并在进度消息到达时重置单页计时器。Main 的 60 秒启动预算与 Renderer 的 120 秒就绪等待未对齐，短文档冷启动时 Main 有机会先判超时。

[Main 初始化](../../src/main/index.ts) 将 Broker 绑定到 `mainWindow`；[Renderer 入口](../../src/renderer/src/main.tsx) 安装 bridge。Broker 派发前仅检查窗口销毁等条件，没有等待 bridge 就绪的握手，也没有在该派发链路中处理 bridge 就绪丢失。Renderer 内的 Worker `ready` 只确认模型初始化，不能证明 Main 发请求时 Renderer 已安装 IPC 监听。窗口重载、Renderer 崩溃及启动时监听尚未安装的影响应按 TC-3 复现。

来源请求可以取消 OCR；已派发请求取消时 Main 发送取消消息并立即结算，然后派发下一项，未等待 Renderer 清理确认。Renderer 对当前活动请求的取消会终止共享 Worker。管理页因此没有将该操作作为安全的单任务取消能力；手动释放也会拒绝活动或排队请求。

### Embedding 的共享执行与取消

[Main provider 工厂](../../src/main/index.ts) 按模型目录维护 `sharedEmbeddingBrokers` 及使用计数；[transport](../../src/main/knowledge/embedding-utility-transport.ts) 以 spawn 确认进程启动。[Granite 引擎](../../src/main/knowledge/granite-embedding-engine.ts) 缓存 `loadTask`，在首次请求时创建 tokenizer 和 WASM ONNX session。进程已启动不等于模型已加载；当前没有为模型加载完成提供独立服务状态。

[Broker](../../src/main/knowledge/embedding-inference-broker.ts) 默认请求超时为 120 秒，计时在 transport 就绪后建立 pending 时开始。调用方取消或超时会先返回错误，同时发送 cancel，保留 pending 和推理执行记录，等待结果、`CANCELLED` 或进程退出。保留容量避免把仍在计算的任务当作已释放。

[执行端](../../src/main/knowledge/embedding-inference-worker.ts) 收到 cancel 后设置 AbortSignal；Granite 在加载、输入构造和 `session.run` 前后检查取消，但没有将可抢占的取消句柄传入 `session.run`。若该调用一直不返回，取消检查和确认就无法完成。Broker 的 `cancelPending` 会清除原计时器，当前没有针对该 pending 的后续有界清理升级，因此持续挂起可一直占用在途容量。此为源码可达的条件风险，真实引擎挂起尚未复现。

`loadTask ??= this.loadFiles(...)` 也会缓存被拒绝的加载 Promise；同一引擎实例后续请求复用同一个失败，不能通过再次请求重新加载。重建进程会建立新引擎；是否增加实例内重试及其清理方式，按 TC-2 验证后确定。

## 架构建议与触发条件

ASR 继续按录音请求创建 Worker。对低频、间歇输入，每次释放模型能避免长期占用；本次没有冷启动与常驻成本数据，不能量化收益。只有连续流式识别成为真实需求，或高频请求测出重复加载已影响目标延迟，才评估常驻 utilityProcess。届时需比较加载成本、暖请求延迟、空闲工作集和取消时延，并重新设计音频流与识别器复用；单纯常驻不会把当前离线 API 变成流式识别。

OCR 保留 Web Worker。如果文档任务需要在主 UI 重载或不可用时继续执行，优先评估由 Main 持有的专用后台 Renderer 加 Worker，以保留浏览器图像/PDF 能力。该方案仍是候选，需要完成以下设计与实机验证后才可决定迁移：

- 保持现有 sandbox、context isolation、禁用 Node integration 的边界；通过专用 preload 暴露必要方法，并沿用可信 sender 与输入校验。当前 IPC 若限定主窗口 sender，需要明确新增宿主的受信身份及响应归属。
- 分别确认后台 Renderer 的 IPC 监听就绪与 Worker 模型就绪；定义重载、崩溃、启动失败及应用退出时 pending、队列和模型的处置，防止静默丢请求或自动重放。
- Main 持有后台宿主生命周期；管理 UI 关闭不销毁执行宿主，服务释放和应用退出才按约定清理。验证隐藏 Renderer 的调度、计时器和 Worker 执行，不根据窗口不可见推断运行不受影响。
- 用实际 OS PID、Electron 进程指标和崩溃影响验证隔离程度。单独的 BrowserWindow/WebContents 不能直接作为独立 OS 进程或独立服务资源统计的证据；若与其他 Renderer 共享 PID，必须继续报告共享范围。

Embedding 保留共享 utilityProcess。查询与索引共享模型和进程的现有方式具备复用基础，优化先处理取消回收和失败重试。单请求取消继续尽量只影响该请求；进程终止属于服务级操作，必须说明其他使用方的结果。不得把每次请求超时直接等同于可以无条件杀死共享进程。

## 任务控制覆盖与缺口

[共享契约](../../src/shared/local-inference-contracts.ts)将服务状态与任务状态分开；[LocalInferenceService](../../src/main/local-inference-service.ts) 在 Main 内存登记请求，保存活动项及最近 100 条终态记录。任务的 `running` 当前包含排队、模型加载与执行，未提供统一细分阶段。该登记器是观测和控制入口，各引擎仍负责实际队列与清理。

| 控制维度 | 当前覆盖 | 后续评估和验收要求 |
| --- | --- | --- |
| 状态 | 任务有 `running/cancelling/completed/cancelled/failed`；服务另有启动、运行、停止、未知和错误状态；ASR 模型可用时服务仍为 unknown | 区分调用方已返回、执行仍活动、资源清理已确认；进程 spawn、模型 ready、请求完成不能互相替代。先增加必要证据，不预建完整阶段状态机 |
| 所有权 | ASR 请求持有 Worker；OCR Renderer 持有共享 Worker；embedding 按目录共享 Broker 并引用计数 | 控制记录注明真实来源与宿主；缺失项目、会话关联时不猜测归属。产品 Task 的取消不能凭名称去停止整个推理服务 |
| 取消 | ASR terminate；OCR 来源取消会终止当前 Worker；embedding 协作取消并保留执行记录 | 验证取消与自然完成竞态、重复取消及清理结果。单请求取消与共享服务停止分别定义影响，不用 UI 隐藏代替取消 |
| 超时与容量 | ASR Worker 120 秒；OCR 两端预算与排队语义不同；embedding 默认请求 120 秒且保留取消后容量 | 分别说明排队、启动、推理、清理的计时起点和上限；调用方超时后仍在执行的工作需要有界处置，不得提前释放容量制造超额并发 |
| 停止与清理 | 服务操作按 serviceId 串行，期间拒绝新增请求；停止校验当前活动 taskId 确认清单；向量停止等待 exit，重启不重放请求 | 清理失败保持可观察的活动/错误信息；窗口或宿主丢失需使受影响请求得到明确结果；ASR 和 OCR 的结果/清理间隙分别核对 |
| 可观测性 | 有来源、状态、时间、可选模型和错误；向量有 PID 资源数据；管理 Modal 不显示任务历史 | 测量排队、加载、执行、取消请求到执行结束、清理确认的耗时与在途数；日志不记录音频、图片或向量原文，未知指标不补零 |

本文的覆盖要求用于后续问题复现和最小修复，不构成引入统一常驻服务框架、持久化执行副本或自动恢复协议的决定。范围为桌面本机引擎；远程 Agent、外部向量端点和未接入的 TTS 不因此获得同样控制能力。

## 资源观测口径

[LocalInferencePage](../../src/renderer/src/LocalInferencePage.tsx) 在启用、文档可见且 Modal 内容未被 hidden/inert 隔离时每 5 秒读取快照，跳过重叠请求，关闭时清理轮询。该刷新间隔不能用于证明短请求的峰值或清理完成时刻。

[向量资源采样器](../../src/main/inference-process-resources.ts) 按 transport 当前 PID 匹配 `app.getAppMetrics()` 的 Utility 条目，用累计 CPU 秒差除以单调时间间隔。100% 表示一个逻辑核心，可超过 100%；首次采样、PID/创建时间变化、间隔超过 15 秒或读数异常时重建基线。工作集从 KiB 转为字节，UI 显示 MiB。

向量工作集包含运行时、模型、临时缓冲区及并发使用方，不能当作模型权重大小或单任务内存。ASR Node Worker 和 OCR Web Worker 没有当前可独立归属的 OS 进程工作集；宿主进程总量不能直接填入某个服务行。未来 OCR 后台宿主也必须先核实 PID 与共享情况，再决定指标范围。显存当前未采集。

## 优化待办与验收

优先级表示建议处理顺序：P1 为执行正确性和回收问题，P2 为测量及有条件的架构选型。全部待办待开展；源码核对已完成，故障复现、修复和实机验收分别记录，不以文档完成替代实现完成。

| ID | 优先级与事项 | 依赖及验收条件 |
| --- | --- | --- |
| TC-1 | P1：embedding 取消/超时后的有界回收 | 先覆盖 `session.run` 延迟返回及不返回，观察 caller、pending、执行记录与容量。定义取消后的清理等待上限及升级条件，数值依据测量确定。普通取消不终止其他共享任务；确需服务级终止时明确受影响使用方及失败结果，等实际退出再释放容量，且不重放请求。模拟用于稳定触发条件，最终以真实引擎取消和停止路径补验 |
| TC-2 | P1：embedding 加载失败重试 | 覆盖首次读模型或建 session 失败、随后恢复依赖的场景；选择清除失败缓存或显式重建引擎的最小方案。验收后续请求能够重新加载，并发请求不重复加载，失败中已创建的资源被清理，销毁后不再复活；不能把一次成功创建进程当作重试通过 |
| TC-3 | P1：OCR 宿主就绪、丢失与超时预算 | 保留当前 Web Worker 即可先验证，无须等待迁移。覆盖监听安装前派发、主 Renderer 重载/崩溃、冷启动超过 Main 启动预算及排队取消。明确 bridge 就绪与 Worker ready 的区别；受影响请求有明确结果，队列能继续使用，没有静默丢失或重放；两端预算、起算点和取消后下一项派发与清理顺序一致 |
| TC-4 | P1：ASR 结果与清理记账 | 覆盖结果先到、延迟退出、清理异常以及取消/超时与结果竞争。选择延后请求结算或单独保留清理记录的最小方案；验收资源仍活动时不会被报告为已释放，也不提前放开实际单请求容量。正常完成及异常路径均验证 Worker 最终退出 |
| TC-5 | P2：统一测量记录与资源归属核验 | 可与 P1 复现并行，为 TC-6/TC-7 提供依据。记录冷/暖加载时间、端到端延迟、排队时长、取消至执行结束/资源回收时长、空闲与峰值工作集、CPU 时间和样本数；按 PID 对照 OS 工具，分别报告引擎、宿主与应用总量。重启后不沿用旧 PID 基线，不以 5 秒 UI 轮询代替专门测量 |
| TC-6 | P2、条件待定：OCR 后台 Renderer 加 Worker | 依赖明确的 UI 独立执行需求、TC-3 生命周期结论及 TC-5 数据。候选验证需包含图片、多页 PDF、UI 重载时执行、后台宿主崩溃、空闲释放、应用退出、preload/IPC sender 边界和各支持平台打包资源。证实任务连续性及实际 PID 隔离后，再记录采用或保留现状的结论 |
| TC-7 | P2、条件待定：ASR 常驻 utilityProcess | 依赖流式/高频场景成立，或 TC-5 证明重复加载达到需优化程度，并完成 TC-4。对比请求级 Worker 与候选的冷启动、暖请求、空闲内存和取消成本；若为流式，验证连续音频、结果提交和停止语义。没有测量或实际需求时继续保留请求级 Worker |

测量记录应包含 OS/架构、Electron 与依赖版本、模型版本、硬件、输入时长/页数/token 与批量大小、冷暖条件、请求频率和并发使用方。使用固定可重复输入，报告样本数、分布及异常，不填入未经测量的性能收益。后续验收覆盖受影响的 Windows、macOS、Linux 构建；尚未测的平台明确保留为待验。

本次证据为源码和已安装依赖入口检查。后续执行待办时，在所属功能进度文档记录命令、环境、真实路径结果及遗留项，并引用 TC 编号；若迁移条件未成立，记录保留现状的原因即可。
