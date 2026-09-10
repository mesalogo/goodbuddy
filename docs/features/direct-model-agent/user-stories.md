# 直连模型 Agent 能力 User Stories

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 已实施，跨平台 CI 待验证 |
| 版本 | 0.4 |
| 日期 | 2026-09-09 |
| 关联 PRD | [直连模型 Agent 能力 PRD](./prd.md) |
| 关联逻辑 | [功能逻辑设计](./logic-design.md) |

## 1. 角色

### 1.1 普通项目用户

希望模型直接完成脚本、文档生成或数据处理，不关心不同平台的 Shell 名称。

### 1.2 开发者

希望直连模型能够修改代码、运行测试、检查 Git 状态并根据失败结果继续修正。

### 1.3 Runtime 用户

已经使用 OpenCode、Continue 或 DeepSeek Harness，希望继续使用 Runtime 原生能力，不看到
重复的 GoodBuddy Shell 或 Subagent。

## 2. Epic A：跨平台执行

### US-A1 在 Windows 运行项目命令

关联：FR-2、FR-3、FR-4。

Given 当前项目位于 Windows 本机且选择直连模型 Execute，When 模型调用
`process_execute`，Then GoodBuddy 使用可用 PowerShell 在项目目录运行命令，并返回
Shell、目录、退出码、输出和耗时。

### US-A2 在 macOS/Linux 运行项目命令

关联：FR-2、FR-3。

Given 当前项目位于 macOS 或 Linux 本机，When 模型运行同一工具，Then GoodBuddy 使用
Bash，Bash 不可用时使用 Sh，工具契约保持不变且实际 Shell 明确可见。

### US-A3 选择命令工作目录

关联：FR-3。

Given 当前请求为本机 Execute，When 模型传入绝对路径或相对工作区路径，Then 命令在
解析后的目录执行，包括工作区外目录和符号链接目标，And 后续省略 `cwd` 时仍使用原工作区。
When 目标不是目录或不存在，Then 命令不启动并返回准确错误。

### US-A4 根据非零退出继续修正

关联：FR-2、FR-9。

Given 测试命令退出码非零，When 进程结束，Then 工具正常返回退出码和 stderr，模型请求
继续运行，And 模型可以读取失败原因、修改代码并再次运行。

### US-A5 取消长命令

关联：FR-7。

Given 命令仍在运行，When 用户取消父请求，Then 当前 Shell 及其由本次命令创建的子进程树
停止，And 活动状态显示“已取消”，And 其他用户进程不受影响。

### US-A6 续读长输出

关联：FR-7、FR-9。

Given 命令或 Subagent 输出超过单次预览容量，When 工具返回结果，Then 明确标记省略并提供
续读位置，And 模型可逐页读取中间与结尾内容，直到取得完整输出。Given 输出包含中文或表情，
Then 即使请求很小的页面，续读仍会前进。Given 所属会话已释放，Then 旧句柄不能继续读取。

### US-A7 从瞬时模型网络故障恢复

关联：FR-7、FR-9、FR-11。

Given 直连模型在 TLS 建连、网络传输或单次请求超时时失败且尚未显示输出，When 请求仍未
取消，Then GoodBuddy 显示当前重试次数并使用递增等待时间最多重试 3 次，And 成功后继续
原问答或工具轮次。Given 已经显示文本或推理内容，Then 不自动重放该调用。

## 3. Epic B：编程闭环

### US-B0 搜索和分页读取大型项目

关联：FR-4、FR-12。

Given 用户在 Ask 或 Execute 中处理本机项目，When 模型需要定位代码或读取大文件，Then
它可以使用随包 ripgrep 搜索内容或列出文件，并按行分页读取命中位置，不要求用户预装 `rg`。
Given Ask 未启用知识库、联网搜索或编程委派，Then 工作区搜索和读取仍可使用，不要求额外批准。

### US-B1 修改后运行验证

关联：FR-2、FR-4。

Given 用户选择 Execute 并要求修复代码，When 直连模型修改文件，Then 它可以运行聚焦测试
或检查命令，并根据真实结果继续修改，直到给出完成或阻塞结论。

