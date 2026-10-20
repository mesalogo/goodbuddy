# 模型思考级别配置

本目录记录 GoodBuddy 对模型思考级别、推理强度和思考预算的产品设计与验证结果。

## 文档

- [PRD](./prd.md)：定义用户问题、配置范围、协议适配、功能需求和验收标准。

## 术语

- **思考级别**：服务商请求中控制模型内部推理工作量的参数，例如 OpenAI 的
  `reasoning.effort` 或 Chat Completions 的 `reasoning_effort`。
- **思考预算**：按 Token 指定内部推理预算的参数，例如 Anthropic 的
  `thinking.budget_tokens`。
- **推理内容**：模型返回的 reasoning 或 thinking 摘要。它描述返回结果，不等于
  请求中控制思考工作量的配置。
