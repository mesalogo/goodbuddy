# GoodBuddy 本机工具环境设计与实施计划

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档类型 | 跨功能技术与产品架构 |
| 状态 | 计划 |
| 版本 | 0.1 |
| 日期 | 2026-08-31 |
| 适用产品 | GoodBuddy 桌面端 |
| 目标平台 | Windows、macOS、Linux，x64 与 arm64 |
| 相关基线 | [DeepSeek Harness Runtime 设计](./deepseek-harness-runtime-design.md)、[SSH 远程主机与 GoodBuddy Agent 实现说明](./remote-host-and-goodbuddy-agent-design.md)、[统一界面设计系统](../../UI-DESIGN.md) |

本文定义 GoodBuddy 为本机 SKILL 脚本和本机 stdio MCP Server 提供 Node.js、Python
解释器的产品形态、设置模型、进程环境、安装生命周期和实施顺序。目标是让普通用户无需
预装开发环境即可使用依赖脚本的能力，同时让专业用户能够明确选择自己维护的解释器。

本文中的“本机工具环境”不等于 Agent Runtime，也不等于 SSH Host 上由 GoodBuddy Agent
管理的远程环境。

---

## 1. 摘要与核心决策

1. 本机工具环境首期只管理 `Node.js` 和 `Python`。
2. 每种工具只有两种互斥来源：
   - **GoodBuddy 托管**：由 GoodBuddy 提供、验证和解析。
   - **自定义环境**：用户从检测结果中选择，或指定其他可执行文件。
3. 不提供独立的“自动选择”。它会隐藏实际版本，并可能在系统环境变化后静默改变执行结果。
4. 不区分“系统安装”和“指定路径”。二者最终都是由用户明确选择的外部可执行文件，只是
   发现方式不同。
5. Node.js 托管环境复用 Electron 内置 Node，通过受管 `node` shim 设置
   `ELECTRON_RUN_AS_NODE=1`，不额外打包一份 Node。
6. Python 托管环境不无条件进入桌面安装包。用户首次需要时，GoodBuddy 按平台和架构下载、
   校验并安装一份固定 Python 发行包。
7. `npm` 跟随 Node.js 来源，`pip` 跟随 Python 来源，不作为独立设置项。
8. 首期不实现每个 SKILL、项目或 Runtime 单独覆盖解释器，也不实现通用 Node/Python
   版本管理器。
9. 环境只注入本机 Runtime 和本机 stdio MCP 启动链路，不修改系统 PATH，不写 Shell
   Profile，不同步到远程主机。
10. Ask/Execute 的现有权限语义保持不变。提供解释器不代表 Ask 获得脚本执行权限。
11. 全新安装默认使用托管来源；升级用户当前可用的系统解释器会在一次性迁移中固化为
    自定义绝对路径，避免升级后改变既有脚本运行环境。
12. 本机 stdio MCP 与 SKILL 使用同一套 Node.js/Python 选择。依赖 Python 或 Node.js
    启动的 MCP 不再要求用户另外配置一套解释器。

---

## 2. 当前实现基线

GoodBuddy 当前已经具备：

- 桌面安装包内的 Electron Node Runtime。
- 随安装包交付的锁定 npm CLI。
- DeepSeek Harness 插件安装器使用的受管 `node.cmd`/`node` shim，可复用
  `process.execPath + ELECTRON_RUN_AS_NODE=1`。
- OpenCode、Continue 和 DeepSeek Harness 的独立本机进程环境构建入口。
- SKILL 按 Runtime 目标分配和暂存的生产链路。
- stdio MCP 的 Main 进程启动链路。
- OpenCode 和 Continue 可执行文件的路径探测、版本读取和自定义路径设置模式。
- 模型及远程 Runtime 包的下载、校验、进度、取消和清理模式。

当前缺口：

