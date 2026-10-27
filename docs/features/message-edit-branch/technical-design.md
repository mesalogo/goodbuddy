# 技术设计

## 现有扩展点

- `conversationBranchInputSchema` 扩展可选编辑点；旧的完整会话复制继续可用。
- `AssistantDatabase.branchLocalConversation` 在既有存储 owner 的事务内校验和复制前缀。
- 消息 metadata 保存复制来源；会话 context JSON 保存分叉消息来源。沿用既有 JSON 存储，不复制附件文件、不引入第二个 writer 或持久化恢复日志。
- Main IPC 在返回前登记附件和工具全文引用；失败清理本次创建的分支及引用。
- Renderer 独立编辑模块维护草稿、提交及恢复状态；App 仅接线，消息列表只传稳定回调。
- `MessageEditDialog` 复用共享表单 Modal；`message-edit-store` 保存正文、附件与提交状态，`use-message-edit` 连接最新会话依赖。组件通过 `useSyncExternalStore` 订阅，输入不更新 App。
- 创建后的请求使用 `conversationQueue.enqueueUser` 和既有 dispatch，不另建模型执行通道。先将新分支同步登记到 store，再入队。

## Runtime 与监督回顾

新 conversationId 进入本机 Runtime 与 SSH Agent 共用请求合同，从完整历史前缀建立新上下文。各原生会话缓存不得按源会话复用。旧压缩状态不传入。复制来源字段在持久化及 Renderer 保存中保留；监督回顾的消息和知识引用扫描排除复制前缀。

编辑分支保留前缀中的附件、图片制品 ID 和已结束的子任务显示记录，去掉旧任务、队列及可执行图片操作关联。完整会话复制继续沿用原有制品和子任务裁剪规则。两类复制均记录 `copiedFromMessageId`；再次复制时保留最初来源 ID。

本次未改变 Agent 协议或 Runtime 执行实现。桌面调用队列的同一个新 conversationId 进入远程路径；SSH 验证使用当前源码的 Host 工具处理器与真实 SSH 传输。模型输出由确定性 fixture 提供；未以此宣称各原生 Runtime 或外部模型提供商均已实测。

## 验证

1. 真实 SQLite：首条/中间/末条编辑、超过显示分页的历史、错误 ID/助手消息/其他会话消息、忙碌、事务失败、原记录不变、新 ID、重开。
2. 资源生产组合：附件和工具全文引用、缺失资源报错、删除原会话后分支可读。
3. Renderer：编辑/取消/草稿隔离、重复点击、异步失败、来源导航、队列早于 Promise 返回的 dispatch 顺序、正确历史及附件进入 run。
4. Runtime：本机模型请求与 SSH 当前源码路径确认新会话和截断前缀，压缩摘要不泄漏；记录实际模型请求数。
5. 监督回顾：复制前缀去重，新请求和回复保留；兼容既有未带标记的消息。
6. 执行定向测试、`npm test`、`npm run typecheck`、`npm run lint`。真实 Electron 操作验证焦点、滚动和完整流程。

依据：[性能原则](../../architecture/performance-principles.md)、[数据库迁移指南](../../development/database-migrations.md)。
