# 应用导航与系统工具入口技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 应用中心与本机推理监控已接入源码，整体验收待完成 |
| 版本 | 0.4 |
| 日期 | 2026-09-17 |
| 关联 PRD | [应用导航与系统工具入口 PRD](./prd.md) |
| 功能逻辑 | [功能逻辑设计](./logic-design.md) |
| UI 设计 | [UI 设计](./ui-design.md) |

## 1. 现状

主页面没有 URL Router，由 `App.tsx` 中的 `WorkspaceView` 和 keep-alive 状态切换；该类型也包含由独立状态打开 Modal 的入口：

```ts
type WorkspaceView =
  | 'chat'
  | 'magic-notes'
  | 'knowledge'
  | 'heartbeat'
  | 'local-inference'
  | 'activity'
  | 'settings'
```

文件、浏览器和终端已经由 `RightAssistantSidebar`、`WorkbarShell` 与 `workbar-contracts.ts`
承载。工作区是不可关闭的单实例应用，浏览器和终端是多实例应用。浏览器多实例的跨进程
实现以[浏览器多实例技术设计](../assistant-workbar/browser-tabs-technical-design.md)为准。代码中尚无资源指标采集和资源监控
面板。侧栏底部已替换为应用中心与独立设置按钮。

应用中心、四应用共享排序、可选应用常驻及启用联动、共同设置页和本机推理监控已接入生产源码；本机资源监控的
Main/Preload/Renderer 实现仍待交付。系统工具只使用右侧工作栏已有 Tab 和“+”链路。
行为由[功能逻辑](./logic-design.md)定义，验证范围见[实施进度](./progress.md)。

## 2. 模块边界

| 模块 | 责任 |
| --- | --- |
| `App.tsx` | 组合主导航、应用中心、固定设置，持有确认配置及页面离开检查 |
| `ApplicationMenu.tsx` / `AnchoredMenu.tsx` | 底部向上锚定的已启用应用菜单；关闭后导航，或打开既有管理 Modal；共享几何定位与键盘行为 |
| `ApplicationCenter.tsx` | 浏览、搜索内置清单，调用既有页面导航及共同设置入口，编辑常驻和顺序；复用设置 Modal 样式和焦点工具 |
| `ApplicationSettingsView` | 位于 `ApplicationCenter.tsx`，由应用中心卡片进入的应用配置表单 |
| `RightAssistantSidebar.tsx` | 保留右侧工具 Tab 和“+”目录调用链路 |
| `WorkbarShell.tsx` | 继续负责实例策略、Tab、目录和焦点行为 |
| `workbar-contracts.ts` | 继续作为工作栏应用 ID 和实例布局的权威契约 |
| `resource-monitor-contracts.ts`（新增） | 定义本机资源快照、可用性和错误码 |
| `resource-monitor-service.ts`（新增） | 在 Main 中采集并规范化本机与 GoodBuddy 指标 |
| `ResourceMonitorPanel.tsx`（新增） | 按需轮询、保留有界历史并渲染资源面板 |
| `application-settings-contracts.ts` | 定义常驻、顺序及应用启用字段；保留笔记既有配置键 |
| `application-settings-store.ts` | 迁移默认值，串行合并更新并原子保存，返回完整确认快照 |
| `PlatformFeaturesSettingsSection` | 移除全局笔记设置页签、跳转入口及专用回调，保留通用设置和远程项目 |

应用中心只编排应用导航和配置，不读取文件、创建 PTY、操作浏览器或采集系统指标。
不增加左侧工具组件、左侧工具状态镜像或主侧栏到工作栏的专用命令通道。

## 3. Renderer 契约

### 3.1 内置应用清单

```ts
type BuiltInApplicationId = 'magic-notes' | 'knowledge' | 'heartbeat' | 'local-inference'

type BuiltInApplicationDefinition = {
  id: BuiltInApplicationId
  source: 'builtin'
  titleKey: string
  descriptionKey: string
  view: BuiltInApplicationId
}
```

全部应用 ID 在 `application-settings-contracts.ts` 的 `BuiltInApplicationId` 定义；`EditableApplicationId` 仅包含 `magic-notes`、`local-inference`。Renderer 的 `applicationDefinitions` 映射图标、国际化键和可选应用启用键，知识库和智能心跳始终可用。
`App.tsx` 默认导入 `LocalInferencePage`，传入 `onClose`、`enabled` 和 `restoreFocus`。`local-inference` 保留为入口 ID，`setView` 在提交工作区切换前将其转为 `localInferenceOpen = true` 并返回，不更新 `view` 或 KeepAlive 缓存；组件按该独立状态挂载及卸载。
静态清单复用既有应用页面和国际化键。管理 Modal 的搜索只过滤该清单，包含未常驻和关闭的应用，不请求
远程目录。启用、常驻和排序从确认配置派生，不在清单中持久化第二份状态。

