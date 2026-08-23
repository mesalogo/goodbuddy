# GoodBuddy 平台功能页签与模型下载源设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档类型 | 跨功能技术与产品架构 |
| 状态 | 已实现（语音输入与 OCR） |
| 版本 | 1.0 |
| 日期 | 2026-08-19 |
| 适用产品 | GoodBuddy 桌面端 |
| 目标平台 | Windows、macOS、Linux，x64 与 arm64 |
| 相关基线 | [统一界面设计系统](../../UI-DESIGN.md)、[文档解析与本地 OCR](../prd/document-processing/document-extraction-and-local-ocr.md)、[本地文本向量模型与连接设计](./local-text-embedding-model-design.md)、[全双工实时语音交互设计](./full-duplex-voice-design.md) |

本文定义“设置 → 平台功能”的二级页签结构，以及所有 GoodBuddy 托管本地模型共同使用的
“模型下载源”设置。首期下载源为 ModelScope 和 Hugging Face，默认使用 ModelScope。

模型下载源是用户明确选择的供应链路径。当前来源不可用或没有所选模型时，GoodBuddy
必须明确失败并提供设置入口，**不能静默切换到另一个下载源。**

---

## 1. 摘要与核心决策

1. “平台功能”保留现有一级设置分类，在分类内部增加共享 `PageTabs`：
   - **通用设置**
   - **魔法笔记**
2. “通用设置”首个功能为“模型下载源”。
3. 首期提供两个互斥选项：
   - `modelscope`，用户文案为 **ModelScope**，默认值。
   - `hugging-face`，用户文案为 **Hugging Face**。
4. 设置影响 GoodBuddy 管理的所有本地模型下载：
   - 当前本地语音输入模型。
   - 当前本地 OCR 模型。
   - 规划中的应用托管文本向量模型。
   - 后续接入统一模型目录的本地 ASR、TTS、VAD 或其他本地模型。
5. 设置不影响：
   - 已安装模型及其当前选择。
   - ZIP 导入和导出。
   - Ollama 自行安装或拉取的模型。
   - 云端模型调用。
   - LLM Provider、Runtime、Skills、MCP 或扩展下载。
   - GoodBuddy 应用自身的“检查更新源”。
6. 每个来源继续固定 Revision、字节数和 SHA-256。两个来源可以为同一模型 ID 提供字节
   不同的工件，但必须分别声明并校验完整来源包，不能只登记一个未校验链接。
7. 一个模型在所选来源缺少任何必需文件时，整个模型在该来源标记“暂不可下载”。不能把
   同一模型包的部分文件从 ModelScope 下载、部分文件从 Hugging Face 下载。
8. 下载任务启动时冻结来源。任务运行期间切换全局设置，不改变、重启或迁移该任务；新的
   下载使用新来源。
9. 当前来源失败时，不自动重试另一个来源。错误可以提供“前往通用设置更换下载源”，由
   用户明确选择。
10. 现有魔法笔记设置只移动到“魔法笔记”页签，不改变保存、启用或评论行为。

---

## 2. 实现基线

### 2.1 平台功能界面

“平台功能”现已使用两个二级页签：

- “通用设置”承载全局模型下载源。
- “魔法笔记”承载显示入口、AI 评论方式和 AI 评论形式。

页签复用共享 `PageTabs`，默认打开“通用设置”，不会把当前页签写入应用设置。

### 2.2 受管模型下载

- `SpeechModelManager` 管理语音输入模型。
- `DocumentOcrModelManager` 管理 OCR 模型。

两者均已接入全局模型下载源，并具备：

- Main 进程下载。
- 固定文件名与角色，以及可按来源覆盖的字节数和 SHA-256。
- ModelScope 或 Hugging Face 的固定 Revision 与下载 Target。
- 随机暂存目录。
- 下载进度和取消。
- 完整校验后原子安装。
- ZIP 导入、导出和删除。
- 受管模型目录。
- 来源冻结、无静默回退和无跨来源文件混合。
- 只向 Renderer 暴露来源可用性，不暴露下载 URL 或重定向 Host。

### 2.3 当前应用设置

平台功能与检查更新共用版本化 `ApplicationSettingsStore`。`modelDownloadSource` 已加入
版本 7 设置，通过共享 Zod Schema、可信 IPC sender 校验和原子 JSON 写入持久化。版本
1 至 6 惰性迁移为 ModelScope；未知未来版本继续拒绝读取且不会覆盖用户文件。

---

## 3. 目标

### 3.1 用户目标

- 在一个固定入口选择后续本地模型从 ModelScope 还是 Hugging Face 下载。
- 清楚知道当前选择、默认值和影响范围。
- 切换来源时不影响已安装、已选择或正在使用的模型。
- 下载失败时知道实际使用了哪个来源。
- 所选来源没有模型时得到明确说明，并可以主动前往设置切换。
- 在“平台功能”中快速区分通用设置与魔法笔记。

