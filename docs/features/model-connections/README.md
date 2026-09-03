# 模型连接请求定制

本功能负责 LLM 模型连接的自定义请求头和自定义请求体。用户可以在同一个连接中保存
Provider 要求的附加元数据；GoodBuddy 只在直连链路或 Runtime 明确原生支持的链路中应用
这些值，不为不支持的 Runtime 伪造透传能力。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [UI 设计](./ui-design.md) | 编辑入口、校验反馈、兼容性说明和无障碍行为 |
| [技术设计](./technical-design.md) | 契约、持久化、合并优先级、Runtime 支持矩阵和验证 |
| [功能进度](./progress.md) | 已验证实现、剩余工作和验证证据 |

本次改动是现有模型连接的有界扩展，不新增独立业务对象或工作流，因此不单独建立 PRD、
User Stories 和逻辑设计；本页定义产品边界，技术设计定义唯一的请求合并规则。

## 术语

| 术语 | 定义 |
| --- | --- |
| 自定义请求头 | 用户为一个 LLM 模型连接保存的附加 HTTP Header 字符串映射 |
| 自定义请求体 | 用户为一个 LLM 模型连接保存的附加 JSON 顶层字段 |
| Runtime 字段 | GoodBuddy 或 Runtime 为模型、消息、工具、流式、认证和协议生成的字段 |
| 直连 | GoodBuddy Main 直接向模型 Provider 发出请求 |
| 受管远程 OpenCode | 模型请求通过 GoodBuddy Agent 的可信模型网关发出的远程 OpenCode |

## 产品边界

- 两项设置都位于“设置 → 模型连接 → LLM → 连接详情”底部，以 JSON 对象编辑。
- 直连模型支持请求头和请求体，包括连接测试、文本、工具、摘要和图像生成请求。
- Continue 原生支持请求头和请求体。
- 本地 OpenCode 原生支持请求头，不使用自定义请求体。
- DeepSeek Harness 的 Pi-AI Provider 原生支持请求头，不使用自定义请求体。
- 受管远程 OpenCode 的可信模型网关支持请求头和请求体。
- 使用 Runtime 自有配置时不引用 GoodBuddy 模型连接，因此不会应用连接级请求定制。
- Runtime、协议和认证字段始终优先。用户不能用请求定制替换模型、消息、工具、流式或
  认证信息。
- 自定义值作为普通连接设置保存。API Key 和其他密钥必须使用专用凭据字段，不应写入
  自定义请求头或请求体。

## 相关功能

- [直连模型 Agent](../direct-model-agent/README.md)
- [DeepSeek Harness Runtime](../deepseek-harness/README.md)
- [远程主机与远程执行](../remote-host/README.md)
