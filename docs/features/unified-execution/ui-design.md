# 界面设计

状态：源码已落地，真实 Electron 定向验收通过；其余界面矩阵见[进度](./progress.md)。对应 FR-1、FR-2、FR-7、FR-8、FR-10，验收 US-01、US-02、US-07、US-14、US-17。

遵循根目录 [UI-DESIGN.md](../../../UI-DESIGN.md) 的布局、令牌、共享控件、主题和无障碍规则，不另建视觉体系。

## 删除清单

| 界面 | 当前来源 | 调整 |
| --- | --- | --- |
| 会话输入区 | [Composer](../../../src/renderer/src/Composer.tsx)、[App](../../../src/renderer/src/App.tsx) | 删除模式选择器、图标、菜单状态、选项和事件；剩余控件自然排列 |
| 本地及 SSH 项目表单 | [ProjectSwitcher](../../../src/renderer/src/ProjectSwitcher.tsx)；原 `ProjectWorkModeFields` 已删除 | 删除模式字段、分段控件、草稿默认值和说明；保留 Runtime 与执行空间 |
| 通道项目设置 | [ChannelProjectSettingsFields](../../../src/renderer/src/ChannelProjectSettingsFields.tsx)、[ChannelSettingsSection](../../../src/renderer/src/ChannelSettingsSection.tsx) | 删除默认模式、前缀覆盖帮助及模式相关说明 |
| 会话任务与任务详情 | [ConversationTaskStrip](../../../src/renderer/src/ConversationTaskStrip.tsx)、[RightAssistantSidebar](../../../src/renderer/src/RightAssistantSidebar.tsx)、[ConversationHistorySlot](../../../src/renderer/src/ConversationHistorySlot.tsx) | 删除模式字段与继承/不可用兜底，保留状态、日程、运行时间和 Runtime |
| 子代理消息与活动 | [ChatTimeline](../../../src/renderer/src/ChatTimeline.tsx)、[agent-event-handler](../../../src/renderer/src/agent-event-handler.ts) | 不再展示或生成 Ask / Execute 标签；保留专家、路由原因与运行状态 |
| 图片能力提示 | [ImageCapabilityNotice](../../../src/renderer/src/ImageCapabilityNotice.tsx) | 删除“切换 Execute”；保留模型未配置、未允许调用、输入不支持等真实原因 |
| MCP 设置 | [McpSettingsSection](../../../src/renderer/src/McpSettingsSection.tsx) | 删除 Execute-only 和模式适用范围；只读/写入描述继续作为工具说明 |
| 原生工具清单 | [RuntimeCustomizationSection](../../../src/renderer/src/RuntimeCustomizationSection.tsx) | 删除 Ask/Execute 可用性列，保留工具名、来源、描述和真实可用状态 |
| 自定义任务 | [CustomTaskDialog](../../../src/renderer/src/CustomTaskDialog.tsx) | 当前已无独立模式选择器；仅需清理“采用会话模式”帮助及关联数据 |
| 安全设置与一般工具审批 | 设置中心及工具审批界面 | 删除“安全”分类、`toolApproval` 自动授权/禁止工具选项、说明及一般工具审批等待界面；保留原生结构化提问 |

辅助清理包括 `composer-menu-store` 的 `mode` 项、`use-composer-actions` 的 `setWorkMode`、会话投影与持久化字段，以及 `.composer-picker--mode/--ask/--execute` 和 `.project-work-mode` 样式。移除整个专用组件前检查其全部引用。

## 清除本地数据

按 L-5、US-17，“清除本地数据”位于“通用 > 平台功能”，复用现有卡片、危险操作按钮和二次确认。保留原有清除范围、进行中状态、错误反馈和确认内容；取消确认不清除数据。删除安全分类后，设置导航不得保留空入口或失效焦点。已通过生产 App、preload、IPC 与 SQLite 的种子数据清除、取消及重载定向验证；中英文、键盘和主题完整矩阵仍须按证据记录。

## 信息与文案

不保留永久“Execute”徽标，不以“完整权限”“只读聊天”等新选项替代旧选择器。执行空间、所选模型与 Runtime 继续可见。

推荐基础文案：

| 场景 | 中文 | English |
| --- | --- | --- |
| 初次欢迎 | 可以直接提问或交给我任务。可用工具由所选 Runtime 和设置决定。 | Ask a question or give me a task. Available tools depend on the selected Runtime and settings. |
| MCP 说明 | 启用并分配后，该服务提供的工具可供对应 Runtime 使用。 | Once enabled and assigned, this server's tools are available to the selected Runtime. |
| 旧 Agent | 当前 Agent 版本不兼容，请更新后重试。 | This Agent version is incompatible. Update it and try again. |

工具结果中保留真实错误，不将权限不足、文件冲突或模型不支持一律改成配置提示。更换文案时同步检查 `app`、`workspace`、`settings`、`integrations` 两种语言以及 Main 中的能力目录说明。

历史用户消息中出现 Ask / Execute 不隐藏；历史应用徽标按迁移和渲染规则清除。旧发布说明保留版本语境。

## 键盘与布局

- 删除模式菜单的焦点目标、快捷引用、ARIA 文本和菜单互斥项，不留空按钮。
- Runtime、模型、知识库等剩余菜单继续支持键盘移动、Escape 和关闭后焦点恢复。
- 输入区在宽窄窗口和浅深主题下自然回收空间；不增加占位元素维持旧按钮宽度。
- 项目和通道表单按既有栅格布局收拢，提交按钮和错误提示位置保持合理。
- 设置开关继续使用共享 Switch，删除字段不改变启用或分配的保存行为。

当前未发现专用 Ask/Execute 键盘快捷键；实施仍应检查引用与原生客户端入口，不能据此略过键盘验收。

## 设计系统同步

根 UI 规范已同步任务元数据、菜单互斥、输入区、侧栏任务、任务中心、原生工具清单和清除数据入口。定向 Electron 结果只覆盖已记录场景，完整界面矩阵仍按进度验收。
