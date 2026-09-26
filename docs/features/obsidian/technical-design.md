# 技术设计

本文负责实现架构及 UI 设计，落实 [FR-1～FR-10](./prd.md) 和 [LR-1～LR-8](./logic-design.md)。实现与验证状态统一在[进度](./progress.md)记录。

## 模块边界

| 层 | 职责与源码 |
| --- | --- |
| Renderer | [McpSettingsSection.tsx](../../../src/renderer/src/McpSettingsSection.tsx) 编辑草稿、显示已保存范围和测试结果；不直接访问文件系统或启动 Node |
| Shared / Preload | [capability-contracts.ts](../../../src/shared/capability-contracts.ts)、[contracts.ts](../../../src/shared/contracts.ts)、[ipc-channels.ts](../../../src/shared/ipc-channels.ts) 和 [preload/index.ts](../../../src/preload/index.ts) 定义窄接口 |
| 配置服务 | [capability-service.ts](../../../src/main/capabilities/capability-service.ts) 保存范围，沿用内置 MCP 的启用和分配状态 |
| Main 服务 | [obsidian-service.ts](../../../src/main/obsidian/obsidian-service.ts) 发现仓库、连接上游、列工具和调用工具 |
| 会话网关 | [knowledge-mcp-gateway.ts](../../../src/main/agent/knowledge-mcp-gateway.ts) 提供 HTTP MCP、仓库发现、目标路由、请求授权撤销及活动调用清理 |
| 共享目录与直连 | [obsidian-tools.ts](../../../src/shared/obsidian-tools.ts) 定义 19 个工具；[model-tool-provider.ts](../../../src/main/agent/model-tool-provider.ts) 发现并调用同一目录，保留上游错误详情 |
| 构建 | [package-mcpvault.ts](../../../src/main/obsidian/package-mcpvault.ts) 复制依赖树，[electron.vite.config.ts](../../../electron.vite.config.ts) 调用打包函数，[package.json](../../../package.json) 配置版本及解包资源 |

正式链路为设置页面经 Preload、受信任的 Main IPC 处理器到配置服务或 ObsidianService；会话经既有能力入口到 ObsidianService，再通过 stdio 到 MCPVault。[index.ts](../../../src/main/index.ts) 创建服务并注入工具启动环境、网关及 IPC；[ipc.ts](../../../src/main/ipc.ts) 已注册设置、测试和目录选择处理器，并在会话入口按保存设置及工作模式签发请求授权。

## 配置与 IPC

`obsidianSettingsSchema` 是严格对象，仅有 `vaultPath`：字符串，去除首尾空白，最大 4096 字符，默认 `''`。不接收 `readOnly`。持久化范围为桌面全局，沿用 CapabilityService 的存储，不增加数据库或配置副本。

| 接口 | 输入与结果 | 副作用 |
| --- | --- | --- |
| `updateObsidianSettings` | `{ vaultPath }` → `CapabilitySnapshot` | 先撤销旧 Obsidian 请求授权，再保存范围；启用与分配值不变 |
| `testObsidianConnection` | 草稿 `{ vaultPath }` → `{ vaults, toolCount }` | 临时连接，结束即清理，不保存设置 |
| `selectObsidianVault` | 无输入 → 目录字符串或 `null` | Main 打开系统目录选择器，取消返回 `null` |

`vaults` 的元素为 `{ id, name, path }`。Main 处理器验证调用来源和共享 schema。范围保存只验证设置形状；目录存在性由发现或测试校验，保存成功不能显示为连接成功。已有配置缺少新字段时补默认值，其他能力设置保持原值。