### 3.2 产品目标

- 为语音、OCR、向量和后续本地模型建立一个共同的下载来源契约。
- 保持模型目录中固定 Revision、大小、SHA-256 和许可信息不变。
- 禁止模型管理器各自实现不同的来源回退和设置读取。
- 为未来平台功能保留可扩展的二级页签结构。
- 保持现有安装、ZIP、取消、原子替换和安全边界。

### 3.3 质量目标

- 同一模型从两个来源下载后，最终安装文件的名称、大小和 SHA-256 完全一致。
- 来源切换不会产生混合来源模型包。
- 活动下载可以准确显示其冻结来源。
- 设置迁移后所有现有用户默认获得 ModelScope，不丢失其他应用设置。
- ModelScope 或 Hugging Face 单独故障时，测试能证明应用不会请求另一个来源。
- 页签和来源选择均可通过键盘、屏幕阅读器、浅色、深色和窄窗口使用。

---

## 4. 非目标

首期不包含：

- 自定义模型下载源 URL。
- 根据网络、地域、速度、HTTP 状态或模型可用性自动选择来源。
- ModelScope 与 Hugging Face 的自动测速或自动排序。
- 同一下载任务内跨来源续传。
- 在来源失败后弹窗默认勾选另一个来源并继续。
- 修改 GoodBuddy 应用更新源。
- 安装、配置或管理 Ollama。
- 为云端 Provider 下载模型。
- 把模型权重打入 GoodBuddy 安装包。
- 将“通用设置”做成所有设置的重复入口。
- 创建空的“未来功能”页签。
- 改变现有魔法笔记的产品行为。

---

## 5. 术语

| 术语 | 定义 |
| --- | --- |
| 模型下载源 | 用户选择的 ModelScope 或 Hugging Face |
| 模型目录 | GoodBuddy 源码中经过验证的模型元数据集合 |
| 模型包 | 一个模型运行所需的全部必需文件和安装清单 |
| 下载目标 | 某个来源中一个固定模型文件的 URL、仓库、Revision 和可选来源专用指纹 |
| 规范工件 | 目录用于旧安装、本地目录和 ZIP 兼容的默认文件指纹 |
| 来源覆盖 | 一个来源是否为模型包的全部必需文件提供下载目标 |
| 冻结来源 | 下载操作启动时记录且在操作期间不变化的来源 |
| 来源回退 | 一个来源失败后由应用自动请求另一个来源 |

“模型来源”容易被理解为模型作者或 License 来源，因此用户界面统一使用“模型下载源”。
模型卡中的 License 和上游模型作者不随下载源改变。

---

## 6. 平台功能信息架构

### 6.1 页面结构

```text
设置
└─ 平台功能
   ├─ 通用设置
   │  └─ 模型下载源
   └─ 魔法笔记
      ├─ 显示魔法笔记入口
      ├─ AI 评论方式
      └─ AI 评论形式
```

分类页只有一个一级标题“平台功能”。页签标题不重复渲染为第二个页面标题；每个面板内部
使用区块标题说明设置内容。

### 6.2 PageTabs

使用共享 `PageTabs`，建议使用 `segmented` 视觉变体：

```tsx
<PageTabs
  ariaLabel="平台功能设置"
  idPrefix="platform-features"
  onChange={setActiveSection}
  tabs={[
    { id: 'general', label: '通用设置' },
    { id: 'magic-notes', label: '魔法笔记' }
  ]}
  value={activeSection}
  variant="segmented"
/>
```

语义要求：

- 容器使用 `tablist`。
- 每项使用 `tab` 和 `aria-selected`。
- 面板使用 `tabpanel`，并由对应 Tab 控制。
- 左、右方向键切换，支持 Home、End。
- Tab 键离开页签组进入当前面板。
- 切换后焦点和可见面板保持一致。
- 不使用普通按钮组或 `SegmentedControl` 替代页签语义。

### 6.3 默认页签和持久化

- 每次打开“平台功能”默认进入“通用设置”。
- 当前页签只在本次设置页面生命周期内保留。
- 不把当前页签写入 `ApplicationSettingsStore`。
- 后续支持设置深链接时，可以通过明确的导航参数打开某个页签，不改变默认设置值。

### 6.4 未来扩展

未来新增页签时：

- 必须与“通用设置”和“魔法笔记”处于同级。
- 页签表示完整、独立的功能设置域。
- 通用设置只放跨功能的全局行为，不成为任意设置的杂物区。
- 页签超过可读数量时重新组织信息架构，不允许多行堆叠。
- 尚未提供的功能不显示空页签或“敬请期待”占位。

