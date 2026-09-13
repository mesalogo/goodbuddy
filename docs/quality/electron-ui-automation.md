# Electron UI 自动化测试规范

本文规定开发期 Electron UI 自动化的执行和取证方法，适用于表单、弹窗、菜单、主题、响应式布局及其业务路径。视觉与交互预期以 [UI 设计系统](../../UI-DESIGN.md)和功能设计为准；通用命令见[开发与构建](../../BUILD.md#质量验证)，功能实测结果写入各功能的进度文档。

## 1. 测试分层与选择

先写清本次改动影响什么、在哪一层验证，以及该层替换了哪些依赖。按影响选择场景，fixture 和真实服务测试提供互补证据。

| 层次 | 运行方式 | 能证明的范围 | 不能据此宣称 |
| --- | --- | --- | --- |
| 单元与组件回归 | Vitest、Testing Library、契约及 CSS 回归 | 状态分支、语义和回归断言 | Electron 实际排版、原生键盘默认行为或生产端到端成功 |
| Electron 视觉 fixture | 当前组件、入口样式、i18n、主题函数；真实 Chromium 与 body Portal；IPC 返回受控假数据 | 排版、主题、控件外观、焦点、原生交互，以及受控空状态和错误状态 | 持久化、真实检索、模型生成或完整 App 接线成功 |
| 生产 IPC 集成 | 当前 Main 服务、注册 IPC、真实 Preload、隔离数据；按需接真实服务 | 跨进程契约、生产存储、检索及生成路径 | 用隔离验证 DOM 展示事件时，不能称为完整 App 输入区或引用 UI 验收 |
| 完整 App | 当前生产 Main、Preload、Renderer，隔离 profile，从真实 UI 入口完成操作 | 用户动作到生产实现及最终可见结果 | 未执行的平台、Provider、模式、重启或远程路径 |

纯视觉修复通常先做组件回归和 Electron 视觉矩阵，在完整 App 中复核受影响入口及 Portal 接线；无需为每种主题、尺寸或 CSS 修改重复调用模型。保存、持久化、检索、生成、引用或 IPC 接线变化，补对应生产路径。真实生成声明必须来自真实生成请求；健康检查、模型列表、HTTP 200 或 fixture 答案均不足以证明。

沿用 [AGENTS.md 的验证授权](../../AGENTS.md#validation)：验证变更路径所必需的有界真实文本模型调用已有持续授权，不逐次询问。只运行必要的最小请求，尽量关闭无关工具与附件；按需工具检索场景保留所需工具。本文不新增产品策略或审批流程。

## 2. 方法来源与证据边界

2026-09-13 的外部知识库复验是本规范的方法来源。永久记录由[知识库进度](../features/knowledge-base/progress.md)及[脱敏复验摘要](../features/knowledge-base/external-knowledge-follow-up-2026-09-13.json)维护。下表用于说明测试方法，不表示本文编写时重新执行了测试。

| 原始临时证据 | 已观察事实 | 保留的限制 |
| --- | --- | --- |
| `external-visual-0913/results.json`、`preview.tsx`、`electron.cjs`、`run.mjs` 及 PNG | 当前源码组件和 `styles.css`、真实 body Portal、fixture IPC；浅深主题，1280×800、960×720、720×640、640×420；56 张场景截图、138 项检查，记录中无失败断言和 errors；计算样式、溢出、焦点与底部操作区配合 PNG 审阅 | 额外拼图和残留 `failure.png` 不计入 56 张；各尺寸场景数不同，未覆盖的组合不能按笛卡尔积推定通过；未验证真实服务 |
| `kb-real-generation/report.json` | 真实 Electron、当前 Preload、已注册生产 IPC 和 ModelAgentRuntime；三个 Provider 的 `always`、Dify `auto`；文本和引用由生产存储保存 | Renderer 是隔离验证 DOM；`auto` 经进程内 `ModelToolProvider → KnowledgeMcpGateway`，不是 HTTP MCP 会话；首轮两家比较器误判保留，解码请求和内嵌证据 JSON 后重跑通过 |
| `kb-full-app-live/report.json` | 当前完整生产 App，隔离 safeStorage profile；UI 创建实例与非空绑定，在实际输入区选择 Dify 并点击发送，真实短答案生成、保存并点击引用；片段及文档/分块匹配 | 仅 Dify、Ask、`always`；测试密钥在 Main 保存 IPC 边界替入；无伪造消息、引用或 Agent 事件；不证明广泛问答质量或其他 Provider 的完整 App |

早期验收曾仅凭“没有横向溢出”漏掉 Portal 移到工作区外后字段样式失效的问题。修正后复验同时检查 `.field` 共享样式、字体、背景、密码显隐布局和实际 PNG。以后不得把 `scrollWidth <= clientWidth` 当作视觉通过的充分条件。

上述生产 IPC 报告实际发出模型请求 7 次、KB 请求 12 次，其中检索 9 次、目录 3 次；包含比较器修正后的两次生成重跑，Runtime 模型重试为 0。完整 App 另发出模型请求 1 次、KB 请求 5 次，其中检索 3 次、目录和详情各 1 次。本轮精确增量为模型 8 次、KB 17 次；不采用原报告中覆盖不完整的历史会话累计区间。后续报告应独立计数，不沿用这些数字作为预期或配额。

原始文件位于当时工作机批准的临时目录。当前可读取视觉脚本；完整 App 的隔离 profile 和构建已删除，其目录只保留报告和截图。它们不是仓库承诺维护的 runner，也不是新环境的依赖。没有原始文件时仍可按下节重建临时驱动，但必须记录“驱动重建”，不能声称复用了原脚本或复现了全部历史证据。

## 3. 当前源码与隔离启动

### 环境与命令

需要 [BUILD.md](../../BUILD.md#环境要求)要求的 Node.js、锁定 npm 依赖、能显示窗口的 Electron 桌面会话，以及本次专用临时目录。记录操作系统、架构、Electron 版本、语言、主题、缩放和内容区尺寸。真实凭据场景还需要当前 OS 用户可用的 `safeStorage` 及已授权配置。

在仓库根目录逐条执行以下准备命令；依赖已经满足时不重复安装：

```powershell
node --version
npm ci
git rev-parse HEAD
git status --short
node -p "require('electron/package.json').version"
```

用 HEAD 和相关未提交变更摘要标识本次源码。读取当前 [Electron Vite 配置](../../electron.vite.config.ts)和 [Main 入口](../../src/main/index.ts)，确认 Renderer、Preload、动态加载资源及用户数据路径。

开发期需要完整生产产物时执行 `npm run build`，确认成功后再用隔离启动器加载 `out/main/index.js`，并记录 Main、Preload、Renderer 入口及相关资源的构建标识。不要把已安装的旧版或陈旧 `out` 当作当前源码。并行任务会修改 `out` 时，使用本次专属源码/构建副本，或在测试前后核对产物哈希；不要覆盖别人的构建。[发布操作](../development/release-runbook.md)另有候选 CI 构建规则，本节不改变该流程。

### 临时驱动的复现步骤

仓库已有 [Electron 启动脚本](../../build/run-browser-tabs-electron-e2e.cjs)及[对应测试](../../tests/browser-tabs-electron-e2e.ts)，可复用其 `esbuild` 临时 bundle、`external: ['electron']`、解析仓库 Electron 可执行文件、清除 `ELECTRON_RUN_AS_NODE` 和退出码处理方式。`node build/run-browser-tabs-electron-e2e.cjs` 是现有浏览器服务测试命令，不是通用 UI 矩阵命令，也不覆盖完整 App。

1. 在本次临时目录准备场景入口、Electron bootstrap 和独立 Node supervisor。依赖从当前仓库解析；临时目录外脚本可用 `createRequire` 指向仓库 `package.json`，不要假定临时目录能自动解析 `react` 或 `electron`。
2. 视觉层用 Vite `createServer` 服务临时入口，引用当前组件、`styles.css`、i18n 和 `applyAppearanceTheme`；React 依赖指向同一仓库实例，服务仅监听 loopback 随机端口，文件允许范围限于本次目录及仓库。保留真实 Portal 容器和位置，仅替换约定的 IPC 返回值；不要另画一份“相似 UI”。
3. Electron bootstrap 在 `app.whenReady()` 前设置本次 `userData`、`sessionData` 和日志目录。视觉层创建 `BrowserWindow`，采用 `useContentSize: true`，通过 `setContentSize` 切换矩阵；完整 App 则在设置隔离路径后动态导入当前生产 Main，由生产代码创建窗口、注册 IPC 和加载实际 Preload/Renderer。监听 `browser-window-created` 找到主窗口，确认最终数据路径仍在测试目录，避免便携路径规则覆盖隔离设置。
4. supervisor 用 Node `spawn` 启动 Electron 子进程，在子进程环境副本中删除 `ELECTRON_RUN_AS_NODE`。否则 Electron 可能作为 Node 执行，窗口和 `app` API 不可用。完整 App 检查实际加载的入口；不要绕过主程序仅挂载 `App` 后称为完整生产路径。
5. 等待页面就绪、目标可见、`document.fonts.ready` 和所需异步状态；所有等待都有阶段期限。通过 `webContents.executeJavaScript` 读取 DOM、测量布局和定位元素，通过 Electron 输入 API 驱动交互，通过 `capturePage().toPNG()` 保存截图。记录程序化定位焦点的步骤，完整 Tab 导航另行验证。脚本按当前控件的可访问角色操作，例如实例选择器改为菜单后，应同步更新旧版 `select` 驱动。
6. 场景完成即写检查和证据索引；失败也写阶段、退出码/信号、脱敏诊断与截图。结束后由 supervisor 核对结果完整性并清理本次子进程、服务和 profile。

生产窗口保持 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false` 及既有 CSP、可信发送方校验和显式 Preload API。不要复制其他专用 smoke 中的 `--no-sandbox`，也不要为驱动增加 `eval`、修改生产安全标志或向 Renderer 暴露 Node。驱动本身无法启动应记录为 harness 故障。

原视觉目录仍存在时，可先在 PowerShell 校验文件可用性。以下只检查可用性，不启动测试：

```powershell
$visualRun = Join-Path $env:TEMP 'opencode\external-visual-0913'
Test-Path -LiteralPath $visualRun
'run.mjs', 'electron.cjs', 'preview.tsx', 'index.html', 'results.json' | ForEach-Object {
  [pscustomobject]@{ File = $_; Exists = Test-Path -LiteralPath (Join-Path $visualRun $_) }
}
```

原脚本包含工作机绝对路径和固定输出文件名。先读脚本、复制到新的临时运行目录并适配源码路径、输出目录、依赖解析及当前选择器，避免覆盖历史失败诊断；随后才可 `node "<本次目录>/run.mjs"`。这是需要适配的命令模板，仓库没有 `npm run test:ui` 或一条命令重放上述全部报告的入口。

### 超时与进程监督

监督进程独立于 Electron 和测试执行进程，持有明确的子进程句柄、开始时间和总期限。一次工具调用的 60 秒等待窗口不等于整个测试允许时长；长任务后台执行并定期读取状态，工具等待结束后仍能取得进度和最终结果。

历史视觉脚本的 watchdog 为 115 秒，现有浏览器服务脚本为 120 秒，都只适用于各自范围。2026-09-13 的全量 `npm test -- --maxWorkers=1 --reporter=verbose` 实测 599,334 毫秒，约 10 分钟。新一轮应按机器和规模给出有余量的有限预算，例如 15 分钟起，并记录预算和实际耗时，不能照搬 60 秒总上限或无限等待。

区分单步等待、服务请求超时和整轮超时。定期保存进度，超时先保留最后阶段、输出尾部及可取得的截图，再终止本次进程树。普通 `child.kill()` 未必能回收孙进程；按 PID 和启动归属核实，只清理本次 Electron、Node、临时服务及监听，不按进程名批量结束正在使用的 GoodBuddy。信号退出、超时或报告缺失均不得记为通过。

## 4. 视觉与原生交互取证

受影响组件默认检查浅色和深色主题，以及 `1280×800`、`960×720`、`720×640`、`640×420` 内容区。它们对应设计系统的宽度区间及短窗口压力场景；产品另有断点、长文案或缩放要求时补充场景。记录实际 `innerWidth/innerHeight` 和设备缩放，不能用带窗口边框的尺寸替代。

每个场景同时保存动作结果、计算值和 PNG。检查页面、弹窗、菜单、字段及操作区的 `getBoundingClientRect()`，并对文档及局部滚动容器比较 `scrollWidth/clientWidth`、`scrollHeight/clientHeight`。正常纵向滚动不算失败，但裁切、无意横向溢出、按钮不可达或滚动内容被粘附区遮挡需要单独断言。

Portal 必须真的挂在生产位置。检查它是否在工作区外、主题变量是否仍可用、背景是否随主题切换；读取字段 `fontFamily`、`fontSize`、高度、边框、圆角、背景和文字色。共享 `.field`、字体令牌、PageTabs、SegmentedControl、Switch、Checkbox、EmptyState 和通知模式按 [UI 设计系统](../../UI-DESIGN.md)核对，不在本规范重新定义视觉数值。

密码显隐前后比较尺寸、字体、背景及相邻按钮位置；敏感输入只能用明确标识的 fixture 文本截图。选中态在 hover 时保持可辨，禁用项不会被键盘选中。底部保存区除了位于窗口内，还要验证聚焦的字段没有落到页头或粘附底部下面、末项可滚到并操作、焦点轮廓可见。

键盘采用 `webContents.sendInputEvent` 的 `keyDown/keyUp`，文本可用 `insertText`。窗口和 webContents 先获得焦点；必要时为 Enter 发送 `char`。按控件实际语义覆盖 Tab、Shift+Tab、Space、Enter、Escape、方向键、Home/End，并验证 `document.activeElement`、选中值和弹窗状态。`dispatchEvent(new KeyboardEvent(...))` 不触发同等 Chromium 默认行为，不能用来证明原生 Tab 顺序、Space 开关或 select 行为。

检查焦点进入弹窗、正反向循环、背景 `inert`、关闭后恢复触发按钮；菜单跳过禁用项、选择后回到触发器；页签的选中状态与面板一致。表单取消保留原值，错误关联正确，失败保留输入和可操作上下文；成功通知不重复显示。

PNG 必须实际打开审阅，并写明审阅方式、具体文件及发现。拼图用于找异常，小尺寸、焦点、字段和异常截图还要按原尺寸检查；确认字体、对比度、密度、层级、遮挡和控件是否像共享设计。截图文件存在或自动像素相同都不能替代审阅。只读了 JSON 时应写“PNG 未审阅”。

## 5. 保存、真实生成与故障

涉及保存时，从实际 UI 修改、提交、重新打开，核对生产读取值；涉及重启持久化时关闭本次 App，用同一隔离 profile 重启，再验证状态。fixture 返回保存成功只证明前端反馈；数据库有记录也不等于已经完成重启验证。空列表、无搜索结果、加载、失败、取消和重试按改动范围检查，明确故障是 fixture 注入、传输注入还是真实服务返回。

完整 App 的真实生成场景从实际输入区选择范围、提交最短必要问题，等待检索、生成及完成事件，核对持久化答案和引用；点击生成答案中的引用，检查弹窗片段、文档/分块定位与生产保存的引用匹配。需要证明依据进入模型时，在 Main 本地解码实际 Provider 请求和内嵌证据后比较，只归档布尔结果与计数。不要用原始序列化字符串匹配造成转义误判。

不得注入答案、引用、消息或 Agent 事件后宣称真实生成/引用验收通过。生产 IPC 测试可用最小验证 DOM 观察真实事件，但要如实标注 Renderer 范围。真实片段进入模型、短答案依据匹配和引用正确，只证明该次路径；不能据此推断复杂问答质量。

### 配置与传输

凭据只在 Main 通过既有存储读取和解密。需要复用默认模型时，将所需加密配置复制到隔离 profile，核对原配置未改变；safeStorage 依赖 OS 用户及加密元数据，解密失败应保留诊断，不改为明文或修改正式设置。历史完整 App 驱动仅复制必要的加密 `os_crypt` 元数据，并在 Main 保存 IPC 边界替入测试 KB 密钥，这一替换必须在方法说明中披露。

HTTPS 验证在隔离子进程显式使用严格证书校验。检查实际 fetch/undici dispatcher、证书忽略开关和监听器；仅设 `NODE_TLS_REJECT_UNAUTHORIZED=1` 不足以证明请求没有被其他配置绕过。历史完整 App 在隔离子进程设置 `rejectUnauthorized: true` 并移除测试环境的证书绕过，不修改生产源码或全局配置。

端点沿用已授权配置，不在验证中擅自升级或替换协议。历史 Dify/FastGPT 使用严格 HTTPS，RAGFlow 和默认模型使用已配置的 HTTP。报告应分别记录各服务的 `http`/`https` 及 HTTPS 校验情况；`strictTls: true` 不能写成“全部请求 HTTPS”。

### 调用计数与失败诊断

从应用实际 HTTP dispatch 边界计数，按运行、场景、阶段和 attempt 记录。区分模型请求、KB 目录、详情、绑定验证检索、聊天预检索、按需工具检索；另记输入区提交数、工具执行数、Runtime 自动重试及人工/驱动重跑。一次提交可产生多个模型请求，不能用提交数代替用量。

计数包含失败、取消前已发出的请求和重跑；启动前失败仍记 attempt，但网络数为 0。已发出但未收到响应的请求也计入，并标明结果未知。上游代理内部重试、服务商 Embedding/重排不可观察时直接写不可观察。旧轮次缺少日志时报告已知精确增量与缺口，不能把估算区间当精确总数。

失败记录保留场景、动作、预期/实际、阶段、HTTP 状态或脱敏错误码、退出信号、截图和重跑关联。区分产品故障、harness 错误、环境阻塞与超时。修正比较器或选择器后重新取证，保留首轮失败，不将其改写为通过或误称为产品修复。控制台错误、`page` 加载失败及进程崩溃也应纳入报告。

## 6. 可复用检查清单

未执行项注明 `not-run`、原因和影响；不适用项注明 `not-applicable`。重启、错误或平台场景也须有本次执行证据后再勾选。

- [ ] 列出变更范围、所选测试层、fixture/真实边界、当前源码及构建标识。
- [ ] 确认桌面会话、依赖、临时目录、隔离 profile、safeStorage 前提及原设置不变。
- [ ] 从独立 supervisor 启动当前 Electron，清除 run-as-node 环境，设置阶段与整轮期限。
- [ ] 保持生产 Main/Preload/Renderer 路径与安全标志，披露测试替换点。
- [ ] 检查浅深主题、四组内容区尺寸，以及实际长文案和空/加载/失败状态。
- [ ] 真实 Portal 的共享字体、字段、主题和控件计算值正确；密码显隐无布局跳变。
- [ ] 检查文档和局部溢出、滚动、焦点轮廓、底部按钮及字段无遮挡。
- [ ] 原生键盘完成适用流程，菜单、页签、开关、焦点循环与恢复都有动作后断言。
- [ ] 打开 PNG 审阅，记录文件、方式、缺陷及修正后的复验。
- [ ] 按影响验证真实保存、重新打开、重启、取消、错误恢复；fixture 不冒充持久化。
- [ ] 需要真实生成时，从所选层的入口取得真实答案/引用证据，完整 App 场景实际点击引用。
- [ ] 精确统计模型与 KB dispatch、失败和重跑，协议与 TLS 分开记录。
- [ ] 源码变更完成仓库要求的 `npm test`、`npm run typecheck`、`npm run lint`，保留完整结束状态；仅修改文档时做文档检查即可。
- [ ] 报告覆盖范围、未测项和失败诊断，核对测试前后源码/产物是否被并行修改。
- [ ] 脱敏后归档摘要，清理本次进程、监听、配置和临时敏感资料，记录清理结果。

## 7. 脱敏报告格式

下例是未执行模板，所有测量值为 `null`，没有伪造通过证据。`null` 表示未知或未测，只有确认没有调用时才填 `0`。状态使用 `not-run`、`passed`、`failed`、`blocked`、`not-applicable`；场景及断言逐项记录，不能只有总数。

```json
{
  "schemaVersion": 1,
  "kind": "template-not-executed",
  "runId": null,
  "source": { "commit": null, "dirtyScope": [], "artifactHashes": {} },
  "environment": { "os": null, "arch": null, "electron": null, "locale": null, "scale": null },
  "scope": { "layers": [], "fixtureIpc": null, "fullProductionApp": null, "substitutions": [], "limitations": [] },
  "execution": { "command": null, "status": "not-run", "timeoutMs": null, "elapsedMs": null, "exitCode": null, "signal": null },
  "scenarios": [
    {
      "id": "replace-with-scenario-id",
      "layer": null,
      "theme": null,
      "viewport": null,
      "attempt": null,
      "rerunOf": null,
      "actions": [],
      "checks": [{ "name": "replace-with-check", "status": "not-run", "expected": null, "actual": null }],
      "computed": {},
      "screenshots": [],
      "pngReview": { "status": "not-run", "method": null, "files": [], "findings": [] }
    }
  ],
  "requests": {
    "boundary": "application HTTP dispatches for this run only",
    "model": null,
    "kbTotal": null,
    "kbCatalog": null,
    "kbDetail": null,
    "kbRetrieval": null,
    "runtimeModelRetries": null,
    "composerSubmissions": null,
    "toolExecutions": null,
    "ledger": [],
    "unknowns": []
  },
  "transport": [{ "serviceAlias": "service-1", "protocol": null, "strictCertificateValidation": null }],
  "failures": [],
  "cleanup": { "testProcessesStopped": null, "listenersClosed": null, "isolatedProfileRemoved": null, "sensitiveArtifactsRemoved": null, "originalSettingsUnchanged": null },
  "redaction": { "status": "not-run", "omitted": ["credentials", "endpoints", "private identifiers", "business and answer prose", "content hashes"] }
}
```

`ledger` 每条记录使用匿名服务标识、场景 ID、attempt、阶段、请求种类、HTTP 方法、协议、状态/错误类别和是否重试；不含 URL、请求头或正文。`failures` 使用同一场景/attempt 关联诊断与重跑。计算值可保存字体、颜色、边界与溢出数，排除 `textContent` 等可能带出业务文本的字段。

截图、完整 DOM、请求体和本地数据库可能含敏感资料，只在本次临时目录用于核验。仓库归档不包含凭据、真实端点、私有配置/远端文档 ID、问题和答案正文、业务片段或这些内容的哈希。需要比较时在本地完成，归档布尔结果、长度或数量；源码/构建产物哈希可用于标识测试版本。可归档截图必须使用无敏感数据的 fixture 或完成脱敏审阅，路径使用相对证据名。

先保留可复查的脱敏失败诊断，再清理原始敏感资料；不要为清理而丢掉失败原因。结束时删除本次隔离配置、加密凭据副本、数据库及不需保留的临时构建，关闭测试进程和端口，核对正式设置未改。仍需本地排障的资料注明临时位置用途与待清理项，不把临时绝对路径当永久证据链接。功能进度链接最终脱敏摘要，并明确原始 harness/截图是否仍可取得。