设置更新、内置 MCP 开关及分配处理器在参数校验后调用 `knowledgeGateway.revokeObsidianCapabilities()`；后两者只在 `serverId === 'obsidian'` 时调用。撤销发生在持久化前，之后通过既有 `refreshCapabilities` 刷新配置；失败语义由 [LR-8](./logic-design.md#授权撤销与清理)定义。

## 仓库发现与路由

注册文件位置如下，优先使用相应环境变量：

| 系统 | 注册文件 |
| --- | --- |
| Windows | `%APPDATA%/obsidian/obsidian.json`，缺少变量时使用用户目录下 `AppData/Roaming` |
| macOS | `~/Library/Application Support/obsidian/obsidian.json` |
| Linux | `$XDG_CONFIG_HOME/obsidian/obsidian.json`，缺少变量时使用 `~/.config` |

注册条目的键直接用作 ID。指定文件夹经绝对路径规范化后生成 SHA-256 ID，Windows 对哈希输入转小写；这是路径身份，不是文件完整性校验或跨机器永久身份。目录移动或注册 ID 变化后，调用方须重新发现仓库。

`callTool` 接收 `{ vaultId?, name, arguments }`，按 LR-3 验证目标后转发。共享工具 `obsidian_list_vaults` 返回仓库列表，其余工具名称为 `obsidian_` 加上游名称，输入额外包含 `vaultId`。网关校验共享 schema，提取 `vaultId`，移除名称前缀后调用上游；其余参数原样保留。输入默认值保持可选，frontmatter 键不受外层严格对象限制。[共享契约测试](../../../src/shared/obsidian-tools.test.ts)逐项比对上游字段、必填项、默认值及约束。

## 上游工具契约

名称集合依据本地安装的 `@bitbonsai/mcpvault@0.16.0` 中 `dist/src/createServer.js` 核对。HTTP 网关和直连工具提供器共享 19 个工具：`obsidian_list_vaults` 加下表 18 个工具的带前缀映射。设置连接测试返回的 `toolCount` 为上游名称去重数，正常为 18，不包含仓库发现工具。

| 上游工具 | 能力 |
| --- | --- |
| `read_note` | 读取笔记 |
| `write_note` | 写入笔记 |
| `patch_note` | 局部替换笔记内容 |
| `list_directory` | 列出目录 |
| `delete_note` | 按上游删除参数处理笔记 |
| `search_notes` | 搜索笔记 |
| `move_note` | 移动或重命名笔记 |
| `move_file` | 移动文件，包括上游支持的附件文件 |
| `read_multiple_notes` | 批量读取笔记 |
| `update_frontmatter` | 更新 frontmatter |
| `get_notes_info` | 获取笔记信息 |
| `get_frontmatter` | 获取 frontmatter |
| `manage_tags` | 管理标签 |
| `get_vault_stats` | 获取仓库统计 |
| `list_all_tags` | 列出标签 |
| `wiki_link` | 处理 wiki 链接 |
| `get_note_outline` | 获取笔记大纲 |
| `read_note_lines` | 按行读取笔记 |

服务分页读取上游工具，不设置功能白名单。读写属性供应用既有工作模式使用，不能据此增加 Obsidian 专用过滤。保留上游的错误结果与参数规则，例如删除参数 `confirmPath`；不把参数要求改造成额外确认弹窗。

## 离线打包与生命周期

构建固定 npm 版本为 `0.16.0`，复制包及递归运行依赖，保留许可证、模块相对资源和 `trash` 的原生辅助程序。资源位于 `out/main/obsidian-mcpvault/node_modules`，生产安装包将其放在 `app.asar.unpacked`。缺包或版本不符必须明确失败，不在运行时执行 `npx` 或回退到在线安装。

服务将 `app.asar` 路径映射到解包目录，检查 `@bitbonsai/mcpvault/dist/server.js` 存在，使用现有 `LaunchEnvironmentProvider` 注入命令环境后运行 `node <server.js> <vault.path>`，工作目录为目标仓库。托管 Node 的准备和用户自定义解释器规则由[工具执行环境技术设计](../local-tool-environment/technical-design.md)负责。Obsidian 不新增下载源；已有工具下载源不控制随包交付的 MCPVault。

每次列举或调用创建 stdio 连接，在 `finally` 中关闭 transport 和 client，初始化失败也清理。`callTool` 传递 `AbortSignal`，启动前已取消时不启动进程。连接测试逐仓库列工具，不调用写入工具；它没有独立取消 IPC。网关沿用现有 MCP 结果大小约束，保留上游原生内容和错误详情，超时沿用 SDK 与既有会话路径。

`callObsidianTool` 合并请求、授权撤销及单次调用的取消信号，并在结果返回前再次检查取消。`revokeObsidianCapabilities` 对含 Obsidian 的授权调用既有 `revoke`，移除令牌并中止其 controller；混合授权整体失效。网关以 `activeObsidianCalls` 跟踪调用 Promise，`dispose()` 先撤销授权，再等待这些 Promise 完成，随后关闭下游会话和 HTTP 服务。由于服务 Promise 包含 `finally` 中的 transport 关闭，等待范围包含真实子进程清理，也包含先前撤销后尚未关闭的调用。

## UI 设计

此章节独立承担功能 UI 设计职责，服从[统一界面设计系统](../../../UI-DESIGN.md)。入口为“能力与工具 → MCP → 内置 MCP”的 Obsidian 卡片，复用 `PageTabs`、卡片、表单、按钮、Switch 及 Runtime 分配 Checkbox。

卡片顺序为名称及状态、启用开关、能力说明、仓库范围、可选路径输入、已保存范围、选择/测试/保存操作、关联反馈、Runtime 分配和可展开工具列表。主按钮为“保存”，测试与选择文件夹为次按钮。范围选项为“所有本机仓库”和“指定文件夹”；指定模式才显示路径输入框。页面明确区分草稿与“已保存范围”。

关闭状态仍允许选择、测试和保存。快照尚未载入或操作忙碌时禁用相关提交，测试按钮显示进度。修改范围或路径清除旧结果；目录选择取消保留原值。连接结果在卡片内显示仓库名称、路径和工具数，作为可复查的诊断内容；字段错误及可立即重试的测试错误就近显示，保留输入。普通保存提示如需增加，使用应用通知，不重复显示同一事件。

启用控件使用 `role="switch"`；范围、路径和按钮具备可访问名称，路径错误使用 `aria-describedby`，错误用 `role="alert"`，测试结果用 `role="status"`。工具展开按钮提供 `aria-expanded` 和 `aria-controls`。沿用原生键盘行为和共享焦点样式。Obsidian 的多字段诊断表单采用纵向布局，操作按钮换行，结果中的长路径允许折行；浅色和深色主题均复用语义令牌。Windows 760 像素宽窗口的实际测量及原生输入结果见[进度](./progress.md)。

## 验证与实施顺序

| 阶段 | 验证内容 | 追溯 |
| --- | --- | --- |
| TS-1 配置与服务 | 缺省字段、持久化独立性、各平台注册路径、ID 路由、真实上游读写、取消清理 | LR-1～LR-3、LR-5～LR-7 |
| TS-2 设置 UI | 草稿测试不保存不启用、切换范围、取消选择、失败保留输入、键盘与窄窗口 | US-1～US-3、US-7、US-8 |
| TS-3 网关与 IPC | 正式 Main 处理器、19 个共享工具、分配、Ask/Execute、配置提交撤销旧授权、在途取消与销毁等待；核对 DeepSeek Harness 和远程执行不可用边界 | LR-3、LR-4、LR-7、LR-8；US-4、US-5、US-9～US-12 |
| TS-4 安装包与端到端 | 在实际支持系统上断网且无系统 Node 测试；Obsidian 关闭；许可证及原生资源完整；从设置到真实会话读写 | FR-5、FR-6；US-6 |

当前分配目标为 `model`、`opencode`、`continue`；[DeepSeek Harness](../../../src/main/agent/deepseek-harness-runtime.ts)和[远程 ACP Runtime](../../../src/main/agent/acp-remote-runtime.ts)的 `supportsScopedDataTools` 为 `false`，沿用既有不可用边界。已通过的生产组件自动化包含设置组件到注册 IPC、HTTP 网关，以及直连工具提供器全部 19 个工具的实际执行。真实聊天会话、Electron 托管 Node、Windows 解包应用及网络限制的不同验证范围见[进度](./progress.md)。
