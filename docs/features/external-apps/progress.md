# 外部应用进度

只记录已验证的实现事实。需求见 [PRD](./prd.md)。

## 阶段 1：消息通道迁入应用中心（2026-10-15，已完成）

- 应用中心新增“平台应用”分组：微信 ClawBot、企业微信、钉钉、Telegram，显示实时连接状态；“打开”进入通道项目。
- 应用设置嵌入单个通道的编辑器（`ChannelApplicationSettings.tsx`），只保存当前通道和它的项目。
- 设置中心移除“消息通道”分类；通道项目空状态的“打开设置”跳到应用中心对应应用。
- 后端 `src/main/channels/` 未改动。

## 阶段 2：企业微信工具（2026-10-15，已完成）

对应 FR-5、FR-6（企业微信部分）和 PRD 7.1。

- `src/main/wecom/wecom-cli-service.ts`：安装固定版本 `@wecom/cli@1.3.4`、专用凭据目录、扫码/手动/复用通道机器人授权、断开、类别校验后执行命令、读取官方 Skill 说明、文档搜索。
- 内置工具 `wecom_guide`、`wecom_cli`（阶段 3 增加 `wecom_script`）经内置工具网关提供给直连模型、OpenCode、Continue；每次调用与当前设置取交集；`wecom_cli` 在直连模型下需要审批。
- 消息会话默认拿不到企业微信工具，开启“允许消息会话使用企业微信工具”后才提供。
- 企业微信应用设置新增“企业微信工具”卡片：授权、启用、13 个类别、消息会话开关、断开。
- 右侧工作区新增“企业微信”面板（工具启用且已授权时出现在“＋”菜单，应用中心“打开”也会打开它）：搜索文档、打开原文、用于当前对话。
- 官方 Skill 说明随应用打包在 `resources/wecom-skills`（阶段 3 起包含文档和 PPT 技能的脚本）。

## 阶段 3：飞书和企业微信技能脚本（2026-10-15，已完成）

对应 PRD 7.1（技能脚本）和 7.2。

- 飞书成为第五个消息通道：`FeishuChannelDriver` 用官方 SDK 长连接收消息、REST 回复；通道设置新增 App ID、App Secret、版本（飞书 / Lark）；数据库升到 v64，CHECK 约束接受 `feishu`，自动创建“飞书”通道项目。
- 飞书应用设置：手动填写或“扫码创建飞书应用”（扫码人自动成为允许的发送者）；“飞书工具”卡片含启用、6 个类别（权限管理默认关闭）、消息会话开关。
- 内置工具 `feishu_doc`、`feishu_wiki`、`feishu_drive`、`feishu_bitable`、`feishu_perm`、`feishu_app_scopes`，经网关提供；`feishu_perm` 在直连模型下需要审批。
- 右侧工作区新增“飞书”面板：浏览知识空间、知识库页面和云空间文件夹。
- 企业微信新增 `wecom_script` 和“在线 PPT”类别：官方 `build_docx.py`、`build_page.py` 等脚本随应用打包，在 GoodBuddy 自建的 Python 虚拟环境中运行。

### 私有化：企业微信内置（2026-10-15）

- `wecom-cli` 二进制和技能脚本所需的 9 个 Python wheel 改为打包时内置（`build/wecom-resources.cjs`，锁文件 `resources/wecom-artifacts.lock.json`），运行时不再访问 npm 或 PyPI。
- 开发环境首次需运行 `node build/wecom-resources.cjs` 准备 `.runtime-resources/wecom-<arch>`。
- 验证：屏蔽网络（代理和 `PIP_INDEX_URL` 指向不可用地址）后，用内置二进制和内置 wheel 建立虚拟环境，官方 `build_docx.py` 生成了 `.docx`；`tests/wecom-resources.test.ts` 覆盖校验失败和不支持的架构；`tests/build-release.test.ts` 通过。

## 阶段 4：设置标签页、扫码修正和 `@` 引用（2026-10-16）

