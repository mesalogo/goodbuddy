# 设备发现与共享技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中 |
| 版本 | 0.1 |
| 日期 | 2026-09-03 |
| 关联 PRD | [设备发现与共享 PRD](./prd.md) |
| 功能逻辑 | [功能逻辑设计](./logic-design.md) |
| 共享协议 | [共享网络总体设计](../../architecture/share-network-architecture.md) |

## 1. 进程边界

```text
Renderer
  -> 窄 Preload API
Main
  -> DeviceSharingService
       -> LanDiscoveryService
       -> PeerPairingService
       -> GatewayConnectionService
       -> CapabilityCatalogService
       -> CapabilityPublicationService
       -> RemoteTaskService
       -> PackageAcquisitionService
       -> SharingAuditStore
  -> 既有 Capability / Runtime / Skill / MCP 服务
```

Renderer 只取得脱敏快照和调用显式动作。设备私钥、Peer 证书、网关凭据、网络 socket、原始
任务令牌、任意文件读取和包缓存路径只存在于 Main。

## 2. 模块职责

| 模块 | 职责 |
| --- | --- |
| `LanDiscoveryService` | mDNS browse/advertise、手动地址握手、接口变化 |
| `PeerPairingService` | 临时握手、验证码、双端确认、配对凭据与撤销 |
| `GatewayConnectionService` | 浏览器登录、设备注册、WebSocket、重连和策略同步 |
| `CapabilityCatalogService` | 合并本机、Peer 和网关目录，保留来源身份 |
| `CapabilityPublicationService` | 校验本机可共享能力并向目标范围发布 |
| `RemoteTaskService` | 授权、确认、provider 冻结、传输、取消和终态 |
| `PackageAcquisitionService` | 固定来源下载、校验、安装协调和权限差异 |
| `SharingAuditStore` | 本机有界审计查询、筛选和清理 |

目录合并只生成 UI 视图，不能把不同 provider 的授权、版本和执行位置压成一个身份。

## 3. 共享契约

实现前建立独立 `packages/share-protocol`。Desktop 只从该包导入 Zod schema 和 TypeScript
类型。协议输入在网络边界和 IPC 边界分别验证，不能因已经过网络校验而跳过 Renderer 输入
校验。

建议导出：

```text
DeviceSummary
PairingChallenge
GatewayDescriptor
CapabilityManifest
Publication
GrantConstraint
AuthorizationDecision
RemoteTaskSnapshot
RemoteTaskEvent
PackageDescriptor
AuditEventSummary
ProtocolError
```

错误只向 Renderer 返回稳定 code、可本地化参数和可恢复动作，不转发远端堆栈、响应正文或
内部地址。

## 4. 持久化

建议在现有 Desktop SQLite 中增加：

```text
device_identity_metadata
peer_pairings
gateway_connections
capability_publications
local_grants
remote_tasks
sharing_audit_events
installed_shared_packages
```

- 私钥和 refresh credential 存系统安全存储；SQLite 只存引用和脱敏元数据。
- 附近广播、在线状态、配对验证码、短期任务令牌和目录候选只存在于内存。
- 网关能力目录可有界缓存，用于离线说明，不作为离线调用授权。
- 审计正文不落库，字段和保留上限在实现前固定。
- 数据库迁移只覆盖已发布 schema；未发布设计不预建兼容读取器。

## 5. 局域网网络实现

- 使用系统支持的 mDNS/DNS-SD 库 browse `_goodbuddy-share._tcp.local`。
- 广播绑定用户允许的网络接口；接口切换时重建监听，不保留旧地址为身份。
- 服务端口由 Main 持有，使用设备证书建立 TLS。
- 未配对握手仅暴露配对所需字段，并限制并发、频率、消息大小和有效时间。
- 手动地址只替代发现，不替代证书指纹与双端确认。
- 停止广播时关闭未完成配对监听；已配对活动连接按任务生命周期处理。

## 6. 网关连接

1. Main 校验 HTTPS URL，并取得服务公开描述。
2. 生成带 PKCE、随机 state 和设备挑战的系统浏览器登录请求。
3. 本机 loopback 或已注册应用链接只接收一次性回调 code。
4. Main 交换设备凭据，展示组织身份，用户确认后持久化。
5. Main 建立带设备身份的 WebSocket 出站连接。
6. 心跳更新在线状态；断线按有界指数退避重连。

