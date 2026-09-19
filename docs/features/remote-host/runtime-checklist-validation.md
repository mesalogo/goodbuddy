# 远程执行清单验证记录

日期：2026-09-18。对应 CL-P1、CL-P3、CL-P4；需求与统一契约见
[执行清单设计](../assistant-workbar/runtime-checklist-technical-design.md)。
本记录包含远程 Agent 到 Main Runtime 的事件验证，以及后续 Windows 完整桌面到
Linux CN 的安装、清单展示、保存、重启和取消验证；各阶段覆盖范围分别列出。

## OC 实现与原生证据

共享 Linux x64 经 `192.168.0.23` 连接，使用已保存的 SSH 凭据和固定 Host Key。
未使用 VPN 路由，不计作第二台 Host。Agent 由当前源码构建到专用测试目录，复用该机
受管 Node 24.19.0 和签名 OC 包；manifest 与二进制 `--version` 均为 1.18.29。

真实模型按提示两次调用 `todowrite`：先写入一个 `in_progress/high` 条目，再写入
`todos: []`。未适配时两次工具均成功，ACP 只有 `tool_call/tool_call_update`，
没有 `plan`。上游同版本
[acp/event.ts](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/acp/event.ts)
也未处理 `todo.updated`，因此不能把 ACP 类型定义当作部署证据。

现有 `opencode-subagent-plugin.ts` 将精确原生 `todo.updated` 放入既有 ACP metadata，
由 Agent 原 Session 分派、operation 归属和 semantic transcript 传递。
`acp-remote-runtime.ts` 在工具截断之前消费该结构并校验 `RuntimeChecklist`。
原 Session 与当前 Prompt 不符、无效条目均不替换清单。工具活动保留；正文及泛化
工具名不触发更新。`cancelled` 原样保留，避免 ACP plan 只允许三种状态造成信息损失。
标准 OC `plan.entries` 的结构化转换也有测试，但本版本的真实成功路径使用插件原生事件。

## 共享 Host 结果

最终源码复验目录为 `/root/tmp/gb-acp-recovery-4bLjbp`，首次通过目录为
`/root/tmp/gb-acp-recovery-SJbdZQ`。首次清单抵达桌面运行时后，在其
semantic checkpoint 被消费前关闭 attach。随后恢复同一 controller、binding 和
operation，设置 `remoteRecoveryOnly: true`，没有再次提交 Prompt。

| 验证项 | 结果 |
| --- | --- |
| 原生清单新增 | sequence 1，`todo.updated`，一个 `in_progress/high` 条目 |
| 未 ACK 清单重放 | 重连后仍为 sequence 1，内容相同 |
| 原生清空 | sequence 5，`todos: []`，映射为 `{source:'opencode',items:[]}` |
| 重连后完成 | 两份清单、工具活动和终态继续到达 |
| 额外模型调用 | 重连未重发 Prompt；该次总计 3 个真实 provider 请求 |
| 清理 | Agent 停止后，测试目录所属残留进程 0；临时上传及运行目录已删除 |

更长条目、取消状态、非法输入、子 Session、标准空 plan、工具活动不重复生成清单、
相同 provenance 重放，由单元测试覆盖。远程真实模型的长清单、取消及连续多轮隔离
本次未实测，不能将单元测试记为真实 Host 验收。

一次较早的重放探测在 `done` 后才断开，之前已 ACK 的记录被正常裁剪，故不能从
sequence 0 重新读取整段历史。该次断言失败后，改为验证未 ACK 边界；产品未增加
历史快照或另一套重连机制。已 ACK 内容的恢复仍依赖 Main 已提交的消息。

另复现 OC 冷启动超过默认 15 秒控制超时：连续五次请求未进入 provider。
将 `runtime/startPrompt` 控制等待提高到至少 30 秒后，原生初始化、建会话和模型选择
完成。对应测试模拟 20 秒启动，确认仅提交一次 start；其他控制请求时限保持原设置。

## 模型调用口径

统计为测试 Agent 中实际向非 loopback provider 发出的 HTTP 请求，不将 ACP Prompt
次数、工具调用、内部 `/session` 路由请求或重连计作模型调用。读取已有 OC 模型配置，
测试未打印凭据或端点。

