# GoodBuddy 设备共享与 ShareServer 联邦网络总体设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中 |
| 版本 | 0.1 |
| 日期 | 2026-09-03 |
| 适用范围 | GoodBuddy 桌面端、ShareServer、网关间联邦协议 |
| 桌面端设计 | [设备发现与共享](../features/device-sharing/README.md) |
| 服务端设计 | [ShareServer](../features/share-server/README.md) |

## 1. 文档职责

本文是设备共享网络的跨端权威设计，负责定义拓扑、术语、身份、能力清单、授权计算、任务
路由、能力分发、协议边界和共同验收标准。桌面端的产品与界面行为由“设备发现与共享”功能
文档负责，独立 Web 服务由 ShareServer 功能文档负责。

本文描述完整目标系统，不以交付阶段删减领域模型，也不把尚未实现的设计表述为当前能力。

## 2. 核心决策

### 2.1 两个独立产品面

1. **GoodBuddy Desktop** 在设置中提供“设备发现与共享”，默认使用局域网发现与直连，也可
   由用户额外连接一个或多个 ShareServer。
2. **ShareServer** 是独立部署、独立升级的 Web 服务，提供组织、设备、能力、权限、更新、
   联邦、中继和审计管理。它不运行在 Electron Main 中，也不由桌面端代为启动。

### 2.2 能力优先，来源可见

用户日常选择的是能力，不是网络连接。设备、ShareServer 和组织作为能力来源与诊断入口。
任何调用都必须持续显示提供者、执行位置和数据去向，不能为了统一体验隐藏跨设备或跨组织
边界。

### 2.3 局域网是默认连接方式，网关是显式附加连接

- 桌面端没有网关配置时，局域网发现、配对、调用和本机共享仍可完整工作。
- 添加、删除或断开 ShareServer 不改变局域网配对关系。
- ShareServer 不接管本机局域网发现，也不能静默把局域网设备注册到组织。
- 同一桌面端可以连接多个 ShareServer；能力来源和授权按连接分别计算。

### 2.4 发现、被发现和开放能力是三个独立动作

- **发现设备**：浏览同一局域网中主动广播的 GoodBuddy 服务。
- **允许被发现**：广播本设备存在及配对入口。
- **开放能力**：向指定设备、用户组或组织发布可查看、调用或拉取的能力。

开启其中一项不能推导另外两项已开启。新安装默认不开放能力。

### 2.5 ShareServer 优先作为控制面

ShareServer 负责身份、目录、策略、任务路由、更新和审计。数据面优先在两个已认证端点之间
直接建立；网络条件不允许时，可按组织策略使用 ShareServer 中继。是否允许中继、正文是否
端到端加密、是否允许跨组织，由本次任务冻结的策略共同决定。

## 3. 术语

| 术语 | 定义 |
| --- | --- |
| `Device` | 安装 GoodBuddy 并拥有稳定设备身份的终端 |
| `Peer` | 与当前设备存在局域网配对关系的另一台设备 |
| `ShareServer` | 提供组织控制面和可选数据中继的独立服务 |
| `Organization` | ShareServer 中隔离成员、设备、能力与策略的管理范围 |
| `GatewayConnection` | 某台设备与一个 ShareServer 上特定组织身份的连接 |
| `Capability` | 可被查看、调用或分发的稳定能力标识 |
| `CapabilityProvider` | 实际持有并执行某项能力的设备或服务节点 |
| `Publication` | 能力提供者向某一范围发布的可见性和使用声明 |
| `Grant` | 主体对能力执行某类动作的明确授权 |
| `Task` | 一次远程能力调用及其输入、执行、输出和终态 |
| `Package` | 可下载到本机安装的签名能力工件 |
| `FederationTrust` | 两个组织网关之间经管理员确认的双边信任关系 |

“网关”是 ShareServer 的网络角色；产品名称和代码目录统一使用 `ShareServer` / `shareserver`。

## 4. 系统拓扑

