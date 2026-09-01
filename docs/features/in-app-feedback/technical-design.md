# GoodBuddy 应用内反馈系统设计与对接

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档类型 | 跨功能产品与技术架构 |
| 状态 | 已实施并完成生产联调，待发布 |
| 版本 | 1.0 |
| 日期 | 2026-08-25 |
| 适用产品 | GoodBuddy 桌面端 |
| 目标平台 | Windows、macOS、Linux，x64 与 arm64 |
| 相关基线 | [统一界面设计系统](../../../UI-DESIGN.md) |

本文定义 GoodBuddy 桌面端的应用内反馈入口、数据边界、Renderer / Preload /
Main 进程职责、公共 API 对接、失败处理和验收方法。反馈平台服务端、管理后台、
数据库、附件存储、部署和运营流程由独立项目维护，不在本文复制其内部设计。

本文是 **GoodBuddy 客户端实现的权威设计**。服务端字段、状态码和限制以反馈平台
发布的版本化公共 API 契约为准；两边的同名契约必须通过兼容性测试保持一致，不能各自
扩展后继续沿用相同的 `schemaVersion`。

---

## 1. 摘要与核心决策

1. 用户在“设置 → 关于与更新”内直接提交问题、功能建议、体验意见或其他反馈，不再跳转
   GitHub Issue 页面。
2. Renderer 只负责表单、截图预览和状态展示。所有网络请求、安装标识、应用版本和系统
   环境组装都在 Main 中完成。
3. Preload 只暴露用途明确的 `feedback.submit()` 方法，不暴露任意 URL、通用
   `fetch`、Electron API、文件路径或服务端管理能力。
4. 公共请求固定使用版本化接口 `POST /api/v1/feedback`，GoodBuddy 的
   `productKey` 固定为 `goodbuddy`。
5. 反馈服务的生产 HTTPS Origin 是客户端源代码中的受信产品常量，不是用户设置，不从
   Renderer、项目、Runtime、环境变量、远程配置或服务端重定向中获取。
6. GoodBuddy 当前的全局 TLS 策略允许模型和内网服务使用自签名或过期证书。反馈可能包含
   用户输入和截图，因此 **反馈客户端不得复用全局不校验证书的 Dispatcher 或
   `globalThis.fetch`**，必须使用独立的 Undici Dispatcher 并显式启用正常证书校验。
7. 首版允许一张可选截图。截图只能由用户主动选择或粘贴，发送前必须预览并允许移除；
   GoodBuddy 不自动截屏。原始输入和 PNG 标准化结果都不能超过 5 MiB。
8. Main 在发送前解码并重编码截图为 PNG，确保原始 EXIF/XMP 等元数据不会离开设备；
   服务端仍独立执行自己的图片验证和标准化。
9. 一次新反馈生成一个 `clientRequestId`。网络失败后的手动重试必须复用原 ID，服务端
   以此保证幂等；创建另一条反馈时才生成新 ID。
10. GoodBuddy 使用单独的随机安装 UUID 做服务端限流。该 UUID 不得复用 Agent
    installation ID、硬件 ID、机器名、用户名、项目 ID 或任何设备指纹。
11. 默认不发送对话、提示词、模型回复、诊断、日志、文件、项目或工作区路径、知识库、模型
    配置、Runtime 配置、API Key、Token、Cookie、SSH 信息、剪贴板或屏幕内容。用户可通过
    默认关闭的 Checkbox 主动附加有界的最近桌面诊断摘要。
12. 反馈提交失败时保留全部表单内容和截图，成功后显示可复制的服务端反馈编号。
13. 首版不提供反馈历史、状态查询、编辑、撤回、自动日志收集或服务端管理入口。
14. 生产接口固定为 `https://imp.mesalogo.com/api/v1/feedback`。域名健康检查、
    TLS、v1 请求校验和客户端调用链必须在发布前一起通过。

---

## 2. 目标与非目标

### 2.1 用户目标

- 不离开 GoodBuddy 即可报告问题或提出建议。
- 在发送前明确知道哪些字段会离开设备。
- 只在主动选择后上传截图，并能检查、替换或移除截图。
- 网络失败后无需重新填写内容。
- 提交成功后获得稳定编号，便于后续沟通。

