# 主机管理实施进度

本文只记录主机管理与云环境管理（[PRD](./prd.md) FR-RH-1 至 FR-RH-6）的已验证实现事实。现有 SSH、Agent 和 Runtime 的历史验证见[技术设计](./technical-design.md)和[执行清单验证记录](../../agent-runtime/validation/remote-checklist.md)。

## 2026-10-13 一期：主机管理迁入应用中心

提交：`05838d2c feat(hosts): move host management into the Hosts application`。

### 已完成

| 范围 | 对应需求 | 实现事实 |
| --- | --- | --- |
| 应用入口 | FR-RH-1 | 应用中心、应用菜单和常驻侧栏新增“主机管理”，打开独立工作页面；应用标识 `remote-hosts`，默认排在末尾、不常驻 |
| 远程能力开关 | FR-RH-1、FR-RH-6 | 开关移到“主机管理 > 应用设置”，沿用 `remoteProjectsEnabled`，Main 校验不变；远程能力关闭时页面仍可打开并就地启用 |
| Agent 离线包 | FR-RH-1 | 从“平台功能 > 远程项目”迁到主机管理的“Agent 离线包”页签；远程能力关闭时仍可管理 |
| 设置中心 | FR-RH-1 | 删除“主机与远程执行”分类和“平台功能 > 远程项目”页签，无重复入口 |
| 主机列表 | FR-RH-2（部分） | 名称或地址搜索；多台主机默认收起为一行，显示验证、执行环境和关联项目徽标；编辑、删除在卡片头部；版本信息改为表格 |
| 配置迁移 | FR-RH-6 | 已保存的导航顺序和常驻偏好保留，新应用追加到末尾；远程能力开关值、主机、凭据、Host Key 和项目引用不变 |
| 应用设置 | — | 各应用设置中的开关统一靠右对齐，包括带说明图标的开关 |

### 验证

- `npm run typecheck` 通过；改动文件的 `eslint` 无问题。
- 下列测试 9 个文件、265 项全部通过：`SshHostsSettingsSection`、`RemoteHostsPage`、`AgentPackageInventoryPanel`、`ApplicationCenter`、`ApplicationMenu`、`SettingsPanel`、`settings-categories`、`application-settings-store`、`goodbuddy-config-contracts`。
- 存储测试覆盖：已发布的五应用完整顺序在远程能力开启和关闭两种情况下升级，新应用追加到末尾且常驻为否，重新读取后不变。
- `App.test.tsx` 350 项中有 8 项失败，均为流式消息与持久化终态收敛用例。在改动前的提交 `b22be514` 上单独运行这 8 项同样失败，与本次改动无关。

### 未验证与剩余工作

- 尚未在真实运行的应用中检查主机列表、离线包页签和应用设置开关对齐，也未覆盖深色主题和窄窗口；以上界面行为目前只有组件测试。
- 尚未连接真实主机执行添加、验证、安装和创建远程项目的完整流程。
- 未实现：列表与详情两栏、来源与连接状态筛选、关联项目页签（FR-RH-2 其余部分），云环境管理和平台适配器（FR-RH-3 至 FR-RH-5）。
