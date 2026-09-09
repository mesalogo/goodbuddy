# Office 协同编辑技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中 |
| 版本 | 0.1 |
| 日期 | 2026-09-09 |
| 关联 PRD | [Office 协同编辑 PRD](./prd.md) |
| 跨端架构 | [ShareServer 联邦网络总体设计](../../architecture/share-network-architecture.md) |

## 1. 技术选型

首个 Provider 使用 ONLYOFFICE Docs Developer Edition。采用前必须确认当前许可证、桌面应用
分发权、并发连接口径、白标、Automation API、离线私有部署和安全支持；技术设计不构成授权
结论。

不采用：

- ONLYOFFICE Desktop Editors：它是独立桌面产品，不是 GoodBuddy 工作栏嵌入 SDK。
- Node/Python OOXML 库：只提供生成或结构化处理，不提供高保真画布、选区和撤销栈。
- Microsoft WOPI：第三方接入资格和云授权不适合作为 GoodBuddy 默认能力。
- 自研 OOXML 渲染器：格式兼容和编辑成本超出当前产品边界。

后续 Provider 可以增加 Univer Sheets，但只能按通过验收的格式和能力声明，不能由“纯前端”推导
为完整 Office 兼容。

## 2. 组件边界

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
Desktop 不读取 Document Server 地址或密钥，只消费 ShareServer 返回的一次性编辑启动 URL。

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

建议的服务端资源：

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

ShareServer 托管固定版本的 GoodBuddy ONLYOFFICE 插件。插件只能：

- 获取当前会话和有界选区描述；
- 发起 AI 编辑请求并显示状态；
- 接收受限结构化编辑操作；
- 在一个编辑器撤销上下文中应用、回滚和高亮修改；
- 发布不含正文的 dirty、save 和 revision 事件。

首期优先让插件通过 ShareServer 会话通道与 Desktop 交换事件，不给远端编辑页面添加通用
Electron preload。ShareServer 只中继有界事件；Agent 请求仍由 Desktop 创建并经过现有
Conversation、模型、Ask/Execute、取消和活动记录边界。

Ask 请求可以返回可复制的修改建议，但 Main 拒绝向插件下发写操作。只有 Execute 请求能够
取得绑定当前文档会话、revision 和选区的短期编辑 Grant；该 Grant 不包含源文件路径，也不能
用于其他文档、文件工具或系统能力。

结构化操作按文档类型单独列白名单，例如文本替换、单元格值或公式更新、幻灯片对象文字
替换。禁止传入 JavaScript、宏、任意 ONLYOFFICE 方法名或表达式求值。

## 8. 部署与配置

ShareServer 部署清单新增可选 Office 组件：

```text
ShareServer API
PostgreSQL
兼容 S3 的对象存储
ONLYOFFICE Document Server
Office callback worker
```

服务端管理配置包含 Document Server 内部地址、公开编辑 origin、JWT 密钥引用、对象存储、
允许格式、文件大小、并发、会话期限和 checkpoint 保留。管理界面提供真实健康检查：创建最小
文档、打开编辑器、执行保存回调并核对输出，而不是只检查 HTTP 端口。

Desktop 仅显示某个 ShareServer 是否声明并实际通过 `office.edit` 能力检查。未配置或不健康时
保留文档入口并说明不可用原因。

## 9. 安全边界

1. ShareServer 和 ONLYOFFICE 之间使用独立网络和凭据，不公开管理接口。
2. 文档内容是不可信输入；禁用宏、外部插件、任意外链加载和 Document Server 出站网络。
3. 每个文件 URL、callback 和启动授权绑定单会话、单用途和短期限。
4. Renderer 不接触设备凭据、ONLYOFFICE JWT、对象存储凭据或本机绝对路径。
5. 编辑器 origin 不能调用任意 IPC、Shell、文件系统、浏览器或 Runtime 工具。
6. 上传、下载、callback、事件和 AI 操作限制字节数、频率、并发和总时长。
7. 服务端保留策略到期后清理工作副本、checkpoint、编辑 Cookie 和对象令牌；审计元数据按组织
   策略独立保留。
8. 组织管理员能够撤销 Office 能力和活动会话；撤销后 Desktop 仍保留本地源文件，不把服务端
   删除描述为本地删除。

## 10. 实施顺序

1. 在 ShareServer 独立仓库补充 Office 服务 PRD、部署配置、对象存储和 ONLYOFFICE 许可证决策。
2. 实现服务端最小会话、上传、启动、callback、checkpoint、下载和清理闭环。
3. Desktop 增加多实例文档页签和只读打开，完成三平台真实视觉及资源验证。
4. 接入源文件冲突检测、原子保存、另存为、关闭和恢复。
5. 实现固定 ONLYOFFICE 插件及单次可撤销 AI 选区修改。
6. 增加组织策略、配额、审计和生产部署验收。

不得在服务端闭环、许可证和三平台真实编辑验收前把该能力标记为已提供。