| 探测 | 实际模型请求 |
| --- | ---: |
| 五次冷启动定位 | 0 |
| 提高启动等待后的原始 ACP 观察 | 3 |
| 输出工具状态、确认两次 todowrite 成功 | 3 |
| 插件接入后在 done 边界重放，断言失败 | 3 |
| 最终未 ACK 边界断线重放通过 | 3 |
| 最终源码再次复验未 ACK 边界 | 3 |
| CN Linux 包与命令入口探测 | 0 |
| 合计 | 15 |

五次进入 provider 的 OC 探测均返回三个 HTTP 200；无受控假 provider 调用。

## CN 部署与生命周期

已从 npm 获取固定 `@continuedev/cli@1.5.47` 工件，压缩包为 17,945,195 bytes，
并在 Host 校验 SHA-512：

```text
gtpewV3RoIOD9dyTtKIBi1SY0VOHRu3Ehe7C/mmnswm+j34MPyrcQhQaWj/m+jdfGO4fNIKdrgGIlLso1ULDFw==
```

在 `/root/tmp/gb-checklist-upload-44f47e99-94e2-4e35-8efb-ef80b7a830ca` 解包，
以受管 Node 24.19.0 执行 `dist/cn.js --version` 得到 1.5.47；`serve --help`
确认 HTTP `/state`、`/message` 入口。`acp --help` 返回普通顶层帮助，并非 ACP
子命令；工件 `src/index.ts` 有 serve 注册、没有 acp 注册。探测未启动模型会话，
没有把包入口可运行记为远程 CN 功能完成。测试工件已从 Host 清理。
日志留存复验目录为 `/root/tmp/gb-checklist-upload-424f412c-cf2a-4857-810f-48da03285821`，
同样通过并清理，模型请求仍为 0。

以下为同日后续实施结果，取代最初调查时的未实现清单。

| 路径 | 当前实现 |
| --- | --- |
| 受管工件 | lock 固定 `@continuedev/cli@1.5.47`、SHA-512 和 `lib/continue/dist/cn.js`；组包保存 payload、manifest、签名和许可文本 |
| 工件安装 | Runtime 与复合 Agent 包校验接受 CN；桌面按 descriptor 的 Runtime ID 选择 payload，Host 复用 `prepare/commit` 和 Runtime registry |
| Agent 启动 | `continue-acp-helper.ts` 在 Host 上复用 `ContinueHostAdapter`，启动 Node 驱动的 CN HTTP 宿主，对既有 Agent 提供 ACP Session 接口 |
| 模型桥 | Main 选择 CN 模型 profile，Agent gateway 保留逐 operation 的模型配置；CN 请求携带 Session/operation 路由头，配置中使用桥接占位凭据 |
| 清单 | 宿主在原始参数层提取成功的 `Checklist.checklist`，经 `_meta.goodbuddyChecklist` 和原 semantic transcript 输出统一 `checklist` 事件 |
| 项目及聊天 | 创建、保存、安装激活、Main Runtime 工厂和聊天菜单均接受 CN；项目默认值与历史 CN 选择保持；安装身份必须匹配选择 |
| 生命周期 | ACP cancel 取消本轮宿主，已有 attach、transcript/ACK 负责断线恢复；后续 Prompt 可在同一对话继续 |

最终复验目录为 `/root/tmp/gb-cn-runtime-EALG99`。开发复合包为 188,609,399 bytes，
使用临时签名身份和隔离 trust registry，没有更改应用或 Host 的正式信任配置。
桌面验包函数、Host `prepare/commit`、安装后 Agent `bootstrap/health` 与 CN
`runtime activate` 均通过。随后当前源码 Agent 使用该安装得到的 CN payload 执行下列场景：