- 应用设置改为与系统设置相同的弹窗：左侧按“工作区应用 / 平台应用”列出可配置应用，右侧是所选应用设置。平台应用分“连接 / 消息 / 工具”标签页（工具页仅飞书、企业微信）。
- 飞书扫码创建应用后直接启用消息通道（扫码人为唯一允许的发送者）；修正扫码完成后每次状态推送都重新读取设置、冲掉未保存表单的问题。
- 飞书知识空间提示按飞书 Wiki FAQ 改为“把机器人拉进群，再把群加为知识空间成员”或“添加文档应用”；根目录浏览失败时显示飞书返回的错误和缺少的权限。
- 企业微信二维码：`wecom-cli` 1.3.4 打印的 `/ai/qc/gen?scode=` 是展示二维码的网页，手机端要扫的是 `/ai/qc/c?s=` 地址。现在从输出中取 `scode` 生成扫码地址，并保留“在浏览器中打开二维码”的备用链接。用真实 CLI 输出解码终端二维码，与生成地址逐字一致。
- 企业微信扫码改由 GoodBuddy 直接调用扫码接口（`wecom-bot-registration.ts`），不再启动 `auth init --noninteractive`：拿到 Bot ID 和 Secret 后签发工具凭据，并把同一机器人存入消息通道（扫码人为唯一允许的发送者，通道启用并自动重启）。原因是 CLI 把 Secret 加密存在自己的目录里，GoodBuddy 读不到，无法填入消息通道。
- 右侧工作区“＋”菜单：工具已启用但不可用的平台也会列出，显示原因和“前往处理”。
- FR-7 `@` 引用：见 PRD。新增 `feishu:search-documents`（应用可见范围内按标题过滤，最多 30 次请求、30 条结果）；企业微信面板搜索和 `@` 搜索都受“文档管理”类别约束。

## 阶段 5：应用开关统一、断开、面板筛选和工具结果卡片（2026-10-17）

- **一个应用开关**：飞书、企业微信工具不再有单独的总开关，可用性跟随通道的启用状态（`resolveAppEnabled` / `isEnabled`，快照新增 `appEnabled`）。通道设置变化后主进程推送新的工具快照。旧设置文件里的 `enabled` 保留但不再使用。
- **扫码即可用**：飞书、企业微信扫码保存凭据后由主进程直接启用应用（不再由界面另行保存）。启用不再要求至少一个允许的发送者：没有发送者时连接成功但不处理消息。
- **断开**：飞书、企业微信、钉钉、Telegram 的“连接”页都有“断开并删除本机凭据”（确认后关闭应用，删除凭据和发送者；企业微信同时删除工具授权）。新增 IPC `settings:channels:disconnect`。Telegram 仍保留“保存时清除 Token”。
- **知识库依赖文档**：`feishuCategoryUsable`，关闭“文档”时知识库不出现在工具、面板新建和 `@` 中，设置页显示为不可用。
- **应用中心平台行**：未配置只显示“连接”；显示账号、能力标签、打开去向；应用关闭时“打开”不可用；顺序为飞书、企业微信、钉钉、微信、Telegram；底部提示一个平台一个账号。
- **应用中心卡片化（2026-10-19）**：内置应用和平台应用改为卡片网格（弹窗宽 1040px），分为“内置应用”“平台应用”两组；搜索框带图标和占位提示。取消排序：内置应用固定按 `applicationDisplayOrder` 排列，左侧常驻入口也按这个顺序；`applicationNavigation.pinned` 新增 `knowledge`（默认常驻）和 `device-sharing`（默认不常驻），旧的 `order` 保留但不再读取。卡片底部：内置应用为“启用”和“常驻菜单”开关、“打开”、设置按钮，知识库只有“常驻菜单”和“打开”；平台应用为“启用”开关（写入通道的 `enabled`）、“打开”、设置按钮，未配置时只显示“连接”。平台卡片显示带颜色圆点的状态和账号标签，飞书工具类别合并为“工具 · N 类”，描述最多两行；已关闭的应用卡片图标和标题变灰。
- **右侧面板**：两个平台都有搜索框、空间下拉、类型筛选、数量、更新时间和路径，以及新建和上传。企业微信新增“最近浏览”“我创建的”（`doc search` 按 visitor / creator 过滤，近 30 天）和“微盘”（`disk files list`）；新建用 `doc create`，上传用 `disk files upload`。飞书新建文档或知识库页面，上传用 `drive/v1/files/upload_all`（≤ 20MB，按官方文档的 multipart 字段）。上传文件由主进程文件对话框选择，界面不传路径。
- **工具结果卡片**：对话中飞书、企业微信工具调用下方显示读取或写入的内容类型、标题、数量和“打开原文”，写入时提示可在平台历史版本中恢复（`platform-tool-card.ts`）。

### 与 PRD 的差距

- 私聊和群策略仍只有白名单和“群聊被提及时响应”；没有配对审批（FR-4）。
- 没有“使用记录”标签页（FR-3）。
- 没有连接向导和完成页，连接在“连接”页完成（FR-2）。
- DeepSeek Harness 不接收企业微信和飞书工具。
- Windows arm64、Linux loongarch 等架构没有官方 `wecom-cli` 二进制，这些安装包不含企业微信工具。
- 安装包体积增加约 25MB（每个架构一份 CLI 和 wheel）。
- 飞书通道不收发图片和附件；钉钉文档工具未开始。
- 飞书图标是 GoodBuddy 自绘的通用图形，不是飞书商标。

