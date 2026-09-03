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