### 2.2 产品目标

- 让 GoodBuddy 成为独立多产品反馈平台的第一个客户端。
- 保持 Electron 上下文隔离和 Main-only 网络边界。
- 使用小而稳定的版本化契约，不把服务端工单、数据库和管理员概念泄漏到客户端。
- 对 Windows、macOS、Linux 的 x64 与 arm64 使用相同行为。
- 以数据最小化为默认，不把应用内反馈演变为隐式遥测或日志上传。

### 2.3 非目标

首版不包含：

- GitHub Issue 创建、GitHub Token 或 GitHub 网页附件上传。
- GoodBuddy 内的管理员后台、处理状态修改或内部备注。
- 用户账户、登录、反馈列表、远程状态查询或推送通知。
- 自动附加当前对话、桌面诊断、日志、错误堆栈、项目、文件、模型或 Runtime 信息。
- 远端 Agent 日志或通用日志、诊断包和附件框架。
- 自动截取全屏、当前窗口、浏览器、远程桌面或其他应用窗口。
- 多截图、视频、录屏、任意文件附件或压缩包。
- 离线队列、后台自动重试、指数退避、跨重启草稿或发送历史。
- 用户可编辑的反馈 Endpoint、证书豁免、代理凭据或服务端 API Key。
- 由 GoodBuddy 推断优先级、自动分类、自动生成描述或代表用户提交。

---

## 3. 用户体验

### 3.1 入口

入口放在现有“关于与更新”页面，不增加新的设置一级分类。

在当前版本与更新卡片之后增加“帮助改进 GoodBuddy”能力卡：

- 标题：`帮助改进 GoodBuddy`
- 说明：`报告问题、提出建议或反馈使用体验，我们会在独立反馈系统中处理。`
- 主操作：`提交反馈`

该卡片不显示反馈平台内部状态、管理员信息或 GitHub 链接。服务不可用时仍允许用户打开
表单和保留输入；提交失败后提供重试，而不是把用户重定向到另一个渠道。

### 3.2 反馈对话框

对话框字段按以下顺序排列：

1. **反馈类型**，必填：
   - 问题：`bug`
   - 功能建议：`feature`
   - 使用体验：`experience`
   - 其他：`other`
2. **标题**，必填，1 至 120 字符。
3. **详细描述**，必填，去除首尾空白后 10 至 5,000 字符；选择桌面诊断时为摘要预留空间，
   用户描述上限为 3,398 字符。
4. **附加最近桌面诊断记录**，可选的原生 Checkbox，默认关闭。
5. **联系邮箱**，可选，最多 254 字符。
6. **截图**，可选，最多一张，支持选择 PNG/JPEG/WebP 或在对话框中粘贴图片。
7. **将发送的信息**，只读显示应用版本、系统、架构和界面语言。
8. **隐私说明**，紧邻提交操作。

隐私说明使用明确文案：

> 将发送反馈类型、标题、描述、可选邮箱、GoodBuddy 版本、操作系统、架构、界面语言，
> 以及你主动添加的截图。默认不上传桌面诊断；只有勾选后才会把有界诊断摘要追加到描述。
> 不会发送对话、Prompt、凭据、文件内容、路径、Provider 原始响应或远端 Agent 日志。

Checkbox 下方持续说明：诊断摘要只含时间、组件、阶段、稳定错误码、错误类型和固定短消息。
Renderer 不预览、不读取也不接收诊断内容或路径。勾选后详细描述上限为 3,398 字符，为附加
摘要预留 1,600 字符以及分隔换行；超长草稿保留在表单中并显示字段错误，不静默截断。

截图区域必须包含：

- 缩略预览。
- 尺寸和所选文件大小；Main 仍在发送前独立执行 PNG 标准化和大小检查。
- `替换截图` 与 `移除截图`。
- `截图可能包含画面中可见的个人信息，请在发送前检查。`

### 3.3 提交状态

| 状态 | 行为 |
| --- | --- |
| 未填写 | 字段保持可编辑，提交按钮按字段有效性启用 |
| 校验失败 | 在对应字段旁显示错误并把焦点移到第一个无效字段 |
| 提交中 | 禁止重复提交、关闭和修改字段，按钮显示“正在提交…” |
| 网络或服务失败 | 保留字段和截图，在表单内显示可操作错误及“重试” |
| 成功 | 对话框切换为确认面板，显示并允许复制反馈编号 |

