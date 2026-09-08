# 工作栏实现与验证进度

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

- `OpenCodeRuntime` 复用缓存的 embedded server 前执行有超时的健康检查；健康则保留
  client，检查失败、抛错或超时则清除 client、会话映射、会话初始化及待答问题，关闭旧
  server 后重建。并发调用共享检查与重建，调用方取消只结束自身等待。
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
