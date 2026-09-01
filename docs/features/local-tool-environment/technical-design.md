# 工具执行环境技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 计划 |
| 版本 | 0.1 |
| 日期 | 2026-09-01 |
| 关联 PRD | [工具执行环境 PRD](./prd.md) |
| 功能逻辑 | [工具执行环境功能逻辑设计](./logic-design.md) |
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
  artifactDownloadSource: 'native' | 'oss'
}
```

只持久化用户意图。不持久化候选列表、版本、PATH、shim 路径、诊断结果或可重新读取的托管
包元数据。

### 2.1 兼容迁移

- 全新用户默认 `managed`。
- 旧设置没有该字段时，Main 按升级前 PATH 分别解析有效 Node 和 Python 3。
- 有效候选写成 `custom + 规范化绝对路径`。
- 没有有效候选时写成 `managed`。
- 新增的 `artifactDownloadSource` 默认迁移为 `native`。
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
- Windows x64 原生工件来自官方 `python` NuGet 包，Windows ARM64 来自官方
  `pythonarm64` NuGet 包。
- macOS/Linux 原生工件来自 Astral `python-build-standalone`。
- 目录包含版本、平台、架构、字节数、SHA-256、许可证、原生 Target 和 OSS Target。
- OSS 对象直接复制原生工件字节，不重新压缩或转换。
- 安装包不无条件携带完整 Python。

具体发行包和版本必须在实现前完成六平台工件、许可证、维护状态和 pip/venv 可用性核验。

目录示例：

```ts
type ManagedToolArtifact = {
  id: string
  version: string
  platform: NodeJS.Platform
  architecture: string
  size: number
  sha256: string
  downloads: {
    native: {
      url: string
      redirectHosts: string[]
    }
    oss: {
      url: string
    }
  }
  licenseFiles: string[]
}
```

URL 只存在于 Main/构建目录，不进入 Renderer。两个 Target 共用顶层 `size` 和 `sha256`，
从 schema 上禁止声明不同字节。

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

- `resources/skills` 顶层只保留五个带 `SKILL.md` 的独立包：
  `deai-writing`、`longdoc-docx`、`product-evidence`、`product-marketing`、
  `product-presentation`。
- 九种纯 Markdown 产品营销配方位于 `product-marketing/workflows/<route-id>/`，
  使用 `WORKFLOW.md` 与同目录 `templates/`，不参与顶层 Skill 发现。
- `CapabilityService` 仅在状态中没有该 ID 时应用默认值。三个产品营销 Skill 默认
  `enabled: false`；两个通用文档工具和导入 Skill 维持默认启用。显式保存状态不迁移、
  不覆盖。
- 默认停用的 Skill 不进入 Runtime 指令和原生 Skill 包列表；用户启用后沿用现有四个
  Runtime 分配。

stdio MCP：

- 裸 `node`、`npm`、`npx`、`python`、`python3`、`pip` 使用工具 bin。
- `env node`/`env python3` 脚本通过 PATH 使用同一来源。
- 绝对 command 保持原样。
- HTTP/SSE 不受影响。
- 工具环境不自动安装 MCP 第三方依赖。

## 11. Renderer 状态与 IPC

### 11.1 统一设置分类

- `settingsCategoryList` 用一个 `capabilities` 分类替换现有 `skills`、`mcp` 分类，不增加
  `sdk` 分类。
- 新增 `CapabilitiesAndToolsSettingsSection`，在统一分类标题下使用共享 `PageTabs` 渲染
  第一阶段的 `skills | mcp`。
- `SkillsSettingsSection` 和 `McpSettingsSection` 继续拥有各自业务状态；嵌入时不重复渲染
  一级分类标题。MCP 原有内层 `PageTabs` 保持独立。
- `ToolEnvironmentSettingsSection` 只承载工具下载源、Node.js、Python 和诊断。
- 当前源码没有 Settings 外部 Skills/MCP 定向入口，第一阶段不增加未使用的
  `initialCapabilityTab`。未来出现真实定向入口时再增加会话级初始 Tab 参数。
- 普通进入 `capabilities` 时默认 `skills`。外层选中值只存在于当前 Renderer 会话，不写入
  Shared 设置。
- 为避免切换时丢失编辑状态，外层面板首次访问时挂载，之后在本次设置面板会话中保留并用
  `hidden` 控制可见性；关闭设置面板后按现有生命周期释放。
- 工具执行环境生产路径完成时，把 `tool-environment` 追加到同一个组件；完成前不注册
  Tab、不渲染占位面板。
- 页签直接包装层使用 `flex: 0 0 auto`，并由 CSS 回归测试保证在滚动设置布局中不可收缩。

### 11.2 工具环境状态与 IPC

Renderer 接收：

- 当前选择。
- 当前实际来源、版本、路径。
- 有界候选列表。
- 托管安装状态、版本、占用空间。
- 工具诊断分项结果。
- 安装进度和脱敏错误。
- 受管工具工件下载源选择，以及活动任务实际冻结的来源。

Renderer 不能提交 PATH、环境变量、下载 URL、摘要、安装目录、shim 内容或任意命令参数。
所有 IPC 输入使用共享 Zod schema，Main 重新验证路径和解释器。

## 12. 受管工具工件下载

- 设置值为 `native | oss`，默认 `native`。
- 下载操作开始时读取并冻结设置。
- 解析目录中对应 Target；缺失即返回“当前下载源不可用”。
- 原生 Target 按每个上游声明严格 Host/重定向 allowlist。
- OSS Target 只允许 GoodBuddy 固定 OSS Host 和不可变对象前缀。
- 两种来源共用大小和 SHA-256 校验、暂存、取消、发布和清理逻辑。
- 失败不重试另一来源。
- 构建/发布流程先下载原生工件、校验，再把原字节同步到 OSS，并复核公开对象。
- 该设置不传给 pip/npm，不改写其 registry；也不参与模型、应用更新和 Agent 目录选择。

## 13. 权限与远程边界

- Ask/Execute 语义不变。
- 不新增解释器批准流程。
- 不上传 shim、Python、pip 包或自定义路径。
- 不修改 Host PATH。
- 不把本机 SKILL 或 stdio MCP 传给远程 ACP Session。
- 远程 Agent 固定 Node 继续只服务 Agent、模型桥和签名 Runtime。

## 14. 实施顺序

### 阶段 1：契约、迁移、探测和 UI

- Shared schema、设置迁移、IPC。
- 用“能力与工具”分类合并现有 Skills/MCP 入口，增加三个外层水平 Tab。
- 增加“工具执行环境”面板及原生/OSS 下载源设置。
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

## 15. 验证

单元测试覆盖设置迁移、探测、版本解析、shim 转义、PATH 顺序、失效路径、下载摘要和暂存
清理，以及原生/OSS 选择冻结、Target 缺失和禁止回退。

Renderer 测试覆盖统一一级分类、三个外层 Tab、默认 Skills、Skills/MCP 定向入口、会话内
状态保留、MCP 内外层 tablist 隔离、键盘切换和窄屏单行滚动。

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
