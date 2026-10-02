# Desktop 0.15.8 / Agent 0.15.2 发布准备

日期：2026-10-02。Desktop 基线 `v0.15.7`，Agent 基线 `agent-v0.15.1`；
已提交源码固定为 `b1129cedec5e4890d82fcddc186b13467f466a6f`。
仅纳入四个已提交功能修正及本次必要发布准备，不提交已有 Story Graph、
会话监督设计或宣传文章等未提交文件。

## 范围

- `dd29f30`：保存会话图片到本机或 Host、设置中列出图像工具。
- `f4d8fe7`：新记录取消、编辑焦点返回、笔记正文使用可用宽度。
- `2e5c348`：缺失内置浏览器设置时默认启用，保留已保存配置。
- `b1129ce`：缺失磨砂外观字段时默认开启，保留已保存配置。
- 数据库仍为 schema 52；Desktop 标准六平台，无 LoongArch。
- Agent 保存路径涉及守护进程、工具声明与桌面图像二进制回复，升至 0.15.2，
  最低 Desktop 0.15.8；协议主版本及 Runtime 锁版本不变。

## 当前源码共享 Host 验证

共享 Linux x64 Host 的现有 SSH 固定身份可达。在独立 `/root/tmp` 目录运行
当前源码 AgentImageToolMcp，通过真实 SSH 传递工具消息，与 Desktop 的
MainImageToolSession、ImageGenerationService、真实 SQLite 会话协作。
图像为本轮生成的合法随机 PNG，196992 字节，超过单个 128 KiB 分块。

保存后的 Host 文件 SHA-256 与 Desktop 原始内容相同；默认覆盖拒绝、明确覆盖成功、
其他会话图片 ID 拒绝、Ask 写入拒绝且无文件落盘。共 8 个回复帧，
最大 174892 字节，低于 256 KiB 上限。外部模型调用 0 次。
这是生产保存服务与 Agent MCP 的真实 Host 工具层验证，不冒充完整 App、
模型自动选工具、安装包或三个 Host 架构验证。使用 SSH 流作为该探针传输；
未改变用户工作区、产品配置或 Host 已安装 Agent。

临时探针最初因打包 Zod 初始化顺序、混入仅 Desktop 依赖而无法启动，
修正探针依赖边界后验证通过；这些失败不计为产品模型调用或产品修复。
探针和包不进入仓库。用户要求不跑本地测试套件，精确候选由 CI
执行全量验证和生产构建后，才允许打 Desktop 和 Agent 不可变标签。

## 发布核对

中英文 FEATURES、Desktop 与 Agent 双语说明必须与上述实现边界一致。
只暂存必要发布文件，保留工作区用户文件；双远端核验候选和标签一致。
公开验证包括六平台 Desktop、三平台 Agent 签名目录、GitHub/OSS 同步及 Latest 分离。
