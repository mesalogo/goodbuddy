# 移除 Ask / Execute 工作模式

状态：主要源码改造已落地，定向 UI 与真实 Host 验证已有证据；全量验证和发布包验收待完成。更新日期：2026-10-04。

本功能从 GoodBuddy 产品中移除 Ask / Execute，包括界面选择、请求字段、原生工具与 MCP 的模式判断、提示词、任务继承，以及历史持久化字段。升级后的正常请求直接使用所选 Runtime 和已启用能力；不保留固定为 Execute 的隐藏字段，也不引入替代工作模式。

当前源码已移除产品模式、“安全”设置分类和 `toolApproval` 策略，数据库 schema 60 与 Runtime 设置 22 清理旧字段。“清除本地数据”位于“通用 > 平台功能”并保留二次确认。Agent 要求 runtime/acp 6，本地 Harness 控制协议为 2；配套工件尚待发布验证。具体证据见[进度与证据](./progress.md)。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [产品需求](./prd.md) | 已确认范围、功能要求、设置粒度和产品验收 |
| [用户故事](./user-stories.md) | 新用户、升级、任务、通道、原生客户端和远程场景验收 |
| [执行规则](./logic-design.md) | 无工作模式时的工具使用、内部文本任务、旧前缀和失败行为 |
| [界面设计](./ui-design.md) | 控件、状态、徽标、文案与无障碍清理清单 |
| [技术设计](./technical-design.md) | 实施顺序、进程边界、协议兼容、文档同步和验证矩阵 |
| [数据迁移](./data-migration.md) | SQL、JSON、Runtime 设置、导入与重放中的历史字段清理及数据保留 |
| [源码调研](./source-audit.md) | 已查明的代码依赖、各 Runtime 差异与现存能力缺口 |
| [进度与证据](./progress.md) | 已完成的调研、未完成实现、验证记录与证据限制 |

## 术语与边界

“工作模式”特指 GoodBuddy 的 Ask / Execute 及历史 Plan 值。“Runtime 原生工具”包括文件、命令、检索、任务及插件提供的工具；“MCP”包括设置管理的内置服务和自定义服务。图片工具虽由图片模型配置管理，也属于本次移除范围。

“无工具内部任务”指摘要、魔法笔记分析、监督者评审等专用文本调用。它们保持无工具配置，不作为可供用户选择的另一种工作模式。

“设置控制”沿用现有启用、分配、模型和执行空间配置。MCP 目前按服务控制；原生工具清单没有通用的逐工具开关。本功能不新增逐工具管理系统。

## 相关功能

- [助手工作栏](../assistant-workbar/README.md)：执行空间、Runtime 交互和原生客户端生命周期。
- [Model Agent](../direct-model-agent/README.md)、[DeepSeek Harness](../deepseek-harness/README.md)：各自工具执行实现。
- [远程主机](../remote-host/README.md)：Agent 协议、部署与真实 Host 验证。
- [Task 与 Job](../task-and-job/README.md)、[消息通道](../wechat-channel/README.md)：后台入口与任务恢复。
- [会话图片](../conversation-media-generation/README.md)、[Obsidian](../obsidian/README.md)：工具业务条件。
- [数据库迁移指南](../../development/database-migrations.md)：已发布数据的升级规则。

本目录定义当前源码行为与验收要求；已发布能力以各版本的实现证据为准，不将旧版验证记录改写为新版已通过的证据。