---

## 7. 通用设置界面

### 7.1 布局

```text
平台功能
管理通用平台行为与可选工作区能力

[ 通用设置 ] [ 魔法笔记 ]

┌ 模型下载源 ────────────────────────────────────────────┐
│ 选择 GoodBuddy 托管本地模型后续下载使用的平台。         │
│ 已安装模型和 ZIP 导入不受影响。                         │
│                                                        │
│ ◉ ModelScope                                           │
│   默认，适合优先访问 ModelScope 的网络环境              │
│                                                        │
│ ○ Hugging Face                                         │
│   适合可以稳定访问 Hugging Face 的网络环境              │
│                                                        │
└────────────────────────────────────────────────────────┘
```

页面只保留一个视觉上最突出的任务。模型下载源保存属于即时设置，不增加与来源选项竞争的
大型“保存全部”按钮。

### 7.2 控件

来源选项包含说明和未来可能的不可用原因，因此使用语义化 Radio Group，而不是原生
`select` 或 `SegmentedControl`：

- `fieldset` + `legend` 表达“模型下载源”。
- 每个选项使用 Radio 和整行可点击卡片。
- 当前项同时显示选中 Radio、强调边框和选中背景。
- 不能只用站点 Logo 或颜色表达选择。
- Logo 可作为辅助图形，但站点名称必须始终显示为文字。

用户文案固定为：

- `ModelScope`
- `Hugging Face`

内部标识不直接显示。

### 7.3 说明文案

区块说明：

> 选择 GoodBuddy 托管本地模型后续下载使用的平台。已安装模型、ZIP 导入、Ollama
> 模型和应用更新不受影响。

来源下方说明：

- ModelScope：`默认，适合优先访问 ModelScope 的网络环境。`
- Hugging Face：`适合可以稳定访问 Hugging Face 的网络环境。`

不使用“国内源”“国外源”等绝对地理描述，也不保证任一来源在用户网络中一定更快。

### 7.4 保存交互

- 用户选择另一个 Radio 后立即调用应用设置更新。
- 保存期间禁用两个选项，保留最后确认值。
- 成功后更新当前选择，并通过应用通知提示：
  `模型下载源已切换为 Hugging Face。`
- 失败时恢复最后确认值，在 Radio Group 附近显示可重试错误。
- 同一个失败不再同时显示页面横幅和全局错误通知。

来源变化不触发：

- 模型下载。
- 已安装模型验证。
- 模型删除。
- 当前模型切换。
- 活动下载取消。

### 7.5 活动下载

不常驻展示活动下载说明。具体下载操作在对应模型卡显示进度和取消入口；需要显示来源时
必须使用任务启动时冻结的来源。切换全局来源不改变已经开始的操作。

---

## 8. 魔法笔记页签

现有魔法笔记卡完整移动到“魔法笔记”面板：

- 显示魔法笔记入口。
- AI 评论方式。
- AI 评论形式。

保持以下行为不变：

- 开关继续使用共享 Switch 和 `role="switch"`。
- 评论方式和形式继续使用 `SegmentedControl`。
- 每项继续即时保存。
- 保存失败保留最后确认设置。
- `onMagicNotesEnabledChange` 继续更新应用导航入口。

页签重构不能：

- 重置现有设置。
- 在切换页签时保存或改变值。
- 因魔法笔记入口关闭而隐藏“魔法笔记”设置页签。
- 把页签选择误当成启用开关。

---

## 9. 设置契约与迁移

### 9.1 共享契约

扩展 `src/shared/application-settings-contracts.ts`：

```ts
export const modelDownloadSourceSchema = z.enum([
  'modelscope',
  'hugging-face'
])

export type ModelDownloadSource = z.infer<
  typeof modelDownloadSourceSchema
>

type ApplicationPreferences = {
  checkUpdatesOnStartup: boolean
  updateSource: 'github' | 'mirror'
  modelDownloadSource: ModelDownloadSource
  magicNotesEnabled: boolean
  magicNoteCommentMode: MagicNoteCommentMode
  magicNoteCommentFormat: MagicNoteCommentFormat
}
```

`applicationSettingsUpdateSchema` 继续允许有界的 Partial 更新，不允许未知字段或空更新。

### 9.2 默认值

```ts
modelDownloadSource: 'modelscope'
```

默认值适用于：

- 首次安装。
- 没有应用设置文件。
- 从旧设置版本迁移。
- 设置文件损坏并完成现有隔离恢复流程。

恢复损坏设置时继续显示现有应用设置恢复警告，不把来源恢复伪装成用户选择。

### 9.3 设置版本

`ApplicationSettingsStore` 增加新版本，例如从当前版本 6 升级到 7：

