# 存储架构升级实施与验收记录

## 交付范围

本记录跟踪 [架构设计](../architecture/desktop-storage-direction.md) 的 SA-01 至 SA-08，并汇总
[Assistant 消费者](../architecture/assistant-storage-consumers.md)、[Knowledge 迁移](../architecture/desktop-storage-knowledge.md)、
[文件存储](../architecture/desktop-storage-files.md) 和 [Runtime 存储](../architecture/desktop-storage-runtime-integration.md) 的当前实现。
同一候选已完成多项桌面数据库所有权迁移、异步生产调用、输出唯一存储和临时资源清理。
内部工作按依赖并行执行，最终整体交付。接口、进程握手或分组测试通过均不代表产品完成。
保留现有未提交文档及仓库规则修改，不自动提交或发布。

## 实施分工

| 工作包 | 实施内容及替代入口 | 验证要求 | 当前状态 |
| --- | --- | --- | --- |
| S01 存储宿主 | 复用 reader 请求关联与 utilityProcess；宿主打开 Assistant／Knowledge，负责升级、查询分派、提交和退出 | 真实 Electron 进程、升级失败重试、取消结算、提交后读取、退出排空 | 已实现并接入生产组合；全量验收未完成 |
| S02 Assistant 调用 | IPC、心跳、监督、任务、笔记、通道、审计和工具接口改用异步领域操作；回调事务留在宿主 | 先写后读、回顾原子发布、项目隔离、暂停／恢复、错误传播 | 已接入生产组合；完整并发验收未完成 |
| S03 Knowledge 调用 | 数据库与 external repository 归宿主；解析、模型与凭据保留原所属；发布 DTO 替代事务回调 | 导入、检索、重建、embedding、删除和取消 | 已接入生产组合；完整 App 和并发验收未完成 |
| S04 文件与关联 | 文档结果、附件引用、正文分页由同一存储宿主管理；删除重复 Markdown；保留分支引用 | 采用／复制／释放／重启，取消失败全文，删除项目引用回收 | 已接入生产组合；完整 App 和并发验收未完成 |
| S05 绑定与账本 | 桌面远程绑定和原生客户端账本迁入宿主；远端数据库保持原所有权 | claim 后派发、提交后 ACK、响应不确定、关闭后删除目录 | 已接入生产组合；完整 App 和并发验收未完成 |
| S06 输出与启动材料 | 短输出有界内存，全文唯一 backing；必要配置文件归属、部分创建清理、启动回收 | 字节等价、内存上限、无多余文件、活跃所有者保护 | 生产 backing 已接入；跨场景文件与生命周期验收未完成 |
| S07 应用组合 | Main 初始化、事件通知、远程批处理、shutdown 接入统一存储；删除旧打开和同步回退 | 正常 UI 进入真实宿主，后台／恢复入口，退出失败可见 | 当前 Main 组合已接入；全路径验收未完成 |
| S08 守护与验收 | 扩展现有 lint、性能脚本和 Electron 测试；复核旧调用及重复实现 | 全仓检查、C01–C07／A01–A10、真实模型及数据副本 | 待最终候选 |

S01 的契约供 S02–S06 复用，S07 统一组合。跨包共享文件由指定整合者修改；业务代理提供所需操作和测试。
全量测试只对组合后的候选作最终判定。每次失败记录源码版本、原因、修复及复测，不放宽预算。

## 已发现问题对应关系

监督者重读／发布 Main 阻塞对应 S01／S02／S07；过大响应、窗口化和摘要缓存保留此前修复并在 C03／C07 回归。
跨会话全局等待、取消／迟到路由、超限用量与 Telegram 交付保留已有修复，纳入故障和混合负载验收。
输出短内容写后即删、全文引用缺失、重复解析 Markdown、Continue 部分创建和 helper 退出、Python 归档残留对应 S04／S06。
Agent 旧包／远程 staging 的失败清理、项目删除附件回收、诊断解析结果归属及笔记原子临时残留需逐项核对现有实现后记录处理结果。
有意保留的原生历史、安装缓存、用户导出、模型文件与 WAL 不作为垃圾删除。

## 真实数据与模型

已定位 portable：`dist/GoodBuddy-windows-x64/data`。该位置是原始数据，只读取统计并制作一致性备份，禁止直接启动候选写入。
数据库存在活动 WAL 时使用 SQLite 一致性备份；备份与工作副本分开，测试材料位于仓库 `temp/goodbuddy-storage-upgrade/`。
仅复制测试必需的数据库及所引用文件，记录校验值、schema、行数与完整性；不把凭据或正文写入报告。
源库无 WAL 且确认关闭时才允许直接文件复制。升级后逐项比较稳定 ID、顺序、引用、事件还原与重放去重。

