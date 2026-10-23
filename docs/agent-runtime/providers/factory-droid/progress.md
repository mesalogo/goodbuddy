# Factory Droid Airgap 验证进度

## 2026-10-22：跨 Runtime 子任务与进程复验

扩展任务脚本并完成零真实模型运行：40 次本地确定性请求，验证 daemon 子任务独立中断、
父中断不停止 detached child、TaskStop 成功及 cancelled 摘要、CLI 关闭后 localhost 服务
仍存活。服务通过 Execute 调用 OS process.kill 停止，PID 消失和端口释放均确认；这不是
原生专用 shell-stop RPC。显式 `exit $LASTEXITCODE` 后 Execute 正确保留 exit 7。

完整证据、复跑命令和其他 Runtime 差异见
[子任务与进程实测](../../validation/subagents-and-processes-2026-10-22.md)。
本节新增外部模型请求 0 次，用户设置未变，测试资源已清理。下方早期“TaskStop 未调用”和
“仅验证 Shell 自然结束”保留历史日期，当前范围以本节为准。产品 UI 仍未接入。

## 验收范围修正：全局启停

用户确认 GoodBuddy 的 Skills/MCP 启停沿用全局设置和 Runtime 分配，没有项目级动态启停。
下方补测保留原始 12 项通过、2 项未通过的执行结果，其中 Project toggle 被拒绝属于上游
接口观察，不计为 GoodBuddy 功能缺陷或待实现要求。没有因范围修正重跑或改写历史测试数字。

仍需处理的是全局禁用在运行实例中的状态同步：已测单实例工具移除和进程退出，但连接状态
未在观察窗口内收敛。多个运行会话同步变更、新会话继承及重新启用，需在产品接入时验证。

## 2026-10-22：Skills、MCP、Todo 与后台任务补测

本节记录提交 `122836c3` 之后的验证。Windows x64，Droid `0.245.1`，SDK `0.10.0`。
新脚本调用真实 Droid CLI/daemon；确定性场景由本地模型夹具提供响应，真实模型场景使用
GoodBuddy 已配置的 `gpt-6-astra` / Responses，经原有 Electron 凭据转发器访问。
本轮共 **20 次真实上游请求尝试，均收到 HTTP 200**：任务/Todo 6 次、会话/问答 7 次、
Skills/MCP 7 次。次数包含中间验证，不代表计费次数，不包含上面的 Runtime 升级测试。

### 原生会话与问答

[session suite](../../../../scripts/validate-droid-session.mjs) 最终正式启动器运行通过
13 项确定性场景，17 次本地模拟请求、0 次上游请求。已完成的真实模型运行另有 4 项场景
通过：文本、多轮回忆、问答、文件读写，共 7 次真实请求。

| 场景 | 原生结果 |
| --- | --- |
| 多轮与进程重启恢复 | 保留 sessionId、cwd 和历史；检查实际 JSONL 文件后重启，恢复请求包含旧消息 |
| 在途取消及继续 | 返回 interrupted，下一轮正常完成 |
| 上游 HTTP 400 及恢复 | 返回 error_during_execution，后续正常请求可用 |
| 多选与自定义答案 | multiSelect 标记及字符串答案传到模型工具结果 |
| 整份问卷跳过 | 返回错误工具结果，turn 为 success、文本为空，无额外模型续轮 |
| 等待问题时取消、迟到答案 | interrupted；晚到答案未进入后续模型输入 |
| Read / ApplyPatch | 读取真实夹具、实际创建文件并核验内容 |

SDK 答案类型是字符串。夹具传入的 `red, blue` 能往返，只证明该字符串被保留，不是上游
规定的多选分隔符。单题跳过及后台子任务问答仍未覆盖。取消 AskUser 时观察到同一调用 ID
产生两个相同工具结果，适配器需要按调用和结果身份去重。

### Todo 和会话顶部映射

[tasks suite](../../../../scripts/validate-droid-tasks.mjs) 验证了 TodoWrite 创建、更新与
冷恢复。输入必填 `{ todos: string }`，示例为：