提交成功属于必须保留编号的上下文结果，不再同时发送一条重复的全局成功通知。异步失败也
保留在对话框内，因为错误与当前草稿和重试操作直接关联。

### 3.4 可访问性

- 对话框使用 `role="dialog"`、`aria-modal="true"` 和可见标题。
- 复用 `activateModalFocus()` 与 `trapTabFocus()`，打开后聚焦反馈类型，关闭后恢复入口
  按钮焦点。
- 非提交状态支持 Escape 关闭；提交中保持对话框打开，直到请求完成或到达有界超时。
- 字段使用原生 `label`、`select`、`input` 和 `textarea`。
- 图片预览提供说明性替代文本，删除和替换按钮有明确可访问名称。
- 加载、失败和成功状态使用文字，不依赖颜色。
- 浅色、深色和 `prefers-reduced-motion` 行为遵循 `UI-DESIGN.md`。

---

## 4. 数据与隐私边界

### 4.1 明确发送的数据

| 数据 | 来源 | 用途 |
| --- | --- | --- |
| `schemaVersion` | Main 常量 | 选择公共契约版本 |
| `productKey` | Main 常量 `goodbuddy` | 服务端产品路由 |
| `category` | 用户选择 | 分流反馈 |
| `title` | 用户输入 | 摘要 |
| `description` | 用户输入；勾选时由 Main 追加桌面诊断摘要 | 问题、建议和主动提供的有界诊断详情 |
| `contactEmail` | 用户可选输入 | 必要时联系用户 |
| `environment.appVersion` | `app.getVersion()` | 判断受影响版本 |
| `environment.platform` | `process.platform` 映射 | 判断受影响平台 |
| `environment.architecture` | `process.arch` 映射 | 判断受影响架构 |
| `environment.locale` | 当前 GoodBuddy UI 语言 | 理解用户语言环境 |
| `installationId` | Main 本地随机 UUID | 服务端安装实例限流 |
| `clientRequestId` | 当前草稿随机 UUID | 幂等和安全重试 |
| `screenshot` | 用户主动选择或粘贴 | 复现视觉问题 |

客户端不主动发送来源 IP；IP 是 HTTPS 请求到达服务端时产生的网络元数据。服务端如何保存、
散列和保留该元数据由独立反馈平台的隐私与运维策略负责。

用户填写联系邮箱后，邮箱会作为业务字段通过 HTTPS 发送并由反馈平台保存，不属于端到端
加密内容。用户不希望提供联系方式时应留空，GoodBuddy 不尝试从系统账户或其他设置推断
邮箱。

### 4.2 默认不发送的数据

以下数据不能因为“有助于复现”而隐式加入请求：

- 当前或历史对话、提示词、模型回复和 Supervisor 内容。
- GoodBuddy、Runtime、Agent、SSH、消息通道、浏览器或操作系统日志。
- 文件内容、附件、知识库、Magic Notes、成果和工作区改动。
- 文件名、项目名、本地路径、远程路径、主机名、用户名或 IP 配置。
- LLM、向量模型、语音模型、OCR、MCP、Skill、Runtime 或通道配置。
- API Key、Access Token、Cookie、SSH 密码、私钥、代理凭据和其他秘密。
- 剪贴板、屏幕、摄像头、麦克风或其他应用内容。
- Remote Agent installation ID、Runtime ID、Conversation ID、Task ID 或 Project ID。

除上述用户主动选择、追加到描述且有界的桌面诊断摘要外，未来若增加日志、诊断包或其他
附件，必须单独设计字段、预览、大小限制、用户选择和服务端保留策略，不能复用截图字段
静默上传。

### 4.3 本地数据生命周期

- 表单草稿、邮箱和截图只保存在当前 Renderer 内存中。
- 首版不把草稿、失败请求、成功响应或截图写入 GoodBuddy 数据库和设置文件。
- Main 只在请求期间持有标准化图片字节，请求结束后释放引用，不创建临时图片文件。
- 成功后关闭确认面板时清空草稿。
- `installationId` 单独保存在用户数据目录中的
  `feedback-identity.json`，格式为版本化 JSON，文件权限沿用私有原子设置文件机制。