```ts
type StoredApplicationSettingsV7 = {
  version: 7
  checkUpdatesOnStartup: boolean
  updateSource: 'github' | 'mirror'
  modelDownloadSource: 'modelscope' | 'hugging-face'
  magicNotesEnabled: boolean
  magicNoteCommentMode: MagicNoteCommentMode
  magicNoteCommentFormat: MagicNoteCommentFormat
  lastSeenReleaseNotesVersion: string | null
}
```

迁移要求：

- 版本 1 至 6 全部迁移为 `modelDownloadSource: 'modelscope'`。
- 保留更新源、魔法笔记和已读发布说明版本。
- 读取不立即写盘，继续沿用设置存储现有的惰性迁移语义。
- 下一次设置更新或发布说明确认时按新版本原子写入。
- 更高未知版本继续拒绝读取，不覆盖用户文件。

### 9.4 设置服务

首期继续复用现有：

- `settings:application:get`
- `settings:application:update`
- `window.goodbuddy.updates.getSettings()`
- `window.goodbuddy.updates.updateSettings()`

虽然 Preload Namespace 名称为 `updates`，底层契约已经承载应用设置。此功能不要求为了一个
字段进行无关的桥接重命名。未来如果拆分 `applicationSettings` Namespace，必须保持迁移期
兼容并避免两套设置源。

---

## 10. 模型目录契约

### 10.1 规范工件与来源专用指纹

每个文件保留一组默认大小和 SHA-256，用于兼容已有安装、本地目录和 ZIP。下载目标固定
来源、仓库和 Revision；当某个来源发布的是同一模型 ID 的另一套字节时，Target 可以同时
声明该来源自己的大小和 SHA-256：

```ts
type ModelArtifactTarget = {
  url: string
  repositoryUrl: string
  revision: string
  redirectHosts?: string[]
  size?: number
  sha256?: string
}

type ModelArtifactFile = {
  name: string
  role: string
  size: number
  sha256: string
  targets: Partial<
    Record<ModelDownloadSource, ModelArtifactTarget>
  >
}

type ManagedModelCatalogEntry = {
  id: string
  displayName: string
  files: ModelArtifactFile[]
}
```

Target 省略 `size` 和 `sha256` 时继承文件默认指纹；覆盖时两者必须同时出现。下载解析器
始终冻结一个来源，并使用该来源每个 Target 的有效指纹计算总大小和完成下载校验。

目录因此可以表达：

- 两个来源提供字节完全一致的镜像；
- 两个来源提供文件名和运行角色相同、但大小或 SHA-256 不同的版本；
- 只有一个来源提供完整模型包。

来源差异不能削弱完整性校验。只提供 URL 而没有默认或来源专用指纹、只覆盖大小或
SHA-256 之一、使用可变 Revision，都会在目录解析时被拒绝。

Renderer 使用的目录快照不暴露下载 URL、重定向 Host 或文件存储地址，只返回来源可用性：

```ts
type ModelDownloadAvailability = {
  source: ModelDownloadSource
  available: boolean
  totalBytes?: number
  unavailableReason?: string
}

type ManagedModelCatalogView = {
  id: string
  displayName: string
  downloadAvailability: ModelDownloadAvailability[]
}

type ManagedModelSnapshot = {
  selectedDownloadSource: ModelDownloadSource
  catalog: ManagedModelCatalogView[]
  installed: InstalledManagedModel[]
  operations: ManagedModelOperation[]
}
```

“打开模型仓库”继续通过 Main 中按模型 ID 和当前来源解析的专用 IPC 完成，不让 Renderer
提交或接收任意仓库 URL。

### 10.2 模型来源覆盖

一个模型在某个来源可下载，当且仅当：

1. 每个必需文件都有该来源的 Target。
2. 每个 Target 使用固定 Revision，不使用 `main`、`latest` 或可变 Tag。
3. URL、仓库 URL 和重定向 Host 通过 Schema 和来源策略校验。
4. 每个文件都有默认指纹或该来源专用指纹，并在下载时按解析后的大小和 SHA-256 校验。

只要缺少一个文件，该模型在该来源整体不可下载。

禁止：

```text
detection.onnx  ← ModelScope
recognition.onnx ← Hugging Face
dictionary.yml   ← ModelScope
```

即使最终 SHA-256 正确，也不能在一次任务中混合来源，因为用户选择和审计语义将不再准确。

### 10.3 仓库入口

“打开模型仓库”使用当前所选下载源对应的 `repositoryUrl`：

- 当前来源有完整覆盖时，打开对应来源仓库。
- 当前来源无覆盖但另一个来源有覆盖时，按钮保持可读但禁用，并说明原因。
- 不自动打开另一个来源的仓库。
- 已安装模型可以显示“安装来源”，但打开仓库仍遵守当前选择，避免把历史来源当成全局值。

