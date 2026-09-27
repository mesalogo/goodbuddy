# 窄容器布局审查修复记录

日期：2026-09-27。范围为全局样式审查第三阶段的工作栏添加入口和模型设置布局。
此前 MCP、共享控件、浮层和深色主按钮对比度修复均保留。

## 修复

工作栏原先将“+”放在页签滚动区内，`300px` 栏宽下默认四个页签就会将按钮卷出可见区。
现在添加按钮独立占用行末宽度，页签及两端滚动箭头放在剩余区域内；溢出测量也读取该区域。
没有改动应用目录、实例策略、持久化或终端生命周期。

模型设置原先按整窗 `720px` 断点切换单列。`721px` 窗口仍保留分类、连接列表和表单三列，
协议选择框宽度只有约 `136px`。现在 `.model-connection-manager` 自身作为命名容器，
可用宽度不超过 `640px` 时让列表及详情各占整行，列表保留 `180px` 的内部滚动上限。
更宽时沿用原双栏。LLM、向量连接和角色编辑共用这条规则，没有增加页面专属断点。

产品规则见 [UI-DESIGN.md](../../UI-DESIGN.md)、
[工作栏页签 PRD](../features/assistant-workbar/terminal-tabs-prd.md#71-tab-行)和
[模型连接 UI 设计](../features/model-connections/ui-design.md)。工作栏两份 PRD 中“+ 随页签
滚动”的旧说明已纠正。

## Electron 证据

[workbar-settings-layout.electron.test.ts](../../tests/workbar-settings-layout.electron.test.ts)
在隔离 profile 中加载当前生产 `WorkbarShell`、`SettingsPanel`、共享样式及字体。
测试使用受控 IPC 配置数据，不访问模型服务。Windows Electron 共记录 32 组结果，包含：

- 中文与英文、浅色与深色主题。
- `300px` 工作栏的默认四个页签、16 个含长标题的页签，以及从目录新建第 17 个实例。
  检查“+”位于可见栏内且中心点可命中，原生鼠标打开目录、创建浏览器实例；Escape 返回
  添加按钮。滚动箭头不改变活动页签，Home/End 激活并显示首末页签。
- 默认页签下将工作栏扩到 `900px` 再缩回 `300px`，检查溢出箭头退出及恢复。
- 设置内容区窗口为 `680×560`、`720×560`、`721×560`、`740×560`、`960×560`、
  `1180×760`。另在 `1180×560` 窗口中将设置面板限定为 `740px`，检查同一窗口内的
  容器响应，而非仅检查媒体断点。
- 长连接名称下，协议当前值的真实字体测量宽度小于控件扣除内边距及箭头后的可用宽度。
  设置内容区、连接管理区及详情无横向溢出，协议框可命中；原生 Tab 进入后，方向键改变
  协议，Home 还原。`721px` 窗宽下控件 clientWidth 为 `370px`，英文协议文字约 `233px`。

通过 `GB_LAYOUT_ARTIFACTS` 可输出截图和 `result.json`。已查看英文深色 `721px` 设置、
英文宽窗口窄容器及中英文工作栏截图。测试退出后删除专用 profile 与 Vite 缓存。

## 验证命令

```text
npm test -- src/renderer/src/WorkbarShell.test.tsx src/renderer/src/WorkspacePrimitives.test.tsx src/renderer/src/SettingsPanel.test.tsx src/renderer/src/EmbeddingSettingsSection.test.tsx src/renderer/src/RolePromptSettingsSection.test.tsx src/renderer/src/RightAssistantSidebar.resize.test.tsx tests/workbar-settings-layout.electron.test.ts tests/shared-controls.electron.test.ts
npm run typecheck
npm run lint
```

Focused 回归 8 文件、238 项通过；typecheck 和 lint 通过。前阶段共享控件 Electron
回归的 338 组状态测量仍通过。模型调用 0 次，未提交代码。
补强页签焦点与选中态同步断言后，新增 Electron 回归连续三次完整通过，每次 32 组结果。

新驱动调试期间修正了目录按钮选择器、环境变量类型声明和 Electron 方向键名称。
原生 select 弹出菜单的关闭时序曾使驱动超时，最终使用原生 Tab 与方向键验证字段操作，
并保留命中、文字宽度和溢出断言；没有放宽产品断言或增加生产代码补丁。
后续联合运行曾停在调整窗口后的动画帧等待。驱动补充了超时脚本记录，并在测试进程中关闭
Windows 原生遮挡节流，等待窗口焦点和尺寸后再同步绘制及发送鼠标输入。该设置不进入产品。
最终连续三次回归通过；超时记录不足以单独证明此前每次停顿的唯一原因。

## 限制

这是当前生产组件的真实 Electron 布局与输入回归，IPC 数据使用 fixture；不证明完整 App
的配置保存或模型调用链路。未覆盖原生 select 弹出菜单的鼠标选项选择、macOS/Linux、
系统缩放、200% 字号、原生窗口遮挡节流和全部设置类别。向量连接和角色编辑运行了组件回归，但本次 Electron
矩阵仅验证 LLM 连接表单。本阶段定向验证未运行全仓测试或生产构建；后续全仓结果见下节。

## 全部样式修复最终验证

2026-09-27 在 Windows 开发环境完成最终验证。范围为共享控件 8 项、浮层 5 项、
窄容器 2 项，共 15 项样式问题，以及 MCP 子 Modal 修复。先读取根目录 `AGENTS.md`，
检查未提交源码和文档 diff；原有 37 个已跟踪修改文件、12 个未跟踪文件均保留，暂存区为空。
本次新增的生产修正仅为 `ProjectSwitcher.tsx` 的初始字段选择器一行，未改测试断言。

| 命令与执行范围 | 实际结果 |
| --- | --- |
| `npm test`，当前工作树，全仓且无 bail | 463 文件：450 通过、2 失败、11 跳过；5395 项：5309 通过、3 失败、83 跳过。耗时 696.22 秒 |
| `npm test -- src/renderer/src/HeartbeatCenter.test.tsx`，隔离 HEAD `11facf0` | 1 文件失败；40 项通过、2 项失败，耗时 4.86 秒，与当前工作树同一行、同一中英文断言失败 |
| `npm test -- src/renderer/src/App.test.tsx src/renderer/src/ProjectSwitcher.test.tsx tests/overlay-layering.electron.test.ts`，焦点修复后 | 3 文件、331 项通过，耗时 80.57 秒 |
| `npm run typecheck` | 全仓测试后及焦点修复后均通过，覆盖 node、agent、web 三份 TypeScript 配置 |
| `npm run lint` | 全仓测试后及焦点修复后均通过 |
| `git diff --check` | 通过；Git 提示已有 LF 将转换为 CRLF，没有空白错误 |

完整 `npm test` 只启动一次，超时设为 1,200,000 毫秒，等待正常结束，没有 bail、
中止或重复启动。修复后只复跑相关集合，未把定向通过改写成全仓通过。

### 失败归因与处理

`App.test.tsx:8921` 是本次回归。项目 Modal 新接入的初始焦点逻辑只查询 input，
覆盖了通道项目说明 textarea 的原有自动聚焦，实际焦点落到后面的默认工作目录。
确认组件结构和失败输出后，选择器改为按 DOM 顺序查询未禁用的 input、textarea、select，
无字段时仍退回按钮。原有说明字段焦点断言保持不变，App 全文件及项目切换组件、真实
Electron 浮层回归共 331 项通过，包含窄侧栏 Escape 隔离与 MCP 保存重读路径。

`HeartbeatCenter.test.tsx:213` 的中文、英文两项失败为既有问题。测试要求全页只有
1 个 tablist，并要求内容面板内没有 tablist；但图谱有事件数据时，
`SupervisorWorkspace.tsx:677` 已渲染事件、实体、关系的内层 `PageTabs`，实际总数为 2。
未带本轮改动的 HEAD `11facf0` 使用相同依赖独立执行该文件，也得到 40 通过、2 失败。
当时保留组件与断言；后续修复及定向验证见下节。

### HeartbeatCenter 断言修复

2026-09-27 后续核对[监督者 UI 设计](../features/conversation-supervision/ui-design.md#故事线图谱)、
`HeartbeatCenter`、`SupervisorWorkspace` 和共享 `PageTabs`：顶层导航与图谱分类导航各有
独立可访问名称，图谱内层页签符合设计。修改前按测试名称复跑，中英文均在原第 213 行失败。

测试现按 role 和可访问名称分别定位两层导航，核对顶层五页签、图谱事件/实体/关系及数量、
唯一选中态和 tab/panel 双向关联；方向键切换内层页签时检查焦点、事件内容或分类空态，
并确认顶层仍选中故事线图谱。非图谱页面继续断言没有内层 tablist，原有标题、范围和操作
断言保留。生产代码未改；设计文档澄清“一套 PageTabs”指顶层导航。

`npm test -- src/renderer/src/HeartbeatCenter.test.tsx src/renderer/src/SupervisorWorkspace.test.tsx src/renderer/src/WorkspacePrimitives.test.tsx`
通过 3 文件、96 项，包含 HeartbeatCenter 全部 42 项。`npm run typecheck` 通过；
`npm run lint` 首次超过 60 秒执行时限，提高时限重跑后通过。本轮未重新运行全仓测试，
上表历史全量结果及跳过项保持原记录。

### Electron 结果与未测范围

全仓运行中，共享控件输出 338 组 computed style 测量，窄容器输出 32 组布局和输入结果。
overlay 文件 3 项通过，包含 MCP 四种主题/窗口/浏览器场景、生产 IPC 保存与重新读取，
以及大图、iframe、项目 Modal、tooltip、知识引用五条路径；焦点修正后该文件再次通过。
这些样式与 MCP 驱动的模型请求尝试为 0。全仓另有隔离的 403 fixture 输出，每种凭据来源
各记录 1 次请求；这不作为真实模型生成证据，也不据此声称全仓外部调用总数为 0。

当时剩余的两项 HeartbeatCenter 断言已由上述定向验证确认修复。全仓跳过的 11 文件、83 项仍未形成通过证据。
本次没有运行生产构建、打包、macOS/Linux 验证、远程 Agent 实机或外部 MCP 连接；
未覆盖强制颜色、完整系统缩放/200% 字号矩阵、原生 select 弹出菜单的鼠标选项选择，
也未将组件 fixture 当作全部 App 业务入口验收。部分 Electron 驱动关闭了 Windows
原生遮挡节流，不能据此宣称产品在原生遮挡状态下也已覆盖。没有 commit 或 push。