### 3.2 应用与设置导航

应用中心调用既有 `navigateFromSidebar` 或同一页面导航函数，沿用未保存离开检查和焦点
策略。打开前检查确认的启用值；未常驻但已启用的应用不附带常驻写入。本机推理监控从常驻入口、菜单及管理 Modal 均经 `setView('local-inference')` 打开独立 Modal，保留底层工作区与设置草稿；其他应用继续页面导航。
`ApplicationMenu` 按四个应用共用的持久化顺序派生清单，仅按启用过滤，不读取常驻或打开历史。应用行先关闭菜单再导航；底部“管理应用”关闭菜单、恢复锚点焦点并打开既有 `ApplicationCenter` Modal。
应用中心卡片的设置操作仅接受 `EditableApplicationId`；应用页和全局设置不提供重复入口。知识库和智能心跳的管理卡片提供“打开”和排序，原工作区实际配置保留，不添加通用空设置页。
共同页复用设置 Modal 容器、配置读取及更新方法，不建立独立配置存储或重复表单。

### 3.3 工作栏选择与创建

已有 Tab 仅按实例 ID 激活，保留目标和历史状态。不得按当前项目、执行空间或 Conversation
查找最近匹配实例替代用户选择，也不在选中时自动重建退出或失败终端。

“+”选择终端每次调用既有创建流程，解析当前 `ExecutionSpaceSelection`，绑定本机或托管
SSH 项目的权威目录；无项目时使用本机 Home。选择浏览器每次创建额外实例，绑定当前
Conversation，无 Conversation 时创建待绑定空实例。同一 Conversation 的浏览器页面独立，
登录上下文共享规则继续由工作栏负责。文件按单实例聚焦，缺失时仅由布局修复补回。
选择现有文件 Tab 保留跟随或固定模式，固定目标失效时不切换目标。

### 3.4 资源监控工作栏应用

在 `workbar-contracts.ts` 中增加 `resources`：

```ts
{
  id: 'resources',
  instancePolicy: 'single',
  defaultContext: 'application'
}
```

该应用不加入升级后的默认打开实例，仅通过右侧已有 Tab 或“+”目录访问，使用既有单实例
规则创建或聚焦。左侧应用清单不包含 `resources`。

## 4. 应用导航偏好

### 4.1 设置结构

在 `ApplicationSettings` 增加独立字段：

```ts
type ApplicationNavigationSettings = {
  order: BuiltInApplicationId[]
  pinned: Record<EditableApplicationId, boolean>
}
```

