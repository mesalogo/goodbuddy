# 工作栏实现与验证进度

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
  并持有使用租约。请求结束或 capability 撤销前，绑定 Tab 拒绝关闭；工具参数未增加模型可见
  `tabId`，已有浏览器工具 schema 保持不变。
- 聚焦回归命令覆盖 Shared、BrowserService、Electron Session、IPC、Preload、MCP、Renderer
  和 Workbar，13 个测试文件共 453 项通过；`npm run lint` 与 Web TypeScript 检查通过。
- `node build/run-browser-tabs-electron-e2e.cjs` 通过。该测试启动真实 Electron/Chromium 和本地
  HTTP 页面，创建两个 `WebContentsView`，验证页面隔离、同 Conversation Cookie 共享、真实
  loopback MCP 的固定 Tab 导航与快照、使用租约关闭保护，以及单 Tab 和最终 Context 清理。
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