性能采用本地确定性模型，真实模型用于生产功能链：普通会话及工具、子任务、监督发布、本地／远程 Runtime。
外部调用有界，记录实际请求数；真实数据内容不会为了性能测试默认发送到外部模型。
远程验证沿用共享 Linux x64 Host、现有凭据和专用测试目录，结束确认所属进程退出。

## 完成条件

最终运行 `npm test`、`npm run typecheck`、`npm run lint` 和差异检查；构建入口变化验证开发构建。
按 [并发验收规范](./concurrent-desktop-acceptance.md) 固定负载和三轮前后对照，包含 30 分钟生命周期。
分别报告界面延迟、Main 阻塞、存储等待／提交、吞吐、取消、内存和文件增长，禁止将单测通过替代性能结论。
实测超预算、未覆盖平台或外部环境阻断均保留为未满足项，不能宣称全部已解决。

当前记录确认 S01-S07 已有生产组合和定向证据；解析 Worker 的无依据队列拒绝已移除。
完整架构验收、平台包验证和 C01-C07/A01-A10 仍未完成。

## 2026-10-05 Portable 真实副本验证

本轮已执行当前源码的 `DesktopStorageClient → utilityProcess → DesktopStorageOwner`，
使用生产升级、读取、发布和关闭入口。脚本为
`tests/support/portable-storage-upgrade.mjs` 与 `portable-storage-upgrade-fixture.ts`。
成功运行始于 `2026-10-05T12:03:32.624Z`，总耗时 265.074 秒；
基于提交 `4bb7573b10ecc46f746fbe04cf6b1e2c05647d1a` 的未提交工作树。
环境为 Windows `10.0.26200`、Intel Core Ultra X7 358H、33,873,752,064 字节内存、
Node `24.21.0`、Electron `44.5.1`。这次未启动完整桌面 UI。

### 原件、备份与清理

原件位于 `dist/GoodBuddy-windows-x64/data`。成功运行没有在该目录打开 SQLite 连接，
也没有启动以该目录为用户数据目录的候选程序。先复制主文件与 WAL 到隔离 capture 目录，
确认源文件的大小、修改时间和 SHA-256 未变，再从 capture 执行 SQLite online backup，
由备份生成独立工作副本。本轮四个源 WAL 均为 0 字节；不能据此声称已覆盖持续写入的活动 WAL。
各数据库分别备份，文件集合不构成跨数据库事务快照。

四个源主文件及各自 WAL／SHM 共 12 个文件的前后大小、修改时间和 SHA-256 全部一致。
升级后的四个备份主文件 SHA-256 也与升级前一致。73 个附件引用均有可复制内容，
包括目录附件，合计 12,720,927 字节；50 个笔记文件合计 431,056 字节。
附件及笔记在复制时校验内容摘要，生产写入与重开后再次确认原件及工作副本内容未变。
日志只保存表名、计数、摘要和断言结果；没有复制设置或凭据，没有把正文写入报告，外部模型调用为 0。

被取消的旧探针曾继续占用 `run/work` 的 Assistant 文件。环境中的 `node` 实际由
`GoodBuddy.exe` 承载，按可执行文件名查询 Node／Electron 会漏掉该进程。
确认其命令行为本任务旧探针后，终止所属进程树并删除残留文件。
成功运行自动删除 `fresh-run` 的 capture、backup、work、WAL／SHM 与 Electron 临时目录；
旧 `run` 也已删除。保留的 `temp/goodbuddy-storage-upgrade/summary.json` 为无正文统计证据。
原取消轮没有保存完整源文件前后报告，因此上述原件不变结论限定于本次有记录的验证区间。

### 数据与正确性

| 数据库 | 源主文件／备份字节数 | schema 前 → 后 | 实际数据规模 | 完成写入练习后的主文件字节数 |
| --- | ---: | --- | --- | ---: |
| Assistant | 2,429,247,488 | 61 → 62 | 11 项目、312 会话、4,836 消息、2,353 任务、1,755,171 事件、233 成果、23,690 活动记录 | 2,432,491,520 |
| Knowledge | 1,568,768 | 13 → 13 | 2 知识库、2 文档、27 分块、27 embedding | 1,568,768 |
| Attachments | 98,304 | 1 → 1 | 73 附件、73 引用 | 98,304 |
| Runtime Bindings | 143,360 | 0 → 0 | 53 绑定 | 143,360 |

本轮实际覆盖的 Assistant 61 → 62 迁移新增监督来源／结果索引；数据已有历史差量存储，
没有重跑 schema 33／34 的正文压缩迁移。