| 场景 | 实测结果 |
| --- | --- |
| Execute 原生清单 | sequence 3 为一个 pending 条目，sequence 6 为显式空列表 |
| 未 ACK 断线重连 | 同一 binding/operation 重放原 sequence 3，再收到空清单；不重发 Prompt |
| 取消 | 新一轮产生清单后取消，Main 返回 `RemotePromptCancelledError`；清单不改写为完成 |
| 同对话续发 | 切换 Ask 后返回 `RECOVERED`，没有旧清单事件 |
| 回收 | Agent 停止后测试所属进程 0；隔离目录和上传目录已删除 |

本轮实际向外部 provider 发出的 HTTP 请求数为 **17**：首次取消探针 5 次，修正探针对
预期取消异常的处理后 6 次，最终安装包复验 6 次。三轮分别取得 4、5、5 个 HTTP 200，
各有 1 次请求在取得响应前取消。安装探针的四次排错运行均为 0 次；重连没有额外提交。
此前已有 `cn-runtime-live.log` 记录过 3 次 CN 请求，属于接手前证据，不计入本轮 17 次，
也不并入上方原 OC 阶段的 15 次。本轮全部 CN 进程均运行于 Linux Host。

安装排错包括复用旧缓存时缺少 Koffi CJS 文件，以及探针把安装器 CLI 一起内联后污染
relay stdout。当前组包实现已包含 Koffi CJS 文件；探针改为单独导入安装器模块。
这些运行未进入模型。最终日志为临时目录中的 `cn-runtime-live.log`。

本阶段验证从 Main 受管 Runtime 工厂进入。后续完整桌面与联合开发包结果见下节。
CN 的 Linux arm64/macOS arm64 尚未实测；本轮没有提交或发布 Agent 包。

## 2026-09-19 联合包与完整桌面验收

默认 Agent 组包与 CI 构建已同时包含 OC 1.18.29、CN 1.5.47。描述符保留主 Runtime，
通过 `additionalRuntimes` 描述随包安装的 CN；目录、桌面验包、Host 安装和资源加载
均校验该列表。单 Runtime 包仍可读取，已有发布包无需迁移。联合包专项测试为
31 passed、1 skipped，包含生产安装器对单包及联合包的安装回归。

完整桌面使用当前生产 Main、Preload 和 Renderer，隔离 profile 与开发签名 registry，
保留 sandbox/context isolation。连接由既有凭据和固定 Host Key 到 `192.168.0.23`，
再转发至同机专属 SSH 服务；该服务将 HOME 限定在 `/root/tmp/gb-joint-ui-2oQ87z/home`。
本地 loopback 地址仅为 SSH 转发入口，CN 进程实际运行于 Linux。原生文件选择对话框
由测试驱动返回开发包路径；其后的导入、验签、传输和安装均走生产 IPC。

桌面完成联合包导入和“由 GoodBuddy 传输”安装后，通过实际项目表单创建 CN 远程项目，
选择 Execute，在真实输入框发送清单请求。两次 Checklist 更新后，顶部显示一项完成、
一项待办，工具活动仍可见；保存和退出重启后，原项目保留这两项状态。

重启续发首次实测失败：CN 内存原生会话已退出，但旧 ready binding 仍引用其 Session；
随后恢复同一个 start 请求又重复递增序号。修复后冷打开 CN ready binding 会从现有
对话历史新建原生会话，未确认 start 的恢复保持原 operation 和序号。相邻 4 文件
167 passed、1 skipped；新构建的真实桌面已验证重启续发成功、清单出现后点击停止、
取消条目仍为待办，以及随后返回 `REMOTE_CN_RESUMED` 且不显示旧轮清单。

测试启动器曾遗漏托盘资源，以及误清除托管 Node 所需的 `ELECTRON_RUN_AS_NODE`，导致
前一次构建未刷新产物；修复启动器后核对产物包含源码修复，再进行上述成功复验。
这两项是临时驱动问题。最初测试计数钩子未覆盖远端模型出口，改从隔离 Agent 的
`model-calls.sqlite` 读取 operation、dispatch 状态及取消结果，仅导出计数，不读取凭据。

首轮全量测试为 4707 passed、67 skipped、1 failed；失败为本地 OpenCode 压缩返回
`compacted: false`。随后单独复验该文件及远程 ACP、项目选择、顶部清单，共 136 passed。
不将专项复验写成一次全量全绿。类型检查和 lint 已通过。