```text
1. [completed] Inspect synthetic cube
2. [completed] Verify synthetic cube
```

没有观察到独立 Todo 通知；`tool_call` 先发空输入，随后补齐 `toolUse.input.todos`。
`tool_result.toolUseId` 对应同一工具，成功内容为 `TODO List Updated`。应在匹配到成功结果
后更新 checklist，忽略空输入，不能按每个 tool_call 通知重复创建待办。

最终真实模型测试断言：只有一个不同 ID 的 TodoWrite、恰好两项、名称和顺序正确、均为
completed、工具结果成功，最终文本为 `LIVE_TODO_OK`。全部通过。

行序对应 item 顺序，文本对应 content，pending/in_progress/completed 对应现有状态。
未验证 priority 或 cancelled Todo。现有 `runtime-checklist.ts` 尚不接受 Droid source；
`RuntimeChecklistStrip` 读取当前/最近消息，不能代替会话级后台任务集合。
这证明顶部展示的数据来源可用，不代表 GoodBuddy UI 已接入。

### 后台子代理及输出控制

本地 daemon 使用 `--host 127.0.0.1 --port <port> --droid-path <binary> --settings <file>`
启动。SDK `createWebSocketDaemonClient` 连接本机 websocket，Airgap 下使用合成 token
完成 authenticate，返回 airgapped-user/airgapped-org；未进行 Factory 登录或云端注册。

| 场景 | 结果 |
| --- | --- |
| 同时创建两个 Task | 独立 childSessionId、原始 toolUseId，均可关联 |
| 父轮自然结束 | 两个子任务仍未完成；下一条前台请求可以完成 |
| 父轮活动时读/附加子会话 | 公开 getSessionMessages/loadSession 可独立使用 |
| 独立停止目标子任务 | daemon `interruptSession({sessionId: childId})` 后收到该子任务 cancelled 终态 |
| 不影响其他执行 | 目标停止期间父会话、兄弟任务仍为 thinking；父回复随后完成 |
| 恢复状态与输出 | subagentInvocations 中目标 cancelled、兄弟 completed；公开消息接口读到兄弟输出 |
| TaskOutput | 模型工具结果分别报告 stopped/completed，与上述状态对应 |
| 后台 shell | Execute fireAndForget 返回 PID、日志路径；输出正确，短进程自然结束。独立停止未验证 |

普通 Task 的独立停止使用 daemon 会话接口，**不使用 Mission 的 killWorkerSession**。
本节通过结果替代早期“普通 Task 停止未验证”的当前结论，早期失败保留为历史记录。
TaskStop 工具只查到 schema，未调用；Shell 的 PID 不能直接作为会话 ID 传给停止接口。

daemon 通知为 `daemon.session_notification`，CLI 为 `droid.session_notification`；
daemon 包含 `params.sessionId` 和 `params.notification`。完成后台任务会自动唤醒父会话，
产生 `task-completion:...` turn，不能用该终态结算另一条用户请求。

任务最终确定性运行通过，21 次本地模型请求；加强 Todo 断言后的真实运行也通过，包含
21 次本地请求及 3 次真实请求。包括探索和前序运行，本轮任务模块累计 147 次本地请求、
6 次真实请求。这些本地请求不访问付费模型。

### Skills 与 MCP

[capabilities suite](../../../../scripts/validate-droid-capabilities.mjs) 的确定性测试验证
真实工具执行；最终运行 **12 项通过、2 项未通过**，19 次本地模型请求、0 次上游请求。
另有 7 次真实模型请求验证 Skill 指令使用、HTTP MCP 与 stdio MCP 调用，均 HTTP 200。

