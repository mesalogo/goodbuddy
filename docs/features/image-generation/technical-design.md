# 图片上下文技术设计

## 请求与存储

Renderer 从当前完整会话快照选择最近一条 `complete` 助手消息的 `artifactIds`，通过
`AgentRequest.imageContextArtifactIds` 传递最多 8 个成果 ID。图片消息可以没有正文，
因此引用选择不使用过滤后的文字历史。队列在实际发送时使用当时的会话快照。
普通文本历史契约保持 `role/content`；图片字节不进入历史 IPC，也不新增图片副本。

Main 仅在 `capability === 'image-generation'` 时调用 `withImageConversationContext`。
当前 `ContextManager` 已解析的显式附图优先；否则通过现有 `getArtifact` 加载引用的
内联 PNG/JPEG，WebP 使用 Electron 解码为 PNG。缺失或不可用引用形成上下文提示，
数据库等基础设施错误仍向上传递。读取不依赖会话的异步保存进度，因为成果已在发送
`artifact` 事件前由 Main 保存。

生成图片继续由 `createImageArtifact` 保存。可选 `imageContextNotice` 随生成事件、
公开成果事件和消息 metadata 保存，不新增表、迁移、服务端 ID 或 Runtime 会话缓存。
它是该回复的展示事实，不进入下一轮提示词。

## 上游请求

`ModelAgentRuntime` 将已有文字历史作为会话数据加入提示词，并把本轮要求放在末尾。
不从头截断组合提示词而丢掉最后的修改要求；服务商自己的长度和资源限制仍然有效。
有图片使用 `/images/edits`，单图字段为 `image`，多图为 `image[]`；无图使用
`/images/generations`。质量、认证及自定义请求字段继续走原有配置合并。

本路径不接入 Responses 图片工具、不依赖 `previous_response_id`，不额外调用文本模型。
显式回传上下文不表示上游提供或保存了服务端会话；无法据此保证像素级不变。
结果仅接受原有校验通过的内联图片，不下载 Provider 返回的图片 URL。

## 能力缺失与错误

编辑返回 HTTP 405/501，或 HTTP 400/404/422 的错误正文明确说明图片编辑不支持或未实现时，
同一请求最多再调用一次无图生成。成功成果携带 `editing-unavailable`，继续以 `done`
结束；再次失败正常报错，不循环回退。

其他错误保留 HTTP 状态和 Provider 信息。尤其不把 401/403、429、模型不存在、
无效图片、超时或服务暂不可用判作不支持编辑。取消发生后不启动后续生成。
本次不持久化能力探测结果、不切换模型、不新增重试框架。

## Remote 边界与验证

Renderer 只为直连模型附带成果引用，Main 只在图片能力分支使用它。
`managed-remote-acp-runtime.ts` 与远程项目 validator 均要求 OpenCode；
本修改不改变 Agent gateway、ACP 或远程模型请求，不需要部署新 Agent。

专项验证覆盖完整文字、纯图片消息引用、显式附图优先、成果恢复、会话隔离、
能力缺失提示、取消、真实错误及 UI/SQLite metadata。真实验收必须从桌面发送按钮进入
生产 IPC 和 Runtime，验证生成、连续修改及重新打开后的续接。
