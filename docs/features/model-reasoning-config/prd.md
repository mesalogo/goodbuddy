# 模型思考级别配置 PRD

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 调研与真实请求验证完成，待实施 |
| 版本 | 0.1 |
| 日期 | 2026-10-17 |
| 适用产品 | GoodBuddy 桌面端 |
| 关联领域 | 模型连接、直连模型 Agent、Continue、OpenCode、DeepSeek Harness |

## 1. 背景

GoodBuddy 当前可以在模型连接的高级设置中填写自定义请求体。用户可以借此传入不同
服务商的思考参数，但产品没有统一的思考级别字段，也没有提示某个参数在哪些协议和
Runtime 中生效。

模型返回的 `reasoning` 或 `thinking` 内容已经可以被 Runtime 解析和展示。它表示模型
实际返回的推理摘要，不能反推出用户配置的思考级别，也不能代替请求参数。

当前实现支持四种模型协议：Anthropic Messages、OpenAI Responses、OpenAI Chat
Completions 和 OpenAI Images Generations。思考配置只适用于文本模型协议，并且参数名、
可选值和计费方式由模型服务商决定。

## 2. 用户问题

- 用户无法在 GoodBuddy 中直接判断模型是否支持思考级别。
- 同一含义在不同协议中使用不同字段，配置方法依赖服务商文档。
- “上下文上限”和“Anthropic 最大输出”容易被误解为思考强度。
- 自定义请求体的生效范围不一致：直连模型和 Continue 支持，本地 OpenCode 与
  DeepSeek Harness 不读取该字段。
- 用户无法在界面中确认某次请求实际采用了哪个思考配置，也无法区分参数被服务商
  接受、忽略或拒绝。

## 3. 产品目标

1. 提供统一、可理解的思考级别配置入口，同时保留服务商专属参数的表达能力。
2. 按模型协议和 Runtime 明确展示可用范围、参数名和限制。
3. 在请求失败或服务商忽略参数时，向用户提供可定位的错误信息和请求诊断。
4. 不改变现有模型、工具、取消、重试、上下文压缩和凭据存储行为。
5. 允许用户为不同模型连接保存不同的思考配置。

## 4. 非目标

- 不承诺把所有服务商映射为完全相同的 Token 预算。
- 不读取或展示模型未公开的原始隐藏推理链。
- 不把返回的 reasoning 摘要当作思考级别的证明。
- 不替 OpenCode、Continue 或 DeepSeek Harness 管理其服务端私有配置。
- 不自动为不支持思考参数的模型伪造思考内容。
- 不在图像生成连接中展示文本模型思考级别。

## 5. 产品方案

### 5.1 配置模型

每个文本模型连接增加一个思考配置。配置采用协议相关的表达方式，并提供统一的
界面标签：