| 能力 | 证据 |
| --- | --- |
| Skill 发现/优先级 | 项目覆盖同名用户 Skill，用户回退可用，其他工作区隔离 |
| Skill 禁用/恢复 | frontmatter/settings 禁用及 SDK 启停生效，禁用 Skill 调用被拒绝 |
| Skill 实际执行 | Skill 工具加载说明，Execute 运行合成脚本，磁盘内容与 stdout 核验通过 |
| 真实模型 Skill 使用 | 模型读取仅存在于 Skill 正文的标记，再调用 HTTP MCP，回复正确引用工具结果 |
| MCP 两种传输 | stdio 和 HTTP 均发现、调用、返回正确结果；真实模型分别调用通过 |
| MCP 鉴权与工具错误 | 合成 HTTP token 成功、错误 token 拒绝；工具错误 isError 正确 |
| MCP 取消与恢复 | 收到 notifications/cancelled；合作式测试服务关闭慢响应，在 teardown 前核验连接已关闭；后续调用成功 |
| MCP 分配隔离夹具 | 禁用/未配置服务工具不出现，其他工作区不继承项目服务器 |

尚未通过项分别是：

1. SDK/Droid 只接受 `settingsLevel: "user"` 的 toggle；Project 被明确拒绝，项目文件未变、
   服务仍连接。该结果是接口范围限制，不是项目配置损坏。
2. 用户级禁用项目定义的 MCP 时，持久化 user override、工具移除与对应 stdio 进程退出都
   已在 teardown 前核验，但当前会话状态在约 11.2 秒后仍为 connecting；新会话能看到禁用。
   这是观察窗口内未收敛，不证明永久不收敛。脚本为这两项保留失败退出码。

MCP 工具 ID 为 `server___tool`，延迟工具需 ToolSearch；权限详情的完整 Execute 命令位于
fullCommand。部分 CLI 工具通知不含 sessionId，必须结合所属连接绑定归属。工具取消会重复
发送同一 ID 的结果。真实模型驱动 Skill 内脚本的执行尚未测，脚本执行由确定性模型验证。

### 复跑、修正与边界

```powershell
$env:GB_DROID_SUITE='tasks'
node scripts/validate-droid.mjs --native --max-calls=0
$env:GB_DROID_SUITE='session'
node scripts/validate-droid.mjs --native --max-calls=0
$env:GB_DROID_SUITE='capabilities'
node scripts/validate-droid.mjs --native --max-calls=0
```

增加 `--live --max-calls=8` 会额外调用真实模型。capabilities 的
`GB_DROID_CAPABILITIES_STDIO_ONLY=true` 仅替换真实模型阶段为 stdio 续测，仍执行确定性用例。
启动器下载固定 SDK；已有 npm 缓存时可设置 `npm_config_offline=true`，这不代表产品离线安装。

本轮修正：FACTORY_HOME_OVERRIDE 应指向 `.factory` 的父目录，实际数据位于
`<home>/.factory/`；旧脚本传入 `<home>/.factory` 会产生多一层目录，现已统一。
stdio MCP 夹具改为独立源码，避免构建器重写被序列化函数的动态 import。
native suite 超时由所属 suite 清理，公共入口不再尝试通过不存在的 ACP 子进程取消。

最终启动器验证、各模块定向 ESLint 通过；capabilities 保留上述两项失败。用户设置字节
比较未变，测试 SDK、夹具、日志和所属进程均已清理。未修改产品代码、未升级 Droid，未提交。

剩余产品验收包括实际顶部 Todo/后台条与问答卡片、GoodBuddy Skill/MCP 分配入口、后台
子任务问答、后台 shell 独立停止、其他真实模型协议、Linux/远程 Agent 和外联阻断。
本地 daemon 的网络绑定与 Airgap 行为已观察，但没有网络抓包或防火墙级隔离证据。

## 2026-10-22：体积与交付记录

本机 Windows x64 `C:\Users\jiang\bin\droid.exe` 实测大小为 296,621,280 字节，
即约 296.6 MB / 282.9 MiB，版本 `0.245.1`。该数值仅包含可执行文件，不含 SDK、插件、
历史和缓存；安装包压缩增量、启动耗时、空闲内存及多会话资源占用尚未测量。