- “清除本地数据”必须中止进行中的反馈请求并删除该身份文件；下次提交会生成新 UUID。

---

## 5. 公共 API 对接

### 5.1 外部契约所有权

反馈平台负责维护公共 API 的权威定义。GoodBuddy 只固定客户端实际需要的版本 1 子集：

```text
POST https://imp.mesalogo.com/api/v1/feedback
```

当前生产 Endpoint 已作为 Main-only 产品常量固定。实现和发布验证必须持续保证：

- 使用 `https:`。
- URL 不含用户名、密码、查询参数或 fragment。
- Path 精确为 `/api/v1/feedback`。
- 对应产品 `goodbuddy` 已在服务端启用。
- 桌面端所在网络能够直接访问该 Origin。

Renderer、Preload、用户设置、环境变量和远程配置都不能覆盖该 Endpoint。域名迁移必须
同时修改客户端受信常量、测试、服务端 Origin 配置和部署文档。

### 5.2 请求 JSON

无截图时发送 `application/json`：

```json
{
  "schemaVersion": 1,
  "productKey": "goodbuddy",
  "category": "bug",
  "title": "魔法笔记页签不可见",
  "description": "平台功能中的魔法笔记页签被布局压缩，无法看到或点击。",
  "contactEmail": "user@example.com",
  "environment": {
    "appVersion": "0.11.0",
    "platform": "windows",
    "architecture": "x64",
    "locale": "zh-CN"
  },
  "installationId": "00000000-0000-4000-8000-000000000101",
  "clientRequestId": "00000000-0000-4000-8000-000000000102"
}
```

有截图时发送 `multipart/form-data`：

- `payload`：同一 JSON 的字符串形式。
- `screenshot`：一张标准化 PNG，文件名固定为 `feedback.png`。

`contactEmail` 为空时省略，不发送空字符串。请求对象不附加服务端未声明字段。

### 5.3 成功响应

HTTP 201 表示首次创建，HTTP 200 表示相同 `clientRequestId` 的幂等结果：

```json
{
  "reference": "GOODBUDDY-000001",
  "duplicate": false
}
```

客户端对两种成功状态使用相同确认界面。`duplicate: true` 不能显示为失败，它表示先前请求
已经成功落库。

### 5.4 错误映射

| HTTP / 错误 | 用户结果 |
| --- | --- |
| 400 | 提示提交内容无效，保留草稿；同时记录为客户端契约缺陷 |
| 403 | 提示客户端与反馈服务配置不匹配 |
| 404 | 提示反馈服务暂不可用 |
| 413 | 提示截图或请求过大，允许移除截图后重试 |
| 429 | 提示提交过于频繁，保留草稿并让用户稍后手动重试 |
| 500–599 | 提示服务暂时异常，保留草稿 |
| 超时 / DNS / TLS / 离线 | 提示无法连接反馈服务，保留草稿 |
| 响应格式错误 | 提示服务返回无效结果，不能猜测成功 |
| 本地诊断读取失败 | 不发送反馈，保留草稿、勾选状态和请求 ID，提示重试或取消勾选 |

首版不自动重试。自动重试容易让用户无法判断是否已经发送，也会在服务持续异常时制造额外
流量。用户点击“重试”时复用同一个 `clientRequestId`。

---

## 6. 进程与模块设计

### 6.1 调用链

```text
UpdateSettingsSection / FeedbackDialog
  → window.goodbuddy.feedback.submit(input)
  → preload: ipcRenderer.invoke(feedbackSubmit)
  → Main IPC: trusted sender + Zod parse
  → FeedbackService: identity + environment + screenshot normalization
  → StrictFeedbackHttpClient
  → POST /api/v1/feedback
  → response schema parse
  → Renderer confirmation or inline retry state
```

### 6.2 Shared

新增 `src/shared/feedback-contracts.ts`，包含：

- `feedbackCategorySchema`
- `feedbackDraftSchema`
- `feedbackScreenshotInputSchema`
- `feedbackSubmitInputSchema`
- `feedbackSubmitResultSchema`
- `feedbackPublicPayloadSchema`
- 公共字段长度和截图限制常量

