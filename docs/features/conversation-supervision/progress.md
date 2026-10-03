# 监督者实施进度

日期：2026-09-30。

当前记录以已验证生产行为为准。监督者尚未覆盖全部 user stories。

## 2026-10-03 会话故事图谱开关

FR-S11、US-S30 的“使用故事图谱”已接通 Composer、生产 Preload／IPC、SQLite 和工具网关。会话默认开启，仅在监督者应用启用时显示，位置在知识库之前。存储和执行合同见 [MCP 接入](./story-graph-mcp-design.md#6-内置-mcp-与-runtime-接入)，没有数据库版本升级或迁移。另保留本轮开始前已有的监督者独立模型选择及并行性能改动。

定向测试共 9 个文件、37 项通过，重复运行不重复计数：

- `npx vitest run src/main/agent/native-client-coordinator.test.ts src/renderer/src/conversation-persistence.test.ts src/renderer/src/Composer.test.tsx src/agent-daemon/story-graph-integration.test.ts`：25 项。覆盖默认值、按会话隔离、保存中及失败、原生客户端绑定、Main／Agent HTTP MCP 发现、旧调用拒绝与重新开启；图谱集成 5 项在最后修改后单独复跑通过，含在途结果交付前关闭。
- `npx vitest run src/main/assistant/assistant-database.test.ts src/main/ipc.test.ts src/renderer/src/App.test.tsx src/main/agent/deepseek-harness-acp-e2e.test.ts -t "story graph|Story Graph|pins"`：11 项通过，630 项按名称未运行。覆盖真实 SQLite 重开、旧自动保存不能覆盖选择、IPC 校验、四种本地 Runtime 的签发与关闭，以及受控 Harness Ask／Execute。
- `npx vitest run tests/overlay-layering.electron.test.ts -t "conversation story graph"`：1 项通过，3 项按名称未运行。真实 App、Preload、IPC 和 SQLite 在 1280px／390px、浅色／深色四种组合下检查共享 Switch、位置和可见矩形；原生鼠标打开菜单、Space 保存、页面重载、应用关闭时移除 DOM、重开后恢复选择及旧工具绑定拒绝均通过。切换没有模型请求，模型尝试计数为 0。

`npm run typecheck` 的 Main、Agent、Web 三组通过，`git diff --check` 通过。修改文件定向 ESLint 除 `conversation-selectors.ts:32,47` 外通过；这两处是同工作树并行标题缓存改动的 `react-hooks/immutability` 报错，本功能只改该文件的 Composer 字段投影，未修改缓存逻辑。没有执行全量测试、发布构建、提交或推送。中文 MCP 说明扫描阻断项为 0，复核项保留必要的数据和执行边界。

### 本轮 Linux Host 证据

[源码探针](../../../scripts/story-graph-host-probe.ts)临时打包后在共享 Linux x64 Host 运行当前 `AgentImageToolMcp`、`AgentOwnedAcpPrompt`、`ContinueHostAdapter`，桌面使用真实 `AssistantDatabase`、`KnowledgeMcpGateway` 和 `MainImageToolSession`。关闭操作改为写会话持久设置，验证其他会话仍开启，以及同一个远程 MCP 会话不再发现工具、旧工具调用被拒绝。

OpenCode 和 Continue 的 Ask／Execute 确定性探针通过，共 10 次测试推理请求（含 2 次标题生成）、10 次桌面图谱读取、0 次外部 Provider 请求。真实 DeepSeek 复测中，Linux OpenCode Ask／Execute 均完成图谱调用并返回完成标记，随后关闭检查通过；该轮 6 次 Provider 请求（含 2 次标题生成）、8 次桌面读取。首轮真实模型已完成 Ask 图谱读取，但探针未拼接流式文字便检查完成标记而失败，消耗 3 次 Provider 请求；修正探针后复测，整个任务外部请求合计 **9 次**。

工具消息通过 SSH 标准输入输出搬运，调用生产二进制工具分发；没有重装共享 Agent，也未把完整 Desktop attach／bootstrap 或远端 Continue 的真实模型请求计作已验证。远程协议与模型桥源码未变，会话开关由 Desktop 的现有可用性回调执行。测试只使用隔离 SQLite 和固定示例内容；临时 Host 探针及运行目录已清理。Electron 界面与 SSH Runtime 分开验收，没有宣称一条自动化场景覆盖整窗点击到远端模型。

## 2026-10-03 监督者独立模型选择

FR-S13 已接通监督者“设置 → 模型”、应用设置持久化和 Main 连接解析。字段只保存已有文本连接 UUID，旧配置跟随应用默认；执行中复用同一 Runtime，继续和重试采用当前设置。规则见[模型选择](./logic-design.md#监督者模型选择)。

定向验证覆盖中英文选择与保存失败草稿、失效连接提示、旧设置默认值及重载、提取到经验阶段的模型一致性、失败后的释放与继续、建议措辞连接及清理。`ipc.test.ts` 的监督／心跳相关 24 项通过，含真实直连 Runtime 到 loopback HTTP 服务的两次请求：固定连接、应用默认各一次，验证模型名、请求定制、无工具及失效连接不回退。外部真实模型请求为 0 次。

验证命令：`npx vitest run src/main/application-settings-store.test.ts src/main/assistant/supervision-production.test.ts src/renderer/src/HeartbeatCenter.test.tsx`；`npx vitest run src/main/ipc.test.ts -t "supervis|heartbeat|unchanged sources"`；`npm run typecheck`；修改的源文件定向 ESLint。未跑全量测试、打包、真实供应商或 Electron 原生界面测试。监督模型请求在桌面 Main 内完成，Agent 和远程模型桥未改动；未进行远程 Host 验证。

## 2026-10-02 长会话验收与 Agent 自主调用图谱

### 长会话验收

`npx jiti scripts/long-session-acceptance.mjs <live.sqlite> .env.deepseek.local <dir> <会话前缀> [failAfter]`：对本机数据库做在线备份，只在副本里归档其他会话、隐藏任务，使回顾只读取一条真实会话；首次运行在第 N 次提取时注入一次提供方失败（不消耗付费调用），再继续同一回顾；完成后用保存的批次片段逐条重建每条消息原文；最后再跑一次心跳和一次默认手动回顾，要求零模型调用。原库不修改。

第一次跑最长会话（389 条消息、约 21.7 万码点、16 天）时，继续回顾三次都失败：两次是模型返回无效 JSON，一次是引用了范围外的来源。原因是一个批次的模型输出不可用时整次回顾立即失败，只能靠反复手动“继续”碰运气。改动：

- 叶子批次输出不可用（无效 JSON、结构不符、引用不存在的来源或实体）时，在同一段待处理正文上缩小到 1/2、再到 1/4（不少于 500 字符）重试，最多 2 次；缩小只是先处理前一部分，其余正文留在待处理里，不跳过、不截断。
- 导航合并输出不可用时，用相同输入再问 1 次。
- 提供方错误、超时、取消和响应超出容量不重试，仍按原来的方式失败并保留已保存批次。

改后结果（DeepSeek `deepseek-flash`）：

| 会话 | 首次运行 | 继续 | 覆盖 | 无变化重跑 |
| --- | --- | --- | --- | --- |
| 97 条、6.0 万码点、4.9 天 | 第 4 次提取注入失败，已存 3 批 | 1 次完成，16 次调用 | 97/97 条精确重建，0 缺口、0 重叠 | 心跳、手动均 `no_change`，0 调用 |
| 389 条、21.7 万码点、16.2 天 | 第 7 次提取注入失败，已存 5 批 | 1 次完成，61 次调用（30 提取、31 合并），约 32.5 分钟 | 389/389 条精确重建，0 缺口、0 重叠 | 心跳、手动均 `no_change`，0 调用 |

最长会话共 67 次调用、约 52.7 万输入和 54.8 万输出 Token，发布 237 个事件；失败前保存的批次在继续后全部保留未重算。改动前的同一会话运行（三次继续均失败）记录在 `sl9/long2`，改后中间版本（仅叶子重试，合并失败两次后第三次继续完成）在 `sl9/long3`。

边界：完整覆盖只说明每段原文都进入了成功批次，不代表模型没有遗漏或误读；验收只用了两条会话，没有测多项目全局回顾。

### Agent 自主调用

决定：普通对话不自动注入故事和经验，由 Agent 按需调用 Story Graph 工具。为此：

- 工具说明写明何时应主动调用（继续之前的工作、询问为什么这样决定、在可能有既有约束的领域开始新任务）、何时不调用（闲聊、与项目历史无关的通用问题），用 2～4 个关键词查询，查几次找不到就说明并按当前上下文回答。
- 搜索改为按词匹配：空格和标点分词，中文按相邻两字切分；一条记录命中整句或至少一半的词即返回，按命中程度排序，故事和经验在同分时靠前。此前 Agent 用“监督者回顾调度”这类自然短语搜索，因为要求整句出现而 0 结果。
- 搜索结果的预览先显示名称、标题、描述等可读字段，不再以 ID 开头。

验证（`scripts/story-graph-agent-deepseek.mjs`，DeepSeek 函数调用，只给生产工具定义，不提示要用工具）：

| 轮次 | 判断正确 | 说明 |
| --- | --- | --- |
| 改前 | 4/5 | 通用编程题也去搜索；继续工作类问题搜了 9～22 次仍找不到内容 |
| 改后 | 5/5 | 三个项目历史问题都主动调用；数组去重和问候都不调用 |

改后“继续回顾调度，按最后定的方案”能找到并引用 2026-10-02 的故事线模型设计；“导出功能有什么约束”能列出经验和来源。“为什么取消 300 秒自动暂停”仍在搜了十几次后达到对话轮数上限：这次取消发生在数据副本最后一次回顾之后，图谱里确实还没有这条决定，Agent 没能及时停止并说明“没有记录”。

## 2026-10-02 故事与经验质量抽查

数据：同一份 437 个事件的数据副本上已有的故事归属运行（`sl3/off1`、`sl3/cross2`）和经验抽取运行（`sl4/run1`、`sl4/run2`），以及本次改提示词后的新运行（`sl8/off3`，DeepSeek `deepseek-flash`，12 次调用，约 6.2 分钟）。一致性用“两次运行中同属一个功能的事件对”的重合度（Jaccard）衡量。

| 检查 | 结果 |
| --- | --- |
| 故事归属一致性（改前，off1 对 cross2） | 0.51 |
| 主要不一致来源 | “提交与发布”吸收了 87 个事件，其中只有 40% 在另一次运行里属于发布；其余是各功能自己的提交、推送和验证 |
| 改动 | 提示词明确：某个领域的提交、推送、测试和验证属于该领域；发布功能只放版本号、发布说明、标签、打包和发布 |
| 改后（off3） | 发布功能 42 个事件；与 cross2 的一致性 0.74；暂不归类 55 个；再次整理 0 次调用 |
| 暂不归类的事件 | 抽查 cross2 的 49 个：几乎都是问候、知识截止时间、SSL/认证报错、寿命和睡眠问答、案例咨询、权限挂载等一次性问题，归为“暂不归类”是合理的 |
| 经验跨运行一致性 | run2 的 38 条里 23 条能在 run1 中找到形成依据重合（Jaccard ≥ 0.3）的对应经验，表述基本一致 |
| 经验依据抽查（10 条） | 形成依据基本都对得上经验内容；后续“应用”较弱，抽到的 5 条应用里约 2 条和经验关系不大（例如“需求有歧义先确认”被记到“询问微信附件导入能力”） |

结论：功能边界在明确“提交归领域”后明显稳定；仍有约四分之一的事件对在两次运行间归属不同，主要发生在界面、笔记、帮助提示等相邻功能之间，可以通过手动合并修正。经验的形成依据可信，应用记录原先过宽。

随后收紧经验应用：模型给出的应用事件必须与该经验的某个形成事件共享实体，否则丢弃（同批其他内容保留）。在 off3 的故事上重新抽取（6 次调用，约 3.8 分钟）：45 条经验，应用记录从此前的 53 条降到 6 条，抽查 6 条全部与经验内容相符；依据无来源 0、应用早于形成 0、再次抽取 0 次调用。代价是跨故事的经验连线变少（3 条），时间螺旋和“可用经验”建议能显示的跨故事复用也随之减少。`supervision-experiences.test.ts` 新增“无关知识的事件不记为应用”。

## 2026-10-02 时间螺旋显示经验节点

对应 [3D 概念](../story-graph/3d-concept.md) 中的桶外经验节点。

实现：

- `experienceLinks()`（`story-graph-3d-model.ts`）：经验在当前层中，从最早形成依据所在的木片，连到之后第一个在另一片木片上的应用。只在同一片木片里用过的、应用不晚于形成的、依据不在当前层的经验不画。每层最多 6 条，按应用到的不同木片数排序。
- 时间螺旋：经验画成桶外的菱形，高度在形成与应用两个时间之间，角度在两片木片之间；两段向外弯的弧线分别连到形成木片和应用木片的对应高度。只有选中的经验在画布上显示名称。提供“跨木片的经验”键盘入口（现为工具栏选择框）；点击菱形或选择经验打开详情。

验证：

- `story-graph-3d-model.test.ts` 新增 1 项（只连到跨木片的后续应用、只出现一次、层外依据与倒序应用排除、上限）。相关组件测试 3 个文件 32 项通过，Web 类型检查、相关 ESLint 通过。
- Electron 实测（生产组件，第 5 步数据副本的 46 个故事、38 条经验；1440 浅色、390 深色）：无报错、无横向溢出；根层 3 条、goodbuddy 层 6 条跨木片经验；从列表选中和在画布上点中菱形都能打开经验。
- 38 条经验中，在当前数据里能形成跨木片连线的只是少数，其余只在同一故事中形成或应用，不在螺旋上显示，仍可在“经验”页签中查看。

## 2026-10-02 故事线模型第 5 步：工作回顾按故事组织

对应[故事线模型改造设计](./storyline-model-design.md)第 5 步“工作回顾页”。

实现：

- 工作回顾在所选回顾结果的摘要之上新增“这段时间的故事”，按该结果的范围和时间区间读取已保存的故事和经验，不调用模型（`supervision-story-digest.ts`、`SupervisionStoryDigest.tsx`）。
- 分组：推进的故事（区间内有事件、区间前也有）、新出现的故事（第一个事件在区间内）、已结束的故事（结束依据事件在区间内）、形成或用上的经验（最早形成依据在区间内，或区间内有应用）、这段时间没有新进展（进行中、区间前有事件、区间内没有；跨项目故事和已结束的故事不算）。功能把子线索的事件计入自己，子线索不重复列出。
- 每组按事件数排序，默认显示 6 条，可展开其余；每条显示项目、事件数和最近一个事件。点击任一故事或经验打开图谱，并选中该对象。原有的工作总结、本次变化、未解决事项保留在下方，作为阅读入口。

验证：

- `supervision-story-digest.test.ts` 2 项（分组规则、子线索计入功能、跨项目与已结束故事不算无进展、经验形成与应用区分）；`SupervisorWorkspace.test.tsx` 新增 1 项（按所选结果范围读取故事、各分组内容、点击进入图谱）。相关组件测试 4 个文件 73 项通过，Web 类型检查、相关 ESLint 通过。
- Electron 实测（生产组件，第 5 步数据副本导出的 46 个故事、38 条经验和一条 7 天的全局回顾结果；1440 浅色、1024 深色、390 深色）：无报错、无横向溢出、条目无文本溢出；宽屏 3 列、窄屏 1 列；展开后从 13 条到 26 条；点击条目切到图谱。该副本的数据从 09-19 开始，这条结果的区间正好覆盖全部数据，因此只出现“新出现的故事 19”“已结束的故事 1”“形成或用上的经验 33”，“推进的故事”和“没有新进展”两组没有在真实数据中出现，只由单元测试覆盖。

## 2026-10-02 故事线模型第 5 步：心跳故事建议与 MCP 故事、经验查询

对应[故事线模型改造设计](./storyline-model-design.md)第 5 步。工作回顾页按故事组织见上一节。

实现：

- 心跳建议新增两类，候选只由规则选出，不调用模型：
  - **暂无进展**（`stalled`）：本次范围内进行中的功能或子线索（至少 3 个事件），最近事件距今达到“故事多少天没有新进展时提醒”（设置，默认 14 天）。只提示查看，不改变故事状态，不推断结束。每次心跳最多 3 条，按事件数从多到少；已待处理或依据未变的不计入名额，其余留到后续心跳。接受后转为暂停的后续任务。
  - **可用经验**（`experience`）：本次回顾归入某故事的事件，与某条经验的形成事件共享实体，而该经验尚未在这个故事中形成或应用。出现在 5 个以上故事中的实体（如产品名）不作为依据。每条经验只指向匹配事件最多的一个故事，每次心跳最多 3 条，按依据数排序。接受即标记已参考。
  - 两类候选排在未决事项之前，不会被每次 20 条的上限挤掉；与其他建议一起只用一次模型调用措辞，输入不含来源原文和定位。
- 建议记录 `story_id`、`experience_id`；“在图谱中查看”直接打开对应故事或经验。Schema 56 重建 `supervision_suggestions` 以扩展类型约束，已有行原样复制。
- Story Graph MCP：`story_graph_search` 支持 `story`、`experience` 两种对象；`story_graph_get_context` 对故事返回其事件（功能包含子线索的事件），对经验返回形成与应用事件，再通过事件读取来源。经验带 `automatic` 或 `user_edited` 标记，工具说明要求把经验作为参考而非规则。查询范围规则不变：项目范围只返回本项目的故事，以及在本项目形成或应用过的经验。

验证：

- 新增 `supervision-story-suggestions.test.ts` 5 项：暂无进展的阈值、不改故事状态、不重复、转任务；每次最多 3 条且按事件数排序、其余在后续心跳补上；经验跨故事建议只出现一次、不建议给形成它的故事；MCP 故事与经验的搜索、上下文及项目范围隔离；Schema 55 升级到 56 保留已有建议。新增 `SupervisionSuggestionsPanel.test.tsx`：新类型标签与按故事、经验打开图谱。监督相关主进程 11 个文件 73 项、IPC 定向 21 项、组件 4 个文件 72 项通过；Node/Web/Agent 类型检查、相关 ESLint 通过。未运行全量测试。
- 真实数据（第 4 步修正后运行的数据副本，`npx jiti scripts/story-suggestions-deepseek.mjs <db> .env.deepseek.local <dir> 7`，DeepSeek `deepseek-flash`；数据只有约 13 天，阈值用 7 天，“现在”取最后事件时间）：

| 运行 | 规则候选 | 调用 | 结果 |
| --- | --- | --- | --- |
| 第 1 轮（故事候选排在未决事项之后） | 20 条未决事项，0 条故事候选 | 2 | 故事候选被 20 条上限挤掉，因此改为故事候选优先 |
| 第 2 轮（暂无进展不限量） | 20 条暂无进展 | 2 | 13 天的数据里大量故事“停滞”，一次挤满上限，因此加每次 3 条的限制 |
| 第 3 轮（经验按每个实体匹配） | 3 条暂无进展、17 条可用经验 | 2 | 同一经验指向 5～8 个故事，大多经由“监督者”这类通用实体匹配，因此改为排除通用实体、每条经验只指向一个故事、每次最多 3 条 |
| 第 4 轮（最终规则） | 3 条暂无进展、3 条可用经验、14 条未决事项 | 2 | 每次请求 6 条故事候选，都不含来源定位；建议都带故事，经验建议都带经验 |

  - 最终规则下的可用经验例如“长任务超时或中断先查取数与分批根因，不以延长超时或调并发修复”指向“回顾算法与并发设置”、“提交只纳入本次相关改动”指向“自动监督开关与设置”。是否真正适用未人工逐条核对。
  - 再次生成时没有重复任何待处理建议；只补上了上一次被 20 条上限挤掉的未决事项（1 次调用）。
  - MCP：全局范围搜到 6 个相关故事、9 条相关经验；一个功能的上下文返回 96 个事件（含子线索），一条经验返回 5 个依据事件。

边界：是否在普通对话中主动查询故事与经验，取决于 Agent 是否调用工具，未做额外注入。

## 2026-10-02 故事线模型第 4 步：经验抽取

对应[故事线模型改造设计](./storyline-model-design.md) SL-4、SL-5 和第 4 步。

实现：

- `supervision-experiences.ts`：新表 `supervision_experiences`（经验、适用条件、边界、状态、用户调整标记）、`supervision_experience_events`（`formed` 形成依据、`applied` 后续应用及结果）、`supervision_experience_seen`。Schema 55，升级后表为空，由下一次回顾从已有故事中抽取，不重读来源。
- 在故事归属之后、同一回顾名额内执行。候选由规则选出，不调用模型：有尚未处理的决定、变化或里程碑事件，且事件数达到“故事参与经验整理的最少事件数”（设置，默认 5）的功能或子线索。小故事和只有讨论的进展直接标记已处理，不调用模型。
- 候选故事按文本量分块，每块一次模型调用，输入是故事名、事件标题与截断描述以及已有经验，不含原文。回答中的每条形成依据必须是本次输入、且有来源的事件，否则整块不保存；早于经验形成时间的“应用”被丢弃（真实模型会出现这种引用），其余保留。同一表述的经验合并到已有经验。
- 经验生成后即可读取，标记“自动归纳”。用户可以编辑、合并、删除，与故事调整共用撤销；编辑过的标记“已手动调整”；删除的经验不会因同一表述或相同依据再次生成。
- 经验抽取失败不影响故事和已发布的回顾：活动记录显示“故事已整理，经验整理失败”，可与故事一起重新整理，下一次回顾也会补上。
- 界面：图谱左侧新增“经验”页签；选中经验在右侧查看适用条件、边界、形成依据和后续应用（含所属故事与结果），依据事件可直接打开；编辑、合并、删除、撤销。设置新增“故事参与经验整理的最少事件数”。

验证：

- 新增 `supervision-experiences.test.ts` 4 项：规则候选、应用记录、无新进展零调用、小故事与纯讨论零调用、虚构依据整块拒绝、早于形成的应用被丢弃、编辑保护、删除后不再生成、合并与撤销。工作区新增经验页签测试。监督相关主进程测试 7 个文件 174 项、工作区／活动／设置组件测试 48 项通过；Node/Web 类型检查、相关 ESLint 通过。未运行全量测试。
- 真实数据（第 2 步跨项目开启运行后的数据副本，46 个故事，`npx jiti scripts/experiences-deepseek.mjs`，DeepSeek `deepseek-flash`）：

| 运行 | 候选故事 | 调用 / 耗时 | 经验 | 应用记录 | 跨故事经验 | 依据无来源 | 应用早于形成 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 首轮（应用早于形成时整块拒绝之前的规则） | 31 | 6 / 约 3.9 分钟 | 40 | 71 | 15 | 0 | 5 |
| 修正后 | 31 | 6 / 约 2.7 分钟 | 38 | 53 | 9 | 0 | 0 |

  - 两次再次抽取均为 0 次调用；所有请求都不含来源原文。
  - 修正后 38 条经验中 8 条只有 1 个形成依据。内容基本是这段时间真实形成的工作经验，例如“长材料回顾须完整分块，按成功批次保存进度并支持续作，禁止截断”“能力开关关闭时须阻断后台任务领取与执行，不能只隐藏入口”“提交只纳入本次相关改动，其他未完成改动留在工作区”。
  - 两次运行的经验条目不完全相同，未比较多次运行的一致性；也未逐条人工核对每条经验与依据是否对得上。

边界：经验尚未接入 MCP、心跳建议和时间螺旋视图（桶外经验节点），这些属于第 5 步和视图后续工作。

## 2026-10-02 故事线模型第 3 步：时间螺旋视图

对应[故事线模型改造设计](./storyline-model-design.md)第 3 步与 [3D 概念](../story-graph/3d-concept.md)。

实现：

- 图谱画布标题右侧新增“平铺 / 时间螺旋”切换。时间螺旋视图（`StoryGraph3D.tsx`）读取故事列表与图谱返回的 `attention`：高度为时间，半径为每圈的对话轮次（一圈一个半径，相邻圈差值受限），木片为故事起止，事件按屏幕距离聚合。层级为 全部 › 项目 › 功能 › 子线索，跨项目故事在根层；点击木片进入下一层并在右侧显示故事详情，单个事件选中后显示事件详情。斜俯视／侧视／俯视／自由视角，拖动、滚轮、方向键、数字键、Esc。
- 计算部分在 `story-graph-3d-model.ts`（树、角度、圈长、半径、聚合），渲染只负责显示。圈长从候选档位中选最接近 8 圈且不超过 14 圈的一档。
- Three.js `0.186.1` 作为依赖，组件通过 `lazy` 加载，只在打开时间螺旋时下载（生产构建中只出现在 `StoryGraph3D` 分块）。颜色取现有 `--graph-node-*` 令牌。WebGL 不可用时提示改用平铺视图。
- 2026-10-02 布局调整：画布下方的图例段落和木片、经验列表移除，中间区域只保留图。图例改为工具栏“图例”按钮，点击后浮在画布右上角，可用 X 关闭；圈长（如“一圈 1 天 · 共 13.1 圈”）常驻画布左下角。木片和经验的键盘与读屏入口改为工具栏中的两个选择菜单（共享 `AnchoredMenu` 样式，每项显示名称和事件数、起止或来源→去向）。按钮按当前层级命名，如“项目与跨项目故事 · 6”“功能 · 15”“子线索 · 9”“经验 · 3”，不再使用“木片”这一内部比喻。菜单内边距 4px，菜单项 8px×12px、行间 2px，两个按钮间距 8px；1440 与 390 宽度下文字无裁切，菜单在窗口内。
- 2026-10-03 图谱中间列不再滚动：平铺与时间螺旋都把标题栏以外的高度全部给图。平铺视图的图例、阅读说明移入标题栏“图例”浮层，可见数量常驻画布左下角；“事件浏览”改为单行（上一个、滑块、下一个、位置、当前事件）。图谱行最低 660px，以免平铺图文字小于 11px；更矮的窗口改为页面滚动。Electron 布局测试新增断言：中间列 `overflow: hidden` 且无溢出，图区一直延伸到列底部；1440×1200 下整页无滚动、底部留 33px，图高 625px。真实数据副本下时间螺旋在 700px 行高中填满，无列内滚动。
- 2026-10-03 图谱页顶部的“图谱范围 · 全局”和时间行并入画布标题下方一行（范围 · 时间区间 · 生成时间 · 事件/实体数），刷新改为标题栏图标按钮；标题由“工作的来路”改为“事件与知识”。图谱行因此多出约 40px：1440×900 下整页不再滚动，图高 552px。布局测试新增断言：范围行位于标题下方，图谱上方不再有独立的范围栏。
- 2026-10-03 修复“时间螺旋没有加载成功”：每次重建场景都复用同一个画布，而上一次释放时已对它调用 `forceContextLoss()`，该画布再也拿不到可用的 WebGL 上下文（Three.js 报 `Cannot read properties of null (reading 'precision')`）。开发模式的 StrictMode 双挂载、父组件刷新时传入新的 `attention` 数组都会触发重建，所以打开就失败。现在每次重建创建独立的绘图画布并在释放时移除，原画布只负责焦点和指针事件；`attention` 按内容保持稳定，刷新不再重建场景。复现脚本（StrictMode + 20 次父组件重渲染）修复前首屏即报错，修复后无报错。真实数据副本的 Electron 检查（1440 浅色、390 深色）：画布外无段落和列表，图例浮层位于画布内，选择框逐层打开、视角切换、Esc 返回正常，无报错和横向溢出。

验证：

- `story-graph-3d-model.test.ts` 4 项（树与跨度、圈长档位、每圈一个半径且变化有界、聚合）；工作区、活动、设置组件测试通过；Node/Web 类型检查、相关 ESLint 通过；`electron-vite build` 确认 Three.js 只在懒加载分块中。
- Electron 实测（第 2 步跨项目运行的真实故事数据副本，生产组件）：1440 浅色与 390 深色均无控制台错误、无横向溢出；画布非背景像素约 26%；根层 6 片（5 个项目、2 个跨项目故事中的果蝇神经仿真等），goodbuddy 15 个功能，监督者 9 条子线索；视角切换、Esc 返回、选中故事回调正常；旋转一帧约 1 ms。数据跨 13 天，一圈 1 天共 13.1 圈。

边界：时间切面（第 7 项）、展开视图（第 8 项）、原位分裂动画和桶外经验节点尚未移植；经验（W）要到第 4 步。Three.js 懒加载分块约 1.15 MB。

## 2026-10-02 故事线模型第 2 步：故事归属与用户调整

对应[故事线模型改造设计](./storyline-model-design.md) SL-1～SL-3、SL-5、SL-8 和第 2 步。

实现：

- `supervision-stories.ts`：新表 `supervision_stories`（功能、子线索、跨项目故事，状态、用户调整标记）、`supervision_event_stories`（主故事唯一，另可关联）、`supervision_story_assigned`、`supervision_story_edits`。Schema 54；升级后表为空，已有事件由下一次回顾归属，不重读来源。
- 回顾发布后在同一回顾名额内执行故事归属：只取本范围中尚未归属的当前事件，按项目分块，每块一次模型调用，输入是事件标题、描述和本项目已有故事摘要，不含原文。没有待归属事件时不调用模型。项目来自事件来源；功能、子线索由模型提出；允许“暂不归类”。
- Main 校验每个事件恰好分配一次、主故事属于本项目、子线索有上级功能、结束标记引用本次归入该故事的事件；任一项不符则整块不保存。功能事件数低于“子线索最少事件数”（设置，默认 20）时，子线索并入功能。
- 跨项目关联关闭时，提示词禁止跨项目故事，也不提供已有跨项目故事；开启时项目依次处理，跨项目故事只作关联，不影响主故事的长度和事件数。
- 用户调整：重命名、合并（同项目同层级）、移除（事件回到上级功能或变为暂不归类，不删除事件）、把事件移到同项目其他故事或暂不归类、撤销上一次调整。调整过的故事不会被自动整理改名或标记结束，移除的故事不会因同名再生成。
- 故事归属失败不影响已发布的回顾：活动记录显示“回顾已保存，故事整理失败”并可重新整理；下一次回顾（含无变化）也会补上。
- 界面：图谱左侧新增“故事”页签，按项目 › 功能 › 子线索、跨项目故事列出，显示暂不归类的事件数；选中故事在右侧查看起止、状态、事件，并可重命名、合并、移除、撤销；事件详情可改所属故事。设置新增“功能拆分子线索的最少事件数”。

验证：

- 新增 `supervision-stories.test.ts` 6 项：归属与无变化零调用、长时间空白后接回原故事、不完整／重复／虚构／证据不符的回答整块拒绝、小功能子线索并入、跨项目开关、调整保护与撤销、回顾内执行及失败后重试。`src/main/assistant` 全目录、Story Graph MCP 集成、监督相关 IPC、监督者工作区／活动／设置组件测试均通过；Node/Web 类型检查与相关 ESLint 通过。未运行全量测试。
- 真实数据（第 1 步升级后的本机数据副本，`scripts/stories-deepseek.mjs`，DeepSeek `deepseek-flash`）：
  - 跨项目关闭：437 个当前事件，11 次调用约 4.3 分钟；39 个故事（35 个功能、4 个子线索），396 个事件归入，41 个暂不归类；无事件有两个主故事、无主故事跨项目；11 个“已结束”均引用本故事内的事件；再次归属 0 次调用。
  - 跨项目开启：11 次调用约 6.4 分钟；44 个故事，其中 1 个跨项目故事关联 dgx 与阿里云-国内的 7 个事件；其余检查同上。

观察到的问题（首轮）：

- 功能粒度不稳定：goodbuddy 的发布被拆成 0.13.10、0.13.11、0.13.12、0.13.13 多个功能，两次运行切分不同。
- 监督者相关 77～85 个事件的功能只拆出 0～1 个子线索，模型很少主动建子线索。
- goodbuddy 的 fly-brain 仿真与微信 ClawBot 的果蝇开源项目在开启跨项目后仍未关联。
- 故事起止跨度可以从事件计算，但单个事件的跨度仍多为同一时刻（见第 1 步边界）。

针对上述问题的调整：

- 提示词写明粒度：功能是持续数周的模块、子系统或研究主题；发布、版本、单个缺陷、单日任务不是功能，同一项目的发布与版本同步归入一个功能，版本可作子线索；功能名不含版本号和日期；每个项目通常 3～12 个功能；功能达到“子线索最少事件数”后按子线索放置事件。
- 新功能或跨项目故事的名字去掉版本号、日期后与已有或同批故事相同时，并入已有故事（确定性规则）；被并入那一方的“已结束”标记不生效，避免一个版本结束让整条发布线结束。
- 子线索拆分：每个项目归属完成后，自身事件数跨过“子线索最少事件数”下一个整数倍的功能（每项目最多 3 个）各做一次拆分调用，输入只有该功能名称、已有子线索和模型放置的事件标题与截断描述。只把事件从功能移到子线索；新子线索至少需要 max(3, 阈值/5) 个事件，否则不建；用户移动过的事件和用户调整过的功能不动；被用户移除的同名子线索不重建。功能没有跨过下一个整数倍时不再调用。
- 跨项目开启时，提示词附带其他项目的功能名称、描述和事件数（最多 60 个，不含事件内容），已有跨项目故事附带它已关联的功能名称；回答可用 `links` 把本项目功能和其他项目功能挂到同一个跨项目故事，关联该功能的全部当前事件（只作关联，不改主故事）。关闭时不提供，且 `links` 会被整块拒绝。
- 新故事键接受 `new_1_t1` 这类写法（真实模型在一次回答中这样写子线索键，原先整块被拒）。

调整后的真实数据（同一数据副本，DeepSeek `deepseek-flash`，每次各自从空故事开始）：

| 运行 | 调用 | 功能 / 子线索 / 跨项目 | 归入 / 暂不归类 | 拆分移动 | 版本号命名的功能 |
| --- | --- | --- | --- | --- | --- |
| 首轮 关闭 | 11 | 35 / 4 / 0 | 396 / 41 | — | 有（0.13.10～0.13.13） |
| 首轮 开启 | 11 | 35 / 8 / 1 | 407 / 30 | — | 有 |
| 调整后 关闭 | 12（含 1 次拆分） | 19 / 23 / 0 | 372 / 65 | 18 | 0 |
| 调整后 开启 | 12（含 1 次拆分） | 21 / 23 / 2 | 388 / 49 | 20 | 0 |

- 改善：goodbuddy 发布收敛为一个“发布与版本”／“提交与发布”功能，版本工作成为其子线索；监督者功能拆出 9～11 个子线索（回顾整理与图谱、回顾算法与并发设置、故事线模型与 3D 图谱、活动记录页、自动监督开关与设置等），界面、笔记与画布也拆出子线索；开启跨项目后“果蝇神经仿真”关联了 goodbuddy“本地果蝇神经仿真”与微信 ClawBot“果蝇神经开源项目调研”（16 个事件），另有“Agent 实例生命周期与回收”关联 goodbuddy 与 dgx（24 个事件）。两次运行都无事件有两个主故事、无主故事跨项目、无小功能子线索，再次归属 0 次调用。
- 未改善或变差：暂不归类增多（关闭 41→65，开启 30→49），模型在功能变宽后把更多零散事件留空，未逐条核对是否合理。首轮的 dgx＋阿里云跨项目故事这次未出现。子线索大多在归属调用中直接建出（关闭 18、开启 20 个事件由拆分调用移入子线索），拆分调用每次运行只触发 1 次。关闭、开启各只成功跑了一次，多次运行的切分是否一致未比较。
- 单元测试：`supervision-stories.test.ts` 新增 3 项（版本名功能合并且不误结束、拆分调用的触发上限与用户事件保护及整块拒绝、跨项目功能列表与 `links` 关联及关闭时拒绝），共 9 项；与 `supervision-timeline.test.ts` 合计 13 项通过；Node 类型检查与相关 ESLint 通过。
- 失败：另有两次运行中途失败、未完成。一次是开启跨项目时模型把“已结束”标记引用到未归入该故事的事件，整块被拒，导致整次归属失败（已在提示词中强调证据事件须归入同一故事，之后的开启运行通过）；一次是上述 `new_1_t1` 键格式，已放宽校验并加单元测试，但放宽后未再用真实模型重跑。严格校验下单块被拒会让整次归属失败，仍需重试才能补上。

## 2026-10-02 故事线模型第 1 步：共享时间线

对应[故事线模型改造设计](./storyline-model-design.md) SL-6、SL-7 和第 1 步。

实现：

- 处理进度改为一条共享时间线：`review_checkpoints` 的监督阶段只用 `scope = 'timeline'`，项目、全局和多项目组合共用。同一来源版本在任一范围成功发布后，其他范围不再提取；范围只决定读取和展示哪些来源。旧的按范围进度在升级时合并，不重读已处理内容。
- 事件新增 `started_at`、`ended_at`、`project_id`、`superseded_by`，来源新增 `source_key`、`source_revision`（`supervision-timeline.ts`）。起止时间和所属项目按事件引用的来源记录计算，不由模型给出；来源跨多个项目时 `project_id` 为空。同一来源版本的重叠区间被后来的结果重新提取时，旧结果中的事件标记为已被替代，图谱和 MCP 只读当前事件，历史结果快照不变。
- 图谱按范围读取共享时间线上的当前事件、实体、关系和来源，并返回 `attention`：按小时统计的消息轮次与正文量，只表示投入集中程度。
- 新增设置“跨项目关联”（`supervisionReview.crossProject`，默认关闭）。关闭时，每批只把本项目已有的实体作为候选，不同项目的内容不会合并为同一实体；开启后候选来自全部项目。运行开始时冻结到本次配置。
- Story Graph MCP：全局范围可以读到各项目的当前事件；来源可从运行范围、全局或包含该来源项目的项目范围读取。
- Schema 53。

验证：

- 新增 `supervision-timeline.test.ts`：项目回顾后全局只提取其他项目的来源，相同项目再次回顾不调用模型；起止时间和项目来自来源；重新整理与项目回顾重叠后当前事件不重复；跨项目开关决定候选；Schema 52 升级合并进度和重复事件。`src/main/assistant` 全目录 28 个文件 324 项、Story Graph MCP 集成、监督相关 IPC 15 项、设置组件均通过。Node/Web 类型检查、相关 ESLint、`git diff --check` 通过。未运行全量测试。
- 真实数据（`scripts/timeline-deepseek.mjs`，用 SQLite 在线备份复制本机 2.2 GB 数据库，原库只读）：升级 2.0 秒，`integrity_check` 为 ok。原有 423 个事件全部得到起止时间与项目；13 个两次回顾重复提取的事件被标记替代，当前 410 个（goodbuddy 358、默认项目 28、dgx 17、微信 ClawBot 5、阿里云-国内 2）；全局图谱返回 67 个小时段、790 轮对话的密度。
- 真实模型（DeepSeek，`deepseek-flash`）：对 goodbuddy 最近 2 小时的 37 个来源做项目回顾，4 个批次加 3 次导航汇总，共 7 次请求，新增 27 个事件，起止时间都在区间内，未关联到其他项目的实体；再次项目回顾和同区间全局回顾均为无变化，0 次请求，全局重新提取的项目来源为 0。

边界：

- 这个 2 小时区间没有其他项目的消息，所以“全局只补其他项目”只在合成测试中验证过。
- 模型通常让一个事件只引用一条消息，所以真实数据里的事件起止时间多数是同一时刻。按故事计算跨度要等第 2 步的故事归属。
- 测试脚本把单次输出上限设为 8,192 token 时，一个批次的输出被截断，导致 JSON 无效。上限调到 32,768 后通过。产品路径不设这个参数，具体由 Runtime 的提供商配置决定。

## 2026-09-30 心跳职责收敛与监督建议

对应 FR-S4、FR-S12、US-S32、US-S33，规则见[心跳职责与介入](./logic-design.md#心跳职责与介入目标设计)。

实现：

- `HeartbeatService` 不再读取来源或调用模型。领取计划后立即完成自身运行，再通过 `review` 触发共享的 `SupervisorService.run({ trigger: 'heartbeat' })`；审查结果 `no_change` 时标记心跳为无变化。计划领取、单次补跑、单回顾排队和失败记录沿用原有机制。
- 手动“回顾”默认增量：`supervisionRunRequestSchema` 新增可选 `reanalyze`，`isIncrementalReview` 决定是否读取、推进 `review_checkpoints`。只有 `reanalyze: true` 重读区间，且不推进也不重置共享进度。自动检查不再续跑用户主动暂停的回顾，改为新建运行处理未提交来源。
- 计划新增 `intervention`（`suggest` / `memory`，默认 `suggest`）。`supervision-suggestions.ts` 从本次发布结果按规则挑选候选：批次未决事项、`revised` 实体变化、`contrasts` 关系、由至少三处不同原始来源支持的未确认实体。没有候选时不调用模型；有候选时 `supervision-suggester.ts` 只把候选文本交给一次建议调用，不读原文。待处理建议不重复，已处理建议仅在依据变化后再次提出。
- 建议失败写入 `heartbeat_runs.suggestion_status/error`，图谱和进度保留；活动页显示“回顾已更新，建议生成失败”并可单独重试。
- 接受未决事项生成暂停任务，接受候选约定确认为长期背景（记忆）并确认对应实体；分歧和修订标记已核对。
- Schema 50：`heartbeat_configs.intervention`、`heartbeat_runs.suggestion_status/suggestion_error`、`supervision_suggestions` 表。升级时把旧心跳报告中仍为 `proposed` 的记忆迁入为待确认约定，不确认、不删除；旧报告只读保留。
- 界面：工作回顾主按钮改为“回顾”，“更多 → 重新整理…”经确认后执行；计划 Modal 增加“介入方式”；自动监督页用“监督建议”替代成功率、趋势、记忆/行动建议和运行审计，建议可查看依据、打开会话、在图谱中查看；设置移除心跳报告超时；导航角标统计待处理建议。

验证：

- 定向单元与集成测试：`src/main/assistant`、`src/shared`、`src/preload` 共 589 项；`src/main/ipc.test.ts` 心跳与监督相关 29 项；Renderer 监督者、自动监督、活动、设置相关组件测试及 `App.test.tsx` 全文件均通过。新增覆盖：手动增量与重新整理不动进度、不续跑已暂停回顾、候选规则与去重、忽略后仅新证据重提、建议失败隔离、IPC 启停门控、Schema 49 升级迁移。
- Electron 布局：`GOODBUDDY_SUPERVISOR_RECAP`、`AUTOMATIC_OVERVIEW`、`ACTIVITY`、`PLAN_MODAL` 场景通过，覆盖 1440/390px 下监督建议、介入方式字段、重新整理确认和工具栏两行布局，无横向溢出。
- 真实模型（DeepSeek，`deepseek-flash`，隔离 SQLite，`scripts/heartbeat-deepseek.mjs`）：首次心跳 1 次回顾调用 + 1 次建议调用（建议输入约 1,150 字符，不含原文），生成分歧、修订、未决事项三条建议且依据均指向本次来源；无变化心跳与默认手动回顾均 0 次调用；追加一条消息后只处理 1 个来源，复用全部 5 个既有实体，再调用 1 次回顾、1 次建议。共 4 次付费请求。
- 未运行全量测试。

边界：主动介入（会话级实时）未实现，界面不显示；项目与全局仍各自维护处理进度（US-S31），已由 2026-10-02 的共享时间线取代。

## 2026-09-28 Story Graph 只读工具

对应 FR-S11、US-S28 至 US-S30 的 D1 读取实现。输入、分页与版本语义由[专项设计](./story-graph-mcp-design.md)负责。US-S31 的跨范围事实复用和 memory 读取切换仍待实现。

实现路径：

- [共享工具合同](../../../src/shared/story-graph-tools.ts)定义 `story_graph_search`、`story_graph_get_context`、`story_graph_read_source`。内置目录与能力设置支持 Model、OpenCode、Continue、DeepSeek Harness 分配；应用关闭时 Main 不签发图谱读取权限。
- [只读 SQLite 投影](../../../src/main/assistant/story-graph-reader.ts)读取精确 scope 下的历史结果、当前对象、事件、变化、关系、来源和成功叶子描述。保留旧决定与修订依据，确认状态和有效性分别返回，未知有效性不按时间推断。没有新增 schema、业务写入或模型调用。
- [Main gateway](../../../src/main/agent/knowledge-mcp-gateway.ts)在发现、读取前和返回前复核监督者开关及 Runtime 分配；IPC 将项目和 Runtime 固定到请求。Model 和 Harness 代理、本地 MCP、原生客户端共用此入口。Harness 的目录、scope schema 转换及 Host Ask 执行钩子均已接通。
- 远程沿用 `ProtocolRemoteRuntimeChannel`、`MainImageToolSession`、`AgentImageToolMcp` 和 `RuntimeAcpBackend` 的现有工具通道。Ask 可以只有图谱描述，没有图像生成描述。OpenCode 根／子会话仅放行当前端点；Continue Ask 保留 Main 会话 MCP，并由原生只读工具名和 Main 双重校验。
- 对象页为 10／50 项，正文页为 4,000／8,000 码点（默认／上限）。Context 用带位置的 JSON 片段续读长对象；游标绑定过滤、scope 和读取修订，变更后返回 `stale_cursor`。来源默认读保存片段；显式 current 通过 locator 读当前记录，version 仅接受可验证的现存版本。知识引用片段不声称是整份知识原文，来源迁出项目、删除、未知历史和响应过大均有明确结果。

定向验证：

```text
npx vitest run src/main/assistant/story-graph-reader.test.ts src/agent-daemon/story-graph-integration.test.ts src/main/assistant/supervision-production.test.ts src/main/capabilities/capability-service.test.ts src/main/ipc.test.ts src/main/remote-agent/protocol-remote-runtime-channel.test.ts src/agent-daemon/runtime-acp-backend.test.ts src/agent-daemon/continue-acp-helper.test.ts src/agent-daemon/opencode-subagent-plugin.test.ts src/main/agent/native-terminal-client.test.ts
```

10 文件、337 项通过，1 项既有条件测试跳过。覆盖真实 SQLite、HTTP MCP、Main／Agent 消息往返、协议准备和释放、四个 Runtime 的 IPC 项目绑定、Supervisor 关闭后不再读取、取消、来源删除／迁移、旧游标、Unicode 正文续页、超长响应及 A → B 修订后 C 仍为选项。冷启动审查发现 current 来源读取依赖运行回顾后才注册的 SQLite 函数，改为按现存 context 直接计算同一修订；新连接回归通过。最终读取相关 3 文件、28 项再次通过。

其他受影响路径也已定向验证：

- `continue-runtime.test.ts`、`opencode-runtime.test.ts`、`deepseek-harness-runtime.test.ts`、`native-client-coordinator.test.ts`、`protocol-remote-runtime-channel.test.ts`、`knowledge-mcp-gateway.test.ts`：6 文件、243 项通过。
- `goodbuddy-harness-control-plane.test.ts`、`continue-host-adapter.test.ts` 及相关桥接／读取测试：6 文件、98 项通过。`model-tool-provider.test.ts`、能力设置及 Continue helper 组合：3 文件、92 项通过。
- `npx vitest run src/main/agent/deepseek-harness-acp-e2e.test.ts -t "reads Story Graph"`：1 项通过、13 项按名称跳过。真实受控 Harness Host 经 ACP 和 Main 代理执行 Ask／Execute 读取，随后关闭监督者并确认工具移除；推理使用测试实现，没有外部模型请求。
- `npx tsc --noEmit -p tsconfig.node.json`、`tsconfig.agent.json`、`tsconfig.web.json` 均通过；最终 Main 类型检查再次通过。本次变更的 TypeScript 源码和测试定向 ESLint 通过，`git diff --check` 通过。

### Linux Host 验证

[SSH 探针](../../../scripts/story-graph-host-probe.ts)从当前源码临时打包，在共享 Linux x64 Host 运行 `AgentImageToolMcp`、`AgentOwnedAcpPrompt` 和 `ContinueHostAdapter`，使用 Host 安装的 OpenCode 和 Continue（1.5.47）。桌面启动隔离内存 SQLite、Main gateway 和 `MainImageToolSession`，通过 SSH 搬运工具通道消息；用户数据库、模型凭据和正文库没有复制到 Host。Host 临时运行目录在结束时清理。

探针通过：HTTP 发现三个只读工具、搜索／上下文／来源读取及分页、`as_of` 拒绝、OpenCode Ask／Execute、Continue Ask／Execute 的实际工具调用，以及关闭后的发现和旧会话调用拦截。成功探针有 10 次本机确定性推理请求，其中 2 次为 Runtime 标题生成，桌面读取 10 次，付费调用 0 次。RPC blob framing 与 prompt 生命周期另由上述 `runtime-acp-backend` 和 `protocol-remote-runtime-channel` 测试覆盖；该 SSH 探针使用标准输入输出承载工具消息，没有执行安装包升级或完整桌面 UI 操作。

复跑时在仓库使用 esbuild 将脚本输出到临时目录，再通过已有 SSH 身份传至 Host 的 GoodBuddy 测试目录。桌面命令参数为：

```text
node <local-probe.cjs> <ssh-host> <remote-probe.cjs> <host-opencode-path> <host-continue-cn.js-path>
```

### 保留边界

没有执行全量测试、付费模型请求、提交、推送或发布。真实模型如何根据冲突证据形成最终建议、跨平台安装包和完整桌面 UI 仍未在本次验收；没有据此声明 US-S28 的建议质量已验证。查询目前同步扫描所选 scope 的已发布事实，大库延迟和运行中断粒度没有性能验收。`replaces`／`contradicts`、历史有效期、`as_of`、跨 scope 事实复用和 memory 消费切换均没有伪造实现；已有记忆与 checkpoint 保留。中文设计扫描无阻断项，复核项是时间、范围和证据限制，按技术含义保留。

## 已验证

### 2026-09-26 单次执行与取消集成复核

对应 FR-S4、FR-S6、FR-S10、US-S24、US-S26。复核当前 Main、SQLite、IPC、Preload 与 Renderer diff，确认手动新建/继续遇到占用立即拒绝，自动回顾等待；取消立即落库，执行位置保留至并行批次及 Runtime 清理结束。UI 在此期间显示正在取消，X 仅关闭提示；已取消运行不能继续，也不会被自动恢复。实现合同见[单次执行与取消](./technical-design.md#单次执行与取消)，界面见[UI 设计](./ui-design.md)。

发现并修复一个可达问题：活动页等待整个 `resume` 请求结束才释放操作锁，继续运行后的暂停和取消按钮因此一直禁用。现在发出继续请求后释放提交锁，独立处理完成/失败，Main 仍保证唯一执行。新增回归在修复前因暂停按钮禁用而失败，修复后验证继续中的取消、停止提示，以及原继续请求返回时不清除后续取消操作的状态。

本轮验证：

- `npx vitest run src/renderer/src/SupervisorActivity.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx`：38 项通过，包含上述新增回归、取消清理期间的状态、重新进入页面、手动重复提示及 X 不取消。
- `npx vitest run src/main/assistant/supervision-review.test.ts src/preload/supervision-activity.test.ts src/main/ipc.test.ts -t "reserves before setup|persists cancellation|allows a new review after|cancels navigation|projects cancellation|wakes waiting automatic|production supervision IPC cancels|supervision"`：27 项通过、144 项按名称跳过；其中 Preload 文件未命中过滤，另用 `npx vitest run src/preload/supervision-activity.test.ts` 单独验证，1 项通过。
- `npx eslint src/renderer/src/SupervisorActivity.tsx src/renderer/src/SupervisorActivity.test.tsx` 通过；本轮文件的 `git diff --check` 通过。中文新增内容按 `deai-writing` 清单人工审校，文档链接目标已核对。

上述测试使用隔离 SQLite、生产 handler/工厂及可控 Runtime、Renderer API 替身；本轮未运行 Electron 端到端、全量测试或类型检查，真实模型调用 0 次。用户提供的后端与前端实现代理测试通过记录作为先前证据，不并入本轮计数。远程不受影响的依据是 `ipc.ts` 生产工厂调用 `resolveRequestRuntime({ workMode: 'ask' })`，无项目、Runtime 选择或执行空间，解析直接返回桌面默认 Runtime；不进入 SSH/Agent 路径，未修改远程协议或取消实现。未运行远程实测，未改动其他工作的 Runtime/package 文件，未提交。

### 2026-09-26 移除回顾自动时间预算暂停

对应 FR-S4、FR-S6、FR-S10。生产服务移除提取循环和导航合并中的整次执行期限判断，持续处理至完成；已保存运行中的 `executionSeconds` 继续兼容读取，但不再控制暂停。设置页移除该控件，中英文帮助和活动配置改为持续处理说明。单次模型超时、共享并发、逐批保存、主动暂停及失败续跑保持原路径，具体合同见[生产接线](./review-scheduling-design.md#0-生产接线与剩余边界)。主动暂停仍中断在途请求，仅保留此前已保存批次。

`npx vitest run src/main/assistant/supervision-review.test.ts src/renderer/src/SupervisionReviewSettings.test.tsx`：13 项通过。受控时钟超过保存的执行预算后，三个叶子及两个导航合并仍完成并发布；另验证主动暂停后复用成功批次和原分块配置、中英文设置不再出现整理时长控件。测试使用隔离 SQLite 和可控摘要器，不代表真实模型长时间运行实测。

`npm run typecheck`、六个修改 TS/TSX 文件的定向 ESLint 和 `git diff --check` 通过。未运行全量测试，真实模型调用 0 次。核对 Main 的生产工厂接线，监督使用不携带项目的 `resolveRequestRuntime({ workMode: 'ask' })`；本次仅改变桌面回顾编排，不修改 Agent、远端 Runtime 或桌面到 Agent 协议。未提交或推送。


### 2026-09-24 长摘要与内容区对齐

针对全局七天回顾的 `summary max 2000` 报错，代码确认导航输出 schema 的 `max(2000)`、服务层对叶子及导航的二次 2000 字符检查，以及模型提示词中的同值要求。另发现监督旧摘要通过 SQL `substr` 和 JavaScript `slice` 截断。以上监督路径限制已移除；生成内容和事实集合的合同见[生产调度合同](./review-scheduling-design.md#已接入的调度与存储)。未读取本次 16:03 失败的原始模型响应，不能据此声明该运行的具体失败节点。

生产工厂回归使用隔离 SQLite 和离线 Runtime 流，验证 14,000 字符的叶子及导航摘要完整进入合并输入、存储、历史读取，发布失败后以已保存节点恢复且不再请求模型，叶子长描述仍进入最终图谱。单次超过 100,000 字节的响应明确失败，保留续跑位置。共享契约另覆盖原字段及数组数量边界，仍拒绝导航事实和叶子缺字段；旧身份兼容、跨范围拒绝和六叶合并恢复测试继续通过。IPC 暂停/继续测试改用 3,600 字符摘要，并修正已有 `persistedId` 提示词断言为当前 `candidateRef` 合同。

布局采用共享阅读、dashboard 宽度，范围、工具栏、历史和结果的对齐规则见[UI 设计](./ui-design.md#应用入口)。真实 Electron 加载生产 React 组件，使用隔离 fixture 验证 2000、1440、1024、390px 的浅深主题，覆盖长摘要、活动、运行中、失败共 32 组，并保存 8 张正文末尾截图。无页面横向溢出，正文末尾保留，宽屏阶段行低于 40px，刷新紧邻筛选。另运行既有活动分支，验证原生键盘展开、完整错误滚动、六个叶子及 12 批分页。已人工查看宽窄屏、浅深主题、运行/失败、正文末尾及批次树截图。

截图分别保存在本机临时目录 `opencode/supervision-content-layout` 与 `opencode/supervision-content-activity`。复现命令为设置 `GOODBUDDY_SUPERVISOR_CONTENT_LAYOUT=1` 或 `GOODBUDDY_SUPERVISOR_ACTIVITY=1` 后运行 `npx vitest run tests/supervisor-layout.electron.test.ts`，可用 `GOODBUDDY_SUPERVISOR_ARTIFACTS` 指定保留目录。模型调用 0 次，未改写用户数据库、运行全量测试或提交。

验证记录：首轮服务、分块、历史和工作区 6 文件 68 项通过；补充共享契约、生产工厂、活动存储/preload、心跳中心及工作区共 8 文件 112 项通过。`npx vitest run src/main/ipc.test.ts -t 'supervis'` 为 17 项通过；修正测试等待的 TypeScript 类型后，暂停/继续单项再次通过。最终 `npm run typecheck`、本轮修改 TS/TSX/MJS 的定向 ESLint 和 `git diff --check` 通过。中文变更按 `deai-writing` 清单人工审校。

### 2026-09-24 活动阶段、批次层级与导航输出修复

对应 FR-S4、FR-S6、FR-S10、US-S26。活动记录改为紧凑运行摘要、实际阶段、恢复操作、折叠错误、按需批次层级和次要配置详情。阶段存入既有运行 JSON；叶子与导航分别校验，叶子缺数组仍失败。当前字段与缺失数据规则见[生产调度合同](./review-scheduling-design.md#已接入的调度与存储)，布局见[活动设计](./ui-design.md#活动)。

只读检查 portable 原库的最新失败运行 `f6800335-5765-4163-9f55-a30c8ab18a94`，确认 32 个来源、剩余 0、6 个成功批次、4,515 字符和 1 个已保存导航节点。错误仅包含 `events / entities / entityChanges / relations` 四个缺失数组。旧代码把导航响应交给叶子 schema，且提示词同时要求“只返回摘要字段”和“事实数组必须为空”，合同矛盾已确认。原始失败响应和阶段没有保存，因此该次失败发生在导航解析仍属有数据支持的推断，不能声称取回了原响应。

使用 SQLite 一致性备份和关联笔记副本执行 `scripts/supervision-navigation-replay.ts`。仅私有副本初始化；第一次因缺少关联笔记停止，补齐后完成。生产工厂继续同一 run，复用已存导航节点，4 次离线响应完成剩余合并及发布，6 个叶子逐项未变。回放文本来自该 run 已保存的成功导航，只保留 summary、changeDigest、openItems，以验证缺数组的合法导航形状；它不验证新摘要质量，也不是原失败响应回放。原库只读，原失败 run 前后相同，付费模型调用 0 次。

本轮验证：

- `npx vitest run src/main/assistant/supervision-production.test.ts src/main/assistant/supervision-review.test.ts src/main/assistant/supervisor-service.test.ts src/main/assistant/supervision-activity.test.ts src/preload/supervision-activity.test.ts src/renderer/src/SupervisorActivity.test.tsx src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx`：8 文件、116 项通过。包含六叶零剩余后的合并失败与继续、发布失败后无模型继续、缺数组叶子拒绝、未知来源/实体拒绝、实际阶段呈现、旧阶段缺失、错误与配置折叠、树分页及读取失败重试。
- `npm run typecheck` 和本轮变更 TS、TSX、MJS 文件的定向 ESLint 通过；未运行全量测试。
- `GOODBUDDY_SUPERVISOR_ACTIVITY=1` 下运行 `npx vitest run tests/supervisor-layout.electron.test.ts`：1 项通过。真实 Electron 加载生产 React 组件，以多项目、多会话的隔离数据覆盖 1440×1000、390×1000 和浅深主题，分别截取运行摘要、错误展开、批次树，共 12 张截图。检查原生 Enter 展开、240px 错误滚动、全部六个已保存叶子及 12 批跨页读取，无横向溢出和控制台错误。失败运行摘要高度为桌面 366px、窄屏 476px，两主题一致；已人工查看截图。

私有数据库、回放报告及截图位于 `C:/Users/jiang/AppData/Local/Temp/opencode/activity-incident-20260924/`，截图测量文件为 `screenshots/review-activity-measurements.json`。收尾检查修正成功返回 coverage 沿用合并前阶段的问题，3 个生产服务测试文件共 33 项复验通过，活动与返回结果均使用发布阶段投影。`git diff --check` 通过，仅提示现存行尾转换。中文文档经 deai-writing 扫描与人工复核，本轮新增段落无阻断项；全文件扫描的 7 项阻断均在既有非本轮段落，未改动其内容。

历史缺失 phase 仍显示未记录；树只列成功批次，没有持久化的单任务失败/在途状态，项目和会话数量仅针对本页。收集与发布仍为同步 SQLite 阶段，不保证轮询可见。未修改 Agent、远程 Runtime、传输或凭据逻辑；原暂存及未暂存修改保留，未暂存、提交或替换 portable 构建。

### 2026-09-24 工作回顾与自动报告分区

对应 FR-S2、US-S22 至 US-S24。工作回顾仅阅读统一监督结果，历史选择和精确结果图谱入口移到正文前；手动新回顾控件保持内联，390px 下使用双列。结果常显生成时间、覆盖区间和范围，正文按原始段落及已有结构化字段展示，限制阅读宽度。新请求配置与运行状态不改写旧结果。自动报告、记忆与行动建议全部归入自动监督，保留展开、确认/忽略、带入对话、标记完成和每次追加 20 条；移除独立最近报告副本。五页签当前布局以 [UI 设计](./ui-design.md#应用入口)为准，下方各轮记录保留为历史证据。

- `npx vitest run src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx src/renderer/src/SupervisorActivity.test.tsx`：66 项通过。覆盖非空结果与空自动报告不矛盾、完整建议操作、长内容展开与分页保留、历史精确 ID、变更新请求范围不重标旧结果、运行中保留正文和活动入口。
- `npx vitest run src/renderer/src/App.test.tsx -t 'graph navigation opens the pinned sidebar result|keeps heartbeat plans independent|saves Supervisor timeouts'`：3 项通过，284 项按名称跳过。校正已有设置保存测试的旧字段选择器，保留实际 App 接线验证。
- `npm run typecheck` 与本轮修改的 Renderer、测试及 Electron driver 定向 ESLint 通过。中文 UI 文档经 deai-writing 扫描，无阻断项；复核项涉及既有状态与实现边界，保留事实限定。
- 设置 `GOODBUDDY_SUPERVISOR_RECAP=1` 后运行 `npx vitest run tests/supervisor-layout.electron.test.ts`：1 项通过。现有生产组件 fixture 覆盖 1440×1100、390×1100 的工作回顾与自动监督，含两类结果均非空、自动报告为空、两者均空，共 12 个页面场景；另验证历史结果运行中保持可见及活动跳转。每页一处刷新、横向溢出及正文宽度断言通过。

截图与 `recap-measurements.json` 保存在 `C:/Users/jiang/AppData/Local/Temp/opencode/supervisor-recap/`。已人工查看桌面与窄屏正文、运行中的历史结果、自动报告展开、建议操作和独立空态截图。此次验证使用隔离 fixture，未读取用户数据库，模型调用 0 次，未运行全量测试；未修改 Main、Preload、数据库、Agent 或远程 Runtime。保留已有暂存和未暂存修改，未暂存或提交。

### 2026-09-24 自动监督概览归属修正

对应 FR-S2、US-S22 至 US-S24。当前状态、范围与刷新、成功率、记忆、洞察、行动指标、报告趋势和心跳运行审计已整体移到“自动监督”，与计划列表同页。当前状态下只保留计划列表的创建按钮和未配置说明，点击直接打开原 Modal。活动页只显示统一监督活动、进度、详情及结果入口，计划 ID 筛选、清除、分页和精确结果跳转沿用原路径；活动筛选不改变自动监督概览。当前归属见 [UI 设计](./ui-design.md#应用入口)，下方旧方案的截图与测试记录保留为历史证据。

- `npx vitest run src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisorActivity.test.tsx`：48 项通过。覆盖空/非空时整块归属、唯一创建入口、独立刷新回调、原 Modal 的 X/footer/关闭保护、计划操作、审计分页、同名计划筛选和结果跳转。
- `npx vitest run src/renderer/src/App.test.tsx -t 'keeps heartbeat plans independent of the active project'`：1 项通过，286 项按名称跳过，保留实际 App 的跨项目计划列表与暂停计划 Modal 保存验证。
- `npm run typecheck`、本轮修改的 `HeartbeatCenter.tsx`、`HeartbeatCenter.test.tsx`、`supervisor-layout-driver.mjs` 定向 ESLint 通过；`git diff --check` 无空白错误，仅提示现存行尾转换。
- 设置 `GOODBUDDY_SUPERVISOR_AUTOMATIC_OVERVIEW=1` 和产物目录后运行 `npx vitest run tests/supervisor-layout.electron.test.ts`：1 项通过，约 10 秒，仅运行本轮范围。现有生产组件 fixture 覆盖浅色 1440×1100、390×1100，空/非空计划与自动监督/活动共 8 个页面场景；检查整块归属、唯一创建按钮、横向溢出、原 Modal 打开关闭及精确计划活动筛选。

截图和 `automatic-overview-measurements.json` 位于 `C:/Users/jiang/AppData/Local/Temp/opencode/supervisor-automatic-overview-20260924/`。已查看桌面、窄屏空/非空计划、活动及滚动后的趋势和运行审计截图；桌面指标四列、窄屏单列，内容无横向裁切，活动页无重复心跳列表。本轮中文修改按 deai-writing 清单人工审校。未运行全量测试，模型调用 0 次，未读取用户数据库；未修改 Agent/远程 Runtime、Modal 实现或共享样式，保留已有暂存和未暂存修改，未暂存或提交。

### 2026-09-24 真实失败运行身份修复

只读定位到 `dist/GoodBuddy-windows-x64/data/assistant.sqlite` 中的运行 `db9902ab-22c8-4aae-86ae-7850bfc07b76`。Roaming 库不含该运行。原运行是全局手动回顾，范围为 2026-09-17 14:33:02 至 09-24 14:33:02，开始于 14:33:02，失败于 14:44:52（本机 UTC+8）。保存配置为分页 50、批次文本量 8000、消息数 20、执行预算 300 秒、模型超时 240 秒、并发 1；清单 32 个来源，成功批次 0。

原错误指向 `entities[0].persistedId` 的 UUID 校验。原始模型响应未保存，诊断文件没有该次响应，无法确认原错误值及 710 秒耗时的模型、排队、重试分解。只读候选检查发现 15 个旧实体均使用文本主键；隔离真实调用再次证明，即使模型选择提供的候选，旧主键仍会触发严格 UUID 校验。修复采用候选短引用、Main UUID 别名及旧键精确映射，详细规则见[技术设计](./technical-design.md)。

通过 SQLite 一致性备份复制数据库和关联笔记文件，仅隔离副本运行初始化及生产工厂 `createProductionSupervisorService`、`ModelAgentRuntime`、批次事务和结果保存。首次隔离启动因缺少笔记文件停止，付费调用 0 次；补齐副本后开始模型验证。使用 `.env.deepseek.local` 的 `deepseek-flash`，总计 3 次 HTTP 请求，无自动付费重试或模型回退：

| 验证 | 本机开始时间 | HTTP | 响应耗时 | 结果 |
| --- | --- | --- | --- | --- |
| 原运行首叶提取 | 14:53:57 | 200 | 5.994 秒 | 首次暴露旧键校验失败，响应私存；修复后缓存复验并保存 |
| 真实来源有界回顾 | 14:58:25 | 200 | 4.445 秒 | 2 个来源、402 字符、1 批，完成并发布 2 个实体 |
| 同一来源候选复用 | 14:58:30 | 200 | 4.703 秒 | 完成并复用 2 个既有实体 |

缓存复验要求请求除 Runtime 当前时间外一致，没有新 HTTP。隔离副本中原失败 run 保存 1 批、3 个精确匹配的原文片段、490 字符及 3 个完整来源位置后主动暂停；32 个来源还剩 29 个，不冒充原全局回顾已完成。两个有界回顾分别完成结果发布，实体总数保持 15。手动回顾不写自动检查用的 `review_checkpoints`。只读复核原 run、来源清单及批次逐项未变；副本完整性检查通过，原有 1 个受保护实体保持不变。

私有产物在 `C:/Users/jiang/AppData/Local/Temp/opencode/supervision-incident-real-20260924/`：`incident.private.json`、`candidates.private.json`、3 份请求与 SSE 响应、`live-metrics.json`、`audit.json` 和副本 `assistant.sqlite`。原库只读打开，无初始化、迁移或业务写入；原失败状态及原有数据保留。验证脚本为 `scripts/supervision-incident-{inspect,launch,audit}.cjs` 与 `scripts/supervision-incident-live.ts`，重复付费启动受检查限制。

定向 7 文件共 47 项测试、`npm run typecheck`、本轮改动文件 ESLint 和 `git diff --check` 通过，后者仅提示现存行尾转换。回归包含真实旧键形状、严格 UUID 别名、空值和占位符的新事实保留、未知候选/跨 scope 拒绝、确认字段及图谱端点保护、失败后成功叶子不重算，以及中英文可展开错误详情。活动页显示本地化失败原因，技术错误保留在可选择文本的折叠详情；进度与设置不再直接展示 UTF-16、Unicode 或共享池术语。新增中文文档按 deai-writing 清单人工复核。未运行全量测试，没有提交、暂存或构建替换应用。此修复属于桌面监督身份边界，未修改 Agent 或远程 Runtime 执行实现；正在运行的 portable 和 D 盘安装版均需包含新源码的构建并重启后才会生效。

### 2026-09-24 计划 Modal 标题与操作区统一

对应 FR-S2、US-S22 至 US-S24。`HeartbeatSettings` 复用既有 `custom-task-dialog__header/content/actions` 和按钮样式，标题在左、带本地化可访问名称及工具提示的 X 在右，取消与保存位于右对齐 footer。采用共享 Grid 的固定标题、滚动正文、固定操作区，没有新增 Modal 框架或页面专属 CSS。共享规范见根目录 [表单 Modal](../../../UI-DESIGN.md#615-表单-modal)，计划交互见[自动监督设置](./ui-design.md#自动监督设置)。

本轮验证：

- `npx vitest run src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/CustomTaskDialog.test.tsx`：50 项通过。覆盖中英文创建/编辑结构、X/取消/Escape/遮罩的干净关闭与未保存确认、Tab 循环、焦点恢复、提交锁定、失败草稿及暂停计划保存重试。
- `npx vitest run src/renderer/src/App.test.tsx -t 'keeps heartbeat plans independent of the active project'`：1 项通过，286 项按名称跳过；验证实际 App 的暂停计划编辑提交、Portal 和背景隔离恢复。
- `npm run typecheck` 通过；本轮修改的 Renderer、翻译和 Electron driver 文件定向 ESLint 通过；`git diff --check` 无空白错误。
- `GOODBUDDY_SUPERVISOR_PLAN_MODAL=1`、`GOODBUDDY_SUPERVISOR_ARTIFACTS=C:/Users/jiang/AppData/Local/Temp/opencode/supervisor-plan-modal-standard` 下运行 `npx vitest run tests/supervisor-layout.electron.test.ts`：1 项通过，约 13 秒。创建/编辑 × 浅/深色 × 1440×1100、390×1100、390×480 共 12 个截图场景，测量无横向溢出、标题与底部按钮不随正文滚动，关闭及底部操作可命中；原生 Shift+Tab、Enter、Escape 验证焦点循环、取消确认和返回编辑。首次两次运行暴露测试驱动的 Enter 字符事件缺失及窗口焦点不稳定，补充字符事件和输入前显式聚焦后通过。

截图与 `plan-modal-measurements.json` 保存在上述产物目录。已查看宽窗口、390px 单列及短窗口的浅深主题创建/编辑截图，X 保持右上、取消与保存保持右下，短窗口只滚动正文。fixture 使用现有五页签和生产 React 组件，未读取用户数据库；模型调用 0 次。未运行全量测试，保留原暂存区与工作区改动，未提交或推送。

### 2026-09-24 监督者文案整理

设置帮助删除“提供商 RPM、TPM、Retry-After 控制及费用预算尚未实现”，保留执行软预算到期后保存正在处理的批次、暂停和从活动记录继续的说明。活动说明删除人工修改审计缺失提示；计划帮助改为选择每日或每周时间、保存并启用后运行。图谱说明实体状态以所选回顾结果为准，事实详情提示展开批次并对照来源核对模型内容。中英文同步，不承诺全局限流或完整语义识别。

已检查监督者设置、帮助、空态、错误展示及相关测试。真实运行错误、失败、超时、暂停和来源失效仍按原路径显示，保留恢复操作。根目录 UI-DESIGN 的既有监督者章节记录文案原则，UI 设计和用户故事同步；内部技术设计与验证记录仍保留事实边界。

本轮验证：

- `npx vitest run src/renderer/src/SupervisionReviewSettings.test.tsx src/renderer/src/SupervisorActivity.test.tsx src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx`：4 文件、57 项通过。新增中英文用例覆盖帮助文案、监督并发范围、来源核对提示，以及真实 HTTP 429 / Retry-After 错误、失败状态和继续入口的保留。
- `npx eslint src/renderer/src/SupervisionReviewSettings.tsx src/renderer/src/SupervisionReviewSettings.test.tsx src/renderer/src/SupervisorActivity.test.tsx src/renderer/src/i18n/locales/zh-CN/heartbeat.ts src/renderer/src/i18n/locales/en-US/heartbeat.ts`：通过。`git diff --check` 通过，仅有现存行尾转换提示。
- 中文 UI 文档扫描无阻断项，9 项复核提示均涉及实际行为边界，按事实保留；新增规则和技术记录另经人工审校。未运行全量测试、类型检查、Electron 或真实模型调用，本轮模型调用 0 次。

本轮仅修改监督者 Renderer、i18n、相关测试和文档；Main、Shared 只读核对。保留已有暂存及未暂存修改，未暂存、提交或推送。

### 2026-09-24 persistedId 并行修复记录

此段记录被上文真实旧库修复替代的早期方案。当时静态核对并行 Main 改动：新实体示例省略 `persistedId`，空字符串和 `null` 视为省略，其他格式错误值仍拒绝。该方案未处理真实候选中的旧文本主键，不能证明用户故障已解决。当前合同见[技术设计](./technical-design.md)。原始失败响应的具体坏值仍未知。

用户提供的并行验证结果为 29 项定向测试及另 1 项 IPC 测试通过；两次真实 DeepSeek 请求分别验证创建和复用，实体数保持 2，实体 ID 稳定。本轮仅记录并静态核对修复，没有复跑这些测试或模型请求；此证据不证明全部事实的语义识别，也不替代此前完整会话实验的范围与计数。

### 2026-09-24 五页签与计划 Modal 修正

对应 FR-S2、US-S22 至 US-S24。当前导航为工作回顾、故事线图谱、自动监督、活动记录、设置。计划列表移入自动监督，原有表单移入共享 Modal；设置只保留算法参数。保存失败保留草稿，未保存关闭确认，暂停计划编辑后仍暂停；计划执行记录按 configId 进入活动筛选，数据库在分页前过滤。报告、建议、概览、审计及精确结果跳转按[当前 UI 设计](./ui-design.md#应用入口)归属。

- 六文件定向组最终 61 项通过：HeartbeatCenter、SupervisorWorkspace、SupervisorActivity、SupervisionReviewSettings、Main supervision-activity、Preload supervision-activity。包含计划创建/编辑、失败重试、放弃确认、焦点循环与恢复、同名计划筛选、报告/审计分页，以及真实 SQLite 分页前过滤。新增换计划重置分页和忽略旧响应回归，筛选与清除保留键盘焦点。
- App 筛选 3 项通过：跨项目计划列表与暂停计划 Modal 保存、设置保存后重开、精确结果跳转。IPC 筛选 2 项通过，验证活动 configId 经真实 handler/SQLite 过滤并拒绝空 ID；其余 App/IPC 测试未运行。
- 最终 `npm run typecheck`、`npm run lint` 和 `git diff --check` 通过；按要求未运行全量测试。中文 UI 文档审校无阻断项，复核提示涉及执行限制和未实现边界，按事实保留。
- Electron 生产组件 fixture 测试 1 项通过，约 66 秒，覆盖 1440/1024/390px、浅深主题、五页签归属、Modal 焦点与放弃、390×720 短窗口保存按钮命中、计划活动过滤和原生方向键。首次运行被终端 60 秒上限中断，延长后通过。

截图位于 `C:/Users/jiang/AppData/Local/Temp/opencode/supervisor-five-tabs/`，包括 `menu-plans-light-390.png`、`plan-modal-dark-390-short.png`、各页签浅深主题截图及 `measurements.json`。人工检查计划、Modal 和设置截图，无横向裁切；短窗口长表单内部滚动。fixture 复用实际生产组件与已有模拟数据，未读取用户数据库，未调用模型。此次不修改 Agent/远程 Runtime，无需远程执行验证。

开始检查时 HEAD 为 `7adae97`，监督改动仍在暂存区与工作区，未发现上轮计划提交；本轮保留其他 dirty 修改，未提交、amend 或推送。

### 2026-09-24 菜单归属调整

此段记录上轮四页签方案，已由上文五页签修正替代。当时设置包含自动监督计划、模型超时与并发、回顾算法三个纵向区块；报告与建议迁入工作回顾，运行概览和心跳审计迁入活动记录。以下保留当时验证证据，当前交互以[应用入口](./ui-design.md#应用入口)为准。

本轮验证：

- `npx vitest run src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx src/renderer/src/SupervisorActivity.test.tsx src/renderer/src/SupervisionReviewSettings.test.tsx`：50 项通过，覆盖双语菜单归属、设置无嵌套导航、计划操作、建议确认/忽略、报告及审计分页、页签切换保留展开状态、快捷按钮焦点、图谱来源与持久进度。
- App 按测试名称筛选运行 4 项并通过：页面读取失败重试、侧栏结果跳转与 keepalive、计划独立于当前项目、模型及回顾参数保存后重开。其余 App 测试未运行。
- `npm run typecheck`、本轮修改的 TS/TSX/MJS 文件 ESLint、`git diff --check` 通过；未运行全量测试。
- `npx vitest run tests/supervisor-layout.electron.test.ts`：最终 1 项通过，约 51 秒。保留原图谱、异常状态、设置及活动的 1440/1024/390px 验证，新增非空菜单在 1440/390px 浅深主题的 12 个页面场景、区块归属、报告全宽、设置无范围徽标/刷新行和原生方向键导航检查。人工查看截图后修正了报告遗留双栏宽度，并补全 fixture 下次运行时间。一次复验受终端 60 秒限制中断，延长执行上限后通过。

截图及测量保存在 `C:/Users/jiang/AppData/Local/Temp/opencode/supervisor-menu-20260924/`，菜单截图以 `menu-` 开头，`measurements.json` 包含布局结果。Electron 使用生产 React 组件和隔离 fixture，未读取用户库、调用模型或验证真实模型产出。本轮模型调用 0 次，无提交或推送。

### 2026-09-24 完整会话生产验证与收尾

生产链路已通过一个独立完整会话的真实模型测试；较早的 129 条消息实验仍为未完成，不能据本次成功改写其状态。按用户要求，没有重发此前的两个请求，也没有重新计算其已保存批次。

只读选择器 `scripts/supervision-select-readonly.cjs` 在 `readOnly`、`query_only` 和读取事务下选择另一条完整会话，筛选条件为 21..40 条 user/assistant 消息、8,001..14,000 码点，并排除旧目标 ID。命中会话共 27 条消息、9,677 码点；选取的是整条会话，没有截取其头尾。仅该会话进入外部临时快照及隔离产品库，原用户库未初始化、迁移或写入。

首次请求输出有效 JSON，提供商以 `stop` 结束，但使用输入的 `locator.source` 作为引用，未使用带范围的 fragment ID。生产校验因此拒收。修正为：引用若是本节点提供的 source token，且只匹配一个输入片段，就映射到该片段 ID；同源多片歧义或未知来源仍拒绝。映射不扩展引用范围，不把片段升级为整条消息。针对唯一映射、歧义拒绝补了确定性测试。

原始 SSE 已保存在外部临时目录。继续测试时通过同一生产工厂、`SupervisorService` 和 `ModelAgentRuntime` 重放该响应，校验相同来源快照、运行配置及请求字节数；这是一次本地响应复核，没有新增付费请求。之后只为未调用的第二叶子和导航节点请求 DeepSeek。最终与每条原消息逐字比较，并检查码点区间连续性。

| 实测项 | 结果 |
| --- | --- |
| 完整覆盖 | 27 / 27 条消息，9,677 / 9,677 码点，27 个片段；重建差异及剩余来源均为 0 |
| 生产产物 | 2 个叶子、1 个导航合并、1 个完整发布结果 |
| 叶子记录 | 19 个事件、15 个实体、8 个变化、11 个关系，共 53 条；摘要未替换叶子 |
| HTTP | 本会话共 3 次 HTTP 200：两个叶子和一个导航；另有一次缓存响应复核，HTTP 为 0 |
| 本轮总付费请求 | 较早失败实验 2 次 + 本会话 3 次 = 5 次；无重复付费请求、无自动重试、无回退模型 |
| 配置 | `deepseek-flash`；页大小 17；默认正文批次 8000、默认消息上限 20；模型超时 180 秒、软预算 600 秒、接纳并发 2 |
| 耗时 | 首次 20,164ms，缓存复核及剩余执行 19,584ms；二者不含人工修正间隔 |
| 手动隔离 | 自动 checkpoint 为 0；SQLite integrity_check 为 ok |

产物目录为系统临时目录 `opencode/review-production-complete-20260924`；来源快照在 `opencode/review-production-selected-20260924`。计数见 `metrics.json` 和只读审计入口，响应 `.private.sse` 仅供本机诊断，未进入仓库。模型输入包含完整选中正文，但未进行独立语义召回评估；“覆盖完成”不表示模型识别了每个事实。

最终确定性验证：12 文件定向组 136 项通过，覆盖服务/存储、迁移、设置、Preload 和页面；生产 IPC 筛选 22 项通过，其余 128 项未运行。完整 App 的设置保存及重开 1 项、AssistantDatabase 的监督历史筛选 4 项通过。Electron 使用生产组件，在 1440/1024/390px、浅深主题通过布局测试。首次视觉测试发现脚本仍只选中第一个设置表单，改为测量整个设置面板的可见控件后通过；两个表单同名保存按钮也已分别命名。

收尾新增用例确认 schema 46 已提交的 2,000 码点前缀不重读，只处理后续 1,300 码点；来源变化保留旧批次并要求新 run，后续自动检查不会永久卡在旧版本。来源上下文按已保存 messageId 和片段返回，避免同时间消息误定位或用当前正文冒充历史片段。`npm run typecheck`、本轮修改及新增 TS/TSX/CJS/MJS 文件的定向 ESLint 均通过。没有运行全量测试、提交或推送。

最终定向命令：

```text
npx vitest run src/main/assistant/supervision-review.test.ts src/main/assistant/supervisor-service.test.ts src/main/assistant/supervision-history.test.ts src/main/assistant/supervision-activity.test.ts src/main/assistant/incremental-review.test.ts src/main/assistant/supervision-model-pool.test.ts src/main/application-settings-store.test.ts src/preload/supervision-activity.test.ts src/renderer/src/SupervisorActivity.test.tsx src/renderer/src/SupervisionReviewSettings.test.tsx src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx
npx vitest run src/main/ipc.test.ts -t "supervision|heartbeat enabled gates|admits .*reports before claiming"
npx vitest run src/renderer/src/App.test.tsx -t "saves Supervisor timeouts and concurrency"
npx vitest run tests/supervisor-layout.electron.test.ts
npm run typecheck
```

### 2026-09-24 生产接线与真实模型失败

本节记录首轮生产接线及较大样本失败；最终补充证据见上一节。下方同日的原型、设计及旧 collector 记录是更早阶段证据。

已接线：Main 手动 IPC 与心跳回调共用 `createProductionSupervisorService`；schema 47 保存来源清单、配置、叶子和导航节点；稳定键分页、项目/会话轮转、Unicode 片段、逐批事务、失败/预算后继续、严格发布判定已进入生产服务。活动及 Preload 增加暂停、继续、分页批次详情；设置存储、App 回调和中英文表单已接通页大小、字符/消息批次上限及软预算。应用仍默认关闭。实现合同和未完成项见[生产接线与剩余边界](./review-scheduling-design.md#0-生产接线与剩余边界)。

确定性验证使用隔离 SQLite、生产 IPC 和可控 Runtime，先于真实请求执行。覆盖超过 20 会话/20 消息的 506 条来源、Unicode 精确重建、手动/自动位置隔离、失败后重开、冻结配置、事务回滚、暂停 signal 到 Runtime、成功批次不重算及历史结果来源。后续增加项目轮转、分页大小不改变语义块、发布失败后复用导航节点、Preload 方法和 UI 操作验证。

真实验证入口为 `scripts/supervision-production-live.cjs` / `.ts`，使用与 Main 相同的生产工厂及 `ModelAgentRuntime`，不使用 `review-algorithm.mjs`。输入为已有只读快照中的完整目标会话，截止时间为 2026-09-23 16:09:45.919 UTC，共 129 条消息；逐消息集合 SHA-256 与原探测清单一致。只将选中会话导入临时产品库，没有复制整份用户库，未打开或改写原库及用户设置。

| 实测项 | 结果 |
| --- | --- |
| 配置 | DeepSeek `.env` 中的 `deepseek-flash`；页大小 17、正文批次 16000、消息上限 50、并发接纳 2、模型超时 180 秒、软预算 600 秒 |
| HTTP | 2 次，均 200；无付费重试、无模型回退、无工具 |
| 结果 | 第 1 批校验并保存，第 2 次输出 JSON 无效；逻辑 run 为 failed，没有完整结果 |
| 来源清单 | 129 条消息，54,979 个 Unicode 码点 |
| 已持久化覆盖 | 16,000 码点；28 条完整消息及 1 条部分消息，共 29 个片段；101 个来源未完成 |
| 已保留输出 | 10 个事件、9 个实体、9 个变化、9 个关系，共 37 条结构化记录 |
| 完整发布 / 自动 checkpoint | 均为 0；此次为手动运行，失败批次没有推进位置 |
| 耗时 | 56,775ms；HTTP 测量仅记录响应头延迟，不能当作完整模型耗时 |
| 完整性 | 临时库 `PRAGMA integrity_check` 为 ok |

私有产物位于系统临时目录 `opencode/review-production-20260924`。`metrics.json` 与只读命令 `node scripts/supervision-production-audit.cjs <外部临时目录>/assistant.sqlite` 可核对上述计数；不在仓库保存正文或凭据。失败响应正文没有保存，尚不能确定 JSON 无效是格式问题还是输出截断；不补造原因。按用户要求未重发失败付费请求，**该 129 条消息样本没有完成真实模型全会话覆盖验收**。16000 字符测试上限也不能视为经过可靠性验证的推荐默认。

已完成的定向命令包括：

```text
npx vitest run src/main/ipc.test.ts -t "production supervision IPC|collects supervision within the exact UI timeRange"
npx vitest run src/main/assistant/supervision-review.test.ts src/main/assistant/incremental-review.test.ts src/main/assistant/supervision-history.test.ts src/main/assistant/supervision-model-pool.test.ts src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisionReviewSettings.test.tsx src/preload/supervision-activity.test.ts
npx vitest run src/main/assistant/assistant-database.test.ts -t supervision
```

前述 IPC 3 项、七文件 45 项及数据库历史 4 项通过。更早一次十文件定向运行 116 项通过，2 项因两个表单保存按钮同名失败；已分别命名并复查相关文件。类型检查、最终定向 lint 和收尾验证在本节后续记录。未运行全量测试、提交或推送，保留已有 dirty 改动。此次没有修改 Agent、远程 Runtime 协议或其取消实现；监督父 signal 使用既有 Runtime 接口，本轮不声称完成远程真实验证。

### 2026-09-24 DeepSeek 全目标会话隔离原型

使用 `.env.deepseek.local` 的 `DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`、`DEEPSEEK_API_KEY`；配置模型及 12 次响应的实际模型均为 `deepseek-flash`。直接调用配置端点，没有 GPT 回退、自动付费重试或工具调用。原型复用 `SupervisionModelPool`，实验并发参数设为 2，实测峰值为 2；没有修改应用设置。单请求超时 180 秒，输出预留 16,384 token，12 次均以 `stop` 结束。

启动前核对旧探测的 PID、创建时间、启动记录及命令路径，终止已取消的全会话 GPT 探测。旧尝试记录 10 次已插桩 HTTP 及 2 次未插桩调用，不计入下表的 DeepSeek 12 次。原始消息复用 `review-full-20260924/sources.private.json`，核验冻结消息集合的 SHA-256 及逐消息重建；未沿用旧 GPT 事实或导航。该快照来自既有 `readOnly`、`query_only` 采集入口，本轮没有打开原库，也未初始化、迁移或写入原库。

| 测量 | 结果 |
| --- | --- |
| 完整目标范围 | 1 个会话，129 / 129 条 user/assistant 消息，8 页；截至 2026-09-23 16:09:45.919 UTC 的冻结快照 |
| 正文覆盖 | 54,979 / 54,979 个 Unicode 码点；本样本 UTF-16 单元数相同；135 个片段、7 个叶子批次，每批正文不超过 8,000 UTF-16 单元 |
| 来源核验 | 重建差异 0、覆盖空洞 0、引用码点区间错误 0 |
| 持久化结果 | 354 条叶子事实、503 条引用；其中一个重复短引文保留 2 个明确标为歧义的候选位置，没有猜选唯一位置 |
| 导航 | 18 组完整索引 354 条事实，每条一次；生成导航前后叶子内容散列一致 |
| 真实调用 | 7 次叶子提取 + 2 次独立检查点选择 + 1 次导航 + 2 次语义评分，共 12 次 HTTP 200 |
| 首批速度 | 并发两请求分别 20.376 / 9.236 秒，首轮 20.420 秒；先保存 16,000 码点并正确返回 partial |
| 叶子速度 | 单请求 9.236..20.376 秒；七请求耗时之和 107.334 秒，含并发重叠，不能当作墙钟耗时 |
| 全实验时间 | 四次执行的进程内耗时合计 111.955 秒；首次请求至末次响应约 333.869 秒，包含检查、修改及人工重启间隔；另两次离线验证合计约 38ms |
| token | 提供商报告输入 188,377、输出 56,009；其中叶子提取为 34,771 / 35,852，其余用于评估及导航；未换算货币费用 |
| 续跑与无变化 | 三个已保存叶子在校验失败后复用；失败批次的已有响应重新本地校验，未再次请求。最终重启复用七批，无变化检查 4.362ms、模型调用 0；独立离线验证 19.826ms、模型调用 0 |

目标会话在旧探测后继续增长，先前记录的 119、123 条与本轮 129 条属于不同读取时点，不能混为同一分母。本轮覆盖完整目标会话，不等于覆盖旧全局区间的 830 条消息、63 个会话，也未测试任务、记忆和知识引用的全量采集。

独立检查点选择请求只看到两半完整原文，没有看到叶子结果，也未注入指定引文。模型返回 125 个检查点，超过要求的每半 24..32 个；排除 2 个原消息中不存在的逐字引文后，评分采用 123 个。第二半的消息回执虽有 64 项，但 ID 集合不匹配，因此仅声称全部 129 条已提交给评估器，不以模型回执证明它逐条读懂。

| 独立检查类别 | 有效检查点 | 模型判为保留 | 遗漏 / 失真 |
| --- | --- | --- | --- |
| 决策 | 46 | 46 | 0 / 0 |
| 修正 | 9 | 9 | 0 / 0 |
| 否定约束 | 1 | 1 | 0 / 0 |
| 未解决事项 | 5 | 5 | 0 / 0 |
| 助手陈述归属 | 62 | 62 | 0 / 0 |

模型评分未报告不受引用支持的事实；离线核验 123 项均有原消息的引用，118 项在所引用叶子中保留完整逐字检查引文，另 5 项依赖语义比较。评估器报告导航短摘要遗漏 69 项叶子细节，相关叶子仍完整保留。评估独立性仅指先从原文选择检查点、再比较输出，提取与评分使用同一模型；缺少人工金标准，否定类仅一项，跨两半的修正关系没有单独审计。这些数字不构成全部事实召回率或“无语义遗漏”的证明。

实际出现两次本地校验失败：重复引文导致叶子拒收，以及评估输出违反检查点数量与引用合同。成功批次在失败后仍可读取；原型为重复引文保存全部候选定位，对无效评估引文明确排除并计数。原始响应保留在临时目录，三次缓存读取不产生 HTTP。确定性测试另外覆盖批次失败、截断、取消和预算暂停后的恢复，未刻意制造提供商失败来增加付费调用。

执行入口为 `scripts/review-deepseek.cjs` / `scripts/review-deepseek.mjs`，共享原型为 `scripts/review-algorithm.mjs`。私有正文、来源、模型响应及 SQLite 均位于系统临时目录；仓库仅包含脚本、合成测试和不含正文的测量记录。产物目录：`C:/Users/jiang/AppData/Local/Temp/opencode/review-deepseek-20260924`。可公开计数见 `metrics.json`、`coverage.json`；私有依据见 `batches.sqlite`、`facts.private.json`、`navigation.private.json`、`gold-*.validated.private.json`、`evaluation-*.private.json`。

复现命令如下。`first`、`finish`、`verify` 启动独立进程，须待上一次退出再运行下一条；`status` 仅读取计数。现有输出目录会复用已保存产物；更换输出目录重跑会新增最多 12 次付费调用。

```powershell
$source = "$env:TEMP/opencode/review-full-20260924"
$output = "$env:TEMP/opencode/review-deepseek-20260924"
node scripts/review-deepseek.cjs first $source $output .env.deepseek.local 2
node scripts/review-deepseek.cjs status $output
node scripts/review-deepseek.cjs finish $source $output .env.deepseek.local 2
node scripts/review-deepseek.cjs verify $source $output .env.deepseek.local 2
node --test scripts/review-algorithm.test.mjs
npx vitest run src/main/assistant/supervision-model-pool.test.ts
npx eslint scripts/review-algorithm.mjs scripts/review-algorithm.test.mjs scripts/review-deepseek.cjs scripts/review-deepseek.mjs
```

10 项原型测试、3 项共享池测试及上述定向 ESLint 通过；没有运行全量测试、提交或推送。测试覆盖分页同序键、Unicode 重建和引用位置、空洞、预算暂停、失败后重开、无变化零调用、来源版本变化、输出拒收、取消以及导航不删除冲突叶子。该原型未接生产 IPC/UI、自动 checkpoint、全局多项目调度或多层汇总；真实请求绕过产品 ModelRuntime。生产实现仍存在下节记录的采集遗漏，未来实现边界见[分块调度设计](./review-scheduling-design.md#12-隔离原型的设计结论)。

### 2026-09-24 模型阶段超时、并发与设计边界

- 本次静态核对当前新代码：报告 `heartbeatReportTimeoutSeconds`、监督 `supervisorOrganizeTimeoutSeconds` 已接入共享校验、设置存储、App/设置表单及 Main 摘要器；整数 30..600 秒、默认 240。报告在等待池前冻结值，监督在摘要器入池前读取值，均在获槽及 Runtime 解析后才计时。完整控制及未覆盖环节见[控制清单](./review-scheduling-design.md#当前超时与调度控制清单已实现)。
- `supervisorModelConcurrency` 已接入同一设置链路，整数 1..4、默认 1；报告与监督共用 FIFO 池，普通聊天排除，降限不终止在途项。报告获槽后才领取，每次到期领取最多一条；租约为 `max(300, 报告超时 + 60)` 秒，实际请求开始前按运行 ID、owner、attempt、claimed 和未过期条件校验并刷新。报告提交或无变化后先释放槽位，再进入下游监督。尚无提供商全局并发、RPM、TPM 或监督层 Retry-After 控制。
- 本轮协作提供的新增验证记录：24 项并发相关测试、33 项租约相关测试及 typecheck、lint 通过。本次文档修订仅核对实现，没有重新执行这些测试；记录未附精确过滤命令，不补造命令或与此前批次相加。
- 实现代理报告：87 项测试、App/IPC 聚焦用例、另 19 项取消测试，以及 typecheck、lint 通过。本次文档修订未复跑这些命令，不将数量相加当作独立用例总数，也不推断全量测试已通过。
- 实现代理报告的真实远程取消验证耗时 30.75 秒，清理后本次拥有的进程为 0。该证据验证相应 Runtime 取消/清理路径，不证明完整分页调度、父级取消、批次持久化或跨重启续跑已经实现。
- 真实用户数据探测结果见下节。两次原始失败耗时与旧 240 秒时限一致，但缺少 abort 原因记录，尚不能证明证据规模是超时根因。
- [回顾分块调度设计](./review-scheduling-design.md)已按用户授权加入完整分页、保留叶子事实/来源、成功批次及位置持久化、预算/失败后继续和严格完成判定。上述调度、存储合同、状态及 UI 仍待实现；当前有界单次成功不等于整个时间区间完整覆盖。

### 2026-09-24 真实会话覆盖与模型小样本

原始数据库以 `readOnly` 和 `query_only` 打开，只读事务内分析，未初始化或迁移。用户所述安装路径不存在；实际安装位于 `D:\Program Files (x86)\GoodBuddy`，数据位于用户配置目录。统计使用当前数据库内 9 月 16 至 23 日记录，并非还原该次运行时的数据库快照。

| 测量 | 结果 |
| --- | --- |
| 区间内会话消息 | 830 条、63 个会话、5 个项目 |
| 手动采集器返回 | 202 条消息、70,491 个 UTF-16 单元 |
| 实际进入当前摘要器 | 100 条消息、17,714 个 UTF-16 单元；覆盖 9 个会话 |
| 目标会话 | 区间内 80 条中仅 20 条进入摘要器；正文覆盖 3,693 / 33,247，即 11.11% |
| 离线完整分块审计 | 123 条消息分为 127 块，重建差异为 0；未对这些块执行模型提取 |
| 只读采集耗时 | 手动 182ms、单批增量 375ms、整个探测 805ms |

整条消息遗漏发生在 SQL 数量限制及服务取前 100 项处；本样本进入摘要器的消息未再发生正文裁剪。100 条来源均缺少 `locator.messageId`，现有会话定位不能代替逐消息覆盖凭据。完整分页与消息定位仍为待实现项。

隔离模型实验使用两条已保存的真实样本，共 814 个 UTF-16 单元，经 `createDefaultModelRuntime` 调用 `gpt-6-astra`。3 次 HTTP 请求均为 200，未付费重试；两次提取耗时 34.665 / 35.413 秒，导航概述 6.703 秒，实验总耗时 76.813 秒。模型输入与原消息逐字一致，要求保留的两处引用及消息引用均核验通过，导航引用两项已保留事实；无变化复查耗时 5.99ms，模型请求为 0。原应用设置在完成时逐字节未变。

两处引文已在提示中明确指定，因此该实验仅验证小样本的引文保留、引用正确性与保留产物，不能证明自由提取完整性、全会话无失真或未来调度器性能。实验采用自定义单来源准入及直接模型 Runtime，未经过完整生产 IPC/UI。原库两次失败运行分别耗时 240.211 / 240.216 秒，监督结果仍为 0；样本成功不等于原问题已修复。

复核产物保存在本机临时目录 `opencode/review-fidelity-20260923-current`：`verification-current/coverage.json`、`live-resolved/live-metrics.json`、`verification-current/verification.json`。执行入口为私有临时脚本 `resume-supervision-probe.cjs` 和 `verify-supervision-probe.cjs`；核验退出码为 0。启动器等待曾超时，最终产物记录三次请求完成且进程随后退出，未因此重发请求。此前依赖加载失败均发生在请求发送前。会话正文及配置副本未加入仓库。

### 既有实现

- 共享监督者契约已接入 Main 服务，模型请求包含系统指令；证据总字符预算为 48,000，输出仍限制为 100KB，并校验本次证据集内的来源引用、输出局部实体 ID 和关系端点。手动回顾当前收集会话、任务、消息已有的知识引用和已确认记忆；记忆使用 `memory` 来源类型。
- SQLite schema 43 包含监督运行、结果、来源、故事线、事件、实体、实体关联和关系表，并保存每次结果的实体与关系内容。来源保存本地 library/document/chunk 或外部 locator 元数据；持久化与升级规则见[技术设计](./technical-design.md)。
- 初版监督者入口只有一个页面页头和四项顶层页签，原有计划、概览、建议及报告当时保留在设置页内部。2026-09-24 已按上文菜单调整迁移内容；手动运行仍通过 Supervisor 通道，未绑定自动计划时也可用。
- 工作回顾显示结果自身冻结的 scope/time range。故事线视图使用真实数据库结果，外围事件按实际时间逆时针排列并保留缺口，事件实体连线和来源过滤来自 Main 查询投影，图形不可用时仍可通过事件/实体/关系列表操作。
- `HeartbeatService` 在定时或手动心跳成功落库后调用同一个 `SupervisorService`，按心跳范围和回顾窗口自动保存监督结果；投影失败不会改写已经成功的心跳状态。
- 监督图谱提供 Main/Preload IPC 的来源读取、实体确认/修订/撤销和关系确认/移除；关系移除保存 `revoked` 状态，不删除来源，后续自动 run 不恢复相同身份的关系。
- 右侧助手栏已读取监督反馈，支持来源查看、继续讨论预览与确认发送，以及本地知识库实体写入预览和确认提交。
- 本地会话来源可按会话 ID 和发生时间读取上下文；没有当前会话时，继续讨论操作明确禁用。
- 应用中心已增加监督者开关，继续复用 `heartbeat` 导航 ID；关闭后已打开页面显示关闭状态并禁用工作区操作，不删除既有心跳计划或历史数据。导航显示同时遵守 enabled 和 pinned 语义。默认值及执行边界以[应用启停与执行](./logic-design.md#应用启停与执行)为准。

## 验证证据

### 2026-09-23 Desktop 0.13.13 侧栏布局回归

- 固定目标与刷新改用标题旁的共享图标按钮；目标显示会话/任务名称，缺失名称使用未命名文案。
  对应 US-S25，行为见[会话侧栏](./ui-design.md#会话侧栏)，未改变监督运行或取消逻辑。
- `RightAssistantSidebar.resize.test.tsx` 66 项和 `SupervisionCard.test.tsx` 4 项通过。
  `tests/supervisor-layout.electron.test.ts` 的常规工作区场景通过，额外设置
  `GOODBUDDY_SUPERVISOR_SIDEBAR=1` 后的侧栏场景也通过：480/300/200px、
  浅深主题、长标题、34px 按钮、键盘焦点与无横向溢出，共 6 种布局。
- 完整 typecheck、lint 通过，真实模型调用 0 次。使用隔离组件 fixture，不代表真实
  用户数据库端到端验收；发布验证范围见[候选记录](../../development/release-preparation-0.13.13.md)。

### 既有实现验证

- `npx vitest run src/renderer/src/SupervisorWorkspace.test.tsx src/renderer/src/HeartbeatCenter.test.tsx`：17 个测试通过，覆盖统一页签、无计划手动回顾、加载状态、图谱真实连线与来源过滤。
- `npx vitest run src/main/assistant/supervisor-service.test.ts src/main/assistant/assistant-database.test.ts src/main/application-settings-store.test.ts src/renderer/src/ApplicationCenter.test.tsx`：166 个测试通过。
- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `git diff --check`：通过；仅有现有文件的行尾转换提示。

### 2026-09-23 页面与视觉验证

- 生产页面按 [UI 设计](./ui-design.md) 使用三栏工作台、真实实体名称、逆时针事件环、实际关联连线、选中强调与来源详情。颜色复用现有图谱令牌，未修改全局主题。密集数据按批显示，列表保留全部返回记录；事件浏览不还原历史实体状态。
- 设置只保留一个一级标题，缺少监督者 bridge 不再回退旧概览；无计划手动回顾、项目/时间范围、来源关联过滤均有组件回归。来源异步读取期间切换事件时，迟到正文不会出现在无关联事件下。
- `npx vitest run tests/supervisor-layout.electron.test.ts src/renderer/src/SupervisorWorkspace.test.tsx src/renderer/src/HeartbeatCenter.test.tsx src/main/assistant/supervisor-service.test.ts src/main/assistant/assistant-database.test.ts`：134 项通过。Main 测试使用隔离数据库和注入摘要器；视觉入口渲染生产 React 组件，未读取真实用户数据或调用付费模型。
- Electron 实测 1440、1024、390px 与浅深主题，页面、壳层和内容容器均无横向溢出；1440px 三栏实测为 216 / 863 / 280px。窄屏画布内部滚动保留可读字号，缩放后 SVG 文字不低于 11px；另验证 9 个容器临界宽度、长标题、80 个同时间事件、40 个实体、来源详情、设置表单、加载/空/错误/缺 bridge 状态。
- 截图与 `measurements.json` 输出到本次指定的临时目录 `opencode/supervisor-visual`。代表文件为 `selected-source-1440.png`、`light-1024.png`、`light-390.png`、`dark-1440.png`、`dense-selected.png`、`selected-source-390.png`、`settings-plans-390.png`。可复用的验证和交互预览入口见 UI 设计末段。
- 全量 `npm test`：416 个文件通过、9 个跳过、1 个失败；4902 项通过、67 项跳过、1 项失败。失败为 `local-runtime-reuse.test.ts` 的十项目 OpenCode 压缩断言（`compacted: false`），单独复跑该文件的 2 项均通过。本次未改动 Runtime 实现，未将这次全量运行记为全绿。
- 页面收尾后重新执行 `npm run typecheck`、`npm run lint` 通过。App 已在上述全量测试中通过；一次包含 App 的额外定向命令超过终端 120 秒限制，随后缩小到上述 5 个相关文件完成验证。

## 当前边界

### 2026-09-24 算法设置文档补充

已静态核对共享设置合同、设置存储及隔离原型参数，补充[设置配置清单](./review-scheduling-design.md#4-设置配置清单)和 [UI 交互目标](./ui-design.md#算法配置设置目标)。本次仅更新文档；新增分页、分块、预算、续跑及额度控件均未实现，原型值不作为产品默认。未运行代码、测试、探测或模型调用，未修改应用配置和用户数据库。

### 2026-09-23 Main 与侧栏定向修复

- 已修复：继续讨论不再把数组写入要求字符串的 `serializedContexts`；请求省略 Runtime 时复用会话选择。真实 SQLite 入队后，生产队列解析器成功派发请求。
- 已修复：每次结果独立分配实体和来源 UUID，映射事件、关系、实体变化及来源引用。两次重叠 run 和跨项目相同模型 ID 均有 SQLite 回归，用户修订的名称和说明保留，所有结果均可读取自己的来源及 locator。schema 41 升级并重复打开后保留旧记录和确认状态。
- 已修复：知识库预览与提交均检查本地库及实体所属库；侧栏确认框展示实际返回内容，取消与写入失败后可重新预览。测试覆盖真实本地实体读写，外部只读及提交前归属变化由注入状态验证。
- 定向验证：`npx vitest run src/main/assistant/assistant-database.test.ts src/main/ipc.test.ts src/renderer/src/RightAssistantSidebar.resize.test.tsx src/main/assistant/supervisor-service.test.ts -t 'supervision|shares bounded evidence'`，4 个文件中选中的 9 项通过，其余 289 项未运行。本轮未运行全量测试、typecheck、lint 或真实模型请求；前文历史验证不能代替本轮验证。
- 当时未修复的双边时间范围及记忆背景语义已由下节定向修复覆盖。跨 run 实体识别由本轮候选身份实现补齐；旧实现已经覆盖或忽略的历史内容无法从现有记录自动还原。

### 2026-09-23 第 4 问题：双边时间范围

- 已接通真实 `supervisionRun` IPC handler → collector → SQLite → 摘要输入 → 结果保存。监督者显式传递请求时间区间，不再扩大到一小时；消息与会话在 LIMIT 前按闭区间筛选，任务按创建或完成时间筛选。所选项目复用存在且 active 的检查；普通 Heartbeat 不传明确区间时仍使用原下界行为。
- 记忆证据使用真实 `updated_at`，locator 保留 `created_at`/`updated_at` 并标明当前背景；摘要指令禁止据此推断历史内容。任务的当前状态也不作为历史状态快照。实现规则与剩余容量边界见[技术设计](./technical-design.md)。
- 定向验证：`npx vitest run src/main/ipc.test.ts src/main/assistant/heartbeat-database.test.ts -t 'collects supervision within the exact UI timeRange|builds one bounded snapshot across only the selected projects'`，2 个文件中选中的 3 项通过，133 项未运行。两项新 IPC 测试分别覆盖 global/projects：15 分钟精确范围与端点、25 条区间后消息及 21 个区间后会话不挤掉区间消息、旧任务期间完成、期内创建但期后完成的任务选用创建时间、记忆非采集时刻、archived 项目拒绝。已有 Heartbeat 项目快照用例通过。
- 首两次定向运行因新增测试 fixture 缺少 `description`、消息 `state` 失败，补齐实际契约后通过。本轮所改 tracked 文件的 `git diff --check` 通过，仅有行尾转换提示。验证使用真实隔离 SQLite 与生产 IPC/collector，模型 Runtime 为测试替身；未运行 UI/Electron、全量测试、typecheck 或 lint，真实模型调用为 0。未改 Renderer/CSS、数据库 schema、远端 Agent/Runtime，不涉及独立远程执行逻辑；未提交。

### 2026-09-23 结果定位、目标过滤与候选身份

- 对应 US-S02、US-S05、US-S10、US-S13、US-S25：overview 返回稳定结果/故事线 ID；Main 校验 graph 请求归属，并按结果读取当次事件、对象与来源。历史选择和图谱共享结果定位，请求序号阻止迟到响应覆盖新选择。
- 侧栏 overview 通过类型化 Conversation/Task 目标查询；SQLite 在 LIMIT 前同时校验匹配来源和项目范围。无匹配结果不展示全局第一条。卡片展示结果范围和时间区间，目标切换清空来源与预览并忽略旧请求。
- tasks 工作栏实例新增可持久化的会话/任务监督绑定；固定、切换聊天、取消固定均连接到实际卡片查询，任务列表仍使用原项目范围。继续讨论预览展示真实发送目标，回调显式传会话 ID，Main 复用该会话配置。固定任务找不到关联会话时不启用发送。
- 模型只能用 `persistedId` 引用 Main 提供的同 scope 候选 UUID；服务与保存事务分别校验。未显式引用候选的实体和所有来源继续分配新 UUID。SQLite 回归覆盖重复 run 复用、不同项目拒绝、裸模型 ID 不合并、确认/修订字段及关系理由保护、移除关系后不自动恢复。
- schema 43 升级保存现有可定位的结果成员，后续 run 不改写旧结果内容；测试从 schema 42 升级并重复打开，比较历史图谱与来源，包括没有直接来源引用、但两端实体归属明确的关系。已有 schema 41 保留数据用例继续通过。缺失归属、曾被覆盖的描述仍无法重建。
- 定向测试共覆盖 32 个不同用例，最终均通过。主命令为 `npx vitest run src/main/assistant/supervision-history.test.ts src/main/assistant/assistant-database.test.ts src/main/assistant/supervisor-service.test.ts src/main/ipc.test.ts src/renderer/src/SupervisorWorkspace.test.tsx src/renderer/src/SupervisionCard.test.tsx src/renderer/src/RightAssistantSidebar.resize.test.tsx src/renderer/src/HeartbeatCenter.test.tsx -t '[sS]upervis'`：29 项通过，2 项失败来自新增同步 IPC 拒绝断言误用 `.rejects`。修正后仅复跑 `src/main/ipc.test.ts src/shared/workbar-contracts.test.ts -t '[sS]upervis'`，5 项通过，包含新增工作栏绑定契约用例。期间修正了旧侧栏 fixture 缺少目标、迁移比较未忽略成员顺序和图谱按钮查询歧义。
- 收尾增加同来源但项目范围不匹配的过滤断言，以及无直接来源引用的关系迁移断言；仅复跑 `src/main/assistant/supervision-history.test.ts src/main/assistant/assistant-database.test.ts -t supervision`，5 项通过，其余 103 项未运行。
- `npm run typecheck` 运行一次，通过。对本轮涉及的 TS/TSX 执行一次定向 ESLint，0 error、1 条 ref 清理 warning；调整后仅复查该文件及新增契约测试，迁移收尾只复查数据库与对应测试，均为 0 error、0 warning。未重复检查整个 App。`git diff --check` 通过，仅有现有行尾转换提示。
- 本轮未跑全量测试或 App 整文件，未启动 Electron 或调用真实模型；模型请求数为 0。验证包含生产 IPC/collector 与真实隔离 SQLite，以及真实 React 组件的异步交互测试，不能据此声称已完成真实模型或完整桌面端到端验收。未修改 Agent/远程执行协议或 Runtime 生命周期；此次改动在桌面 Main 的监督者输入、存储和查询层生效。全部 dirty 改动保留，未提交。

### 2026-09-23 侧栏结果直达图谱

- 对应 US-S25：SupervisionCard 有匹配结果时提供中英文“在图谱中查看 / View in graph”原生按钮。App 通过显式回调接收 resultId，遵守现有离页检查并打开 heartbeat 路由，向 HeartbeatCenter / SupervisorWorkspace 传递类型化导航请求；没有新增页面或 window 事件。沿用 schema 43 与现有 graph IPC，未改 Main、Preload 或存储。
- 图谱页签、键盘焦点和历史结果选择共用现有页面状态；同一结果再次点击、不同结果切换及 keepalive 再进入均重新定位，固定监督目标保持。导航切换立即清空旧图谱和详情；overview、graph、来源及操作的迟到响应不会改写新选择。overview 没有返回指定结果时仍按该 ID 请求图谱；失败可重试原 ID，不回退默认最新结果。
- 新增 7 个定向用例，最终均通过。首轮命令：`npx vitest run src/renderer/src/SupervisionCard.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/App.test.tsx -t 'graph navigation'`，3 项通过、2 项因测试使用旧文案失败。修正为实际“工作栏”“历史结果”文案并补充两项竞态测试后，仅运行 `src/renderer/src/SupervisorWorkspace.test.tsx src/renderer/src/App.test.tsx -t 'graph navigation'`，5 项通过、296 项未运行。请求状态收尾后仅复跑 SupervisorWorkspace 的同一筛选，4 项通过、11 项未运行。
- 测试覆盖真实 React 组件与 App 路由接线：首次只请求侧栏结果、固定目标、同结果重复点击、不同结果、keepalive 页面实例不变、历史选择同步、页签方向键及焦点、中英文/空态入口、旧 overview/graph/来源迟到、指定 ID 不在 overview 和失败重试。IPC 在这些 UI 测试中为替身，未声称真实桌面端到端验收。
- 本轮涉及的 10 个 TS/TSX 文件定向 ESLint 通过，0 error、0 warning。`npx tsc --noEmit -p tsconfig.node.json` 与 `npx tsc --noEmit -p tsconfig.web.json` 各一次有效源码检查通过；此前附加 `--incremental false` 的启动因 composite 配置报 TS6379，未执行源码检查。`git diff --check` 通过，仅有现有行尾提示。
- 未运行 App 整文件、全量测试、全量 lint、Agent typecheck、Electron 或真实模型请求；模型调用为 0。此次仅修改桌面 Renderer 导航和异步展示，不影响 Agent/远程 Runtime。保留全部其他 dirty 改动，未提交。

### 2026-09-23 自动监督设置

- 对应 US-S22 至 US-S24：当时设置直接显示完整自动监督配置，并保留运行概览、建议、报告与记录次要面板；2026-09-24 已迁移这些面板并移除内部导航。界面统一中英文命名，保留内部 heartbeat 标识和已有内容。无计划时明确显示仅支持手动回顾，填写草稿不触发保存或运行。
- 核对共享 recurrence 合同及实际调度器后，仅展示已支持的每日、每周指定时间；页面明确说明不支持分钟间隔。编辑保留原时区和暂停状态，计划列表显示范围、周期、时区、回顾窗口与保留期限，继续提供编辑、暂停、恢复、运行及确认删除。
- 已核对 App、Preload、Main 和 HeartbeatService 的既有 CRUD 接线，本轮未修改调度器或创建默认计划。保留工作区原有默认关闭及 Main 启用检查改动。
- 定向测试：`HeartbeatCenter.test.tsx` 23 项、`application-settings-store.test.ts` 50 项通过；`heartbeat-recurrence.test.ts`、`heartbeat-service.test.ts`、`heartbeat-database.test.ts` 合计 17 项通过；`ipc.test.ts -t 'heartbeat enabled gates'` 4 项通过、128 项未运行。覆盖中英文直接入口、每日/每周提交、多项目、无效窗口、失败保留草稿、时区及暂停状态、各项计划操作，以及默认关闭、无计划不运行和启停行为。首轮整文件运行发现原有顶层图谱测试未清理 DOM，补充文件级 cleanup 后通过。
- `tests/supervisor-layout.electron.test.ts` 通过：生产 React 组件的自动监督设置在 1440、1024、390px 和浅深主题下测量无横向溢出，周频表单全部控件边界可达，默认配置页及未配置说明存在。该测试使用隔离 fixture；未将其表述为真实模型或用户数据库端到端验收。
- `npm run typecheck` 通过；本轮 9 个 TS/TSX 文件及 Electron driver 的定向 ESLint 通过。按要求未运行全量测试，真实模型调用 0 次；没有 Agent 或远程 Runtime 改动，未提交或推送。

### 2026-09-23 活动页签

- 对应 FR-S10、US-S26：schema 45 复用运行表保存监督开始、完成和失败，并按真实心跳 ID 合并报告和下游监督。手动失败、报告完成但下游运行中/失败、回调失败、应用重开后的未完成记录均有真实 SQLite 测试。没有新的执行引擎或取消协议。
- 类型化活动 IPC/Preload 已接入生产页面；关闭应用不查询，页签或路由离开停止刷新并忽略迟到响应。每页 50 条，串行轮询，读取失败可重试。历史结果通过 resultId 定位，保留现有自动监督设置。
- `npx vitest run src/main/assistant/supervision-activity.test.ts src/main/assistant/supervisor-service.test.ts src/main/assistant/heartbeat-service.test.ts src/preload/supervision-activity.test.ts src/renderer/src/SupervisorActivity.test.tsx src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx`：7 个文件、58 项通过。
- `npx vitest run src/main/assistant/supervision-activity.test.ts src/main/assistant/heartbeat-database.test.ts src/main/assistant/supervision-history.test.ts`：3 个文件、14 项通过，包含 schema 44 升级及重开保留。
- `npx vitest run src/main/ipc.test.ts -t 'supervision|heartbeat enabled gates'`：8 项通过、124 项未运行。新增活动查询首次运行暴露 UNION 排序列缺少别名，修正后真实 SQLite 和 IPC 均通过。
- `npx vitest run tests/supervisor-layout.electron.test.ts`：1 项通过，新增活动页 1440、1024、390px 浅深主题测量，长错误、元数据和操作无横向溢出，短窗口页签保持高度。测试使用生产组件和隔离 fixture，没有读取用户库。
- `npm run typecheck` 通过；定向 ESLint 通过。未跑全量测试或真实模型，模型调用 0 次。没有修改 Agent/远程 Runtime；工作区其他改动保留，未提交或推送。
- App 定向命令 `npx vitest run src/renderer/src/App.test.tsx -t 'Supervisor|graph navigation'`：5 项通过、281 项未运行。刷新互斥及焦点收尾后，`SupervisorActivity.test.tsx`、`HeartbeatCenter.test.tsx`、`supervisor-service.test.ts` 合计 31 项通过；22 个相关 TS/TSX/MJS 文件的定向 ESLint 为 0 error、0 warning。
- 结束时间收尾：手动心跳使用真实报告完成时间，下游失败单独记录结束时间。`npx vitest run src/main/assistant/supervision-activity.test.ts src/main/assistant/heartbeat-service.test.ts src/main/assistant/heartbeat-database.test.ts src/main/assistant/supervision-history.test.ts`：4 个文件、21 项通过，新增受控时钟用例区分 10:00 开始、10:02 报告完成、10:03 下游失败。随后 Node typecheck 和这 3 个改动源码/测试文件的 ESLint 通过。
- 已存在的手动失败无法补回；旧心跳没有冻结范围和关联 ID，保留缺失提示。心跳仍按原保留期限清理，监督结果独立保存。取消和人工修改时间序列审计未实现；`no_change` 的后续接入见下节。

### 2026-09-28 继续讨论正文与布局

侧栏与图谱来源详情直接显示可编辑的发送正文，移除隐藏上下文拼接及附带提示。目标会话独立分隔，底部复用共享右对齐操作区。失败保留草稿，取消不发送，目标切换继续使旧预览失效。Main 的来源筛选与发送契约未修改。

- `npx vitest run src/renderer/src/SupervisionDiscussion.test.tsx src/renderer/src/SupervisionCard.test.tsx`：10 项通过，覆盖正文可见、编辑后精确提交、删除引用后不补回、失败重试、取消、重复提交和目标切换。
- `npx vitest run src/main/ipc.test.ts -t 'scopes supervision continuation|dispatches supervision continuation'`：2 项通过，使用真实 SQLite 与队列解析器核验来源范围及空附件发送。
- `npx vitest run tests/supervisor-layout.electron.test.ts` 分别设置 `GOODBUDDY_SUPERVISOR_DISCUSSION=1`、`GOODBUDDY_SUPERVISOR_SIDEBAR=1` 运行通过。图谱覆盖 1440/390px，侧栏覆盖 480/300/200px，均含浅深主题；检查 16px 区块间距、8px 字段间距、目标分隔、右对齐及无横向溢出，侧栏另检查滚动后按钮可命中。截图与测量保存在临时目录 `opencode/discussion-feedback-graph`、`opencode/discussion-feedback-sidebar`。
- Renderer 类型检查 `npx tsc --noEmit -p tsconfig.web.json`、8 个改动 TS/TSX/MJS 文件的定向 ESLint 与改动文件 `git diff --check` 通过。Electron 使用生产组件和模拟数据，未调用模型；未跑全套测试，未提交。

### 其他边界

- 新批次来源读取按 messageId 返回已保存片段及版本；旧历史缺少消息 ID 时保留会话/时间定位。本地知识引用通过现有 `KnowledgeService` 解析文档/分块，失效时显示不可用；外部引用只使用已保存 locator，不调用远端全库。
- 继续讨论和知识库写入使用现有本地会话队列与知识库实体接口，并要求先预览、再由用户确认提交。侧栏支持结果直达图谱；继续讨论的侧栏与图谱入口均已提供可编辑的实际上下文正文，发送规则见 [UI 设计](./ui-design.md)。
- 关系移除保留撤销状态及原始来源；界面没有提供恢复入口。
- 候选集最多 100 个实体，复用依赖模型显式选择；不会自动合并历史重复实体或跨 scope 合并。结果级历史内容已保存，事件滑块仍不重建逐事件的实体演变。Experiment 和完整图谱回放尚未实现；批次暂停/继续已接通。

## 2026-09-23 自动增量验证

对应 FR-S4、FR-S10、US-S27。自动心跳报告与下游监督均已接入来源版本和处理位置；无变化跳过模型并保存 `no_change`。消息修订、任务状态、知识引用变化分别参与增量判定，已确认记忆只作背景。实现、预算和删除语义见[自动增量收集](./technical-design.md#自动增量收集)。

- schema 46 增加最小来源进度与消息版本，扩展已有心跳状态 CHECK。来源片段进度与对应结果原子保存，模型或事务失败不推进。未送入模型的来源及正文余段保留待处理资格。
- `incremental-review.test.ts` 使用真实 SQLite 和生产服务，覆盖重开数据库、重复零调用、消息修订后复用实体 ID、105 个长来源分批读完、模型及结果事务失败、任务状态、范围排序、记忆背景、知识引用、报告保存失败和 schema 45 有数据升级。
- 真实模型使用已有加密默认文本配置，经 `RuntimeSettingsStore` 和 Electron `safeStorage` 读取隔离副本，生产 `createDefaultModelRuntime`、`HeartbeatService`、`SupervisorService` 和 SQLite 执行。`tests/incremental-review-live.electron.test.ts` 于本日通过：首次自动运行 2 次 HTTP 请求，重复自动运行 0 次，修改消息后的监督回顾 1 次，再次监督检查 0 次，总计 **3 次真实文本请求**。工具与附件均为 0。
- 真实输出通过结构、来源及实体引用校验，修改后的 Atlas 实体至少复用一个原持久化 ID；无变化检查前后图谱相同。测试检查原设置字节未变、外键与数据库完整性。隔离数据库、配置快照和加密 Local State 随测试目录删除，未改用户计划或数据库。
- 实时测试命令：设置 `GB_REVIEW_LIVE_SETTINGS` 为已有运行时配置路径后，执行 `npx vitest run tests/incremental-review-live.electron.test.ts`。无该环境变量时跳过；每次测试最多 3 个真实请求，不记录凭据。
- 最终聚焦验证：10 个服务、SQLite、Preload 和 Renderer 测试文件共 76 项通过；`npx vitest run src/main/ipc.test.ts -t 'supervision|heartbeat|application enable'` 另有 9 项通过，124 项按过滤条件跳过。`npm run typecheck`（Node、Agent、Web）和本次改动的 19 个 TypeScript 文件 scoped ESLint 均通过。

真实测试覆盖来源较短的单次自动回顾、重复检查及修改后的实体复用。长正文和大量来源预算由确定性 SQLite 回归验证；没有执行全量测试或真实用户数据库升级。事件驱动、清空或重建图谱和语义近似去重不在本次实现范围。
- 知识正文条目与监督实体仍是两个模型，当前不会把监督实体当作知识正文条目。
