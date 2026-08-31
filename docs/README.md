# GoodBuddy 文档导航

GoodBuddy 文档按“文档类型 → 功能域”组织。新增文档应先选择类型，再放入对应功能目录，
避免继续把所有设计平铺到单一 `features` 目录。

## 产品需求

| 功能域 | 入口 |
| --- | --- |
| Task 与 Job | [Task 与 Job 总览](./prd/task-and-job/README.md) |
| Smart Heartbeat | [智能心跳 PRD](./prd/smart-heartbeat/smart-heartbeat-prd.md) |
| 助手工作栏 | [通用助手工作栏与执行空间 PRD](./prd/assistant-experience/assistant-workbar-and-execution-spaces-prd.md) |
| 会话监督 | [会话监督 PRD](./prd/supervision/conversation-supervision-prd.md) |
| 记忆 | [分区记忆 PRD](./prd/memory/partitioned-memory-prd.md) |
| 并行实验 | [并行实验工作台 PRD](./prd/experiments/parallel-experiments-prd.md) |
| 持续学习 | [持续学习与评估门 PRD](./prd/learning/continuous-learning-prd.md) |
| 知识库 | [知识库检索与分块增强 PRD](./prd/knowledge/knowledge-rag-enhancement-prd.md) |
| 文档处理 | [文档解析与本地 OCR](./prd/document-processing/document-extraction-and-local-ocr.md) |
| 消息通道 | [微信 ClawBot 通道 PRD](./prd/channels/wechat-clawbot-channel-project-prd.md) |

## Task 与 Job 文档

- [统一领域模型](./prd/task-and-job/task-and-job-model.md)
- [Task Center](./prd/task-and-job/task-center-prd.md)
- [Scheduled Task](./prd/task-and-job/scheduled-task-prd.md)
- [Goal Task](./prd/task-and-job/goal-task-prd.md)
- [Job 与 Subjob](./prd/task-and-job/job-and-subjob-prd.md)

## 跨功能文档

- [自动化平台架构](./architecture/automation-platform-architecture.md)
- [平台功能页签与模型下载源设计](./architecture/model-download-source-design.md)
- [本地文本向量模型与连接设计](./architecture/local-text-embedding-model-design.md)
- [本机工具环境设计与实施计划](./architecture/local-tool-environment-design.md)
- [全双工实时语音交互设计](./architecture/full-duplex-voice-design.md)
- [DeepSeek Harness Runtime 设计](./architecture/deepseek-harness-runtime-design.md)
- [应用内反馈系统设计与对接](./architecture/in-app-feedback-integration-design.md)
- [SSH 远程主机与 GoodBuddy Agent 稳定终态设计](./architecture/remote-host-and-goodbuddy-agent-design.md)
- [SSH Host 远程环境准备与控制面直连设计](./architecture/remote-host-environment-provisioning-design.md)
- [跨平台助手产品设计](./design/cross-platform-assistant-product-design.md)
- [长期助手路线图](./roadmap/long-term-assistant-roadmap.md)
- [产品、性能与体验综合改进计划](./roadmap/product-performance-experience-improvement-plan.md)
- [电脑控制实施状态](./status/computer-control-implementation-status.md)
- [知识检索评估](./quality/knowledge-retrieval-evaluation.md)
- [GoodBuddy 龙芯（LoongArch）预览版构建与功能列表](./development/loongarch-preview-build.md)
- [统一界面设计系统](../UI-DESIGN.md)

## 目录规则

1. PRD 放在 `docs/prd/<功能域>/`。
2. 跨功能技术总纲放在 `docs/architecture/`。
3. 产品级设计放在 `docs/design/`，路线图和实施状态分别放在 `roadmap`、`status`。
4. 测试方法、评估协议和质量报告放在 `docs/quality/`。
5. 开发环境、实验性构建和移植说明放在 `docs/development/`。
6. 一个概念只能有一份权威定义；其他文档链接到它，不复制另一套术语。
7. Task、Job、Run、Subagent 和 Conversation 的含义以
   [Task 与 Job 统一领域模型](./prd/task-and-job/task-and-job-model.md) 为准。