### US-B2 使用本机工具环境

关联：FR-8、FR-10。

Given 用户选择了 GoodBuddy 托管或自定义 Node/Python，When 新命令调用 `node`、`npm`、
`npx`、`python` 或 `pip`，Then 它们解析到当前工具环境，And 不修改系统 PATH 或已有终端。

### US-B3 依赖或命令不存在

关联：FR-2、FR-9。

Given 项目缺少所需命令或依赖，When Shell 返回错误，Then 工具保留退出码和错误文本，
And 模型说明缺失项或在 Execute 中采取用户要求的安装步骤，不把环境缺失报告为模型故障。

### US-B4 使用补丁修改文件

关联：FR-4、FR-12。

Given 用户选择 Execute，When 模型提交包含新增、修改或删除操作的工作区补丁，Then
GoodBuddy 在写入前验证全部路径和上下文，逐文件原子写入，并返回实际修改的文件列表。
Given 用户选择 Ask，Then 补丁工具不出现在清单中且伪造调用会被拒绝。

## 4. Epic C：Subagent 委派

### US-C1 委派聚焦编程任务

关联：FR-5、FR-6。

Given 父直连模型正在处理复杂请求，When 它调用 `subagent_delegate` 并给出独立任务，
Then 子级使用同一项目、模型连接和 Execute 能力完成工作，And 最终结果返回父模型综合。
Given 父请求已有浏览器标签页，When 委派任务需要浏览器，Then 子级使用同一页；子级完成后，
父模型仍可继续操作该页，不因子会话清理而关闭父页。

### US-C2 Ask 中只读委派

关联：FR-4、FR-5。

Given 父请求为 Ask，When 模型委派分析任务，Then 子级保持 Ask，不能写文件或运行命令，
And 不因 Subagent 存在而扩大权限。

### US-C3 禁止递归委派

关联：FR-5、FR-7。

Given 子级正在执行，When 它读取自己的工具清单，Then 清单中没有
`subagent_delegate`，And 子级不能创建孙级任务。

### US-C4 子级失败后父级继续

关联：FR-5、FR-9。

Given 子级运行期间失败或超时，When 子任务结算，Then 父模型收到失败状态、部分输出和
有界错误，And 可以自行继续、改变方案或向用户说明阻塞。

### US-C5 取消传播

关联：FR-7。

Given 一个 Subagent 正在运行模型或命令，When 用户取消父请求，Then 排队和运行中的子级
全部取消，当前命令进程树停止，And 不再向父请求追加迟到结果。

### US-C6 保持产品对象简单

关联：FR-6。

Given 直连模型完成一次委派，When 用户查看会话、Task Center 和活动，Then 会话内可看到
Subagent 状态与结果摘要，And Task Center 不出现新的子 Task，And UI 不展示 Job/Run 树。

## 5. Epic D：Runtime 与执行空间边界

### US-D1 Agent Runtime 不重复获得工具

关联：FR-1、FR-10。

Given 用户选择 OpenCode、Continue 或 DeepSeek Harness，When Runtime 启动，Then
GoodBuddy 不注入 `process_execute` 或 `subagent_delegate`，And Runtime 原生能力保持不变。

### US-D2 切换 Runtime 后工具清单更新

关联：FR-1。

Given 会话从直连模型切换为 Agent Runtime，When 下一次请求开始，Then 新请求只使用目标
Runtime 的能力；切回直连模型时重新获得符合工作模式的直连工具。

### US-D3 不在错误设备执行

关联：FR-3。

Given 当前执行空间是 SSH 且远端进程后端尚不可用，When 解析工具清单，Then 不注册
`process_execute`；即使调用参数有效，也不能回退到桌面本机执行。

### US-D4 消息通道使用相同规则

关联：FR-1、FR-4。

Given 消息通道项目选择直连模型，When 合法消息触发 Ask 或 Execute，Then 使用与桌面会话
相同的工具矩阵和通道既有工具策略，不维护第二套 Shell 能力配置。