在追加合成记录之前，对四库全部已有用户表逐行计算规范化摘要，比较行数与表摘要。
比较包含稳定 ID、顺序字段、时间、引用和远程来源字段；子任务事件按任务及事件 ID 顺序，
调用生产 `restoreSubagentPayload` 还原后比较。未变的不可变过程块复用内容摘要，
过程块数量与顺序仍参与每条事件的摘要。所有已有表的 `changed` 与 `added` 列表均为空，
没有需要豁免的启动恢复差异。Assistant 完整扫描前／后分别耗时 80.393／107.989 秒。

备份、升级副本及完成写入练习后的四库 `integrity_check` 均为 `ok`，
`foreign_key_check` 均为 0 条。真实监督数据包含 3 个结果、434 个事件、758 个来源；
读取其中一个图谱并关闭／重开，内容摘要一致。
新增远程事件的首次写入、同内容重放去重、冲突拒绝、已提交序号读取，以及重开后的重放去重均通过。
100 批合成监督发布每批包含 20 个来源及 20 个事件；最后一批的事件、来源和 20 条关联均存在，
关联端点有效，关闭／重开后图谱摘要一致。

Assistant 空闲页从 1,643 变为 1,619，Knowledge 维持 90 页；本轮没有证明空间回收收益。
表中 Assistant 最终大小包含后续合成发布与去重记录，不能当成仅升级造成的增长。
最终工作 WAL 的独立字节数没有写入该轮报告，退出后相关副本已清理。

### 耗时与边界

| 项目 | 单轮观测 |
| --- | --- |
| 首次生产存储就绪／关闭后再次就绪 | 557.778／308.364 ms |
| 后续练习初始化／再次就绪 | 333.349／286.487 ms |
| 100 次发布与 100 组图谱＋结果列表读取重叠执行 | 32,363.016 ms |
| 发布 p50／p95／max | 10.830／15.269／27.026 ms |
| 读取组 p50／p95／max | 334.647／355.728／368.961 ms |
| 夹具 Main 事件循环延迟 p99／max | 16.482／17.121 ms，共 2,117 个采样 |
| 结束时 pending／Main RSS | 0／93,634,560 字节 |

这些数值来自单轮、两个有界生产者的闭环负载，不能替代固定 offered load、三轮前后对照、
多项目混合负载或 C01–C07／A01–A10。pending 高水位只在请求完成后采样，观测值 1 不是全程峰值。
未测 UI 响应、Renderer、存储进程内的等待与提交分解、30 分钟生命周期、真实模型及远程 Host。
Main 延迟采样也不能替代单次阻塞测量，当前证据不足以宣称所有性能预算达标。

探针设有 15 分钟总期限、每个 Electron 练习 180 秒期限、完整扫描 600 秒检查，
扫描每 100,000 行报告进度，练习每 10 秒报告阶段；通过后台运行与有界轮询执行。
前一版重复序列化累计过程的扫描超过期限，修正为复用块摘要后才完成全量比较，未减少事件数。
另外修复了 `publishedGraph` 的 `unknown` 使用：用共享 `supervisionGraphViewSchema` 校验响应，
没有用类型断言跳过检查。依赖目录缺失曾阻断续跑，经用户授权按 lockfile 恢复后完成执行。

### 检查结果

`npm run typecheck` 全仓通过，用时 14.312 秒。两个探针文件的 ESLint 通过。
定向运行 `desktop-storage.test.ts`、`desktop-storage-files.test.ts`、
`desktop-storage-runtime-operations.test.ts` 与 `assistant-storage-upgrade.test.ts`，
4 文件、31 测试全部通过，Vitest 报告 8.56 秒；包含真实 Electron 存储及历史迁移合成回归。
结束前执行 `--verify-source`，再次确认 12 个源 DB／WAL／SHM 指纹和笔记摘要与本轮基线一致。
`git diff --check` 无空白错误。中文审校扫描无阻断项，复核项中的测试边界与实际统计表述保留。

全仓 `npm run lint` 最后仍有一个范围外错误：
`tests/support/story-graph-focus-driver.mjs:122` 的 `console` 未定义；没有修改该探针。
全仓 `npm test` 使用 300 秒总期限启动，结束时没有留下最终汇总或退出结果，不能标记为通过。
已输出的失败涉及 `MarkdownRenderer.cache.test.tsx` 的 1 个微基准、
`image-tool-mcp.test.ts` 的 3 个测试及 `obsidian-electron.test.ts` 的 1 个测试。
这些失败保留给对应实现负责者，不以本轮存储验证通过覆盖全仓失败。
检查产生的本任务临时目录也在所属进程退出后清理；没有提交代码。

## 2026-10-05 C01-C07 并发桌面验收（未完成）