推荐客户端 IPC 输入：

```ts
type FeedbackSubmitInput = {
  category: 'bug' | 'feature' | 'experience' | 'other'
  title: string
  description: string
  includeDiagnostics: boolean
  contactEmail?: string
  locale: 'zh-CN' | 'en-US'
  clientRequestId: string
  screenshot?: {
    data: Uint8Array
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  }
}
```

Renderer 不能传入 `productKey`、`appVersion`、`platform`、`architecture` 或
`installationId`，也不能传入诊断内容或路径。这些字段由 Main 从受信运行环境生成。

### 6.3 IPC 与 Preload

新增：

```text
ipcChannels.feedbackSubmit = "feedback:submit"
```

`DesktopApi` 新增必选窄接口：

```ts
feedback: {
  submit: (input: FeedbackSubmitInput) => Promise<FeedbackSubmitResult>
}
```

Main handler 必须：

1. 调用现有 `assertTrustedSender(event, window)`。
2. 使用 Shared Zod schema 解析 `unknown` 输入。
3. 不接收 URL、文件路径、Cookie、Header 或任意请求选项。
4. 由 `FeedbackService` 跟踪活动 Promise，应用关闭或清除数据时先取消再有界等待。

Preload 只转发已声明输入，不做网络请求或图片文件读取。

反馈 handler 独立放在 `feedback/feedback-ipc.ts`，复用共享的
`assertTrustedSender()`，避免继续扩展通用 `registerIpcHandlers()` 的位置参数列表。

### 6.4 FeedbackIdentityStore

新增 Main-only `FeedbackIdentityStore`：

- 文件：`<userData>/feedback-identity.json`
- Schema：

```json
{
  "version": 1,
  "installationId": "00000000-0000-4000-8000-000000000101"
}
```

- 缺失时使用 `crypto.randomUUID()` 创建。
- 使用 `writeJsonFileAtomically()` 写入 0600 临时文件并原子替换。
- 读取时使用严格 schema。
- 损坏时隔离原文件并生成新身份，不读取或复用 Remote Agent 身份。
- 并发首次读取必须合并为同一个 Promise，不能生成两个 UUID。
- `clear()` 删除文件和内存缓存，供“清除本地数据”调用。

该 UUID 是可重置的应用安装级随机标识，不声称代表真实设备或用户。

### 6.5 FeedbackService

Main-only `FeedbackService` 负责：

- 读取或创建安装 UUID。
- 映射应用版本、平台和架构。
- 验证并标准化可选截图。
- 组装严格的公共 payload。
- 仅在 `includeDiagnostics: true` 时通过注入的 DesktopDiagnostics provider 读取最多 20 条
  最近记录；默认提交完全不调用诊断 provider。
- 将诊断格式化为带
  `[GOODBUDDY_DESKTOP_DIAGNOSTICS_V1_BEGIN]` /
  `[GOODBUDDY_DESKTOP_DIAGNOSTICS_V1_END]` 明确分隔、最多 1,600 字符且只保留完整 JSON
  行的摘要。无记录时写入固定 `{"status":"no-recent-diagnostics"}` 事实。
- 调用 HTTP Client。
- 维持单次提交的 AbortController，并在 dispose / 清除本地数据时取消。

平台映射固定为：

| Node 值 | API 值 |
| --- | --- |
| `win32` | `windows` |
| `darwin` | `macos` |
| `linux` | `linux` |
| 其他 | `unknown` |

架构只保留 `x64` 和 `arm64`，其他值映射为 `unknown`。

公共 API 继续使用 `schemaVersion: 1` 和原有固定字段。`includeDiagnostics` 只属于客户端
IPC 输入，不进入公共 payload，也不新增 multipart 字段；Main 把摘要追加到
`payload.description`。默认未勾选时，公共 payload 与既有实现逐字段一致。诊断读取失败时
不得发送部分摘要或声称已附加，必须返回可本地化的 `diagnostics-unavailable` 错误。

### 6.6 严格 HTTPS Client

反馈客户端使用 `undici` 的独立 `Agent`：

```ts
new Agent({
  connect: {
    rejectUnauthorized: true
  }
})
```

