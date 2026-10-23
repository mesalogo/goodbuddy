# 子任务与进程适配验证

本文保留发现问题时的测试结果。Continue/DSH 命令后代回收和 OpenCode 子任务取消映射已在
后续源码中修复，当前结果见[2026-10-23 修复验证](./cancellation-fixes-2026-10-23.md)。

## 环境与范围

2026-10-22，Windows x64，源码为 `6e12c4cd38ec92d0eaae4d7311f4d5d2ee126d9b`
及本轮未提交验证文件。OpenCode binary/SDK `1.19.3`、Continue `1.5.47`、
DeepSeek Harness `0.2.1-rc.2`、Droid `0.245.1` / SDK `0.10.0`。

本轮真实外部模型请求 **0 次**。模型响应由本地 HTTP 服务、fetch 夹具或 DSH llm/stream
事件提供；进程、原生工具和下文指明的适配器真实执行。未通过 UI 点击，不等同于完整产品
或跨平台验收。测试目录均位于仓库 temp/。

## 对比结果

| 类型/操作 | 直连模型 | OpenCode | Continue | 受控 DSH | Droid |
| --- | --- | --- | --- | --- | --- |
| 子任务 | 生产委派服务、调度器与 child ModelRuntime 通过 | 原生 Task、并发子会话及问答通过 | 已测目录无委派工具 | 已测固定 Host 无子代理工具 | 原生 Task/daemon 子会话通过 |
| 父轮等待 | 本轮委派等待结果 | 本轮 Task 等待结果 | 等待命令 | 等待命令 | await=false 子任务可在父轮结束后继续 |
| 定向取消 | execute 的独立 AbortSignal，兄弟继续 | native abort 停止目标，适配器记 failed | 父请求返回取消，Node 后代未终止 | ACP 返回取消，Node 后代未终止 | daemon interruptSession 和原生 TaskStop 子任务取消通过 |
| 后台命令/服务 | 无 background/stdin/pty 参数；未建立跨轮管理合同 | bash 无后台参数；本轮未测出回复后存活 | 有 CheckBackgroundJob，创建/独立停止合同未建立 | 固定 Host 无 job 控制工具 | fireAndForget 服务可存活至 CLI 退出后 |
| 服务停止 | 会话释放终止在途服务器，端口释放 | 未验证 | 未验证 | 未验证 | Execute 调用 OS process.kill，非后台进程专用 RPC |

官方 DSH Web 的实际目录包含 subagent、subagent_fork、list_agents、send_message、
interrupt_agent、job_list、job_output、job_kill 和 workflow。本轮只采集目录，未执行这些
生命周期；它们不属于 GoodBuddy 固定 Host 已接入能力。

## OpenCode

新增 [原生子任务测试](../../../tests/support/opencode-native-children.test.ts)，使用真实
CLI server、SDK、工具和当前 OpenCodeRuntime，模型由 localhost 夹具提供。
六个场景最终通过，27 次本地模型请求；四个真实 ACP 插件问答测试另通过，8 次本地请求。
重跑不重复计算覆盖数。

- 两个子请求通过 barrier 确认并发，native parentID 和 runtimeCallId/childTaskId 正确。
  父回复在两个子任务完成后结束。
- 子任务 read 成功/失败归属正确；单个工具失败不自动等同于整个子任务失败。
- 不存在的 subagent 类型使 Task 失败，不创建虚假子会话。
- 子任务 question 带 childTaskId 回传，回答后子任务与父任务继续；ACP 插件亦通过。
- 取消父请求投影子任务 cancelled，native session 回到 idle，后续请求成功。取消结算中
  仍观察到一次父模型请求，不承诺中断后绝无额外调用。
- 直接 session.abort(childSessionID) 中止 A 时，B 和父任务完成。A 的原生错误为
  MessageAbortedError/Aborted，适配器终态为 **failed**，没有 completed/cancelled，也没有
  CHILD_A_FINISHED 输出。共享 AgentRuntime 尚无定向子任务停止操作。
- 原生历史保留 17,000 字符子输出，适配器预览截到 16,000；未证明产品可读取原生全文。

bash 参数为 command/timeout/workdir，task 为 description/prompt/subagent_type/task_id/
command，均无后台标记。短 detached Node 探针在父回复返回前已结束，未产生后台任务事件；
该观察不证明 OpenCode 上游绝不支持脱离执行。

```powershell
npx.cmd vitest run tests/support/opencode-native-children.test.ts --reporter=verbose
npx.cmd vitest run src/agent-daemon/remote-question-binary.test.ts --reporter=verbose
```

尝试共享 Host：LAN SSH 关闭连接，VPN SSH 可认证，但已安装二进制返回 `1.18.9`，Host
checkout 缺少本轮测试依赖/资源。未替换其安装，未完成远程 `1.19.3` 验收；上述 ACP 测试
在本机二进制和当前 Agent 插件上运行。

## 直连模型

新增 [进程与委派测试](../../../tests/support/direct-model-native-processes.test.ts)。
生产链路为 ModelAgentRuntime → ModelToolProvider → DirectModelSubagentService/Scheduler
→ child ModelAgentRuntime → process_execute。模型 fetch 与异步文件 backing 是夹具，
进程执行、取消、调度和分页逻辑来自生产实现。

五个新增测试通过，结合现有进程/委派用例共 **35 个不同测试通过**。最终新增文件重跑
5/5 通过，8 次 mock fetch，无外部模型请求。

- 两个真实进程使用独立 AbortSignal，取消一个后兄弟正常完成。
- localhost 服务器在 execute 期间运行；releaseConversation 后返回 cancelled，PID
  不存在、原端口可重绑；相同 conversationId 后续调用成功。