### 10.4 目录校验

启动时对整个模型目录执行静态校验：

- 模型 ID 唯一。
- 文件名和角色唯一。
- 每个来源 Target 的 URL 和 Revision 有效。
- 来源专用大小和 SHA-256 必须成对出现。
- 至少一个来源完整覆盖可下载模型。
- 非手动模型不得在两个来源都缺失。
- `repositoryUrl` 与下载 Target 属于同一声明来源。
- 重定向 Host Allowlist 有界且不包含通配公网域名。

目录错误应在开发和测试阶段阻止启动或测试，不在运行时猜测修复。

### 10.5 当前已验证覆盖

当前目录只声明已经逐文件核对字节数和 SHA-256 的来源：

| 模型 | ModelScope | Hugging Face |
| --- | --- | --- |
| PP-OCRv6 Tiny / Small / Medium | 可下载 | 可下载 |
| SenseVoiceSmall INT8 | 可下载 | 可下载 |
| Whisper Tiny | 可下载 | 可下载 |
| Paraformer 中英双语 | 可下载 | 可下载 |
| Paraformer 中粤英三语 | 可下载 | 可下载 |
| Whisper Small / Medium | 可下载 | 可下载 |

OCR 模型包的检测模型与识别模型来自同一下载源中的不同上游仓库。因此每个 Target 都必须
符合所声明来源的 Host 策略，而模型卡的主仓库入口必须对应到该来源至少一个实际文件
Target。语音模型当前每个模型包的 Target 与主仓库入口保持一致。

当前六个语音模型均已登记 ModelScope 和 Hugging Face 固定 Target。Paraformer 中英双语
在两个来源使用不同的已验证文件指纹；其余语音模型当前使用字节一致的镜像。来源专用
版本不会触发自动回退，也不会允许一次安装混合两个来源。其 ModelScope 版本还必须通过
当前捆绑 `sherpa-onnx` 的模型加载和中英样例转写探测，不能仅凭下载 URL 可访问就入库。

---

## 11. 下载任务

### 11.1 启动

Renderer 发起安装时提交：

```ts
type ManagedModelInstallInput = {
  modelId: string
  expectedDownloadSource: ModelDownloadSource
}
```

Main 必须：

1. 从 `ApplicationSettingsStore` 重新读取已保存来源。
2. 验证其与 `expectedDownloadSource` 一致。
3. 在模型目录中解析该来源的完整模型包。
4. 创建记录冻结来源的操作。
5. 只使用该解析结果完成全部文件下载。

`expectedDownloadSource` 只用于检测 Renderer 快照过期，不能覆盖 Main 中的已保存设置。

如果两个值不一致：

- 不开始下载。
- 返回“模型下载源已变化，请刷新后重试”。
- 不使用 Renderer 提交的来源。

### 11.2 操作快照

扩展模型操作：

```ts
type ManagedModelOperation = {
  modelId: string
  kind: 'download' | 'import'
  downloadSource?: ModelDownloadSource
  phase: 'preparing' | 'transferring' | 'installing'
  currentFile: string | null
  completedBytes: number
  totalBytes: number | null
}
```

- 下载操作必须包含 `downloadSource`。
- ZIP 导入不包含 `downloadSource`。
- UI 使用操作快照显示“正在从 ModelScope 下载”。
- 全局设置变化不修改现有操作对象的来源。

### 11.3 来源解析

语音与 OCR 管理器复用共享的 `resolveModelDownloadPackage` 契约函数：

```ts
resolveModelDownloadPackage(files, source)
```

解析结果是不可变快照，包含：

- 来源。
- 全部文件的 URL、大小、SHA-256。
- 允许的重定向 Host。

模型管理器不直接拼接 ModelScope 或 Hugging Face URL，也不自行尝试第二来源。

### 11.4 设置切换期间

来源设置更新和模型下载任务相互独立：

```text
10:00 语音模型下载从 ModelScope 启动
10:01 用户把全局来源切换为 Hugging Face
10:01 当前语音下载继续使用 ModelScope
10:02 新 OCR 下载使用 Hugging Face
```

不能：

- 取消旧任务后从新来源重新开始。
- 让当前文件继续从旧来源、下一文件切到新来源。
- 把进度归零但不告诉用户。
- 在设置更新完成前启动使用草稿来源的下载。

---

## 12. 模型管理界面

### 12.1 来源状态

语音和 OCR 的当前模型详情各保留一个全局下载源标签。向量内置连接不重复显示平台功能中
已经明确的全局来源，也不显示固定本地安装路径；下载仍使用已保存的全局来源。

所有模型管理界面都显示当前模型是否可下载、活动操作的进度与取消入口，以及已安装模型
的安装和校验状态。活动操作需要显示来源时，使用任务启动时冻结的来源，不能读取后来
切换的全局值。

