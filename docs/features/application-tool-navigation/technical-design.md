# 应用导航与系统工具入口技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中 |
| 版本 | 0.2 |
| 日期 | 2026-09-08 |
| 关联 PRD | [应用导航与系统工具入口 PRD](./prd.md) |
| 功能逻辑 | [功能逻辑设计](./logic-design.md) |
| UI 设计 | [UI 设计](./ui-design.md) |

## 1. 现状

主页面没有 URL Router，由 `App.tsx` 中的 `WorkspaceView` 和 keep-alive 状态切换：

```ts
type WorkspaceView =
  | 'chat'
  | 'magic-notes'
  | 'knowledge'
  | 'heartbeat'
  | 'activity'
  | 'settings'
```

文件、浏览器和终端已经由 `RightAssistantSidebar`、`WorkbarShell` 与 `workbar-contracts.ts`
承载。工作区是不可关闭的单实例应用，浏览器和终端是多实例应用。浏览器多实例的跨进程
实现以[浏览器多实例技术设计](../assistant-workbar/browser-tabs-technical-design.md)为准。代码中尚无资源指标采集和资源监控
面板。现有侧栏底部 `user-card` 整行打开设置，并显示“本地工作区”和平台架构。

本次改动增加入口编排、从主侧栏到工作栏的命令通道，以及本机资源监控的 Main/Preload/
Renderer 最小实现。文件、终端和浏览器后端保持不变。

## 2. 模块边界

| 模块 | 责任 |
| --- | --- |
| `App.tsx` | 组合主导航、系统工具栏、设置入口和页面离开检查 |
| `SidebarSystemTools`（新增） | 渲染四个系统工具按钮并发送打开意图 |
| `RightAssistantSidebar.tsx` | 接收打开意图，调用工作栏实例创建或激活逻辑 |
| `WorkbarShell.tsx` | 继续负责实例策略、Tab、目录和焦点行为 |
| `workbar-contracts.ts` | 继续作为工作栏应用 ID 和实例布局的权威契约 |
| `resource-monitor-contracts.ts`（新增） | 定义本机资源快照、可用性和错误码 |
| `resource-monitor-service.ts`（新增） | 在 Main 中采集并规范化本机与 GoodBuddy 指标 |
| `ResourceMonitorPanel.tsx`（新增） | 按需轮询、保留有界历史并渲染资源面板 |
| `application-settings-contracts.ts` | 增加应用导航偏好 schema 和默认值 |
| `application-settings-store.ts` | 迁移并原子保存应用导航偏好 |
| `PlatformFeaturesSettingsSection` 或独立设置 Section | 编辑“显示在侧边栏”偏好 |

不要在 `SidebarSystemTools` 中读取文件、创建 PTY、操作浏览器或采集系统指标；该组件只发送
有界的工具 ID。

## 3. Renderer 契约

### 3.1 系统工具 ID

```ts
export const sidebarSystemToolIds = [
  'workspace',
  'terminal',
  'browser',
  'resources'
] as const

export type SidebarSystemToolId = (typeof sidebarSystemToolIds)[number]
```

该类型可以放在 Renderer 内共享模块。首期不暴露 IPC，因为动作只编排已有工作栏 Renderer
状态；实际能力调用继续走现有 Preload API。

### 3.2 打开意图

`App` 向 `RightAssistantSidebar` 传入单调递增的请求或命令对象：

```ts
type WorkbarOpenIntent = {
  requestId: number
  appId: 'workspace' | 'terminal' | 'browser' | 'resources'
  reason: 'sidebar-system-tool'
  context?: { conversationId?: string; projectId?: string }
}
```

`requestId` 使连续点击同一工具仍能被消费。不要仅设置 `assistantSidebarTab`，因为用户可能已
关闭对应实例，且终端需要按执行空间寻找实例。

建议由 `RightAssistantSidebar` 在消费意图后通过现有 `WorkbarShell` 控制接口完成。控制器必须
接收上下文和调用原因，不能只按 `appId` 查找第一个实例：

```ts
type WorkbarController = {
  openOrActivate(intent: WorkbarOpenIntent): Promise<WorkbarTabInstance>
}
```

若当前 `WorkbarShell` 没有命令式入口，先增加窄的回调或受控请求 Props，不引入全局事件总线。

