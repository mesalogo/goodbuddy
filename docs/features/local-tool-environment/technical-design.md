# 本机工具环境技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 计划 |
| 版本 | 0.1 |
| 日期 | 2026-09-01 |
| 关联 PRD | [本机工具环境 PRD](./prd.md) |
| 功能逻辑 | [本机工具环境功能逻辑设计](./logic-design.md) |
| 相关架构 | [DeepSeek Harness Runtime 设计](../deepseek-harness/technical-design.md)、[SSH 远程主机与 GoodBuddy Agent 实现说明](../remote-host/technical-design.md) |

## 1. 当前基线

GoodBuddy 已具备：

- Electron 内置 Node Runtime。
- 安装包中的锁定 npm CLI。
- DSH 插件安装器使用的 `process.execPath + ELECTRON_RUN_AS_NODE=1` shim。
- OpenCode、Continue、DeepSeek Harness 的独立本机进程环境入口。
- SKILL 按 Runtime 目标分配和暂存。
- Main 和 Runtime 的 stdio MCP 启动链路。
- Runtime 可执行文件探测、版本读取和自定义路径模式。
- 下载、摘要校验、进度、取消和暂存清理模式。

当前缺少统一工具来源设置、通用 PATH 注入和托管 Python。

## 2. 设置契约

```ts
type LocalToolEnvironmentSelection =
  | { source: 'managed' }
  | { source: 'custom'; executablePath: string }

type LocalToolEnvironmentSettings = {
  node: LocalToolEnvironmentSelection
  python: LocalToolEnvironmentSelection
}
```

只持久化用户意图。不持久化候选列表、版本、PATH、shim 路径、诊断结果或可重新读取的托管
包元数据。

### 2.1 兼容迁移

- 全新用户默认 `managed`。
- 旧设置没有该字段时，Main 按升级前 PATH 分别解析有效 Node 和 Python 3。
- 有效候选写成 `custom + 规范化绝对路径`。
- 没有有效候选时写成 `managed`。
- 迁移只执行一次，后续 PATH 变化不改变选择。

## 3. Main 服务

新增一个 `LocalToolEnvironmentService`，负责：

- 设置读取和保存。
- Node/Python 候选探测。
- 自定义解释器诊断。
- 当前工具组合解析。
- 受管工具 bin 创建。
- 托管 Python 安装、更新、删除。
- 有界状态和进度发布。
- 应用退出时取消安装并清理本次暂存。

不为每项职责增加持久 Manager、注册表或恢复状态机。失败安装删除暂存，下次重新执行。

## 4. 解析结果

```ts
type ResolvedLocalToolEnvironment = {
  binDirectory: string
  node?: {
    executablePath: string
    npmCliPath?: string
    npxCliPath?: string
  }
  python?: {
    executablePath: string
  }
}
```

工具 bin：

| 平台 | 命令 |
| --- | --- |
| Windows | `node.cmd`、`npm.cmd`、`npx.cmd`、`python.cmd`、`python3.cmd`、`pip.cmd` |
| macOS/Linux | `node`、`npm`、`npx`、`python`、`python3`、`pip` |

shim 使用绝对路径。`pip` 固定调用 `<python> -m pip`，避免解释器错配。

## 5. Node.js 托管环境

托管 Node shim：

```text
ELECTRON_RUN_AS_NODE=1 <process.execPath> <arguments...>
```

约束：

- 复用 DSH 已有的平台转义实现。
- `ELECTRON_RUN_AS_NODE` 不写入 Main 全局环境。
- npm/npx 使用安装包中同一锁定 npm 发行版的 CLI。
- npm 子进程范围设置 `npm_execpath` 和 `npm_node_execpath`。
- 自定义 Node 只使用与其配套且验证成功的 npm/npx，不混入 GoodBuddy npm。
- 普通 JavaScript 和 Node 内置模块属于支持路径。
- 普通 Node 原生扩展可能受 Electron ABI 影响，不承诺兼容。

## 6. Python 托管环境

### 6.1 包

- 使用包含 pip、venv、SSL 和标准库的固定 CPython 独立发行包。
- 每个平台/架构锁定一个版本。
- 目录包含版本、平台、架构、来源、字节数、SHA-256 和许可证。
- 下载复用当前官方 GitHub/镜像来源，不增加来源设置。
- 安装包不无条件携带完整 Python。

具体发行包和版本必须在实现前完成六平台工件、许可证、维护状态和 pip/venv 可用性核验。

### 6.2 安装

```text
读取固定目录
→ 下载到 GoodBuddy-owned 暂存
→ 校验大小和 SHA-256
→ 解压到新版本目录
→ 运行完整环境诊断
→ 发布为当前托管 Python
→ 删除暂存
```