未安装且来源可用：

```text
可从 Hugging Face 下载 · 约 91 MB
[下载]
```

未安装且来源不可用：

```text
Hugging Face 暂不提供此模型的完整已验证文件。
[前往通用设置]
```

不能显示可点击“下载”后才告诉用户缺少某个文件。

### 12.2 已安装模型

已安装模型不依赖当前下载源：

- 切换来源后继续可用。
- 不重新验证网络地址。
- 继续按安装 Manifest 中的大小和 SHA-256 验证。
- Manifest 必须完整匹配目录中的默认包或任一来源包，不能逐文件拼接不同来源版本。
- 不自动重新下载。
- 不改变当前模型选择。

当前安装 Manifest 保持来源无关，只记录运行和离线迁移需要的模型 ID、文件名、大小与
SHA-256。下载来源记录在活动操作快照中，尚未持久化到安装 Manifest。未来如需持久化
审计来源，可以新增：

```ts
type InstalledModelProvenance = {
  installKind: 'download' | 'archive' | 'local-directory'
  downloadSource?: ModelDownloadSource
  catalogDigest: string
}
```

该扩展必须向后兼容；不能根据文件路径、模型 ID 或当前全局设置猜测旧安装的来源。

### 12.3 ZIP 导入与导出

ZIP 是来源无关的离线迁移方式：

- 导入始终按模型 ID、文件名、大小和 SHA-256 验证。
- 整个 ZIP 必须匹配默认包或某一个完整来源包，不接受逐文件跨来源组合。
- 当前下载源不参与导入兼容判断。
- 从 ModelScope 下载的模型可以在选择 Hugging Face 的设备上导入。
- 导出可以保留原安装来源作为审计元数据，但不能限制另一设备导入。
- 导入失败不触发网络下载。

### 12.4 文案

所有硬编码文案改为来源感知：

- `正在从 {{source}} 下载`
- `打开 {{source}} 模型仓库`
- `当前下载源暂不提供此模型`
- `前往通用设置更换下载源`

不再写死：

- `请从 ModelScope 下载`
- `打开 ModelScope`
- `正在从 ModelScope 下载`

---

## 13. 不静默切换契约

### 13.1 禁止行为

以下行为全部禁止：

- ModelScope 网络失败后请求 Hugging Face。
- Hugging Face 返回 404 后请求 ModelScope。
- 当前来源缺少一个文件时从另一个来源补齐。
- 当前来源速度慢时自动测速并切换。
- 使用环境变量覆盖 UI 已保存来源。
- 为某一种模型单独保留隐藏的“优先来源”。
- 同一模型管理器使用与全局设置不同的默认值。
- 把 CDN 重定向误表示为切换到另一个模型下载源。

### 13.2 允许的同来源恢复

以下恢复可以自动执行：

- 同一固定 Target 的有界网络重试。
- 同一来源声明的固定镜像 Endpoint。
- 同一来源明确允许的 CDN 重定向。
- `.partial` 暂存文件内的安全续传，前提是服务支持且完整文件最终通过 SHA-256。

这些恢复必须保持：

- 同一用户选择来源。
- 同一模型 ID 和 Revision。
- 同一预期大小和 SHA-256。
- 同一冻结下载任务。

### 13.3 用户主动切换

失败状态提供：

1. 重试当前来源。
2. 前往“平台功能 → 通用设置”。
3. 取消。

用户切换来源后需要重新点击下载。不能在设置保存后自动恢复上一失败任务。

---

## 14. 网络与供应链安全

### 14.1 URL

- 只允许 HTTPS 下载；开发测试 Fixture 可以注入受控 Transport。
- URL 必须来自源码内置目录，不接受 Renderer 自由输入。
- 禁止 URL 中的用户名和密码。
- Fragment 在目录校验时拒绝。
- 查询参数不写入日志和错误文案。
- 模型卡只显示来源名称和仓库，不显示带签名的最终 CDN URL。

### 14.2 重定向

ModelScope 和 Hugging Face 都可能跳转到文件存储或 CDN。每个来源 Adapter 维护明确的
允许 Host，或者由固定 Target 提供有界 `redirectHosts`：

- 重定向次数有上限。
- 每一步重新校验 HTTPS 和 Host。
- 不允许跳转到另一下载源的站点。
- 不允许通配任意公网 Host。
- 最终内容仍按固定大小和 SHA-256 验证。

当前 ModelScope 大文件只允许跳转到已核验的
`cdn-lfs-cn-1.modelscope.cn`；小文件可以由 `modelscope.cn` 直接返回。

重定向到已声明 CDN 属于同一下载源内部传输，不构成下载源切换。UI 继续显示用户选择的
逻辑来源。