### 验证

- `npm run typecheck`、`npx eslint src`：通过。
- `npx vitest run src/renderer`：132 个文件、1893 个用例通过。
- `npx vitest run src/main/ipc.test.ts src/main/agent src/main/wecom src/shared src/preload`：113 个文件通过（4 个按条件跳过）。
- `npx vitest run tests`（Electron 集成）：52 个文件通过、7 个跳过，包括 Telegram 生产 IPC 冒烟测试。
- `npm run build:bundle`：通过。
- 真实环境手工验证（Windows x64）：通过 npm 安装 CLI，状态显示“未授权”，无效凭据返回企业微信服务端错误 853000，扫码链接被正确捕获，Skill 说明可读取。**未用真实企业微信账号完成扫码授权和业务命令调用**，也未在 macOS、Linux 上验证。

阶段 3（2026-10-15）：

- `npm run typecheck`、`npx eslint src`：通过。
- `npx vitest run src`：491 个文件通过、8 个跳过（6187 个用例）；第一次运行时 `local-runtime-reuse.test.ts` 在满载下超时一次，该测试与本次改动无关，单独运行 3 次均通过。
- `npx vitest run tests`（Electron 集成）：52 个文件通过、7 个跳过。
- `npm run build:bundle`：通过。
- 真实环境手工验证（Windows x64）：
  - 飞书 SDK 可加载；无效凭据被飞书服务端拒绝；扫码创建应用接口返回真实二维码地址（有效期 600 秒）。
  - 企业微信技能脚本：以本机 Python 3.13 创建虚拟环境、从 PyPI 安装 5 个依赖，官方 `build_docx.py` 生成了 `.docx`，`build_page.py --help` 正常；未开启类别时脚本被拒绝。
  - **未用真实飞书应用收发消息或调用文档接口，也未用真实企业微信账号生成 PPT。**

阶段 4（2026-10-16）：

- `npm run typecheck`、改动文件的 eslint：通过。
- `npx vitest run src/renderer src/main/feishu src/main/wecom src/shared src/preload`：182 个文件、2242 个用例通过。
- `npx vitest run tests/telegram`：通过（Telegram 生产 IPC 冒烟测试已按新标签页更新）。
- 真实环境（Windows x64）：用内置 `wecom-cli` 1.3.4 运行 `auth init`，解码其终端二维码，内容与新生成的扫码地址一致。
- **未用手机实际扫码；`@` 搜索未连真实飞书、企业微信账号验证。**

企业微信扫码同时填入消息通道（2026-10-16）：

- 类型检查（node、web）和改动文件的 eslint：通过。
- `npx vitest run src/main/wecom src/main/channels src/main/ipc.test.ts src/renderer/src/WecomToolSettings.test.tsx src/renderer/src/ChannelApplicationSettings.test.tsx`：通过。
- 真实接口（Windows x64）：`/ai/qc/generate` 返回 `scode` 和 `auth_url`，`/ai/qc/query_result` 在未扫码时返回 `{"status":"init"}`，取消后停止轮询。
- **扫码成功后的 `bot_info` 字段（`botid`/`bot_id`、`secret`）和 `identity whoami` 的 userid 字段来自二进制字符串和推断，未用真实扫码确认；消息通道用扫码机器人建立长连接也未验证。**

阶段 5（2026-10-17）：

- `tsc -p tsconfig.node.json`、`tsc -p tsconfig.web.json`、改动文件的 eslint：通过。
- `npx vitest run src`：493 个文件通过、8 个跳过；6 个失败用例在 `App.test.tsx`（任务条“空闲/运行中”重复）和 `AppSidebarLayout.test.ts`，来自工作区中他人未提交的 `ConversationTaskStrip.tsx`、`styles.css` 改动，暂存这两个文件后这些用例通过。
- `npx vitest run tests/telegram-channel.electron.test.ts`、`npm run build:bundle`：通过。
- 新增测试：应用开关与工具可用性、断开、空发送者可启用、知识库依赖文档、企业微信列表/新建、飞书新建/上传（multipart 字段）、应用中心平台行、两个面板的筛选与新建、工具结果卡片。
- **未用真实账号验证**：企业微信 `doc search` 的 visitor / creator 过滤和 `disk files list`、`doc create`、`disk files upload` 的返回结构按官方 Skill 和 CLI schema 实现；飞书上传、新建知识库页面未连真实应用试过。
