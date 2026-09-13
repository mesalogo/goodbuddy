# DeepSeek Harness 实现进度

## 2026-09-14 Windows 工作区路径修复

本机 Runtime 的 Host 启动与 `newSession.cwd` 已共用初始化时解析的 `realpath`，
规则见[技术设计](./technical-design.md#52-受控组合不启动用户-profile)。修复此前
`C:/...\workspace` 写法触发 ACP `-32602`，以及随后换成同目录规范写法仍复用
错误 Runtime 的问题。Host 严格比较与 execution-space 缓存规则保持原样。

新增 Windows 真目录回归，连接真实 ACP、Host 和控制面，分别用混合分隔符及规范
路径创建会话，断言共用同一 Runtime、只启动一次 Host、两次均完成。该自动化回归
使用内存模型；外部真实模型验证单独由完整 App 完成。

Windows 完整 App 使用当前源码构建的 Main、Preload、Renderer 和新建隔离配置。
正式配置只读，模型凭据由隔离配置中的 safeStorage 解密；真实 composer 输入请求，
由 `deepseek-v4-flash` 在 Ask 模式读取 `summary-probe.txt`，校验码未放入 prompt。

| 目录写法 | Composer 提交 | 真实模型 HTTP dispatch | 文件读取 | 结果 |
| --- | ---: | ---: | ---: | --- |
| Windows 混合分隔符 | 1 | 2 | 1 | 仅返回文件中校验码，任务完成 |
| 同目录规范路径 | 1 | 2 | 1 | 仅返回文件中校验码，任务完成 |
| 合计 | 2 | 4 | 2 | 两条会话均通过 |

两轮 dispatch 来自同一 DS Utility Host 进程，切换目录写法未新增 Host；ACP 会话
ID 不同。两条工具卡片均显示路径摘要，原生点击展开后可查看输入与输出；重载
Renderer 并重新选择项目后，已保存会话的摘要、详情和完成状态仍通过检查。四张
局部截图已逐张打开审阅。驱动曾返回不可克隆的监听器函数，以及在重载后默认项目
等待工具卡片超时；修正定位后通过，这两次驱动错误没有增加模型请求。

本机临时 `ds-windows-path-live/report.json`、`dispatch.jsonl` 与 `source.json`
记录结果、逐请求计数和构建哈希，原 `runtime-summary-live` 报告未覆盖。
本次 App 正常退出，退出前记录的 5 个所属进程均已停止；隔离 profile、数据库、
工作区、临时构建和私有日志已清理。正式模型配置与启动前逐字节一致，报告和截图
保留在本机临时目录，不作为长期可用的仓库资源。
测试沿用生产 HTTPS 与证书处理，未单独验证严格证书校验或 Main 重启。

专项 7 个测试文件通过，91 项通过、3 项跳过。`npm run typecheck` 与
`npm run lint` 通过。最初两个假时钟测试因异步目录解析尚未结束就推进启动时钟而
超时；调整为等待 launcher 启动后，DS Runtime 的 34 项测试全部通过。
最终全量 `vitest run`（`npm test` 的脚本入口）为 353 个文件通过、9 个跳过，
4155 项通过、66 项跳过、0 失败，耗时 602.00 秒。`git diff --check` 通过。

远端核查：Main 的 SSH 分支创建托管远程 Runtime，最终使用 `AcpRemoteRuntime`；
`create-runtime.ts` 的本机 DS 入口拒绝 SSH execution space。本次未改远端代码，
未调用远端模型，也未进行 Linux Host 实测。