`applicationNavigation` 保存四个应用的完整顺序和两个可选应用的常驻布尔值。默认顺序为
`knowledge`、`heartbeat`、`magic-notes`、`local-inference`；可选应用常驻分别默认 `true`、`false`。
权威返回 schema 和更新 schema 均要求四个 ID 各出现一次，拒绝重复、未知和缺失 ID；`pinned` 仅接受两个可选应用的完整布尔映射。Renderer 直接读取该顺序，再按各入口的可见性过滤。知识库和智能心跳始终启用、常驻，无可写开关键。
按[排序规则](./logic-design.md#3-主导航组合规则)提交完整顺序；不持久化可推导的可见 ID 列表。
首期不预建插件字段，也不为未发布的旧隐藏 ID 草案增加迁移读取器。

### 4.2 与现有开关组合

可选应用侧栏入口可见条件如下，知识库和智能心跳按保存位置始终显示：

```ts
const visible = featureEnabled && applicationNavigation.pinned[id]
```

`magicNotesEnabled` 保留为笔记启用的唯一权威键，`localInferenceEnabled` 为本机推理监控应用启用键，默认 `true`，不在导航配置再复制 enabled map。心跳没有应用级启用字段，单条计划 enabled 的业务含义和存储不变。关闭可选应用时保留常驻控件和恢复入口。

笔记配置继续使用 `magicNotesShowIncompleteTodoCount`、`magicNoteCommentMode` 和
`magicNoteCommentFormat`，应用中心与笔记页使用同一 schema 和更新链路。未配置的笔记
布尔值（含 `magicNotesEnabled`）默认 `true`；迁移必须用字段是否存在区分缺失与显式 `false`，
不能用 `value || true`。已有单选值保留，缺失时分别使用 `immediate` 和 `combined`。
若旧“显示入口”实际绑定 `magicNotesEnabled`，保留其启用含义和原值；独立常驻使用新字段，
不得直接把旧业务启用键改名为 pinned。只为确认已发布的独立显隐偏好增加对应迁移。

### 4.3 持久化与 IPC

沿用现有应用设置链路：

```text
Renderer
  -> window.goodbuddy.updates.updateSettings
  -> settings:application:update
  -> application-settings-store
  -> application-settings.json
```

Main 继续校验可信 sender、Zod 输入，复用 `ApplicationSettingsStore` 的更新队列，读取最新
确认值后合并本次 patch、原子写入并返回完整 `ApplicationSettings`。写入失败不发布目标值。
存储版本 12 补充可选应用导航和启用字段，为缺失字段补默认值；保留已有
`true`、`false`、单选值和无关设置，不迁移或清理笔记、知识及会话业务数据。
新安装和升级时缺失整个 `applicationNavigation` 均使用共享默认值，本机推理监控启用但不常驻；本次不增加存储版本。已保存的常驻值均保留，无法区分旧默认 `true` 与用户主动固定，不强制改为 `false`。

仅存储读取允许补齐旧数据：缺失的 `knowledge`、`heartbeat` 按此顺序前置，再保留已有 ID 的相对顺序，最后按默认顺序追加缺失的可选应用。旧 `[local-inference, magic-notes]` 因此变为 `[knowledge, heartbeat, local-inference, magic-notes]`；完整四项顺序原样保留。缺失或空顺序采用默认顺序，部分 `pinned` 映射仅补缺失键，显式 `false` 保留。重复或未知 ID 仍按现有损坏文件处理规则处理，不静默去重或丢弃。版本 11 迁移时写入归一化结果；版本 12 读取时归一化，下一次设置保存时写入完整结果。IPC 和配置工具写入不接受这些部分数据。

版本 12 属于未发布的分支格式，原草案 `knowledgeEnabled`、`heartbeatEnabled` 已移除，不为这些开关键增加兼容读取器。

## 5. 侧栏底部重构

原 `user-card` 整行设置按钮已替换为容器和相邻独立按钮：

```tsx
<div className="sidebar-footer">
  <button onClick={toggleApplicationMenu} aria-haspopup="menu" aria-expanded={applicationMenuOpen} ...>
    {t('navigation.applicationCenter')}
  </button>
  <button aria-label={t('navigation.settings')} ...>
    <Settings aria-hidden="true" />
  </button>
</div>
```

应用中心和设置为相邻独立按钮。设置按钮继续调用 `navigateFromSidebar('settings', trigger)`，
保留设置预加载、焦点恢复和未保存离开确认。该调用只打开设置 Modal，不更新当前工作区或
KeepAlive 缓存；`settingsOpen` 独立管理打开状态。关闭后卸载设置内容，下次按入口指定的分类
和消息通道重新挂载，避免缓存上次分类覆盖本次直达目标。底层工作区继续挂载，普通关闭不跳回聊天。

应用菜单使用 `AnchoredMenu` 的 body Portal，向上锚定，无模态遮罩或背景隔离；`menu` 语义纳入共享浏览器 viewport 相交遮挡。管理 Modal 及共同设置沿用原 Portal、焦点隔离、恢复及 Escape 机制。
不在主侧栏复制工具入口。工作栏仍由窗口右上方固定开关展开和关闭，关闭后焦点返回该开关。

## 6. 应用可用性与知识请求

Renderer 从同一确认快照派生可选应用主导航、中心状态和页面可用性，依赖只包含相应
字段。keep-alive 页挂载不代表应用仍启用；禁用后在原位置渲染不可用状态，
保留页面草稿及业务数据，阻止新的页面操作。重新启用不触发导航或业务重放。

`ApplicationAvailability` 隐藏并设置业务内容为 inert，保留挂载的页面实例；重新启用从
应用中心卡片设置进入。笔记页面直接消费确认的评论配置，
不因修改评论方式而重建编辑器。

知识库和智能心跳不经过 `ApplicationAvailability`；会话知识按钮、范围、检索方式和标签继续遵守原知识库规则，心跳计划 enabled 保持不变。
请求构建没有应用级禁用知识库的裁剪或守卫；本机、托管 SSH 和排队请求沿用原知识上下文链路。
单个知识库实例的配置、停用、删除及取消清理仍由知识库功能负责。

## 7. 串行保存与确认快照

中心与应用页的启用、常驻、排序及笔记配置共用一个 Renderer 更新入口及 pending
状态。任一提交未完成时，所有入口中修改这组设置的控件暂时禁用；下一次操作基于最新确认
快照生成 patch，不提交整个过期 `ApplicationSettings` 覆盖无关字段。Main 队列仍负责串行合并。

`ApplicationSettingsStore.update` 在持久化成功后通过 `onChanged` 发布完整快照；IPC 转发
`applicationSettingsChanged`，Preload 提供 `updates.onSettingsChanged`。工具配置服务调用同一 Store，
因此配置工具写入也同步界面，保存失败不发事件。`App` 收到事件后推进读取修订号并替换快照，
迟到的旧读取及旧保存响应不能覆盖新状态。每次重开中心都刷新配置，刷新期间锁定修改，失败后
保留锁和重试入口；控件不先乐观生效。
明确保存失败时保留最后确认值，就地显示可重试错误与编辑上下文。若 IPC 响应中断而写入
结果未知，通过既有设置读取重新取得权威快照再解锁；读取失败继续显示错误并允许重试读取，
不自动重发变更或写回旧配置。无须引入持久化回滚日志或独立导航快照文件。

## 8. 插件兼容边界

首期不增加市场 URL、YAML 导入导出、ShareServer API、插件注册表或安装服务。FR-15 的
私有市场协议、YAML Schema、资源分发与扩展生命周期另行设计；系统 ID 不向插件开放。
不得直接复用 DeepSeek Harness 的 npm 插件市场。后续依赖见第 11 节，首期不预建占位界面。

## 9. 本机资源监控

### 9.1 采集范围

首期在 Main 中使用经过依赖审查的 `systeminformation` 获取整机 CPU、内存和磁盘 IO，使用
Electron `app.getAppMetrics()` 汇总 GoodBuddy 桌面进程 CPU、内存和进程数。采集函数不接收
Renderer 提供的路径、PID、设备名或命令。

首期指标定义：

- CPU：整机忙碌时间占比，规范化为 `0` 至 `100`。
- 内存：总字节数、可用字节数和 `总量 - 可用量` 得到的使用量。
- 磁盘 IO：所有可用本机磁盘的每秒读取与写入字节数。
- GoodBuddy：`app.getAppMetrics()` 返回的桌面进程聚合 CPU、工作集内存和进程数量。各进程
  CPU 先相加，再按逻辑处理器数量归一化为整机容量占比 `0` 至 `100`；不能通过截断总和处理
  多核数值。

受管 Runtime、MCP 和终端子进程的逐进程指标不在首期范围。磁盘 IO 在平台或权限不足时返回
不可用错误码，不能回退为 `0`。新增依赖在合入前需要完成许可证、维护状态、打包体积和供应链
检查；检查未通过时应选择提供同等跨平台语义的 Main 侧实现，不能改用 Renderer Shell 命令。

### 9.2 快照契约

```ts
type ResourceMetric<T> =
  | { status: 'available'; value: T }
  | { status: 'warming-up' }
  | { status: 'unavailable'; reason: ResourceMetricUnavailableReason }

type LocalResourceSnapshot = {
  sampledAt: string
  host: {
    cpuPercent: ResourceMetric<number>
    memory: ResourceMetric<{
      usedBytes: number
      totalBytes: number
    }>
    diskIo: ResourceMetric<{
      readBytesPerSecond: number
      writeBytesPerSecond: number
    }>
  }
  goodbuddy: {
    cpuPercent: ResourceMetric<number>
    memoryBytes: ResourceMetric<number>
    processCount: ResourceMetric<number>
  }
}
```

所有数字必须有限且非负；百分比限制为 `0` 至 `100`，字节数设置跨 IPC 上限。`sampledAt` 由
Main 生成。不可用原因使用稳定枚举，例如 `unsupported-platform`、`permission-denied`、
`collector-timeout` 和 `collector-failed`，不向 Renderer 返回原始命令输出。`warming-up` 只用于
依赖两个采样点的 CPU 与磁盘 IO，不能用于掩盖采集失败。

### 9.3 Preload 与 IPC

Preload 只暴露：

```ts
resourceMonitor.getLocalSnapshot(input: {
  resetIntervalBaseline: boolean
}): Promise<LocalResourceSnapshot>
```

对应 IPC 为 `resource-monitor:local-snapshot:get`。Main 验证可信 sender；单次采集设置超时，
并合并同一时刻的并发请求，防止多个 Renderer 重复启动系统采集。采集超时后向调用方返回
有界错误，但底层 Promise 仍占用唯一单飞槽位，直到实际结束；在此之前不启动第二个采集
任务。输入只接受布尔值，接口不提供任意进程、磁盘或远程主机查询。

合并规则区分普通请求与基线重置请求：

- 普通请求在途时，新的普通请求复用它。
- 普通请求在途时收到重置请求，Main 最多登记一个待执行重置；当前采集结束后再执行，不能
  用普通请求结果满足重置请求。
- 多个重置请求复用同一个在途或待执行重置。
- 重置请求在途时，普通请求复用其 `warming-up` 结果，下一次时钟再取得区间值。

因此服务最多持有一个在途采集和一个待执行重置。调用方超时不取消这个顺序，也不增加队列
长度。

面板每次从非活动状态恢复后的首次请求传入 `resetIntervalBaseline: true`。Main 消费本次
`systeminformation` 与 Electron CPU 读数并重置区间基线，CPU 和磁盘 IO 返回 `warming-up`；
内存等瞬时指标正常返回。后续请求传入 `false` 并计算当前区间值，避免把面板停用期间计入
速率。

### 9.4 轮询与历史

`ResourceMonitorPanel` 仅在工作栏展开、`resources` 为活动实例且
`document.visibilityState === 'visible'` 时启动轮询：

1. 进入活动状态后立即请求一次，并设置 `resetIntervalBaseline: true`。
2. 此后每 2 秒请求一次；前一请求未结束时跳过本次时钟。
3. Tab 失活、工作栏收起、页面变为隐藏或组件卸载时清理定时器，并忽略较晚返回的旧请求。
4. Renderer 环形队列最多保留 150 个带真实时间戳的样本。
5. 采集失败不追加伪造样本，也不持久化历史。

资源数据不写入应用设置、工作栏布局、运行记录或 SQLite。工作栏布局只保存 `resources` 实例
及其活动状态。

## 10. 测试

### 10.1 Renderer 测试

- 固定入口不受应用启用、常驻和顺序组合影响，应用中心及设置始终可达；左侧没有重复系统工具。
- US-B6：底部菜单向上锚定且无遮罩，只列已启用应用，不受常驻或打开历史影响；点击行关闭菜单并导航，“管理应用”进入既有可搜索 Modal，包含关闭及未常驻应用。
- US-F3／US-F5：三个入口均打开本机推理监控 Modal 并保留底层工作区；覆盖嵌套确认的焦点循环、逐层 Escape、提交期间禁止关闭与重复执行、关闭后的入口及后备焦点恢复，以及停用内容后的键盘焦点。
- US-B7：常驻、取消常驻、键盘及拖动排序成功后同步，重新开启及重启保留原偏好和顺序。
- US-B8：知识库和智能心跳始终启用且常驻，卡片提供打开与排序，不提供启用或常驻开关，心跳计划 enabled 不变；可选应用关闭后的不可用页保留草稿，重新开启不自动导航或重放。
- US-B9：应用中心卡片进入笔记表单，管理启用、常驻、待办数量、评论方式及形式；笔记页和全局设置无重复入口。
- US-B5：所有入口共享 pending，保存失败保留相同确认值；重开刷新期间锁定修改，较新事件使旧读取失效；结果未知时重读，不自动重发。
- 文件复用不可关闭单实例；选择任一已有终端或浏览器 Tab 保留确切目标，“+”每次创建额外实例。
- 已退出、失败的终端 Tab 不因选中而重建；工具切换不改变主页面，后台状态不抢占 Tab。
- 窄窗口、键盘排序、共享 Switch、Tab 语义及浮层焦点恢复正确；中心和设置不被原生浏览器遮挡。
- 资源面板只在可见活动时轮询，跳过重叠请求并把历史限制为 150 项。
- 窗口隐藏、最小化和恢复时停止轮询并重新建立区间基线。
- 资源部分可用、全部失败和重新进入活动状态均显示正确结果。

### 10.2 Main 与契约测试

- 顺序包含四个应用 ID 各一次；公开写入拒绝重复、缺失、未知 ID 及无效常驻字段；旧存储顺序按迁移规则补齐，不为未发布的两个旧启用键添加迁移。
- 未配置启用及笔记布尔项默认开启，本机推理监控默认不常驻；已保存的常驻值和评论单选值经迁移及重启保留。
- 更新常驻或顺序不修改启用、计划或业务数据；笔记既有配置键保持语义。
- 串行 patch 在 Main 最新快照上合并，原子写入失败不发布目标状态；响应丢失后重读实际结果。
- Store 持久化后才发布变更，工具配置写入使用同一通知链路；知识库和智能心跳不受可选应用偏好影响。
- 保存启用失败不会改变业务判断；会话关联和历史知识引用不因入口隐藏被清空。
- 资源快照拒绝 NaN、Infinity、负数字节数、越界百分比和未知错误码。
- 采集超时、权限不足和磁盘 IO 不支持时返回有界部分结果。
- 超时采集尚未实际结束时保持单飞，不累积新的后台采集任务。
- 普通采集在途时收到基线重置请求，最多排队一个重置且不复用普通结果。
- `resetIntervalBaseline: true` 时把 CPU 与磁盘 IO 标记为 `warming-up`。
- GoodBuddy CPU 预热时，其内存和进程数仍可独立返回。
- GoodBuddy 多进程 CPU 按逻辑处理器数量归一化，结果保持在 `0` 至 `100`。
- GoodBuddy 摘要不包含 PID、命令行、环境变量或其他进程信息。

### 10.3 回归范围

- 工作栏布局恢复和已关闭实例重建。
- 本地与托管 SSH 终端目标。
- 浏览器无会话、创建中和 Agent 操作中状态。
- 设置页未保存离开确认。
- 魔法笔记待办数和智能心跳建议数徽标。
- 浅色、深色、`220px` 与 `420px` 侧栏宽度。
- Windows、macOS 和 Linux 的真实 CPU、内存与磁盘 IO 采集；不支持项显示准确原因。

FR-16 单独覆盖 US-F3 概览去重、未知指标、US-F4 单任务取消与完成竞态、US-F5 服务
实际启动/停止/重启或加载/释放、使用方确认、外部管理限制及失败真实状态；用接入的真实引擎
验证共享服务不被单任务取消终止，重启不重放。设计文档检查或模拟服务不算生产路径验证。

## 11. 实施顺序

实施范围以 [PRD 分期](./prd.md#8-分期)及最新评审决定为准，逻辑映射见
[需求对应](./logic-design.md#6-与需求的对应关系)。既有 FR/US 编号保持稳定；新增故事使用
US-B6 应用中心、US-B7 顺序、US-B8 启用联动、US-B9 笔记迁移，以及 US-F3 概览、
US-F4 取消、US-F5 服务生命周期。PRD、User Stories、配套设计与根 UI 规范已同步入口及持久化规则。

以下为实施阶段划分，应用中心及本机推理监控已接入源码，验证状态以进度记录为准。

1. 底部入口使用向上锚定的轻量菜单，通过“管理应用”进入既有整窗 Modal；核对已发布配置的迁移来源。
2. 接入现有内置应用页面与最底部应用中心入口，保留独立设置和固定运行记录入口。
3. 实现常驻、完整顺序及启用契约，迁移时保留明确旧值，通过串行保存与确认快照同步所有界面。
4. 迁移魔法笔记共同设置，保留知识库、智能心跳始终可用及原工作区配置、单条计划 enabled，验证可选应用关闭和重新开启。
5. 验证右侧现有文件、终端、浏览器 Tab 的确切目标与“+”额外实例行为，不实现左侧重复工具条。
6. 单独实现资源快照契约、Main 采集服务、Preload API 与右侧 `resources` 单实例面板。
7. 验证键盘、焦点、浅深主题、窄窗口、设置失败、重启持久化和跨平台行为。

首期使用内置应用清单，不依赖远程商店、插件注册或安装服务。商店目录、推荐、安装与
更新机制在后续独立设计中确定；Demo 中的模拟商店不接入首期产品界面。

本轮 `local-inference` 已接入管理 Modal、类型化 IPC 与真实引擎管理，支持范围见 11.1；
实机和自动化验证范围见[实施进度](./progress.md)。

后续设计输入见 [FR-15](./prd.md#fr-15-私有化市场与-yaml-交换后续) 与
[FR-16](./prd.md#fr-16-本机模型管理入口新增计划项)：

- 私有市场的 YAML Schema 应由桌面本地导入与 ShareServer 发布共用，具体协议与字段在
  市场功能设计中确定。市场 URL 按设备保存，认证信息沿用受保护凭据存储；导出仅包含
  可迁移应用定义与非敏感配置。
- 程序包与模型资源单独分发。受管下载声明不可变版本、预期字节数和 SHA-256，下载开始后
  固定来源，失败不静默切源；下载地址与重定向范围由 Main 验证，不接受 Renderer 任意覆盖。
  市场来源配置不覆盖现有模型、应用更新或 Runtime 下载源设置。
- ShareServer 的市场发布与分发实现由其独立仓库承接，本仓库先记录依赖，不将桌面需求
  记录标为服务端已实现。

### 11.1 本机推理任务与执行服务

ASR、OCR 与内置向量的跨功能执行边界、任务控制缺口及有条件的优化方向，见[本机专用推理架构与任务控制评估](../../architecture/local-inference-task-control.md)。该评估区分源码现状、建议与待办，未将常驻化或后台宿主迁移列为已采用实现。

`LocalInferencePage` 默认导出，接收必需的 `onClose` 及可选的 `enabled`、`restoreFocus`，通过 `createPortal(..., document.body)` 渲染管理 Modal，复用 `PageHeader` 和共享
`activateModalFocus`／`trapTabFocus`。`ImpactConfirmation` 使用独立 Portal 和紧凑确认样式；共享焦点工具隔离下层 Modal，并在关闭时恢复可用触发元素或指定后备焦点。`operation` ref 防止重复执行，`busy` 和 `control` 控制关闭与 Escape，交互细节见 [UI 设计](./ui-design.md#91-本机推理管理)。`local-inference-contracts.ts` 定义快照、操作与取消输入；Main 注册四个
`local-inference:*` 通道，复用可信 sender 校验和 Zod 输入校验。Preload 只暴露读取、服务操作、
任务取消及打开既有设置的方法，不接收 PID、命令或模型路径。

| 引擎 | 生产接入与可用操作 | 明确限制 |
| --- | --- | --- |
| ASR / sherpa-onnx | `SpeechTranscriptionService` 登记真实请求；执行路径保留独立 Worker 请求取消 | 每次请求加载、结束释放；未提供 Worker 就绪观测，模型可用时状态为 unknown，不从活动请求推断 running |
| OCR / PaddleOCR | `DocumentOcrBroker` 登记文档请求；`document-ocr-bridge` 提供实际 Worker 状态、加载及空闲释放 | 有活动或排队请求时拒绝释放；不把终止共享 Worker 暴露为单任务取消 |
| 内置向量 / Granite | 按模型目录复用引用计数 Broker；启动、停止、重启；取消消息等待 Worker 结果或取消确认 | 启动确认进程 spawn，模型在首个请求时加载；不把进程启动称为模型已加载 |
| TTS | 显示当前没有执行服务 | 不提供虚假任务或控制 |
| 外部向量连接 | 快照契约保留配置，Modal 不显示；通过既有模型设置管理 | 本页不主动探测，不推断本机归属，不控制外部进程 |

`LocalInferenceService` 在 Main 内存中登记真实 ASR、OCR、向量请求，保留活动请求和最近
100 条终态记录。只保存能力来源、时间、模型（执行路径有提供时）、状态和错误，不保存音频、
图片或向量输入文本。运行阶段包括排队、模型加载及执行，没有统一阶段进度；来源未提供项目或
会话对象时不补造对象关联。Modal 仅使用活动请求生成影响确认，不展示任务历史或单任务取消。

向量执行端通过 `utilityProcess.fork` 创建独立进程。每个 transport 持有自己的资源采样器，按当前 `child.pid` 从 `app.getAppMetrics()` 匹配 Utility 条目。服务快照的 `resources.scope` 为 `service-process`，携带 PID、采样时间及可用指标；无进程或无法采集时为 `unavailable` 并给出原因。Broker 清除退出的 transport，重启使用新采样器，不复用旧进程指标。

Modal 可见且启用时每 5 秒读取一次快照，跳过重叠请求。CPU 使用累计 CPU 秒数之差除以单调时钟间隔，100% 表示一个逻辑核心，可超过 100%；首次读取、PID 或创建时间变化、采样间隔超过 15 秒、计数回退及采样失败后重新建立基线。15 秒阈值为定时器延迟和跳过重叠请求留出余量。工作集由 Electron 的 KiB 转为契约中的字节，界面显示 MiB。缺少 CPU 时间或内存读数时只标记该指标不可用，不补零。数值为整个向量服务进程的占用，包含运行时和并发使用方，不是单任务或模型权重大小。

ASR 使用主进程中的 `node:worker_threads`；OCR 使用渲染进程中的 Web Worker，两者均没有独立进程工作集，逐行标明无法独立统计 CPU／内存。没有将主进程或整个 Renderer 的读数归属给服务。显存未采集，本机资源监控工作栏应用仍未实现。

服务操作按 serviceId 串行，操作期间拒绝新增该服务请求；停止前校验所有当前活动 taskId
都在用户确认清单内，新增使用方要求刷新后重新确认。向量停止等待实际 child exit；失败保留
可观测状态和错误。Renderer 操作失败时关闭旧确认并重新读取快照，刷新期间或失败时禁用服务操作；再次操作须重新确认当前活动请求。重启不重放中断请求。任务取消与服务停止分开，完成竞态保留执行方结果。

向量 Broker 将调用方 Promise 与 Worker 执行记录分开。调用方取消或超时可先返回错误，
执行记录在 Worker 确认、返回结果或进程退出前仍为活动项，保留在途名额并计入服务停止影响；
停止等待超时也不能提前移除记录。请求取消与自然完成竞争时采用执行方结果。

OCR 模型可用性由 Main 校验，Worker 运行状态由实际持有它的 Renderer 模块提供。手动加载
同样复用既有 Worker，加载超时恢复为可重试错误；空闲 60 秒自动释放。Modal 启用、文档可见且内容未被 hidden／inert 隔离时每 5 秒刷新，跳过未结束的请求；嵌套确认期间暂停新快照读取。
关闭 Modal 时卸载组件并清理轮询，窗口隐藏、关闭管理应用或取消常驻不会触发服务停止。退出整个进程继续
沿用原有应用清理路径。模型文件卸载仍在模型设置中独立进行。

向量 Main 引擎使用 `onnxruntime-web` 的 Node 条件入口，避免浏览器 `/wasm` 入口通过 fetch
加载本地文件失败。执行方的具体错误随任务返回；Renderer 不把失败展示为零指标或恢复成功。

## 12. 项目活动汇总

对应 [FR-14](./prd.md#fr-14-项目活动汇总)，按[活动逻辑](./logic-design.md#9-项目活动汇总)
派生状态，界面行为见[活动界面](./ui-design.md#10-项目活动汇总)。

- `conversation-activity.ts` 从 `App.tsx` 的会话、`activeConversationIds`、全部可见
  `assistantTasks`、`completedConversationIds` 和项目元数据派生会话行、全局及项目计数，不新增持久化活动副本。
  `ProjectActivity` 在有活动时渲染汇总与项目、会话级联菜单，`ProjectSwitcher` 复用项目计数。
- `use-unviewed-completions.ts` 在 Renderer 内存维护完成集合和上一轮 Task 状态；已观察到的
  顶层 Task 转为 `completed` 时加入集合，初始历史不生成通知。`App` 的本地 `done` 事件和
  活动运行持久化快照的成功终态调用 `markConversationCompleted`，失败、取消不调用。
  新运行及 Task 恢复运行或等待处理时清除旧通知。具体优先级和通知生命周期以活动逻辑为准。
- `App` 仅在 `view === 'chat' && !settingsOpen && !applicationCenterOpen` 时向 Hook 传入当前会话 ID；Hook 监听
  `visibilitychange`，文档不为 `hidden` 时才按当前会话清除通知。这使普通侧栏、活动菜单
  导航和可见性恢复共用查看规则，KeepAlive 挂载本身不代表查看。集合不写入 SQLite 或设置。
- 聚合状态新增 `completed`，全局和项目计数包含 `attention`、`running`、`completed`，
  同一 Conversation ID 只按最高优先级计数；活动行为空才隐藏摘要。
- `App` 向 `ProjectActivity` 传入项目元数据、活动行、侧栏可见状态与既有精确跳转回调。
  菜单按项目 ID 分组并记忆化派生集合；排序仅影响展示，不改聚合状态或持久化数据。
- 两层菜单在同一 body Portal 内相接，桌面会话层使用独立 fixed 定位，不参与项目层高度计算。
  项目层锚定摘要，会话层锚定选中项目行并独立限制窗口边界。布局在打开、层级变化、实时数据更新、窗口缩放和
  滚动时按锚点重算；窄窗口隐藏项目面板并保留返回操作。菜单不调用 Modal 焦点隔离，
  捕获阶段消费 Escape，防止触发窄侧栏的文档级监听；Tab 关闭后交还正常焦点顺序。
  菜单关闭与焦点恢复在导航回调之前同步完成。
- `role="menu"` 使浮层直接进入共享 `browser-viewport-occlusion.ts` 相交检测。未增加
  浏览器实例的特殊隐藏条件，也不关闭或重建浏览器会话。
- 持久化快照刷新时，同一条仍在流式输出的消息保留本地待审批、待回答信息，持久化终态
  则清除这些信息。响应成功后对应 Task 立即退出等待状态；响应期间到达的新问题、审批或
  终态不能被旧响应覆盖。
- `AssistantDatabase.listTasks()` 保留最近历史窗口（默认 100 条），额外包含窗口外当前
  运行或等待处理的可见 Task；`activeVisibleTaskSelect` 与 `toTask` 的有效状态保持一致，
  待调度运行规范化为 `queued`，不因旧 Task 状态被误纳入实时集合。
- `listConversations()` 的范围与排序遵守
  [会话列表读取与前端保留](../assistant-workbar/execution-history-storage.md#会话列表读取与前端保留)，
  包含上述 Task 关联及含 `streaming` 消息的较早活动会话，避免后台工作被最近记录挤出。
  `listTasks()` 仍按原时间顺序返回；列表结果允许超过历史窗口大小。
- `openActivityConversation` 按确切 Conversation ID 导航；内存中缺失时刷新持久化会话
  列表并合并，再查找同一 ID。刷新失败或会话已不存在时显示通知，不回退到项目最新会话。
  设置离开检查通过后才提交项目、会话及界面清理状态。
- 远程恢复成功提示沿用独立的自动消失计时器；活动汇总更新不重置或替代该计时器。

完成通知的定向验证应覆盖本地成功、持久化活动运行成功、后台 Task 状态转换、初始历史、
失败和取消、实时状态优先、三类计数、普通侧栏查看、设置覆盖、隐藏文档与恢复可见、无活动行隐藏。
验证记录见[项目活动级联实施进度](./progress.md)；源码核对不能替代真实 Electron 路径验证。
