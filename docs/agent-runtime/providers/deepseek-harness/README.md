# DeepSeek Harness Runtime

通用规范与接入契约见 [Agent Runtime](../../README.md)。本目录维护 DeepSeek Harness 的接入设计与验证证据。

本功能定义 DeepSeek Harness 作为 GoodBuddy 本机 Agent Runtime 的产品接入、控制面、
插件市场、权限和打包边界。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [技术设计](./technical-design.md) | Runtime 产品与技术方案、协议、插件、打包、测试和验收 |
| [实现进度](./progress.md) | Windows 工作区路径修复及验证记录 |

现有文档同时包含部分 PRD、功能逻辑和进度内容，后续修改该 Runtime 时再按标准职责拆分。

跨项目共享 Host 和状态检查不冷启动的实现设计，由
[Runtime 进程复用技术设计](../../design/process-reuse.md)
统一维护；本 Runtime 的生命周期见[技术设计 §9](./technical-design.md#9-runtime-生命周期)，
未发布实现的验收状态见[工作栏进度](../../../features/assistant-workbar/progress.md#2026-09-14-runtime-进程复用实施中)。

The separate official Web client is pinned to `@deepseek-ai/dsh@0.2.1-rc.2`.
Its Main service API, unified execution rules, capability adapters, packaged resource
layout, and Windows validation are documented in
[Native Client Proposal, section 9.1](../../design/native-client.md#91-ds-web-backend-2026-09-26).
This Web resource tree is prepared separately from the background Harness Host.
Current shortcut/coordinator behavior and configured-model evidence are tracked in
[local native client progress](../../../features/assistant-workbar/progress.md#2026-09-27-local-native-client-validation),
including the remaining managed Node delivery gap.
