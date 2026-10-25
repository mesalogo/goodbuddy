# Office 协同编辑技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 已接通三种现代格式与三种旧格式转换编辑；完整协同验收待完成 |
| 版本 | 0.2 |
| 日期 | 2026-10-25 |
| 关联 PRD | [Office 协同编辑 PRD](./prd.md) |
| 跨端架构 | [ShareServer 联邦网络总体设计](../../architecture/share-network-architecture.md) |

## 1. 技术选型

当前接入基线使用用户指定的 `onlyoffice/documentserver:10.0`（Community），普通插件作为
DOCX 实时选区接入路径。实际验证与限制见[实施进度](./progress.md)。Developer Edition 和
Automation API 不作为当前已具备的能力；需要时单独评估。正式分发仍按实际嵌入方式确认许可。

本地阅读与在线编辑分层：先复用[文件打开规则](../file-opening/README.md)和本地预览候选，
用户选择编辑时才上传工作副本。预览 Demo 没有 Desktop IPC 或编辑会话，不直接搬入产品作为
已完成能力。按[性能原则](../../architecture/performance-principles.md)按需加载；Main 负责调度，
文件解析、哈希及批量传输交给已有 worker／utilityProcess 或远程 Agent。

不采用：

- ONLYOFFICE Desktop Editors：它是独立桌面产品，不是 GoodBuddy 工作栏嵌入 SDK。
- Node/Python OOXML 库：只提供生成或结构化处理，不提供高保真画布、选区和撤销栈。
- Microsoft WOPI：第三方接入资格和云授权不适合作为 GoodBuddy 默认能力。
- 自研 OOXML 渲染器：格式兼容和编辑成本超出当前产品边界。

后续 Provider 可以增加 Univer Sheets，但只能按通过验收的格式和能力声明，不能由“纯前端”推导
为完整 Office 兼容。

## 2. 组件边界

下图为 Desktop 完整接入目标；当前服务实现及缺口见第 4 节，部署实况见第 8 节。

```text
GoodBuddy Renderer
  └─ 文档 Tab 外壳、公开状态、用户命令

GoodBuddy Main
  ├─ DocumentEditSessionService
  ├─ 本地/SSH 源文件 Grant 与校验
  ├─ 上传、下载、原子回写和冲突检测
  ├─ OfficeEditorView 生命周期
  └─ 本地活动记录

ShareServer
  ├─ 用户、设备、组织和策略认证
  ├─ Office 会话 API 与短期启动授权
  ├─ 工作副本、保存检查点和保留清理
  ├─ ONLYOFFICE JWT、文件 URL 和 callback handler
  ├─ 编辑器版本、健康、配额和审计
  └─ 可选 AI 编辑消息中继

ONLYOFFICE Document Server
  └─ Word、Spreadsheet、Presentation Web Editors
```

ShareServer 可以把 ONLYOFFICE 和对象存储作为同一部署套件的依赖管理，但两者仍是独立服务。
目标由 ShareServer 提供编辑入口；当前实际入口为 `/documents?document=<id>`，尚无一次性启动 URL。
Desktop 使用 `/office/editor?document=<id>` 简洁布局，普通浏览器仍使用 `/documents`。
编辑页面按服务端配置加载浏览器可达的 Docs origin；共享 JWT 原始秘密始终保留在服务器。

## 3. 工作栏实例

在工作栏应用注册表新增多实例 `document`：

```ts
type DocumentPanelInstance = {
  id: string
  capability: 'document'
  documentSessionId: string
  displayName: string
  duplicateIndex?: number
  binding: { mode: 'pinned'; target: { type: 'document-session'; id: string } }
  dock: 'right' | 'bottom' | 'window'
}
```

持久布局只保存公开会话 ID、显示名、来源对象 ID 和停靠方式，不保存启动 URL、Cookie、文件
令牌、绝对路径或 ONLYOFFICE 配置。应用恢复时由 Main 重新认证并判断会话能否恢复。

编辑器内容不使用现有静态 HTML `iframe sandbox=""`。Main 为每个已加载会话创建独立
`WebContentsView`，固定允许的 ShareServer origin、隔离 session partition、关闭 Node
integration、开启 context isolation 和 sandbox，并禁用新窗口、任意下载、权限请求和非允许
导航。远端页面不获得通用 Electron preload API。

