# 工具执行环境 PRD

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
5. 工具执行环境不修改系统环境，也不传播到远程主机。
6. 保持 Ask/Execute、Runtime、MCP、取消和进程清理的现有边界。
7. 用户可以在“工具执行环境”Tab 中明确选择受管工具工件使用原生地址还是 OSS 镜像。
8. Skills、MCP 和工具执行环境通过一个“能力与工具”设置入口形成清晰的能力配置链路。

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

### 3.4 分阶段交付统一设置入口

第一阶段先把现有 Skills 和 MCP 合并到“能力与工具”，只显示两个真实可用的水平 Tab。
“工具执行环境”实现完成后再加入第三个 Tab；未实现期间不展示禁用项、空白页或开发中占位。

## 4. 功能范围

### 4.1 包含

- 本机 OpenCode、Continue、DeepSeek Harness 加载的 SKILL。
- Main 或本机 Runtime 启动的 stdio MCP。
- 托管 Node.js、npm、npx。
- 按需下载安装的托管 Python 3、pip、venv。
- 系统解释器探测、自定义文件选择和真实诊断。
- 工具来源、版本、路径、安装、删除、更新和错误状态。
- 受管工具工件的原生地址/OSS 镜像选择。
- “能力与工具”一级分类及 `Skills`、`MCP`、`工具执行环境` 三个水平 Tab。
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
- 修改模型下载源、应用更新源、Agent 下载源、pip/npm 注册表或用户配置的网络地址。

## 5. 功能需求

### FR-1 Node.js 托管环境

- 安装 GoodBuddy 后托管 Node.js 即可用，不需要额外下载。
- 实际版本通过运行命令诊断，不仅根据 Electron 版本推断。
- `node`、`npm`、`npx` 必须来自同一托管组合。
- Electron Node 原生扩展兼容限制必须可见。

### FR-2 Python 托管环境

- Python 未安装时展示安装入口，不把完整 Python 放入所有桌面安装包。
- Windows x64 使用固定官方 `python` NuGet 工件，Windows ARM64 使用固定官方
  `pythonarm64` NuGet 工件；macOS/Linux 使用固定 Astral `python-build-standalone`
  工件，最终版本以真实诊断和共同支持矩阵为准。
- 原生地址直接指向精确上游工件；OSS 镜像保存该工件的字节完全相同副本。
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

### FR-11 工具下载源

- “工具执行环境”Tab 提供两个互斥选项：`原生地址` 和 `OSS 镜像`。
- 全新用户默认使用原生地址；该选择独立于“关于与更新”和模型下载源。
- 选择原生地址时，每个受管工件使用目录中固定的上游 URL。
- 选择 OSS 镜像时，使用 GoodBuddy OSS 中固定的对应对象。
- 两个 Target 必须声明同一逻辑工件、相同字节数和 SHA-256；OSS 不得重打包或修改内容。
- 下载开始时冻结来源；运行期间切换设置只影响后续下载。
- 当前来源失败、缺少工件或校验失败时明确失败，不自动请求另一个来源。
- 该设置适用于当前 Python Runtime 和未来纳入受管工具目录的 Runtime/工具链。
- 该设置不影响用户执行的 pip/npm 依赖安装、模型下载、应用更新、Agent 下载、HTTP/SSE
  MCP 或用户配置 URL。

### FR-12 统一设置入口

- 设置中心只提供一个“能力与工具”一级分类，不再并列显示独立的 Skills、MCP 或工具执行
  环境分类。
- 第一阶段提供 `Skills`、`MCP` 两个水平 Tab；工具执行环境完成后依次提供
  `Skills`、`MCP`、`工具执行环境` 三个水平 Tab。始终默认打开 `Skills`。
- 三个 Tab 使用共享 `PageTabs`，保留 `tablist`、`tab`、`tabpanel`、方向键和可见焦点。
- `Skills` 继续承载现有 Skill 启停、导入、状态和 Runtime 分配。
- 内置 Skill 顶层目录只展示五个独立能力：`deai-writing`、`longdoc-docx`、
  `product-evidence`、`product-marketing`、`product-presentation`。产品营销的功能目录、
  一页纸、技术方案、白皮书、招标、演示套件、客户案例和竞品定位作为
  `product-marketing` 内部工作流，不重复显示为独立 Skill。
- `deai-writing` 和 `longdoc-docx` 默认启用；`product-evidence`、
  `product-marketing`、`product-presentation` 默认停用。已保存的用户启停和 Runtime
  分配始终优先于默认值；导入 Skill 的默认行为保持不变。
- `MCP` 继续承载现有 MCP 配置、凭据、状态和 Runtime 分配；其现有内部分组页签保持不变。
- `工具执行环境` 承载工具下载源、Node.js、Python、诊断和生效范围。
- 合并导航不改写 Skills/MCP 业务数据；未来新增定向入口时必须进入对应水平 Tab。
- 切换水平 Tab 不丢弃当前编辑状态；不把当前水平 Tab 持久化为产品设置。
- 未实现的工具执行环境不得以禁用 Tab 或占位内容提前显示。

## 6. 产品验收

- 无系统 Node.js 时，托管 Node 可以真实执行 JavaScript SKILL 和 stdio MCP。
- 无系统 Python 时，用户可安装托管 Python 并真实执行现有 Python SKILL 和 MCP。
- Node、npm、npx 来源一致；Python、python3、pip 来源一致。
- 用户可明确选择并锁定自定义解释器。
- 自定义路径失效不触发静默切换。
- 工具就绪与能力依赖就绪不会混为同一状态。
- 本机 Skills、MCP 和工具执行环境不会应用于远程主机。
- 工具下载使用用户明确选择的原生地址或 OSS，且不会静默回退。
- 第一阶段通过“能力与工具”统一入口展示 Skills/MCP 两个水平 Tab；工具执行环境完成后
  追加第三个 Tab。
- 中英文界面、键盘操作、焦点和状态反馈符合统一设计系统。
- 全量测试、类型检查、Lint 和生产构建通过。
