# 知识库

知识库已提供本地资料导入、解析、分块、索引、检索、图谱和带来源的知识问答。
将 Dify、FastGPT 和 RAGFlow 中已有知识库接入同一检索范围已完成 Main 进程适配器和
真实接口验证，但实例管理、绑定、统一检索和界面尚未接通，因此仍不属于当前已提供能力。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [知识库检索与分块增强 PRD](./prd.md) | 检索、分块、诊断和产品验收 |
| [User Stories](./user-stories.md) | 知识使用者、维护者和调试者场景 |
| [UI 设计](./ui-design.md) | 当前本地知识库的信息架构、首次使用、状态与高级功能分层 |
| [实施进度](./progress.md) | 已验证实现事实、验证命令与剩余外部知识库工作 |
| [本地文本向量技术设计](./local-embedding-technical-design.md) | 本地与兼容向量连接、模型包、索引和进程边界 |
| [知识检索评估](./retrieval-evaluation.md) | 检索质量评估方法、数据集、指标和门槛 |
| [外部知识库接入 PRD](./external-knowledge-prd.md) | 外部实例、知识库绑定、检索范围和产品验收 |
| [外部知识库 User Stories](./external-knowledge-user-stories.md) | 实例配置、添加、使用和故障恢复场景 |
| [外部知识库逻辑设计](./external-knowledge-logic-design.md) | 状态、不变量、配置优先级和失败规则 |
| [外部知识库 UI 设计](./external-knowledge-ui-design.md) | 知识库页面、外部实例管理和创建向导交互 |
| [外部知识库技术设计](./external-knowledge-technical-design.md) | Provider Adapter、凭据、持久化、IPC 和检索标准化 |
| [外部知识库实测基线](./external-knowledge-probe-baseline.json) | 脱敏记录真实实例的接口状态、字段结构、特色能力和耗时 |
| [2026-09-10 基础复测](./external-knowledge-probe-2026-09-10-strict.json) | 开启证书校验的目录、详情和基础检索结果 |
| [2026-09-10 扩展复测](./external-knowledge-probe-2026-09-10-extended.json) | 配置覆盖、重排、图谱与知识编译开关的请求结果及结构 |

## 术语

- **外部实例**：一个由用户配置的 Dify、FastGPT 或 RAGFlow 服务地址及其认证信息。
- **外部知识库绑定**：GoodBuddy 中的知识库记录与外部实例内一个远端知识库 ID 的只读关联。
- **Provider 配置**：某一 Provider 检索接口独有的设置，例如 RAGFlow 图谱检索。

外部知识库只提供检索结果。GoodBuddy 不接入外部 App、Chat、Assistant、Workflow
或 Agent，也不在外部实例中创建、修改、上传或删除知识库内容。远端资料不会批量同步
或进入本地索引；实际用于回答的有界片段会随引用保存在本地会话中。

本目录尚未拆出统一逻辑设计；当前本地知识库状态规则由 PRD、User Stories 和实现契约
共同约束。外部知识库继续使用独立逻辑设计，直至进入实施阶段。
