# Desktop 0.16.3 发布准备

日期：2026-10-14。基线 `v0.16.2`，候选源码包含 `ae46cccc` 至 `af86e2f8`
之间的已提交变更。本候选只更新 Desktop；Agent 保持 `0.15.6`，不创建新的 Agent 标签。
标准六平台 Desktop，不含 LoongArch。

## 范围与兼容性

- 将远程主机管理迁移到应用中心，提供 Hosts 和 Agent 包页签；原有远程项目和连接配置继续保留。
- 聊天历史增加可关闭的缩略图导航，保留连续历史加载和窗口化显示。
- 改进应用中心、设置和项目菜单导航，等待状态、监督图谱缩放和附件选择边界。
- 不新增数据库 schema，Agent、runtime/acp、wire 和运行时锁版本不变。

## 工作区边界

开始准备时工作区包含用户未提交的 Hosts/Agent 包实现、测试、契约、
Preload/IPC 和文档修改，包括 `src/main/remote-agent/`、`src/preload/`、
`src/shared/`、`src/renderer/src/AgentPackageInventoryPanel*`、
`src/main/ipc*`、`docs/features/application-tool-navigation/README.md`
以及未跟踪的 `docs/features/external-apps/`。这些内容不属于候选，不得覆盖或提交。

## 发布门槛

完成发布说明校验、测试、三套 typecheck 和 lint 后，再确认候选提交并推送到
`origin` 与 `github`。本轮不构建或发布 LoongArch，也不创建新的 Agent 标签。