```text
局域网：
GoodBuddy Desktop A <-- mDNS 发现 + 配对后 TLS 直连 --> GoodBuddy Desktop B

单组织：
GoodBuddy Desktop A -- 出站连接 --> ShareServer <-- 出站连接 -- Provider Device B

跨组织：
Desktop A --> ShareServer A <== 联邦信任 ==> ShareServer B <-- Provider Device B
```

局域网和网关连接共享能力、授权和任务的领域语义，但不共享发现方式：

| 维度 | 局域网 | ShareServer |
| --- | --- | --- |
| 发现来源 | mDNS/DNS-SD 主动广播 | 已配置 URL 或邀请链接 |
| 初始身份 | 双端验证码确认设备指纹 | 用户登录、设备注册和组织成员身份 |
| 能力目录 | 已配对设备直接返回 | 服务端按组织策略过滤 |
| 连接方向 | 配对后直连 | 设备主动建立出站连接 |
| 管理范围 | 单个设备间授权 | 用户组、组织和联邦授权 |
| 审计权威 | 两端各自本地记录 | 组织网关记录元数据，两端保留本地记录 |

## 5. 组件边界

### 5.1 GoodBuddy Desktop

- 浏览和广播局域网服务。
- 创建、确认和撤销点对点配对。
- 连接 ShareServer，保存脱敏连接信息和本机受保护凭据。
- 发布用户明确选择的本机能力。
- 展示经当前身份过滤的能力目录。
- 在调用前冻结提供者、输入范围、授权和路由。
- 执行本机提供的任务，或消费远端任务结果。
- 校验并安装用户明确选择的签名能力包。
- 保存本机活动记录和可撤销授权。

### 5.2 ShareServer

- 认证用户、设备、服务节点和其他 ShareServer。
- 管理组织、成员、用户组和设备目录。
- 接收能力发布并生成权限过滤后的目录。
- 计算组织强制策略，签发短期任务授权。
- 路由任务、维护在线状态，并在允许时中继数据。
- 管理签名包、发布通道、更新策略和撤销。
- 建立双边联邦关系并限制跨组织可见性与调用。
- 保存有界审计元数据、用量和管理操作。

### 5.3 能力提供者

- 只执行已发布且本次授权允许的能力。
- 在执行边界重新验证任务令牌、输入 schema、大小、期限和调用方。
- 使用自身 Runtime、账号、工作区和数据权限。
- 返回有界进度、结果、成果或确定终态。
- 不因收到任务令牌而获得其他能力或任意系统接口。

## 6. 身份与信任

### 6.1 设备身份

每次 GoodBuddy 安装生成稳定设备密钥和自签设备证书，私钥保存在系统安全存储中。对外只
使用随机设备 ID、公钥指纹、用户设置的设备名称和必要协议版本。操作系统用户名、绝对路径、
软件资产和能力详情不进入未认证发现广播。

重装或主动重置设备身份会产生新设备。旧局域网配对和 ShareServer 设备注册不会自动迁移。

### 6.2 局域网配对

1. 发起端选择一台主动广播的设备。
2. 双方建立临时加密通道并计算共同短验证码。
3. 两端同时显示设备名、系统类型、公钥指纹和验证码。
4. 双方用户确认后保存对端公钥及配对 ID。
5. 后续使用双方设备证书认证；任一端可以撤销配对。

IP 地址不作为设备身份，也不单独构成授权依据。

### 6.3 ShareServer 注册

用户通过浏览器/OIDC 或服务端支持的登录方式认证后，为当前设备申请一次性注册挑战。设备
使用自身私钥签名挑战，ShareServer 建立 `user + organization + device` 绑定并签发可轮换的
设备凭据。设备凭据不等同于用户 Web 会话，不可用于管理控制台登录。

### 6.4 联邦身份

两个 ShareServer 由双方管理员交换组织标识、网关公钥、公开端点和指纹，并分别确认信任。
联邦关系只有在双方状态均为 `active` 时生效。单方暂停或撤销后立即停止新目录交换和新任务，
已执行任务保留审计终态。

