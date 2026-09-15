# 工作栏实现与验证进度

## 2026-09-15 Desktop 0.13.6 发布准备

用户批准两项性能修复的中英文更新说明，指定 Desktop 0.13.6，不发布 Agent 或
LoongArch 预览，并明确排除工作区另外四个应用导航设计／演示文件。
`package.json` 与 lockfile 的两处根版本一致，更新说明校验通过。
双语功能矩阵已核对并补充按需历史行为；Agent 保持 0.13.0。

用户随后要求直接交由 CI 发布，本地独立候选的全量验收命令被取消，未记为通过；
开发阶段的完整测试及实测结果保留在下一节。候选发布不再进行本地生产构建或
打包，主分支 CI 与六平台标签工作流仍为发布验收入口。最终提交、标签与公开
产物状态须以远端实际结果核对，不以版本号变更视为已发布。

## 2026-09-15 会话列表与图片合并性能修复

本轮针对用户报告的 0.13.5 卡顿与高内存，不修改正在运行的正式应用或数据库。
只读检查发现最近会话正文约 1.14 MiB，消息 metadata 约 119.3 MiB；`f8d0741`
的图片合并还会重建无变化消息，使焦点刷新后再次保存历史。实现规则见
[会话列表读取与前端保留](./execution-history-storage.md#会话列表读取与前端保留)。

已实现并验证：

- 图片合并的三个分支共用保留引用的函数。1,600 条无图片历史引用不变；App 使用
  JSON 往返形状刷新后，保存的消息数为 0，较新的图片操作、成果关联和流式正文仍保留。
- 启动、焦点／队列刷新、活动跳转与自定义任务入口均使用摘要或按 ID 读取。
  搜索保留中文、Unicode 大小写和字面 `%_` 匹配，包含仍显示但已落到最近 100 条以外的
  会话；真实 SQLite 中 501 条历史仍可完整取回，header-only 保存不删除消息。
- 打开、复制、导出、发送及压缩上下文保留完整历史语义。详情读取失败可原地重试；
  旧摘要不能覆盖晚到的后台审批或刚加载的历史。搜索只保存命中 ID，复制／导出不把
  未打开详情留入缓存，空闲详情在已确认保存后随现有 KeepAlive 生命周期释放。
- 三路 simplify 审查覆盖全部本轮源码，修正了两处残留全量读取、搜索保留大对象、
  较早会话搜索遗漏及后台审批竞态。保留已发布完整列表接口，无 schema／Agent 协议迁移。
- 定向 App、SQLite、IPC／恢复及图片合并测试：**443 通过**。最终 `npm test`：
  **4,301 通过、67 跳过、0 失败**，约 736.46 秒。`npm run typecheck` 和所有本轮
  源码文件的 ESLint 通过。全仓 `npm run lint` 仍被本轮范围外的
  `application-tool-navigation/navigation-demo.js:360` 的 `no-unused-expressions`
  阻塞，未修改该用户编辑；不能记为全仓 lint 通过。
- 以 `f47049c40d757a38296d06d281b87fb6a5fe1c8c` 和本轮 14 个源码／测试文件冻结
  before／after，两个生产 Electron 构建均成功；验证后哈希核对无源码漂移。
- 隔离生产 Electron 的 100 会话／1,600 消息试验：首次摘要读取 0 条消息，仅当前会话
  详情读取 16 条；搜索第 100 个会话的正文不预载其 metadata，点击后再读取完整 16 条。
  已检查实际 UI 截图，不是只调用数据库或 Mock。
- 另一个隔离 App 正常 UI 打开未加载的旧会话并发送，Main 请求携带原有 2 条历史；
  **1 次真实直连文本调用**，HTTP 200，最终完整保存准确标记 `HISTORY_RENDERER_7391`。
  初始等待使用错误 DOM class 超时，随后以保存结果核对成功，未重复发送。
- Linux x64 共享 Host 在本轮独立目录构建、安装并激活当前源码 Agent／OpenCode，
  真实 SQLite 摘要测试通过；**2 次真实无工具文本调用**均完成且 delivered=1，
  第二轮复用同一原生 Session 并准确记住首轮标记。测试 Agent 停止后独立 `/proc`
  检查无该目录所属进程。此检查验证当前源码部署与 Session 续接，不冒充远端 UI
  断线恢复全流程；桌面恢复问题投影由本轮真实 SQLite IPC 回归覆盖。

本轮真实模型调用共 **3 次文本、0 次图片**，无工具请求，不新增图片生成费用。
准备阶段的错误 fixture provider／图片默认字段、独立 profile 缺少原安全存储的
加密上下文、Host 源码包漏带 LICENSE 均只修验证脚本；失败记录保留，不计为产品修复。
所有脚本与原始证据位于忽略目录
`.agent-resources/conversation-performance-20260915/run-KX7bIz/`。

### 完整 App 配对内存测量

最终采用三组顺序执行的 before／after 冷启动，共六个独立 profile。每组使用相同
100 会话／1,600 消息，正文 1.20 MiB、完整 reasoning metadata 119.69 MiB；
执行三次焦点刷新、搜索未打开正文并导航 11 次。使用直连 Runtime 的无网络配置，
不启动 OC／DSH、不调用模型；测试与构建已完成后再开始这组测量。

下表是各三次结果的中位数，内存为 Windows Private Commit，单位 MiB：

| 指标 | before | after |
| --- | ---: | ---: |
| 初次传入 Renderer 的完整消息数 | 1,600 | 16 |
| 三次无变化刷新保存的消息数 | 4,800 | 0 |
| Main 焦点列表读取耗时（ms，不是端到端帧延迟） | 207.28 | 8.05 |
| 启动稳定点 App / Renderer | 803.42 / 284.77 | 682.36 / 155.73 |
| 三次刷新后 App / Renderer | 1,640.43 / 703.91 | 661.34 / 154.16 |
| 导航及缓存释放后 App / Renderer | 895.27 / 557.09 | 574.65 / 248.95 |
| App 采样峰值 | 1,788.71 | 694.35 |

每次 10 个进程样本，定时器间隔 5 秒，另有阶段采样，不代表连续峰值。
本数据集采样峰值中位数下降 **61.18%**；before 三次峰值分别为
2,506.29 / 1,788.71 / 1,766.39，after 为 694.35 / 693.61 / 719.27。
它测的是这两项历史读取／重复保存修复，不含重型 Runtime 的原生内存，不能推广为
正式用户整个 App 必然下降相同比例，也不是长时间空闲泄漏证明。

六个最终 profile 都保留 1,600 条消息，按 ID／角色／状态／正文／完整 reasoning
计算的 SHA-256 一致，`quick_check` 均通过；六个 App 均正常退出（code 0）。
汇总见 `summary.json`，单轮为 `before-2` 至 `after-4` 的 report／acceptance。

保留但不纳入三组对照的早期 `before-1`／`after-1`：after 的驱动在清除搜索后未等待
延迟筛选收敛，导航失败；退出时还记录 `PostQueuedCompletionStatus` 无效句柄。
后续为两个版本都补上可见列表等待，并等本轮采样子进程完成后再正常退出；
未唯一定位早期退出错误，也未据此修改产品代码。最终六轮完成后的监督脚本仍因
向已退出 CDP 调用 browser close 返回错误；随后不附带 CDP 独立关闭命名浏览器成功。
OS 按本轮目录核对无遗留 Electron／Node 进程，原始失败日志未覆盖。

文档检查覆盖本轮六份文档、81 个相对文件链接，无缺失；未逐一校验所有历史锚点。
修改未提交、未推送、未发布。

## 2026-09-15 Runtime 执行清单设计（未实现）

对应 FR-CL1–FR-CL4。用户本轮明确只完善设计与进展文档，不改代码；
[设计与验收](./runtime-checklist-technical-design.md)不代表功能已经接入或发布。

此前调研已通过真实模型完成以下本地测试；本次文档更新未重新运行测试：

| Runtime | 已确认的本地研究结果 | 调用口径 |
| --- | --- | --- |
| OC 1.18.29 | `todo.updated` 与 `session.todo` 为 `content/status/priority` 完整替换，无 item ID | 3 个真实模型轮次 |
| CN 1.5.47 | `Checklist.checklist` 为 Markdown `- [ ]` / `- [x]` 完整替换，成功后才提交 | 3 次真实 HTTP 调用 |
| DS | 真实默认环境无 todo/plan；本次不加工具 | 1 次真实模型 HTTP 调用，返回 200 |

上述口径不合并计算为同一种调用次数，也不算 GoodBuddy 顶部清单端到端通过。本轮新增
模型调用为 0，未运行代码测试或远程部署验证。

本轮只读源码检查确认 OC 普通工具输入及 CN 宿主工具输入存在 4,000 字符截断；
Agent 已传递带 Session、binding/operation 归属的通知，桌面已有 ACP plan/tool 消费，
但 plan entries 当前降为状态文本。这些链路可供设计复用，尚未验证清单端到端接入。

| 部署 | 已有能力与本功能可用程度 | 剩余工作 |
| --- | --- | --- |
| 本地 OC/CN | 原生清单格式已有上述实测结论；顶部清单未实现 | CL-P1、CL-P2、CL-P4 待实施及验证 |
| 远程 OC | 已有托管 Agent 安装与请求路径，其历史验证见远程文档；本功能没有远程实测 | 原生 entries/tool 格式、完整传递及 CL-P3、CL-P4 待验证 |
| 远程 CN | 当前受管安装、项目校验与 Runtime 创建只支持 OC，不能声明 CN 已可部署使用 | CL-P3 需补齐 CN 真实部署路径，再验收 CL-P4；当前本功能未验证 |

未决技术点：远程 OC/CN 实际发送的原生清单格式与等价性、CN 原生清空表示及 Markdown
接受规则、现有消息/事件字段的最小扩展位置、CN 受管工件与启动/模型桥接入方式。
产品范围与隔离规则已明确，不因这些待办缩减远程 CN 范围或增加 DS 工具、plan 模式与
文档功能。共享 Linux Host 的清单及重连验收全部待验证。

文档检查：已按 `deai-writing` 审校新增内容；新技术设计扫描为 0 个阻断项、12 个复核项，
复核项为必要的实现边界和验收枚举，按原意保留。新增相对链接与章节锚点已人工核对。
`git diff --check` 通过，仅输出工作区 LF/CRLF 提示；未修改本轮范围外的既有改动。

## 2026-09-14 Runtime 进程复用（实施中）

对应 FR-RR1–FR-RR6，设计及完整验收清单见
[Runtime 进程复用技术设计](./runtime-process-reuse-technical-design.md)。
用户已授权实施，本次复用改动尚未整体提交或发布，不包含在正式 Desktop 0.13.2 /
Agent 0.11.25 中。最终验证结果见本节末尾，早期失败及中间状态按时间保留。

- P0–P2：Main 已组合 `LocalRuntimeRegistry`，OpenCode Server 和 DSH Utility 按兼容
  配置共享，工作区通过轻量适配器传入 Session。无会话 owner 空闲 60 秒回收；
  适配器淘汰不结束其他会话。DSH 被动状态不再启动 Host，取消超时先释放目标 Session，
  同时回收对应 Main 工具资源；配置替换期间的原生问题继续交给原请求的 Runtime。
- 首轮 Windows 完整 UI 使用当时构建的生产 Main/Preload/Renderer 和隔离 profile，
  OpenCode、DSH 各两个项目、四个并行会话，通过输入区和发送按钮完成实际开发。
  OpenCode 工具数为 7、7、6、8；DSH 为 9、13、11、11。独立运行各项目测试合计
  60 项通过。两类 Runtime 分别共用一个重型进程，本轮未使用原生子代理。
- 首轮 UI 提供方请求共 55 次 HTTP 200：OpenCode 23、DSH 32。其中包含驱动选择器
  失误引发的一条额外默认项目 Ask，工具为 0，不把它计为开发任务验收。
  同轮 OpenCode 单进程 Private Commit 约 882.88 MiB，工作集约 629.51 MiB；
  Electron 自身指标另存，不将两者混为整个 App 的测量结论。后续重复运行和空闲
  证据见下文，不把这一单点与正式用户库直接比较。
- P3：生产 Agent 已接入单 ACP decoder/握手、Session → binding/operation 路由、
  逐 operation Unix 模型桥及空闲回收。共享 stdio 与 Prompt 输入/期限分离；
  Session 取消结算可如实保留 `processTree: running`。未增加持久进程池账本。
- 共享 Linux x64 Host 已通过现有加密凭据与固定 Host identity 连接。使用当前源码、
  固定 Node 24.19.0 / OpenCode 1.18.29 构建隔离测试包，走真实 prepare/commit、
  activate、attach 和 Agent-owned Prompt，不改写已有 Host 安装。
- Linux 首轮五条 Prompt 共 22 次已完成且已交付模型调用；两个 Execute 分别在正确
  项目完成修改，各通过 8 项测试，四个会话只启动一个原生进程。但 Ask 的搜索被原
  `kind === read` 规则误拒，原生子代理工具因权限请求未转发而等待，首轮验收失败。
  修正采用原生 Session 工具规则；原生子代理只继承父拒绝规则、不继承允许规则这一点
  已按固定版本源码核实，子 Session 同样设置当前模式，并保留原生显式限制。
- 下一轮测试脚本在 transcript 尚有分页时按已完成状态提前结束，误报缺少项目 marker，
  随后 cleanup 中止了其他三个请求。这是验证驱动缺陷，产品自身已有 `hasMore` 处理；
  驱动已修正为读完全部分页、等待全部并行结果。该轮共 14 次 dispatch，
  其中 11 次完成、3 次结果不确定，失败记录保留，不将其计为通过。
- 重复测试包构建曾遇到 Host ENOSPC。只清理本轮已确认可重建的 bundle、Runtime
  staging 和重复 `.gbagent`，保留测试 home、workspace、SQLite 及报告，继续验证。
- 后续两轮 Linux 各 7 条 Prompt、35/34 次 dispatch，四个 Ask/Execute 与原生子代理
  续接均通过，分别取得 483/467 条子会话事件；取消没有关闭共享 owner。重连驱动先后
  漏发 `controller/resume`、错读 `agent/capabilities.generation`，导致两次后续验收
  失败；均已修正，保留失败报告。35 次调用一轮包含 1 次结果不确定，34 次一轮全部完成。
- 最终当前源码 Linux 生命周期复验：2 条 Prompt、5 次完成且已交付调用，共享一个
  owner。目标返回 `cancelled / processTree: running`；另一会话跨真实 SSH 断线、
  controller resume 和重新 attach 继续执行，3 个工具返回正确项目 marker。
  全部 binding 释放后等待 65 秒，owner 数为 0；停止隔离 Agent 后仍为 0。
- 原生 Compact 单独复验：两项目各先完成 3 工具请求，再并行压缩原生 Session。
  两次压缩分别归到各自的新 operation，各 1 次已交付调用，前后为同一个 owner；
  总计 4 条 Prompt、8 次完成且已交付调用。释放会话并等待 65 秒后 owner 为 0，
  Agent 停止后仍为 0。该结果没有用普通聊天返回“已压缩”代替原生 Compact。
- 第二轮 Windows 完整 UI 重开同一隔离 profile，四项目八条续接开发请求全部完成，
  OpenCode 包含原生子代理，DSH 使用已有原生工具。独立项目测试合计 77 项通过。
  两个 Runtime 仍各一个重型进程。另有四条实际慢工具请求：前两条 30 秒测试在点击
  停止前已结束，不作为取消通过；后两条 120 秒测试中目标被正常 Stop 取消，另一项目
  的测试继续完成，DSH PID 未变化。第二个 App 共 12 条任务，11 完成、1 取消；
  100 次 HTTP 200（OpenCode 24、DSH 76），无失败请求。
- 第二轮任务结束后的 631.573 秒采样共 121 点，提供方请求计数始终为 100，
  DB 始终 2,928,640 字节、WAL 始终 4,268,352 字节。期间查看了项目和截图，属于
  **无新任务/模型请求**，不是完全无人操作的 UI。原生 Session 有意保留，不要求其
  Runtime 退出；首个 App 自行退出时的进程消失不计为空闲计时验收。

| 进程 | Private Commit 起止（MiB） | 范围（MiB） | 区间 CPU 秒 |
| --- | ---: | ---: | ---: |
| OpenCode | 826.34 → 825.05 | 824.36–830.82 | 12.03125 |
| DSH Utility | 98.73 → 98.73 | 98.73–98.73 | 0 |
| Main | 184.16 → 185.05 | 182.90–186.77 | 0.953125 |
| Renderer | 142.80 → 136.22 | 135.00–142.80 | 0.6875 |
| GPU | 120.48 → 138.88 | 120.48–173.52 | 0.0625 |

Private Commit 不是独占物理内存，工作集相加会重复计算共享页。这组测量未发现两个
Runtime 在该空闲区间持续增长，但不是整个 App 无泄漏证明，也不是旧新版本对照。

- 当前 Linux 六个 ACP/bridge/owner 测试文件为 82 通过、0 跳过，包含 Windows 跳过的
  Unix broker 并发及旧路由排队拒绝回归。本机完整回归曾为 4,170 通过、67 跳过；
  首轮唯一失败来自旧测试把 `failed + running` 当成非法，修正后仍保留 `unknown`
  的拒绝断言，并新增共享失败/取消接受用例。
- 标准 `typecheck` 原先没有把部分 Agent 源码作为检查入口。已增加
  `tsconfig.agent.json`，并修正暴露的 ACP resume capability、spawn stdio 及几个局部
  类型问题；扩展类型检查、26 项受影响 Agent 回归及 lint 通过，之后已再次进行上述
  当前源码 Host 生命周期与压缩验证。
- 三个只读审查分别检查复用、质量/兼容来源和效率。修复了被动状态刷新不断重置
  60 秒空闲计时的问题；状态检查不取得执行 owner，Native Session 映射成为唯一会话
  保留依据，不再另存重复 conversation Set。最后本机定向回归 98 通过、3 跳过，
  含真实 OpenCode 与 DSH ACP 组合；扩展类型检查通过。该补修仅涉及本机 registry，
  不改变 Agent/远程路径。当时全量 `npm test` 为 **4,171 通过、67 跳过、0 失败**
  （356 文件通过、9 跳过，609.57 秒）；`npm run typecheck`、`npm run lint`、
  `npm run build` 均通过。构建仍报告既有 chunk 大小/混合导入警告，不影响成功结果。
- 保留 exclusive raw ACP 是已有公开字节流路径，不是为本分支中间形态保留的兼容层。
  新的共享取消/失败结果需要配套 Desktop/Agent，不声称旧 Desktop 已支持新结果。
  原生插件两处祖先遍历可局部提取，但没有已证实故障或性能收益，本次不为此扩展改动。
- 本轮真实模型调用合计 **273 次**：本机两轮 UI 155 次，Linux 六轮
  **118 次 dispatch**（29 条 Prompt，114 次完成、4 次结果不确定）。
  包含所有失败轮次和误发默认 Ask，不重复计算最新报告别名；本机 HTTP 200 不等于
  Agent ledger 的完整交付证明。原生确定性协议测试不计入真实提供方调用。

补充的 owner 成本对照使用同一当前源码、同一 Windows 机器、全新空工作区，分别经
生产 factory 创建两个独占实例或两个共享适配器。每种组合重复 3 轮，每轮显式连接后
再做 5 次双工作区连接检查；共启动 18 个真实 OpenCode/DSH Utility，全部退出，
**真实模型和本机合成模型请求均为 0**。测量前全量测试已结束，没有同时运行测试套件。

| Runtime / owner 方式 | 进程数 | Private Commit 中位数及范围（MiB） | 双工作区首次 ready 中位数及范围（ms） |
| --- | ---: | ---: | ---: |
| OpenCode 两个独占实例 | 2 | 1,401.17（1,396.15–1,517.91） | 1,195.00（1,184.14–1,213.49） |
| OpenCode 一个共享 owner | 1 | 777.59（667.04–802.78） | 1,135.71（1,130.32–1,140.81） |
| DSH 两个独占实例 | 2 | 171.62（170.79–173.50） | 167.06（163.36–167.78） |
| DSH 一个共享 owner | 1 | 86.64（86.18–87.29） | 155.31（155.28–157.79） |

这是**进程所有权方式**的对照，不是旧版 App 对新版 App、等规模历史或真实开发负载
对照；没有测模型首字节。DSH 后续连接检查读取已缓存握手，不能当作热 Prompt 延迟。
最后一个共享 DSH 在无 Session 时每 5 秒读取状态，持续 65 秒，原 Host 已退出且没有
重启，证明状态轮询不会续期空闲 owner。探针早期的类型及 CJS/ESM 打包错误均发生在
模型调用前；改为正确 ESM 依赖解析并加入启动前语法检查后完成测量，未修改产品以适应驱动。

清理时，完整 UI 的“关闭窗口”按现有产品行为隐藏到托盘，并不退出 App。随后只对已无
活动任务且重新核对启动命令的隔离 App 进程树进行清理；这不作为正常托盘退出验收。
命名浏览器会话已关闭，本机按本轮启动路径筛选的进程数为 0。最终通过固定身份 SSH
只读核对本轮 Linux 路径下的 `/proc` 进程和各测试安装 owner 数据库，两者均为 0；
保留测试 profile、工作区、数据库和报告，未删除用户历史或停止用户 Runtime。

此时尚未完成的完整 UI、十项目和问答恢复验收，后续结果见以下继续验收记录。
旧新版本全 App 对照、完整共享能力组合及 Continue/直连资源分解仍需独立完成，
不能将 P0–P4/V1–V8 整体标为完成。

本机证据位于忽略目录 `.agent-resources/runtime-reuse-implementation-20260914/`，
包括 UI 聚合指标、截图、Host 聚合报告及保留的失败轮次。这些不是 checkout 自带资产，
不包含可提交的模型或 SSH 凭据。

### 继续验收：远端完整 UI 与模式切换

- 用户要求继续后，已从完整生产 Electron UI 启用远程项目、保存两个 SSH 项目并在
  各项目创建两条会话。仅在测试 SSH 命令入口将 `HOME` 指向既有隔离安装；项目保存、
  Host/Agent/Runtime 发现、Main Runtime factory、传输、协议、模型和工具均保持生产实现，
  未伪造 capability、Prompt、事件或权限结果。
- 四条正常开发任务均完成，共用一个原生 owner。分别在各自工作区实现 words/prices，
  独立运行两项目测试为 12 + 13 = **25 项通过**。实际重叠峰值为 2 条请求，
  不是四条同时运行；四个会话完成后，共享的原生 owner 仍然存活。
- 新增真实模型调用 **21 次**，分别为 5、5、5、6，均 completed 且已交付。
  与上一段 273 次相加，累计 **294 次**；没有把旧 Agent ledger 的 13 次基线重复计入。
- 随后在原价格会话中从 Execute 切到 Ask 并发送原生业务问答请求，实际失败，UI
  显示“没有可安全附加的远端 Agent 请求，且恢复不会重放任务”。Agent 仍把 workMode
  固定在 binding 首次启动值，拒绝新模式；此次在模型 dispatch 前失败，新增调用为 0。
  此问题不能由先前“不同 binding 使用不同模式”的通过结果排除。
- 当前修正只允许共享 Session 的后续准备变更模式，独占进程仍保持原契约；
  `AgentOwnedAcpPrompt.start` 显式接收当前请求模式，原生 Session 路由与 ACP 备用权限
  决策均使用该模式，不再捕获构造时模式。48 项定向回归和扩展类型检查、lint 通过，
  包含 Execute → Ask → Execute 保留 Session 与原生父/子问答。
  后续当前源码 Linux 包和完整 UI 复验已通过，见下一节；48 项是当时的定向结果，
  不是后续全部修正后的全量结果。
- 首轮 UI 通过正常 `app.quit()` 进入生产退出清理，本机测试进程退出；
  隔离 Agent 随后按 installation identity 停止，`/proc` 与 owner 数据库均为 0。
  首轮报告、失败任务和工作区保留。再次构建前 Host 仅余约 251 MiB，已明确限定只回收
  更早停止的测试安装软件及重复测试包，不清理状态、历史或工作区。

### 继续验收：断线、取消、模式续接与 Desktop 重启

- 四个原生问题同时等待时切断实际 SSH，复现“ACP channel does not exist”，继而出现
  重复注册 binary channel。诊断确认 Agent-owned Prompt 可能没有 raw ACP journal 行，
  replay 却对不存在的行 ACK 0。修正只在已有 raw cursor 时确认 journal，不放宽正序号、
  channel/epoch 或 installation 检查。真实临时 SQLite 回归先失败再通过；94 项后端/
  journal/channel 测试、当前源码 Linux 六文件 86 项通过，失败报告保留。
- 保留旧 Desktop profile 并更换隔离 Agent 后，旧安装的恢复曾无限重试阻塞项目。
  attach-only 路径现在在打开 channel 前明确报告安装身份不匹配，不重放 Prompt。
  同一 Agent 的新连接则保留 Runtime，对已有 binding 旋转 transport generation，
  新 channel 使用实际连接 generation；不同 daemon 或倒退身份仍按原规则拒绝/替换。
- 完整生产 Electron UI 再次同时等待四个问题，实际断线重连后原表单和 Session 均保留，
  没有新增模型调用或 owner。四会话尚在等待时，第五个新 Session 可以执行文件读写；
  该 Session 的 Execute → Ask → Execute 三轮均完成，各 2 个工具、3 次模型调用，
  验证实际写入、只读读取、再次写入，不以模型自述代替文件结果。
- 取消一个 120 秒原生命令时，其余三个待答会话仍可各自回答并完成。取消后立即在原
  对话显式发送新请求也完成，使用新的原生 Session，仍共用原 owner。已确认取消通过
  专用错误进入终态；未确认的 Stop 保留原恢复逻辑，不把网络中断等同于取消成功。
  曾出现 Task 已取消但 assistant message 仍 streaming，改用既有数据库终态事务
  同时更新消息、任务和终态事件。最终真实 UI、Desktop SQLite、Agent 状态一致，
  streaming message 和 active Task 均为 0，共享进程未被误杀。
- Desktop 重启前的首次尝试因测试观察 SSH 挂起，实际上未退出，已明确作废该证据。
  驱动加有界观察超时和 `finally` 退出后，真实重启复现两个缺陷：live question 没有
  transcript provenance 却被当作持久事件拒绝；同项目串行恢复让第二个待答 Session
  无法附加。现由 Main 并行恢复任务，live question 使用已有待答 Map 和活动请求租约，
  只投影到实时会话快照，不伪造 provenance，不写新的问题日志。
- 修正后的真实正常退出/重开恢复两个同时待答的 Session，后一个先回答并完成，
  前一个独立 Stop。两端终态分别 completed/cancelled，UI 无残留活动或恢复提示，
  仍为同一个原生 owner。到该轮累计真实提供方调用 **348 次**：
  273 + 首轮远端 UI 21 + 旧隔离安装诊断 6 + 当前隔离安装 48。
  48 次全部完成并交付；更早 273 次中的 4 次不确定仍保留，Prompt 取消不等同于
  模型调用交付不确定。后续审查复验的增量另记，不覆盖这一时间点。
- 重启修正后的全量回归为 **4,186 通过、67 跳过、1 失败**，唯一失败是
  `ActivityPanel` 的 501 条历史显示测试；该文件单独重跑 **16 项全通过**。
  不将单文件重跑写成全量通过，原全量报告保留。此前 4,171 通过的报告早于这些修正。

### 继续验收：共享能力与配置退役审查

- OpenCode 生产 factory、真实二进制测试覆盖 2/10 项目，每项目两 Session、两轮原生
  文件读取并逐项目原生 Compact，manager 容量设为 1，仍只启动一个 Server。
  DSH 实际 Host/ACP composition 同样覆盖 2/10 项目、每项目两 Session、两轮原生
  文件读写和平台 Shell，一个 Host。二者使用确定性模型，新增真实提供方调用为 0；
  这是原生组合测试，不是十项目完整 Electron 性能测试。
- DSH 补充双项目共享组合：原生 Skill、实际 stdio MCP、Host 插件清单、不同尺寸的
  inline 图片和 Execute → Ask 均通过。两项目使用不同 Main ToolProvider 和正确的
  conversation context，Ask 不调用先前 MCP，图片原始字节分别匹配。该文件当前
  **9 通过、3 跳过**；Host 在测试进程内实际运行，不能表述为完整 Utility/UI 能力矩阵。
- 完整 61 文件复查分别检查复用、质量/兼容来源和效率。没有新增仅服务分支中间形态的
  兼容层；raw ACP 独占和 Continue 单请求 Host 保留其已有契约。
  复查发现重启后的回答/跳过未保存到 remote-authoritative assistant message，以及
  manager reset 后旧 controller 拒绝所属问题的回答。修正复用原消息 `answeredQuestions`
  metadata 和既有 question owner，不新增 schema、恢复日志或重复历史。
- 真实 UI 复验又确认设置保存入口仍主动取消全部请求，不能以 controller 单测通过
  宣称生产配置切换完整。Runtime 设置、原生定制和能力更新现在只激活/退役配置，
  不批量 abort 或清除待答确认；已接受请求继续使用原配置。用户 Stop、清除数据和
  App 退出的原有取消/分离规则不变。真实 SQLite 的三入口回归覆盖并行恢复、反序回答、
  跳过、重新打开答案和终态；manager reset 回归覆盖旧问题可回答、新工作仍拒绝。
  最新 **152 项 IPC/controller/manager 测试、typecheck、lint 和生产构建通过**；
  这次补修的最终真实 UI 复验及全量回归仍在进行。
- 后续真实 UI 的设置保存不再取消原生待答 Prompt；一次连接 readiness 超时后，
  重新启动 Desktop 附加同一请求并回答 `KeepYes`，原 owner 未更换，任务 completed，
  原消息的 `answeredQuestions` 已落库。再一次正常退出/重开后，“问题与回答”仍显示
  正确答案和完成状态，截图已检查。该时点累计真实调用 **352 次**，相对 348 新增
  当前 Agent 3 次及误选默认项目的本机 Ask 1 次；后者未使用问题工具，不计问答验收。
  当前 Agent ledger 共 51 次，均 completed 且已交付。正常退出 Desktop 后按已核对的
  隔离 installation 停止 Agent，所属 `/proc` 进程和 active owner 记录均为 0。
- 复查设置更新的专家团队分支发现，既有调度器会取消剩余专家，但父请求可能用替换后的
  模型继续综合。仅对活动团队父请求保留配置替换取消，普通原生请求不受影响；
  **156 项 IPC/controller/manager/SubagentService 回归通过**。此分支属于 Main 专家
  调度，不是 Agent 原生子代理；远端普通 Prompt 的 `teamMode` 为 false，先前验证的
  SSH 问答路径不改变。
- 工作区随后出现其他任务的新提交和 Magic Notes API 修改。整仓类型检查曾因其
  `DesktopApi.magicNotes.onChanged` 与 App 测试 mock 不匹配失败，没有覆盖这些并行
  改动。冻结 candidate 的 typecheck、lint、生产构建通过，前后性能对照
  使用该隔离源码，不滚入后来的功能变更；其已带入的按钮位置调整见下节范围说明。
- 随后完成 baseline/candidate 两个独立生产构建、相同 seed 历史、三次冷启动及
  无新任务十分钟的全 App 对照，结果见下节。驱动校准失败不计性能样本，
  测量期间未并发全量测试；既有 owner-only 数据不替代此结果。

### 2026-09-15：前后完整 App 对照与剩余 Runtime 检查

对照基线为 `de14a6157a6c34f1e3ef22619eca374a50a83706`。通过隔离源码构建 baseline
和包含本任务改动的 candidate，使用同一 Windows 机器、同一依赖、同一 seed
SQLite（四项目、八会话、320 条等量历史消息）和相同工作区 marker。后续其他工作区
提交不滚入该冻结对照；这里的冷启动是新的 App/profile/Runtime 进程，不清 OS 文件缓存。

截图及源码复核发现，candidate 的 `App.tsx` 同时带入了 `fbba2e3` 的工作栏按钮
移到主题切换按钮旁的调整。用户明确要求保留，工作区及冻结 candidate 均未剔除，
也不为此补跑。以下结果是**包含该 UI 差异的完整 App 实测对照**，不是严格的
纯 Runtime 单变量实验；此前“只含本任务改动”的范围描述不准确，现予以更正。

- 每组 3 次冷启动，各 55 条请求、110 次确定性 loopback 模型请求。每次冷启动包含
  八会话一轮工具请求和五条热请求，最后一次另加两轮八会话续接。每轮等待八个真实
  Native Prompt 同时到达提供方再释放响应，随后实际原生 `read` 读取各项目 marker。
  全部目录结果正确，无全局 Prompt 串行化。该对照新增真实提供方调用为 **0**；
  自然开发、写入、Shell 和真实模型验收仍以前文证据为准。
- baseline 稳态为 3 个 OpenCode Server、2 个 DSH Host；三轮分别累计启动 3/3/3 个
  OpenCode 和 4/4/6 个 DSH（包含被动状态临时 Host）。candidate 每轮只启动一个
  OpenCode、一个 DSH；六次 App 正常退出后，本次登记的全部 Runtime 进程均退出。
- 早期驱动的必填模型字段、Windows 子进程继承输出管道、Runtime 未就绪时点击以及
  读到半份 JSON 报告导致的失败均保留，不纳入以下样本。最终报告原子替换，发送前等待
  实际启用状态并核对 Main 已接收请求；不重放失败/不确定的真实模型请求。

| 指标 | baseline，中位数（范围） | candidate，中位数（范围） | 样本口径 |
| --- | ---: | ---: | --- |
| 全 App 采样峰值 Private Commit，MiB | 3,543.18（3,485.58–3,589.01） | 2,040.11（1,698.68–2,085.82） | 每组 3 个 App，分别取采样峰值 |
| Runtime 采样峰值 Private Commit，MiB | 2,843.18（2,831.00–2,854.82） | 1,338.93（1,229.31–1,347.63） | 同上，仅 Runtime 进程 |
| bootstrap 到首个模型请求到达，ms | 4,519（4,464–4,529） | 3,573（3,519–4,040） | 每组 3 次，包含 UI 启动与操作，不是独立握手计时 |
| OpenCode 热请求总时长，ms | 225（198–286） | 200（187–308） | 每组 9 次 |
| OpenCode 首个可见事件，ms | 139（118–201） | 124（102–187） | 文本/推理/工具任一事件，不是模型首字节 |
| DSH 热请求总时长，ms | 66.5（54–80） | 83（62–104） | 每组 6 次 |
| DSH 首个可见事件，ms | 32（28–39） | 38（30–45） | 同上 |

这批包含上述 UI 差异的样本中，全 App 采样峰值中位数降低 **42.42%**，不能将全部
差值单独归因于 Runtime 复用。DSH 的热请求中位数反而增加 16.5 ms，
没有隐去该回退，也没有据此增加未经测量的队列优化。Private Commit 不是独占物理
RAM，工作集求和会重复统计共享页；5 秒采样不等于捕获了瞬时峰值。两组使用相同
测试观察代码，数据不是未插桩 App 或生产大库的性能承诺。

最后一次各有 **124 个**无新任务空闲样本，覆盖 **610.588 / 610.544 秒**，最大间隔
5.149 / 5.068 秒。两组模型请求均固定为 58，active Task 为 0，DB 固定
2,007,040 字节、WAL 固定 4,128,272 字节、事件数固定为 276。

| 空闲组 | baseline Private Commit 起止，MiB / CPU 秒 | candidate Private Commit 起止，MiB / CPU 秒 |
| --- | ---: | ---: |
| 全部 OpenCode | 2,433.02 → 2,382.73 / 19.359375 | 1,007.88 → 973.12 / 11.609375 |
| 全部 DSH | 180.00 → 179.19 / 0.09375 | 86.92 → 87.62 / 0 |
| Main | 211.00 → 200.34 / 4.9375 | 205.33 → 197.70 / 4.4375 |
| Renderer | 183.32 → 137.40 / 0.265625 | 157.90 → 127.23 / 0.4375 |

Session 有意保留；DSH 尾端有 0.70 MiB 增量，不把这一段描述为所有点都下降，
也不从十分钟数据宣称整个 App 已无泄漏。聚合报告同时保留工作集、堆、句柄和逐进程 CPU。
原始数据位于忽略目录 `matched-app-WBCdJL/{before,after}-{10,11,12}`，汇总为 `summary.json`；
这些是本机验证资产，不进入版本库。

其后才运行剩余 Runtime 检查，避免干扰对照：

- OpenCode 双项目真实 Server 组合通过原生 Skill、真实 stdio MCP 和不同 inline 图片，
  两轮八次 MCP 调用均用请求 ID 核对原 grant 归属，读取结果仍匹配各自目录；十项目
  测试仍通过。DSH 的对应共享组合也通过。四文件合计 **114 通过、4 跳过**，
  跳过的是 3 个显式启用的真实 DSH 模型测试和 1 个真实图像生成测试，不把这些记为通过。
- 直连模型的会话 release/dispose 与实际 Shell 完整输出分页检查通过：删除目标会话
  缓存并释放对应 ToolProvider；dispose 先释放所有已知会话，再释放 provider。实际命令
  结束后输出可分页，dispose 后句柄失效。没有新增模型进程池、历史字节 LRU 或持久缓存，
  此处也没有做直连模型整体 retained-heap 泄漏证明。
- Continue 使用实际 1.5.47 包和生产 Utility adapter，3 轮各两个并发请求，另 5 次热请求。
  11 次本机确定性提供方请求全部返回预期内容，11 个请求级 Utility 均退出，真实模型调用
  为 0。准备耗时中位数：冷准备 **333.93 ms**（326.06–381.94），同 adapter 缓存
  **0.0031 ms**（0.0010–0.0054），新 adapter 命中磁盘产物仍 **312.97 ms**
  （276.08–334.63），各 3 次。11 次原生 HTTP ready 中位数 **936.96 ms**
  （925.60–959.27），首个提供方请求从 run 起算 **980 ms**（969–1,013），总时长
  **1,353 ms**（1,314–1,373）。准备在 run 前单独测量，不能把它再说成总时长已包含。
  跨 adapter 重复准备没有消失；本次保留现有检查与缓存，不为约 0.31 秒的准备成本
  修改单 Session Host 或新增常驻池。
- 最终整仓 `npm test -- --reporter=json --outputFile=<本机证据目录>/full-validation-final.json`
  为 **4,204 通过、67 跳过、0 失败**，耗时约 **733.80 秒**。包括最后加强的
  OpenCode 逐请求图片互斥断言、共享能力组合、设置退役及专家父请求回归；
  先前失败的 `ActivityPanel` 本次在全量中 **16 项通过**。早期失败报告仍保留，
  不将跳过的真实提供方或平台专用测试计为通过。
- 全量结束后再次运行 `npm run typecheck`、`npm run lint` 和 `git diff --check`，
  全部通过，先前并行 Magic Notes mock 不匹配已不再出现。10 个相关文档的
  **140 个相对文件链接**均可解析，未独立复验标题锚点。全量测试进程及按本次测试
  路径筛选的本机验证进程均已退出；Linux 隔离安装的清理证据见前文。
- 最终门禁及报告修订没有新增真实提供方调用，累计仍为 **352 次**。按钮位置调整及
  其他并行工作均保留；本次未执行 commit、push、tag 或发布。性能对照仍使用原冻结
  样本，不把整仓后来通过的回归结果描述成已重新测量该版本的性能。

验收边界仍需保留：性能对照是 Windows 四项目确定性读取，不是大库自然开发或十项目
完整 UI 性能报告；十项目为实际 Native composition 测试。未测所有第三方插件的组合，
未证明整个 App/直连模型无泄漏，macOS/Linux arm64 原生运行仍需可用平台或 CI。

### 2026-09-15：追加真实模型复验与资源观察

用户要求继续使用真实模型，并监控数据库及内存。此次将 `e1fe1cf` 与当时工作区改动
冻结到独立源码目录，构建真实 Main/Preload/Renderer，使用新的隔离 profile 和四个专用
项目，预置 320 条合成历史。按钮位置调整保留；没有把正式用户历史送入测试。
原始证据位于忽略目录 `.agent-resources/runtime-live-20260915/run-tQ1xtk/`，
不是 checkout 自带资产。本轮只调整测试驱动，没有修改 Runtime 产品源码。

- 独立生产构建通过。冻结快照的类型检查暴露并行附件功能的 App 测试 mock 缺少
  `getFilePath` / `importFiles`，未覆盖或撤销那部分工作；这一失败不被早先整仓通过
  的结果覆盖。初次构建取证脚本误用 Preload 扩展名、同步 esbuild 不支持插件等驱动
  错误均发生在模型调用前，生产构建与 Runtime 未因此修改。
- 显式启用 DSH 的三个真实模型专项，全部通过：自定义 Header、Ask 下 Main 代理的
  Web Search/Fetch、真实 npm 插件在 Ask 被拒绝且在 Execute 执行。共 **7 次**
  实际模型请求；该次按测试名选择，仅运行这三项，不把其余九项的过滤跳过算作通过。
- 完整 App 从输入区发出四项目八条开发任务，实际读写模块、添加边界测试并执行
  `node --test`。项目选择器曾因模糊名称匹配到路径中的 `live-2` 而选错项目，
  驱动在发送前被会话身份检查挡住，改用已验证的精确项目文本；没有重复发送已接受任务。
- 第一轮六条任务完成、两条 DSH 以 `pi-ai stream idle timeout after 300000ms`
  失败。一次未观察到上游响应状态，另一条有 HTTP 200 但任务仍超时，不能把 HTTP 200
  当作交付成功。保留失败与数据库后，正常退出测试 App，将测试转发层改为独立
  `undici.request` 流式转发，再显式重跑这两条，均完成。由于同时重启了 App，
  不能据此断言已经唯一定位到转发器或提供方；本轮未盲目修改 Runtime 来规避失败。
- 四项目独立执行测试分别 **16、17、18、19 项通过，共 70 项**。每类 Runtime 的
  项目请求存在重叠，使用同组 owner；本轮开发请求重叠峰值为 OpenCode 4、DSH 2。
  两类 Runtime 分批发送，不声称八条同时运行。
  后续真实原生子代理读取模块及测试，父请求执行测试完成；DSH 两个真实慢命令重叠时，
  只 Stop 其中一个，另一项目继续完成，DSH Host PID 未变。
- 直连与 Continue 从同一完整 App 会话各发出一次无工具短请求，分别持久化
  `LIVE_DIRECT_OK` / `LIVE_CONTINUE_OK`。当前已配置的图像模型另发出一次生成请求，
  实际得到白底蓝色圆形图片并可在生产预览中打开；不是配置检查，也没有读取提供方
  返回的图片 URL。这验证当前配置路径，不冒充运行了绑定指定服务商的可选测试。
- 此时 App 共 **16 条 Prompt：13 completed、2 failed、1 cancelled**，
  **67 次模型请求**；加上 DSH 专项 7 次，本机新增 **74 次真实调用（73 次文本、
  1 次图像）**。计数包含失败及显式重跑。早期累计 352 次暂增至 426 次，
  后续 Linux 增量另记；本机 HTTP 计数不等于 Agent ledger 的交付证明。
- 真实子代理的 **153 条事件**，实际保存 **70,668 字节**，等价完整快照
  **495,934 字节**，该事件负载减少 **85.75%**。使用生产 codec 逐条还原及重新编码
  校验通过；6 次工具块 upsert 中无变化重复写入为 **0**，数据库 `quick_check` 为
  `ok`。这是同批事件的编码差额，不是整个数据库文件缩小 85.75%，也没有删历史。
- 模型结束后连续 **610.857 秒、123 个样本**，最大采样间隔 **5.292 秒**。
  请求数固定为 16，模型调用数固定为 67，活动任务和 streaming 消息为 0；
  DB 固定 **1,765,376 字节**、WAL 固定 **4,140,632 字节**，消息数 355、
  事件数 663、事件 JSON 负载 284,577 字节均不变。
- 本轮全 App 采样峰值 Private Commit 为 **1,728.79 MiB**，OpenCode + DSH
  合计采样峰值 **997.66 MiB**。没有同负载的旧版真实模型样本，不能把它与前文
  确定性对照相减生成新的“节省百分比”，也不把采样峰值称为瞬时峰值或独占物理 RAM。
- App 收到正常 quit 后回收了本轮登记的全部 Runtime，OS 核验最终 Main、OpenCode、
  DSH 和 Continue Utility 均已消失。退出探针曾因等待 `will-quit` 误报超时：
  生产实现实际在 `before-quit` 清理后调用 `app.exit(0)`。该驱动失败记录保留，
  后续探针改从独立父进程观察退出，不修改产品退出路径或伪造原始报告中的 phase。
  关闭后 WAL 为 0，DB 为 **3,125,248 字节**，属于正常 checkpoint，不是空闲增长；
  已保存图片内容为 **1,351,526 字节**，不能把图片占用与事件差量节省混为一谈。

| 空闲进程 | Private Commit 起止（MiB） | 范围（MiB） | 区间 CPU 秒 | 句柄起止 |
| --- | ---: | ---: | ---: | ---: |
| 全 App | 1,345.77 → 1,345.95 | 逐进程样本保留 | 分进程见下 | 分进程见下 |
| OpenCode | 750.42 → 746.00 | 741.62–750.42 | 5.984375 | 333 → 333 |
| DSH | 89.86 → 89.86 | 89.86–89.93 | 0.015625 | 364 → 364 |
| Main | 196.61 → 200.37 | 193.13–205.09 | 5.703125 | 1,137 → 1,137 |
| Renderer | 120.66 → 121.51 | 120.64–122.67 | 0.15625 | 337 → 335 |

Main 堆使用量为 67.27 → 69.44 MiB；Main 与 Renderer 有小幅增量，不能表述为
“所有进程都下降”。采样包含测试观察器累积记录的分配，这一窗口未见数据库增长或
Runtime 句柄积累，但不构成整个 App 无泄漏证明。

当前源码 Linux 复验使用 `/root/tmp` 下的专用目录。旧 `/tmp` 测试 Node/依赖缓存
已不存在，初次准备因失效链接失败，未发出模型请求。随后只替换本轮创建的失效链接，
核验锁定 Node 24.19.0 的 SHA-256，并安装锁定依赖，完成当前源码 Agent/Runtime
组包、隔离安装及 OpenCode 1.18.29 激活，不修改旧安装或无关 Host 文件。

- 两项目各 Ask/Execute 一会话，共四会话使用同一个进程 owner、一个原生 OpenCode PID。
  Ask 实际读取，Execute 实际修改和运行测试，目录 marker 均正确。后续原生子代理
  产生 **497 条**子会话事件，同一 Session 续接完成；两项目独立测试各 **8 项通过**。
- 两个真实 90 秒慢命令期间，目标 Prompt 明确结算为
  `cancelled / processTree: running`。另一会话经真实 attach 传输断开、
  controller resume 和重新附加后完成，原 Session 与 owner 均保留。
  本轮走生产 SSH/ACP/Agent/模型桥，不是再次运行完整远程 Electron UI 或 Desktop 重启。
- 共 **7 条 Prompt：6 completed、1 cancelled**，**36 次模型请求全部 completed
  且已交付**，逐 operation 归账。取消 Prompt 不等于模型交付不确定。释放全部 binding，
  等待 65 秒后 owner 为 0；随后停止本轮隔离 Agent，独立 `/proc` 与 owner 表核验均为 0。
- Host 共 71 次资源快照，未出现采样错误；所属进程私有驻留页合计采样峰值
  **1,033.00 MiB**，其中 OpenCode 峰值 **771.60 MiB**。这是 Linux 私有驻留页，
  不是 Windows Private Commit；也不是 Linux 十分钟空闲或旧新版本对照。
  退出后 semantic-prompts、model-calls、runtime-owners 数据库分别为
  **1,634,304 / 36,864 / 24,576 字节**，WAL 均为 0。
- 本轮最终新增 **110 次模型请求：109 次文本、1 次图像**，包括本机失败和显式重跑；
  加上此前 352 次，累计 **462 次**。其中本机一次未观察到上游响应状态，不能把全部
  110 次写成成功交付。实际开发项目测试合计 **86 项通过（Windows 70 + Linux 16）**。
- 收尾时当前工作区 `npm run typecheck`、`npm run lint` 和差异检查通过。
  238 个 Runtime/Agent/远程适配器文件与冻结快照的文本内容一致，原始字节差异来自
  checkout 的 CRLF/LF；Main、Preload、Renderer 入口产物哈希未变化。并行附件测试
  mock 的缺项已在当前工作区消失，不回写冻结快照，也不掩盖其当时的类型检查失败。
  10 个相关文档的 140 个相对文件链接有效，标题锚点未独立复验。
  本轮没有产品源码修复，未再次运行全仓 `npm test`；前文 4,204 项通过的报告
  早于后来的并行附件/窗口改动，不能将其当成这些改动的完整回归结果。
- 本机命名浏览器会话及所有本轮测试进程均已关闭；保留隔离工作区、数据库、生成图片、
  失败诊断及汇总报告，没有清理正式用户历史，也没有 commit、push、tag 或发布。

## 2026-09-14 Runtime 资源调研与方案（未实施）

- 按用户要求完成文档与源码调研，方案见
  [Runtime 进程复用技术设计](./runtime-process-reuse-technical-design.md)，对应
  FR-RR1–FR-RR6。当前工作仅文档和本机忽略目录内的隔离探针，未修改 Runtime/Agent
  源码、停止用户 Runtime、清理用户数据或准备新发布。
- 源码基线 `de14a6157a6c34f1e3ef22619eca374a50a83706`，保留此前活动 UI 修复。
  manager/controller、OpenCode、Continue、DeepSeek、直连、远程 ACP、Agent backend /
  owner、模型桥和原生插件均已检查。此前同基线生命周期定向回归为 11 文件、
  346 通过/1 跳过；不是本方案实施后的产品验收。
- 已安装 0.13.2 的 09:10:12–09:15:12 五分钟只读采样：数据库约增加 2.72 MiB，
  3,367 条新增子代理事件约 1.49 MiB、平均约 465 字节，93 个工具 upsert 中未变化的
  upsert 为 0；App 相关进程 Private Commit 约 3,229–3,866 MiB，CPU 平均约为
  16 核整机的 3.15%。后续一分钟又完成两个任务，不能作为真正空闲或泄漏结论。
- 两个 OpenCode Server 属于当前 App，启动工作区不同。其中一个原生库 0 Session /
  0 Message、约 527 MiB Private Commit。源码确认按工作区保留实例、清单可启动执行
  Runtime、无时间型空闲回收；没有独立调用轨迹证明该空 Server 最早由清单启动。
- 首轮两个无真实模型探针中 OpenCode 通过，DSH 驱动误用工具内部 `filePath` 而不是
  原生 schema 的 `file_path`，断言失败。修正驱动参数后两项通过，未调整产品代码。
- 随后完整三探针最终通过，Vitest 3 passed / 0 failed，39.20 秒：
  - 生产 OpenCode launcher 单次 spawn，两个目录四个原生 Session，文件路由与单会话
    删除后的其他会话存活通过；没有调用生产 `Runtime.run`。
  - 真实 DSH Host composition、Agent factory、文件和 PowerShell 工具，两个不同 cwd
    的 Agent 并行读写各自测试文件；生产控制面拒绝第二工作区也得到断言确认。
    这不是 Electron Utility/ACP 生产多工作区测试。
  - 一个 Windows 原生 `opencode acp`、一条 ACP connection、两个工作区 Session，
    并行完成两个合成 Prompt；`chat.headers` 的 sessionID 与两个 HTTP 请求归属一致。
    尚未经过 Agent backend、生产模型桥、真实工具/子代理或 Linux Host。
- 本次研究真实模型调用 **0 次**；最终 ACP 探针向本机确定性服务发出 **2 次 HTTP
  请求**。测试服务、原生进程和专用工作区在 finally 中关闭/删除，不操作用户运行中的
  Runtime 或其临时数据库。
- 复现命令：`npx vitest run --config .agent-resources/runtime-reuse-research-20260914/vitest.config.ts`。
  `probe.test.ts`、`opencode-result.json`、`dsh-result.json`、`acp-result.json` 保留在
  同一忽略目录，仅为本机证据，不作为他人 checkout 后必然存在的测试资产。
- 未实施项及生产验收见技术设计 P0–P4/V1–V8；本次未进行新的 Linux Host 验证、
  真实模型开发任务或修复前后内存对照，不将原生能力探针描述成修复完成。
- 文档核验覆盖 10 个改动文档、131 个相对链接和其中 44 个标题锚点，全部通过；
  FR-RR1–FR-RR6 的定义唯一且有验收引用，`git diff --check` 通过。研究用 OpenCode
  二进制剩余进程数为 0。产品源码未改动，因此本轮未重跑全仓 test/typecheck/lint。

本页下方 schema 35 段落保留当时的失败与未发布记录。其后已随 Desktop `0.13.2`
（发布提交 `81ae9e0`）正式交付，Agent `0.11.25` 同期为维护发布；新的进程复用方案
不包含在这两个已发布版本内。

## 2026-09-14 多 Runtime 工具操作摘要

显示与事件合并规则见[工具操作摘要](./runtime-interactions.md#工具操作摘要)。Continue、
DeepSeek Harness 和直连模型已接入共享摘要函数，完成事件缺少输入时保留已有摘要。

Windows 完整 App 使用当前生产 Main、Preload、Renderer 和隔离配置，模型为
`deepseek-v4-flash`。从真实输入区输入并点击发送读取测试文件的请求，校验码只存于
文件中。三条成功会话都返回正确校验码，工具完成后仍显示路径；原生点击展开可查看
输入与输出，离开后重新打开会话、重新加载 Renderer 后再次打开均保留摘要和详情。
六张对话区截图已实际打开审阅。

| Runtime | 成功模式 | 提交数（含失败重跑） | 模型 HTTP dispatch | 工具执行 |
| --- | --- | ---: | ---: | ---: |
| 直连模型 | Ask | 1 | 3 | 3 |
| Continue | Execute | 2 | 4 | 3 |
| DeepSeek Harness | Execute | 3 | 3 | 2 |
| 合计 | | 6 | 10 | 8 |

计数来自 Main 和真实 Utility Host 的 HTTP dispatch，未注入答案或工具事件。Continue
首轮 Ask 仅提供配置工具，未能读取文件；改用 Execute 成功。DS 前两次因 Windows
工作区路径写法与 Host `realpath` 比较不一致而返回 ACP `-32602`，均未调用模型；
同目录改写路径仍复用缓存 Runtime，改用全新规范路径目录后成功。该路径问题随后由
[DS 工作区路径修复](../deepseek-harness/progress.md#2026-09-14-windows-工作区路径修复)
单独处理，新增验证计数见该记录，不计入上表。驱动的包解析、
DOM 定位及卡片比较器失败已记录，修正比较器后的复验没有追加模型请求。

本机临时 `runtime-summary-live/report.json` 保留逐次结果和产物哈希；源码基线为
`c71da4b6ae1d7228ff968d39c63db205caf61339` 加本次工作树改动，Main SHA-256 为
`2153d72a947ab6f5eab22eab28d7a3f2f86a47740d5223a3e1547f199fa7de84`。
测试进程、隔离配置、数据库、工作区和构建均已清理，正式配置字节未改变；报告和截图
保留在本机临时目录，不作为长期可用的仓库资源。请求使用已配置 HTTPS，沿用生产
证书策略，本轮未验证严格证书校验。未测试 Main 重启或远程 Agent。

专项回归 210 项通过、1 项跳过。完整 `npm test` 首轮 4154 项通过、66 项跳过，另有
6 个 `.agent-resources` 内的本地 `node:test` 文件被 Vitest 误收集导致套件失败。
使用 `npm test -- --exclude "**/.agent-resources/**"` 完整重跑后，353 个文件通过、
9 个跳过，4154 项通过、66 项跳过、0 失败，耗时 646.04 秒。`npm run typecheck`、
`npm run lint` 和 `git diff --check` 通过。

## 2026-09-13–14 schema 35 工具重复写入补修（未发布）

- 0.13.1 的历史库回收成功，但其真实模型验收限制子代理不使用工具，遗漏了生产工具对象
  的 `undefined` 可选字段。JSON 重读省略这些键，原深比较误判未变化的工具块。正常开发
  任务复现同批 928 条事件的 7,787 次重复工具块写入；仅归一化空字段的对照将负载从
  10,467,622 降为 452,391 字节，逐条还原一致。该对照不是产品修复验收。
- 当前修复按共享工具 schema 的字段值比较，不序列化整份工具输出进行比较。空字符串、
  输出修订、状态和错误变化仍保留。schema 35 使用同一编码器重整旧完整事件及 schema 34
  已存差量，跳过 JSON 未变化的行；不会删除事件、会话、工具结果或来源字段。
- 存储缓存仍最多 16 个任务，终态及时移除缓存引用；回滚后按已提交记录重建，其他任务
  不受影响。远程先按来源主键判断是否重放，重复事件不重建已经释放的写入缓存；
  `INSERT OR IGNORE`、冲突校验及消息投影事务仍保留。
- Windows 当前源码加便携版内置 OpenCode 完成正常 CSV 项目开发，主／子代理实际读取、
  改代码、补测试和执行命令；独立 59 项测试及 CLI 通过。698 条子代理事件共
  368,575 字节，重复工具块为 0，与归一化对照字节数完全相同，每条事件还原一致。
- 多项目实测使用两个独立 OpenCode 实例、每项目两个会话，两轮共 8 次 Execute。
  第一轮四个开发任务全部完成；第二轮复用会话，主动取消一个正在使用工具的子代理任务，
  其余三个完成并通过测试。2,841 条子代理事件共 1,305,340 字节，重复工具块为 0，
  全部逐条还原一致。每轮结束后缓存任务数、打开的 SSE 响应流均为 0。
  隔离 Main 测试进程在显式 GC 后的堆占用为 12.94 → 12.91 MiB；
  这证明本轮未持续积累，不是整个 Electron UI／Runtime 的 RSS 上限或无限负载保证。
- 共享 Linux x64 Host 使用当前桌面源码经真实 SSH、Agent、ACP 和模型 gateway 完成
  Ask 与正常工具 Execute。912 条子代理事件共 405,360 字节，重复工具块为 0，
  逐条还原及重复重放通过，远程 Python 项目测试通过。修复位于共享桌面层，不修改 Agent
  或公开事件协议。两次早期测试驱动错误中断操作，修正瞬态事件处理后才完成上述验收；
  不能将早期失败写成产品通过。
- 本轮实际提供商请求为 121 次：本地开发 26，多会话 79，远程账本 16（成功验收 14，
  早期驱动中断 2 次结果未知、未交付）。本地计数器只记录 HTTP 状态，远程按测试
  request/operation 的 Agent ledger 统计，不记录凭据、正文或请求头。另有先前诊断的
  24 次请求，不计入这 121 次。已核对本轮本机和远程测试工作区无残留 Runtime 进程。
- 活动 schema 34 库通过 SQLite online backup 取得一致性备份，并校验独立测试副本。
  正常启动升级成功，2,898,984,960 → 607,055,872 字节（2.70 GiB → 578.93 MiB，
  回收 79.06%）。完整比较 424,148 条原事件的内容、ID、时间及来源一致。
  隔离启动未复制模型配置，既有启动修复调整一条项目／会话 Runtime 选择及一个在途任务、
  消息和活动状态，另追加一个状态事件；不是迁移删除或改写历史内容。
- 同一真实备份的另一个副本直接运行实际构建的升级 Worker，在处理 64 条后取消，
  重启后完成 316,664 条子代理记录；全量事件再次还原一致。全部非事件表逐表内容一致，
  包括 150 个会话、1,915 条消息、914 个任务和 136 个成果；`integrity_check=ok`。
  原运行库和校验备份没有被测试改写。schema 35 副本再次进入实际 Worker 时直接完成，
  进度事件数为 0，不重复整理。
- 最终专项 99 项、typecheck、lint 及生产开发构建通过。首轮全量产品用例 4,154 通过、
  66 跳过，但 6 个临时 Node 测试项目被 Vitest 错误发现；配置已排除 `.agent-resources/`，
  独立项目仍单独运行自己的 Node 测试。随后显式双 worker 全量为 4,148 通过、66 跳过、
  `App.test.tsx` 6 项时序失败；恢复仓库默认单 worker 后该文件 220 项全部通过，
  未修改 UI 代码。最终默认配置全量为 4,151 通过、66 跳过、3 个问答 UI 测试失败，
  失败项与双 worker 不同；本轮全量回归尚未全绿。随后仅调整测试等待和 mock 隔离的
  尝试仍有不稳定失败，已完整撤回这些额外 UI 测试改动，不把单次重跑通过当作稳定修复。
  存储专项、真实工具任务、并发内存和真实数据迁移证据均通过；UI 测试问题仍需单独处理，
  本次未提交、未发布，也未替换用户正在运行的 0.13.1。

## 2026-09-13 Desktop 0.13.1 执行记录去重与大库升级

- 实现与兼容边界见[执行记录存储与升级回收](./execution-history-storage.md)，通用开发
  要求见[数据库迁移指南](../../development/database-migrations.md)。本机和远程写入共用
  差量编码，不修改 Runtime 公共事件或 Agent 协议；消息投影与来源去重继续保持事务。
- 真实 portable 旧库先备份并校验 SHA-256，再在独立新版 portable 中启动升级：
  13,094,912 → 12,595,200 字节，schema 33 → 34。659 条消息、52 条会话、133 条成果、
  笔记／待办及模型用量表逐表内容一致，完整性检查通过。
- 另对真实膨胀库的核验备份副本运行同一 portable 启动入口：
  97,308,667,904 → 594,182,144 字节，即 90.63 GiB → 566.66 MiB，
  实际回收 90.07 GiB（99.39%），freelist 为 0。原库和原 portable 数据库未改写。
- 全量还原比较 411,981 条事件，所有内容、事件 ID、时间及远程来源字段一致；
  SQLite `integrity_check` 返回 `ok`。1,876 条消息、895 个任务、136 个成果及笔记、
  待办、用量和活动记录等表内容一致。隔离 profile 没有复制模型配置，既有启动修复更新了
  一条项目及一条会话的 Runtime 选择，项目 `updated_at` 随之更新；不是事件迁移修改。
- 真实升级中通过“退出，稍后继续”停止，再用更新后的 portable 继续并完成。初版 UI
  只按内容高度展开且进度条过窄，用户指出后修复为全高画布和全宽进度条，并显示处理速度；
  实包测得页面高度约 761 CSS px、viewport 761 px，进度条宽约 960 px，截图人工复核通过。
- 大库采样的读取耗时占约 65%、JSON 解析约 17%。将升级读取缓存由 8 MiB 提至
  64 MiB，保留每批 32 条事务和 SQLite 自动 checkpoint，只在任务结束时截断 WAL。
  相邻 2,048 条转换采样从约 12.0 秒降至 8.8 秒；样本和缓存状态不同，不作为固定加速比。
  未增加同库并行写入，也未关闭事务或同步落盘。
- 当前源码通过真实本地 OpenCode Execute 和共享 Linux x64 Host 的托管 Ask／Execute。
  本机与远程各观察到 65 条子任务事件，最终过程仍可显示，远程重复事件不重复投影；
  测试资源均位于专用目录。共提交 3 次真实 Prompt，Runtime 上报 4 笔模型用量；
  子代理内部 HTTP 调用未单独计数，不将该上报数称为服务商请求总数。
- 首轮完整 `npm test` 为 4,114 通过、66 跳过，637.97 秒；后续 8 项新增／修正的专项
  回归通过，`npm run typecheck`、`npm run lint` 通过。生产构建及用户要求的 portable
  实包开发验证通过。0.13.1 版本与发布说明变更后的本地最终验证被用户主动取消，按要求
  不再追加本地测试，候选的最终全量测试、类型、lint 与生产构建由 main CI 判定。
- 用户批准 0.13.1 中英文说明及仅标准六平台发布；Agent 保持 0.11.24。
  已发布提交 `4937720` 和不可变标签 `v0.13.1`，main CI 与六平台发布通过；
  后续真实工具场景的遗漏及补修见本页 schema 35 记录。

## 2026-09-13 原生浏览器与应用浮层修复

- 用户在“添加实例”中复现原生网页盖住弹窗。原先只有终端关闭确认释放 viewport，
  现在所有应用 Modal 与相交浮层共用
  [浏览器遮挡机制](./browser-tabs-technical-design.md#4-renderer-与-viewport)。
  新增五个组件回归在修复前全部失败，修复后通过；独立检测器另有十项回归。
- Windows 当前 Main、Preload、Renderer，通过 `electron-vite dev` 和独立 profile
  启动完整 App，不是旧安装包或仅有 Renderer 的 fixture。浏览器导航到本机合成页后，
  实例管理与项目设置均验证原生视图 `visible → hidden → visible`；视图 ID 不变且未销毁。
  本次不修改 Runtime、Agent、MCP 或远程生产路径。
- 实例编辑器在浅深主题、目标 1280×800、960×720、720×640、640×420 下完成八组
  几何、关闭按钮命中和原生视图隐藏断言。Windows 缩放产生不足 1 CSS px 的取整差异，
  记录实际尺寸而非把目标尺寸当测量值。PNG 实际审阅包括浅色 1280、720 和深色 640；
  其余尺寸执行程序化检查，不将其描述为全部 PNG 人工审阅。
- 临时驱动曾出现新浏览器 target 抢占自动化目标、隐藏窗口截图阻塞及严格像素比较
  误判；修正驱动后重新取证，不把这些失败改写为产品修复。最终使用 pinned renderer、
  独立测试窗口和 CDP PNG；原生视图状态单独从 Main 读取，避免网页截图漏掉原生视图。
- 顺带复现已发布更新说明资源为 136,554 字节，超过原 128 KiB 读取上限。上限提高到
  1 MiB，仍使用有界读取；回归直接读取实际打包资源并确认当前版本可展示、可确认。
  完整 App 已显示并关闭 0.13.0 更新说明，重启后不再次显示。
- 首轮 `npm test -- --maxWorkers=1`：4,108 通过、66 跳过，608.30 秒；
  `npm run typecheck`、`npm run lint` 通过。补长名称修正后的全量执行为 4,105 通过、
  66 跳过、3 失败，586.51 秒；失败全部位于并行修改中的子代理进度测试。
  未修改这些文件，随后定向重跑 ACP 与 OpenCode 子代理共 66 项全部通过。
  全仓类型与 lint 检查期间先后遇到并行子代理/存储升级改动的缺失字段和未使用导入，
  这些改动不纳入本次提交，不能把早先的通过结果当作当前并行工作区全绿。
- 两组 Harness 单测补 `onTestFinished` 回收临时目录。最后定向四文件 73 项通过，
  运行前后检查新增残留目录为 0。测试清理不改变 deployed Runtime。
- 本次修改文档的 66 个相对链接目标存在，暂存差异无空白错误；最终发布仍需对确定的、
  不再变动的候选提交执行发布验证，不能将未提交的并行改动混入候选。
- 临时脚本、截图和隔离构建按用户要求在提交后清理；这里只保留脱敏结论。知识库布局、
  合成服务保存验证与调用计数见[知识库进度](../knowledge-base/progress.md#2026-09-13-知识库布局与自动名称修复)。

## 2026-09-13 OpenCode 事件流关闭顺序修复

候选检查中的 lifecycle 失败已稳定复现，4 路并行后 `openEventBodies` 为 3 而不是 0。
原因与统一修正规则见[复发缺陷记录](../../quality/recurring-defects.md#事件迭代结束前释放底层订阅)；
聊天与 Compact 共用最小迭代器包装，不修改 OpenCode SDK、重试时限或现有断言时限。

- 加强既有正常结束与消费方提前返回回归，修复前两项均失败，确认最终 `signal.aborted`
  不能证明关闭顺序正确；修复后通过。
- `npm test -- src/main/agent/opencode-runtime-lifecycle.test.ts
  src/main/agent/opencode-runtime.test.ts src/main/agent/opencode-runtime-permissions.test.ts
  src/main/agent/opencode-subagent.test.ts`：4 个文件、99 项通过。
- Windows 当前源码配合真实 OpenCode `1.18.29`、真实 SDK/HTTP MCP 和 loopback 模型通过
  1、4、8 路并行、取消一条而另一条正常结束，以及实际原生 Compact；各阶段打开的 SSE
  响应流均归零。验证是生产 Runtime 入口，不是完整 Electron UI；真实服务商调用 0 次。
- 已核对远端 `AcpRemoteRuntime` 的 Agent-owned transcript 轮询与
  `AgentOwnedAcpPrompt` 的 ACP stdio 连接，不使用本机 `client.event.subscribe`。本次未改
  Agent、远程桥或协议，不需要远端对应修复，也未将本机测试算作远程 Host 复验。
- 最终 `npm test`：349 个文件通过、9 个跳过；4,089 项通过、66 项跳过、0 失败，
  耗时 571.43 秒。`npm run release:notes:verify`、`npm run typecheck`、`npm run lint`
  全部通过；下节失败结果保留为修复前记录，不再是当前本地回归结论。
- 发布说明按 Desktop `v0.12.12`、Agent `agent-v0.11.23` 到最终候选的差异核对，
  不按中间开发提交分别列出修正。用户明确不增加事件流条目，已批准中英文说明保持不变。
- 本轮未提交、推送或打标签，未运行本地生产构建或打包；远程问答完整生产链路的真实
  服务商验证及候选 CI/原生发布验证仍沿用各自待验收状态，不由本机 SSE 修复代替。

## 2026-09-13 Desktop 0.13.0 / Agent 0.11.24 候选检查

本轮仅准备本地候选：更新 Desktop 与 Agent 版本、用户批准的中英文发布说明及功能清单，
远程原生问答按问题修复分类。Agent 发布说明测试允许仅有修复章节，同时检查中英文分类
一致；未修改 Runtime、Agent 问答或事件流实现。Agent `0.11.24` 需要先升级 Desktop 至
`0.13.0`，OpenCode 保持 `1.18.29`。

- `npm run release:notes:verify`、`npm run typecheck`、`npm run lint`：通过。
- `npm test`：348 个文件通过、1 个失败、9 个跳过；4,088 项通过、1 项失败、66 项跳过，
  耗时 571.96 秒。唯一失败为 `opencode-runtime-lifecycle.test.ts:120`，并行请求结束后
  `openEventBodies` 期望为 0、实际为 3，轮询未在时限内满足；该现象早已有记录，
  本轮没有完成根因判断，也没有放宽断言或跳过测试。
- 单独复跑上述 lifecycle 文件及 `agent-release-workflow.test.ts`、
  `release-notes-source.test.ts`、`release-notes-service.test.ts`：发布相关 15 项通过，
  lifecycle 同一断言再次失败。该结果不能替代一次全量通过。
- 更早的一次全量运行在调整 Agent 发布说明章节断言前主动停止，未取得汇总，不计为通过。
- 候选版本一致性、历史 Desktop 发布说明未改动、48 个 Markdown 相对链接目标和
  `git diff --check` 已通过。
- 本轮真实模型验证调用 0 次，未重跑真实 Host；既有 SSH/确定性模型证据见下文，
  不将其扩写为完整生产 Main/Preload 配合真实服务商的验收。
- 未提交、推送或创建标签，未运行本地生产构建、打包或 LoongArch 预览。
  全量测试失败、完整远程生产链路及候选 CI/原生包验证仍未解决，候选不标记为可发布。

## 2026-09-13 SSH 问答 UI 复验与取消后续发

在真实 Electron 窗口中使用当前 `App`、入口样式和主题函数，经测试 IPC 接入生产
`createManagedRemoteAcpRuntime`。远端使用共享 Linux x64 Host、真实 SSH attach、当前源码
Agent、原生 OpenCode 和生产模型桥；模型响应来自远端 loopback 确定性服务。配置、项目、
队列和存储 API 复用 App 测试 fixture，因此本次证据范围为 App Renderer 到真实 SSH
Runtime，未覆盖完整生产 Main/Preload、生产数据库持久化、发布安装或重启恢复。

窗口测试发现待答期间取消后，同一对话立即发送会报
`Active prompt operation identity cannot change before terminalization`。Agent 取消分支
原先只写语义记录，重复终态写入失败后未留下可核对的操作终态；Desktop 也保留了旧
binding。修复复用 Agent 的异常终态记录方法，并在 Desktop 显式取消后核对终态、关闭
已终结 binding 和释放会话通道。新增两项回归验证 Agent 取消核对及同一对话续发。

已通过的 UI 场景：父子问题同时待答、重复事件不丢草稿、自由文本回答、选项回答、注入
一次回复失败后原输入重试、跳过、待答期间取消、取消后在同一对话发出新请求并正常完成。
鼠标和输入使用 Electron 原生输入 API。重复问题和回复失败由驱动注入，其余问题、工具
进展及完成事件来自真实远端 Runtime；驱动消费内部 checkpoint，并将取消映射为公开
`error/status=cancelled` 事件，不把内部 Runtime 事件直接送给 Renderer。

浅深主题各检查四组窗口尺寸，问题表单无横向溢出、草稿保留，提交按钮可滚动到可见位置。
短窗口需纵向滚动查看问题与输入，未宣称整张卡片同时可见。检查目标为 1280×800、
960×720、720×640、640×420，Windows 175% 缩放下实际 CSS 内容区各多 1 像素。
临时驱动、JSON 测试报告、各轮日志及 PNG 保留在批准临时目录，使用
`question-ui-*`、`remote-question-*` 和 `question-validation-*` 文件名前缀；驱动按
[Electron UI 自动化规范](../../quality/electron-ui-automation.md)的现有启动方法重建，
不是仓库通用 UI runner。SSH 测试结束后停止专属 daemon 并清理远端专属目录和上传文件。

复现时在批准临时目录执行 `node question-ui-build.cjs`、
`node remote-question-build.cjs`，随后设置 `GOODBUDDY_QUESTION_UI=1` 并执行
`node remote-question-run.cjs`。脚本依赖本机既有加密 Host 配置和 Host 上的测试 Node
依赖目录；不得将这些本机条件当作新环境已经满足。早期驱动的内部事件转发、原生输入
等待和跨轮模型结果判断错误均已修正；它们与实际取消续发缺陷分别记录，未将失败轮次
改记为通过。首轮窗口退出过早，未取得完整模型夹具计数，历史夹具请求累计数不完整；
外部模型调用为 0。

最终 SSH/UI 一轮完成 4 次输入区提交、2 次回答和 1 次跳过，收到 4 个原生问题，取消
核对结果为 `terminal/cancelled/processTree=empty`，随后新请求完成。该轮模型夹具请求
精确为 7 次，外部模型调用 0 次，Renderer 控制台错误 0 条，驱动退出码 0。最终定向
回归分两条命令执行：`npm exec vitest run src/agent-daemon/runtime-acp-backend.test.ts
src/main/agent/acp-remote-runtime.test.ts` 为 96 项通过；
`npm exec vitest run src/agent-daemon/remote-question-binary.test.ts
src/agent-daemon/opencode-subagent-plugin.test.ts src/agent-daemon/model-bridge.test.ts
src/main/remote-agent/protocol-remote-runtime-channel.test.ts
src/agent-daemon/runtime-composition.test.ts src/main/ipc.test.ts` 为 179 项通过、5 项跳过。
`npm run typecheck`、`npm run lint` 和 `git diff --check` 通过。

首轮默认并行 `npm test` 的打包测试超时，整轮随后被 120 秒工具时限中断；单 worker
重跑为 4,084 项通过、66 项跳过，耗时 626,816 毫秒。此结果早于本节取消修复，
不作为最终源码全量结果。

取消修复后的全量命令为 `node node_modules/vitest/vitest.mjs run --maxWorkers=1
--reporter=json --outputFile=<批准临时目录>/question-validation-final.json`，覆盖 358 份
测试文件，结果为 4,087 项通过、1 项失败、66 项跳过，监督进程记录耗时 617,138 毫秒、
退出码 1。唯一失败是 `tests/agent-package.test.ts:372` 的大清单安装用例，耗时
63,366 毫秒，超过该用例 60 秒上限。随后
`npm exec vitest run tests/agent-package.test.ts -- --maxWorkers=1` 单独复跑为
22 项通过、1 项跳过，整文件耗时 60.08 秒；没有修改该打包测试或放宽超时。
全量失败记录保留，不能将分次复跑结果写成单轮全绿。

最终 UI 原始日志为 `question-ui-1789278503920.log`，8 张待答截图为
`question-ui-{light,dark}-{1280,960,720,640}.png`，另有完成截图
`question-ui-success.png`。已逐张打开待答 PNG 审阅字体、字段、按钮、焦点和短窗口
滚动位置；未发现问题卡片遮挡或按钮不可达。尺寸切换等待 CSS 过渡结束后再截图，
窗口使用独立临时 session partition。当前证据不覆盖全键盘导航或正式 profile 的清理。

## 2026-09-13 托管 SSH 原生问答

- 当前源码支持前台托管 SSH OpenCode 的父、子孙会话原生问题、回答和拒答，复用已有
  Renderer 队列与 Task 归属。问题来源为原生 `question.asked`；模型正文和普通工具活动
  不生成问答表单。协议、身份与生命周期规则见
  [远程主机技术设计](../remote-host/technical-design.md#acp-与断线)。
- 新增 `remote-question-binary.test.ts`，使用真实 OpenCode `1.18.29` ACP 进程、生产插件、
  Agent Prompt owner 和 loopback 模型夹具，覆盖父问题、Task 子问题、拒答、取消、
  跨 binding 回答拒绝、迟到回答拒绝，以及临时回复能力不进入语义记录。
  插件测试另覆盖孙会话归属、并发重复事件、HTTP 路径认证、原生待答列表校验和端口关闭；
  Runtime 测试覆盖已 ACK 记录后的待答补发、回复失败重试与已回答历史去重。
- 共享 Linux x64 Host 使用既有加密凭据和固定 Host Key，经真实 SSH attach 启动当前源码
  的隔离 Agent。生产 `createManagedRemoteAcpRuntime` 入口完成 Ask、Execute 并行父子
  问答、拒答和待答期间取消；两个并行问题在首次回答前均到达 Desktop Runtime，子问题
  带 Task 归属，回答后原生 Task 和父轮次正常完成。拒答结束原生轮次，取消后迟到回答
  明确失败。最终一轮 7 次确定性模型夹具请求，外部模型调用 0 次；测试 daemon 停止，
  测试目录与上传文件已清理，未修改 Host 原有 Runtime registry。
- 最终定向回归：11 份测试文件，219 项通过、5 项平台跳过，包含 Agent、模型桥、ACP
  Runtime、认证控制通道及托管入口测试。`npm run typecheck`、`npm run lint` 通过。
  本轮全量 `npm test -- --reporter=json --outputFile=<临时报告>` 为 4,081 项通过、
  0 项失败、66 项跳过；之后的插件身份与并发去重补充由最终定向回归和 Host 复测覆盖。
- 本节早期验证未操作 Electron 窗口、重装共享 Agent 或模拟整机重启；问答队列的界面行为由
  既有 App/ChatTimeline 测试覆盖。同一存活 Prompt 的待答补发由 Runtime 回归验证，
  不把它描述成 Agent 进程重启后的问题恢复。旧 Agent 和任意第三方 ACP 服务的范围见
  [Runtime 交互边界](./runtime-interactions.md)。

## 2026-09-13 并行提问顺序回答

- 修复同一前台请求的后续提问覆盖未回答问题：Renderer 按 ID 保存待答队列，逐次显示、
  回答和跳过，保留失败重试输入；运行中快照刷新保留队列，终态清理全部待答项。
  交互和归属限制见 [Runtime 交互边界](./runtime-interactions.md#运行与失败)。
- 本机 SDK 使用已收到的 Task 子会话元数据传递可选 `childTaskId`；Task 卡片显示待答状态，
  展开后可定位并聚焦队首表单。没有已知 Task 关联的问题仍能回答。
- 六份相关测试文件共 346 项通过：`App.test.tsx`、`ChatTimeline.test.tsx`、
  `conversation-activity.test.ts`、`opencode-runtime.test.ts`、
  `opencode-runtime-permissions.test.ts`、`opencode-runtime-lifecycle.test.ts`。
  覆盖并发到达、重复 ID、草稿保留、提交失败、队列推进、快照刷新及终态与回复竞态。
- 真实本机 OpenCode 二进制配合 loopback 模型服务验证两次原生提问均在首次回答前到达，
  随后分别回传并完成请求；同时保留 Task 文件读取和 Ask 工具限制验证。该用例每轮
  6 次 loopback 模型请求，外部模型调用 0 次。完整桌面点击路径由 App 组件测试覆盖，
  本轮未手动操作 Electron 窗口。
- 首次 `npm test` 达到工具 200 秒上限；后台重跑 `npm test -- --reporter=verbose` 完成，
  348 份测试文件通过、9 份跳过，4,069 项通过、66 项跳过，耗时 572.20 秒。
  随后补充已回答 ID 的去重必须先于任务状态更新，最终 18 项问答及活动相关回归通过。
- 独立评审补充同一 React 批次首次两次收到相同 ID 的回归：修复前显示两个待答项。
  在消息函数式更新器内复核待答和已回答 ID，重复事件直接返回原消息，保留状态；外层
  去重仍阻止重复事件改写任务状态。修复后 19 项定向回归、typecheck 和完整 lint 通过。
- 最终 App 全文件复跑为 217 项通过、1 项失败；失败项为并行开发中的外部知识绑定测试
  `adds a new external binding to the current selection without re-enabling an excluded library`，
  “添加知识库”按钮未启用，定向复跑仍失败。本次未修改该测试或知识绑定逻辑。
  `npm run typecheck` 与差异空白检查通过；早期完整 lint 通过，最终完整 lint 扫到并行
  工作新增的 `.kb-app-live` 产物而失败。保持产物原样，使用
  `npm run lint -- --ignore-pattern ".kb-app-live/**" --ignore-pattern ".kb-app-live*.cjs" --ignore-pattern ".kb-app-live*.ts"`
  复跑通过。
- 远程 `AcpRemoteRuntime` 仅接入权限请求，尚无业务问答桥；本次未修改 Agent、ACP
  传输、共享子任务进度适配器或 SSE 订阅，不将本机问答验证算作远程覆盖。

## 2026-09-13 浏览器租用标签页关闭与显式恢复

- 更新 `tests/browser-tabs-electron-e2e.ts`，移除两处租用期间拒绝关闭的旧断言。
  当前行为见 [Agent 与 MCP 路由](./browser-tabs-technical-design.md#6-agent-与-mcp-路由)
   和 [浏览器需求](./prd.md#77-浏览器)。同步修改 BrowserService、IPC、Gateway 和直连模型工具。
- Windows 真实 Electron/Chromium 与 loopback HTTP/MCP 验证通过：关闭已物化的预留页和
  已租用主标签页，等待原 WebContents 的 `destroyed` 事件，确认租约结束而请求信号未取消。
  同一 token 和 MCP session 仍可列出工具；旧目标快照返回关闭提示且不创建页面。
  显式 `browser_navigate` 创建不同身份的专用替代页，后续 MCP 快照读取该页。
- 同 Conversation 的 sibling 仅在主标签页关闭后取得 `primary` 标记，页面 URL、导航状态、
  时间戳、工作栏身份和 Cookie 内容保持不变；另一 Conversation 的页面与可见 viewport
  保持不变。撤销 capability 后完成替代页、同级页和 Context 清理。
- 已先检查 runner：esbuild 输出临时 CJS，启动真实 Electron，子进程上限 120 秒，结束后
  删除临时 bundle。`node build/run-browser-tabs-electron-e2e.cjs` 最终退出码 0；
  前三轮分别修正测试对销毁事件时序、服务旧 ID 错误文案和 sibling 主标签标记的假设。
  测试文件 ESLint 与限定文件的 `git diff --check` 通过。
- 覆盖边界：本轮通过 Main BrowserService 和真实 MCP transport 操作页面，未点击完整
  Renderer/Preload 关闭入口，未注入执行中的工具取消，也未运行直连模型循环或其他共享工具。
   浏览器、Gateway、直连 Provider、Model Runtime 和 IPC 回归共 359 项通过、1 项跳过，
   包括执行中关闭、请求继续完成和其他工具继续可用。全库 typecheck、lint 和 diff 检查通过。
   全量 `npm test` 在 Agent 离线依赖安装用例失败后达到 200 秒执行上限；无外部模型调用。
- 本轮未修改 Agent、桥接或 Runtime 产品源码，也未连接远程 Host。远程调用若进入同一桌面
  Gateway，会使用上述服务端路由；远端 Runtime 到桌面的实际传输、取消传播及恢复仍需真实
  Host 验证，本记录不将本机 loopback 结果算作远程覆盖。

## 2026-09-12 浏览器刷新与关闭后的错误清理

- 按 [浏览器工具栏规则](./prd.md#77-浏览器) 修复空白标签页允许刷新的问题；
  刷新需要 Main 的已提交 URL，地址草稿不启用刷新，首次导航仍可停止加载。
- 侧栏操作错误在切换面板、关闭当前页签或收起工作栏后清除；旧面板的异步失败不再回写。
  作用域实现见 [浏览器多实例技术设计](./browser-tabs-technical-design.md#4-renderer-与-viewport)。
- Sidebar 回归 38 项、App 浏览器筛选回归 5 项、BrowserService 回归 43 项通过。
  `node build/run-browser-tabs-electron-e2e.cjs` 通过，验证真实空白页、导航、页面隔离和关闭；
  该脚本不覆盖 Renderer 提示显示，提示清理由组件测试验证，本轮未手动操作完整桌面 UI。
- `npm run typecheck` 和两份修改源码的 ESLint 检查通过。全量 `npm test` 在 Agent
  离线依赖清单用例超时后，整轮达到 200 秒执行上限；包含完整 App 测试的补跑也达到该上限。
  `npm run lint` 被工作区原有未跟踪的 `application-tool-navigation/navigation-demo.js`
  中 27 项浏览器全局变量错误阻断，未修改该文件，不将整库校验记为全绿。
- 本轮仅修改桌面 Renderer 控件与提示状态，未改 BrowserService、Runtime、Agent 或远程协议；
  不需要单独的远程实现。无外部模型调用。

## 2026-09-10 提交后保留问答

- 桌面端在提交成功后保留结构化问答回顾，支持多轮回答、跳过及本地会话重新加载；
  交互规则见 [Runtime 交互边界](./runtime-interactions.md#运行与失败)。
- App 回归覆盖提交与重载、下一轮问题提前到达、终态先于提交返回、提交失败；数据库
  回归覆盖完整替换、增量保存、关闭重开、多选及超过 1,000 字符的自定义答案。
- `npm test`：3,900 项通过、66 项跳过，Agent 离线依赖清单测试在 60 秒超时；
  该项独立复跑通过（58.33 秒）。`npm run typecheck`、`npm run lint` 与差异空白检查通过。
- 本轮未手动运行真实 OpenCode 问答会话，外部模型调用 0 次。修改仅涉及桌面端展示与
  本地保存，不改变 Runtime 回传协议或 Agent 路径，不新增远程 ACP 问答能力。

## 2026-09-10 Git 历史测试夹具修复

- 桌面候选 `877cf58` 的 CI 在四项工作区测试准备 Git 提交时因缺少作者身份失败。
  `c037d7f` 移除测试身份后引入了机器配置依赖；本机已有身份使该问题未在本地暴露。
- 测试现在把已暂存的 tree 写入固定 Git commit 对象，并仅更新临时仓库的分支引用，
  不调用 `git commit`，不修改或覆盖任何 Git 身份配置。历史、重命名差异、分页和脏文件
  分支冲突仍由真实 Git 与生产 `manageWorkspace` 验证，不用 mock 或跳过用例替代。
- 新增夹具自检确认 `git fsck --strict` 通过、父提交链有效、未暂存内容保持不变且仓库配置未改。
  聚焦测试 11 项通过、2 项因当前文件系统大小写不敏感而跳过；无身份 Runner 的验证待新候选 CI。
- 完整 `npm test` 为 3845 项通过、66 项跳过、1 项未修改的活动列表测试超时；
  随后 `ActivityPanel.test.tsx` 的 16 项独立复跑全部通过，未放宽时限或删除断言。
  `npm run release:notes:verify`、`npm run typecheck`、`npm run lint` 通过。
  未将这次本地整库结果记为全绿，发布仍以新候选的 CI 校验和生产构建通过为前提。
- 本轮只改测试和验证记录，产品功能、Agent 源码及已批准的双语发布说明不变，无外部模型调用。

## 2026-09-10 工作区布局与分支输入样式

- 按 [FR-W1、FR-W4](./prd.md#76-工作区) 将视图切换和刷新合并到顶部行，
  文件与 Git 工具按视图显示；移除根目录的孤立图标及空导航行，子目录保留文字路径导航。
  分支搜索复用共享 `field`，面板限宽、分支列表限高滚动，创建按钮使用紧凑次操作。
- 新增布局、子目录返回、焦点恢复、分支搜索/切换/创建回归；工作区、设置界面、设置存储、
  IPC 和 Sidebar 五个测试文件共 354 项通过。另确认安全与数据的默认 `toolApproval` 为
  `always`，对应“Execute 自动授权已启用的工具”；已有明确保存的禁止策略仍保留。
  本轮没有修改授权策略或默认值。
- 当前构建的 Windows Electron 使用独立 profile 和临时 Git 项目，实际 App → Preload →
  Main 路径通过分支搜索、切换、创建和子目录新建文件；磁盘与 Git 分支结果均确认。
  文件/Git 切换保留浏览目录，返回根目录后导航行移除、焦点回到刷新；Escape 收起分支面板并恢复焦点。
  真实安全与数据页面的默认选中项也确认为自动授权。
- 浅色与深色下，将实际工作栏布局宽度设为 300、420、650px 后均无工作区横向溢出。
  输入框为共享 13px 正文、标签 11px，分支面板最大 360px；15 个分支时列表可在 240px 内滚动。
  这些是布局检查，不作为分栏拖拽或原生浏览器鼠标交互的验证。
- `npm run build:bundle`、`npm run typecheck`、`npm run lint` 通过。
  整库 `npm test` 为 3843 项通过、1 项失败、66 项跳过；失败项是未修改的
  `opencode-runtime-lifecycle.test.ts` 事件流关闭时序断言，单独复跑通过。
  未再次运行整库，不将此结果记为整库全绿。
- 本轮产品改动仅为共享 Renderer 工作区布局，未改 Main/Agent 的工作区命令、
  desktop-to-Agent 协议或 Runtime 执行逻辑；远程项目继续使用同一组件和既有回调，
  本轮未做新的 Host 实测。无外部模型调用，所属测试应用、浏览器会话和调试监听已关闭。

## 2026-09-10 提交审查修复

- [FR-W3、FR-W6](./prd.md#76-工作区)：同一目录项可仅修改大小写，仍拒绝覆盖其他文件、
  目录和硬链接目录项；提交 Diff 同时使用重命名前后路径；分支后台刷新不再使历史请求
  遗留 busy；自动目录刷新包含当前浏览目录并去重。
- 浏览器请求仅预留目标身份，首次导航才创建实际资源；Main 状态携带工作栏实例身份，
  Renderer 直接绑定同一页面，停止或回收后清除旧绑定。跨会话显式选择不会被应用类型
  同步覆盖，终端关闭确认期间释放原生浏览器 viewport。规则以
  [浏览器多实例技术设计](./browser-tabs-technical-design.md) 为准。
- 删除普通浏览器操作的自动截图、固定等待、重试及 JPEG 状态缓存/IPC 字段，保留显式截图。
- 整合复核补齐现有 32 页签容量处理与 Harness 代理的已发现工具复用。新增容量回归验证
  满额时布局仍有效、页面保留，关闭一项后显示原页面；Harness 回归验证发现接口后续失败时
  已知工具调用不再触发发现。相关三文件 66 项通过，最新 typecheck 与 lint 通过。
- 工作区聚焦测试 43 项通过、2 项需大小写敏感文件系统而跳过；IPC 与 Sidebar 聚焦回归
  132 项通过。随后新增的 Ask 指令、继承 Runtime 用量持久化及计划模式 App 场景，3 项通过。
- 扩展真实 Electron/MCP E2E 在独立临时 profile 通过：四个未使用的请求预留不创建会话、
  WebContents 或 UI 事件；首次 MCP 导航物化相同 Tab/工作栏身份，恢复不额外创建页面，
  并验证独立页面、共享 Cookie、当时的请求租约关闭保护和清理；关闭保护已于 2026-09-13 移除。
- 当前源码的共享 Linux x64 Host 验证已通过，覆盖工作区目标保护和重命名/Git Diff，
  并通过桌面托管 ACP → 隔离 Agent → OpenCode 完成 Ask/Execute 和继承 Runtime 指标持久化；
  该组共 3 次真实模型调用，清理后无所属进程残留。完整记录见
  [远程 Host 开发验证](../remote-host/technical-design.md#agent-开发期间的真实-host-验证)。
- 最终整库 `npm test` 为 341 个文件通过、9 个文件跳过，3839 项通过、66 项按平台或手动
  条件跳过、0 失败；`npm run typecheck`、`npm run lint`、开发期 `npm run build` 和
  `git diff --check` 通过，19 份修改 Markdown 的相对链接目标检查通过。
  先前整合中的一轮为 3823 项通过、6 项失败、66 项跳过，另有被移动的测试路径加载失败，
  不作为最终结果；源码稳定后完整重跑得到上述全绿结果。
- 原文档解析焦点回归改为等待 Modal 的焦点效果，保留焦点与背景隔离断言，没有改动产品逻辑。
- Windows 独立 Electron profile 的完整 App → Preload → Main UI 验证通过；最终复测使用
  本轮最终开发构建。启用浏览器后普通 Execute 没有创建原生浏览器视图，工具导航只创建
  一张同时显示在工作栏的页面，跨会话选择保留原页面与 viewport。
- 实际终端连通后，从浏览器关闭该终端可正常显示确认并操作按钮；原生视图可见性按
  可见 → 确认时隐藏 → 取消后可见变化，终端关闭清理完成。无效地址 `http://` 被拒绝后，
  原控件可重试有效地址并关闭页面；关闭端口返回了过滤代理错误页，因此该 UI 场景不作为
  Chromium `loadURL` 拒绝的实机证据。服务与 Renderer 释放绑定回归另有自动测试覆盖。
- 桌面使用确定性 loopback 模型服务驱动真实生产路径，共 24 次本地 completion 请求，
  未发出外部模型请求；可选真实 Provider 探针没有找到已加密保存的 OpenAI 兼容文本连接，
  未据此宣称桌面真实模型验收通过。Ask 与编程 Subagent 的桌面结果见
  [直连模型验收记录](../direct-model-agent/progress.md#2026-09-10-提交审查后的桌面-ui-验收)。
  测试应用与具名浏览器会话已退出，所属 Electron/Node 进程及 fixture 监听端口均为 0；
  临时截图和隔离 profile 保留在本机测试目录，不进入仓库。

## 2026-09-10 固定基础页签与浏览器多实例

- 工作栏注册表已分别声明实例策略、默认上下文、默认打开、必须存在、可关闭和排序属性。
  任务中心与工作区保持默认存在且不可关闭；浏览器改为当前 Conversation 上下文的多实例。
  布局加载按 `required` 补回缺失的基础页签，并修复失效活动实例。
- 任务中心增加“当前项目”“全局任务”“全部项目”范围，默认跟随活动项目；任务和审批按
  Conversation 所属项目过滤，范围模式随工作栏布局持久化。
- 浏览器服务已拆分 Conversation Context 与 Browser Tab。每个 Tab 拥有独立页面、Driver、
  操作队列、状态和元素引用空间，同一 Conversation 的 Tab 共享 partition、代理和 Cookie。
- Renderer 使用工作栏实例 UUID 原子创建或恢复 Browser Tab，并以 UUID viewport token 防止
  延迟 cleanup 隐藏新活动 Tab。关闭单个实例只释放对应 Tab。
- 直连模型和请求级 MCP capability 在请求开始时优先绑定可见 Tab，其次绑定 primary Tab，
  并持有使用租约。当时绑定 Tab 拒绝关闭，该行为已于 2026-09-13 改为允许关闭和显式导航恢复；工具参数未增加模型可见
  `tabId`，已有浏览器工具 schema 保持不变。
- 聚焦回归命令覆盖 Shared、BrowserService、Electron Session、IPC、Preload、MCP、Renderer
  和 Workbar，13 个测试文件共 453 项通过；`npm run lint` 与 Web TypeScript 检查通过。
- `node build/run-browser-tabs-electron-e2e.cjs` 通过。该测试启动真实 Electron/Chromium 和本地
  HTTP 页面，创建两个 `WebContentsView`，验证页面隔离、同 Conversation Cookie 共享、真实
  loopback MCP 的固定 Tab 导航与快照、当时的使用租约关闭保护，以及单 Tab 和最终 Context 清理。
- `npm run typecheck`、`npm run lint`、`npm run build:bundle` 和 `git diff --check` 通过。
- 本轮整库 `npm test` 为 3686 项通过、61 项跳过、4 项失败。失败位于 portable/release 的
  ASAR 元数据 fixture、Runtime 版本探测和 DeepSeek Harness 的本地 MCP fixture；定向复跑仍
  失败。本次工作栏、浏览器、IPC 和 MCP 聚焦回归均通过，不将整库结果记为通过。

## 2026-09-09 移动目录选择与 Git 控件修正

- 本轮在已有文件管理改动上修正 [FR-W3、FR-W4、FR-W6](./prd.md#76-工作区)：
  本机移动调用创建项目使用的 `settings.selectWorkspace()`；远程移动调用
  `sshHosts.browseDirectories()`，按项目 Host 浏览。所选目录映射为工作区相对目标，
  保留原名；取消不提交移动，外部目录在弹窗内提示限制。
- 取消、分支、Fetch、历史展开和提交行接入共享控件样式；删除菜单项左对齐。
  远程目录列表限制滚动高度，保留加载、空目录、失败和截断提示。
- `npm test -- src/renderer/src/WorkspaceFilesPanel.test.tsx src/renderer/src/RightAssistantSidebar.resize.test.tsx src/main/workspace/workspace-management.test.ts src/main/ssh/ssh-host-directory-browser.test.ts`
  通过 56 项，覆盖本机目录选择桥接、Windows 与 POSIX 目标映射、取消与越界选择、
  远程 Host 和目录参数、取消未完成的浏览，以及 Git 控件与真实文件管理服务。
- `npm test -- src/renderer/src/App.test.tsx -t "workspace|stale Git|opens the global assistant sidebar"`
  通过 12 项。工作栏切换测试改为等待项目目录加载后出现刷新按钮。
- `npm run typecheck`、`npm run lint` 和 `git diff --check` 通过。
- 本轮整库 `npm test` 完整运行 944 秒，3642 项通过、61 项跳过、6 项失败。
  工作栏加载时序断言已修正并定向复测通过；其余 5 项涉及 Agent 离线依赖测试超时、
  DeepSeek Harness MCP 加载、Runtime 版本探测，以及 portable/release 打包产物检查。
  未再次运行整库测试，不记为整库通过。
- 隔离 Electron 窗口加载当前源码组件和 CSS，检查浅色、深色主题下 300px、420px 工作栏：
  无横向溢出，分支与 Fetch 同行，提交行左对齐；移动弹窗没有路径输入框，取消为次按钮，
  删除项计算样式为左对齐。截图保留于本机临时验证目录。此检查使用桥接替身，未自动操作
  系统原生目录对话框，也不替代完整应用中的人工验收。
- 尝试从隔离 Electron 配置调用真实 SSH 目录浏览服务时，已有凭据在
  `safeStorage.decryptString` 解密失败，尚未建立 Host 连接。真实远程目录选择验收仍受阻；
  未修改用户配置或远端文件，本轮未调用真实模型。

## 2026-09-09 文件管理与 Git 工作区扩展

- 已只读核对根目录规范、UI 设计系统、目录浏览组件、WorkspaceAccess 与 Agent 协议。
  本轮范围定义于 [PRD 工作区 FR-W1 至 FR-W6](./prd.md#76-工作区)。
- 当前生产路径具备目录、属性、文本预览和工作树 Diff；Agent 的写入及 Git operation
  仍是只读拒绝接口。文件管理、分支与提交历史尚未实现或验证，不能视为完成。
- 待完成源码实现、整库 test/typecheck/lint、真实桌面路径与当前源码 Linux Host 验证。
  本轮开始前已有浏览器与工作区未提交改动，保留这些改动；不提交或推送。

## 2026-09-09 工作区页签交互

- 已核对当前工作树中的 `RightAssistantSidebar.tsx` 和 `WorkspaceFilesPanel.tsx` 差异：
  文件预览期间目录树保持挂载，接入返回位置与焦点恢复、文件与未提交更改分段视图、
  目录就地重试，以及文件预览和 Diff 操作。行为定义见 [PRD 工作区](./prd.md#76-工作区)。
- `npm test -- src/renderer/src/RightAssistantSidebar.resize.test.tsx src/renderer/src/WorkspaceFilesPanel.test.tsx`
  通过 35 项，覆盖目录展开、返回位置与焦点、视图选择、刷新失败保留内容、Markdown
  源码切换，以及切换项目后丢弃未完成的文件预览。
- `npm test -- src/renderer/src/App.test.tsx -t "workspace|stale Git"` 通过 11 项，
  覆盖应用中的文件预览、路径复制、默认应用打开、返回和任务结束刷新。
- 本轮 `npm test` 完整运行结果为 3629 通过、61 跳过、5 失败。失败位于 Agent 离线
  依赖打包超时、DeepSeek Harness MCP 加载、Runtime 版本探测，以及两个打包产物检查，
  不将该结果记为整库回归通过。
- `npm run lint` 和差异空白检查通过。最新 `npm run typecheck` 被同时进行的浏览器
  接口变更阻塞：测试替身缺少 `hide`、`setBounds`、`setViewport`，部分侧栏测试仍传递
  已移除的浏览器回调。该轮类型检查未通过，未改动另一项任务的接口或测试替身。
- 尚未进行真实桌面视觉验收；组件测试的滚动断言不代替实际窗口中的布局和滚动检查。
- 范围仅限工作区页签，不包含项目文件搜索或其他页签改动。

## 2026-09-09 托管 Runtime 并行阻塞

- Windows 完整隔离测试程序通过界面发送 OpenCode 原生双子代理、直连与 Continue 文件
  任务；随后三路上游请求在 917 ms 内发出并重叠，全部完成。普通并发没有复现全局排队。
- 在同一程序中，让真实模型执行一次 4,000 行、约 98 KB 文件的 CRLF → LF 转换，
  同时运行另一个会话。原生进程的无凭据存活探针两次延迟 3,301 ms、3,085 ms；
  原生热线程持续使用 CPU，而 Main 没有同步满载。操作不是模拟事件或直接调用
  Runtime 的脚本，模型请求来自实际输入框和发送按钮。
- 托管 OpenCode 关闭未消费的自动 Git 快照后，完整程序重复相同操作和并行会话，
  90 秒观察中的最大原生探针延迟为 210 ms，没有超过 500 ms 的探针，两条请求均完成。
  该对照验证已复现的快照阻塞得到消除，不声称已经证明历史 90–125 秒事件的唯一原因。
- Continue 的实际 Electron 原生宿主在不排空 stdout 时被注入的 128 KiB 输出阻塞；
  使用当前生产适配器后，输出在 5 ms 内完成，20 次状态读取全部成功，最大 5 ms。
  这证明管道修复有效，不代表普通启动约 640 字节的输出就是历史卡顿原因。
- 修复版完整程序再次完成原生双子代理与 Continue 文件任务，实际请求重叠，三个页面
  都通过计数按钮功能检查。Windows 诊断与程序验证合计 40 次成功模型调用；
  另一次 UI 请求返回账户额度不足的 402，用户充值后才继续，没有把失败当成通过。
- 当前源码 Linux x64 Agent 经桌面生产管理链路完成 Ask 读取和 Execute 换行转换，
  共 4 次成功模型调用；最终原生配置确认 `snapshot: false` 且权限仍为 `ask`/`allow`。
  此验证覆盖实际 Agent、模型桥、工具完成和关闭，不量化 Linux 提速，也未注入取消。
- 定向回归先验证 7 项失败，再验证 124 项通过、5 项 Windows 平台跳过；
  全项目类型检查和修改文件 lint 已通过。首次全量回归为 3625 通过、1 失败、61 跳过；
  失败来自生命周期测试的包装流在底层 reader 关闭后仍计数为打开，已通过独立流实验
  复现并改为观察 `reader.closed`，没有因此修改生产取消逻辑。最终候选全量回归为
  3626 通过、0 失败、61 跳过，`npm run typecheck`、`npm run lint`、
  `npm run release:notes:verify`、差异空白与文档相对链接检查通过。本机和远端的
  测试进程已回收，安装版和正式 Host 环境未改动；正式发布仍需候选 CI 与资产核实。
  运行策略见
  [托管 Runtime 并行与输出](./runtime-interactions.md#托管-runtime-的并行与输出)。

## 2026-09-08 消息底部请求状态

- 已接入本机 OpenCode 父会话的原生重试等待及开始事件；直连模型把退避等待与实际发起
  重试分开显示，Continue 初始文案改为中性的请求处理。显示规则和未接入边界见
  [消息底部请求状态](./runtime-interactions.md#消息底部请求状态)。
- 消息底部按真实事件显示准备、工具、待回答及终态；有新进展时清除旧状态，结束后不
  接受迟到状态覆盖。仅该处状态点改为静态，会话列表闪点、发送和停止按钮未改动。
- Windows 隔离开发桌面通过实际 UI 发送验证 OpenCode 的 503/Retry-After 等待、
  原生重试开始、真实模型回复与完成；直连模型通过派发前连接拒绝、500 ms 等待、
  重试、真实回复与完成。故障由本机测试代理注入，不冒充服务商实际故障。
  三个隔离测试配置总计 5 次真实文本模型调用；另有一次直连重试被测试代理的调用
  上限明确拒绝，界面正确显示失败，最终单次补测完成。未执行用户命令或修改安装版。
- DOM 状态记录确认底部无闪烁、完成后无旧重试文案，浅色截图可见原生重试计划与原因；
  底部 WCAG 2 A/AA 定向检查无违规。最小化窗口的补充截图超时，未作为通过证据。
  隔离窗口及测试代理已结束。
- 最终 `npm test -- --reporter=json --outputFile=<临时报告路径>` 为 3618 项通过、
  0 项失败、61 项按平台或手动条件跳过；首轮的压缩状态旧断言已修正，途中被用户中断
  的运行不计为通过。`npm run typecheck`、`npm run lint`、
  `npm run release:notes:verify`、差异空白与相关文档相对链接检查通过。

## 2026-09-08 Desktop 0.12.8 安装包修复

- 真实 `0.12.7` 安装目录确认 OpenCode 配置缺少整个 `node_modules`。新增测试调用实际
  electron-builder 资源复制器，复现相同 ENOENT；把复制源上移到 `.runtime-resources`
  后，插件及传递依赖逐文件复制验证通过。
- 真实安装的 DSH bootstrap 存在 `dsh-session-projection` 外部导入，而 Host 解包目录没有
  对应依赖。将其加入 Vite bundling，配置回归从失败转为通过；最终包会拒绝同类外部导入。
- Windows x64 CI 已接入包内 OpenCode 插件导入、真实 DSH UtilityProcess 握手及 npm
  探针，位于解包目录清理和发布之前。用户要求不做本地打包；CI 探针结果尚待本候选执行，
  不能把当前源码回归通过当作真实发布包已通过。
- 本次不改变 Agent `0.11.21` 源码或包。macOS 改为 DMG-only，用户明确接受旧版客户端
  手动升级影响；格式与发布规则见[发布手册](../../development/release-runbook.md)。

## 2026-09-08 Execute 目录权限等待修复

- 本机 OpenCode 的内部配置显式允许默认工具权限；每次 Ask 仍设置 deny-all 会话规则并
  禁用工具，当前请求精确分配的只读能力例外。Execute 不把 Workspace 当作目录边界。
- `permission.asked` 不再忽略所有非父会话事件。Main 用 OpenCode Session 的 `parentID`
  确认属于当前请求的子孙会话后按当前模式回复；其他并行会话不受影响，同一请求只回复
  一次。子会话权限不伪装为父会话中的待完成工具。
- 真实 OpenCode `1.18.9` 和候选 `1.18.29` 均已通过本地确定性模型驱动的原生 Task
  工作区外读取回归；同一 Runtime 的 Ask 仍不暴露文件与命令工具。
- Continue `1.5.47` 的真实 CLI 已通过 Execute Shell 写入工作区外测试文件；DSH 固定
  Host 已通过 Execute 工作区外写入、随后 Ask 拒绝同一写工具，未增加权限策略或人工审批。
- 真实 OpenCode `1.18.29` 已完成原生 Task 后的 yes/no 与自由文本问答回传；父、子会话
  提问及后台任务不能交互时的失败路径均有回归测试。Continue 真实 `AskQuestion` 暴露了
  QuizService 扁平数据结构与原适配器不一致的问题，现已按锁定版本修正；真实自由文本
  回传、yes/no、选项及跳过均验证通过，自定义答案不再误标为选项。
- DSH 活跃 Execute 的 ACP 权限回调不再等待第二次 authorizer，Ask 继续拒绝；未添加
  通用业务问答工具或从终端日志猜测确认意图。完整范围见
  [Runtime 交互边界](./runtime-interactions.md)。
- 当前源码 Linux x64 Agent 通过签名组包、生产安装、真实 Ask/Execute、原生子代理
  工作区外写入、重连同一 daemon 和 stop/bootstrap。实机回归同时定位并修复了握手
  Base64URL 响应误用 ID 校验及断流未结算等待；13 项 Unix 原生端点测试和连续 20 次
  握手通过。两轮真实模型调用合计 10 次，均 completed；本轮测试 Agent 已停止。
- 最终完整回归使用 `npm test -- --reporter=json --outputFile=<临时报告路径>`，并通过
  `GOODBUDDY_TEST_OPENCODE_BINARY` 指向已验证版本的候选 OpenCode。结果为 338 个文件、
  3597 项通过、0 项失败、61 项按平台/手动条件跳过，报告 `success=true`、退出码 0；
  Windows 跳过的 Unix 端点场景另在 Linux Host 运行了上述 13 项原生测试。
- 最终 `npm run typecheck`、`npm run lint`、`npm run release:notes:verify` 和差异空白检查
  通过，相关 Markdown 相对链接有效。此前失败、暂停及控制台截断的回归记录由本次完整
  JSON 报告覆盖，不代表仍有测试失败。未执行系统休眠/唤醒或本地桌面生产构建、打包；
  后续发布仍需对应候选的 CI 构建和跨平台验证。

## 2026-09-08 OpenCode 复用与原生控件恢复

- `OpenCodeRuntime` 仅在没有活动请求时探测缓存的 embedded server；活动对话或
  Compact 期间直接复用服务，避免新会话的一次短探测失败关闭其他会话正在使用的进程。
  空闲探测失败时仍清除旧 client 和会话映射并重建；并发调用共享检查与重建。
  进程退出或服务关闭会中止绑定它的对话与 Compact，事件流重连等待也可立即取消，
  请求明确报错，不自动重放已执行命令。本次修复后的真实模型验证共 6 次：正常并发、
  已复现场景下的共享服务保护均正常完成；主动结束测试进程后旧请求明确失败，新请求
  在替换服务上完成。此前“新会话完成、旧会话持续等待”的故障不再出现。
- 请求级 MCP 注册与断开通过实例内 `mutateMcp` 队列串行执行。仅实际发出 `mcp.add`
  的名称进入清理列表；注册尚在排队时取消不追加断开。断开的 1 秒超时从出队后开始。
- `App` 按本机/远程、连接方式、项目和 Runtime 选择组成 scope 缓存原生清单，用请求
  代次阻止旧 scope 结果回写；同 scope 会话刷新不清空重取，切换会话重置消息级选择，
  Runtime 切换状态也按 generation 隔离。清单请求失败或返回 `unavailable`/`partial`
  时保留已有可用缓存并有界重试；没有可用缓存时保留新返回的部分数据，因此
  `unavailable` 重试为可用 `partial` 后可显示 Agent 和 Command。

验证记录：首轮定向测试 273 项通过、5 项跳过；补充修复后的 Runtime 与生命周期测试
77 项通过，界面定向测试 6 项通过，类型检查通过。修复前的 lint 检查通过。
全量测试超过 120 秒被终止，期间出现一项 DS 本地 stdio MCP 测试失败，尚待定位。
这是当次历史结果。后续发布前修复与实机验证见本文上方及
[远程主机技术设计](../remote-host/technical-design.md)；真实系统休眠恢复仍未完成验证。

## 2026-09-06 项目工作区

范围见 [PRD 工作区](./prd.md#76-工作区)。

当前源码已移除重复标题与底部完整 Diff 入口，使用彩色 Git 状态字母，点击更改项读取
单文件 Diff。已暂存与未暂存差异分开展示；本机 Git 测试覆盖无首次提交、未跟踪、
暂存后继续修改、重命名、删除及包含方括号的路径。Git 刷新驱动目录树重新读取，保留
展开状态；SSH 项目不提供本机系统打开按钮。审查后补齐了当前 Diff 随刷新重读、
旧请求结果失效，以及超过 50 项变更的继续加载入口。

验证记录：

- 最终 `npm run typecheck`、`npm run lint`、`npm run build` 均通过。
- 工作区专项 7 个测试文件复跑：317 项通过，3 项 Linux 专用测试在 Windows 跳过。
  任务完成测试同时检查目录树出现新文件。
- 最终 `npm test`：326 个测试文件、3552 项测试通过，9 个文件、58 项测试按既有条件
  跳过。复核首轮曾有一项浏览器地址草稿测试超时，单独复跑及最终全量复跑均通过；
  更早的超时/失败记录不再作为最终验收结果。
- 后续复核已通过既有凭据和固定 Host Key 经 VPN 连接共享 Linux x64 Host，使用当前
  源码构建的隔离 Agent 包安装并启动。真实 `RemoteWorkspaceAccess → Agent git/status`
  与 `git/diff` 路径覆盖暂存后继续修改、删除、重命名、未跟踪和方括号路径；均通过。
  Git 验证未调用模型。
- Windows 隔离桌面实例已通过真实点击验收：当前项目单文件暂存/工作树 Diff 分组与
  增删颜色正确，修改测试文件后点击刷新可更新正在查看的 Diff，53 项变更经加载更多
  全部可访问。截图留在本地验证目录，不纳入产品包。

目录分页、任意目录切换和 HTML 预览不在本轮改动范围内。