| 协议或服务商能力 | 推荐请求字段 | 级别或取值 |
| --- | --- | --- |
| OpenAI Responses | `reasoning.effort` | `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，具体模型可能只支持其中一部分 |
| OpenAI Chat Completions | `reasoning_effort` | 同上，具体由模型或兼容服务决定 |
| Anthropic effort | `output_config.effort` | `low`、`medium`、`high`、`xhigh`、`max`，具体模型可能只支持其中一部分 |
| DeepSeek Chat Completions | `reasoning_effort` | `none`、`low`、`high`、`max`；兼容值 `minimal` 映射为 `low`，`medium` 和 `xhigh` 映射为 `high` |
| 其他兼容服务 | 服务商自定义字段 | 由高级 JSON 配置表达，不预设级别集合 |

### 5.1.1 思考强度全集

下表列出产品需要识别的全部原生强度值。它是协议能力全集，不代表每个模型都支持
全部值。模型能力清单必须按模型裁剪；服务商没有能力声明时，不能显示为已确认支持。

| 标准级别 | OpenAI | Anthropic | DeepSeek | 产品含义 |
| --- | --- | --- | --- | --- |
| `none` | 原生值，部分模型不支持 | 无通用原生值 | 原生值，关闭思考 | 尽量不使用思考；不能保证普通模型完全没有内部计算 |
| `minimal` | 原生值，模型相关 | 不支持该名称 | 兼容别名，等同 `low` | 极低思考量，优先响应速度 |
| `low` | 原生值 | 原生值 | 原生值 | 简单任务、短对话和低延迟场景 |
| `medium` | 原生值 | 原生值 | 兼容别名，等同 `high` | 质量和成本之间的中间档 |
| `high` | 原生值 | 原生值 | 原生值，也是默认级别 | 复杂任务和常规 Agent 工作 |
| `xhigh` | 原生值，模型相关 | 原生值，模型相关 | 兼容别名，等同 `high` | 长流程、复杂编程和深度研究 |
| `max` | 原生值，模型相关 | 原生值，模型相关 | 原生值 | 允许的最高思考强度，成本和延迟最高 |

产品界面同时显示服务商原生名称和统一解释。对于 DeepSeek 的兼容别名，界面显示
“`medium`（发送为 `high`）”这类明确映射，不能假装它与 OpenAI 或 Anthropic 的
`medium` 具有相同语义。

### 5.1.2 思考模式与执行模式

思考模式不是强度级别，需要单独配置：

| 服务商 | 字段 | 模式 |
| --- | --- | --- |
| Anthropic | `thinking.type` | `disabled`、`enabled`、`adaptive`；部分模型还支持 `between_tools` |
| DeepSeek | `thinking.type` | `disabled`、`enabled` |
| OpenAI | `reasoning.mode` | `standard`、`pro`，只改变执行模式，不替代 `reasoning.effort` |

Anthropic 手动模式使用 `thinking.type: "enabled"` 和 `budget_tokens`。预算不是离散
级别，属于 Token 数值配置；通常必须不小于 1,024，并小于 `max_tokens`，具体以模型
文档为准。Anthropic 自适应模式使用 `thinking.type: "adaptive"`，再用
`output_config.effort` 选择 `low`、`medium`、`high`、`xhigh` 或 `max`。

OpenAI 的 `reasoning.context` 也不是强度级别。支持该字段的模型可使用 `auto`、
`current_turn` 或 `all_turns`，它控制历史 reasoning 的上下文处理方式。

首版实现优先覆盖 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 和
DeepSeek Chat Completions。
服务商未提供能力声明时，界面允许使用高级请求体，但不显示“已支持”的统一级别。

### 5.2 用户界面

参考 OpenAI 和 Anthropic 将 effort 放在模型请求参数区域的做法，GoodBuddy 只在主界面
提供一个“思考程度”控件。它默认选择“自动”，由模型或服务商决定是否思考以及思考量。
模型连接详情中新增该控件，位于上下文上限和最大输出设置之后、原有高级 JSON 之前：

- **自动**：优先使用服务商的原生自适应模式；服务商没有可确认的自适应模式时省略
  思考字段，使用模型默认行为。这是新配置和旧配置的默认值。
- **快速**：请求较低思考量，优先降低延迟和费用。
- **平衡**：请求中等思考量，适合普通问答和一般工具任务。
- **深入**：请求较高思考量，适合编程、研究和多步骤任务。
- **极致**：请求模型允许的最高思考量，只在当前模型有对应能力时显示。
- 下拉框只显示当前模型可映射的选项。服务商没有能力清单时，只显示“自动”和“自定义”。
- 控件旁显示一句模型相关说明，例如“自动：使用 `claude-sonnet-5` 的默认设置”。
- “自定义”展开协议字段、思考模式、固定预算和执行模式，普通用户不需要接触这些字段。
- 高级 JSON 继续保留，放在“自定义”区域下方，并标注用于未覆盖的服务商字段。

GoodBuddy 不在首版根据用户输入自行判断任务难度，也不为每条消息自动切换级别。自动
模式交给服务商处理；用户选择“深入”或“极致”时，配置固定到当前模型连接。这样可以
避免客户端的任务分类错误，也避免同一个会话中思考级别突然变化。

推荐的界面结构如下：

```text
思考配置
  思考程度       [自动 v]
                 自动 / 快速 / 平衡 / 深入 / 极致 / 自定义
  当前模型说明   自动使用模型默认值；较高设置通常增加延迟和 Token 用量
  生效范围       直连模型：支持 · Continue：支持 · OpenCode：由 Runtime 配置