本轮使用现有 `build/run-app-perf.cjs` 与
`tests/support/app-perf-driver.mjs`，新增最小并发模式夹具
`tests/support/app-perf-concurrent.mjs`。夹具通过真实 UI、Preload、Main、存储宿主和本地回环确定性模型运行；没有启动 portable 原始目录，也没有外部模型请求。基线使用独立 worktree 的提交
`4bb7573b10ecc46f746fbe04cf6b1e2c05647d1a`，候选为同一提交的当前未提交工作树。日志和原始 JSON 位于 `temp/goodbuddy-concurrent-upgrade/`。

本轮没有达到验收规范要求的三轮交替、每项三轮各 100 个有效样本，也没有完成全部 C01-C07。因此不能标记 PERF-15／PERF-16 或本架构验收通过。

| 场景 | 实际结果 | 证据与主要指标 |
| --- | --- | --- |
| C01 3／4／8 | 未通过 | 当前候选首轮测量 1,898 个按键样本，p95 输入 16.8 ms、p95 帧 17.0 ms，但 Main 最大事件循环延迟 64.4 ms；请求未排空，驱动超时。基线首轮在第一批真实发送前等待发送按钮超时。 |
| C02 4／8／16 | 未通过 | 两个 30 秒测量周期完成；周期 1 有 494 个按键样本，p95 输入 17.4 ms、p95 帧 17.2 ms、4.2% 抖动、Main p99 18.4 ms、最大 25.3 ms。第三周期在请求排空前超时；标准机输入和帧 p95 均超预算。 |
| C03 回顾发布＋知识重叠 | 未执行 | 现有 App 夹具没有真实重叠的 100 批回顾发布、知识导入／检索和图谱读取生产动作。 |
| C04 故障隔离 | 未执行 | 没有挂起启动／模型路由／清理并验证取消及健康 peer 的夹具。 |
| C05 存储故障与饱和 | 未通过 | C06 运行期间生产存储路径实际多次返回 `STORAGE_CAPACITY`；错误来自 `ReadonlyQueryReader.call` 的会话队列读取，已保留在 `soak-current/execution.log`。专门读 Worker 失败、存储进程退出和提交前后故障注入尚未完成。 |
| C06 30 分钟生命周期 | 未完成 | 已启动完整期限为 1,800,000 ms 的后台运行，实际约 34.5 分钟后因驱动超时退出；首个 30 秒测量有 494 个按键样本，p95 输入 16.6 ms、p95 帧 16.9 ms、Main p99 17.5 ms。由于请求持续在途且存储容量错误，未完成规范要求的完整生命周期、关闭重开和排空，不能算通过。 |
| C07 冷／暖进入 | 未通过 | 两个周期完成；周期 1 有 442 个按键样本，p95 输入 17.8 ms、p95 帧 50.0 ms、8.2% 抖动、Main p99 17.7 ms。夹具尚未分别测量监督概览、图谱、历史选择和来源正文的冷／暖内容可用时刻。 |

资源证据包括每个场景的 Browser、Tab、GPU、Utility PID、CPU 和工作集快照。当前候选的 C02 周期 1 Tab 工作集约 210 MB、Browser 约 200 MB；C07 周期 1 Tab 约 210 MB、Browser 约 212 MB。夹具已记录 3／4 和 4／8 项目／会话档位及 8／16 子任务 offered load，但生产事件中没有形成稳定的 8／16 个同时运行子任务，不能把 offered load 当成实际吞吐。周期性 4 KiB 工具更新、存储排队／执行拆分、缓存／订阅计数、临时文件字节数、C03-C05 故障动作和完整 supervisor 冷／暖内容指标均为未采集项。

本轮没有修改核心存储或调度实现。`node --check build/run-app-perf.cjs` 和
`node --check tests/support/app-perf-concurrent.mjs` 通过；未运行全仓 `npm test`，
因此本节只记录局部复测，不改变 C01-C07 的未完成状态。

### 2026-10-05 C01/C02/C07 实际证据复核与局部修复

复核了上述原始 JSON、`soak-current/execution.log` 及生产源码。容量错误的实际调用链为
`pumpConversationQueue` → `DesktopStorageClient.listConversationQueueItems` →
`ReadonlyQueryReader.call`；同一压力段还可见 `tasks:execution-stats`、工作区变化和概览读取竞争同一
有界读容量。C01 候选首轮为 1,898 个输入样本，输入 p95 16.8 ms、帧 p95 17.0 ms、Main 最大
64.4 ms；C02 周期 1 为 494 个样本，输入 p95 17.4 ms、帧 p95 17.2 ms、Main p99 18.4 ms、
最大 25.3 ms；C07 周期 1 为 442 个样本，输入 p95 17.8 ms、帧 p95 50.0 ms、Main p99
17.7 ms。C02/C07 的长帧主要出现在持续事件输入和显示刷新期间，采样中没有长任务脚本时间，
但有长动画帧的渲染／样式布局时间；因此未减少 offered load、输入样本或阈值。

