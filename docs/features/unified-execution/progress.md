# 进度与证据

## 2026-10-05 K07/K08 局部修复

最终集成补注：排除并行删除功能后，待提交内容的隔离全量测试为 6,212 项通过、0 失败、87 跳过，类型检查及 lint 通过。下文分组阶段的失败轮次不是最终结果；完整证据见[KISS 验收](../../review/kiss-local-fixes-2026-10-05.md#最终检查)。

K07 已修复共享 Runtime 在模型路由清理阶段阻塞控制队列、取消后迟到安装留下路由的
问题。broker 关闭与终态提交顺序保留，原生路由撤销在队列外完成；迟到安装按原
transport／Session／operation 再次清理。transport 退出中止未完成路由 HTTP 请求。
规则见[Session 所有权](../assistant-workbar/runtime-process-reuse-technical-design.md#61-连接与所有权)。

K08 在监督正文超容量时立即取消，清空正文并只消费用量事件，清理等待上限 1 秒。
原容量错误优先于后续流错误与超时，不重试、不重复记账；超时以后返回的事件不写库。
该路径由桌面直连模型执行，远程项目的监督也使用同一实现；具体用量规则见
[监督模型调度](../conversation-supervision/technical-design.md#模型阶段超时与调度)。

### 回归与检查

首轮七项持久回归在修复前全部失败：取消／截止时间后的 peer 查询仍等待路由释放，
迟到安装残留，OpenAI／Anthropic 已收到的 12 input／3 output 用量丢失，以及超限后的
记账消费与清理边界不符。修复后增加缓冲完成响应、transport dispose／exit 回归，
共十一项新增用例通过。检查取消终态只有一条、peer 仍 running、无重复 Prompt、
用量只有一个 call，以及迟到事件不会在池槽释放后写入。

```text
npx --no-install vitest run src/main/assistant/supervision-model-retry.test.ts src/main/assistant/supervision-production.test.ts src/main/agent/model-runtime.test.ts src/agent-daemon/runtime-acp-backend.test.ts src/agent-daemon/agent-owned-acp-prompt.test.ts src/agent-daemon/protocol-server.test.ts
npm run typecheck
npm run lint
```

上述六文件 243 项通过、1 项跳过；12:22 的 Main／Agent／Renderer 类型检查及全仓 lint 通过。
并发工作树的完整 `npm test` 为 6,214 项通过、5 项失败、87 项跳过，耗时 870.20 秒；
失败位于监督布局、IPC 的 provider 重试、监督恢复和快照读取测试，K07/K08 文件均通过。
原始输出为批准临时目录中的 `k07-full-tests-1791174423486.log` 及同名 `.json`。
这轮结果不能当作全仓验收通过；未修改其他任务负责的数据库、IPC 或界面文件。
12:45 单独复跑 IPC provider 场景通过（1 项通过、190 项按筛选跳过）；期间其他任务仍在
修改测试，后一次类型检查报 `supervision-ui-reads.test.ts` 的 `publishing` phase 类型
错误。最终整体检查需由合并工作树的负责方复跑，不能用本模块的通过结果替代。

### Linux x64 当前源码

复用前阶段 `a01-runtime-host` 的凭据与 SSH 固定身份入口，仅以 esbuild 生成当前
Desktop driver、Agent daemon 和 CLI/helper 测试 bundle。使用 Host 已安装的原生
OpenCode／Continue，在 `/root/tmp/gb-lifecycle-*` 专用目录运行，未安装生产包或更换
Host current。阻塞点只由 harness 注入；路由安装、撤销及 409 缺失校验通过真实 helper。

| 场景 | peer 查询 | 取消完成 | 外部文本 HTTP 请求 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 首轮 OpenCode | 51 ms | 206 ms | 2 | 取消及迟到路由清理通过；后续工具恢复触及旧夹具的两次调用上限 |
| 最终 OpenCode | 13 ms | 176 ms | 3 | peer 完成、工具执行、detach／恢复、测试 Agent 提升、终态重放通过 |
| 最终 Continue | 46 ms | 194 ms | 3 | 同上 |

准确合计 **8 次外部文本提供商 HTTP 请求、0 次图片提供商调用**，八个响应均 HTTP 200。
最终每个 Runtime 包含一次短文本 peer 调用和两次工具／恢复调用，预算在 harness 中
显式设为三次；被取消的启动未调用提供商。三个运行结束时所属进程均为 0，额外的
只读 SSH/SFTP 检查确认本轮时间范围内的专用目录残留为 0，该检查新增模型调用 0 次。
延迟是单次场景观察，不作为 p95 或桌面性能预算结论。

最终 Host 事件通过现有批处理器和隔离 SQLite 校验：OpenCode 41 条事件、21 个
checkpoint；Continue 16 条事件、8 个 checkpoint；重放去重通过。没有读写用户生产库。

原始脚本位于 `C:/Users/jiang/AppData/Local/Temp/opencode`：
`k07-runtime-host-build.cjs`、`k07-runtime-host-run.cjs`、`k07-host-cleanup-build.cjs`。
日志位于其 `k07-runtime-host/` 子目录：`opencode-1791173985798.log`、
`opencode-1791174187014.log`、`continue-1791174187010.log`、`inspect-1791175306647.log`。
验证不覆盖签名安装包、macOS、Linux arm64、完整 UI 操作或生产规模性能；远程修复需
部署包含本次源码的 Agent，当前未提交或发布。

## 2026-10-05 Runtime 生命周期审查修复

A01（远程启动阻塞控制队列）和 A02（本机 OpenCode 提交失败后等待静默 SSE）已修复。
远程启动等待释放 backend 控制队列及协议接收分派，取消、watchdog、关闭和其他
binding 可以继续处理；Session owner 合并相同启动、拒绝冲突，并关闭取消后迟到的
原生 Session。本机提交错误立即唤醒所属 SSE 消费，保留原错误和既有 Session 取消。
两条实现均未增加整个 Prompt 的默认总时限；共享进程、终态提交和写帧顺序规则见
[Runtime 进程复用设计](../assistant-workbar/runtime-process-reuse-technical-design.md)。

### 确定性复现

持久回归中，本机拒绝、错误响应、10 ms 提交超时三种情况在旧代码经过 100 ms
假时钟后仍未结算；远程共享进程中的第二个 Session 启动被挂起时，旧代码经过
200 ms 后，取消/截止时间和同进程另一 binding 的查询均未结算。上述五项先运行旧
实现，全部按这些断言失败。真实 Host 首轮还定位到协议 dispatcher 串行等待启动
响应，新增帧级回归在修复前只分派 `start`，没有分派后续 `cancel` 和 `peer`。

修复后的九项新增回归通过，另覆盖启动 watchdog、默认关闭时限、相同启动重放及
冲突。共享 peer 保持 running；迟到 Session 收到自身的 `session/close`，取消的
启动不发送 Prompt。原始审查探针曾在 131 秒假时钟后观察到启动、取消、peer 查询
仍等待，默认 10 秒 dispose 报超时且 stop 次数为 0，现有关闭与 watchdog 回归不再
等待原生初始化响应。各假时钟值是确定性边界，不是系统性能测量。

### 当前源码实机验证

复用已有 lifecycle harness，用 esbuild 重建当前 Desktop driver、Agent daemon、
CLI/helper；凭据从 GoodBuddy 已有加密配置的临时副本加载，SSH 校验已固定 Host
identity。共享 Linux x64 经 `192.168.0.23` 连接，只使用 `/root/tmp/gb-lifecycle-*`
专用目录和所属进程，未替换原 Host 安装或修改无关数据。

| 场景 | 实际结果 | 真实文本提供商调用 |
| --- | --- | ---: |
| 首轮 Host 启动挂起 | backend 修复后，协议 dispatcher 仍阻塞；测试退出后所属进程为 0 | 0 |
| OpenCode 启动取消及工具、detach、controller 恢复、测试 Agent 提升、重放 | 启动响应被挂起时控制查询 48 ms、取消 216 ms；工具与恢复完成；两个提供商响应均 HTTP 200 | 2 |
| Continue 同场景 | 控制查询 60 ms、取消 258 ms；工具与恢复完成；两个提供商响应均 HTTP 200 | 2 |
| Windows 当前源码 OpenCode 普通文本 | 真实原生二进制经有界 loopback 转发访问已配置模型，返回 `LOCAL_RUNTIME_OK`，0 工具调用；总耗时 4,727 ms | 1 |

本轮合计 **5 次真实文本提供商调用、0 次图片生成调用**。两次本机脚本准备失败发生在
SDK 动态加载阶段，均为 0 次模型调用，随后修正测试 bundle 并通过。所有成功场景均
使用最终相关生产源码。Host 启动取消阶段各为 0 次模型调用，最终所属残留进程均为 0，
专用目录由 harness 清理；本机 Runtime 和凭据临时副本也已清理。

真实数据检查使用本轮原生工具和模型产生的事件：OpenCode 45 条写入、23 个 checkpoint，
Continue 16 条写入、8 个 checkpoint，经生产 `AssistantDatabase` 和
`RemoteEventBatcher` 写入隔离 SQLite，再重放确认全部去重。未迁移、改写用户生产
历史库，也未以构造事件代替本轮 Host transcript。

原始脚本和日志位于 `C:/Users/jiang/AppData/Local/Temp/opencode`：
`a01-runtime-host-build.cjs`、`a01-runtime-host-run.cjs`、`a01-runtime-host/`，以及
`a02-local-model.ts`、`a02-local-model-run.cjs` 和 `a02-local-model-1791142126078.log`。
Host 成功日志为 `opencode-1791141713375.log`、`continue-1791141785721.log`。
延迟为各场景一次实测，不宣称吞吐、p95 或完整桌面性能提升。

### 检查命令与边界

```text
npx vitest run src/agent-daemon --testTimeout=30000 --hookTimeout=60000
npx vitest run src/main/remote-agent src/main/agent/acp-remote-runtime.test.ts src/main/agent/runtime-controller.test.ts src/main/agent/local-runtime-registry.test.ts --testTimeout=30000
npx vitest run src/main/agent/opencode-runtime.test.ts
npx vitest run src/main/agent/opencode-runtime-lifecycle.test.ts --testTimeout=30000 --hookTimeout=60000
npm run typecheck
npm run lint
```

四组测试分别为 323 通过/33 跳过、393 通过、156 通过、4 通过，共 876 项通过；
typecheck、全仓 lint 和修改范围 `git diff --check` 通过。初次合并运行中，既有
OpenCode `cleanup-timeout` 用例失败一次；该用例独立复跑及随后完整 OpenCode 文件
复跑通过，未改动该用例或相关产品清理逻辑。较早 Main 类型检查的并发监督者 fixture
错误在最终全仓检查时已消失。

验证覆盖当前源码、真实 Windows OpenCode 二进制和共享 Linux x64 Host，不含签名包
安装验收、完整 UI 点击、macOS/Linux arm64 或用户生产大库性能测试。首轮定向验证
未运行全仓 `npm test`，后续完整检查见下节；远程更新仍须部署包含本次源码的 Agent，
未提交或发布。

### SDK cleanup-timeout 复查

后续全仓验证为 6,130 通过、1 失败、87 跳过，唯一失败是 OpenCode SDK
`cleanup-timeout` 用例。复查通过独立 Node 子进程的十轮显式 GC 和受控取消复现：
旧 fetch 替身只保存 `request.signal`，返回永不结算的 Promise，没有在途 Request
所有者或 abort 处理。Request 及 Undici 内部 AbortController 被回收后，外层超时
signal 已中止，保存的 Request signal 仍未中止。真实 loopback fetch 在同样 GC
条件下保留 Request，取消后 SDK 返回错误，未观察到产品清理提前完成。

修正仅涉及测试：挂起的 fetch 替身在 abort 时以 `request.signal.reason` 拒绝，
闭包保持 Request 存活至取消。原有 `signals.every(signal => signal.aborted)`、调用
顺序、错误脱敏及超时均保留。新增 GC 回归在旧替身上稳定失败，修正后通过；九项
SDK 定向用例、Main 类型检查及该文件 ESLint 通过。本次跟进新增外部模型调用 0 次，
生产代码与远程 Agent 路径均未改动，无需重新执行 Host 模型验证。

修正后的完整 `npm test` 于 04:00:22 开始，852.63 秒完成，退出码 0：518 文件通过、
15 文件跳过；6,136 项通过、0 失败、87 跳过。计数包含并发工作树中的其他修复。
原始记录为 `C:/Users/jiang/AppData/Local/Temp/opencode/a02-cleanup-final-20261005.log`
及同名 `.json`；GC/真实 loopback 对照脚本为该目录的 `a02-cleanup-gc-probe.mjs`。

## 2026-10-04 调研与设计

调研阶段，用户确认彻底移除 Ask / Execute，包括界面、原生工具与 MCP 限制，并允许升级清理历史模式字段。该阶段先交付文档，随后用户确认删除安全设置并授权实施；实现结果见下文。

已完成只读源码调研：共享合同、Renderer、Main IPC、Model/OpenCode/Continue/Harness、原生客户端、Agent/桥接/辅助程序、图片工具、子代理、通道、队列、日程和数据库迁移入口。具体路径见[源码调研](./source-audit.md)与[数据迁移](./data-migration.md)。历史检索未返回相关存储决策，设计依据为当前会话要求与源码。

调研基于有未提交改动的工作树，不对应冻结的发布提交。记录到 Desktop 版本 0.15.10、数据库 schema 59、Agent wire 2.0 和 runtime/acp capability 5；实施前须重新检查并发变更。

## 已知工作树改动

本会话较早阶段按“Ask 仅提供只读工具”的旧方向修改了浏览器权限、网关分类、IPC 发放及相关测试。该方向已被完全移除模式的需求替代，后续源码改造已清理这些模式条件。

旧方向的聚焦测试曾报告 280 通过、1 跳过，类型检查与 lint 通过；这不构成本功能的验收证据。当时发现的 Model/Continue 上层授权分支和图片服务模式检查已在本次实现中移除。

工作树另有并发的任务统计、监督者、界面和文档改动，均不属于本次移除实现。未对其回退或覆盖。

## 2026-10-04 当前实现与定向验证

主要源码改造已落地，最终类型检查、lint 与生产构建通过。全量测试和后续定向复跑结果见“最终集成检查”；当前不声称全仓测试全绿。

| 技术设计阶段 | 状态 | 剩余工作 |
| --- | --- | --- |
| P1 合同与迁移 | schema 60、Runtime 设置 22 及无模式合同已实现；合成回归 44 个文件、538 项通过，见[迁移记录](./data-migration.md#8-本地存储验证) | 真实旧库与未声明历史形状取证 |
| P2 本地执行 | Model、OpenCode、Continue、Harness 模式分支及一般工具审批已移除；内部无工具构造保留 | 全量测试及各平台最终验收汇总 |
| P3 各入口与原生客户端 | 队列、日程、通道、委派、子任务及原生配置已改为无模式 | 外部委派服务、原生客户端发布包矩阵 |
| P4 远程协议 | runtime/acp 6 与当前源码真实 Linux Host 定向验证通过 | 配套签名包重建、升级与发布矩阵 |
| P5 界面与文档落地 | 模式与安全分类已删除；清除数据搬迁后的 Electron 定向验证通过 | 中英文、主题、键盘完整矩阵及最终文档汇总 |

### 真实 Host

原始证据：`C:/Users/jiang/AppData/Local/Temp/opencode/unified-execution-host/validation.md`。基于并发工作树，用 esbuild 重建 Desktop driver、Agent daemon 与 CLI/helper，连接共享 Linux x64 Host，在专用目录测试；上游 OpenCode/Continue 工件使用 Host 已安装版本。这是源码开发验证，不是签名包或发布验证。

| 场景 | 真实模型调用 | 实际结果 |
| --- | ---: | --- |
| OpenCode 无模式请求及进程重建后的原生历史 | 2 | 通过 |
| Continue 无模式请求及进程重建后的历史 | 2 | helper 原生模式修正前通过 |
| OpenCode 原生工具、detach、controller 恢复、测试 Agent 提升及重放 | 2 | 通过 |
| Continue 取消及新请求 | 2 | helper 原生模式修正前通过 |
| Continue 原生工具/detach 首次尝试 | 1 | 失败：没有 running tool 事件，helper 选择了原生 chat/`--readonly` |
| Continue 原生工具、detach、controller 恢复、测试 Agent 提升及重放 | 2 | helper 改为原生 agent 后通过 |
| Continue 取消及新请求 | 2 | helper 改为原生 agent 后通过 |

共 13 次真实模型调用，每次运行关闭后所属残留进程均为 0。真实图片提供商调用为 0；图片绑定、生成与保存仅由受控提供商测试覆盖。结构化提问由远程测试及既有原生二进制探针覆盖，没有真实 Host 提供商提问场景的结论。

最终远程回归命令：

```text
npx vitest run src/agent-daemon src/main/remote-agent src/main/agent/acp-remote-runtime.test.ts src/shared/remote-agent-contracts.test.ts src/shared/remote-runtime-launch-contracts.test.ts src/shared/agent-protocol --testTimeout=30000 --hookTimeout=60000
```

66 个文件通过、2 个跳过；723 项通过、33 项跳过。helper 最终修改后的局部 ESLint 通过。原始记录当时报告全仓 lint 通过，但 typecheck 仍被并发调用方和夹具阻塞，Agent-only 检查剩余 `DirectModelSubagentParent.workMode` 错误；这保留为当时结果，不作为最终聚合检查结论。

### 真实 Electron

实施方提供的通过结果与 [unified-execution-main.ts](../../../tests/support/unified-execution-main.ts) 对应：生产 App、preload、IPC、设置和 SQLite，隔离无关启动服务。种子消息证明首次点击不删除、取消保留、确认经生产 IPC 删除且重载后仍删除；同时检查输入区及项目表单无模式控件、安全分类消失、入口属于 General / Platform Features，模型请求为 0。该证据不等于完整启动服务或全部 UI 场景验收。

### 现行文档

根 README、双语 FEATURES、BUILD、UI-DESIGN、运行时约定与受影响功能 Markdown 已同步无模式规则。规划功能仍保持规划状态；历史发布、原型及日期明确的验证段保留当时结果。站点中英文页面、内置工具描述与联网诊断请求也已清理旧模式说明和字段。

### 专家执行空间与远程图片保存

审查发现智能路由删除 Ask 条件后，原先全局缓存的专家模型可能把项目写操作落到全局目录。现已按当前项目创建专家实例，传递父请求的能力上下文，并在子任务结束时释放其自身资源。两份不同本地根目录的回归验证写入位置和上下文继承；内部综合仍使用独立无工具实例。

SSH 专家保留父请求已解析的 OpenCode 或 Continue 选择，通过现有 managed remote runtime 使用专家模型配置。图片保存因此沿用 Host 的 image MCP，不调用 Desktop 的本地保存函数，也没有新增文件传输协议。复核未再发现上述执行空间或保存目标问题。

真实 Host 记录：`C:/Users/jiang/AppData/Local/Temp/opencode/expert-image-validation.md`。两个 Runtime 均完成无覆盖保存、重复保存冲突、显式覆盖测试，SFTP 读取结果与替换 PNG 的 68 字节完全一致；每个成功场景 3 次图片读取、0 次桌面保存，退出后所属进程为 0。此处图片是测试夹具，不是提供商生成。

该轮共 12 次真实文本提供商请求，包括初始验证脚本预算不足的两次尝试各 2 次请求，以及最终成功的两组各 4 次请求。加上前述无模式链路的 13 次，本功能开发验证累计 25 次真实文本请求、0 次图片生成请求。SSH 专家修复后五个聚焦文件 260 项通过、1 项既有跳过。

### 最终集成检查

- `npm run typecheck`：Main、Agent、Web 通过。
- `npm run lint`：通过。
- `npm run build`：最终专家修复后通过，包含上述类型检查和 control-plane installer 检查；保留一条共享工作区模块静态/动态导入的构建提示。
- `npm test`：完整运行 523 个文件，497 通过、12 失败、14 跳过；6,062 项中 5,956 通过、20 失败、86 跳过，并出现 1 个未处理错误。该运行期间工作树有并发修改。
- 失败定位与修正后，最后针对六个文件复跑为 360 通过、1 失败；其中 App 348 项、真实存储 Worker 3 项、工作栏布局 2 项、OpenCode 生命周期 4 项和远程路径访问 3 项通过。
- 本功能遗漏的存储 Worker 旧夹具已修复，并增加直接通过历史迁移链构造 schema 59 的真实 Worker 升级验证；相关三个文件共 145 项通过。

最后复跑仍失败的是 `tests/supervisor-layout.electron.test.ts`：驱动等待 `.supervisor-workspace__inline-error`，并发监督者改造已改用通知。该问题不属于本次工作模式移除，没有回退或改写对应业务变更。它阻止当前工作树被描述为测试全绿。

完整及复跑报告分别位于临时目录的 `ask-execute-full-20261004.json`、`ask-execute-focused-20261004.json` 和 `ask-execute-final-followup-20261004.json`。这些数字属于各次运行，不相加作为去重测试总数。

尚未进行用户生产旧库副本迁移、签名安装包发布或全部跨平台验收。远程使用需配套支持 runtime/acp 6 的 Agent；现有已发布锁文件未被伪造为兼容新协议。

## 调研阶段验证边界

早期只读调研没有执行迁移、读取真实用户数据库或调用模型，调用次数为 0。后续实施验证单列在上文，不能将两个阶段的证据范围混为一谈。

仍需实际取证：旧 `runs` JSON 形状、Agent 不透明事件中的应用自有字段、旧远程操作跨升级恢复，以及外部委派服务兼容性。不得用递归删字段或清空日志回避这些问题。

## 调研阶段文档检查记录

已对九份文档进行交叉审查，核对范围、需求与故事映射、源码引用、相对链接和当前状态表述。审查发现的独立授权验收缺项、原生设置范围歧义和起草阶段备注已修正。

`deai-writing` 扫描九份文档，阻断项为 0。复核项主要为未验证状态、数据保留条件和字段枚举；结合技术文档语境保留这些限定，不将迁移计划改写为已完成事实。

`git diff --check -- docs/features/unified-execution docs/features/assistant-workbar/README.md` 通过已跟踪改动的空白检查。新建文档另经内容与链接核对；该命令不会把未跟踪文件当作已验证差异。文档检查不替代运行时验收，后者按用户故事与技术设计执行。

## 2026-10-05 直连模型工具错误回传

普通工具执行失败不再直接终止直连模型循环，错误结果继续交给模型处理，取消行为保留。
实现、三协议回归及全量测试边界见[直连模型修复记录](../direct-model-agent/progress.md#2026-10-05-工具执行异常回传)。