### 14.3 凭据和隐私

- 两个公开模型源首期不要求用户凭据。
- 不把 LLM、Embedding、Runtime 或渠道 API Key 附加到模型下载请求。
- 不继承浏览器 Cookie。
- 不上传已安装模型清单、知识库、对话或设备文件。
- 常规 User-Agent 可以包含应用名称和版本，不包含用户 ID 或机器标识。
- 下载错误只记录来源、模型 ID、文件角色、HTTP 状态和有界网络分类。

### 14.4 校验

无论来源如何，安装成功必须满足：

- Content-Length 未超过上限。
- 实际完整字节数匹配目录。
- SHA-256 匹配目录。
- 所有必需文件存在且角色匹配。
- 安装 Manifest 完整。
- 正式目录通过原子替换创建。

来源可信不替代文件校验，HTTPS 成功也不证明模型工件正确。

---

## 15. 与其他设置和能力的关系

### 15.1 检查更新源

“模型下载源”与“检查更新源”是两个独立设置：

| 设置 | 位置 | 作用 |
| --- | --- | --- |
| 模型下载源 | 平台功能 → 通用设置 | GoodBuddy 托管本地模型 |
| 检查更新源 | 关于与更新 | GoodBuddy 版本检查和下载页 |

切换任一设置不得修改另一个设置。用户选择 ModelScope 不表示应用更新使用镜像节点；选择
Hugging Face 也不表示应用更新使用 GitHub。

### 15.2 Ollama

Ollama 的模型下载由用户和 Ollama 管理。GoodBuddy 的模型下载源不：

- 改写 Ollama Registry。
- 影响 `ollama pull`。
- 安装或更新 Ollama 模型。
- 改变 Ollama Endpoint。

### 15.3 云端模型

云端 LLM、Embedding、Rerank、语音和图像 Provider 不下载本地权重，因此不受该设置
影响。

### 15.4 模型运行

模型下载源只决定本次获取哪一个已登记来源包，不进入：

- 推理配置。
- 向量 Provider Fingerprint。
- 语音识别模型选择。
- OCR 模型选择。
- 模型质量或速度标签。

安装后运行只依赖 Manifest 与磁盘文件匹配一个完整目录包，不依赖当前全局下载源。不同
来源可以具有不同 SHA-256；目录中的模型族、语言、质量、速度和许可证说明必须准确覆盖
所登记的来源版本。

---

## 16. 失败与恢复

| 场景 | 行为 |
| --- | --- |
| 读取设置失败 | 显示平台功能阻塞错误，不猜测或写入来源 |
| 保存来源失败 | 保留上一个确认值，显示就地错误 |
| 当前来源无完整模型包 | 下载按钮禁用，显示前往通用设置 |
| 当前来源网络不可用 | 当前下载失败或允许同来源重试，不请求另一来源 |
| 当前来源返回 404 | 显示来源缺少固定文件，不请求另一来源 |
| 重定向 Host 不受信任 | 立即失败并删除本次暂存 |
| 文件大小不匹配 | 立即失败并删除本次暂存 |
| SHA-256 不匹配 | 立即失败并删除本次暂存 |
| 设置在下载期间变化 | 当前任务继续冻结来源，新任务使用新来源 |
| Renderer 来源快照过期 | 拒绝启动，要求刷新 |
| ZIP 导入期间切换来源 | 导入不受影响 |
| 已安装模型缺少来源元数据 | 继续可用，显示安装来源未知 |
| 应用关闭 | 取消下载并清理本次暂存 |

错误必须包含可执行下一步，但不能默认执行来源切换。

---

## 17. 测试

### 17.1 设置契约

- 接受 `modelscope` 和 `hugging-face`。
- 拒绝未知来源、空值和多余字段。
- Partial 更新不覆盖魔法笔记和更新源。
- 新安装默认 ModelScope。
- 版本 1 至 6 全部迁移为 ModelScope。
- 更高未知版本拒绝，不覆盖文件。
- 并发设置更新保持完整 JSON。

### 17.2 平台功能界面

- 默认选中“通用设置”Tab。
- Tab 使用 `tablist`、`tab`、`tabpanel` 和 `aria-selected`。
- 方向键、Home、End 和焦点恢复正确。
- 切换到魔法笔记不改变任何设置。
- Radio Group 具有持久 Label。
- 选择来源时保存一次，保存期间防止重复提交。
- 保存失败恢复原值并保留可重试错误。
- 窄窗口不隐藏页签或来源名称。

### 17.3 目录

对语音、OCR 和向量目录分别验证：

