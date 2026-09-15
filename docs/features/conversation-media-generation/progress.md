# 进度记录

## 2026-09-15

### 真实图片请求与构建修复

已使用现有 `gpt-image2` 连接（模型 `sub-gpt-image-2`）经生产 `ImageGenerationService` 发起两次真实图片请求：生成白底蓝色圆形，再上传该成果将圆形改成红色。两次均 HTTP 200，保存并重新解码成功，导出图片目视检查符合要求。请求数为 2，自动重试为 0，用户保存的配置未修改。请求尺寸为 1024×1024，供应商实际返回两张 1254×1254 PNG；未对结果重采样。证据保存在本机临时目录 `image-bounded-oiOPRi/`。此项验证 Main 图片服务与真实供应商，尚不替代真实聊天模型经各 Runtime 自行调用工具及完整界面切换验收。

用户报告 Renderer 生产构建失败，定位到 `remote-image-tool-contracts.ts` 的 `node:crypto` 被共享契约间接引入浏览器。已将 MCP 名称哈希移至仅 Main 与 Agent 引用的 `remote-image-tool-node.ts`，共享消息编解码使用标准 `TextEncoder`/`TextDecoder`，无新增依赖或 polyfill。修复后 `npm run build`（含类型检查、Main、Preload、Renderer 构建）、`npm run lint` 通过，4 个相关测试文件共 89 项通过。此前仅运行类型检查和测试未发现这一构建问题，不能作为生产构建通过证据。

### 实施与集成复验

工作区已有模型会话调用开关、默认图片模型、配置派生的四种 Runtime 只读分配、Main 图片服务、上传与历史成果引用、操作状态及取消/重新生成 IPC。本地 Model、OpenCode、Continue、DeepSeek Harness 和受管远程 OpenCode 均已接入同一服务。操作复用消息 metadata 和成果存储，未新增任务表或独立分配设置。

本轮修复远程保留会话在图片目录清空后未刷新 MCP，以及 Continue 准备自定义 MCP 失败时未释放本次图片工具令牌的问题。图片卡片更新保持原顺序；取消提示区分请求取消、停止等待和取消未生效后的结果保存。失败卡片提供模型设置与素材重选入口，无工具能力及 Ask 有相应提示。长名称和提示词自动换行，窄窗口及 200% 缩放下恢复按钮可换行。

验证证据如下；此前小节中的超时和未验证记录仅代表各次检查时点：

| 验证 | 结果与边界 |
| --- | --- |
| `npm test` | 364 个文件通过、9 个跳过；4,267 项通过、67 项跳过。后续恢复入口及样式修改另有 269 项定向测试通过，未再运行全量测试 |
| `npm run typecheck`、`npm run lint` | 最后一次 Renderer 修改后通过 |
| 真实 Linux Host | 最终 Agent 构建通过固定主机身份连接，使用实际远程 OpenCode；Ask、Execute 各 1 次真实文本请求均 HTTP 200 并完成，真实图片请求 0 次 |
| Host 图片工具往返 | 最终运行含 7 次受控图片请求、15 次受控文本请求；生成、上传和历史图编辑、目录刷新、Ask 隐藏、并发会话归属、停止回复和断连后 Main 继续保存均通过。图片服务返回固定内联 PNG，不构成真实生图证明 |
| Electron 界面 | 当前生产组件、样式、字体及双语文案，使用隔离 fixture API；初轮 94 项检查，恢复入口完成后 40 项检查通过。覆盖明暗主题、四种窗口尺寸、键盘导航及 200% 缩放；没有修改用户配置 |

最终 Host 运行退出码为 0，残留自有进程为 0，隔离目录和上传文件已清理。此前受控复验另有 7 次图片请求和 15 次文本请求，因此本轮合计真实文本请求 2 次、真实图片请求 0 次、受控图片请求 14 次、受控文本请求 30 次。此前历史测试记录不计入此合计。

本机临时证据位于 `C:/Users/jiang/AppData/Local/Temp/opencode/`：`image-review-full-tests-20260915.stdout.log`、`image-host-final-real-20260915.stdout.log`、`image-host-review-20260915.stdout.log` 及 `image-visual-0915/`。这些是开发检查产物，不随产品发布。

当时尚未完成真实图片供应商生成与编辑；后续验证见上方记录。完整 Electron Main/Preload 路径中的自然语言触发及本地/远程双向切换验收仍待完成，FR-3、FR-9 尚未完成全部产品验收。

隔离的真实图片验证脚本离线校验通过后，已按用户要求执行上述两次真实请求。该连接的会话调用仅在验证内存中启用，不修改保存配置。此前 `deai-writing` 文档扫描阻断项为 0，25 个候选经语境复核保留产品边界、状态限制和历史证据；`git diff --check` 通过。

### Renderer 与设置复查

本轮在已有未提交实现上修复图片操作卡片：状态事件原位更新，保留同一消息中多次生成的卡片顺序；取消提示区分正在请求取消、已停止等待和取消未生效但图片已保存。按钮通过 `aria-describedby` 关联就地操作错误，中英文提示同步更新。补充组件回归，并在现有 App 测试中检查离开原会话、结果晚到、返回及切换 Runtime 后继续修改时的卡片顺序。

