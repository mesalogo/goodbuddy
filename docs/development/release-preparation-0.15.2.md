# Desktop 0.15.2 与 Agent 0.15.0 发布准备

日期：2026-09-28。用户要求包含当前本地工作、推送双远端，等待候选 CI 和生产构建通过后打标签；
确认同时发布 Agent 0.15.0，不构建 LoongArch。沿用此前自行审核候选和双语说明的授权。

## 发布范围

- Desktop 基线为已发布的 `v0.15.1`（`4e5239256d42c856bb1420d87c4a338f17867b80`）。
  [发布 CI 36368878429](https://github.com/mesalogo/goodbuddy/actions/runs/36368878429)
  六个原生目标和 GitHub/OSS 发布全部成功，0.15.1 的历史说明保留。
- 新源码截止 `66f77b83c2b6ebe0018a6c5c2bc72e1b4c1e43b1`：
  renderer 退出诊断、笔记采集界面、双语网站及 Story Graph 只读工具与完整讨论草稿。
- Agent 0.15.0 尚未发布，基线仍为 `agent-v0.13.4`。
  既有遥测和 Continue 更新检查修复保留，补充远程 Story Graph 工具；
  最低 Desktop 版本由当前 manifest 派生为 0.15.2。三个原生目标和 Runtime 锁不变。
- 当前未提交的功能矩阵、主机/云环境设计和宣传文稿一并审核纳入。
  云平台适配与主机入口迁移明确为待实现规划，不进入发布功能说明。
  宣传稿保持草稿和原核查截止点，不代表已对外发布。
- 正式双语正文仅维护在 `resources/release-notes.json` 的 0.15.2 条目和
  `resources/agent-release-notes/0.15.0.md`。两份 FEATURES 已对照实现与规划核对。

## 验证边界

Story Graph 已有开发期证据见
[监督者验证进度](../features/conversation-supervision/progress.md#2026-09-28-story-graph-只读工具)：
真实 Linux Host 上的 OpenCode/Continue Ask、Execute 调用与禁用检查通过；
推理为本机确定性响应，10 次请求含 2 次标题生成，外部付费请求 0 次。
不将这些证据称为真实模型建议质量验证，也不宣称历史重建、跨范围事实合并或大库性能已验收。

本轮类型、lint、双语说明及网站静态校验通过。按当前源码重建隔离 Agent 探针，
在共享 Linux x64 Host 经固定身份完成 OpenCode/Continue Ask、Execute、空闲进程回收、
冷启动历史恢复和遥测关闭环境检查；每个 Runtime 2 次真实模型请求，共 **4 次**，
没有重试或假模型调用，结束时归属进程均为 0。该补充检查不等于真实模型图谱建议质量验收。

准备期间另有 `0cdf042` 宣传稿提交，已核对只有三份文档变化，产品源码仍截止 `66f77b8`，
一并纳入完整候选。用户随后中断本地全量步骤，明确要求直接推送等待 CI；
本地全量不记为通过，由精确候选的主分支 CI 执行完整测试和生产构建，通过后才打标签。
不运行本地生产构建、安装包打包或安装包启动；使用既有隔离 Host 目录，不更改生产 Agent。
schema 保持 48；从旧版升级应备份完整数据库和相邻 `notes/`，不能用旧客户端打开升级后的库。

## 首次候选 CI

`76e781a` 已同步双远端。Agent [CI 36379713606](https://github.com/mesalogo/goodbuddy/actions/runs/36379713606)
通过；Desktop [CI 36379713607](https://github.com/mesalogo/goodbuddy/actions/runs/36379713607)
5,389 通过、51 跳过、1 失败，生产构建未执行，未打标签。
失败的设置测试用固定五个服务器名称过滤按钮，却用新增 Story Graph 后的六项目录断言数量。
同步把旧模拟列表与按钮身份断言改为复用正式目录，保留数量和原交互断言，并逐项验证目录按钮存在。
最终完整 SettingsPanel 文件、类型、lint 和发布说明检查通过；全量继续交由新提交 CI。