自定义思考参数
  [仅选择“自定义”后显示]
```

初始版本不在聊天输入框旁增加一个全局思考按钮。思考配置属于模型连接，放在模型连接
详情中可以让同一个模型在聊天、Continue 和其他已支持入口中使用同一默认设置，也避免
用户在切换 Runtime 后误以为配置仍然生效。

当模型能力未知时，界面使用“由服务商决定”，不能把默认值显示成已确认能力。

### 5.2.1 简单选项的协议映射

| 简单选项 | OpenAI | Anthropic | DeepSeek |
| --- | --- | --- | --- |
| 自动 | 省略 `reasoning` 或 `reasoning_effort`，使用模型默认策略 | 支持自适应且能力已确认时发送 `thinking.type: adaptive`，否则使用模型默认模式 | 省略字段，使用服务商默认值 |
| 快速 | 当前模型支持的最低思考级别 | `low` | `none` 或 `low`，按模型能力选择 |
| 平衡 | `medium`，不支持时降为模型默认值 | `medium` | `high`，DeepSeek 没有独立 medium |
| 深入 | `high` | `high` | `high` |
| 极致 | `max` 或模型支持的最高级别 | `max` | `max` |
| 自定义 | `reasoning.effort`、`reasoning.mode` 等 | effort、思考模式、`budget_tokens` | `thinking.type`、`reasoning_effort` |

简单选项只是用户意图，不声称不同服务商的同名级别完全等价。界面可在悬浮说明中显示
实际映射，例如“平衡 → DeepSeek `high`”。如果目标模型不支持某个映射，系统不静默
发送一个未经确认的值，按以下顺序处理：使用模型声明的相邻级别、回退到自动，或要求
用户选择“自定义”。

当模型名能被能力目录识别时，级别下拉框只列该模型支持的值。模型名无法识别时，统一
控件只显示“自动”和“自定义”，并保留高级 JSON。用户通过高级 JSON 成功完成连接测试后，界面
可以显示“已由服务商接受”，但不把这次成功推断为模型能力目录中的永久支持。

### 5.3 请求和运行时行为

- 未开启手动配置时，不向请求添加思考字段，使用服务商默认行为。
- 开启后，Runtime 只向支持该配置的请求路径添加对应字段。
- Runtime 生成的模型、消息、工具、流式和认证字段继续拥有优先级。
- 参数被服务商拒绝时，保留服务商错误信息，并标出思考配置字段。
- 参数被服务商接受但服务商不返回 reasoning 摘要时，请求仍视为成功。
- 取消、超时、重试和工具轮次沿用现有语义。
- 请求记录保存协议、模型、配置来源和结果状态；不保存 API Key，不保存完整隐藏推理。

### 5.4 会话级调整

首版按模型连接保存默认配置。会话临时切换思考级别属于后续范围，届时需要明确：

- 切换只影响新请求，正在运行的请求继续使用启动时配置。
- 会话临时值是否写入会话历史。
- Runtime 自有配置和 GoodBuddy 模型配置发生冲突时的优先级。

## 6. 功能需求

### FR-1 模型能力识别

系统按模型协议展示可配置类型。模型或服务商未声明支持范围时，显示未知状态，允许
用户通过高级 JSON 配置，但不提供未经确认的级别选项。

### FR-2 OpenAI 思考级别

OpenAI Responses 使用 `reasoning.effort`；OpenAI Chat Completions 使用
`reasoning_effort`。系统不把两个字段同时写入同一请求，并保留服务商返回的参数错误。

### FR-3 Anthropic 思考预算

系统支持 `thinking.type`、`budget_tokens` 和服务商支持的自适应思考配置。手动预算必须
满足服务商的最小值要求，并为最终文本保留最大输出空间。

### FR-4 Runtime 范围

界面必须显示当前配置对每个 Runtime 的支持状态。未接入该字段的 Runtime 不得显示为
已生效。

### FR-5 配置校验

保存前校验数字范围、协议组合和保留字段冲突。模型服务商特有字段仍由真实请求验证，
GoodBuddy 不根据未知服务商的字段自行推断语义。

### FR-6 请求可观测性

请求失败时，活动记录显示协议、模型、思考配置来源和服务商错误类别。诊断内容不得
包含 API Key、Authorization 头或完整请求正文中的用户消息。

### FR-7 默认行为

旧配置和未选择思考配置的模型继续省略思考字段，使用服务商默认值。升级不能改变现有
模型连接的请求行为。

### FR-8 连接测试

“保存并测试模型”必须使用当前思考配置发起真实文本请求。测试结果至少记录请求是否
成功、HTTP 状态、协议、模型、配置字段是否被发送，以及服务商返回的有限错误摘要。

### FR-9 自适应优先

新模型连接默认使用“自动”。自动模式不由 GoodBuddy 进行任务难度分类；支持服务商原生
自适应模式且能力已确认时使用该模式，否则省略思考控制字段，让服务商使用模型默认策略。
用户选择其他简单选项时，系统按模型能力表映射
到服务商字段；无法安全映射时回退到自动并提示原因。

### FR-10 简单配置与高级配置分层

普通界面只显示“自动、快速、平衡、深入、极致、自定义”。协议字段、思考模式、固定
预算、OpenAI 执行模式和高级 JSON 只在用户选择“自定义”后显示。统一选项和高级 JSON
不能同时覆盖同一个请求字段而不提示冲突。

## 7. 验收标准

- [ ] OpenAI Responses 模型可保存并发送 `reasoning.effort`。
- [ ] OpenAI Chat Completions 模型可保存并发送 `reasoning_effort`。
- [ ] Anthropic 模型可校验并发送思考预算或自适应思考配置。
- [ ] 未配置思考级别的旧模型请求体不新增思考字段。
- [ ] 图像生成连接不显示文本思考配置。
- [ ] UI 能区分上下文上限、最大输出和思考预算。
- [ ] OpenCode、Continue 和 DeepSeek Harness 的支持范围与实际请求一致。
- [ ] Provider 拒绝参数时，错误信息能定位到协议、模型和参数类型。
- [ ] 真实连接测试不输出凭据和用户消息。
- [ ] 新模型连接默认显示“自动”，保存后不添加思考控制字段。
- [ ] 简单选项能按模型能力映射到各协议；无法映射时显示回退原因。
- [ ] 选择“自定义”后才显示协议专属字段和高级 JSON。
- [ ] 取消、超时、重试、工具调用和上下文压缩的现有测试继续通过。

## 8. 当前代码依据

- 模型连接字段及协议定义：[src/shared/contracts.ts](../../../src/shared/contracts.ts)
- 自定义请求体保留字段和合并规则：[src/shared/model-request-customization.ts](../../../src/shared/model-request-customization.ts)
- 直连模型请求构造：[src/main/agent/model-runtime.ts](../../../src/main/agent/model-runtime.ts)
- Continue 临时模型配置：[src/main/agent/continue-host-adapter.ts](../../../src/main/agent/continue-host-adapter.ts)
- 模型设置界面：[src/renderer/src/SettingsPanel.tsx](../../../src/renderer/src/SettingsPanel.tsx)

## 9. 环境模型实测

本节只记录脱敏后的模型、协议、端点类型、请求参数和结果，不记录 API Key、完整请求体
或用户内容。测试使用仓库中的环境文件，并以最小真实文本请求验证服务商是否接受思考参数。

### 9.1 测试范围

测试日期为 2026-10-17。测试读取仓库中的 `.env.openai.local`、`.env.deepseek.local` 和
`.env.claude.local`，分别向配置的模型端点发起最小文本生成请求。OpenAI 和 DeepSeek
各测试 `low` 和 `high` 两个值；Claude 测试手动思考预算和自适应思考两种配置。请求没有经过桌面 UI、Preload 或 GoodBuddy Main Runtime，
因此本节只验证服务商端点对字段的实际响应，不验证产品配置保存和 Runtime 注入路径。

测试过程中 Node 报告运行环境设置了 `NODE_TLS_REJECT_UNAUTHORIZED=0`。这会降低 HTTPS
证书校验强度，属于测试环境问题；生产验证不得依赖该设置。

### 9.2 结果

| 配置文件 | 协议 | 模型 | 请求字段 | low | high | usage 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| `.env.openai.local` | OpenAI Responses | `sub-gpt-5.6-sol` | `reasoning.effort` | HTTP 200 | HTTP 200 | 两次均为 `reasoning_tokens: 0` |
| `.env.deepseek.local` | OpenAI Chat Completions | `deepseek-flash` | `reasoning_effort` | HTTP 200 | HTTP 200 | 仅返回 `total_tokens`，无 reasoning 明细 |
| `.env.claude.local` | Anthropic Messages | `claude-sonnet-5` | `thinking.enabled`，预算 1024；`thinking.adaptive`，effort high | HTTP 200 | HTTP 200 | 两次均为 `thinking_tokens: 0` |

OpenAI 两次请求的 usage 均为 4,391 个输入 Token、5 个输出 Token、4,396 个总 Token，
其中 `reasoning_tokens` 为 0。DeepSeek 两次请求分别返回 49 和 48 个总 Token。Claude
两次请求均返回 102 个输入 Token、4 个输出 Token，`thinking_tokens` 为 0。三组结果
都只能证明端点接受了请求，不能证明思考参数改变了实际思考工作量。

### 9.3 结论

- OpenAI Responses 端点接受 `reasoning.effort` 字段，但当前测试模型或代理没有返回
  可观测的 reasoning Token。
- DeepSeek 端点接受 `reasoning_effort` 字段，但当前返回的 usage 不包含思考 Token
  明细，无法据此比较级别效果。
- Claude Messages 端点接受手动思考预算和自适应思考配置，但当前测试模型或代理返回的
  `thinking_tokens` 为 0，无法据此比较两种模式的实际思考量。
- 产品必须把“字段发送成功”和“思考级别已被服务商采用”分成两个状态；仅收到 HTTP
  200 不足以显示“已生效”。
- 后续产品实现需要保留服务商 usage 原文中允许展示的有限字段，并在能力未知时提示
  用户以服务商模型文档为准。

## 10. 后续实现顺序

1. 扩展共享模型配置契约，增加协议相关思考配置并保持旧配置兼容。
2. 在设置界面增加思考配置区域和边界校验。
3. 让直连模型和 Continue 按协议构造请求字段。
4. 明确 OpenCode、远程模型网关和 DeepSeek Harness 的支持边界。
5. 增加请求探针、真实连接测试和错误诊断覆盖。
6. 完成 Windows、Linux 和 macOS 的生产路径验证。

## 11. 外部依据

- [OpenAI Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)：定义
  `reasoning.effort` 的取值、`reasoning.mode` 和 `reasoning.context`。
- [Anthropic Effort](https://platform.claude.com/docs/en/build-with-claude/effort)：定义
  `output_config.effort` 的五档取值和模型差异。
- [Anthropic Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)：定义
  手动思考预算和 `thinking.type`。
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)：定义
  `thinking.type`、`reasoning_effort` 及兼容值映射。
