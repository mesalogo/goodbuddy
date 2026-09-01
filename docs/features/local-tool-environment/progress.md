# 工具执行环境功能进度

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档类型 | 功能进度 |
| 状态 | 计划中 |
| 版本 | 0.1 |
| 日期 | 2026-09-01 |
| 关联入口 | [工具执行环境](./README.md) |

## 当前结论

设置菜单结构第一阶段已经进入源码：原 Skills/MCP 一级分类合并为“能力与工具”，内部
显示两个水平 Tab。工具执行环境、Node/Python 和下载源尚未实施。

## 已完成

- [x] 明确功能只服务本机 SKILL 和本机 stdio MCP。
- [x] 明确远程 Host 不接收工具执行环境、SKILL 或 MCP。
- [x] 将来源收敛为“GoodBuddy 托管”和“自定义环境”。
- [x] 明确 Node、npm、npx 同源，Python、python3、pip 同源。
- [x] 区分工具环境就绪与能力依赖就绪。
- [x] 定义现有用户解释器的一次性兼容迁移。
- [x] 定义状态机、来源和命令决策表、失败恢复与生效时机。
- [x] 定义受管工具外部工件的原生地址/OSS 镜像规则。
- [x] 将 Skills、MCP、工具执行环境收敛到“能力与工具”一级分类和三个水平 Tab。
- [x] 实现“能力与工具”一级菜单及 `Skills`、`MCP` 两个水平 Tab。
- [x] 移除原 Skills/MCP 一级入口，并保留原有业务功能和 MCP 内层页签。
- [x] 未提前显示“工具执行环境”禁用项或占位页。
- [x] 定义设置页结构、状态、文案和无障碍要求。
- [x] 定义 Main 服务、shim、探测、诊断、PATH 注入和 Python 生命周期。
- [x] 远程主机设置副标题已说明本机 Skills 和 MCP 不作用于远程主机。
- [x] 将内置 Skill 顶层目录从 14 个收敛为 5 个，九种产品营销配方改为
  `product-marketing` 包内按需工作流。
- [x] 通用文档工具默认启用，三个产品营销 Skill 默认停用，同时保留用户显式保存状态。

## 待实施

### 阶段 1：设置、探测和界面

- [ ] Shared 设置、状态、操作和 IPC schema。
- [ ] 旧用户迁移。
- [ ] Node/Python 候选探测。
- [ ] 完整环境诊断。
- [x] “能力与工具”统一设置分类及 Skills/MCP 水平 Tab。
- [ ] 工具执行环境完成后追加第三个水平 Tab。
- [ ] 工具下载源、Node.js、Python 和诊断卡片。

### 阶段 2：托管 Node

- [ ] 提取并复用 DSH Node shim。
- [ ] 提供 node/npm/npx。
- [ ] 注入 OpenCode、Continue、DeepSeek Harness。
- [ ] 注入 Main 和 Runtime 的 stdio MCP。
- [ ] 安装包真实 Node、npm、npx smoke。

### 阶段 3：托管 Python

- [ ] 选型并锁定六平台 CPython 工件。
- [ ] 完成许可证和下载目录。
- [ ] 为每个平台工件固定原生 Target 和字节相同的 OSS Target。
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
- 工具执行环境的 Node/Python、下载源、诊断和进程注入尚未开始源码接入。

## 已验证证据

### 2026-09-02

- `npm run typecheck` 通过。
- `npm run lint` 通过。
- `npm run build` 通过。
- `npm test` 通过：`3412` 通过、`50` 跳过。
- Skill 聚焦测试通过：Capability/Bundled Skills `39/39`，产品营销路由 `10/10`。
- `npm test -- src/renderer/src/SettingsPanel.test.tsx` 通过：`80/80`。
- 设置页测试确认左侧不再显示独立 Skills/MCP，统一入口默认打开 Skills，MCP 原内层页签
  保持可用，且不显示工具执行环境占位。
- 修复能力与工具 Tab 包装层在可滚动设置布局中被 Flexbox 压缩到零高度的问题，并增加与
  平台功能相同的 `flex: 0 0 auto` CSS 回归测试；聚焦测试 `110/110` 通过。
- Electron 自动化检查被本机已运行正式版的单实例锁和隔离开发版原生启动错误阻塞；未停止
  或修改正式版进程，已清理本次隔离进程和临时用户数据。

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