这是必要边界，不是额外配置。GoodBuddy 的 `GlobalTlsPolicy` 会给模型、MCP 和内网服务
安装不校验证书的全局 Dispatcher；反馈内容不能经过该 Dispatcher。

每次请求必须满足：

- 固定、预先校验的 HTTPS URL。
- 使用 Undici 原始 `request()`，不安装重定向处理器；任何 3xx 都按服务不可用处理。
- 不使用 Cookie Jar、缓存、Referrer 或浏览器凭据模式。
- `Accept: application/json`。
- 固定、非敏感 `User-Agent`，例如 `GoodBuddy-Feedback/<version>`。
- 不发送 `Authorization`、Cookie、API Key 或自定义代理凭据。
- 总超时建议 15 秒，最大不得超过 30 秒。
- 成功响应体最多 16 KiB，并检查流式实际字节数，不能只相信
  `Content-Length`。
- 只接受 JSON `Content-Type` 和 JSON 响应体，并使用
  `feedbackSubmitResultSchema` 解析。
- 日志只记录有界错误类别和 HTTP 状态，不记录请求正文、邮箱、截图、安装 UUID、
  `clientRequestId` 或响应编号。

测试可以注入 Endpoint、Dispatcher 和 Request Transport。生产构造路径不得读取测试覆盖值或
环境变量。

---

## 7. 截图处理

### 7.1 Renderer

- 文件输入限制为 `.png,.jpg,.jpeg,.webp`。
- 原始文件上限固定为 5 MiB，超过后不读取完整内容或调用 IPC。
- 粘贴事件只处理图片，不拦截普通文本粘贴。
- 读取 `File.arrayBuffer()` 后先执行 Shared 字节上限校验。
- 使用临时 Object URL 预览，替换、移除或关闭对话框时立即
  `URL.revokeObjectURL()`。
- 不调用 `webUtils.getPathForFile()`，不把本地文件路径传给 Main 或服务端。

### 7.2 Main

Main 不信任 Renderer 声明的 MIME：

1. 校验 PNG、JPEG、WebP 文件签名。
2. 使用 `nativeImage.createFromBuffer()` 实际解码。
3. 拒绝空图片、异常尺寸、超过 API 公开上限的像素数。
4. 使用 `toPNG()` 重编码，去除原始元数据。
5. 检查标准化后字节数不超过 5 MiB，最大边长不超过 8,192 像素，总像素数不超过
   3,200 万。
6. 仅把标准化 PNG 放入当前网络请求，不写入磁盘。

客户端和服务端都执行图片验证属于有意的纵深防御：客户端保证原始元数据不离开设备，
服务端保证不能信任任意客户端。

---

## 8. Renderer 实施落点

### 8.1 组件

- `UpdateSettingsSection.tsx`
  - 继续负责应用信息和更新卡片。
  - 渲染反馈入口卡片。
- `FeedbackDialog.tsx`
  - 独立管理草稿、预览、校验、提交、重试和成功编号。
  - 关闭后销毁草稿状态。
对话框不与更新检查状态共用 `saving`、`checking` 或 `error`，避免一个功能失败覆盖另一个
功能的状态。

### 8.2 国际化

在 `settingsSections` 的 `zh-CN` 与 `en-US` 资源中增加同构键：

- 入口卡片标题、说明和按钮。
- 类型名称。
- 字段标签、占位、帮助和校验。
- 截图选择、替换、移除和隐私提醒。
- 提交中、失败、重试、成功和复制编号。
- 数据发送说明。

组件不得内嵌只存在于一种语言的产品文案。

### 8.3 样式

- 复用 `capability-card`、`field`、`primary-button`、`secondary-button` 和现有
  对话框层级。
- 新样式使用 `UI-DESIGN.md` 的语义颜色、间距、圆角和动效令牌。
- 对话框桌面端最大宽度建议 600px；窄窗口占可用宽度并保持 16px 页面边距。
- 不为反馈入口创建新的一级页面、页签视觉或高饱和营销卡片。

---

## 9. 失败、生命周期与恢复

### 9.1 幂等

- 打开新草稿时生成 `clientRequestId`。
- 字段编辑、截图替换、网络失败和手动重试都不改变 ID。
- 成功或显式丢弃草稿后，下一条反馈生成新 ID。
- 同一 ID 返回原编号时按成功处理。