多页签允许多个会话描述同时存在；只有经过资源验收的有限数量编辑器保持加载。非活动实例的
具体挂起和恢复阈值在跨平台内存测试后冻结，不能未经保存检查点直接销毁 dirty 编辑器。

## 4. ShareServer API 边界

### 当前接入依据

Office API 位于 ShareServer 的 `server/src/office/`，与其他 API 共用 Node.js/Hono 后端。
React Web 独立构建，经 Nginx 同源访问统一后端，无单独 Python 服务。
内网没有域名时使用 `http://<主机IP>:8088`，Docs 使用客户端可达的 `http://<主机IP>:8080`；
开发测试须覆盖 IP 地址下的编辑、插件跨端口加载和保存，不把 Docker 名称或 localhost 当作远端主机。
现有接口的唯一清单见
[ShareServer 技术设计第 10.1 节](../../../../goodbuddy-shareserver/docs/features/share-server/technical-design.md#101-私有部署第一阶段待实现)。
GB 适配 `/api/v1/office/documents`：上传原始文件字节而非 multipart，打开编辑页、请求保存并
查询状态。`/config` 提供 enabled、maxBytes、publicUrl、formats、directFormats、conversions、
`versionedDownload: true` 和原型标志；不声明 AI 能力。

当前服务只适用于可信私有网络，没有组织认证；页面返回的是带签名编辑配置，未实现下述
`/sessions`、启动 code、事件通道或 `source-commit`。这些目标不能当作可调用 API。
接入沿现有 documents 资源补齐实际缺口，不为沿用旧接口名称重写服务：

| 缺口 | 接入要求 |
| --- | --- |
| 内嵌布局 | 已有简洁编辑页及专用 WebContentsView，复用浏览器遮挡判断；跨平台焦点和输入法待验收 |
| 下载稳定版本 | `download?revision=N` 返回指定已提交版本；详情返回 digest、size，Desktop 后台校验后回写 |
| 保存结果 | `noChanges` 需结合编辑器状态判断；不能只等待 revision 增长，也不能视为源文件已保存 |
| 选区与状态桥 | 将请求绑定原文档和目标，读取编辑器未保存内容；当前服务器 revision 不能检测所有人工修改 |
| 结束与放弃 | 源文件导入模式的放弃是不回写源文件；现有服务器文档不会因关闭而删除或回滚 |

### 后续组织服务目标（未实现）

原建议资源保留如下，仅用于组织服务设计参考：

```text
POST   /api/v1/office/sessions
PUT    /api/v1/office/sessions/{id}/source
POST   /api/v1/office/sessions/{id}/launch
GET    /api/v1/office/sessions/{id}
GET    /api/v1/office/sessions/{id}/events
GET    /api/v1/office/sessions/{id}/checkpoints/{revision}
POST   /api/v1/office/sessions/{id}/source-commit
DELETE /api/v1/office/sessions/{id}

GET    /internal/office/files/{objectToken}
POST   /internal/office/callback/{callbackToken}
```

Desktop API 使用设备凭据和组织 audience。启动 URL 使用一次性 code，交换为 HttpOnly、Secure、
SameSite Cookie 后立即失效。ONLYOFFICE 文件 URL、callback URL 和 JWT 使用独立 audience、短
有效期及单会话绑定，不能用于普通 ShareServer API。

ShareServer 不把对象存储公开 URL 直接返回 Renderer。文件下载必须重新验证用户、设备、会话、
revision 和策略，并返回声明大小和 SHA-256。

## 5. 会话契约

```ts
type CreateDocumentEditSession = {
  source: {
    kind: 'workspace-file' | 'artifact'
    publicSourceId: string
    displayName: string
    mediaType: string
    size: number
    sha256: string
  }
  requestedAccess: 'edit' | 'read-only'
}

type DocumentEditSessionSummary = {
  id: string
  state: 'uploading' | 'ready' | 'editing' | 'offline' | 'expired' | 'closed'
  access: 'edit' | 'read-only'
  documentType: 'word' | 'cell' | 'slide'
  displayName: string
  sourceRevision: string
  checkpoint?: {
    revision: string
    size: number
    sha256: string
    createdAt: string
  }
  retentionExpiresAt: string
}
```

远端值全部经过有界 schema 校验。`publicSourceId` 是 Desktop 管理的对象 ID，不是文件路径。

## 6. 文件与保存

### 当前 Office 文件实现

`office-contracts.ts` 定义窄 IPC；`OfficeService` 管理选择文件、独立沙箱视图、保存与关闭。
`office-file-worker.ts` 执行上传、摘要计算、版本下载、冲突检查及同目录暂存后 rename；Main
不执行文档解析或哈希。`office-store.ts` 持有运行期面板状态，布局只保存页签 ID 和文件名；
应用重启后需重新选择文件，尚无编辑来源恢复。公开服务器地址保存在 Renderer localStorage。

`shareserver-connection-store.ts` 是各文件入口共享的连接状态，沿用既有
`goodbuddy.office.serverUrl` 偏好键；设置和文档面板共用配置组件。不在应用启动时请求服务。
连接检查通过窄 `office:capabilities` IPC 请求 `GET /api/v1/office/config`，校验
`enabled / formats / maxBytes / versionedDownload`。连接到 ShareServer 不等于 Office 已启用，
能力返回也不证明编辑引擎此时健康；实际编辑页加载错误仍由打开流程报告。
Main 创建编辑会话前检查启用状态与版本下载能力，失败不读取远程文件或上传。
Worker 上传前重新读取能力，按格式与上限校验文件。此检查复用于本地、附件和远程 Workspace 来源。

`officeStore.requestOpen` 统一接收来源引用：已配置时自动打开，相同来源正在打开或已有编辑页签时复用。
会话文件预览页的编辑动作保留项目与路径，复用工作区的请求分发；普通阅读不调用此动作。
未配置和失败保留来源供重试。当前客户端允许 DOCX、XLSX、PPTX、DOC、XLS、PPT，仍须通过服务端能力检查。
旧格式由 ShareServer 转换后返回现代格式文件名、`originalName` 与 `requiresSaveAs=true`。
Main 将该来源标为不可直接回写，首次保存弹出另存为；Worker 拒绝与输出格式不一致的目标扩展名。
成功另存后后续保存更新新文件，旧的本地或远程来源不再作为写回目标。AI 选区工具当前仅显示于 Word。

保存期间隐藏原生视图防止继续输入，等待编辑器 ready 且 dirty=false，再发 forcesave，等待
服务端轮次退出 saving，并下载该 revision。无新修改不要求 revision 增长。源文件摘要变化
时报冲突并保留视图，用户可以另存为。成功后更新下一次回写的摘要基准。关闭提供保存、
不回写、取消；不回写不撤销已完成的服务器保存。退出在既有清理开始之前处理文档，取消时
保留所有编辑视图。远程文件适配通过 Workspace 通道校验摘要后替换；AI 选区桥已接入现有
会话队列，完整应用的本地测试模型往返通过。当前尚无操作取消 IPC，完整验收范围见实施进度。

以下为覆盖本地及远程来源的完整目标，未实测部分不由上述本地实现推导为完成：

- Desktop 从已授权本地或 SSH 源读取并流式计算大小和 SHA-256。
- 上传目标由 Main 从固定 ShareServer API 获得，不接受 Renderer 提供 URL。
- ShareServer 写入随机对象键，拒绝用户文件名决定存储路径。
- ONLYOFFICE callback 先写临时对象，校验后原子发布为新 checkpoint。
- Desktop 下载 checkpoint 到 GoodBuddy-owned 暂存，复核大小、SHA-256、普通文件属性和文件
  magic，再在源文件同目录创建临时文件并原子替换。
- SSH 源文件由远程 GoodBuddy Agent 执行相同摘要、冲突和原子替换，不把远程凭据交给
  ShareServer。
- 每次成功回写后 Desktop 将新摘要作为下一次冲突检测基准。

## 7. 编辑器桥与 AI 编辑

ShareServer 在 `server/src/office/plugin` 托管 GoodBuddy ONLYOFFICE 插件。`scripts/office-e2e/plugin` 仅为
测试夹具，通过真实 `GetSelectedText`／`PasteText` 验证 DOCX 简单文本；未接入聊天或生产配置。
插件配置由 Docs origin 跨域读取，托管资源需要精确 CORS，业务 API 仍可保持同源。
生产桥只暴露有界语义操作，不照搬探针供测试驱动使用的任意方法调用接口。插件只能：

- 获取当前会话和有界选区描述；
- 发起 AI 编辑请求并显示状态；
- 接收受限结构化编辑操作；
- 在一个编辑器撤销上下文中应用、回滚和高亮修改；
- 发布不含正文的 dirty、save 和 revision 事件。

首期优先让插件通过 ShareServer 会话通道与 Desktop 交换事件，不给远端编辑页面添加通用
Electron preload。ShareServer 只中继有界事件；Agent 请求仍由 Desktop 创建并经过现有
Conversation、模型、能力范围、取消和活动记录边界。

仅要建议的请求返回可复制文本，不下发编辑操作。修改请求
取得绑定当前文档会话、revision 和选区的短期编辑 Grant；该 Grant 不包含源文件路径，也不能
用于其他文档、文件工具或系统能力。

结构化操作按文档类型单独列白名单，例如文本替换、单元格值或公式更新、幻灯片对象文字
替换。禁止传入 JavaScript、宏、任意 ONLYOFFICE 方法名或表达式求值。

## 8. 部署与配置

当前独立部署的实际结构为：

```text
React Web / Nginx
ShareServer Node/Hono API（单写进程，Office 模块直接处理保存回调）
宿主文件系统（文档、版本及 JSON 元数据）
ONLYOFFICE Document Server 10.0
```

启动变量、地址与镜像 digest 统一见
[ShareServer 部署说明](../../../../goodbuddy-shareserver/docs/office-deployment.md)。Office 首期不依赖
PostgreSQL、S3 或独立 callback worker；完整组织服务可按实际需要扩展。

后续服务端管理配置包含 Document Server 内部地址、公开编辑 origin、JWT 密钥引用、对象存储、
允许格式、文件大小、并发、会话期限和 checkpoint 保留。管理界面提供真实健康检查：创建最小
文档、打开编辑器、执行保存回调并核对输出，而不是只检查 HTTP 端口。

Desktop 仅显示某个 ShareServer 是否声明并实际通过 `office.edit` 能力检查。未配置或不健康时
保留文档入口并说明不可用原因。

## 9. 安全边界

1. ShareServer 和 ONLYOFFICE 之间使用独立网络和凭据，不公开管理接口。
2. 文档内容是不可信输入；禁用宏、外部插件、任意外链加载和 Document Server 出站网络。
3. 每个文件 URL、callback 和启动授权绑定单会话、单用途和短期限。
4. Renderer 不接触设备凭据、ONLYOFFICE JWT 共享秘密、对象存储凭据或本机绝对路径；
   编辑器接收服务端签发的配置 token，不持有签名秘密。
5. 编辑器 origin 不能调用任意 IPC、Shell、文件系统、浏览器或 Runtime 工具。
6. 上传、下载、callback、事件和 AI 操作限制字节数、频率、并发和总时长。
7. 服务端保留策略到期后清理工作副本、checkpoint、编辑 Cookie 和对象令牌；审计元数据按组织
   策略独立保留。
8. 组织管理员能够撤销 Office 能力和活动会话；撤销后 Desktop 仍保留本地源文件，不把服务端
   删除描述为本地删除。

## 10. 实施顺序

1. 沿已验证的 ShareServer DOCX 和普通插件路径对齐当前 API，补内嵌布局、稳定版本下载与状态桥。
2. Desktop 将文件阅读入口与显式编辑动作接通，新增专用文档视图和多实例页签，保留既有文件来源引用。
3. 完成服务器保存、源文件回写、另存为、冲突及关闭流程；本地与远程分别通过真实链路验收。
4. 将当前聊天 Runtime 接入插件，验证未保存选区读取、请求期间目标变化、实际修改、撤销及保存重开。
5. 扩展 XLSX、PPTX 和复杂样本，完成三平台嵌入、焦点、剪贴板、输入法与资源测量。
6. 组织认证、策略与文档保留按独立组织服务目标推进；不将其假定为当前私网原型已具备的能力。

不得在服务端闭环、许可证和三平台真实编辑验收前把该能力标记为已提供。