## 7. 能力模型

### 7.1 能力清单

```json
{
  "schemaVersion": "1.0",
  "capabilityId": "document.convert.docx",
  "name": "文档转 Word",
  "version": "1.4.0",
  "modes": ["remote", "package"],
  "inputSchema": {},
  "outputSchema": {},
  "permissions": ["receive_text", "receive_files", "return_files"],
  "limits": {
    "maxInputBytes": 10485760,
    "maxOutputBytes": 52428800,
    "maxDurationSeconds": 900,
    "maxConcurrentTasks": 2
  },
  "dataPolicy": {
    "retention": "task_lifetime",
    "networkAccess": false,
    "delegation": "none"
  }
}
```

清单只描述能力事实，不授予任何主体访问权。`inputSchema` 和 `outputSchema` 使用受限 JSON
Schema 子集；实现必须限制 schema 深度、属性数、枚举数和总字节，不能把清单当作可执行代码。

### 7.2 发布声明

`Publication` 将一个能力版本发布到以下一种范围：

- 指定局域网 Peer。
- 所有已配对 Peer。
- ShareServer 内指定用户、用户组或设备组。
- 指定联邦组织中的用户组。

发布声明同时定义允许动作：`discover`、`inspect`、`invoke`、`download`。`inspect` 允许查看
详细清单，`discover` 只允许看到名称和可用状态。

### 7.3 可调用与可分发

- `remote`：代码与受控数据留在提供方，调用方只发送输入并接收结果。
- `package`：签名工件下载到调用方，经校验和用户/组织策略批准后安装。

同一能力可以同时支持两种模式，但两种模式分别授权。远程调用授权不能推导下载权，下载权
也不能推导安装后自动启用。

## 8. 授权模型

### 8.1 授权输入

一次动作的最终决定取以下约束交集：

```text
调用方用户权限
∩ 调用方设备状态
∩ 调用方组织强制策略
∩ 发布范围
∩ 提供方授权
∩ 提供方组织强制策略
∩ 能力输入与数据策略
∩ 联邦关系限制（跨组织时）
= allow | require_approval | deny
```

`deny` 优先于 `require_approval`，`require_approval` 优先于 `allow`。客户端偏好只能在组织强制
策略允许的范围内收紧权限，不能放宽权限。

### 8.2 Grant

Grant 至少绑定：

- 主体：用户、用户组、设备、设备组或外部组织。
- 能力 ID 和允许的版本范围。
- 动作：查看、调用、下载、安装或发布。
- 输入：文本、文件、数据分类、单项和累计大小。
- 提供者和执行位置限制。
- 次数、并发、预算、时间段和有效期。
- 是否需要每次批准。
- 是否允许委托及明确的下游组织。

“始终允许”只创建与当前能力、提供者、输入类型和范围匹配的 Grant，不创建整台设备的任意
访问权。

### 8.3 转委托

默认 `delegation=none`。允许委托时，任务授权中必须冻结完整执行链和最大跳数。任一新组织、
新能力或新数据接收方加入执行链，都需要重新计算授权，不能沿用原任务令牌。

## 9. 任务协议

### 9.1 任务快照

创建任务时冻结：

- 调用方用户、设备和组织。
- 能力 ID、版本和提供者。
- 输入 schema 版本、数据类型、数据分类和字节数。
- 路由：局域网直连、网关直连、网关中继或联邦路径。
- 授权决定、批准记录和策略版本。
- 委托链、预算、期限和幂等键。

设置或策略后续变化不追改已接受任务；紧急撤销可以阻止尚未开始的任务，并按策略取消活动
任务。

### 9.2 状态

```text
created -> awaiting_approval -> queued -> connecting -> running
running -> completed | failed | cancelled | outcome_unknown
created/awaiting_approval/queued/connecting -> rejected | expired | cancelled
```