- 安装包没有向 SKILL 或通用 stdio MCP 暴露可直接调用的 `node` 命令。
- 本机 Runtime 只继承经过筛选的系统 PATH；没有把 GoodBuddy 工具目录加入 PATH。
- Python 完全依赖用户自行安装。
- 设置页没有统一展示 Node.js、Python 的实际来源、版本、路径和可用状态。
- 用户配置 `node server.js` 或 `python script.py` 时，成功与否取决于 GoodBuddy 启动时
  继承到的系统环境。

---

## 3. 范围

### 3.1 首期范围

- 本机 OpenCode、Continue、DeepSeek Harness 加载的 SKILL 脚本。
- 由 GoodBuddy Main 启动的本机 stdio MCP Server。
- Node.js 和 npm。
- Python 3、pip 和标准 `venv` 能力。
- 托管环境安装、删除、状态检查和真实解释器诊断。
- 系统解释器探测、自定义文件选择和明确版本验证。
- Windows、macOS、Linux 的 x64 与 arm64。

### 3.2 明确不作用的范围

- SSH Host 上的 GoodBuddy Agent、固定 Node 和签名 OpenCode Runtime。
- 远程项目的 PATH、Shell Profile、Python、Node 或系统包。
- HTTP/SSE MCP Server 的服务端运行环境。
- Renderer 进程和网页内容。
- GoodBuddy 自身构建环境。

### 3.3 非目标

首期不包含：

- 通用 `nvm`、`pyenv`、Conda、Poetry、uv 或操作系统包管理器替代品。
- 任意 Node.js/Python 版本的目录、升级矩阵或自动切换。
- 每个 SKILL 自动创建和维护独立虚拟环境。
- 自动读取并执行任意 SKILL 的安装脚本。
- 自动解析或合并多个 SKILL 的 `requirements.txt`、`package.json`。
- 修改用户的系统 PATH、注册表、Shell Profile 或全局 npm/pip 配置。
- 把 Python 无条件打入所有桌面安装包。
- 把本机工具环境上传、复制或映射到 SSH Host。
- 对用户自定义解释器进行安装、升级、修复或卸载。

---

## 4. 用户体验

### 4.1 设置位置

在 `Agent Runtime` 设置中增加“本机工具环境”区块。该区块位于默认工作区之后、
具体 Runtime 高级设置之前，避免让用户误以为它只属于某一个 Runtime。

区块顶部持续显示范围说明：

> 用于本机 SKILL 脚本和本机 stdio MCP；不会修改系统环境，也不会应用于远程主机。

设置使用普通卡片和原生单选语义。选项只有两项，不增加三级页签或页面专属切换控件。

### 4.2 Node.js 卡片

```text
Node.js

● GoodBuddy 托管（推荐）
  Node.js vXX · 已就绪

○ 自定义环境
  [Node.js v22.x · C:\Program Files\nodejs\node.exe ▼]
  [选择其他可执行文件]
```

托管 Node 随应用可用，不显示安装按钮。版本来自一次真实
`node --version` 诊断，而不是仅根据 Electron 包版本推断。

### 4.3 Python 卡片

未安装托管 Python 时：

```text
Python

● GoodBuddy 托管（推荐）
  尚未安装
  [安装]

○ 自定义环境
  [Python 3.13.x · C:\Python313\python.exe ▼]
  [选择其他可执行文件]
```

安装后显示版本、架构、占用空间和“删除”操作。删除前只需要说明依赖托管 Python 的本机
SKILL 和 MCP 将暂时不可用；不引入额外确认文字输入。

### 4.4 自定义环境

- 下拉列表展示本次检测到且验证成功的候选项。
- 每项必须同时展示版本和规范化绝对路径。
- “选择其他可执行文件”使用 Main 管理的文件选择器。
- 保存前执行真实 `--version` 诊断。
- 已保存路径失效时保持该选择并显示“路径不可用”，不静默切回托管环境或其他候选。
- 用户可以显式改回 GoodBuddy 托管。

### 4.5 反馈

