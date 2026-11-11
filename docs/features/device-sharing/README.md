# 设备共享与数字分身

GB 设备共享接入独立 ShareServer。数字分身支持由 GB 发布配置、服务器托管执行，GB 离线后仍可使用。与管理员在 ShareServer 创建的分身共用目录和授权；模型路由是独立功能。

- [数字分身设计与契约](../../../../goodbuddy-shareserver/docs/features/share-server/persona-sharing-design.md)：两种来源、状态、权限、UI 与服务端协议的唯一权威定义。
- [客户端实现](./technical-design.md)：Main/Preload/Renderer 接入和生命周期。
- [实施记录](./progress.md)：验证事实与限制。

来源设备指发布配置的设备，不表示在该设备上执行。发布不会自动上传项目、记忆、文件或凭据。
