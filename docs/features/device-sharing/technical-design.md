# 客户端数字分身接入

执行用户确认的[PS-1 至 PS-6](../../../../goodbuddy-shareserver/docs/features/share-server/persona-sharing-design.md)。遵循[性能原则](../../architecture/performance-principles.md)：按页签加载、不增加启动工作、服务器为已发布配置唯一持久化 owner。

`src/shared/sharing-personas.ts` 定义 Zod 输入及响应、显式 IPC 方法；Main 的 `DeviceSharingService` 复用现有服务器连接和设备凭据，调用 `/api/v1/device-sharing/personas`。来源与 owner 不允许通过配置输入指定，凭据不进入 Renderer。

`DeviceSharingPage` 新增同级页签，复用 PageTabs。`SharingPersonas` 负责局部草稿和表单；`sharing-personas-store` 持有目录、加载及问答状态，通过 `useSyncExternalStore` 订阅，使用刷新代次和请求 ID 排除迟到响应。切换服务器重建视图，卸载取消问答。取消经显式 IPC 到 Main 的 AbortController，再传入真实 fetch。IPC 清理时终止仍在途的分身请求。

不引入第二份本地发布数据库或后台轮询；成功保存后重新读取服务器实际版本。失败保留草稿，版本冲突要求刷新后重新编辑。暂停与撤回使用服务端 revision。文本回答显示完整内容及来源版本标识；当前不是长期会话，也不调用本地 Runtime 或远程 Agent。

新界面复用 `.field`、共享按钮、PageShell 和通知机制；阻断加载与问答错误保留在上下文，保存成功通过应用通知显示。表单显示服务器地址、来源与服务器托管语义。可选知识只能选服务端已授权资料，匿名设备不展示成员知识。

真实联调复用 `tests/device-sharing.electron.test.ts`，设置 `GOODBUDDY_SHARING_SERVER_ROOT`、`GOODBUDDY_SHARING_TEST_HOST` 和 `GOODBUDDY_SHARING_MODEL_ENV` 后，经真实 UI、Preload、Main、HTTP 和模型提供商验证发布／问答／撤回。隔离目录在 `temp/device-sharing/`，测试 finally 清理。