- 安装、删除和重新检测的瞬时成功信息使用应用通知。
- 当前来源、版本、路径、下载进度和阻塞错误保留在卡片内。
- 下载失败保留当前选择和已验证旧安装。
- 字段或路径错误就地展示，不与通知重复。

---

## 5. 设置与状态模型

### 5.1 持久设置

每种工具只保存用户意图：

```ts
type LocalToolEnvironmentSelection =
  | { source: 'managed' }
  | { source: 'custom'; executablePath: string }

type LocalToolEnvironmentSettings = {
  node: LocalToolEnvironmentSelection
  python: LocalToolEnvironmentSelection
}
```

不持久化以下可重新推导的信息：

- 检测候选列表。
- 当前版本。
- PATH。
- shim 路径。
- 诊断结果。
- 托管包的重复元数据副本。

托管 Python 的固定包清单属于随应用交付或从受信目录读取的产品元数据，不进入用户设置。

### 5.2 兼容迁移

- 全新用户的 Node.js、Python 默认来源均为 `managed`。
- 已发布版本升级且设置中没有本机工具环境字段时，Main 分别按升级前实际使用的 PATH
  解析 `node` 和 Python 3。
- 找到并通过真实版本诊断后，迁移写入
  `{ source: 'custom', executablePath: '<规范化绝对路径>' }`。
- 未找到有效解释器时，该工具迁移为 `{ source: 'managed' }`。
- 迁移只执行一次并持久化明确结果。后续 PATH 变化不会自动改变选择。
- 迁移不复制、修改或删除系统解释器及其已安装包。

这样保留现有用户脚本的解释器来源，同时不向产品增加长期存在的“自动选择”模式。

### 5.3 Renderer 状态

Renderer 只接收有界公开状态：

```ts
type LocalToolEnvironmentStatus = {
  tool: 'node' | 'python'
  selection: LocalToolEnvironmentSelection
  active?: {
    source: 'managed' | 'custom'
    executablePath: string
    version: string
  }
  candidates: Array<{
    executablePath: string
    version: string
  }>
  managed: {
    state: 'ready' | 'not-installed' | 'installing' | 'error'
    version?: string
    installedBytes?: number
  }
  error?: string
}
```

Renderer 不能提交下载 URL、摘要、解压目录、命令参数或任意环境变量。

---

## 6. Main 进程架构

### 6.1 `LocalToolEnvironmentService`

Main 新增单一服务负责：

- 读取和保存工具来源设置。
- 探测系统候选。
- 验证自定义解释器。
- 解析当前有效解释器。
- 准备受管 shim 目录。
- 安装和删除托管 Python。
- 发布有界进度和状态。
- 应用退出时取消自身安装任务并清理本次暂存。

保持一个服务即可，不为 Node、Python、下载、shim 和探测分别建立持久 Manager 层。

### 6.2 解析结果

Runtime 和 MCP 不读取设置文件，而是请求一次解析结果：

```ts
type ResolvedLocalToolEnvironment = {
  binDirectory: string
  nodeExecutable?: string
  pythonExecutable?: string
}
```

`binDirectory` 包含受管命令入口：

- Windows：`node.cmd`、`npm.cmd`、`python.cmd`、`python3.cmd`、`pip.cmd`。
- macOS/Linux：`node`、`npm`、`python`、`python3`、`pip`。

只有当前选择且验证成功的工具才生成入口。入口使用绝对路径，不依赖递归 PATH 查找。

### 6.3 环境注入

本机 Runtime 启动时把 `binDirectory` 放在其现有 PATH 前面：

```text
<GoodBuddy tool bin><delimiter><existing filtered PATH>
```

注入点包括：

- 内置 OpenCode Server 进程。
- Continue Utility Process。
- DeepSeek Harness Utility Process。
- Main 启动的 stdio MCP Server。

不注入：

- GoodBuddy Main 自身的 `process.env`。
- Renderer。
- SSH/Agent/远程 Runtime 请求。
- 用户打开的普通系统终端。

