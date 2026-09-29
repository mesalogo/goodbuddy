# 执行方式与模型选择设计

本文件是执行方式（Runtime）与模型选择的唯一权威说明，覆盖分层解析、各入口的界面
行为、存储迁移，以及尚未实现的“用途模型”规划。连接本身的请求定制见
[技术设计](./technical-design.md)，DeepSeek Harness 的平台来源解析见
[Harness 技术设计](../deepseek-harness/technical-design.md#121-配置来源)。

## 1. 术语

| 术语 | 定义 |
| --- | --- |
| 执行方式 | `provider`：`model`（直连模型）、`opencode`、`continue`、`deepseek-harness` |
| 模型选择 | `{ kind: 'profile', profileId }` 或 `{ kind: 'runtime-config' }`（Runtime 自有配置） |
| 选择层 | `RuntimeSelectionLayer = { provider?, model? }`，两个字段都可缺省 |
| 全局默认模型 | 每个执行方式在“系统设置”中的默认模型：直连用 `defaultModelProfileId`，其余用 `opencodeModelSource` / `continueModelSource` / `deepseekHarnessModelSource` |
| 具体选择 | 解析结果 `AgentRuntimeSelection`，包含确定的 `provider`，以及 `profileId` 或 `runtimeConfig: true` 之一 |

## 2. 分层与优先级（已实现）

选择按“会话 → 项目 → 全局”逐字段解析，入口为共享函数 `resolveRuntimeChoice`
（`src/shared/runtime-selection-contracts.ts`）：

1. **执行方式**：会话层 `provider` → 项目层 `provider` → 全局兜底（见第 6 节）。
2. **模型**：只继承与最终执行方式一致的层。会话单独切换执行方式时，丢弃会话层模型，
   沿用项目层（若项目执行方式相同）或该执行方式的全局默认模型。
3. 结果附带 `providerSource` / `modelSource`（`global`、`project`、`conversation`），
   界面据此显示来源标记。

失效处理：

| 所选模型状态 | 行为 |
| --- | --- |
| 可用 | 使用 |
| `unavailable`（缺少 API Key） | 保留选择；运行时明确报告缺少凭据，不静默换模型 |
| `missing`（连接已删除） | 回退到下一层，并在选择器中提示回退原因 |
| `incompatible`（协议或能力不匹配） | 同上 |

- 图像生成连接只对直连模型有效，且永远不作为回退默认值。
- 远程项目只允许 OpenCode 与 Continue；其他执行方式按 `provider` 原因回退。
- 全局 `defaultModelProfileId` 为空时解析为 `{ provider: 'model' }`，不生成空 `profileId`。
- 不存在 `auto`。旧 `{ provider: 'auto' }` 在读取和 IPC 入口处去除，按上述顺序解析。

## 3. 各入口行为（已实现）

### 3.1 项目设置

本地、远程和通道项目共用 `ProjectRuntimeSelector`：

- “执行方式”必选，没有“继承”选项；保存时总是写入具体 `provider`
  （`ProjectSwitcher` 的 `withProjectProvider`、`ChannelProjectSettingsFields` 的
  `channelProjectDraft`）。
- “模型”默认项为“跟随 xx 默认（…）”，其余为该执行方式可用的连接及“使用 xx 自有配置”。
- 新建会话跟随项目，不再提供“默认执行方式”四选一。

### 3.2 输入框选择器

`RuntimeModelPicker` 为两栏菜单：左栏执行方式，右栏当前高亮执行方式的模型。

- 选择只写入会话层；左栏选择与项目相同的执行方式时写入 `undefined`，保持继承。
- 右栏首项为“默认（…）”，带来源标记（全局 / 项目）；已删除或不兼容的连接禁用，缺少
  API Key 的连接可选并标注。
- 会话存在单独选择时，底栏显示“本会话单独选择”和“恢复为项目默认”；输入区按钮不在图标与 Runtime 名称之间添加圆点。
- 模型列按最长列表预留高度，悬停切换执行方式时菜单不跳动；列内超出部分滚动，底栏
  固定在两栏下方。长名称单行截断，完整名称和模型 ID 通过 `title` 与可访问名称提供。
- “管理模型连接…”打开“设置 → 模型连接”。
- 键盘：左右键在两栏间切换，上下 / Home / End 在栏内移动，Esc 关闭并还焦点。

### 3.3 系统设置

“设置 → Agent Runtime”按 OpenCode / Continue / DeepSeek Harness 页签分别选择各自的
全局默认模型；直连模型的默认值在“模型连接”中设置。设置页没有“全局执行方式”控件。

## 4. 执行时解析（已实现）

- Main 的 `resolveStoredRuntimeSelection` / `resolveLayeredRuntimeSelection` 在每次请求时
  读取会话层与项目层重新解析，不把解析结果回写到会话记录。
- 排队的输入在真正派发时重新解析，不使用入队时的快照。
- 定时任务的选择在创建时冻结在任务上；运行时优先任务选择，再到项目层。
- 远程事件的 context metrics 按本次请求实际使用的具体选择记录
  （`remoteEventSelection`）；未传入时数据库按会话层、项目层解析，缺省执行方式为
  OpenCode。

## 5. 存储与迁移（已实现）

- `projects.runtime_selection_json` 与 `conversations.runtime_selection_json` 保存紧凑
  的选择层；空层保存为 `NULL`。
- 数据库版本 49（`migrateRuntimeSelectionLayers`）把旧的 `{ provider, profileId }` 和
  `{ provider: 'auto' }` 改写为选择层；读取时 schema 预处理也会升级旧形状。
- `repairConversationRuntimeSelections` 在连接被删除后清除所有项目与会话中的失效
  `profileId`。
- 通道项目创建为 `{ provider: 'model' }`；SSH 项目允许不保存选择。

## 6. 全局 `provider`（历史遗留，待移除）

`RuntimeSettings.provider` 来自项目层出现之前的“全局执行方式”。它已没有设置界面，
但仍在以下位置被读取：

| 位置 | 用途 |
| --- | --- |
| `resolveRuntimeChoice` 的 `normalizedGlobalProvider` | 项目和会话都没有 `provider` 时的兜底（旧数据、无项目的状态查询） |
| `getConfiguredRuntimeTarget` → `createConfiguredRuntime`（`src/main/index.ts`） | 启动和设置变更时创建默认 Runtime；监督者回顾、无唯一项目的心跳等不带项目的请求使用它 |
| `runtime-settings-store.ts` | 归一化、`auto` → `model` 迁移和写回 |
| `SettingsPanel` | 无界面地读入并原样保存 |

结论：该字段不应继续作为用户概念存在。移除方案与第 7 节一起实施：

1. 启动修复为所有 `provider` 为空的项目写入当时解析出的具体执行方式。
2. 兜底固定为 `model`；默认 Runtime 固定为直连模型。
3. 设置输入和公开设置不再包含 `provider`；存储保留该字段只用于读取旧文件，不再写入。

## 7. 用途模型（规划，未实现）

### 7.1 问题

后台功能各自隐式决定模型，用户无法控制，也无法从界面得知：

| 用途 | 当前行为 | 是否需要工具 |
| --- | --- | --- |
| 监督者回顾与整理 | 全局 `provider` 对应的默认 Runtime 与模型 | 否，工具调用被拒绝 |
| 心跳报告 | 单一项目时跟随项目，否则同上 | 否 |
| Magic Notes 分析 | 直连默认模型连接 | 否 |
| 知识图谱抽取 | 直连默认模型连接（HTTP） | 否 |
| 上下文压缩 | 已有 `contextCompression.modelSource`（当前模型 / 指定连接） | 否 |
| 子代理 | 直连模型，可按专家覆盖 | 是，保持现状 |
| 定时任务 | 任务或项目选择 | 是，保持现状 |

### 7.2 决策

- 用途只选择**模型连接**，统一走直连模型，不提供执行方式选择。上述用途都是无工具的
  文本请求，为其启动 OpenCode / Continue / DeepSeek Harness 只增加延迟、成本和故障面。
- 每个用途的取值为“跟随默认模型”或一个文本模型连接；图像连接不可选。
- 需要工具的子代理和定时任务不纳入本设置。

### 7.3 范围

“设置 → 模型连接”新增“用途模型”小节，包含：

- 监督者回顾与整理
- 心跳报告（无唯一项目时）
- Magic Notes 分析
- 知识图谱抽取
- 上下文压缩（迁入现有 `contextCompression.modelSource`，语义不变）

### 7.4 解析与失效

- 解析：用途设置的连接 → 全局 `defaultModelProfileId`。
- 连接被删除：设置修复为“跟随默认模型”，与第 5 节的失效清理一致。
- 连接缺少 API Key：保留选择，运行时明确失败，不静默改用默认模型。
- 心跳在有唯一项目时仍跟随项目选择；用途设置只替代原先的全局兜底。

### 7.5 待定

- 设置字段形状（建议 `purposeModels: Record<Purpose, { kind: 'default' } | { kind: 'profile', profileId }>`）
  与设置文件版本号。
- `contextCompression.modelSource` 的 `current`（跟随当前会话模型）是否保留为压缩用途
  专有的第三个选项。
- 监督者模型并发（`supervisorModelConcurrency`）是否与所选连接绑定显示。
