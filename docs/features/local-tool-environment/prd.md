# 本机工具环境 PRD

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 计划 |
| 版本 | 0.1 |
| 日期 | 2026-09-01 |
| 适用产品 | GoodBuddy 桌面端 |
| 目标平台 | Windows、macOS、Linux，x64 与 arm64 |
| 关联文档 | [功能入口](./README.md)、[User Stories](./user-stories.md)、[功能逻辑](./logic-design.md)、[UI 设计](./ui-design.md)、[技术设计](./technical-design.md)、[功能进度](./progress.md) |

## 1. 背景

GoodBuddy 的部分 SKILL 通过 Node.js 或 Python 脚本生成成果，部分本机 stdio MCP 也以
`node`、`npm`、`npx`、`python` 或 `python -m` 启动。当前安装包没有向这些能力提供统一
解释器，用户是否成功取决于系统 PATH 和预装软件。

普通用户不应为了使用一个 SKILL 或 MCP 手工安装开发环境。专业用户已有项目 Node、
Python、虚拟环境或 Conda 环境时，也不能被 GoodBuddy 静默替换。

## 2. 产品目标

1. 全新设备无需预装 Node.js 即可运行普通 JavaScript SKILL 和 Node.js stdio MCP。
2. 用户可在 GoodBuddy 内按需安装 Python，并运行 Python SKILL 和 stdio MCP。
3. 专业用户可以选择检测到的解释器或指定其他可执行文件。
4. 设置始终展示实际来源、版本、路径、工具状态和能力依赖状态。
5. 本机工具环境不修改系统环境，也不传播到远程主机。
6. 保持 Ask/Execute、Runtime、MCP、取消和进程清理的现有边界。

## 3. 核心决策

### 3.1 每种工具只有两个来源

- **GoodBuddy 托管（推荐）**
- **自定义环境**

不提供“自动选择”。“系统安装”和“指定路径”合并为“自定义环境”，因为两者最终都是
用户明确选择的外部可执行文件，区别只在发现方式。

### 3.2 配套命令跟随解释器

- Node.js 保证 `node`、`npm`、`npx` 来自同一来源。
- Python 保证 `python`、`python3`、`pip` 来自同一来源；`pip` 实际绑定当前 Python。
- 首期不托管 `uv`、`uvx`、Conda、Poetry、pyenv 或 nvm。

### 3.3 工具就绪不等于能力依赖就绪

解释器通过诊断后标记“工具环境已就绪”。只有 SKILL 或 MCP 的实际入口及所需第三方包
通过验证后，才能标记“能力依赖已就绪”。GoodBuddy 首期不自动扫描和安装任意能力依赖。

## 4. 功能范围

### 4.1 包含

- 本机 OpenCode、Continue、DeepSeek Harness 加载的 SKILL。
- Main 或本机 Runtime 启动的 stdio MCP。
- 托管 Node.js、npm、npx。
- 按需下载安装的托管 Python 3、pip、venv。
- 系统解释器探测、自定义文件选择和真实诊断。
- 工具来源、版本、路径、安装、删除、更新和错误状态。
- 新启动本机 Runtime 和 MCP 的 PATH 注入。

### 4.2 不包含

- SSH Host 的 PATH、Agent、固定 Node、Runtime、SKILL 或 MCP。
- HTTP/SSE MCP 服务端环境。
- 普通助手工作栏终端的 Shell 环境。
- 通用语言版本管理器。
- 每项目或每 SKILL 的解释器覆盖。
- 自动合并或求解多个 `requirements.txt`、`package.json`。
- 自动执行任意第三方安装脚本。
- 修改系统 PATH、注册表或 Shell Profile。
- 无条件把完整 Python 打入桌面安装包。
- 首期导入托管 Python 离线包；完全离线用户可选择已有的自定义 Python。

## 5. 功能需求

### FR-1 Node.js 托管环境

- 安装 GoodBuddy 后托管 Node.js 即可用，不需要额外下载。
- 实际版本通过运行命令诊断，不仅根据 Electron 版本推断。
- `node`、`npm`、`npx` 必须来自同一托管组合。
- Electron Node 原生扩展兼容限制必须可见。

### FR-2 Python 托管环境

- Python 未安装时展示安装入口，不把完整 Python 放入所有桌面安装包。
- 下载复用“关于与更新”的官方 GitHub/镜像来源。
- 展示下载、校验、安装、取消、可更新、删除和失败状态。
- 下载失败保留已验证旧安装。

### FR-3 自定义环境

- 探测 PATH 和常见安装位置中的有效候选。
- 候选同时展示版本和规范化绝对路径。
- 用户可以选择未被探测到的可执行文件。
- 保存前执行真实诊断。
- 已保存路径失效时保持用户选择并报错，不静默回退。

### FR-4 SKILL 接入

- SKILL 可以稳定调用 `node`、`npm`、`npx`、`python`、`python3` 和 `pip`。
- SKILL 不需要知道解释器真实安装目录。
- 缺失解释器或第三方依赖时返回准确错误。
- 工具环境不自动安装 SKILL 声明的依赖。

### FR-5 stdio MCP 接入

- 裸命令通过当前工具环境解析。
- `env node`、`env python3` 形式的脚本使用当前工具环境。
- MCP 中配置的绝对命令路径保持原样，不被替换。
- Python 和 Node.js MCP 均使用与 SKILL 相同的来源。

### FR-6 状态与诊断

- 分别显示“工具环境状态”和“能力依赖状态”。
- Node 诊断覆盖 Node、npm、npx、标准库和子进程。
- Python 诊断覆盖 Python 3、架构、标准库、SSL、pip 和 venv。
- 诊断使用临时目录并在结束后清理。

### FR-7 生效范围

- 设置只对新启动的本机 Runtime 和 stdio MCP 生效。
- 已运行进程不被中途替换环境。
- 不影响普通终端、系统环境和远程主机。

### FR-8 升级兼容

- 全新用户默认选择 GoodBuddy 托管。
- 已发布版本升级时，将当前有效系统解释器一次性固化为自定义绝对路径。
- 没有有效系统解释器时迁移到托管来源。
- 后续系统 PATH 变化不自动改变选择。

### FR-9 生命周期

- 安装、诊断、Runtime 和 MCP 子进程支持取消和应用退出清理。
- 删除只作用于 GoodBuddy-owned 目录。
- 不删除系统解释器、自定义环境、用户工作区或远程文件。

### FR-10 权限模式

- Ask 不因解释器可用而获得额外命令或写入权限。
- Execute 继续使用当前本机账号的完整授权。
- 不为工具环境增加第二套批准流程。

## 6. 产品验收

- 无系统 Node.js 时，托管 Node 可以真实执行 JavaScript SKILL 和 stdio MCP。
- 无系统 Python 时，用户可安装托管 Python 并真实执行现有 Python SKILL 和 MCP。
- Node、npm、npx 来源一致；Python、python3、pip 来源一致。
- 用户可明确选择并锁定自定义解释器。
- 自定义路径失效不触发静默切换。
- 工具就绪与能力依赖就绪不会混为同一状态。
- 本机 Skills、MCP 和工具环境不会应用于远程主机。
- 中英文界面、键盘操作、焦点和状态反馈符合统一设计系统。
- 全量测试、类型检查、Lint 和生产构建通过。
