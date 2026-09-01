# 本机工具环境功能进度

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档类型 | 功能进度 |
| 状态 | 计划中 |
| 版本 | 0.1 |
| 日期 | 2026-09-01 |
| 关联入口 | [本机工具环境](./README.md) |

## 当前结论

功能尚未进入源码实施。产品范围、User Stories、功能逻辑评估、UI 一致性和技术方案已经
形成首版文档。

## 已完成

- [x] 明确功能只服务本机 SKILL 和本机 stdio MCP。
- [x] 明确远程 Host 不接收本机工具环境、SKILL 或 MCP。
- [x] 将来源收敛为“GoodBuddy 托管”和“自定义环境”。
- [x] 明确 Node、npm、npx 同源，Python、python3、pip 同源。
- [x] 区分工具环境就绪与能力依赖就绪。
- [x] 定义现有用户解释器的一次性兼容迁移。
- [x] 定义状态机、来源和命令决策表、失败恢复与生效时机。
- [x] 定义设置页结构、状态、文案和无障碍要求。
- [x] 定义 Main 服务、shim、探测、诊断、PATH 注入和 Python 生命周期。
- [x] 远程主机设置副标题已说明本机 Skills 和 MCP 不作用于远程主机。

## 待实施

### 阶段 1：设置、探测和界面

- [ ] Shared 设置、状态、操作和 IPC schema。
- [ ] 旧用户迁移。
- [ ] Node/Python 候选探测。
- [ ] 完整环境诊断。
- [ ] Agent Runtime 设置中的本机工具环境卡片。

### 阶段 2：托管 Node

- [ ] 提取并复用 DSH Node shim。
- [ ] 提供 node/npm/npx。
- [ ] 注入 OpenCode、Continue、DeepSeek Harness。
- [ ] 注入 Main 和 Runtime 的 stdio MCP。
- [ ] 安装包真实 Node、npm、npx smoke。

### 阶段 3：托管 Python

- [ ] 选型并锁定六平台 CPython 工件。
- [ ] 完成许可证和下载目录。
- [ ] 下载、校验、安装、更新、取消和删除。
- [ ] 提供 python/python3/pip。
- [ ] Python 标准库、SSL、pip、venv 真实诊断。

### 阶段 4：端到端验收

- [ ] Node SKILL 实际成果。
- [ ] Python SKILL 实际成果。
- [ ] Node stdio MCP 实际调用。
- [ ] Python stdio MCP 实际调用。
- [ ] 自定义 Node/Python 路径。
- [ ] Ask/Execute、Runtime 重建、取消、退出。
- [ ] 六平台 CI、许可证和生产构建。

## 当前阻塞项

- 尚未完成六平台可再分发 CPython 工件选型，因此托管 Python 版本、体积和下载摘要未锁定。
- 尚未开始源码接入。

## 已验证证据

### 2026-08-31

- 确认安装包携带 Electron Node 能力和锁定 npm CLI，但未向通用 SKILL/MCP 提供 `node`
  命令。
- 确认 DSH 插件安装器已有 `ELECTRON_RUN_AS_NODE=1` shim，可作为复用基线。
- 确认远程 Agent ACP Session 使用空 MCP Server 列表，本机 SKILL/MCP 不进入远程路径。
- 远程主机设置文案聚焦测试通过：`80/80`。
- 当时完整类型检查通过；完整测试和 Lint 被并行开发中的 `RightAssistantSidebar` 变更
  阻塞，不作为本功能实现验证。

## 进度维护要求

- 只有真实源码和生产路径完成后才能勾选对应实施项。
- 测试失败时保留未完成状态并记录失败原因。
- 每次更新记录日期、实际命令、结果和外部阻塞。
- 不在本文件复制未来设计，需求变化回写 PRD/UI/技术设计。
