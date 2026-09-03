# 桌面宠物技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中 |
| 版本 | 0.1 |
| 日期 | 2026-09-03 |
| 关联 PRD | [桌面宠物 PRD](./prd.md) |
| 功能逻辑 | [功能逻辑设计](./logic-design.md) |
| UI 设计 | [UI 设计](./ui-design.md) |

## 1. 进程与窗口边界

```text
Main
  -> createMainWindow()  (既有，src/main/window.ts)
  -> createPetWindow()   (新增)
       -> 独立 BrowserWindow：无边框、透明、置顶、不入任务栏
       -> 独立 preload：src/preload/pet.ts（新增，窄 API）
       -> 加载独立渲染入口：src/renderer/pet.html + src/renderer/src/pet/
Renderer（主窗口，既有）
  -> window.goodbuddy（既有 DesktopApi，不变）
Renderer（宠物窗口，新增）
  -> window.goodbuddyPet（新增窄 API，与既有 window.goodbuddy 完全隔离）
```

宠物窗口是与主窗口平级的第二个 `BrowserWindow`，不是主窗口的子窗口、不是 `WebContentsView`
叠加层。理由：

- 主窗口现有 `setWindowOpenHandler` 拒绝一切子窗口（`src/main/window.ts`），沿用该策略
  比引入例外更简单。
- 宠物窗口需要独立于主窗口的显示/隐藏、位置和置顶状态，作为子窗口会继承父窗口的显示
  状态，不满足“主窗口隐藏时宠物仍可见”的产品要求。

不复用主窗口的 preload 和渲染入口：主窗口 preload 暴露的 `DesktopApi` 面积很大（对话、
知识库、设备共享等）。给宠物窗口加载同一 preload 会让一个新增的、长期运行、暴露给
远程可控网页内容风险更低但攻击面更广的窗口拥有不必要的能力。新增窄 preload 遵循仓库
现有的“只暴露显式方法”约束。

## 2. 模块职责

| 模块 | 位置 | 职责 |
| --- | --- | --- |
| `PetWindowService` | `src/main/pet/pet-window-service.ts`（新增） | 创建/销毁宠物窗口、位置持久化与越界校验、置顶与贴边、显示/隐藏 |
| `PetSettingsStore` | `src/main/pet/pet-settings-store.ts`（新增） | 总开关、外观、位置、安静模式的持久化，遵循既有 settings-file-utils 模式 |
| `PetStatusProjector` | `src/main/pet/pet-status-projector.ts`（新增） | 从既有 Task 查询结果计算状态镜面取值，不引入新状态源 |
| `PetDraftBridge` | `src/main/pet/pet-draft-bridge.ts`（新增） | 把宠物提交的文本/附件转交主窗口渲染进程，驱动会话激活与草稿写入 |
| `PetNotificationCoordinator` | `src/main/pet/pet-notification-coordinator.ts`（新增） | 与既有 `desktop-notification.ts` 协商同一事件只走一条提示路径 |
| 既有 `context-manager.ts` | 不变 | 宠物附件校验复用其 `selectFiles`/校验规则，不新增第二套限制 |
| 既有 `assistant-database.ts` / Task 查询 | 不变 | 状态镜面查询的唯一数据来源 |