- `completed` 只在提供者提交完整终态且调用方确认接收后成立。
- 网络中断后无法确认副作用结果时使用 `outcome_unknown`，不得自动重放。
- 重试创建新 attempt，并复用仅在能力声明支持时才有效的幂等键。
- 用户取消必须传播到实际提供者；未确认取消时不能声称任务已停止。

### 9.3 数据传输

- 小型 JSON 输入使用任务通道传输。
- 文件使用内容 SHA-256、声明大小和一次性任务对象令牌传输。
- 接收端边读边校验大小和摘要，拒绝路径、符号链接和调用方文件名决定的落盘位置。
- 任务正文、文件和输出不进入普通网关审计日志。
- 中继模式下是否端到端加密由策略快照明确记录；界面必须显示网关能否读取正文。

## 10. 能力包与更新

每个 Package 必须提供不可变版本、目标平台和架构、内容大小、SHA-256、发布者签名、权限
声明、依赖和兼容范围。安装流程统一为：

```text
取得签名目录 -> 选择不可变目标 -> 下载暂存 -> 校验大小/摘要/签名
-> 展示权限差异 -> 批准 -> 安装到 GoodBuddy-owned 目录 -> 验证 -> 启用
```

要求：

- 下载开始后冻结来源，不在失败时静默切换 ShareServer 或镜像。
- 包不得包含凭据；配置只携带非敏感结构和密钥引用。
- 新版本扩大文件、进程、网络、数据或委托权限时，旧 Grant 不自动继承。
- 紧急撤销阻止新安装和新调用；已安装包的停用或删除遵循组织策略并向用户说明。
- 复用现有 GoodBuddy 签名工件原则，但不同用途使用独立签名域。

## 11. 协议分层

### 11.1 局域网发现层

- DNS-SD 服务类型：`_goodbuddy-share._tcp.local`。
- 广播仅包含协议 major、随机实例 ID、端口和配对状态。
- 设备名称、证书和详细版本通过临时加密握手取得。
- 不扫描任意端口，不枚举未主动广播的机器。

### 11.2 ShareServer 控制 API

使用 HTTPS 提供登录、设备注册、目录、管理和审计 API；使用 WebSocket 建立设备出站控制
通道，承载心跳、任务声明、取消和短期数据通道协商。普通管理 API 与设备通道使用不同凭据
和受众。

### 11.3 数据通道

数据通道可以是配对 TLS 直连、ShareServer WebSocket 中继或经网关协商的端到端加密流。
协议只保证有界帧、顺序、取消和终态，不自行实现另一套拥塞控制。

### 11.4 版本协商

- 每层独立声明 `major.minor`。
- major 不同拒绝连接；minor 使用双方共同支持的最低能力集合。
- 未识别字段在声明允许扩展的位置忽略，安全与授权枚举中的未知值一律拒绝。
- 联邦只交换双方共同支持的能力和策略表达式，不降低任一方策略。

## 12. 数据与审计

### 12.1 最小审计事件

- 操作者、调用设备和组织。
- 动作、能力、版本和提供者。
- 路由与是否跨组织。
- 输入数据类别、分类、文件数和字节数。
- 授权结果、策略 ID 和批准者。
- 任务状态、耗时、输出大小和资源用量。
- 包下载、安装、更新、撤销和发布变更。

默认不保存提示正文、文件内容、模型输出、密钥、Cookie、认证头或完整私有路径。需要内容
审计的组织必须单独定义保留期限和访问角色，并在调用前向用户显示。

### 12.2 数据权威

- 桌面端是本地配对、本机共享偏好和本地活动记录的权威。
- ShareServer 是组织成员、设备注册、组织策略、发布目录和组织审计的权威。
- 能力提供者是运行中任务及结果是否产生的权威。
- 联邦两端各自保存本组织审计，不复制对方完整成员目录或内部策略。

## 13. 安全边界

ShareServer 可以部署到公网，因此公网连接、外部组织和服务端多租户是本设计中的实际信任
边界。共同要求如下：

