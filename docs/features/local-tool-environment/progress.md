# 工具执行环境功能进度

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档类型 | 功能进度 |
| 状态 | 已实施，跨平台验收中 |
| 版本 | 0.3 |
| 日期 | 2026-09-02 |
| 关联入口 | [工具执行环境](./README.md) |

## 当前结论

本机工具执行环境的生产链路已经进入源码。“能力与工具”现在显示 `Skills`、`MCP`、
`工具执行环境` 三个真实 Tab；Main 统一解析托管或自定义 Node/Python，并把不可变 PATH
快照应用到新启动的本机 Runtime 与 stdio MCP。Windows x64 已完成真实托管 Node 和原生
地址托管 Python 安装验证。

该实现尚不能视为六平台发布验收完成：六个 OSS 镜像对象已发布并公开回读验证，但
Windows ARM64、macOS 和 Linux 工件仍需原生 CI 验证，第三方许可证资源也尚未随包落地。

## 已完成

### 设置、迁移和界面

- [x] Shared 严格设置、候选、诊断、进度、IPC 和 Preload 契约。
- [x] Application Settings v10；全新用户默认托管环境和原生地址。
- [x] v1-v9 分别执行真实 Node/Python 3 探测的一次性迁移；无有效候选时选择托管环境。
- [x] 用户/系统 PATH、活动 venv/Conda、`CONDA_ENVS_PATH`、Conda/pyenv/nvm 和常见安装
  位置，以及已保存自定义路径候选的规范化、去重、版本及架构诊断。
- [x] 自定义解释器保存前真实验证；无效新选择不持久化，已保存失效路径不回退。
- [x] “自定义环境”始终可进入；不隐式采用首个候选，取消文件选择不改设置，验证错误在
  对应工具卡内显示。
- [x] “能力与工具”统一入口及三个水平 Tab，MCP 原内层页签保持不变。
- [x] 工具下载源、Node.js、Python、候选、诊断、安装进度、取消和删除界面。
- [x] 使用 `PageTabs`、应用通知、就地操作错误、删除确认和具名进度条。

### 托管 Node 与进程注入

- [x] 使用 Electron-as-Node 提供 `node`，使用同一 Node 和打包 CLI 提供 `npm`、`npx`。
- [x] 自定义 Node 只使用同安装位置且验证成功的 npm/npx，不与托管 CLI 混用。
- [x] 每次配置生成不可变 shim 目录；已有进程继续持有原 PATH，新进程读取新快照。
- [x] OpenCode、Continue、DeepSeek Harness 和本机通用/精选 stdio MCP 接收工具 PATH。
- [x] 工具 PATH 不修改 `process.env`，不进入普通终端或远程 Host。
- [x] 解释器探针使用过滤后的环境，不接收模型凭据、GoodBuddy 或 Factory 内部变量。

### 托管 Python

- [x] 锁定 CPython 3.13.15 的 Windows/macOS/Linux x64/ARM64 六平台目录、大小和 SHA-256。
- [x] 用户选择的原生地址或 OSS 镜像在任务开始时冻结，同一次任务不回退。
- [x] HTTPS、重定向 Host、大小、SHA-256、取消和部分文件清理。
- [x] NuGet ZIP 与 Astral TAR 的 payload 限定、路径穿越防护、展开上限和安全链接处理。
- [x] GoodBuddy-owned 暂存安装、发布、失败清理、更新保留和删除。
- [x] `python`、`python3`、`pip` 同源，`pip` 固定使用所选 Python 的 `-m pip`。
- [x] 发布前真实验证 Python 3.13.15、架构、标准库、SSL、pip，并创建和执行临时 venv。
- [x] 取消恢复原状态且不显示为安装失败；退出时取消并等待安装清理。

## 待完成验收