`PetStatusProjector` 只读取既有 Task 查询结果并按
[功能逻辑第 3 节](./logic-design.md#3-状态镜面优先级)的优先级归并，不写入、不缓存跨进程
重启的状态；重启后状态镜面从当前 Task 集合重新计算。

## 3. 宠物窗口创建

```ts
// src/main/pet/pet-window-service.ts（示意）
function createPetWindow(): BrowserWindow {
  return new BrowserWindow({
    width: PET_SIZE.width,
    height: PET_SIZE.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true, // 由“始终置顶”设置决定实际值
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(currentDirectory, '../preload/pet.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
}
```

- `transparent: true` 依赖操作系统合成器。按 PRD 6 节明确限制，在不支持透明合成的
  Linux 桌面环境（例如未运行合成器的部分窗口管理器）下，Electron/Chromium 会把窗口
  渲染为不透明；`PetWindowService` 不检测合成器能力，只在渲染进程内把背景色设置为
  当前主题的画布色作为不透明回退，保证内容仍然可读，不尝试探测或声明支持特定合成器。
- `alwaysOnTop` 的实际值由“始终置顶”Switch 驱动，通过 `window.setAlwaysOnTop(bool)`
  在设置变更时更新，不需要重建窗口。
- 复用既有 `resolveWindowIcon`/任务栏排除逻辑作为参考，但宠物窗口 `skipTaskbar: true`
  固定为真，不提供用户设置。
- 宠物窗口不设置 `parent`，与主窗口是同级独立窗口；应用单实例锁和 `second-instance`
  处理（`src/main/index.ts`）不需要改动，因为宠物窗口的存在与否由 `PetWindowService`
  内部状态决定，而不是第二个 Electron 实例。

## 4. 拖放实现

Electron 渲染进程原生支持 HTML5 拖放；宠物渲染进程监听 `dragenter`/`dragover`/`drop`
即可获得视觉反馈和释放事件，不需要 Main 参与拖放事件本身。文件路径解析复用既有
`webUtils.getPathForFile`（已用于 `src/preload/index.ts` 的知识库拖放导入）：

```ts
// src/preload/pet.ts（示意）
import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('goodbuddyPet', {
  submitDraft: (input: PetDraftSubmission) =>
    ipcRenderer.invoke(petIpcChannels.submitDraft, input),
  resolveDroppedPaths: (files: File[]) =>
    files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
  // ...状态订阅、设置读写等方法
})
```

拖入的文本（非文件）通过 `dataTransfer.getData('text/plain')` 直接读取，随普通文本
字段一起提交，不经过路径解析。

宠物渲染进程把解析出的路径和文本打包为 `PetDraftSubmission`，通过 IPC 交给 Main；Main
侧的路径校验、类型判断、大小限制和读取，全部复用既有 `ContextManager` 的规则（`src/main/context-manager.ts`
中的 `supportedExtensions`、`supportedImageExtensions`、`supportedDocumentExtensions`、
`maximumContextBytes`、`maximumAttachmentsPerMessage`），不新增校验逻辑。`ContextManager`
目前的公开入口是围绕原生对话框（`selectFiles`）设计的；实现时需要新增一个接受任意
canonical 路径数组的方法（例如 `stageFromPaths`），内部复用现有扩展名/大小/文档解析
分支，而不是复制一份判断逻辑。文件夹路径（`fs.stat` 判定为目录）在该方法入口即被拒绝，
不递归遍历。

## 5. 快速起草提交与主窗口联动

```text
宠物渲染进程 submitDraft(input)
  -> Main: PetDraftBridge.handleSubmit(input)
       -> ContextManager.stageFromPaths(input.filePaths)  (复用既有校验)
       -> 若主窗口不存在：createMainWindow() + loadMainWindow()（复用既有函数）
       -> showWindow(mainWindow)（既有函数）
       -> mainWindow.webContents.send(petIpcChannels.draftReceived, {
            targetConversationId, text, stagedContextIds
          })
  -> 主窗口渲染进程（App.tsx 新增一个事件监听，与既有 conversation:new 监听模式一致）
       -> 若 targetConversationId 无效或已删除：回退为新建会话（既有新建会话路径）
       -> 激活目标会话、把 text 写入该会话输入框状态、把 stagedContextIds 追加到该
          会话的附件状态（既有 App.tsx 附件状态更新路径）
       -> 聚焦输入框
```

- 草稿只在主窗口渲染进程内变成“输入框状态”和“待发送附件列表”，与用户手动打字/手动
  点击附件按钮产生的状态是同一份 React state，不建立并行的草稿存储。这直接满足
  `INV-1`：宠物不产生消息、不产生 Task。
- `stagedContextIds` 复用现有 `context:*` IPC 产生的 Context ID；主窗口把这些 ID 加入
  附件列表的方式，与用户通过“附加文件”按钮选择文件后的状态更新完全一致。
- 若提交发生时主窗口曾被销毁（用户从未打开过，或者提前研究表明当前架构不销毁主窗口
  只隐藏），`PetDraftBridge` 调用既有 `createMainWindow`/`loadMainWindow`，等待
  `ready-to-show` 完成后再发送 `draftReceived`，避免竞态。

## 6. IPC 边界

新增独立 IPC 通道命名空间 `pet:*`，与既有 `ipcChannels` 并列定义在
`src/shared/ipc-channels.ts`：

```text
pet:get-snapshot        (设置 + 当前状态镜面取值 + 可见性)
pet:update-settings      (总开关、外观、贴边、置顶、安静模式)
pet:submit-draft         (快速起草/拖放提交)
pet:dismiss-bubble       (关闭完成/失败气泡)
pet:open-task            (点击状态镜面/气泡，打开 Task Center 对应任务)
pet:toggle-visibility    (托盘“隐藏/显示桌面宠物”)
```

- 所有输入使用 `src/shared/pet-contracts.ts`（新增）中的 Zod schema 校验，与既有约定
  一致。
- `trusted-ipc-sender.ts` 的 `assertTrustedSender` 按窗口实例参数化使用；宠物窗口的
  IPC handler 校验 `event.sender === petWindow.webContents`，不能用主窗口的 trusted
  sender 校验函数验证宠物窗口的请求，也不能反过来。
- 宠物 preload 不暴露任何既有 `DesktopApi` 方法；需要的能力（提交草稿、读取/写入宠物
  设置、订阅状态镜面）都通过 `pet:*` 通道单独暴露为 `window.goodbuddyPet` 的具体方法。
- Main 侧广播状态镜面变化时，只向宠物窗口发送派生后的枚举值（第 3 节的六种状态之一）
  和最小必要的任务标题/ID，不发送完整 Task 或 Conversation 对象。

## 7. 持久化

新增设置文件，遵循既有 `settings-file-utils.ts` 的原子写入、版本校验和损坏隔离模式，
不复用 `ApplicationSettingsStore` 或 `ShortcutSettingsStore` 的 schema：

```text
pet-settings.json
{
  version: 1,
  enabled: boolean,
  quietMode: boolean,
  alwaysOnTop: boolean,
  snapToEdge: boolean,
  appearance: { character: string, size: 'small'|'medium'|'large',
                opacity: number, motion: 'off'|'reduced'|'full' },
  position: { displayId: number, x: number, y: number } | null
}
```

- `position` 为 `null` 表示尚未被用户拖动过，使用默认位置计算规则（第 8 节）。
- `displayId` 使用 Electron `screen.getAllDisplays()` 返回的 `id`；加载时按第 8 节校验，
  不假设跨重启保持稳定的显示器 id 一定仍然存在。
- 独立 schema 版本号（从 1 开始），与主设置版本号互不影响；未来变更只需要迁移这一个
  文件。
- 是否需要独立数据库表：不需要。宠物没有需要查询、筛选或跨设备同步的历史数据，一个
  JSON 文件足够，符合仓库 KISS/YAGNI 约束。

## 8. 位置与多显示器校验

```ts
function resolvePetPosition(
  saved: PetPosition | null,
  displays: Display[]
): { x: number; y: number } {
  if (saved) {
    const display = displays.find((d) => d.id === saved.displayId)
    if (display && pointWithinWorkArea(saved, display.workArea)) {
      return saved
    }
  }
  const primary = screen.getPrimaryDisplay()
  return defaultPositionWithin(primary.workArea) // 例如右下角，留出安全边距
}
```

- 该函数在宠物窗口创建时以及 `display-added`/`display-removed`/`display-metrics-changed`
  事件触发时调用；越界立即调用 `window.setPosition` 校正，不等待用户下一次拖动。
- 用户拖动结束（`moved` 事件）时把当前 `getBounds()` 和 `screen.getDisplayNearestPoint`
  得到的 `displayId` 写入 `PetSettingsStore`，去抖后原子写入，避免拖动过程中高频写盘。
- 贴边吸附在渲染进程拖动过程中做视觉预判（不移动实际窗口，只显示吸附提示），在
  `moved` 事件的最终位置上由 Main 一次性计算是否落入吸附阈值并调用 `setPosition`
  吸附到边缘，阈值和默认位置的具体像素值作为实现细节调优，不在此固定。

## 9. 状态镜面查询

`PetStatusProjector` 不新增事件源，而是订阅既有 Task 变化通知（主窗口渲染进程已经
用于更新 Task Center 和会话内任务卡片的同一套 Main → Renderer 事件）在 Main 侧的
对应版本，或者在 Main 侧直接查询 `assistant-database.ts` 暴露的 Task 读取方法。具体
选择两者之一属于实现阶段的技术选择，约束条件是：

- 不引入宠物专属的任务状态表或缓存；查询/订阅的结果必须与 Task Center 在同一时刻
  展示的状态一致。
- 查询开销必须是有界的（只统计活跃与最近终态 Task 的数量和状态，不拉取消息正文）。
- Runtime/网络不可达导致查询失败时返回 `unavailable`，不静默返回 `idle`。

“最近完成”“最近失败”窗口时长和“已查看”判定：复用 Task 已有的已读/查看时间戳字段
（若既有模型已提供）；若当前模型没有这类字段，实现时以“该 Task 终态发生后，用户是否
已经点击过对应的宠物气泡或状态镜面，或已经在 Task Center 中打开过该 Task”作为已查看
判定，窗口时长建议与现有原生通知的展示逻辑保持同量级（分钟级），具体数值在实现时
根据既有 Task 事件粒度确定。

## 10. 提示与原生通知协商

`PetNotificationCoordinator` 与 `desktop-notification.ts` 的 `showDesktopNotificationWhenUnfocused`
共享同一个“主窗口是否可见并聚焦”判定：

```ts
function shouldSuppressBecauseMainWindowVisible(mainWindow: BrowserWindow): boolean {
  return !mainWindow.isDestroyed() && mainWindow.isFocused()
}
```

- 现有 `showDesktopNotificationWhenUnfocused` 已经使用等价条件（`window.isFocused()`）
  决定是否弹出原生通知；`PetNotificationCoordinator` 复用同一判定函数（如需要，提取为
  共享工具），保证两者的“可见性”定义永远一致，不出现原生通知判定为可见但宠物判定为
  不可见（或反之）导致同一事件同时出现两条提示或完全没有提示的情况。
- 实现层面：调用触发通知的代码路径在决定“原生通知 vs 宠物气泡”时二选一，而不是
  两者分别独立判断后都可能触发；例如由现有触发点先判断安静模式和宠物启用状态，
  为真则调用 `PetNotificationCoordinator`，否则调用现有 `showDesktopNotificationWhenUnfocused`。
- 安静模式开启时，两者都不触发；状态镜面仍照常更新（状态镜面更新走独立的
  `pet:get-snapshot`/推送通道，不经过通知协商）。

## 11. 与既有模块集成

- 快速起草和拖放最终只调用主窗口渲染进程已有的“设置输入框文本”“追加附件”“激活
  会话”“创建新会话”状态更新函数，不新建与 Ask/Execute、模型选择、Runtime 选择相关
  的任何路径。
- 点击状态镜面/气泡打开 Task Center 复用现有 Task Center 导航（既有 IPC/路由，与托盘
  “新建对话”发送 `conversation:new` 事件属于同一类模式：Main 发送一个事件，主窗口
  渲染进程消费并完成导航）。
- 托盘菜单新增项复用现有 `Menu.buildFromTemplate` 结构（`src/main/index.ts` 的
  `buildTray`），插入一个受当前可见性状态驱动的条目，不重写整个菜单构建函数。
- 全局快捷键（`src/shared/shortcut.ts`、`shortcut-settings-service.ts`）不受影响，
  桌面宠物不注册新的全局快捷键，因为激活方式是点击窗口本身或系统级窗口切换，不需要
  额外抢占全局按键空间。

## 12. 生命周期

- 应用启动读取 `PetSettingsStore`；`enabled: true` 时在既有服务和 IPC 注册完成后创建
  宠物窗口（与主窗口创建顺序一致，不阻塞主窗口 `ready-to-show`）。
- 宠物窗口创建失败（例如极端情况下操作系统拒绝创建透明窗口）：记录原因，不阻塞主窗口
  启动，托盘“显示桌面宠物”下次点击时重试创建。
- 应用退出（`before-quit`/既有 `isQuitting` 标记）时，宠物窗口与主窗口一并销毁，不需要
  独立的关闭确认或延迟清理，因为宠物窗口没有正在进行的网络连接或未保存状态：草稿已经
  转交主窗口的那一刻起就属于主窗口生命周期。
- “暂时隐藏”只调用 `window.hide()`，不销毁窗口实例，重新显示直接 `showWindow` 复用
  既有实例，避免频繁创建/销毁透明窗口带来的闪烁。

## 13. 打包

- 宠物渲染入口（HTML、内置角色素材）加入 `electron.vite.config.ts` 的 renderer 构建
  输入（现有配置已有 `input` 多入口结构，参考现有主渲染入口的声明方式新增一项）。
- 内置角色素材（数量有限的静态图片/精灵图）作为打包资源加入 `package.json` 的 `files`/
  `extraResources`，不通过运行时网络下载，符合仓库“不新增远程资源请求”的字体/资源
  约束的同一精神。
- 新增 preload 产物（`pet.cjs`）需要加入 `electron.vite.config.ts` 的 main/preload 构建
  `entryFileNames` 规则，与现有主 preload 产物并列。
- 六个标准打包目标（Windows/macOS/Linux × x64/arm64）均需验证宠物窗口可创建、透明或
  回退不透明背景符合第 3 节预期；LoongArch 预览目标不单独验证，遵循仓库现有策略。

## 14. 验证策略

### 14.1 自动化

- `PetSettingsStore` 的默认值、原子写入、损坏隔离和版本校验（沿用
  `settings-file-utils.ts` 现有测试模式）。
- `resolvePetPosition` 在显示器存在/不存在/坐标越界三种输入下的返回值。
- `PetStatusProjector` 按第 3 节优先级表在各种 Task 组合输入下的输出。
- `PetNotificationCoordinator` 与 `desktop-notification.ts` 共享判定函数在“可见并聚焦”
  “不可见”“安静模式开启”组合下只触发一条路径或都不触发。
- `ContextManager.stageFromPaths`（新增方法）对合法文件、超限文件、不支持类型、文件夹
  路径的分支覆盖，复用现有 `context-manager` 测试基础设施。
- `pet:*` IPC handler 的 trusted sender、schema 校验和错误码。
- 快速起草提交后主窗口渲染进程状态更新的单元测试：目标会话激活、文本写入、附件追加、
  草稿被丢弃时不产生 Task 或消息记录。

### 14.2 真实环境

- Windows、macOS、Linux 至少各一次验证宠物窗口创建、拖动、贴边吸附、透明或回退背景的
  实际渲染效果。
- 真实拖放一个合法文件、一个超限文件、一个文件夹到宠物窗口，确认 UI 设计第 4.3 节的
  反馈和最终主窗口状态符合预期。
- 真实触发一次任务完成和一次任务失败，在“主窗口隐藏”“主窗口可见”“安静模式开启”
  三种组合下确认气泡和原生通知的出现符合第 10 节的互斥规则。
- 多显示器插拔场景下确认位置回退逻辑（断开记忆显示器后宠物仍可见）。
- 打包后的应用在六个标准目标上完成启用、拖动、快速起草、退出流程的一次冒烟验证。

设计文档完成不代表功能实施或上述验证通过。
