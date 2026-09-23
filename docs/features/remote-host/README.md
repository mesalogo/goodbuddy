# 远程主机与远程执行

本功能负责 SSH Host 管理、Host Key、远程环境安装、GoodBuddy Agent、签名 Runtime、
远程 Workspace 和 Ask/Execute 生产路径。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [远程主机与 Agent 技术设计](./technical-design.md) | 当前产品语义、Agent、Runtime、Workspace、协议、生命周期和验证事实 |
| [远程环境准备技术设计](./environment-provisioning-technical-design.md) | Host 下载、GoodBuddy 传输、安装事务、更新和恢复边界 |
| [执行清单验证记录](./runtime-checklist-validation.md) | 远程 OC/CN 原生清单、CN 开发包安装、取消及断线重放的实测结果与剩余验收 |

现有文档包含产品、功能逻辑和进度事实，后续修改远程功能时再按标准职责拆分。

跨会话共享 OpenCode 进程、ACP 连接与模型桥的实现设计，见
[Runtime 进程复用技术设计](../assistant-workbar/runtime-process-reuse-technical-design.md#6-ssh-opencode-与-agent)。
当前实现尚未发布；验收状态见[工作栏进度](../assistant-workbar/progress.md#2026-09-14-runtime-进程复用实施中)。

更新退役、任务完成后 Runtime 回收和下一轮历史恢复的当前源码验证，见
[2026-09-23 生命周期验证](./technical-design.md#生命周期验证2026-09-23)。