1. 所有远端清单、名称、schema、错误、文件和模型输出都作为不可信数据处理。
2. Renderer 不接触设备私钥、网关令牌、任意 socket 或原始文件传输接口。
3. Main/Provider 在执行边界重新验证任务，不信任 Renderer 或 ShareServer 代替本机授权。
4. ShareServer 按组织隔离查询，搜索和计数接口不能泄露无权查看的设备或能力。
5. 设备只建立主动配置的网关出站连接，不接受 ShareServer 发起任意系统调用。
6. 局域网发现不等于信任，组织成员身份也不等于所有能力授权。
7. 远程能力不能扩大本机 Ask/Execute、Workspace、Runtime、Skill 或 MCP 现有权限。
8. 密钥只进入对应安全存储，诊断和审计使用固定字段与脱敏错误码。
9. 限制握手、清单、帧、文件、并发、速率、任务时长和审计查询大小。
10. 撤销设备、用户、Grant、Publication、Package 或 FederationTrust 后停止签发新令牌。

## 14. 建议领域实体

```text
DeviceIdentity
PeerPairing
GatewayConnection
Organization
Membership
Group
RegisteredDevice
Capability
CapabilityVersion
Publication
Grant
Policy
Approval
Task
TaskAttempt
ArtifactTransfer
Package
PackageRelease
FederationTrust
AuditEvent
Revocation
```

共享协议只定义跨端 DTO 和状态，不规定桌面 SQLite 与 ShareServer 数据库使用相同表结构。

## 15. 仓库边界

目标目录结构：

```text
docs/
  architecture/share-network-architecture.md
  features/device-sharing/
  features/share-server/
packages/
  share-protocol/        # 与 Electron、数据库和 Web 框架无关的 schema/类型
shareserver/             # 独立 Web 服务及管理前端
src/                     # GoodBuddy Desktop
```

当前文档先固定边界，不创建空服务脚手架。实现时 `shareserver` 不反向依赖桌面端 `src/shared`；
双方依赖独立 `share-protocol`。协议包不得包含数据库模型、Electron API、服务实现或凭据。

## 16. 共同验收标准

- [ ] 不配置 ShareServer 时，两台桌面端可通过局域网发现、双端配对、查看获准能力并调用。
- [ ] 关闭“允许被发现”不会关闭主动发现；关闭主动发现不会撤销既有配对。
- [ ] 本机没有明确 Publication 时，任何 Peer 或组织成员都不能查看或调用本机能力。
- [ ] 桌面端可以连接多个 ShareServer，任一连接故障不影响局域网和其他连接。
- [ ] ShareServer 只展示当前用户、设备和组织获准查看的目录。
- [ ] 每次远程调用都能说明提供者、执行位置、发送数据、路由、授权依据和委托链。
- [ ] 网络中断且副作用结果不确定时进入 `outcome_unknown`，不会自动重放。
- [ ] 能力包经大小、SHA-256、签名、兼容和权限差异校验后才能安装。
- [ ] 跨组织调用同时满足两端策略；联邦撤销后不能创建新任务。
- [ ] 审计默认只保存必要元数据，不保存正文、文件、密钥或认证信息。
- [ ] ShareServer 可独立部署和升级，不由 Electron 启动，也不影响桌面端离线使用。

## 17. 相关设计

- [设备发现与共享 PRD](../features/device-sharing/prd.md)
- [设备发现与共享功能逻辑](../features/device-sharing/logic-design.md)
- [设备发现与共享 UI](../features/device-sharing/ui-design.md)
- [设备发现与共享技术设计](../features/device-sharing/technical-design.md)
- [ShareServer PRD](../features/share-server/prd.md)
- [ShareServer 功能逻辑](../features/share-server/logic-design.md)
- [ShareServer 管理界面](../features/share-server/ui-design.md)
- [ShareServer 技术设计](../features/share-server/technical-design.md)
- [SSH 远程主机与 Agent](../features/remote-host/README.md)
- [GoodBuddy 统一界面设计系统](../../UI-DESIGN.md)