首期不修改助手工作栏终端的环境，避免与用户 Shell Profile 和系统命令预期发生隐式冲突。
如果未来提供“使用 GoodBuddy 工具环境的新终端”，必须作为用户显式选择的新终端类型设计。

### 6.4 运行时刷新

工具环境设置保存、托管 Python 安装或删除后：

- 新启动的 Runtime 和 MCP 使用新环境。
- 已运行进程不在中途替换 PATH。
- 需要重建的当前 Runtime 使用现有 Runtime 重建入口完成。
- 已运行的 stdio MCP 在下一次正常重连或显式测试时使用新环境；首期不增加独立热切换协议。

界面应准确说明“新启动的本机 Runtime 和 MCP 将使用此环境”。

---

## 7. Node.js 托管环境

### 7.1 执行方式

托管 `node` shim 固定调用当前 `process.execPath`：

```text
ELECTRON_RUN_AS_NODE=1 <GoodBuddy executable> <arguments...>
```

实现复用 DeepSeek Harness npm 安装器已经验证的转义和平台脚本模式，不复制另一套命令
拼接规则。

### 7.2 npm

- 托管 Node 使用安装包内锁定的 npm CLI。
- `npm` shim 调用托管 Node，并把 npm CLI 绝对路径作为第一个参数。
- `npm_node_execpath`、`npm_execpath` 只在 npm 子进程范围设置。
- 自定义 Node 优先使用同一目录或系统 PATH 中与其配套的 npm；找不到 npm 时 Node 仍可用，
  卡片显示“npm 不可用”。
- 首期不混用“自定义 Node + GoodBuddy npm”，避免产生难以解释的版本组合。

### 7.3 约束

- `ELECTRON_RUN_AS_NODE` 不写入 Main 全局环境。
- shim 不放入系统 PATH。
- Electron 升级后版本变化必须在设置状态中可见。
- 普通 JavaScript 和 Node 内置模块属于支持路径。
- 原生 `.node` 扩展可能受 Electron ABI 影响，界面帮助文案应明确不保证普通 Node 原生
  扩展兼容；N-API 兼容性仍以模块自身声明和真实加载为准。

---

## 8. Python 托管环境

### 8.1 包形态

- 使用可再分发、包含 `pip` 和 `venv` 的固定 CPython 独立发行包。
- 每个平台和架构只有一个 GoodBuddy 支持版本。
- 包目录包含版本、平台、架构、URL、字节数、SHA-256 和许可证信息。
- 下载源复用“关于与更新”中用户选择的官方 GitHub/镜像来源，不另建一套来源设置。
- 具体版本在实施时按六平台可用性和许可证复核后锁定，不在用户设置中自由选择。
- Python 标准库和许可证与托管包一起安装。

### 8.2 安装

```text
用户点击安装
→ Main 读取当前固定包元数据
→ 下载到 GoodBuddy 用户数据暂存目录
→ 校验大小和 SHA-256
→ 解压到新的版本目录
→ 运行 python --version 和最小标准库诊断
→ 发布为当前托管 Python
→ 删除本次暂存
```

失败时删除本次暂存并保留已验证旧安装。首期不建立快照、安装日志恢复器或多版本注册表；
下次安装从头重试即可。

### 8.3 Python 包

- 托管 Python 提供正常的 `python -m pip`。
- SKILL 仍显式声明和执行自身需要的依赖安装命令。
- 首期不自动扫描或安装 `requirements.txt`。
- 首期共用一个当前用户的托管 Python 包环境；若出现可复现的依赖冲突，再单独设计按
  SKILL 隔离，不预先建设虚拟环境编排系统。
- 专业用户需要 Conda、uv、Poetry 或项目虚拟环境时，应选择对应环境中的 Python
  可执行文件作为“自定义环境”。

### 8.4 删除与升级

- 删除只影响 GoodBuddy-owned Python 目录。
- 不删除用户工作区、系统 Python 或自定义环境。
- 正在被 GoodBuddy 子进程使用时，先通过现有 Runtime/MCP 生命周期停止相关进程，再删除。
- Python 版本随 GoodBuddy 发布清单更新，但不后台自动升级。用户在设置页看到“可更新”后
  显式执行更新。