服务器返回的跳转 URL 必须符合已取得服务描述和 HTTPS 限制。Renderer 不能提交认证头、设备
证书、WebSocket URL 或任意回调地址。

## 7. 本机能力适配

不是所有现有 Capability 都自动可共享。每种可共享类型需要显式 adapter：

```ts
interface ShareableCapabilityAdapter {
  describe(): CapabilityManifest
  validatePublication(input: PublicationDraft): ValidationResult
  invoke(input: unknown, context: ProviderTaskContext): AsyncIterable<TaskEvent>
  cancel(taskId: string): Promise<CancelResult>
}
```

adapter 负责把共享输入映射到既有生产服务，并保留原权限边界。首批类型在实现前根据真实
产品需求确定；未有 adapter 的 Skill、MCP、知识库和 Runtime 不出现在共享列表。

## 8. 远端调用生命周期

```text
Renderer 选择能力和输入
-> Main 解析候选并取得当前授权
-> 必要时返回确认描述
-> 用户批准
-> Main 冻结 task/provider/route/policy
-> 建立数据通道并流式发送
-> Provider 再校验并接受
-> Main 转发有界进度和结果
-> 终态与审计事务保存
```

每次任务使用稳定 `taskId` 和 attempt ID。Provider 未接受前的连接失败可以明确失败；已接受
后的断线先查询同一任务，不新建 attempt。无法恢复权威终态时保存 `outcome_unknown`。

附件从 Main 已授权的用户选择结果读取，按声明大小流式发送，不把任意本机路径交给远端。
接收成果先写 GoodBuddy-owned 暂存并校验，再通过现有 Artifact 边界进入产品。

## 9. IPC

Preload 只暴露按产品动作命名的方法，例如：

```text
sharing.getSnapshot
sharing.updateLanSettings
sharing.startPairing / confirmPairing / cancelPairing
sharing.revokePeer
sharing.addGateway / completeGatewayLogin / removeGateway
sharing.listCapabilities
sharing.savePublication / pausePublication / deletePublication
sharing.prepareInvocation / confirmInvocation / cancelTask
sharing.listAuditEvents / getAuditEvent
```

所有变更方法校验 trusted sender、严格 schema、对象当前 revision 和归属关系。不得暴露通用
HTTP、WebSocket、mDNS、证书、文件传输或数据库查询 IPC。

## 10. 生命周期与资源边界

- 应用启动按保存设置启动主动发现；不因保存了网关而阻塞窗口创建。
- 广播只有在用户开启后启动。
- 网关连接在后台恢复，认证过期只影响对应连接。
- 应用退出停止接收新任务，取消未接受任务，并有界通知活动 Provider 后关闭连接。
- 单个 Peer/网关/任务设置连接数、帧、字节、并发和重连上限。
- 大文件全程流式处理，不进入单个 Main `Buffer` 或 Renderer state。

## 11. 与现有模块集成

- `capability-service` 提供本机能力事实；共享 adapter 明确选择可公开子集。
- 已安装共享 Skill/MCP 继续使用现有配置、启停和 Runtime 分配，不建立第二套执行器。
- SSH Host 保持独立；除非未来提供专门 adapter 和用户发布，否则不进入目录。
- 远端 Task 的公开活动复用现有工具/任务展示语义，但保留 provider 和 route 字段。
- 应用更新源、模型下载源、Agent 下载源和工具下载源不因添加 ShareServer 自动改变。

## 12. 验证策略

### 12.1 自动化

- schema 边界、未知枚举和协议版本协商。
- 三个独立开关及默认值。
- mDNS 去重、接口变化、广播停止和手动地址。
- 配对双方确认、拒绝、超时、身份变化和撤销。
- 多网关隔离、认证过期、重连和移除。
- provider 排序、冻结、授权变化和失败不切换。
- 调用确认最小输入、附件上限、取消和结果未知。
- Publication 校验、暂停、撤销和 adapter 消失。
- 包签名、权限差异、来源冻结和失败保留旧安装。
- IPC sender、revision、归属和无通用网络/文件接口。

### 12.2 真实环境

- Windows、macOS、Linux 至少两种组合完成同网段发现和配对。
- mDNS 可用、被防火墙阻断、网络接口切换和设备离线场景。
- 真实 ShareServer 登录、设备出站连接、目录、调用和认证过期。
- 小型 JSON、文件流、取消、Provider 进程失败和网络中断。
- 确认日志、Renderer、诊断和审计中没有凭据或文件正文。

设计文档完成不代表功能实施或上述验证通过。