按用户确认的方向将已有安装复用、按需安装、离线导入和 Host 共享二进制写入产品需求。
本轮继续升级已接入的 OpenCode/DeepSeek，Droid 仍保持调研状态，未修改其二进制。

## 2026-10-22：原生 SDK、问答与后台控制补测

本节为后续设计验证，新增真实请求 **12 次**，与下方 ACP 测试的 18 次分别统计。
两阶段合计 30 次真实上游请求尝试，均使用 `gpt-6-astra`，不代表计费次数。

### 原生链路

使用本机 Droid `0.245.1`，在任务临时目录安装固定 `@factory/droid-sdk@0.10.0`，通过
自定义 stdio transport 连接 `stream-jsonrpc`。SDK 发出协议版本 `1.269.0`，本地返回
`1.272.0`；以下已测操作兼容，未承诺整个协议表兼容。模型仍经 Electron 本机转发器访问，
Airgap 和隔离目录沿用下方测试环境。

| 项目 | 结果 |
| --- | --- |
| 初始化、模型发现与更新 | 成功；选择实际返回的 custom 模型 ID |
| 工具 schema | `AskUser`、`Task`、`TaskOutput`、`TaskStop`、`Execute` 可查询 |
| 用户问答 | 显式启用 `AskUser` 后收到 `droid.ask_user`，回答 `blue`，最终准确返回 `COLOR=blue` |
| 文本增量 | `includePartialMessages: true` 收到 90 个 `assistant_text_delta`，正常完成 |
| 后台创建 | `Task` 使用 `subagent_type: worker`、`await=false` 成功；收到 `child_session_available` 及任务 UUID |
| 子会话消息读取 | 父轮结束后 native load 子会话成功，快照可读；本次只有两条 user/context 消息，没有 assistant 输出 |

问答实际输入含 `index: 1`、`topic: Color`、question 和 red/blue options。返回
`{ answers: [{ index: 1, question: <原问题>, answer: "blue" }] }`。工具默认
`allowed: false`，需启用工具并注册 handler。多选、自定义、跳过及后台子任务问答尚未实测。

原始通知正文位于 `params.notification`。原始文本增量字段为 `textDelta`，SDK partial
event 使用 `text`。初版后台探针读错通知层级，导致没有发送目标 stop；已修正脚本并补测。

### 停止控制未通过

修正后的补测创建一个真实后台 worker，约一秒后发送 `droid.kill_worker_session`。
约 19 ms 后收到 `{}`。期间父会话 `agent_turn_completed` 的 reason 为 `completed`，
SDK 返回 success、空文本。等待约 1.5 秒后重新加载父会话，其 `subagentInvocations` 中
该任务仍为 `running`。加载子会话显示 idle、无活动 agent loop，但没有收到该子任务
`cancelled` 终态。加载后的 idle 不能证明取消转换成功。

检查 SDK 包源码发现，`DaemonSessionController.killWorkerSession()` 注释具有 Mission
语义：记录 worker 失败、重新排 feature、修改 mission 状态并中断 worker/orchestrator。
因此这个方法不能直接接到普通 Task 的“停止”按钮。后台测试现在要求明确的 cancelled
摘要；只有成功 ACK 时仍报告失败。

另确认：`TaskOutput`/`TaskStop` 是模型工具，不是通用客户端 RPC。猜测的
`droid.list_background_tasks`、`droid.list_tasks`、`droid.get_task_output`、`droid.stop_task`
均返回 Unknown method，已从最终探针移除。SDK 本地 `listSessions()` 在隔离路径下返回空，
但 native load 能恢复会话，故不能拿它充当活动任务列表。

`DroidClient.loadSession()` 会修改当前 sessionId，本轮只在父轮结束后检查快照。
SDK daemon 路径的消息读取与 child attachment 只查到源码定义，未启动 daemon 验证。
主回复自然完成后子任务继续、独立停止、持续输出、后台 shell 和远程 Host 仍需补测。