---

## 9. 自定义环境探测

### 9.1 Node.js

候选来源：

- 当前筛选后 PATH 中的 `node`/`node.exe`。
- Windows 常见 Node 安装目录和当前用户 npm 目录关联的 Node。
- macOS/Linux 常见系统安装位置。
- 已保存的自定义路径。

每个候选使用分离参数执行 `--version`，要求普通文件、目标平台可执行、成功退出且版本输出
可解析。候选按规范化真实路径去重。

### 9.2 Python

候选来源：

- Windows 的 `python.exe`。
- macOS/Linux 的 `python3`，其次是明确指向 Python 3 的 `python`。
- 常见系统和当前用户安装目录。
- 已保存的自定义路径。

验证命令必须同时确认 Python 3、平台架构和解释器绝对路径。Windows Store 的未安装
App Execution Alias 不能作为成功候选。

### 9.3 探测行为

- 打开设置页时读取最近状态，不阻塞整个设置中心。
- 用户点击“重新检测”时重新扫描。
- 探测不安装软件、不执行包管理器、不修改文件。
- 单候选和总探测均使用有界超时、输出上限和进程树清理。
- 路径或版本诊断失败只影响该候选。

---

## 10. SKILL 与 MCP 接入

### 10.1 SKILL

GoodBuddy 继续按当前方式把 SKILL 包暂存到目标 Runtime。工具环境只改变本机 Runtime
子进程看到的 PATH，因此 SKILL 可以使用稳定命令：

```text
node "<skill-dir>/scripts/example.js"
python "<skill-dir>/scripts/example.py"
python -m pip install -r "<skill-dir>/requirements.txt"
```

SKILL 不接收解释器真实安装目录，也不把路径写入自身内容。未准备的解释器被调用时，命令
明确失败，Runtime 应把原始“环境未就绪”上下文返回给用户。

### 10.2 stdio MCP

- `command: node`、`command: python` 和对应脚本参数通过同一个工具 bin 解析。
- `command: python3`、`command: npm`、`command: pip` 同样解析到当前明确选择的工具来源。
- 以 `#!/usr/bin/env python3` 或 `#!/usr/bin/env node` 启动且由 Runtime Shell 解析的
  MCP 脚本，也会从注入的工具 bin 找到当前解释器。
- 例如 `python -m my_mcp_server`、`node server.js` 这类本机 MCP 启动命令，无论由 Main
  直连模型工具链还是本机 OpenCode、Continue、DeepSeek Harness 发起，都使用相同来源。
- 绝对命令路径继续按用户配置执行，不被工具环境替换。
- HTTP/SSE MCP 不受影响。
- 自定义 MCP 凭据和工具环境状态保持分离。
- MCP 进程继续受现有取消、超时、关闭和输出上限控制。
- 工具环境只提供解释器和配套 npm/pip，不自动安装 MCP 自身的 Python/Node 依赖；这些
  依赖仍由 MCP 的安装流程或用户明确执行的安装命令准备。

### 10.3 Ask/Execute

- Ask 的 Runtime 只读边界保持不变。
- 提供 Node/Python 不会给直连模型新增 Execute 工具。
- OpenCode、Continue、DeepSeek Harness 仍按各自 Ask 权限边界决定是否允许命令工具。
- Execute 继续表示用户对所选本机账号可用工具和路径的完整授权。
- stdio MCP 的启动行为沿用当前能力开关和分配规则，不新增第二套批准流程。

---

## 11. 远程主机边界

本机工具环境与远程托管环境严格分离：

- 不上传 shim、Python 包、pip 包或自定义解释器路径。
- 不修改 SSH Host PATH。
- 不把本机 SKILL 包同步到远程 OpenCode。
- 不把本机 stdio MCP Server 配置传给远程 ACP Session。
- 远程 Agent 的固定 Node 继续只服务 Agent、模型桥和签名 Runtime。
- 远程项目只能使用远端签名 Runtime 自身具备的能力和 SSH 账号已有系统环境。