本轮应用了三个最小局部调整：隐藏窗口时丢弃已过时的会话显示刷新并在重新可见时重读；侧栏隐藏时
不挂载项目切换器、活动菜单及其项目行；队列泵遇到 `STORAGE_CAPACITY` 时按会话只保留一个
50 ms 后重试，避免同一队列因容量瞬时不足进入错误风暴。正常事件、持久化和队列项目均保留。
定向 `ipc`、刷新和项目切换回归为 248 passed、1 skipped；类型检查和相关 lint 通过。

重新构建后以相同 C02 档位（4 项目／8 会话／16 子任务、每轮 30 秒输入）执行了四个周期，
原始报告位于 `temp/goodbuddy-concurrent-upgrade/profile-1MGfH7/artifacts/result.json`。修复后四轮
输入 p95 为 16.9／16.9／17.0／17.3 ms，帧 p95 为 16.9／16.9／17.0／17.1 ms，Main
最大事件循环延迟为 46.5／31.1／45.8／292.8 ms；最后一轮仍有 1 个 51 ms 长任务，驱动因
请求未排空而超时。日志仍观察到少量其他后台读取的 `STORAGE_CAPACITY`，所以本轮只能证明显示
刷新和队列重试的局部改善，不能标记 C02 或容量验收通过。相对原 C02 周期 1，前三轮输入／帧
p95 已回到约 17 ms，但 Main 尾延迟和完整排空仍未达预算；C01/C07 尚未取得修复后的同口径复测。

## 2026-10-05 C03／C04／C07 补充运行（仍未满足）

本轮只扩展现有 `build/run-app-perf.cjs`、`tests/support/app-perf-driver.mjs` 的
并发夹具，并通过已有 Preload／IPC／存储宿主／SQLite 生产入口执行。模型仍为本地
回环确定性模型，数据目录和运行目录均由 `run-app-perf` 隔离在
`temp/goodbuddy-concurrent-upgrade/`。构建命令为 `npm run build:bundle`；本轮没有
修改核心存储或调度实现，也没有提交。

| 场景 | 实际结果 | 证据 |
| --- | --- | --- |
| C03 混合存储 | 未满足 | `C03-current-r4/result.json` 记录知识导入耗时 4,307.193 ms，100 个重叠批次，100 次历史读取、100 次知识检索、100 次图谱读取，重叠窗口 3,784.373 ms。当前隔离数据没有已持久化监督结果，回顾发布批次为 0，因此没有把图谱读取冒充回顾发布；运行期间日志出现 `STORAGE_CAPACITY`。结果状态保留为 `not-fulfilled`。 |
| C04 故障隔离 | 未满足 | 复核发现原夹具在请求观察器登记前允许点击取消，且 HTTP `request.close` 被误记为模型中止；现已改为等待请求登记、使用响应 `close` 判断异常中止，并等待健康 peer 真正进入和完成。`C04-final-local-r2/result.json`（本地确定性、Windows x64、Electron 44.5.1）记录取消后请求结算、查询和 Runtime status 响应、清理完成，健康 peer 用时 37,142 ms，但 `healthyPeerUnaffected: false`，且循环账本 4 次请求中没有 `fault-hung` 条目，因此不能声称挂起模型路径已完成。外部模型请求数为 0；未授权执行真实模型。 |
| C07 冷／暖进入 | 未满足 | `C07-current-r1/result.json` 记录冷进入：输入 0.591 ms、历史 41.889 ms、监督概览 2.532 ms、图谱 2.244 ms、知识快照 2.555 ms；暖返回：输入 18.844 ms、历史 219.868 ms、图谱 10.757 ms、知识快照 2.062 ms。暖监督概览因 `STORAGE_CAPACITY` 无可用时刻；来源正文没有持久化来源，仍未测得。夹具状态为 `measured-with-gaps`，整体未满足。 |

所有补充运行均保存原始 `result.json` 和执行日志；模型边界仍为本地回环，外部请求数为 0。运行中观察到的存储容量错误及一次存储 Worker 退出均保留为当前候选的未满足项，不能以夹具已采集样本或构建成功覆盖。三轮交替、每项三轮 100 个有效交互样本、C03 回顾发布、C04 健康 peer 完成和 C07 来源正文时刻仍未完成。

## 2026-10-06 Portable 证据轻量复核