### 请求次数与命令

| 批次 | 真实请求尝试 | 结果 |
| --- | --- | --- |
| 原生问答与文本 | 4 | 均 HTTP 200，问答与增量断言通过 |
| 初次后台场景 | 4 | 均收到 HTTP 200；最后一次子任务响应在清理时中止 |
| 修正通知解析后的后台场景 | 4 | 2 次 HTTP 200、2 次收到状态前中止；独立停止终态断言未通过 |
| 协议检查及最终复验 | 0 | 零模型验证通过 |

```text
node scripts/validate-droid.mjs --native --max-calls=0
node scripts/validate-droid.mjs --native --live --max-calls=4
node scripts/validate-droid.mjs --native --native-background --live --max-calls=5
```

原生测试实现见 [validate-droid-native.mjs](../../../../scripts/validate-droid-native.mjs)。
`--native` 会临时下载固定版本 SDK；这不是离线安装或网络隔离测试。根依赖和锁文件未改。
定向 ESLint 及最终零模型运行通过。所有自建测试目录、SDK 副本及所属 Droid 进程已清理，
用户设置最终字节比较未变。产品代码未改。

方案审查后修正验证转发器的并发请求计数，在读取 body 后、调用上游前同步检查并占用预算。
本轮文档的相对链接检查、`npm.cmd run docs:build`、定向 ESLint 与定向 `git diff --check`
通过。文案扫描没有阻断项；复核项中的状态限制、协议边界及验收枚举按技术含义保留。

## 2026-10-22：ACP 与真实模型验证

### 环境与执行路径

本机 Windows x64，Droid `0.245.1`，ACP 协议版本 `1`。使用 GoodBuddy 当前默认模型
`gpt-6-astra`，协议 `openai-responses`，未调用 Claude 模型。

实际链路为 Droid ACP 子进程 → 本机 HTTP 转发器 → 已配置的真实模型服务。
转发器使用 Electron `net.fetch`，从加密设置快照解析凭据；真实密钥仅在 Electron
主进程内存中使用。Droid 设置文件只包含回环地址和测试用占位密钥。此次验证没有覆盖
Droid 直接连接真实网关的网络路径。

子进程设置 `FACTORY_AIRGAP_ENABLED=1`、`FACTORY_DROID_AUTO_UPDATE_ENABLED=0`、
`FACTORY_DISABLE_SETTINGS_PERSISTENCE=true` 和临时 `FACTORY_HOME_OVERRIDE`，同时隔离
HOME、USERPROFILE、APPDATA、LOCALAPPDATA。工作区为 `temp/` 下的独立 Git 仓库，
仅包含合成测试文件。没有向模型提供用户项目文件。

### 实际结果

下列耗时来自一次修正凭据初始化后的完整运行，是单次观测，不是性能基准。

| 场景 | 结果 | 耗时 | 真实上游请求尝试 |
| --- | --- | --- | --- |
| `initialize` / `session/new` | ACP v1 初始化及会话创建成功 | 949 / 296 ms | 0 |
| Airgap 模型目录 | `availableModels` 仅包含隔离配置的 `custom:validation-0` | 随会话创建 | 0 |
| 无效模型 | `session/set_model` 返回 `-32602`、`Model not recognized` | 6 ms | 0 |
| 选择模型 / 推理参数 | custom 模型及 `reasoning_effort=low` 均被接受 | 19 / 72 ms | 0 |
| 文本 | 返回 `READY-73`，终态 `end_turn` | 5,192 ms | 1，HTTP 200 |
| 多轮上下文 | 正确回忆 `ORBIT-73` | 3,341 ms | 1，HTTP 200 |
| 文件读写与授权 | 读取 `input.txt` 并创建内容正确的 `output.txt`；收到 `session/request_permission`，回复 `allow_once` | 11,416 ms | 3，均 HTTP 200 |
| 问答提示 | 返回普通文本问题，没有客户端问答回调 | 4,484 ms | 1，HTTP 200 |
| 取消 | `session/cancel` 后返回 `cancelled`，转发器请求被中止 | Prompt 总耗时 346 ms | 1，中止 |
| 取消后继续 | 同一会话返回 `RECOVERED-73` | 5,164 ms | 1，HTTP 200 |
| 重启 / 加载 | 新进程初始化及 `session/load` 成功 | 192 / 315 ms | 0 |
| 恢复后的上下文 | 重新选择 custom 模型后仍正确回忆 `ORBIT-73` | 4,628 ms | 1，HTTP 200 |