工作区意图始终激活注册表中的不可关闭单实例；仅在迁移或布局损坏时补回。浏览器意图按
`conversationId` 激活最近使用的匹配实例，没有匹配实例时创建一个。工作栏“+”不走该去重
路径，选择浏览器时始终创建新实例。

### 3.3 终端匹配

工作栏“+”目录选择终端时每次创建新实例；侧栏系统工具按钮执行“进入当前终端”，采用：

1. 解析当前项目对应的 `ExecutionSpaceSelection`。
2. 在现有终端实例中按目标 identity 查找 `starting` 或 `running` 状态。
3. 存在多个匹配实例时激活最近使用的实例。
4. 没有匹配实例时调用现有终端创建流程。

`closing`、`exited`、`interrupted` 和 `failed` 实例保留为历史 Tab，不阻止快捷按钮创建新终端。
工作栏“+”继续按原规则创建额外终端，不受快捷按钮去重影响。

### 3.4 资源监控工作栏应用

在 `workbar-contracts.ts` 中增加 `resources`：

```ts
{
  id: 'resources',
  instancePolicy: 'single',
  defaultContext: 'application'
}
```

该应用不加入升级后的默认打开实例。侧栏资源按钮与工作栏“+”目录都通过既有单实例规则创建
或聚焦它。

## 4. 应用导航偏好

### 4.1 设置结构

在 `ApplicationSettings` 增加独立字段：

```ts
type BuiltInApplicationId = 'magic-notes' | 'knowledge' | 'heartbeat'

type ApplicationNavigationSettings = {
  hiddenBuiltInApplicationIds: BuiltInApplicationId[]
}
```

默认值为空数组，保持升级前所有可用入口可见。ID 数组可以避免为每个应用增加一个顶层布尔
字段；Zod schema 必须去重、限制数量并拒绝未知内置
ID。

首期不保存排序，因为内置应用顺序固定。插件偏好在插件系统确定稳定 identity 和卸载保留
规则后另行扩展，不提前混入当前 schema。

### 4.2 与现有开关组合

入口可见条件为：

```ts
const visible = featureEnabled && !hiddenBuiltInApplicationIds.includes(id)
```

`magicNotesEnabled` 继续控制功能启停。知识库和智能心跳若未来增加业务启停开关，也按同一组合
规则处理。功能停用时设置页保留显隐偏好但禁用显隐 Switch，并提供原功能设置入口。导航设置
不能写回现有开关。

### 4.3 持久化与 IPC

沿用现有应用设置链路：

```text
Renderer
  -> window.goodbuddy.updates.updateSettings
  -> settings:application:update
  -> application-settings-store
  -> application-settings.json
```

更新继续由 Main 校验可信 sender、Zod 输入和原子写入。设置版本迁移只补充默认空数组，不
修改已有 `magicNotesEnabled` 或其他平台设置。

## 5. 侧栏底部重构

现有 `user-card` 是一个覆盖整行的设置按钮。实现时替换为容器和相邻独立按钮：

```tsx
<div className="sidebar-footer">
  <SidebarSystemTools onOpenTool={openSystemTool} />
  <button aria-label={t('navigation.settings')} ...>
    <Settings aria-hidden="true" />
  </button>
</div>
```

不能在设置按钮内部嵌套工具按钮。设置按钮继续调用 `navigateFromSidebar('settings', trigger)`，
保留设置预加载、焦点恢复和未保存离开确认。该调用只打开设置 Modal，不更新当前工作区或
KeepAlive 缓存；`settingsOpen` 独立管理打开状态。关闭后卸载设置内容，下次按入口指定的分类
和消息通道重新挂载，避免缓存上次分类覆盖本次直达目标。底层工作区继续挂载，普通关闭不跳回聊天。

系统工具按钮调用统一 `openSystemTool`：

1. 设置工作栏打开意图。
2. 展开工作栏。
3. 由工作栏创建或激活实例。
4. 按现有策略把焦点移入目标面板。

工作栏仍由窗口右上方的固定开关关闭，关闭后的焦点返回该开关。

## 6. 工作栏状态与快捷按钮

`RightAssistantSidebar` 应向 `App` 暴露当前活动实例的 `appId` 和必要的有界状态摘要，或由
现有 `onTabChange` 扩展得到。主侧栏不读取终端输出、文件内容、URL 或活动详情。

