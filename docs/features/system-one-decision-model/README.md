# System One 决策模型

本功能为 GoodBuddy 增加 System One 决策模型协议，并将其作为应用内的结构化判断能力。首期用途是根据任务内容选择合适的 Assistant 角色；后续用途可扩展到意图路由、知识库结果重排、记忆筛选和任务评分。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [产品需求](./prd.md) | 用户问题、范围、需求和验收标准 |
| [技术设计](./technical-design.md) | 协议、配置、调用边界和实现顺序 |
| [功能进度](./progress.md) | 已验证实现、剩余工作和验证证据 |

通用模型连接的请求头、请求体和连接编辑行为由[模型连接请求定制](../model-connections/README.md)维护。Runtime 的模型选择契约由[Agent Runtime](../../agent-runtime/README.md)维护。

## 术语

| 术语 | 定义 |
| --- | --- |
| System One | 接收状态和类型化问题，返回结构化答案及概率的决策模型协议 |
| 决策模型 | 使用 System One 协议的模型连接 |
| 决策用途 | GoodBuddy 消费决策模型结果的产品场景 |
| 角色选择 | 根据当前任务在 Assistant 角色候选集中选择一个角色 |