- 2 秒超时返回 terminationReason=timeout，已产出内容保留，PID 已退出。
- schema 拒绝 background/stdin/pty，没有 listProcesses/stopProcess/writeInput 接口。
  AbortSignal 是调用方控制，不是模型可调用的独立停止工具。
- detached 子进程在 execute 返回前已完成，未证明跨轮后台存活。
- 委派 queued → running → completed，child 实际执行进程，子层不暴露递归委派。
- 新测试确认进程预览截断，并分页读取夹具生成的委派助手输出；两者不是同一正文。
  现有 process-service 测试另覆盖真实 stdout/stderr 全文分页、10 MiB 输出与 backing IO 取消。
- 委派结果引用下一轮可读，releaseConversation 后拒绝旧句柄。

```powershell
npx.cmd vitest run tests/support/direct-model-native-processes.test.ts src/main/agent/direct-model-process-service.test.ts src/main/assistant/direct-model-subagent-service.test.ts --reporter=verbose
npx.cmd vitest run src/main/agent/model-runtime.test.ts -t "delegates one programming Subagent" --reporter=verbose
```

## Continue 与受控 DSH

[启动器](../../../scripts/validate-continue-dsh-tasks.mjs)和
[场景](../../../scripts/validate-continue-dsh-tasks.ts)通过真实工具执行夹具命令。
Continue 使用真实 HostAdapter 和 Electron utilityProcess；DSH 使用真实 Runtime、ACP
和生产组合 Host，但 Host 在探针 Node 进程内运行，不是完整 Electron utilityProcess 边界。

最终复跑 **13 项检查：11 通过、2 失败**，退出码保留 1。8 条 shell 命令、1 次
CheckBackgroundJob，18 次本地模型调用（Continue 9、受控 DSH 8、原生 Web 目录 1）。

| 取消测量 | Continue | 受控 DSH |
| --- | ---: | ---: |
| abort 到调用方结算 | 282 ms | 1 ms |
| 结算后取样间隔 | 513 ms | 502 ms |
| abort 到取样 | 795 ms | 503 ms |
| 取样时 Node 命令后代存活 | 是 | 是 |
| abort 到观察 PID 消失 | 14,985 ms | 15,037 ms |
| 正常结束标记文件 | done | done |

夹具没有 detach 或忽略终止逻辑，定时写入 done 后自然退出。两次最终观察均表明取消没有
及时终止该 Node 命令后代；测量其 PID，不断言外层 shell 也存活。退出由 50 ms 轮询观察，
不是精确 OS 时刻。兄弟请求和后续新请求通过。**两个取消后代问题尚未修复。**

1.5 秒命令被等待，stdout/stderr 可读。显式传播 exit 7 时，Continue 报告 7，但错误结果
省略 stdout；受控 DSH 保留 stdout/stderr/exit code，工具事件仍为 completed。
因此不能从 completed 推断命令成功。

Continue 有 CheckBackgroundJob，对不存在的 ID 返回 Job not found、空 available_jobs；
无 delegate/job_list/job_kill，Bash 无后台参数。受控 DSH 目录为 edit/pwsh/read/skill/write，
无 subagent/jobs，pwsh 无 run_in_background。未展示跨回复后台管理或 stdin 输入能力。

```text
node scripts/validate-continue-dsh-tasks.mjs
```

现有 DSH ACP、原生 Web 和 Continue utility adapter 聚焦回归另有 11 通过、14 项按名称
过滤/跳过；这些通过不能抵消上述两项新失败。

## Droid

扩展 [任务脚本](../../../scripts/validate-droid-tasks.mjs)。最终运行通过，**40 次本地
确定性请求、0 次真实模型请求**。前序证据见 [Droid 进度](../providers/factory-droid/progress.md)。

- Todo 创建/更新/恢复、两子任务关联、下一轮父请求、输出与终态恢复再次通过。
- daemon interruptSession({sessionId: childId}) 独立取消目标，父请求和兄弟继续。
- 中断父会话时，detached 子任务仍为 thinking，两者可以分别结算。
- TaskStop({task_id: childSessionId}) 模型工具成功，随后摘要 cancelled，父会话继续。
  TaskStop 和客户端 interruptSession 是不同控制入口。
- Execute fireAndForget 启动 localhost 服务，输出 PID/端口；CLI 关闭后 HTTP 仍可访问。
  后续 Execute 运行 Node process.kill，确认所属 PID 不存在且端口可重绑。这是模型工具
  执行 OS 操作，不是已经接入按钮的专用 shell-stop API。
- Execute shell 本轮为 PowerShell 7.6.7。内层 Node exit 7 未传播时 wrapper 返回 1；
  添加 `exit $LASTEXITCODE` 后进度/结果均为 7。stderr 保留且 isError=true，前者不能
  归因为 Droid exit-code 缺陷。

```powershell
$env:GB_DROID_SUITE='tasks'
$env:npm_config_offline='true'
node scripts/validate-droid.mjs --native --max-calls=0
```

子任务问答、失败子任务恢复、daemon 问答 handler 重挂、专用 shell 控制 API、Linux/远程
Agent 和实际顶部 UI 尚未在此验证。

## 清理与后续

新增文件定向 ESLint 通过，OpenCode/direct-model Node 类型检查通过。临时夹具和已识别
所属进程清理完成，Droid 用户配置字节比较未变。watchdog 强制退出分支未故障注入，不据此
宣称所有失败情况下的完整进程树清理。

统一规范据此区分 Todo、Agent 子任务、后台命令/服务与运行设施进程。优先待修项是
Continue/受控 DSH 的命令后代取消，以及 OpenCode 独立 abort 的终态映射和产品控制入口。
本轮没有修复生产问题，没有提交或发布。
