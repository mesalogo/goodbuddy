# 应用导航与系统工具入口技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中 |
| 版本 | 0.1 |
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
承载。工作区与浏览器是单实例应用，终端是多实例应用。现有侧栏底部 `user-card` 整行打开
设置，并显示“本地工作区”和平台架构。

本次改动只增加入口编排和一个从主侧栏到工作栏的命令通道，不改变各工具后端。

## 2. 模块边界

| 模块 | 责任 |
| --- | --- |
| `App.tsx` | 组合主导航、系统工具栏、设置入口和页面离开检查 |
| `SidebarSystemTools`（新增） | 渲染三个系统工具按钮并发送打开意图 |
| `RightAssistantSidebar.tsx` | 接收打开意图，调用工作栏实例创建或激活逻辑 |
| `WorkbarShell.tsx` | 继续负责实例策略、Tab、目录和焦点行为 |
| `workbar-contracts.ts` | 继续作为工作栏应用 ID 和实例布局的权威契约 |
| `application-settings-contracts.ts` | 增加应用导航偏好 schema 和默认值 |
| `application-settings-store.ts` | 迁移并原子保存应用导航偏好 |
| `PlatformFeaturesSettingsSection` 或独立设置 Section | 编辑“显示在侧边栏”偏好 |

不要在 `SidebarSystemTools` 中读取文件、创建 PTY 或操作浏览器；该组件只发送有界的工具 ID。

## 3. Renderer 契约

### 3.1 系统工具 ID

```ts
export const sidebarSystemToolIds = [
  'workspace',
  'terminal',
  'browser'
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
  appId: 'workspace' | 'terminal' | 'browser'
  reason: 'sidebar-system-tool'
}
```

`requestId` 使连续点击同一工具仍能被消费。不要仅设置 `assistantSidebarTab`，因为用户可能已
关闭对应实例，且终端需要按执行空间寻找实例。

建议由 `RightAssistantSidebar` 在消费意图后通过现有 `WorkbarShell` 控制接口完成。文件和浏览器
已有实例时只激活实例，保留其“跟随当前上下文”或“固定到指定对象”状态：

```ts
type WorkbarController = {
  openOrActivate(appId: WorkbarAppId): Promise<WorkbarTabInstance>
}
```

若当前 `WorkbarShell` 没有命令式入口，先增加窄的回调或受控请求 Props，不引入全局事件总线。

### 3.3 终端匹配

工作栏“+”目录选择终端时每次创建新实例；侧栏系统工具按钮执行“进入当前终端”，采用：

1. 解析当前项目对应的 `ExecutionSpaceSelection`。
2. 在现有终端实例中按目标 identity 查找 `starting` 或 `running` 状态。
3. 存在多个匹配实例时激活最近使用的实例。
4. 没有匹配实例时调用现有终端创建流程。

`closing`、`exited`、`interrupted` 和 `failed` 实例保留为历史 Tab，不阻止快捷按钮创建新终端。
工作栏“+”继续按原规则创建额外终端，不受快捷按钮去重影响。

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
保留设置预加载、焦点恢复和未保存离开确认。

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

## 9. 测试

### 9.1 Renderer 测试

- 固定入口顺序不受三个应用显隐组合影响。
- 运行记录和设置没有显隐控件。
- 三个系统工具按钮具有名称、工具提示、键盘行为和选中状态。
- 文件和浏览器复用单实例；终端优先聚焦当前执行空间实例。
- 工具按钮展开工作栏但不改变当前主页面。
- 显隐更新成功后主导航立即变化，失败时 Switch 和主导航恢复原状态。
- 窄窗口下工具按钮不重叠，焦点恢复正确。

### 9.2 Main 与契约测试

- 新设置字段默认值、合法 ID、重复 ID、数量上限和未知 ID 校验。
- 旧版本设置迁移后默认显示所有既有应用。
- 更新导航偏好不修改魔法笔记启停等无关字段。
- 原子写入失败时保留最后一次有效设置。

### 9.3 回归范围

- 工作栏布局恢复和已关闭实例重建。
- 本地与托管 SSH 终端目标。
- 浏览器无会话、创建中和 Agent 操作中状态。
- 设置页未保存离开确认。
- 魔法笔记待办数和智能心跳建议数徽标。
- 浅色、深色、`220px` 与 `420px` 侧栏宽度。

## 10. 实施顺序

1. 增加应用导航设置 schema、迁移和设置界面。
2. 按即时保存结果组合主导航，并补充失败恢复。
3. 拆分侧栏底部设置按钮，加入三个系统工具按钮。
4. 为工作栏增加 `openOrActivate` 意图接口和终端匹配规则。
5. 接入选中状态、焦点恢复、无障碍文案和响应式样式。
6. 完成 Renderer、契约、迁移和回归测试。

插件注册与插件市场不与首期改动一并实施。