远程主机设置页必须持续显示：

> 本机配置的 Skills 和 MCP 不会应用于远程主机。

---

## 12. IPC 与安全边界

- 所有设置和操作输入使用共享 Zod schema。
- Renderer 只提交工具类型、来源、已选择候选路径或文件选择动作。
- 自定义路径由 Main 重新规范化、检查和执行真实版本诊断。
- Renderer 不能提交 PATH、环境变量、下载 URL、安装目录或 shim 内容。
- Main 只在明确的本机 Runtime/MCP 子进程环境中注入工具 bin。
- API Key 和 MCP 凭据不进入解释器检测命令、安装日志或状态快照。
- 下载、解压、诊断和删除都限制在 GoodBuddy-owned 目录。
- 不删除或覆盖用户自定义解释器及其包。
- 继续保持 Context Isolation、Sandbox 和 Renderer 无 Node Integration。

---

## 13. 实施顺序

以下阶段是开发顺序，不是可以长期停留的残缺产品状态。合并该能力前应完成普通用户使用
托管 Node/Python 和专业用户使用自定义解释器的完整本机生产路径。

### 阶段 1：共享契约、设置与诊断

- 增加本机工具环境设置 schema、迁移默认值和 IPC 契约。
- 全新用户默认 Node.js、Python 均选择 `managed`。
- 升级用户把当前有效的系统解释器一次性固化为自定义绝对路径。
- 实现 Node/Python 候选探测和真实版本诊断。
- 增加设置页卡片、范围说明、来源选择、路径选择和状态展示。
- 保持旧用户现有 Runtime 设置不变。

### 阶段 2：托管 Node 与本机执行链路

- 提取并复用当前 DSH `node` shim 逻辑。
- 生成当前会话受管 tool bin。
- 为 OpenCode、Continue、DeepSeek Harness 注入工具 bin。
- 为本机 stdio MCP 注入同一工具环境。
- 验证 npm CLI 与 npm lifecycle 子进程使用正确 Node。

### 阶段 3：托管 Python

- 选定并锁定六平台 CPython 独立发行包。
- 增加包目录、许可证、下载、进度、取消、校验、安装、诊断和删除。
- 生成 `python`、`python3`、`pip` shim。
- 验证当前内置 Python SKILL 的真实执行路径。

### 阶段 4：端到端验收与文档收口

- 使用内置 Node 脚本 SKILL 验证无需系统 Node。
- 使用现有 Python SKILL 验证全新设备从安装托管 Python 到生成实际成果。
- 使用 Node 和 Python stdio MCP 分别验证启动和工具调用。
- 验证切换到系统/自定义解释器后的版本和路径。
- 验证 Ask/Execute、取消、退出和 Runtime 重建行为。
- 更新用户说明、架构文档、设置文案、发布打包校验和许可证清单。

---

## 14. 预计代码落点

| 层 | 预计改动 |
| --- | --- |
| Shared | 本机工具环境设置、状态、操作和 IPC schema |
| Main | `LocalToolEnvironmentService`、探测、shim、Python 包安装 |
| Runtime | `process-environment`、OpenCode、Continue、DSH 启动环境注入 |
| MCP | stdio transport 的受管 PATH 注入 |
| Preload | 状态读取、保存、检测、安装、取消、删除和进度订阅 |
| Renderer | Agent Runtime 设置中的本机工具环境卡片 |
| Build | Python 包目录/许可证校验，现有 npm 和 Electron Node 验证 |
| Docs | 用户范围、SKILL/MCP 使用和远程主机边界 |

实际实现应优先复用现有运行环境检测、模型下载、通知和进程树清理代码，不为了表格中的职责
机械新增同名文件或抽象层。

---

## 15. 测试策略

### 15.1 单元测试

