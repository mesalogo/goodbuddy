# Runtime 取消修复验证

## 修复范围

2026-10-23 完成此前[子任务与进程实测](./subagents-and-processes-2026-10-22.md)发现的
Continue/受控 DSH 命令后代未取消，以及 OpenCode 定向子任务中止被显示为失败三项修复。
保持 Continue `1.5.47`、DSH `0.2.1-rc.2` 和 OpenCode `1.19.3`，无依赖升级。
本轮使用真实工具和进程、本地确定性模型，外部模型请求 **0 次**。

## Continue

原 abort 开始终止进程树时，finally 同时发出 /pause、/exit。Windows 下 Host 可能先退出，
导致 taskkill 无法再枚举其命令后代；Linux ACP 请求 Host 未使用独立进程组。

[Host adapter](../../../src/main/agent/continue-host-adapter.ts) 移除并行的 HTTP 退出操作，
复用既有进程树终止函数，保留 owner 直到树终止完成。POSIX 默认子进程和
[Agent ACP helper](../../../src/agent-daemon/continue-acp-helper.ts) 按每次请求创建独立进程组，
将所有权明确交给同一终止函数；不通过关闭共享服务取消一个请求。

Windows 真实 utility Host 和 Linux x64 当前源码 helper 均验证取消后代消失、正常结束
标记缺失、兄弟任务继续。Linux 使用原固定 SSH identity 与凭据，测试目录隔离，没有覆盖
已部署安装；两次 Linux 取消观测为 16 ms / 13 ms。测试入口为
[Continue 原生取消探针](../../../src/agent-daemon/continue-native-cancellation.manual.ts)。
这覆盖受影响的 helper/共享 adapter，不等于完整桌面到 Agent 的安装与连接验收。
定向回归 92 项通过，Agent 类型检查与定向 lint 通过。

## DeepSeek Harness

已确认取消信号到达 subprocess，但固定版本的 Windows Job runner 在 Store PowerShell
场景终止 shell 后，Node 后代仍可继续。强制退回 PowerShell 5.1 虽解决该夹具的回收，却会
改变 PS7 语法和文件编码，因此最终方案没有采用降级。

[GoodBuddyHarnessSubprocess](../../../src/main/agent/deepseek-harness-subprocess.ts)
替换固定 Host 中的 subprocess 插件：Windows 保留实际命令 child handle，复用仓库既有
树终止函数、DSH 输出收集器和 Cordis dispose；原生 PowerShell resolver 保持不变。
非 Windows 继续使用上游实现。仅私有 runner 启动时设置 Electron Node 模式，从用户命令
环境中移除该变量，并在启动后恢复环境，避免 Electron 应用误以 Node 模式执行。

[控制面](../../../src/main/agent/goodbuddy-harness-control-plane.ts) 不再在 cancel 回调中
提前 resolve inflight，而由实际 agent idle 和已有事件结算完成 Prompt。

Windows wrapper 同时区分 direct exit 与输出 close：子孙继承输出句柄时，按 spec.graceMs
有界排空并结算直接进程结果，避免 dispose 无限等待。该行为不声称仍存活的后代已退出。
新增回归明确保留该后代直到断言结束，再按已知 PID 清理。

真实 UtilityProcess 验证包括：

- Store PowerShell 7 仍被选中，`&&` 语法与中文 `>` UTF-8 文件输出通过。
- shell/native stdout、stderr 和管道输入的 Unicode 内容正确。
- 用户命令环境没有 ELECTRON_RUN_AS_NODE；实际启动 Electron 的 process.type 为 browser。
- 取消后 shell 和 Node 后代退出，正常完成标记缺失；兄弟任务正常完成，同 Host/会话可复用。
- 最后一次聚焦 utility 取消及退出观测 291 ms；Host dispose 后进程退出。

新增 [取消回归](../../../src/main/agent/deepseek-harness-runtime-cancellation.test.ts)、
[Utility 驱动](../../../tests/support/deepseek-harness-cancellation.electron.ts)和
[输出排空回归](../../../src/main/agent/deepseek-harness-subprocess.test.ts)。最后聚焦运行
4/4 通过；前序扩大 DSH 运行 86 通过、4 个外部插件条件跳过。
当前工厂拒绝远程 DSH，因此没有对应 gbagent 实现需要修改。非 Windows DSH 执行未实测。

## OpenCode

原共享进度映射忽略 child session.error / MessageAbortedError，后来的父 Task 错误将目标
显示为 failed；远端插件还过滤了 session.error。

[共享 mapper](../../../src/main/agent/opencode-subagent.ts) 识别类型化 MessageAbortedError，
保留 cancelled 与已收集进度，后续 Task/ACP 帧不能将其覆盖成 failed/completed。
[Agent 插件](../../../src/agent-daemon/opencode-subagent-plugin.ts) 通过既有 ACP metadata
通道转发所属子会话错误。只有错误类型匹配时才按取消处理，APIError/UnknownError 即使
文本是 Aborted 也仍是失败。

真实 native 6/6、原生 ACP 问答 4/4、新增 ACP 定向取消 1/1 通过；共享 mapper/plugin
单测 13/13，本地 Runtime/远程 ACP 组合 263/263 通过，范围有重叠，不相加成独立总数。
Linux x64 使用隔离并校验的 `1.19.3` bundle，当前源码 ACP 场景 5/5 通过：目标 cancelled，
兄弟与父任务正常完成。未替换已安装 Runtime。仍未新增前端定向停止按钮。

## 合并验证

未修改原有复现探针的断言来掩盖失败。

```text
node scripts/validate-continue-dsh-tasks.mjs
npm.cmd run build
npm.cmd run lint -- --ignore-pattern sites/docs-dist/** --ignore-pattern sites/docs/.vitepress/cache/** --ignore-pattern sites/docs/.vitepress/dist/**
```

保留 PS7 的最终组合探针 **13/13 通过**。Continue 取消返回 276 ms，后代在 abort 后
781 ms 的取样中已不存在；DSH 分别为 346 ms 与 860 ms。两者正常结束标记均不存在，
兄弟完成，8 个夹具进程和 5 个 Continue Host 均退出。这些是采样值，不是精确 kill 延迟。
输出排空补丁之后的集成复跑另有 14/14 通过，覆盖 DSH 取消、直连真实进程和 OpenCode 子任务。
最终生产构建（包含三套 TypeScript 检查和打包校验）及源码 lint 通过。

全量 `npm test` 已尝试但未完成。运行期间时钟从约七分钟跳到三小时以上，Electron canvas
记录约 11,664 秒；watchdog 随后终止。可能涉及宿主暂停或调度中断，原因未确认。
终止前报告 5,783 通过、7 失败、41 跳过；491 个文件有结果（479 过、5 失败、7 跳过），
这些只是部分统计，不能作为最终全量结论。

失败复核：

- Obsidian 测试要求临时目录在 checkout 外，与本仓库 temp 规则冲突，属已知无关失败，未改。
- App 设置弹窗测试无法找到“设置中心”，隔离复跑仍失败；相关源码/测试无本轮改动，根因
  尚未深入确认，没有归因于取消修复，也没有宣称已排除全部依赖影响。
- 其余五个数据库/画布/App 用例在隔离复跑通过，保留环境/时序限制，不宣称根因已查明。

本轮未发现取消修复新增的失败。临时驱动、日志、夹具和识别出的所属本地/远端进程均已清理。
没有提交或发布；macOS、Linux 桌面 Electron、完整 UI/安装包和全仓全绿仍未验收。
