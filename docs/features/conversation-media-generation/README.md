# 会话媒体生成

实现状态：已完成。纳入 Desktop 0.13.5 / Agent 0.13.0 候选，尚未发布。日期：2026-09-15。实际验证范围单独见[进度记录](./progress.md)。

用户添加图片模型后，可以开启“允许 AI 在会话中调用”。支持工具调用的聊天模型通过 GoodBuddy 生成图片、编辑上传图片和历史成果。切换聊天模型或 Agent Runtime 后仍可发起生成和编辑；已提交操作固定生成模型，结果保存到原会话。

本目录负责普通 LLM 调用媒体模型的产品行为、调用入口和生命周期。现有直连图片协议及连续修改仍由[图片生成](../image-generation/README.md)维护；本设计不表示现有功能已改变。

## 范围

图片生成与编辑覆盖直连文本 Model Runtime、本地 OpenCode、Continue、DeepSeek Harness，以及 GoodBuddy Agent 远程路径上的适用 Runtime。复用已有图片协议和各 Runtime 的内部工具或 MCP 注入，由 GoodBuddy 自动管理；用户无需创建 Skill、搭建 MCP server 或重复配置凭据。

使用稳定工具 `generate_image` 完成生成与编辑。全局默认和本次指定模型足够，不新增会话级选择器或独立生成表单。无工具能力的聊天模型明确提示限制，可使用已有直连图片工作流。视频不在本设计范围；完整需求以[产品需求](./prd.md)为准。

图片能力在现有内置 MCP 列表持续可见，Runtime 分配以只读复选框展示，由图片模型的会话调用设置自动管理；没有开启的模型时全部取消勾选，仍保留该行和模型设置入口。分配规则见[行为规则](./logic-design.md)，展示与说明见[界面设计](./ui-design.md)。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [产品需求](./prd.md) | 范围、需求编号与产品验收 |
| [用户场景](./user-stories.md) | 用户操作及场景验收 |
| [行为规则](./logic-design.md) | 选择优先级、切换规则、状态和失败处理 |
| [界面设计](./ui-design.md) | 配置入口、会话操作、结果卡片和反馈 |
| [技术设计](./technical-design.md) | 工具注入、Main 服务、存储与 Runtime 接入 |
| [进度记录](./progress.md) | 当前代码事实、剩余工作与验证证据 |

## 术语与依赖

聊天模型负责理解请求、调用工具和组织回答；生成模型负责图片生成与编辑；Agent Runtime 承载聊天模型及工具执行。工具提供结构化调用入口，使用说明随工具提供，不要求用户管理 Skill。

“生成操作”指一次图片生成或编辑及其结果记录，不自动创建任务中心的 Task，也不引入新的通用 Job 调度系统。领域边界遵循 [Task 与 Job 模型](../task-and-job/task-and-job-model.md)。

- [模型连接](../model-connections/README.md)：连接、凭据、协议及请求定制。
- [直连文本 Agent](../direct-model-agent/README.md)：文本工具循环与上下文。
- [远程主机](../remote-host/README.md)：远程 Runtime 与桌面通信。
- [统一界面规则](../../../UI-DESIGN.md)：控件、反馈和可访问性。