- 设置迁移和严格 schema。
- 两种来源的解析，不存在第三种自动状态。
- Node/Python 候选发现、去重、超时和版本解析。
- Windows Store Python alias 拒绝。
- shim 的 Windows 与 POSIX 转义。
- `ELECTRON_RUN_AS_NODE` 仅存在于 Node 子进程。
- PATH 前缀顺序和原环境保留。
- 已保存自定义路径失效时不回退。
- Python 下载摘要、暂存清理、成功发布和删除范围。

### 15.2 本地集成测试

- 安装包中的 Electron Node 实际执行 JavaScript 文件。
- 安装包中的 npm CLI 实际运行并启动一个最小 lifecycle script。
- OpenCode、Continue、DeepSeek Harness 分别解析相同 `node`/`python` shim。
- 本机 stdio MCP 使用托管和自定义来源启动。
- 设置变化后新进程使用新环境，旧进程不被中途改写。
- 取消和应用退出没有残留安装任务或工具进程。

### 15.3 六平台打包验证

- tool bin 脚本存在且权限正确。
- Electron RunAsNode 可用。
- npm CLI 和许可证存在。
- Python 固定包目录覆盖目标平台/架构，下载工件和许可证可验证。
- Python 安装后能导入标准库、pip、venv。
- 安装包未无条件包含完整 Python 工件。

### 15.4 项目验证

源码完成后运行：

```text
npm test
npm run typecheck
npm run lint
npm run build
```

涉及生产打包资源时按发布流程运行对应平台的原生 CI 打包验证。该功能不改变远程 Agent
或桌面到 Agent 生产链路，因此不要求因本机工具环境本身修改共享 SSH Host；如果后续改动
触及远程协议、Agent 包或远程 Runtime，则必须按远程架构文档完成真实 Host 验证。

---

## 16. 验收标准

- 全新安装且系统没有 Node.js 时，本机 SKILL 可以通过 `node` 执行普通 JavaScript。
- 全新安装且系统没有 npm 时，托管 npm 可以执行受支持的安装命令。
- 系统没有 Python 时，用户可以从设置页安装托管 Python，并运行现有 Python SKILL 生成
  实际成果。
- 用户可以选择检测到的系统 Node/Python，设置页显示实际版本和绝对路径。
- 用户可以选择未被自动发现的解释器文件，保存前完成真实诊断。
- 自定义路径失效时明确报错，不静默切换来源。
- Node.js 和 Python 各自只有“GoodBuddy 托管”和“自定义环境”两个来源。
- npm 跟随 Node，pip 跟随 Python，不出现重复来源设置。
- 本机 OpenCode、Continue、DeepSeek Harness 和 stdio MCP 使用一致的解释器选择。
- 依赖 Python 和依赖 Node.js 的本机 stdio MCP 均能使用托管环境完成真实启动与工具调用。
- 不修改系统 PATH、Shell Profile 或用户自定义解释器。
- Ask 不因安装解释器获得额外写入或命令权限。
- 取消、Runtime 重建和应用退出可以清理 GoodBuddy 自己启动的进程与暂存。
- 远程主机不接收本机 SKILL、MCP、shim、Python 包或自定义解释器路径。
- 中英文设置文案、键盘操作、可见焦点、状态和错误反馈符合统一界面设计系统。
- 全量测试、类型检查、Lint 和生产构建通过。

---

## 17. 已知限制

- Electron Node 与普通 Node 的原生模块 ABI 可能不同，首期不承诺普通 Node 原生扩展兼容。
- 托管 Python 首期只有一个 GoodBuddy 支持版本，不提供多版本并存和自动选择。
- 首期共用托管 Python 包环境，不能解决所有第三方包版本冲突；复杂项目应选择用户自己的
  虚拟环境。
- 已运行的 Runtime 和 MCP 不热切换解释器，设置变化对新进程生效。
- 助手工作栏终端首期不自动继承本机工具环境。
- HTTP/SSE MCP 的远端服务依赖由服务部署方负责。