本次只读复核针对原始 `dist/GoodBuddy-windows-x64/data`、保留的
`temp/goodbuddy-storage-upgrade/summary.json` 和当前仓库状态执行；没有启动 portable 原始目录，
没有复制或写入原始数据库，也没有提交。保留证据的成功运行时间仍为
`2026-10-05T12:03:32.624Z`，记录提交为 `4bb7573b10ecc46f746fbe04cf6b1e2c05647d1a`，
且记录的工作树为未提交状态。当前 HEAD 为
`edf019aaa728f094a433a2601d149d0ec9b28a21`，工作树仍有大量未提交修改，因此 portable 运行早于当前
源码状态，不能把它当作当前 HEAD 的运行结果。

保留验证器 `node tests/support/portable-storage-upgrade.mjs --verify-source` 本次未通过：
当前 `assistant.sqlite` 与保留基线的 SHA-256 和修改时间不同，当前 `knowledge.sqlite` 的修改时间不同，
且保留基线中的四个 0 字节 WAL 与四个 SHM 当前已不存在。当前四个主库的字节数仍分别与记录一致；
`conversation-attachments.sqlite` 和 `remote-runtime-bindings.sqlite` 的 SHA-256／修改时间仍一致，
`knowledge.sqlite` 的 SHA-256 仍一致。当前 `notes` 仍为 50 个文件、431,056 字节，内容指纹与保留证据一致。
因此原件相对本轮 portable 执行后的“当时未变”结论有后续漂移，不能宣称当前原始数据仍与 portable 运行基线完全相同。

对当前四个原始主库执行只读 SQLite `PRAGMA integrity_check` 均为 `ok`，`foreign_key_check` 均为 0 条，
版本分别为 Assistant 62、Knowledge 13、Attachments 1、Runtime Bindings 0。这只证明当前文件的轻量结构完整性，
不恢复 portable 运行与当前源码的一致性，也不替代一次新的隔离副本迁移验证。

清理复核确认 portable 验证使用的 `temp/goodbuddy-storage-upgrade/fresh-run`、`run` 目录均不存在，
保留目录中只有日志、JSON 结果和源基线等证据文件；进程命令行未发现 portable 数据目录、验证脚本或
`goodbuddy-storage-upgrade` 相关进程。机器上发现的已安装 GoodBuddy 进程使用独立用户数据目录，未计入本次
 portable 验证进程。上述结果只更新本实施记录，未修改原始目录或其他实现文件。

## 2026-10-06 简化与前后对照验收

### 简化

按“出现实测问题才加机制”复核并发修复期间新增的机制，删除以下实现（共约 400 行）：

| 删除项 | 原因 | 替代 |
| --- | --- | --- |
| 自定义分帧传输 `desktop-storage-wire.ts` | 同机实测原生 `utilityProcess.postMessage` 传 32 MB 文本 126–139 ms、5 万行 71–85 ms，Main 最大延迟在 16 ms 计时精度内；自定义分帧分别为 249–271 ms、448–496 ms | 原生结构化克隆 |
| 读／写／后台三类准入预算、交互保留槽 | 容量错误是“满了就拒绝”造成的，分类只是缓解 | 单一在途上限 32，超出按顺序等待，不再拒绝 |
| 同键读取合并、存储进程侧重复准入、整值读取串行 | 客户端已限流，宿主再做一遍没有新约束 | 删除 |
| 队列泵 `STORAGE_CAPACITY` 50 ms 重试 | 等待替代拒绝后不再出现容量错误 | 删除 |

另把存储进程启动移到建窗口之前，与窗口创建重叠。取消、提交后才确认、进程丢失时不重放、关闭前排空的语义不变；真实 Electron 存储夹具（含 16 MiB 视频、2,560 万字符历史）通过。

### 前后对照