失败保留已验证旧安装。删除只作用于 GoodBuddy-owned Python 目录。

### 6.3 包依赖

首期提供解释器和 pip，不自动扫描或安装任意 `requirements.txt`。第三方包由 SKILL/MCP
安装流程或用户明确命令准备。出现可复现的包冲突后，再评估能力级虚拟环境。

## 7. 自定义环境探测

### 7.1 Node

候选来源：

- 筛选后的 PATH。
- Windows/macOS/Linux 常见安装目录。
- 已保存路径。

每个候选运行分离参数的 `--version`，确认普通文件、可执行、成功退出和可解析版本，并按
真实路径去重。

### 7.2 Python

- Windows 探测 `python.exe`。
- macOS/Linux 优先 `python3`，其次为明确的 Python 3 `python`。
- 拒绝未安装的 Windows Store App Execution Alias。
- 诊断 Python 3、版本、架构和解释器绝对路径。

单候选和总探测具有超时、输出上限、取消和进程树清理。

## 8. 完整诊断

### 8.1 Node

- `node --version`
- 加载标准库
- 启动最小子进程
- `npm --version`
- `npx --version`
- npm/npx 实际 Node 来源一致

### 8.2 Python

- Python 3、版本和架构
- 标准库导入
- SSL/证书模块
- `python -m pip --version`
- 在临时目录创建最小 venv

诊断不联网，使用 GoodBuddy-owned 临时目录并清理。

## 9. 环境注入

新启动的以下本机进程将工具 bin 放到现有筛选 PATH 前面：

- OpenCode Server。
- Continue Utility Process。
- DeepSeek Harness Utility Process。
- Main 启动的 stdio MCP。
- Runtime 启动的 stdio MCP。

不注入 Main 全局环境、Renderer、普通终端、SSH 请求、Agent 或远程 Runtime。

设置变化后，有活动请求的 Runtime 保持启动时快照；空闲 Runtime 在下次使用前使用既有
重建入口。已运行 MCP 在正常关闭、重连或显式测试后使用新环境，不增加热切换协议。

## 10. SKILL 与 MCP

SKILL 稳定调用命令名，不接收真实安装路径。

stdio MCP：

- 裸 `node`、`npm`、`npx`、`python`、`python3`、`pip` 使用工具 bin。
- `env node`/`env python3` 脚本通过 PATH 使用同一来源。
- 绝对 command 保持原样。
- HTTP/SSE 不受影响。
- 工具环境不自动安装 MCP 第三方依赖。

## 11. Renderer 状态与 IPC

Renderer 接收：

- 当前选择。
- 当前实际来源、版本、路径。
- 有界候选列表。
- 托管安装状态、版本、占用空间。
- 工具诊断分项结果。
- 安装进度和脱敏错误。

Renderer 不能提交 PATH、环境变量、下载 URL、摘要、安装目录、shim 内容或任意命令参数。
所有 IPC 输入使用共享 Zod schema，Main 重新验证路径和解释器。

## 12. 权限与远程边界

- Ask/Execute 语义不变。
- 不新增解释器批准流程。
- 不上传 shim、Python、pip 包或自定义路径。
- 不修改 Host PATH。
- 不把本机 SKILL 或 stdio MCP 传给远程 ACP Session。
- 远程 Agent 固定 Node 继续只服务 Agent、模型桥和签名 Runtime。

## 13. 实施顺序

### 阶段 1：契约、迁移、探测和 UI

- Shared schema、设置迁移、IPC。
- Node/Python 候选探测和完整诊断。
- 设置卡片和状态。

### 阶段 2：托管 Node 与执行链路

- 提取 DSH shim。
- 增加 node/npm/npx。
- 注入本机 Runtime 和 stdio MCP。

### 阶段 3：托管 Python

- 锁定六平台工件。
- 下载、校验、安装、更新、取消、删除。
- 增加 python/python3/pip。

### 阶段 4：真实端到端验收

- Node SKILL 与 MCP。
- Python SKILL 与 MCP。
- 自定义解释器。
- Ask/Execute、重建、取消和退出。
- 六平台打包和许可证。

这些阶段是开发顺序，不是可长期发布的残缺功能。合并能力前完成普通用户和专业用户的完整
生产路径。

## 14. 验证

单元测试覆盖设置迁移、探测、版本解析、shim 转义、PATH 顺序、失效路径、下载摘要和暂存
清理。

集成测试覆盖安装包 Electron Node、npm/npx、托管 Python、三个本机 Runtime 和两类 stdio
MCP 的实际进程路径。

项目验证：

```text
npm test
npm run typecheck
npm run lint
npm run build
```

生产资源通过六平台原生 CI 打包验证。若后续改动触及 Agent、远程协议或远程 Runtime，
再按远程架构文档执行共享 Linux x64 Host 验证。