取消测试在转发器准备发送请求后约 300 ms 发出取消通知；346 ms 是整个 Prompt 的耗时，
不能当作纯取消响应延迟。测试未启动 shell 或后台任务，因此没有验证运行中工具进程树的取消。

另用本地模拟服务返回 HTTP 400，Droid 将错误转换为 ACP `-32603`。一次场景中观察到
两次本地 HTTP 请求，没有发送到真实模型。初版脚本把预期异常标成失败，已修正为检查错误码
及错误内容；最终协议测试通过。

### 未通过或未证实的能力

- 逐段文本流式输出：收到 `agent_message_chunk`，但每次答案只有一个块；追加的十二句
  文本测试也只有一个块。尚不能确认逐 Token 或分段输出行为。
- 用户问答：追加一次强制调用测试后，观察到标题为 `Ask User` 的 `tool_call`，输入含
  `questionnaire`；随后 `tool_call_update` 为 `failed`，内容为
  `Tool execution cancelled by user`。客户端没有发出取消，也没有收到问答回调。
  尚未验证回答往返，不能把普通文本提问视为问答工具接入成功。
- Airgap：本轮验证了启用环境变量后的 custom 模型目录及真实请求，没有直接选择内置模型
  验证拒绝行为，也没有防火墙、抓包或 Sandbox 断网证据。不能据此保证无外联。
- MCP、Skills、图片、嵌入上下文、认证流程、会话 list/resume/close、ACP 文件系统回调
  均未实测。初始化声明的能力不计为验证通过。
- GoodBuddy Runtime 选择器、产品事件适配器、发行包、远程 Agent 和跨平台运行未实现或未验证。

### 请求统计与测试程序修正

本轮共转发 **18 次真实上游请求尝试**，其中 10 次 HTTP 200、6 次 HTTP 401、2 次中止。
这是转发器统计，不代表服务端计费次数。

| 执行批次 | 尝试数 | 结果 |
| --- | --- | --- |
| 初次运行 | 7 | 6 次 HTTP 401，1 次中止 |
| 修正后的完整运行 | 9 | 8 次 HTTP 200，1 次中止 |
| 强制问答工具测试 | 1 | HTTP 200，问答工具失败 |
| 较长文本测试 | 1 | HTTP 200，仍只有一个 ACP 文本块 |

初次 401 来自验证程序的凭据初始化问题：复制 Windows `Local State.os_crypt` 的时机晚于
Electron 初始化。修正为启动 Electron 前准备隔离 profile，并同步设置 `userData` 后，
真实调用成功。此问题不归因于 Droid 或模型服务。

### 复跑与清理

可复用脚本：[启动器](../../../../scripts/validate-droid.mjs)、
[Electron 主进程测试](../../../../scripts/validate-droid-main.mjs)。当前默认路径面向 Windows，
可用 `GB_DROID_BINARY` 和 `GB_DROID_SETTINGS` 指定可执行文件与 GoodBuddy 加密设置路径。

```text
node scripts/validate-droid.mjs
node scripts/validate-droid.mjs --live --max-calls=16
node scripts/validate-droid.mjs --live --question-only --max-calls=2
node scripts/validate-droid.mjs --live --text-only --max-calls=1
```

不加 `--live` 只验证协议和本地模拟失败；仍需要读取本机加密模型配置。
`--max-calls` 限制每次运行转发到真实服务的请求尝试数，包含失败和工具续轮。
脚本退出码表示协议断言是否通过；问答结果须另查 `questionObservation.answerRoundTripVerified`，
不能用退出码替代完整功能验收。

