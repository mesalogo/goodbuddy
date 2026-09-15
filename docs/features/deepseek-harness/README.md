# DeepSeek Harness Runtime

本功能定义 DeepSeek Harness 作为 GoodBuddy 本机 Agent Runtime 的产品接入、控制面、
插件市场、权限和打包边界。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [技术设计](./technical-design.md) | Runtime 产品与技术方案、协议、插件、打包、测试和验收 |
| [实现进度](./progress.md) | Windows 工作区路径修复及验证记录 |

现有文档同时包含部分 PRD、功能逻辑和进度内容，后续修改该 Runtime 时再按标准职责拆分。

跨项目共享 Host 和状态检查不冷启动的实现设计，由
[Runtime 进程复用技术设计](../assistant-workbar/runtime-process-reuse-technical-design.md)
统一维护；本 Runtime 的生命周期见[技术设计 §9](./technical-design.md#9-runtime-生命周期)，
未发布实现的验收状态见[工作栏进度](../assistant-workbar/progress.md#2026-09-14-runtime-进程复用实施中)。