- 两个来源分别解析到自己的固定文件名、大小和 SHA-256。
- Target 未覆盖指纹时继承默认值；只覆盖大小或 SHA-256 之一时拒绝。
- 缺少任一 Target 时模型在该来源不可下载。
- 不允许一次任务混合来源。
- 可变 Revision 被拒绝。
- 仓库 URL、下载 URL 和重定向 Host 符合来源策略。
- 重复模型、文件和角色被拒绝。

### 17.4 下载管理器

使用注入的受控 Fetch 验证：

- ModelScope 选择只请求 ModelScope Target。
- Hugging Face 选择只请求 Hugging Face Target。
- 一个来源失败时另一个来源零请求。
- 设置中途变化不改变活动任务。
- 新任务使用最新已保存来源。
- Renderer 提交过期来源时零网络请求。
- 两个来源字节不同时，安装 Manifest 分别记录实际来源包摘要。
- 旧默认指纹和任一完整来源指纹都能通过安装、ZIP 和运行时校验。
- 逐文件命中不同来源的混合包被拒绝。
- 取消、关闭、错误和摘要不匹配不留下正式模型目录。
- 快照准备会清理名称同时匹配受管模型 ID 与安装 UUID 的陈旧
  `.install-*` 目录，以及受管文件名对应的孤立 `.partial` 文件；已安装模型、
  非目录条目和用户自建文件不参与清理。

### 17.5 回归

- 已安装语音模型继续可选择和转写。
- 已安装 OCR 模型继续可解析。
- ZIP 导入导出在任一来源设置下可用。
- 魔法笔记入口、评论方式和评论形式保持一致。
- 检查更新源行为不变。
- 文档、向量和语音推理不因下载源变化而改变。

---

## 18. 实施阶段

### 阶段 1：应用设置和页签（已完成）

- 新增 `ModelDownloadSource` Schema 和默认值。
- 将应用设置版本升级并迁移旧版本。
- 在“平台功能”中增加 `PageTabs`。
- 增加“通用设置”与模型下载源 Radio Group。
- 把现有魔法笔记卡移动到“魔法笔记”面板。

### 阶段 2：共享目录和来源解析（已完成）

- 定义默认规范工件与可覆盖指纹的分来源 Target。
- 实现共享 `ModelDownloadTargetResolver`。
- 为语音和 OCR 目录补充 ModelScope 与 Hugging Face 固定 Target。
- 静态验证每个来源解析后的文件大小和 SHA-256。
- 更正来源感知文案和仓库入口。

### 阶段 3：模型管理器（已完成）

- 扩展安装输入和操作快照。
- 让语音与 OCR 下载任务冻结应用设置来源。
- 保持 ZIP、删除、校验和模型选择行为不变。
- 接入来源 Host 和重定向策略。

### 阶段 4：后续模型

- 应用托管文本向量模型接入同一解析器。
- 实时语音的 ASR、TTS、VAD 模型目录接入同一解析器。
- 其他本地模型只有满足统一目录契约后才能使用全局下载源。

---

## 19. 验收标准

### 19.1 产品

- “平台功能”显示“通用设置”和“魔法笔记”两个可访问页签。
- 默认打开“通用设置”。
- “通用设置”提供 ModelScope 和 Hugging Face，默认 ModelScope。
- 来源选择说明影响范围，并明确已安装模型、ZIP、Ollama 和应用更新不受影响。
- 切换来源不会下载、删除、切换或重新验证任何已安装模型。
- 当前来源没有模型时，在点击下载前即可看到不可用原因。
- 下载失败不会自动请求另一来源。
- 魔法笔记的现有设置和入口行为保持不变。

### 19.2 数据与下载

- 旧应用设置完整迁移，并得到 ModelScope 默认值。
- 每个双来源模型的文件名和角色一致；大小和 SHA-256 可以按来源固定。
- 单次下载任务只使用一个冻结来源。
- 活动下载显示实际冻结来源。
- 已安装 Manifest 和 ZIP 兼容性不依赖来源。
- ModelScope 和 Hugging Face 分别通过固定 Target、重定向、取消和摘要校验测试。

### 19.3 安全和无障碍

- Renderer 不能提交任意下载 URL。
- Main 重新读取设置并校验 Renderer 的预期来源。
- 重定向不能跨到未声明来源或任意公网 Host。
- 下载请求不携带模型 Provider、Runtime 或渠道密钥。
- 页签、Radio、错误和进度可由键盘及屏幕阅读器操作。
- 浅色、深色和窄窗口均持续显示当前来源和活动下载来源。

### 19.4 工程验证

源代码实施后必须通过：

```text
npm test
npm run typecheck
npm run lint
npm run build
```

模型文件真实性和双来源一致性使用门控目录验证命令，不在普通测试中下载模型权重。只有
显式授权的维护流程可以访问外部模型仓库并更新固定字节数和 SHA-256。