定向 ESLint 与最终无真实请求的协议验证通过。测试结束后已删除任务临时目录，未留下本次
Droid/Electron 进程。GoodBuddy `runtime-settings.json`、Factory `settings.json` 和
`config.json` 的最终字节比较一致。本轮只增加验证脚本与更新文档，未接入产品 Runtime。

## 2026-10-14：本机二进制与环境变量检查

### 被测对象

- 路径：`C:\Users\jiang\bin\droid.exe`
- 版本：`0.238.0`
- 文件大小：`281,700,576` bytes
- SHA-256：`D7BC651C24AD3A2B066D7F7FD9E9FCD124246E70B0F31664540AA33D4F1AAF9D`
- 平台：Windows x64
- 内嵌运行时：Bun `1.4.2`

### 已验证事实

1. `droid exec --help` 暴露 `--output-format acp`，并同时支持 `text`、`json`、
   `stream-json` 和 `stream-jsonrpc`。
2. `droid exec --help` 暴露 `--settings <path>`，二进制字符串还包含
   `FACTORY_RUNTIME_SETTINGS_PATH` 和 `FACTORY_ORG_MANAGED_SETTINGS_LOCAL_PATH`。
3. 二进制的环境变量映射包含 `FACTORY_AIRGAP_ENABLED`，其值 `true` 或 `1` 会启用 Airgap。
4. 二进制包含明确错误文案：内置模型在 Airgap 部署中不可用，需要配置 BYOK custom model。
5. Airgap 执行分支会拒绝通过 Factory LLM proxy 路由的内置模型，并要求使用
   `settings.json` 中的 BYOK custom model。
6. `FACTORY_DROID_AUTO_UPDATE_ENABLED` 和 `FACTORY_DISABLE_SETTINGS_PERSISTENCE` 均存在于
   二进制环境变量映射，可用于 GoodBuddy 子进程启动隔离。
7. 设置 `FACTORY_AIRGAP_ENABLED=1` 后执行：

   ```text
   droid exec --model gpt-6-sol --list-tools --output-format json
   ```

   返回 `Invalid model: gpt-6-sol`，并报告 `Available built-in models: None`，同时列出本地
   custom models。这与 Airgap 禁用内置模型的逻辑一致。
8. 设置 `FACTORY_AIRGAP_ENABLED=0` 且同时设置 `AIR_GAP=1` 后，同一命令正常列出内置工具，
   说明当前版本不使用 `AIR_GAP` 作为 Airgap 开关。
9. `droid doctor --config --json` 在设置 `AIR_GAP=1` 或 `FACTORY_AIRGAP_ENABLED=1` 时都能
   完成配置检查；该命令本身没有把 Airgap 状态作为公开诊断字段输出，因此不能用它单独证明
   Airgap 已启用。

### 执行命令

```text
droid --version
droid exec --help
droid doctor --config --json
$env:FACTORY_AIRGAP_ENABLED='1'; droid exec --model gpt-6-sol --list-tools --output-format json
$env:FACTORY_AIRGAP_ENABLED='0'; $env:AIR_GAP='1'; droid exec --model gpt-6-sol --list-tools --output-format json
```

上述检查没有向 Factory 模型发送 Prompt，没有修改仓库文件，也没有修改用户 settings 文件。

### 尚未验证

- 真实 Airgap build 的 ACP 初始化和多轮 Prompt。
- 使用本地或内网 custom model 的真实文本请求。
- ACP 工具调用、问答、取消、进程树回收和会话恢复。
- Windows 防火墙或 Sandbox 对外联请求的实际阻断结果。
- GoodBuddy 适配器、Runtime 选择器、发行包和远程 Agent 支持。

当前证据只支持进入 GoodBuddy Runtime 实现阶段，不代表 Factory Droid 已经接入 GoodBuddy。