- [x] 发布六个平台/架构的字节完全相同 OSS 镜像对象并公开回读校验。
- [ ] 将 CPython、PSF 和 python-build-standalone 适用许可证资源纳入发行包及构建校验。
- [ ] Windows ARM64、macOS x64/ARM64、Linux x64/ARM64 原生 CI 安装、SSL、pip、venv 探针。
- [ ] 最低 Windows/macOS/glibc 支持矩阵和 Windows NuGet 签名核验。
- [ ] 真实 JavaScript/Python SKILL 成果及 Node/Python stdio MCP 调用。
- [ ] 自定义 Node/Python 在产品 UI 中的真实选择和任务执行。
- [ ] 更新或删除托管 Python 时，使用现有本机 Runtime/MCP 生命周期协调受影响进程。

## 当前阻塞项

- 当前机器只能原生验证 Windows x64。其余五个平台必须由对应原生 CI 执行，不能用本机
  mock 代替。
- 许可证文件和来源清单尚未进入 `resources/tool-environment`，发行合规验收未完成。

## 已验证证据

### 2026-09-02 完整实现

- `npm run typecheck` 通过。
- `npm run lint` 通过。
- `npm run build` 通过，Main、Preload 和 Renderer 生产 bundle 成功。
- 工具环境聚焦测试通过：契约、设置迁移、解析/shim、服务、下载、解压、安装、IPC、
  Preload、Runtime/MCP 注入、Renderer 和发行资源校验。
- Windows x64 真实托管 Node：Electron Node `24.18.0`、npm `11.19.0`、npx `11.19.0`。
- `GOODBUDDY_RUN_LIVE_TOOL_ENVIRONMENT=1` 真实下载官方 NuGet、校验摘要、解压、安装并
  验证 CPython `3.13.15`、SSL、pip 和 venv，`1/1` 通过；临时安装已清理。
- 隔离 Electron 生产 bundle 自动化确认三个 Tab 均可见；“诊断全部”显示托管 Node
  `24.18.0`、npm/npx `11.19.0`。隔离进程和用户数据已清理。
- 第一次全量测试发现 3 个确定性夹具/兼容失败，修复后聚焦复跑 `25/25` 通过。第二次暴露
  2 个 `App.test.tsx` 设置导航时序问题，修正为按可访问名称点击并等待设置中心。
- 最终 `npm test` 通过：`3465` 通过、`51` 跳过；完整 `App.test.tsx` 为 `157/157` 通过。
- 使用本机受控 Aliyun 凭据将六个已验证上游工件原样上传到
  `goodbuddy/tool-artifacts/python/3.13.15/<sha256>/<filename>`，总计 `142,251,693`
  字节。随后从目录中的六个公开 OSS URL 全量下载，逐个验证字节数和 SHA-256，全部一致。
- 修复无候选时禁用“自定义环境”的死路交互，并扩展 venv/Conda/常见安装位置探测；
  聚焦 Main/Renderer/Settings 测试 `95/95` 通过，最终 `npm test` 为 `3477` 通过、
  `51` 跳过，类型检查、功能文件定向 Lint 和生产构建通过。仓库全量 Lint 当前被并行
  `App.tsx` 的两个 React Compiler memoization 错误阻塞，与工具执行环境文件无关。
- 隔离 Electron 实机确认“自定义环境”始终可进入，展开和刷新不会保存来源；在 64 项以上
  PATH 的机器上优先发现活动 `<user>\miniconda3\python.exe`，真实诊断为
  Python `3.13.13 · amd64`，刷新后持久设置仍为 `managed`。

### 2026-09-02 菜单阶段

- 完成“能力与工具”一级菜单及 Skills/MCP Tab，并修复可滚动 Flex 布局将页签压缩为零
  高度的问题；加入 `flex: 0 0 auto` 回归约束。

## 进度维护要求

- 只有真实源码和生产路径完成后才能勾选对应实施项。
- 测试失败时保留未完成状态并记录失败原因。
- 每次更新记录日期、实际命令、结果和外部阻塞。
- 不在本文件复制未来设计，需求变化回写 PRD/UI/技术设计。
