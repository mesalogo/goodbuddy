# Desktop 0.15.3 发布准备

日期：2026-09-28。用户确认沿用双远端推送、精确提交 CI 和生产构建通过后自动打标签的流程；
本次仅发布 Desktop 0.15.3，已发布 Agent 0.15.0 保持不变，不构建 LoongArch。

## 范围

- 已发布基线：`v0.15.2`，提交 `47ba54f47db4f22f69375310925eedab020b3cf0`。
- 本轮已核对 15 个提交，截止 `86347af0b1cc8726c1166b3f9fa3d7f12a0cc5e3`。
  包含手动压缩、请求级工具授权、取消/失败状态、聊天/笔记重复工作、
  侧栏与工作栏布局、打包依赖精简。起始工作区干净。
- Office 同会话实时编辑仅更新需求与验收设计，不计入交付能力。
- `package.json`、lockfile 两处 Desktop 版本统一为 0.15.3。
  已发布 0.15.2 与 Agent 0.15.0 的正文保持不变；新双语说明单独追加。
- 两份 FEATURES 对照实现更新手动压缩、状态反馈、搜索、箭头方向及发布状态。
  不用局部 Markdown 基准宣称整体渲染性能提升，不提前承诺跨平台安装包缩小比例。

## Agent 与验证边界

`src/agent-daemon`、`src/main/remote-agent`、Agent 和 Runtime 锁在本轮未变。
授权修复属于 Desktop 的 `KnowledgeMcpGateway`：请求有效期间不再按固定十分钟撤销，
取消和清理继续撤销；不修改远程工具通道或部署包，不需要重发 Agent 0.15.0。
手动直连压缩仅用于本地文本会话，UI 与 IPC 均排除 SSH/远程直连入口。

开发期证据分别见[直连模型进度](../features/direct-model-agent/progress.md)、
[导航进度](../features/application-tool-navigation/progress.md)和
[性能基准](../roadmap/product-performance-experience-improvement-plan.md)。
开发期全量曾报告侧栏和笔记 Electron 用例失败，不把这些历史结果计为本候选通过。
本轮 `npm run typecheck`、`npm run lint`、`npm run release:notes:verify` 通过。
网关、Obsidian 授权、桌面资源与 DS 打包、手动压缩真实 Electron 生产链路共 6 文件：
**85 通过、1 跳过**。跳过的是 Windows 不适用的 POSIX 符号链接用例。
压缩测试使用本机 HTTP fixture，不冒充外部模型调用；本轮没有新增付费模型请求。
沿用用户确认的直接推送等待 CI 流程，完整测试及生产构建以精确候选 CI 为发布门槛。
不进行本地生产构建、打包或安装包启动。

schema 保持 48；从更早版本升级前备份完整数据库及相邻 `notes/` 目录。