完整桌面截图位于批准临时目录的 `joint-cn-real-before-restart.png` 和
`joint-cn-cancelled.png`，均已打开审阅。窗口中状态与内容对齐，取消后保留待办，
输入框仍可使用。UI 驱动为 `joint-desktop.cjs`、`joint-scenario.ps1`；共享 Host
及隔离 profile 由 `joint-ui-host.ts` 管理。

补充真实长清单测试收到 55 项、5,601 字符的条目正文，数据库读取数量和字符数一致。
随后成功调用空字符串清单，顶部隐藏；再次退出重启并打开原项目，保存的空数组仍有效，
没有复活旧清单。自动断言摘要保存在批准临时目录的 `joint-final-evidence.json`，覆盖
SSH 项目身份、CN 选择、长清单落库、取消保留待办、取消后续发和清空后的重启状态。

本轮新增模型请求以隔离 Agent gateway 调用账本为准，共 **16 次**，15 次 completed，
1 次 outcome-unknown/cancelled。三轮创建并更新两项清单分别 3 次；取消场景 2 次；
取消后续发 1 次；55 项长清单 2 次；清空 2 次。旧会话失败和启动排错未新增 gateway
dispatch。本轮 16 次与上文 CN 17 次、早期 OC 15 次分别记录，不重复累计。

清理后已用原固定身份重新连接 Host，确认测试目录不存在、所属进程为 0；本地隔离
profile 及其加密测试凭据已删除。正式 Host 安装、应用配置和业务文件未改动。最终
typecheck、lint、差异检查通过。尚未执行 Linux arm64/macOS arm64 真机与多远程
会话同时生成清单的完整桌面矩阵；隔离与去重仍有定向测试覆盖，不据此扩大真机结论。

## 测试与复查路径

源码相邻测试：7 个文件，185 passed、6 skipped。覆盖 ACP Runtime、协议通道、
managed Runtime、原生插件、Agent-owned Prompt、ACP connection 和 model bridge。

```text
npx vitest run src/main/agent/acp-remote-runtime.test.ts src/agent-daemon/opencode-subagent-plugin.test.ts src/main/remote-agent/protocol-remote-runtime-channel.test.ts src/main/remote-agent/managed-remote-acp-runtime.test.ts src/agent-daemon/agent-owned-acp-prompt.test.ts src/agent-daemon/agent-acp-connection.test.ts src/agent-daemon/model-bridge.test.ts
npm run typecheck
npm run lint
```

Typecheck、lint 通过。`npm test` 在 240 秒时超时，未得到全量完成结果；此前
`src/renderer/src/App.test.tsx` 两项 Magic Notes 测试因 `pdfjs` 的 `DOMMatrix is not defined`
失败。本次未修改该 Renderer 路径。

本机临时探测目录为 `C:\Users\jiang\AppData\Local\Temp\opencode`，保留这些脚本供复查：

- `checklist-host-driver.ts`：读取既有凭据、SSH 固定身份、部署源码 Agent、清单及断线断言。
- `checklist-host-build.cjs`、`checklist-host-run.cjs`：构建和 Electron 执行入口；`--verify` 跑 OC，`--cn-only` 跑 CN 无模型探测。
- `checklist-host-daemon.ts`：只记录原生 ACP 初始化阶段名称的诊断包装。
- `checklist-cn-probe.cjs`：CN 工件完整性与 Linux CLI 入口验证。
- 复用 `acp-recovery-host-build.cjs`、`acp-recovery-host-daemon.ts` 和 `image-host-agent.ts`，没有复制凭据文件。

最终 stdout 证据分别为该目录的 `checklist-oc-final.log` 和 `checklist-cn-final.log`。
文档审校扫描无阻断项；复核项为测试范围列举及必要的未验证边界，按事实保留。

构建顺序为先运行 `acp-recovery-host-build.cjs`，再运行 `checklist-host-build.cjs`，
最后运行 `checklist-host-run.cjs --verify`。真实 OC 探测会调用模型；早期 `--cn-only`
探测只检查 CN 入口，不调用模型。