已检查模型设置、RuntimeSettingsStore、CapabilityService 和共享设置契约。现有实现从已保存模型开关派生四种 Runtime 的只读分配，不持久化独立分配；关闭或删除默认图片模型后保留失效默认。相关测试本轮通过，未改动这些生产契约。共享工具目录测试原先仅排除浏览器工具，现补充图片受管能力例外，确认 `generate_image` 保持写操作且不重复进入直连模型设置分组。

验证记录：

- `npx vitest run src/renderer/src/ImageOperationStatus.test.tsx src/renderer/src/App.test.tsx src/renderer/src/SettingsPanel.test.tsx src/main/runtime-settings-store.test.ts src/main/capabilities/capability-service.test.ts`：5 个文件、451 项通过。
- 修正目录测试后，`npx vitest run src/shared/builtin-model-tools.test.ts src/renderer/src/ImageOperationStatus.test.tsx`：2 个文件、5 项通过。
- `npm run typecheck`、`npm run lint` 通过。
- `npm test` 在 120 秒上限被终止；期间报告的共享工具目录测试失败已单独修正并复验，未取得全量测试通过结论。
- 未调用真实文本或图片服务，请求数均为 0；未执行 Electron 视觉验收或真实 Host 验证。本轮没有修改 `src/main/agent` 或 `src/agent-daemon`。各 Runtime 的真实生成、编辑、取消及切换验收仍待完成。

### 此前文档修订记录

本日补充：已按最新明确接受的要求修订 FR-1、FR-9、L-1、界面与技术设计，并新增 US-16 至 US-19。只读分配及模型配置派生规则见[行为规则](./logic-design.md)，受管行、说明与无障碍要求见[界面设计](./ui-design.md)。已读取根目录与 features 的 AGENTS、根 UI-DESIGN.md 及本目录七份现有文档，保留此前未提交修订；本次未修改目录外文件或应用代码，相关行为仍待实现与产品验收。

本日更正：此前将其他 Runtime 自动调用排除在交付范围之外的记录不符合用户要求，现由本条替代。七份文档已统一为图片生成和编辑，支持范围及验收以[产品需求](./prd.md)和[用户场景](./user-stories.md)为准，不再保留分期规则。视频移出范围，US-10 保留编号并明确标注；其他被替代要求已记录编号变更。

本次只修改本目录设计文档，未检查或改变应用实现。2026-09-14 记录仅为当日历史证据，不表示已重新验证。图片工具、Main 请求生命周期、各本地及 GoodBuddy Agent 远程适用 Runtime 的生成、编辑和切换均仍需实施与实际验证；具体注入及桥接核验属于实施工作，不缩减支持范围。

本次文档验证：7 份文档的 38 个相对 Markdown 链接均可解析；一致性审阅覆盖模型配置唯一来源、只读分配、空目录保留行、运行状态独立及完整 Runtime 范围，未发现分期或缩减支持范围的现行规则。`deai-writing` 扫描阻断项为 0，25 个复核候选涉及设计状态、职责与必要行为限制，逐条按语境保留，并通读检查结构及前后规则。`git diff --check -- docs/features/conversation-media-generation` 通过；本次七份文件均已被 Git 跟踪，检查覆盖其工作区差异。该命令不覆盖未跟踪文件，不能沿用此前“目录未跟踪”的结论。未运行应用测试或真实生成请求，未声称功能完成或重新验证此前代码。

## 2026-09-14（历史记录）

以下保留当日检查与原设计记录，其中视频、保存重试等旧范围已被 2026-09-15 更正取代，不作为当前实施要求。

当前阶段：设计草案已落盘，功能未实现。本次只新增设计文档与相关入口链接。

代码与文档检查确认以下基础能力：

| 事实 | 证据 |
| --- | --- |
| 已有直连图片生成、编辑及历史成果引用 | [图片技术设计](../image-generation/technical-design.md)、`src/main/agent/model-runtime.ts` |
| 模型连接及 Main 凭据存储已存在 | `src/shared/contracts.ts`、`src/main/runtime-settings-store.ts` |
| 已有 Skill 发现、Runtime 分配及工具分发 | `src/main/capabilities/capability-service.ts`、`src/main/agent/model-tool-provider.ts` |
| 会话、消息 metadata 和成果已有 SQLite 存储 | `src/main/assistant/assistant-database.ts`、`src/shared/assistant-contracts.ts` |
| 生图尚未成为普通 LLM 的内置生成工具 | 检查 `src/shared/builtin-model-tools.ts` 及工具分发路径 |
| 本次检查未发现第一方视频生成协议实现 | 检查模型能力契约、Runtime 及现有功能文档；不据此推断外部 MCP 的能力 |

剩余工作对应[技术设计实施顺序](./technical-design.md)：模型调用设置与选择、图片服务及会话入口、各 Runtime 接入、视频真实服务与成果交付均待实施。视频协议选择和远程工具桥接验证待完成。

本次未修改应用代码，未运行应用测试或真实生成请求。文档验证记录如下：

- 相对 Markdown 链接检查：7 份新文档及图片功能入口共 33 个链接，失效链接为 0。
- `deai-writing` 扫描：阻断项为 0；人工复核保留设计状态、能力边界和禁止行为等必要限定，以及真实并列的验收项。
- 独立一致性审阅发现“重新生成”与“重试保存”的操作身份表述不一致，已在 L-4 和 US-09 中统一：前者创建新操作，后者更新原操作。
- `git diff --check` 通过。上述检查只验证文档，不构成功能验收。