### 9.2 并发

- 对话框同一时间只允许一个提交。
- Main 同一 `clientRequestId` 只运行一个请求。
- Main 全局同一时间只发送一条反馈；相同 ID 的重复调用合并，不同 ID 在已有请求期间返回
  有界 `busy` 结果，不能并行保留多份 5 MiB 截图。
- 读取截图使用选择代次；旧文件后完成时必须丢弃并释放 Object URL，不能覆盖较新的截图。

### 9.3 应用退出与清除数据

- 反馈请求有独立 AbortController。
- 应用退出时取消进行中的请求并关闭严格 TLS Dispatcher。
- “清除本地数据”先取消请求，再删除 `feedback-identity.json`。
- 失败或取消不写入本地“已发送”状态，服务端是否已接收由同 ID 重试确认。

### 9.4 服务不可用

反馈平台不可用时：

- 保留表单和截图。
- 显示明确网络或服务错误。
- 不静默丢弃、不自动切换 GitHub、不打开网页、不自动重试。
- 其他 GoodBuddy 功能继续可用。

---

## 10. 实施文件

当前实现涉及：

| 文件或目录 | 变更 |
| --- | --- |
| `src/shared/feedback-contracts.ts` | 输入、公共 payload、响应和限制 schema |
| `src/shared/ipc-channels.ts` | `feedbackSubmit` channel |
| `src/shared/contracts.ts` | `DesktopApi.feedback` |
| `src/main/feedback/feedback-identity-store.ts` | 随机安装 ID |
| `src/main/feedback/feedback-screenshot.ts` | 签名、解码和 PNG 标准化 |
| `src/main/feedback/feedback-http-client.ts` | 固定 Endpoint、严格 TLS、有界响应 |
| `src/main/feedback/feedback-service.ts` | payload 组装与生命周期 |
| `src/main/feedback/feedback-ipc.ts` | 独立 trusted sender、schema parse 和 submit handler |
| `src/main/trusted-ipc-sender.ts` | Main IPC 共享 sender / main Frame 校验 |
| `src/main/index.ts` | Main service 构造、清理和 IPC 注入 |
| `src/preload/index.ts` | 窄 `feedback.submit()` bridge |
| `src/renderer/src/FeedbackDialog.tsx` | 表单和成功/失败流程 |
| `src/renderer/src/UpdateSettingsSection.tsx` | About 入口卡片 |
| `src/renderer/src/i18n/locales/*/settingsSections.ts` | 中英文文案 |
| `src/renderer/src/styles.css` | 令牌化布局与响应式样式 |

每个生产文件应有相邻或现有测试文件覆盖。不要把 Endpoint、截图处理或网络逻辑塞进
`ipc.ts` 或 React 组件。

---

## 11. 验证

以下 Shared、Main、IPC、Preload 和 Renderer 行为均由相邻或现有自动化测试覆盖；生产
Endpoint 的健康检查和无副作用 schema 探针也必须在发布前通过。

### 11.1 Shared 合同

- 接受四种反馈类型和有效字段。
- 拒绝未知字段、空标题、短描述、超长描述、错误邮箱、非 UUID 和多截图。
- 对截图按字节限制，而不是字符串长度限制。
- 请求与反馈平台 `schemaVersion: 1` fixture 双向兼容。

### 11.2 Main 单元测试

- 安装 ID 首次创建、并发读取、持久化、损坏隔离和清除。
- 不复用 Agent、Runtime、Project 或硬件身份。
- 平台和架构映射。
- PNG/JPEG/WebP 签名、实际解码、尺寸限制、PNG 重编码和元数据不保留。
- 无截图 JSON、有截图 multipart、请求 Header 和固定 URL。
- 独立 Dispatcher 显式 `rejectUnauthorized: true`。
- 拒绝重定向、非 HTTPS、错误 Origin、超时、超大响应、非 JSON 和错误 response schema。
- 4xx、429、5xx 和网络错误映射。
- 手动重试复用 `clientRequestId`。
- 不同 ID 的并发请求被有界拒绝，清除本地数据期间不能开始新提交。

### 11.3 IPC 与 Preload

