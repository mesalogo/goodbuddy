# 工作栏实现与验证进度

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