后续 CN 全路径复验使用 `cn-runtime-build.cjs` 构建当前源码与临时签名复合包，再运行
`checklist-host-run.cjs --continue --verify --lifecycle`。该命令会发出真实模型请求，
与前述只运行 version/help 的 `--cn-only` 不同。`cn-runtime-daemon.ts` 在隔离 Home
调用桌面验包及 Host 安装器，验证 CLI 激活，然后使用当前源码 Agent 持有模型轮次；
provider HTTP 请求计数在 Agent gateway 的外部 fetch 层完成。

后续专项验证：远程相关 27 个测试文件、374 项通过；新增 CN 复合包测试经过桌面完整
验包与生产安装器的 prepare/commit。全量运行完成，4665 passed、67 skipped、6 failed；
其中一项是运行期间新增 CN 测试尚未修正的归档名，随后专项复验通过。其余五项为
`ActivityPanel.test.tsx` 与 `activity-store.test.ts` 的引用复用断言，本轮未修改对应实现。
这两个文件在并行工作区继续更新后重新运行，39 项全部通过；全量运行中的失败项均已
经后续专项复验，但没有重新运行全部测试来取得同一最终快照的全绿报告。
最终另复验项目选择、顶部清单和安装管理 3 文件、41 项通过；App 远程 Runtime 选择与
继承 3 项通过。`npm run typecheck`、`npm run lint` 均通过。中文审校扫描阻断项为 0，
复核项为测试列举、请求数分项与必要验收边界，按事实保留。

## 2026-09-19 Continue 会话 MCP 交付回归

模型桥 helper 原先把 Session MCP 写入原生配置，但独立模型 profile 生成分支只保留
显式能力，导致 Execute 最终配置丢失 MCP。修复后通过 run options 传递会话 HTTP
服务器；本机原生 MCP 隔离和 Ask 只读规则不变，具体机制见[Runtime](./technical-design.md#runtime)。
`continue-acp-helper.test.ts` 联合运行实际 helper 与 adapter 配置生成器，覆盖初次交付、
续接替换、Ask 排除、加载空列表以及本机 profile 不继承原生 MCP。

共享 Linux x64 Host 经 LAN 固定身份连接，使用保存的 GoodBuddy 凭据，当前源码 Agent、
helper、adapter 与 CN 1.5.47 在专用目录运行。Main 受管 Runtime → Agent-owned ACP →
Continue → Agent HTTP MCP → Main 工具桥往返通过；仅最末端图片服务替换为无计费
测试接收端，校验输入并返回 `SAFE_MCP_ROUNDTRIP`，未连接图片 Provider。
同一对话依次 Execute、Ask、Execute：两次 Execute 各实际调用工具一次，Ask 没有工具调用
并回复 `ASK_NO_IMAGE_TOOL`；三次均正常终结。最终源码再次构建后完整重复该顺序。

首轮成功目录 `/root/tmp/gb-cn-runtime-2kQ7wc`，最终复验目录
`/root/tmp/gb-cn-runtime-NNM89D`。每轮 5 次真实文本 Provider HTTP 请求，合计 **10 次**，
全部 HTTP 200；每轮上限 6 次，单次最大输出 1,024 tokens，单 Prompt 验证超时 120 秒。
图片 Provider 请求 **0 次**。此前一次测试目录权限错误在 Runtime 验证阶段退出，模型请求
0 次；修正测试目录权限后通过，未放宽产品校验。每轮结束确认所属剩余进程 0，专用运行
及上传目录已清理，原 Host 安装未修改。此验证不包含正式包安装、UI 点击或真实图片生成。

复查脚本位于上述本机临时目录：`mcp-host-build.cjs`、`mcp-host-run.cjs`，
最终日志 `mcp-host-live.log`。专项 4 文件 38 项通过；改动文件 ESLint 和 Agent 类型检查
通过。主任务随后完成合并后的 `npm test`：405 个文件通过、9 个跳过，4,826 项通过、
67 项跳过，耗时 982.48 秒，无失败；最终完整类型检查与 lint 通过。