```ts
type SidebarSystemToolState = {
  activeToolId?: SidebarSystemToolId
  statusByToolId?: Partial<Record<SidebarSystemToolId, 'attention' | 'error' | 'running'>>
}
```

首期可以只实现 `activeToolId`，没有可靠聚合来源时不显示状态徽标。不能根据局部事件猜测错误
或运行状态。

## 7. 应用显隐更新

应用显隐 Switch 复用平台功能设置的即时更新模式。请求开始后禁用三个应用显隐 Switch，只
允许一个完整目标集合处于提交中。Main 返回成功结果后更新 App 中的平台设置快照，主导航
随之变化。失败时恢复控件原值，在对应设置行显示可重试错误；主导航继续读取最后一次成功
保存的设置。

## 8. 插件兼容边界

首期不增加插件注册表、插件 schema 或插件持久化字段，只保留系统 ID 不向插件开放的产品边界。
插件市场设计需要单独确定 Host、权限、签名、生命周期和稳定 identity；不得直接复用 DeepSeek
Harness 的 npm 插件市场。

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

- 固定入口顺序不受三个应用显隐组合影响。
- 运行记录和设置没有显隐控件。
- 四个系统工具按钮具有名称、工具提示、键盘行为和选中状态。
- 文件复用不可关闭单实例；浏览器和终端按当前上下文聚焦匹配实例，工作栏“+”允许显式多实例。
- 工具按钮展开工作栏但不改变当前主页面。
- 显隐更新成功后主导航立即变化，失败时 Switch 和主导航恢复原状态。
- 窄窗口下工具按钮不重叠，焦点恢复正确。
- 资源面板只在可见活动时轮询，跳过重叠请求并把历史限制为 150 项。
- 窗口隐藏、最小化和恢复时停止轮询并重新建立区间基线。
- 资源部分可用、全部失败和重新进入活动状态均显示正确结果。

### 10.2 Main 与契约测试

- 新设置字段默认值、合法 ID、重复 ID、数量上限和未知 ID 校验。
- 旧版本设置迁移后默认显示所有既有应用。
- 更新导航偏好不修改魔法笔记启停等无关字段。
- 原子写入失败时保留最后一次有效设置。
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

## 11. 实施顺序

实施范围以 [PRD 分期](./prd.md#8-分期)为准。本节替代旧实施顺序；前文关于四个左侧
系统工具按钮、仅持久化隐藏 ID 的契约需在实现前同步，不能直接按旧规格开发。

1. 同步 PRD 功能要求、User Stories、逻辑、UI 与技术契约，收敛首期应用中心样式。
2. 接入现有内置应用页面与最底部应用中心入口，保留独立设置和固定运行记录入口。
3. 为常驻显隐和排序设计最小持久化契约，保留已发布的相关设置与用户数据，按保存结果更新导航。
4. 接入应用设置的共同界面与既有设置更新路径，先验证魔法笔记多入口状态一致性。
5. 验证右侧现有文件、终端、浏览器 Tab；移除计划中的左下角工具快捷条和专用于该快捷条的意图接口工作。
6. 单独实现资源快照契约、Main 采集服务、Preload API 与右侧 `resources` 单实例面板。
7. 验证键盘、焦点、浅深主题、窄窗口、设置失败、重启持久化和跨平台行为。

首期使用内置应用清单，不依赖远程商店、插件注册或安装服务。商店目录、推荐、安装与
更新机制在后续独立设计中确定；Demo 中的模拟商店不接入首期产品界面。

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
- 本机模型管理实施前盘点现有 OCR、向量、语音及推理服务的生命周期接口，优先复用其
  Main 服务。只为实际支持的操作提供 typed IPC；区分受管子进程、外部服务和进程内模型，
  不把直连模型 HTTP 请求等同于独立模型进程。
- 模型管理的详细逻辑需确定共享服务的使用方识别、忙碌时停止与重启、退出应用时的释放
  行为，再接入管理页面并验证实际引擎。该工作单独排期，不依赖市场上线。

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
- `App` 仅在 `view === 'chat' && !settingsOpen` 时向 Hook 传入当前会话 ID；Hook 监听
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