- 未知窗口和非主 Frame 被拒绝。
- Renderer 不能覆盖 `productKey`、版本、平台、架构、安装 ID、Endpoint 或 Header。
- Preload 只暴露 `feedback.submit()`。
- Sandbox 测试验证没有通用网络或文件路径能力泄漏。

### 11.4 Renderer

- About 页面展示反馈卡片。
- 表单字段、字符限制、中英文文案和隐私说明。
- 普通文本粘贴不被图片处理拦截。
- 截图选择、预览、替换、移除和 Object URL 清理。
- 并发截图读取按最新选择生效，关闭对话框后不会留下待处理 Object URL。
- 失败保留字段、诊断勾选状态，重试使用原 `clientRequestId`。
- 默认提交不读取诊断且公共 payload 不变；主动附加、描述预算、无记录和读取失败均有覆盖。
- 成功显示真实编号并清空后续新草稿。
- Dialog role、初始焦点、Tab 循环、Escape 和焦点恢复。
- 浅色、深色、窄窗口和 reduced motion。

### 11.5 真实集成

2026-08-25 已从隔离配置的真实 Electron 生产构建完成一次端到端合成提交：

- 标题：`[GOODBUDDY INTEGRATION TEST] 2026-08-25`
- 类型：`other`
- 联系邮箱：未填写
- 截图：GoodBuddy 公共应用图标，经 Main 重编码后以 PNG multipart 上传
- 服务端编号：`GOODBUDDY-000001`

该结果确认 About UI、Renderer、Preload、trusted IPC、安装身份、Main 图片处理、独立严格
TLS Dispatcher 和生产 v1 API 调用链可以共同工作。发布候选仍应按以下清单复验：

1. 从打包候选的 About 页面提交一条明确标记的合成反馈。
2. 可选添加一张不含个人数据的测试截图。
3. 确认客户端显示的编号与管理后台一致。
4. 确认版本、平台、架构和语言正确。
5. 确认服务端只保存标准化 PNG，不含原始图片元数据。
6. 断网后提交，确认草稿保留；恢复网络后以同一 ID 重试且只产生一条记录。
7. 使用无效证书的测试服务，确认反馈客户端拒绝连接，即使 GoodBuddy 全局内网 TLS
   策略允许其他服务继续工作。
8. 检查 Renderer 和 Main 日志不含正文、邮箱、截图、安装 ID 或凭据。

最终仍需运行仓库统一验证：

```text
npm test
npm run typecheck
npm run lint
npm run build
```

---

## 12. 发布与兼容性

- `schemaVersion: 1` 与 `/api/v1/feedback` 是同一版本边界。
- 向请求增加必填字段、修改枚举或改变字段语义属于破坏性变更，必须发布新 schema 或新
  API 版本。
- GoodBuddy 对响应执行严格解析。服务端需要扩展响应时，应先协调客户端兼容策略。
- Endpoint 域名变化属于客户端发布变更，不能依赖 301/302 迁移。
- 入口发布与 `goodbuddy` 产品启用状态、生产 TLS 和 v1 契约保持同一发布门槛。
- 此功能不迁移现有用户数据；只新增可重置的随机反馈安装身份。
- 发布说明应明确：用户现在可以在“关于与更新”内直接提交反馈，邮箱和截图可选；桌面诊断
  默认不上传，只有用户勾选后才附加有界摘要，并且不会发送对话、Prompt、凭据、文件内容、
  路径、Provider 原始响应或远端 Agent 日志。

---

## 13. 当前对接状态

截至 2026-08-25：

1. 生产 Origin 已确定为 `https://imp.mesalogo.com`，HTTPS、HSTS 和健康检查正常。
2. `/api/v1/feedback` 已返回符合 v1 契约的严格校验错误，无副作用探针未创建记录。
3. `goodbuddy` 产品已启用，实际提交返回 `GOODBUDDY-000001`。
4. GoodBuddy 客户端已完成 Shared、Main、IPC、Preload、About UI、双语文案、截图和
   生命周期实现。
5. 服务端公开 schema、字段长度和 5 MiB 截图上限与客户端一致。
6. 隔离 Electron 实例已完成浅色、深色、600×800 窄窗口、焦点与背景隔离、截图预览和
   真实生产提交验收。
