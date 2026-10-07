# Desktop 0.15.13 / Agent 0.15.6 发布准备

日期：2026-10-07。基线 `v0.15.12`，冻结源码
`c1e4bbf66a418dbd4e0f99a36ff0522dbf610553`。只纳入已提交实现和发布准备，
保留开始准备后出现的并行工作。标准六平台 Desktop、三平台 Agent，不含 LoongArch。

## 范围与兼容性

- 一个 Desktop storage utility process 统一拥有 Assistant、Knowledge、附件、
  Runtime binding/ledger 等业务 SQLite；Main 通过类型化异步操作访问。
  保留数据库路径、表、ID、事务、提交顺序和远程 Agent 数据库。
- storage utility 使用现有读取 Worker 和受界定 IPC，覆盖 readiness、取消、
  容量、进程退出、关闭排空和错误传播；移除生产 Main 业务 SQLite owner。
- schema 仍为 62，无数据迁移；升级前仍备份完整数据目录、notes 和设置。
- 直连模型工具失败后可继续下一轮，分页输出保持有界；Magic Notes 标签、
 监督来源别名、设置直达预加载、文件元数据和 Composer 过渡同步修复。
- Agent 生产 Runtime/模型桥有变化，需 0.15.6；runtime/acp 6、wire 2.0、
  Node/Electron/OpenCode/Continue 锁不变。

## 验证边界

storage foundation focused 结果：utility process 真实 Electron 编排、监督
heartbeat/回顾叶子/导航、异步 Worker、存储帧高水位约 248,332 bytes Main、
252,578 bytes storage；focused 70 项跨 11 suites 通过，Node/Agent/Renderer
typecheck 和 scoped lint 通过。工具失败继续、分页输出、Magic Notes 和监督
别名另有定向回归。

并发验收文档明确的 C01–C07 和 A01–A10 完整矩阵、跨平台 storage process
安装、低端机对照及完整 UI→Preload→Main→storage→SQLite 验收仍不是这份文档
中的已完成事实。不得把 focused 结果或架构文档目标写成全部 PERF-15/PERF-16
已验收。Agent 远程路径需在当前源码 CI/Host 规则下重新验证。

## 发布门槛

按用户约定不运行本地测试套件、typecheck、lint、生产构建或安装包探针；
先校验发布元数据，推送双远端，要求精确候选 main CI 和生产构建通过后再创建
Desktop/Agent 不可变标签。通过后核验六平台 20 项 Desktop 资产、macOS 签名公证、
Agent 三平台目录、OSS/GitHub 元数据和网站 12 种标准下载选择。
