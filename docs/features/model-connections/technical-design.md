# 模型连接请求定制技术设计

## 1. 共享契约

`src/shared/model-request-customization.ts` 定义：

- `ModelRequestHeaders`：字符串到字符串的映射。
- `ModelRequestBody`：顶层 JSON 对象。
- 两个 Zod schema、统一边界和合并函数。

模型连接输入、公开设置、Main 内 resolved profile 和远程 Prompt profile 复用这些类型。
Runtime 设置文件版本为 21；版本 20 迁移为两个空对象，不改变已有连接或凭据。

## 2. 边界

请求头最多 64 项；名称最长 128 字符，值最长 4096 字符。名称必须是合法 HTTP token，
大小写归一后不能重复，值不能包含控制字符。

请求体编码后最多 64 KiB，最大深度 16、最大节点数 4096；对象或数组单层最多 256 项。
键最长 256 字符，字符串值最长 32768 字符，数字必须有限。

下列请求头由认证、协议或传输层拥有，不能在连接中配置：

`Authorization`、`X-API-Key`、`API-Key`、`Content-Type`、`Content-Length`、`Host`、
`Connection`、`Transfer-Encoding`、`User-Agent`、`Anthropic-Version`。

下列请求体顶层字段由 GoodBuddy 或 Runtime 拥有，不能在连接中配置：

`model`、`stream`、`messages`、`input`、`instructions`、`system`、`tools`、
`tool_choice`、`parallel_tool_calls`、`max_tokens`、`max_output_tokens`、
`stream_options`、`prompt`、`n`、`quality`、`response_format`。

## 3. 合并规则

请求头先装载用户值，再装载 Runtime 和协议值，最后注入认证值。名称比较不区分大小写，
因此 Runtime、协议和认证值始终覆盖同名用户值。

请求体只做一次顶层浅合并：

```ts
const providerBody = {
  ...connection.requestBody,
  ...runtimeBody
}
```

不递归合并嵌套对象。最终请求仍需通过现有协议策略和请求大小校验。

## 4. Runtime 支持矩阵

| 请求路径 | 自定义 Header | 自定义 Body | 实现边界 |
| --- | --- | --- | --- |
| GoodBuddy 直连 | 支持 | 支持 | Main 在连接测试、文本、工具、摘要和图像请求中合并 |
| Continue | 支持 | 支持 | 使用 Continue 1.5.47 的 `requestOptions.headers` 与 `extraBodyProperties` |
| 本地 OpenCode | 支持 | 不支持 | 使用 OpenCode Provider `options.headers`；不生成未证实的 Body 配置 |
| DeepSeek Harness | 支持 | 不支持 | 使用 `dsh-llm-pi-ai` Provider 的 `headers`；Utility 控制协议 v3 传递 Header |
| 受管远程 OpenCode | 支持 | 支持 | Agent Prompt profile 传到可信模型网关后合并 |
| Runtime 自有配置 | 不适用 | 不适用 | 该模式不使用 GoodBuddy 模型连接 |

对不支持自定义 Body 的 Runtime，设置仍保留在连接上，切换回支持路径时继续生效；当前
Runtime 不接收也不发送该 Body。

## 5. 远程模型网关

非空请求定制随 Prompt-scoped model profile 发送，不写入 Agent 环境、命令行或模型调用
ledger。模型 profile digest 绑定规范化后的 Header 和 Body，但继续排除 API Key。

Main 网关和 Agent 网关都执行相同的可信 profile 合并、协议策略检查和最终 Body 大小检查。
认证 Header 在请求摘要生成后注入，避免凭据进入摘要或 ledger。受管远程
`runtime/acp` capability 为 v5；旧 v4 Agent 不能接收带请求定制的新 Prompt profile，
由现有受管更新流程升级后再运行。

## 6. 凭据

API Key 继续由现有 Main 加密设置和 Prompt-scoped Agent 凭据路径管理。自定义 Header 和
Body 是普通可见连接设置，不提供第二套通用秘密存储；UI 必须提示不要把密钥放入这两个
JSON 对象，标准认证 Header 也由 schema 拒绝。

## 7. 验证

- 共享 schema：JSON 类型、边界、保留字段和优先级。
- 设置存储：v20 → v21 迁移与 Header/Body round trip。
- 直连：连接测试、流式文本、工具、摘要和图像请求。
- Runtime：真实 bundled OpenCode/Continue 对 loopback Provider 的请求探针；DeepSeek
  Utility 启动配置和 Pi-AI Provider 配置。
- 远程：Main/Agent 网关合并、认证优先级、摘要绑定、大小限制和不重放。
- UI：默认值、保存、无效 JSON 保留和 Runtime 支持说明。

## 8. 通道直连模型选择修复

`repairChannelRuntimeSelection` 只在默认连接可用于文本通道时保留动态
`{ provider: 'model' }`。默认连接为图像生成、API Key 认证但明确缺少凭据，或默认 ID
已不存在时，若找到可用文本连接，修复结果必须携带该连接的 `profileId`，使后续
`applyRuntimeSelection` 使用已验证回退，而不是重新解析到不可用的全局默认值。
已有可用显式引用保持不变；没有可用连接时不虚构 ID 或声称可运行。

共享回归测试将修复结果直接传入 Main 的生产 resolver，验证动态默认、显式固定、
图像默认、缺少凭据和失效默认 ID。该修复不改变 OpenCode、Continue 或托管 SSH 的
Runtime 选择路径。

## 9. Harness 平台来源公开投影

`RuntimeSettings.deepseekHarnessPlatformModel` 是可选只读元数据，描述 `platform`
选项在当前已保存模型设置与管理员环境下的实际解析结果：

- `{ source: 'environment', name, modelName }`：使用完整管理员预置。
- `{ source: 'profile', profileId, name, modelName }`：使用兼容 GoodBuddy 连接回退。
- `{ source: 'unavailable' }`：没有可解析的连接。

Main 的 `toPublicSettings` 复用 `resolveDeepSeekHarnessModelProfile`，只在调用中将来源
设为 `platform`，不改变用户已保存的 `default`、`profile` 或 `platform` 选择。投影逐字段
构造，不包含地址、API Key、自定义 Header/Body 或凭据状态，不写入设置文件、迁移或新状态。
公开契约保持可选，缺失时 UI 明确来源信息不可用，不从通用模型或环境凭据猜测。

`source: 'profile'` 描述来源分支，不代表凭据来源：仅环境密钥或旧环境变量可能仍影响该
GoodBuddy 连接，但不会被误报为完整管理员预置。连接解析不代替真实模型请求或可用性测试。
UI 的未保存兼容候选只作草稿预览，保存后继续以 Main 返回的投影为准。
