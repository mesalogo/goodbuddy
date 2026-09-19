# HTTP PaddleOCR-VL 实施与验证

## 状态

当前状态以 [2026-09-19 实现与验证](#2026-09-19-实现与验证)及[附件操作布局复验](#2026-09-19-附件操作布局复验)为准。
以下至“菜单核对检查”的内容是实施前历史记录，保留原日期与原调用数。

2026-09-18：完成规划文档和独立 HTTP 探索脚本。FR-H1 至 FR-H12 均未完成生产实现，
现有设置、解析器、数据库、界面与 Agent 未因本次任务改变。下一步实现顺序见
[技术设计](./http-paddleocr-vl-technical-design.md#实施与验证顺序)。

同日按用户确认补充 [PRD](./prd.md#131-范围与存储边界) 的会话文件资源、数据库关联、
生命周期及配置预览验收，并修正技术设计中复用聊天内联图片存储的建议。本轮仅修改文档，
未新增服务调用；此前探测记录和下述调用计数保持原意。当前聊天解析文本仍用于临时 contexts
与队列，长期附件保存、重启预览和队列资源恢复均待实现与产品验收。

2026-09-18 图片路由文档核对：新增 FR-I1 至 FR-I5 及对应场景、逻辑，目录规划见
[结果与资源](./http-paddleocr-vl-technical-design.md#结果与资源)。源码核对确认
`ContextManager.storeImage/enrichRequest` 已走图片请求且会转码 JPEG，队列序列化保存上下文；
这不等于原图文件持久化。`ModelRuntime` 有图片能力检查，IPC 的图片工具路径另有引用处理，
尚不能宣称所有 Runtime 已提供统一的不支持提示与 OCR 选择。`DocumentParsingService`
当前单独处理 PDF、PPTX，其他格式转原生解析；显式纯图片 OCR 入口仍待实现。
`KnowledgeService.managedRoot` 由 Main 配为 userData/knowledge，受管原件按库、来源保存。
本次仅更新既有文档，保留原有探索脚本和历史证据，未调用 OCR 或聊天模型服务。

2026-09-18 完整交互设计：新增 [UI 设计](./ui-design.md)，同步 FR-I5、图片 OCR 发送方式、
历史/队列输入冻结及对应故事、逻辑、技术契约。设置、三入口预览、文档选图到会话、无有效
会话时的选择/新建、独立副本、幂等与移除、共享附件限制及完整验收矩阵均已写入设计。
这些是文档完成项，FR-H1 至 FR-H12、FR-I1 至 FR-I5 的新增生产能力仍未完成。

源码核对：设置实际使用 `SettingsCategoryHeader` 和 Portal 诊断框；`App.tsx` 提供聊天
reading 与知识库 master-detail 壳层，KnowledgeWorkspace 不再嵌套壳层；共享
`PageTabs`、`SegmentedControl`、焦点辅助函数可复用。现有 MarkdownRenderer 的
`skipHtml` 不能直接覆盖 OCR 混合 HTML 图表，技术设计已明确适配工作。附件 8 项、Main
16 项/12 MiB 规则已存在但部分常量仍分散，设计要求集中复用，没有新增选图配额。

剩余实现与验证包括 HTTP 和认证、高级选项及有效跨页样例、资产与数据库引用、预览与
选图生产接线、本地/远端实际图片输入、取消重启和删除清理。按
[技术实施顺序](./http-paddleocr-vl-technical-design.md#实施与验证顺序)推进，不代表允许
分批缩减产品范围。本轮未修改产品代码或探索脚本，未新增网络请求或模型调用。

## 菜单核对

2026-09-19 对照当前工作区源码检查入口，未运行 Electron；以下为源码事实，不是新增功能验收。
目标规则由 [UI 设计](./ui-design.md#11-入口与职责)维护。

| 入口 | 当前实现与证据 | 与完整目标的差距 |
| --- | --- | --- |
| 设置 → 文档解析 | [分类定义](../../../src/renderer/src/settings-categories.ts)包含 `document-parsing`；[解析设置](../../../src/renderer/src/DocumentParsingSettingsSection.tsx)提供本地模型管理、场景测试及纯文本诊断预览 | HTTP 配置、正文/图片/详情共享预览尚未接入；当前没有可用远程来源切换控件 |
| 应用中心 → 本机推理监控 | [应用定义](../../../src/renderer/src/ApplicationCenter.tsx)仍为四项；[监控](../../../src/renderer/src/LocalInferencePage.tsx)显示本地服务并加载/释放 OCR | 不承担远程 OCR 配置或管理；关闭监控入口不等于关闭解析能力 |
| 监控 → 模型与连接设置 | [IPC](../../../src/main/ipc.ts)的 `localInferenceOpenSettings` 只发出无分类的 `settingsOpen`；[App](../../../src/renderer/src/App.tsx)仅打开设置，[SettingsPanel](../../../src/renderer/src/SettingsPanel.tsx)默认分类为 `runtime` | 文案与默认落点不一致，未直达模型或文档解析；本轮仅记录，产品跳转未修复 |
| 聊天附件 | App 的附件按钮直接选文件；当前卡片显示名称、容量、缩略图或图标、文本 tooltip 和移除 | 尚无逐附件更多菜单、显式 OCR、解析结果预览、重解析或文档选图 |
| 知识库文档 | [DocumentsView](../../../src/renderer/src/KnowledgeWorkspace.tsx)提供任务、打开来源、失败文档重试和分块管理；来源行另有同步，库页头另有“用于当前对话” | 解析文档详情、成功文档重解析及选图须新增，不能把分块管理 Modal 当作已有完整解析预览 |
| 新建选图目标会话 | App 的 `startNewConversation` 返回布尔值，拒绝消息通道项目，并在复用空会话或新建后切到聊天 | 预览保留、目标 ID 取得及返回确认仍需接线；直接调用不满足 US-I9 |

本轮更正文档中“既有文档详情”的描述，补齐菜单矩阵及 US-H16 / A-15；队列修改统一先
恢复到草稿，显式图片 OCR 的上传说明与快速模式区别保持一致。根 UI 规范与双语功能清单
同步标明本轮范围；本地 OCR 仍为现有能力，HTTP 和新附件流程仍为规划。
未修改产品代码、探索脚本或既有应用排序，OCR、文本及视觉模型调用均为 0。

## 2026-09-19 实现与验证

HTTP PaddleOCR-VL 已接入 `DocumentParsingService` 的生产 PDF/PPTX 路径，设置支持来源切换、
Bearer 加密凭据、过滤、三态参数、跨页整理及连接诊断。新增会话文件资产、数据库归属、
可恢复草稿、历史预览、图片 OCR、选图独立副本、队列查看/恢复和解析中断记录。
知识库 managed/reference 派生资源单独保存，重解析成功才替换正文、chunks 和资源引用。
具体机制及设计差异见 [implementation.md](./implementation.md)。

### 验证层次

本轮 Windows x64、Electron 43.2.0、Node 24.18.0，使用当前工作区源码构建到
`node_modules/.document-e2e-out`，不覆盖其他运行中的 `out`，不改正式 profile。
测试保留 context isolation、sandbox 和禁用 Node integration，未改可信 sender 校验。
完整 App 的文件选择对话框由驱动返回合成 fixture；其余设置、解析、存储、预览和输入框
使用生产组件、preload 与 IPC。知识库批量生命周期部分通过生产 preload 调用，单独标注。

原始报告位于获准临时目录 `C:/Users/jiang/AppData/Local/Temp/opencode`。下表目录为该目录
的子目录；这些是本机取证路径，不是产品默认值。源码没有写入测试端点。

| 场景 | 层次及结果 | 证据目录 |
| --- | --- | --- |
| 自动/高保真扫描 PDF | 生产服务直调，无 OCR Broker 和本地权重；两页正文、两张内联插图，自动模式逐页渲染 | `document-production-XERonK` |
| 设置、测试、聊天附件、选图、显式 OCR | 完整 App；保存 HTTP 设置，HTML 表格、图片、测试隔离、文档选图、父附件独立移除、普通图片提取文字 | `document-app-GXKuZv` |
| 草稿及 OCR 结果重启 | 完整 App；两份草稿恢复、解析正文重开；重启没有 OCR 请求 | `document-app-MWn5Zn`、`document-app-GXKuZv` 的 restart 报告 |
| 实际输入框发送 | 完整 App；文档选图和 OCR 文本从 Composer 发送，回答 `Yellow`，草稿清空，历史预览存在 | `document-app-fuFTEY` |
| 已发送附件重启 | 完整 App；历史 OCR 正文包含合成金额，未重新解析 | `document-app-fuFTEY/restart-report.json` |
| managed/reference 导入、失败重解析、成功替换、删来源 | 当前 App 的生产 preload/IPC；两种模式各有两图四 chunks，故障注入为关闭的本机端口；失败保留 resultId/chunks，成功更换，删除不损坏会话图片 | `document-app-CBANUC`，前次 `document-app-n65dt4` |
| 解析中断恢复 | 完整 App 导入；驱动在 HTTP 发出前暂停并终止应用，重启显示中断，手动重试成功；未把暂停请求算作 OCR 调用 | `document-app-YmDUR9` |
| 队列能力失配、重启、恢复草稿 | 生产 IPC；首次暂扣 Renderer dispatch 以固定未执行队列状态，重启恢复真实分发；模型能力设为不支持图片，队列保留；附件恢复且文字合并，不重复排队 | `document-app-YyagTN` |
| 直连实际图片消费 | 当前生产 Main/IPC/ModelRuntime；观察 Provider 请求包含图片并收到 `Yellow` | `document-app-VmNZIG` |
| 托管 OpenCode 实际图片消费 | 当前 Desktop 至共享 Linux x64 Host；使用已有 Host 凭据和固定主机密钥，独立 `/root/tmp/goodbuddy-document-*` 目录；透传代理只计数与核对图片，Provider 返回 `Yellow` | `document-app-gzC5ZV` |
| 托管 OpenCode 文档选图发送 | 生产导入、持久化选图、移除父文档后发图；Provider 请求有图，回答 `Yellow`，测试目录回收 | 最终 `document-app-iZSxV8`，前次 `document-app-zqnBBt` |
| 跨页表格效果 | 生产解析服务；两页连续设备发票表从两个 HTML table 变为一个，32 个条目各出现一次；分组来源页为 `[1,2]` | `document-production-Twr0N4/report.json`、`table-check.json` |
| 图片文件与引用回收 | 真实 SQLite/文件测试；原字节、重启、共享消息引用、队列与草稿独立、数据库无原图 Base64、解析中断原件保留 | `conversation-attachment-storage.test.ts` |
| HTTP 认证及失败 | 真实 loopback HTTP fixture；生产客户端 Bearer、401、取消和 health/OpenAPI；公网/内网认证部署未测 | `http-document-ocr.integration.test.ts` |

HTTP OCR 本身只运行在 Desktop。未修改 Agent daemon、传输协议或远端 OCR 实现；远端验证
使用当前 Desktop 接入既有 Agent 图片链路，不将此次结果记作新 Agent 包发布或安装验收。

### 界面取证

`document-app-GXKuZv` 的视觉复验覆盖浅/深主题、约 1279×800、959×720、719×640、
680×561 CSS 像素及 200% 缩放下约 639×400。原生最小窗口限制使请求的 640×420 实际为
680×561，不能写作实际验证了 640×420。十组测量中页签未收缩、主体可滚动、操作区可见，
无横向溢出。原生 `Right` 和 `Escape` 通过；最初驱动用 `ArrowRight`，未产生 Electron
原生键事件，修正后复验。已打开审阅浅色窄窗口和深色 200% PNG。

诊断初次完整 App 截图发现 HTTP 被显示为“本地 OCR”、附件按钮继承固定 28px 宽度，
均已修正。测试菜单统一到分类页头，诊断关闭恢复测试按钮焦点。知识库使用详情/返回列表，
普通历史和队列分别只读；队列修改入口为“恢复到草稿”。

隔离生产构建启动有 4 条打包字体 data URI 被现有 CSP 阻止的控制台记录，本轮未修改字体或
CSP。截图使用系统字体回退可读；此项不能算作无控制台告警。

### 自动检查

最终完整 `npm test`：399 个文件通过、9 个跳过；4,779 项通过、67 项跳过，耗时 816.55 秒。
最新 `npm run typecheck`、`npm run lint` 通过。隔离 `electron-vite build` 通过，保留既有
workspace-management 动静态导入警告。没有提交或推送。

首次全仓运行有 9 项失败，其中 8 项是新增参数/schema 后的旧断言，1 项为并行画布导航的
Quill 加载失败；最终完整运行均已通过。中途一轮超过 240 秒工具期限，未产生完成报告，
不计为通过。其他聚焦失败包括新增测试缺少 cleanup、旧附件失效行为断言、诊断焦点返回，
均保留修正后的回归。

队列验证发现提前保存用户消息导致重启删除未执行队列的缺陷，已修正并复验。另有测试驱动
误读升级页首次 load、未等待菜单挂载、文本换行比较器使用了转义字符串等失败；这些没有
被记作产品已通过，最终队列证据采用 `document-app-YyagTN`。

### 调用计数与边界

按保存报告可核对 **28 次远程 layout、1 次 restructure、0 次远程 health/OpenAPI GET**。
另有一次表格测试被工具超时终止：设置已进入第二次 layout 阶段，可以确认它包含 2 次
layout，是否已经发出 restructure 缺少 dispatch 日志。故本轮已知 layout 合计 **30 次**；
restructure 可核对 1 次，另最多 1 次状态不明。未将 2026-09-18 探测计入本轮。

模型请求报告中可观察到 7 次 Provider dispatch，包含早期驱动提前退出/超时的 3 次。
`document-app-zMeC7X` 的远端调用不经过 Desktop fetch，另从 Agent 的操作 ID 记录确认
1 次已完成；完整 Composer 发送 `document-app-fuFTEY` 使用独立 Runtime，桌面 fetch 计数
不覆盖其内部 Provider 请求，已收到真实 `Yellow`，该次至少 1 次调用。
因此本轮可精确核对 **8 次模型请求，另有至少 1 次完整 UI Runtime 请求**；早期队列驱动
超时且缺少报告的轮次不能给出完整 Provider attempt 数。后续驱动在 dispatch 时单独写计数，
不以输入框提交数代替实际调用数。

未执行 macOS、Linux Desktop/arm64、本地 OCR 各档位、Continue/DeepSeek Harness 的本轮真实
图片消费；未验证方向分类、去扭曲、印章、图表和公式选项的效果，也未验证真实磁盘满场景。
跨页表格结论只覆盖上述连续表格，标题重定级没有独立有效样例。完整 App 的原生浏览器
遮挡没有在本轮单独实测，继续使用共享 Modal 遮挡机制及其既有回归。

上述未测项保留在验收矩阵，不能将 A-01 至 A-15 的全部分支写成已通过。

## 2026-09-19 附件操作布局复验

对应 FR-H12。检查实际工作区后保留已有 OCR、存储、预览与队列实现，修正草稿、历史消息
及队列预览的操作布局。查看结果与更多操作改为同排 32px 图标按钮，草稿移除使用同尺寸
叉号；保留含附件名的可访问名称、悬停提示和键盘聚焦说明。文件名省略，状态与大小可换行。

文件名核对覆盖 `ContextManager` 导入、显式 OCR、重解析、`ConversationAttachmentStorage`
和结果清单。源码将 UUID 用于资源标识，显示名来自导入文件名；已有存储测试验证原名称在
重启后保留。本轮没有截图对应的原文件及记录，无法确认该 UUID 名称的来源，未作猜测性改名。

`AttachmentActions.test.tsx` 验证图标名称、预览关闭和菜单 Escape 焦点恢复、菜单方向键
及队列只读动作。`tests/attachment-layout.electron.test.ts` 加载生产 `ChatMessageRow`
与样式，在 Windows Electron 中验证浅/深主题、1000/720/360px 宽度及 200% 缩放；两个
操作均为 32px、同排，长文件名截断，卡片高度低于 110px，无页面横向溢出。原生 Tab、Space
打开菜单及 Escape 返回通过。此用例替代设置快照接口，不调用 OCR，不作为完整 App 解析验收。

新增 Electron 用例初次受系统缩放的亚像素取整影响，测得根容器宽 360.57px；驱动固定
device scale factor 后复验。驱动 Enter 未产生按钮激活，改用原生 Space 后菜单流程通过。
这两次失败未记作产品通过，也未通过修改页面溢出样式绕过测量。

定向 10 文件、116 项测试通过，覆盖 HTTP 客户端及 loopback、解析服务、设置、会话文件
存储、ContextManager、预览、附件操作及共享 UI。新增 Electron 用例单独通过；最终
`npm run typecheck`、`npm run lint` 通过。全仓测试结果完成后补记。

本轮未修改 Main、Preload、Agent 或 Runtime 请求链路，未发起真实 OCR、文本或视觉模型
请求。前轮实际调用与未测验收项仍以上节记录为准，不能由本次界面回归推断全部高级选项、
Runtime 组合和跨平台验收已完成。没有提交或推送。

## 复现

脚本为 [`scripts/paddleocr-vl-probe.mjs`](../../../scripts/paddleocr-vl-probe.mjs)，
使用 Node 内置 fetch 和已安装的 `@napi-rs/canvas`，不新增依赖。`--endpoint`、`--out`
必填，无产品地址默认值；`--out` 必须是已存在的临时或 Git 忽略目录，由调用者选择。
脚本在其中创建独占子目录，不覆盖历史运行。中文 fixture 需 Microsoft YaHei 或 Noto Sans
CJK SC；缺字体导致文字未绘制时中文断言会失败，先检查 `fixture.png`。

本次实际执行命令（地址仅是获准使用的测试目标）：

实测时脚本名为 `.cjs`；交付前按仓库脚本惯例改为 `.mjs`，只调整模块导入，复现时使用
下列最终路径。请求、fixture 和断言逻辑未变。

```powershell
node scripts/paddleocr-vl-probe.mjs --endpoint http://10.7.0.152:8080 --out C:/Users/jiang/AppData/Local/Temp/opencode --mode discover
node scripts/paddleocr-vl-probe.mjs --endpoint http://10.7.0.152:8080 --out C:/Users/jiang/AppData/Local/Temp/opencode --mode full --timeout-ms 60000
```

`discover` 执行 health、OpenAPI 共 2 个 GET；`full` 另执行 4 次 layout 请求和 2 次
restructure 请求。无自动重试，每请求默认超时 60 秒、最多 120 秒，响应流上限 32 MiB。
完整运行至多 8 个请求，默认最坏请求等待预算 480 秒；失败停止后续调用并写 report。
不读取用户资料、不使用凭据、不跟随重定向、不获取返回的图片 URL。

输出包括合成 PNG、两页纯图像 PDF、OpenAPI、选项 schema、各请求选项、逐页 Markdown、
摘要、解码后的插图与 `report.json`。摘要记录 HTTP 状态、耗时、页标签、图片格式、尺寸、
字节数、SHA-256 和页内引用对应关系，不输出 Base64 或返回 URL。Markdown 保留服务原文，
图片本地文件名映射在 `*-summary.json`；它不是已改写资源路径的产品预览。

## 实测结果

环境：Windows x64，Node 24.18.0。fixture 为 1200 × 1600 像素合成报告，包括中英文、
页眉页脚、页码、风景插画和两列表格；PDF 两页均为嵌入 JPEG，无原生文本层。与先前仅文字
PNG、文本 PDF 探测不同，本次验证了扫描型输入和插图输出。

最终运行目录：`C:/Users/jiang/AppData/Local/Temp/opencode/paddleocr-vl-L8LJIm`，
运行时间为 `2026-09-18T05:04:33.802Z`。23 项断言全部通过，8 个请求均 HTTP 200。

| 请求 | 选项差异 | 耗时 | 结果 |
| --- | --- | --- | --- |
| PNG 默认 | 省略 ignore labels，图片 true，可视化 false | 1439 ms | 804 字符，中文及金额正确；页眉页脚不进入 Markdown |
| PNG 保留标签 | `markdownIgnoreLabels: []` | 937 ms | 875 字符，页眉页脚可见 |
| PNG 排除正文 | `['text','header','footer','number']` | 931 ms | 696 字符，金额正文被排除；表格和插图保留 |
| 两页 PDF | 保留标签 | 2490 ms | 每页 875 / 847 字符，Page 1 / Page 2 顺序正确，均含表格和插图 |
| 重组关闭 | `mergeTables: false, relevelTitles: false` | 146 ms | 两页文字、图片引用保留 |
| 重组开启 | 两项均 true | 167 ms | 两页文字、图片引用保留，与关闭组 Markdown 相同 |

PNG 插图为裸 Base64 JPEG，解码后 899 × 482、23,708 字节；PDF 两页分别为
899 × 482、25,849 字节和 898 × 481、25,585 字节。未观察到 URL 或 data URI 图片；
这两种返回形式的分支尚无真实服务验收。Markdown 插图是 HTML `<img>`，表格是 HTML
`<table>`，不能只按 Markdown `![]()` 链接提取资源。

本次 `prunedResult` 没有 `page_index`，`page_count` 是 null。第一个 full 探测曾把
零起始 page_index 当断言，因此退出非零；服务请求本身全部成功。该运行同时发现默认
sans-serif fixture 没有显示中文。修正字体并将页码检查改为合成页标记顺序后完整复测。
第一次 full 的两页图片键相同，证实不能直接用 Provider 图片键作为文档级唯一标识。

## 调用计数

本轮实际发送：1 次 discovery 加 2 次 full，共 **6 个 GET、8 次 layout 推理请求、4 次
restructure 请求**；layout 输入共 10 页图像（每轮 3 张 PNG 加 2 页 PDF）。重组接口内部
是否另调用模型无法从客户端确认，以上计数为 HTTP 调用数。文本模型调用 0 次。
最初一次终端内联 Node 命令因 shell 转义在发请求前语法失败，不计为 HTTP 请求。

此前对话的探测记录另有 3 次成功 layout 请求（首次 PowerShell 图片请求、Node 双语 PNG、
两页文本 PDF），不包含在上述本轮计数；合并已知历史则为 11 次 layout、4 次 restructure，
历史 GET 数未追溯。

## 能力边界

已验证 FR-H3/FR-H4/FR-H7 对应的服务基础事实：图片字节、页内链接、表格结构、中英文、
页眉页脚过滤及有界报告。未完成这些需求的产品持久化、界面与端到端验收。

重组请求成功仅验证接口形状及图片传递。fixture 中虽然有“continued”表格，但开关前后
输出相同，不能证明真实跨页合并或标题重定级生效。方向分类、去扭曲、图表、印章、图片块
OCR、公式编号、输出格式等只发现 schema，未主动启用探测，详见
[参数矩阵](./http-paddleocr-vl-technical-design.md#高级参数)。

未测认证、HTTP 异常返回、服务端取消、大文件、并发、其他操作系统、原生/扫描混合页的
产品选页策略、PPTX HTTP 路径和图片生命周期。单次样例耗时不构成吞吐或质量基准。
测试产物留在独占临时目录供复核，未写入聊天或知识库。

## 检查

已运行脚本 `--help`、语法检查及上述真实 full 探测。最终 `.mjs` 的 `--help`、
`node --check`、`npx eslint scripts/paddleocr-vl-probe.mjs` 均通过；27 个相对文件链接及
锚点检查通过，`git diff --check` 无空白错误。
文档扫描的 2 个阻断候选均位于既有本地 OCR 文档（PRD 的按幻灯片计数、聊天技术说明的
Worker 整体回收），是具体实现对比，保留原文。本次新增内容没有阻断项；复核候选主要是
已测/未测边界、字段清单和生命周期规则，人工审阅后保留事实限制。
没有生产功能变更，不运行整个产品测试集。

2026-09-18 PRD 补充检查：7 份 Markdown 的 30 个相对文件链接及锚点通过，含未跟踪文档的
空白与冲突标记检查通过，相关 `git diff --check` 无空白错误。使用 deai-writing 扫描并人工
复核，新增内容无阻断项；既有的 2 处实现对比按上述理由保留。复核候选为参数清单、验收条件
和实现边界，未删除这些必要限定。本轮未运行产品测试或服务探测，未修改产品代码。

2026-09-18 图片路由补充检查：7 份 Markdown 的 36 个相对链接及锚点通过，含未跟踪文档的
空白与冲突标记检查通过，`git diff --check` 无空白错误。deai-writing 扫描仍为既有 2 个
阻断候选，按上述实现对比理由保留；79 个复核候选经通读核对，主要为参数枚举、验收和
能力限制，新增内容无阻断项。本轮未运行产品测试、真实服务调用或提交。

2026-09-18 完整 UI 文档检查：8 份 Markdown 的 58 个相对链接（其中 30 个含锚点）均通过；
17 项需求、27 个用户场景、14 条逻辑规则的 ID 引用有效，每项需求均有场景与逻辑追溯。
检查包含未跟踪文档的行尾空白、文件末尾换行及冲突标记，`git diff --check` 通过。
目标目录中的缩减交付和选图待定措辞已核对修正；技术实现顺序和未实测能力边界保留。

使用 `python -X utf8` 运行 deai-writing 的 `deai_scan.py docs/features/document-processing --ext .md`，
新增内容无阻断项；既有 2 处实现对比按此前记录的理由保留。人工复核参数清单、需求条件、
状态规则及否定句候选，保留防止误发、丢图、误删和夸大验证范围的明确限制。通读核对 UI
容器、选择/附加状态、原图/文字发送方式、资源归属和失败替换规则，未将设计计作生产完成。
本轮 OCR 请求、文本/视觉模型调用均为 0；未运行产品测试、构建或远端 Host 验证，未提交。

2026-09-19 菜单核对检查：文档处理目录及关联根文档、导航文档共 13 份 Markdown，185 个
相对链接和其中 70 个锚点均通过；含未跟踪文档的行尾空白、末尾换行和冲突标记检查通过。
`git diff --check` 通过。deai-writing 扫描文档处理目录仍为既有 2 个阻断候选，按前述具体
实现对比理由保留；新增内容无阻断项，复核项保留必要的能力边界和菜单状态限制。关联文档
新增段落经人工审校；本轮没有产品代码变更，未运行产品测试或实机菜单验收。