基线为独立 worktree 的 `edf019aa`，候选为同一提交加当前工作树；同机交替运行，本地确定性模型，无外部请求。判定口径见[并发验收的发布门槛](./concurrent-desktop-acceptance.md#发布门槛与目标差距)。

| 场景 | 正确性门槛 | 对照结果（基线 → 候选，3 轮） |
| --- | --- | --- |
| 单会话 11 个场景 | — | 输入、切换、长会话打开、流式均在轮间波动内；Main 延迟 p99 在流式场景约 20.6 → 16.8 ms；启动至输入框可用中位数约慢 33 ms（1,300 → 1,333 ms），与轮间波动同量级 |
| C01（3／4／8） | 两版均 3/3 通过：全部排空、0 错误 | 排空耗时一致（约 37 s／17.5 s）；Main p99 约 21 → 16.7 ms |
| C02（4／8／16） | 两版完成的轮次均通过 | 排空耗时一致（约 23 s／53 s）；Main p99 约 22 → 16.7 ms |
| C03 混合读取 | 两版均无回顾结果可发布，标未满足 | 100 批重叠读取窗口约 1,010 → 912 ms；基线知识导入在该夹具中报错，候选无错误 |
| C04 故障隔离 | 两版均 3/3 通过：挂起请求取消结算，健康会话完成 | 取消观测约 135 → 101 ms，健康会话耗时一致 |
| C06 5 分钟生命周期 | 两版均通过 | 每轮排空耗时一致；4 轮后堆 18.2 → 17.8 MB；另有候选 30 分钟运行 21 轮全部排空、0 错误，堆每轮约增 0.3 MB，与每轮新增 8 条持久化会话一致，结束时驱动退出出错，未记为通过 |
| C07 冷／暖进入 | 无持久化来源，来源正文未测 | 冷进入各阶段 1–7 ms，两版一致；暖返回监督概览 38–45 → 25–38 ms |

旧版记录曾按产品子任务并发 3 判定 16 个子任务的测量；该数字没有用户设置或故障测量依据，已从生产默认配置移除。后续验收按实际 offered load 和实际运行数记录，不再用内部上限替代吞吐结果。夹具修正：排空等待改为 180 s（两版相同）、子任务按 `childTaskId` 统计、输入框焦点未就绪时重试输入。

结论：**正确性门槛在 C01／C02／C04／C06 两版都通过，候选在单会话和并发场景均未退化，Main 尾延迟有改善。** 剩余未满足项：C03 回顾发布与 C07 来源正文需要先有持久化回顾数据的夹具；C05 存储故障注入只有真实 Electron 存储夹具中的进程丢失、发送失败、取消覆盖，未做 App 级故障矩阵。输入 p95 约 8–9 ms，帧 p95 多数 8.5 ms，部分轮出现 16.5／58 ms，两版相同，记为目标差距。

### 真实数据与真实模型

portable 新副本（`--fresh`）当前源码复验通过：Assistant 库 175 万条事件、4,848 条消息，schema 62，所有已有表规范化摘要无变化，`integrity_check` 为 ok，外键违规 0；73 个附件、50 个笔记前后一致，原件 DB／WAL／SHM 指纹未变，副本已删除。100 批发布与读取重叠时，发布 p95 19 ms，夹具 Main 延迟 p99 16.4 ms。

真实模型输出分页首次走通：使用当前默认 `openai-responses` 配置，模型调用 1 次 `process_execute`、2 次 `output_read`，逐页游标连续至 EOF，恢复两个随机标记，**4 次外部请求**。之前两次失败的原因是该手动用例未注入输出正文存储（生产在 `index.ts` 注入），工具在模型分页前就报错；已改为注入与其他单测相同的文件存储。

### 全仓检查

`npm run typecheck`、`npm run lint` 通过。`npm test` 三次全量结果：1 失败（`workspace-import` 图片加载超时）、9 失败、1 失败（`local-runtime-reuse` 压缩返回 false），每次失败的用例不同，单独复跑均通过（`local-runtime-reuse` 3/3、`workspace-import` 4/4、其余 3 个文件 481/481）。判定为满载时的时序敏感用例，未放宽断言或超时，但不能记为全仓一次通过。

## 2026-10-06 有界真实模型复验

本节记录当前未提交源码的最终有界复验。没有启动 portable 原始数据目录，也没有把其中的会话、附件、笔记、日志或凭据发送给外部模型。所有发送给模型的监督输入均为脚本内合成内容；取消和输出分页场景也只使用脚本生成的短提示、临时工作区和随机标记。请求计数来自生产 Runtime 的 fetch 层或本地计数 relay，不记录请求正文、响应正文、请求头、端点或密钥。

| 路径 | 实际外部 HTTP 请求 | 结果 | 范围与边界 |
| --- | ---: | --- | --- |
| 生产存储宿主监督链 | 4 | 通过，4 次 HTTP 200 | `supervision-storage-live.cjs` 使用当前运行时设置读取凭据，在隔离 Electron、Assistant／Knowledge 存储宿主、生产监督工厂和 Heartbeat 入口中运行合成项目；故事、经验、建议发布成功，`no_change` 重跑新增 0 次，设置未改变，pending 为 0 |
| 生产监督审核工厂 | 2 | 通过，完成 | `supervision-audit-validation.ts live` 使用当前 `ModelAgentRuntime`、生产监督服务和隔离 SQLite；1 条合成消息完成提取与故事归属，重跑新增 0 次，SQLite 完整性与外键检查通过 |
| 直连 Runtime 取消 | 3 | 通过 | 现有 `cancelled-turn-live.test.ts` 的两个 direct-model 取消后续答复用本地计数 relay 执行；取消轮和后续请求均完成，取消内容没有并入下一轮，3 次请求均由 relay 计数 |
| 直连 Runtime 输出分页／工具请求 | 2 | 未通过覆盖断言 | 现有 `runtime-e2e.manual.test.ts` 的生产源测试到达模型两次，但模型没有发出 `process_execute` 或 `output_read`，因此没有证明真实模型工具请求和分页闭环；该次仅计入实际请求，不把失败运行写成通过 |
| 本地 OpenCode | 0 | 未执行 | 当前源码 checkout 没有 `.runtime-resources/win32-x64/opencode.exe`；没有改用已发布 portable 或其他缓存二进制 |
| 本地 Continue | 0 | 未执行 | 当前源码 checkout 没有 `node_modules/@continuedev/cli/dist/cn.js`；没有改用已发布包 |
| 共享 Linux Host | 0 | 未执行 | `192.168.0.23` 的 SSH 连接可达，但 BatchMode 连接在认证前由 Host 关闭；没有凭据交换或模型请求 |

本节合计观察到 **11 次** 外部模型 HTTP 请求：监督存储 4 次、监督审核 2 次、取消 3 次、输出分页失败尝试 2 次。没有重试被计入，也没有远程或 OpenCode／Continue 本地请求。监督链使用的运行时设置仅在隔离进程内解密，原设置字节保持不变。

验证结束后，隔离数据库、Electron profile、临时工作区、凭据副本、计数 relay 和生成的 probe 目录均已删除；进程检查没有发现属于这些运行的残留进程。该结果证明了当前源码的生产存储监督与直连取消路径，以及一次明确失败的真实模型工具分页尝试；不证明本地 OpenCode、Continue、远程 Linux Host、真实模型工具分页成功、完整桌面 UI、portable 数据副本或 C01–C07／A01–A10 验收已经完成。

## 2026-10-07 C03／C07 继续验收（当前 HEAD 1f85d0c0）

本次只修改了 `tests/support/app-perf-concurrent.mjs`、`tests/support/app-perf-driver.mjs` 和 `build/run-app-perf.cjs` 的验收夹具。运行目录为 `temp/goodbuddy-acceptance-continue/`，使用 `npm run build:bundle` 生成当前源码开发构建；每次运行都由 `build/run-app-perf.cjs` 启动隔离 Electron profile、存储 utility process 和 127.0.0.1 回环确定性模型。模型请求总数分别保留在原始 JSON 中，均为回环请求，未发送外部模型请求。

### C03 混合存储

命令为 `GB_PERF_MODE=C03 node build/run-app-perf.cjs`，最终证据为 `temp/goodbuddy-acceptance-continue/C03-final4/result.json`。夹具先通过生产 `conversations.saveLocal` IPC 保存 99 个会话、每个 20 条消息，再通过生产 `knowledge.createLibrary` 和 `knowledge.importPaths` 导入知识源；监督页通过真实导航和“回顾”按钮启动生产 `supervision.run`，确定性模型走生产 Runtime 流式接口。回顾提交完成后，结果通过生产 overview、activity 和 batches IPC 读取，首批分页返回的每组证据数为 20，提交进度为 100 批。

生产重叠窗口包含 100 次历史读取、100 次 Knowledge search 和 100 次监督 overview，Knowledge 导入耗时 7,190.102 ms，重叠窗口 6,701.095 ms。结果 `status=measured`，运行器最终状态为 `passed`；没有使用直接 SQL 写入或预置 review 表。C03 的通过条件仅断言回顾结果存在、100 批提交、抽取分页每批 20 条证据、导入已执行以及三类生产读取各 100 次并发生在导入窗口内。

### C07 冷热进入

命令为 `GB_PERF_MODE=C07 node build/run-app-perf.cjs`，最终证据为 `temp/goodbuddy-acceptance-continue/C07-passed/result.json`。冷进入和暖返回分别测量输入框、历史、监督概览、图谱和 Knowledge snapshot 的可用时刻；随后通过生产监督页触发一次确定性回顾，刷新监督页并打开图谱事件。夹具点击真实图谱事件的来源链接，等待 `.supervisor-workspace__source pre` 出现并读取其 DOM 文本长度；本次 `textLength=51`、`rendered=true`，因此来源正文是 UI 内容可用证据，不是 API 返回时间的替代。

两次运行均为 Windows x64、Electron 44.5.1、当前源码 dirty worktree，外部模型请求为 0。C03／C07 的测量状态通过；其余并发矩阵、三轮交替对照、C05 故障注入、完整预算判定和 A01–A10 仍按上文状态保留未完成，不能由本节扩展为 PERF-15／PERF-16 全项通过。
