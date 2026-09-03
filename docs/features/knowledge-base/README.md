# 知识库

知识库负责资料导入、解析、分块、索引、检索、图谱和带来源的知识问答，也负责将
Dify、FastGPT 和 RAGFlow 中已有的知识库接入同一检索范围。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [知识库检索与分块增强 PRD](./prd.md) | 检索、分块、诊断和产品验收 |
| [User Stories](./user-stories.md) | 知识使用者、维护者和调试者场景 |
| [本地文本向量技术设计](./local-embedding-technical-design.md) | 本地与兼容向量连接、模型包、索引和进程边界 |
| [知识检索评估](./retrieval-evaluation.md) | 检索质量评估方法、数据集、指标和门槛 |
| [外部知识库接入 PRD](./external-knowledge-prd.md) | 外部实例、知识库绑定、检索范围和产品验收 |
| [外部知识库 User Stories](./external-knowledge-user-stories.md) | 实例配置、添加、使用和故障恢复场景 |
| [外部知识库逻辑设计](./external-knowledge-logic-design.md) | 状态、不变量、配置优先级和失败规则 |
| [外部知识库 UI 设计](./external-knowledge-ui-design.md) | 知识库页面、外部实例管理和创建向导交互 |
| [外部知识库技术设计](./external-knowledge-technical-design.md) | Provider Adapter、凭据、持久化、IPC 和检索标准化 |

## 术语

- **外部实例**：一个由用户配置的 Dify、FastGPT 或 RAGFlow 服务地址及其认证信息。
- **外部知识库绑定**：GoodBuddy 中的知识库记录与外部实例内一个远端知识库 ID 的只读关联。
- **Provider 配置**：某一 Provider 检索接口独有的设置，例如 RAGFlow 图谱检索。

外部知识库只提供检索结果。GoodBuddy 不接入外部 App、Chat、Assistant、Workflow
或 Agent，也不在外部实例中创建、修改、上传或删除知识库内容。远端资料不会批量同步
或进入本地索引；实际用于回答的有界片段会随引用保存在本地会话中。

当前尚未拆出覆盖整个知识库功能家族的统一逻辑、UI 设计和功能进度文档。
