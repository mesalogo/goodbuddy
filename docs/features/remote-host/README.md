# 远程主机与远程执行

本功能负责 SSH Host 管理、Host Key、远程环境安装、GoodBuddy Agent、签名 Runtime、
远程 Workspace 和无模式工具执行生产路径。

2026-09-28 新增待实现方向：主机管理迁入应用中心，与“云环境管理”成为同级应用；
云平台发现已有实例，接入执行时复用 SSH 主机。产品范围见 [PRD](./prd.md)。
本文中的平台连接指云账号或私有化 API 连接，云实例指平台中的虚拟机，主机指 GoodBuddy
保存的 SSH 连接目标；三者不等同。现有实现和历史验收仍以下列技术文档为准。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [产品需求](./prd.md) | 应用迁移、六平台适配范围、分期与产品验收；待实现 |
| [功能逻辑](./logic-design.md) | 平台、实例、主机关系，独立状态、依赖和删除规则；待实现 |
| [界面设计](./ui-design.md) | 独立工作页面、主机列表与详情、云实例接入和响应式交互；待实现 |
| [远程主机与 Agent 技术设计](./technical-design.md) | 当前产品语义、Agent、Runtime、Workspace、协议、生命周期和验证事实 |
| [远程环境准备技术设计](./environment-provisioning-technical-design.md) | Host 下载、GoodBuddy 传输、安装事务、更新和恢复边界 |
| [执行清单验证记录](./runtime-checklist-validation.md) | 远程 OC/CN 原生清单、CN 开发包安装、取消及断线重放的实测结果与剩余验收 |

既有技术文档保留当前 SSH 行为及历史进度；新增 PRD、逻辑和 UI 文档只定义本次待实现范围，
不替代已有验证事实。验收场景随 PRD 维护，本次不单独创建 User Stories 或进度占位文档。

跨会话共享 OpenCode 进程、ACP 连接与模型桥的实现设计，见
[Runtime 进程复用技术设计](../assistant-workbar/runtime-process-reuse-technical-design.md#6-ssh-opencode-与-agent)。
当前实现尚未发布；验收状态见[工作栏进度](../assistant-workbar/progress.md#2026-09-14-runtime-进程复用实施中)。

更新退役、任务完成后 Runtime 回收和下一轮历史恢复的当前源码验证，见
[2026-09-23 生命周期验证](./technical-design.md#生命周期验证2026-09-23)。
