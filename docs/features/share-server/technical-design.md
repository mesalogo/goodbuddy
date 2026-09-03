# ShareServer 技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中 |
| 版本 | 0.1 |
| 日期 | 2026-09-03 |
| 关联 PRD | [ShareServer PRD](./prd.md) |
| 功能逻辑 | [功能逻辑设计](./logic-design.md) |
| 共享协议 | [共享网络总体设计](../../architecture/share-network-architecture.md) |

## 1. 仓库与运行边界

实现时在仓库顶层创建独立项目：

```text
shareserver/
  README.md
  package.json
  src/
    api/
    auth/
    organizations/
    devices/
    capabilities/
    policies/
    approvals/
    tasks/
    relay/
    packages/
    federation/
    audit/
  web/
  migrations/
  deploy/
  tests/
```

当前只提交设计文档，不创建无法运行的目录占位。服务端和 Desktop 共同依赖未来的
`packages/share-protocol`，ShareServer 不导入 Electron 的 `src/shared`。

## 2. 技术选型约束

- 使用与仓库一致的 TypeScript/Node.js 工具链，具体 HTTP 框架在实现前根据维护性选择。
- PostgreSQL 是组织、策略、任务元数据和审计的权威数据库。
- Package 与可选中继暂存使用 S3 兼容对象存储；不开启对应功能时不要求对象存储。
- Web 控制台与 API 同源部署，采用严格 CSP，不在浏览器保存设备凭据。
- 单实例部署可完整工作；水平扩展时再引入共享事件/连接路由组件，不为未验证规模预设复杂
  分布式协议。

## 3. 服务模块

| 模块 | 职责 |
| --- | --- |
| `auth` | 本地身份、OIDC、Web session、服务和设备凭据 |
| `organizations` | 组织、成员、组、角色和范围解析 |
| `devices` | 注册挑战、设备记录、出站连接和在线状态 |
| `capabilities` | manifest、provider、Publication 和目录投影 |
| `policies` | Grant、强制策略和确定性授权计算 |
| `approvals` | 内容绑定申请、决定、过期和通知 |
| `tasks` | task/attempt、provider 路由、状态和取消 |
| `relay` | 可选有界数据中继，不解释能力正文 |
| `packages` | 不可变对象、签名目录、通道和撤销 |
| `federation` | 网关身份、offer、双边策略和跨组织映射 |
| `audit` | 事务内审计写入、查询、保留和导出 |

模块通过服务接口调用，API handler 不直接拼接跨组织 SQL 或自行计算权限。

## 4. API 边界

建议分为四类 audience：

```text
/api/v1/web/*         管理控制台与成员自助 API
/api/v1/device/*      设备注册、目录和任务控制 API
/api/v1/federation/*  ShareServer 间 API
/api/v1/public/*      服务描述、健康与登录入口
```

设备使用 WebSocket `/api/v1/device/connect` 建立出站控制通道。包下载使用短期、绑定主体和对象
摘要的 URL。联邦 API 使用网关身份，不接受普通用户 session。每类 token 使用不同 issuer/
audience/scope，不能互换。

所有请求经 schema、认证、organization scope、授权、速率和大小边界。列表使用游标分页和固定
最大页；错误返回 request ID、稳定 code 和有界参数。

## 5. 数据模型

核心表建议为：

```text
instances
identity_providers
users
organizations
memberships
groups
group_members
role_bindings
registered_devices
device_credentials
device_connections
capabilities
capability_versions
providers
publications
grants
policies
approval_requests
approval_decisions
tasks
task_attempts
task_events
package_objects
package_releases
release_channels
update_policies
federation_trusts
federation_capability_exports
audit_events
revocations
```

要求：

- 所有组织数据表包含不可为空的 `organization_id`，并由 repository 层强制作用域。
- 唯一约束同时包含 organization，避免跨组织名称冲突泄漏。
- 密钥保存为单向摘要或经外部主密钥加密的密文；数据库不保存明文 token。
- 在线连接和短期 nonce 主要在内存；表中只保存恢复所需元数据，不把 socket 当持久对象。
- task event 只存控制状态和有界统计；正文流不进入普通关系表。

## 6. 事务与一致性

- 业务变更与对应审计事件在同一 PostgreSQL 事务提交。
- Publication/Grant/Policy 使用 revision 做乐观并发，Web 草稿不能覆盖他人更新。
- 授权决定创建 task 时再次读取当前 revision，并将命中策略摘要冻结到 task。
- 设备在线状态允许短暂最终一致；身份、撤销、授权和任务接受必须走权威存储。
- 重复注册挑战、联邦 offer 和 task create 使用唯一幂等键。
- 无法确认 provider 副作用时只更新 `outcome_unknown`，不靠消息队列自动重放。

## 7. 设备连接与任务

连接建立后完成设备 credential、organization、客户端协议和当前 registration 校验。服务端为
每个连接设置心跳、空闲、帧、发送队列和并发上限。

任务流程：

```text
authorize -> create task -> resolve exact provider connection
-> send declaration -> provider accepts/rejects
-> establish direct or relay route -> stream progress
-> provider terminal result -> caller delivery -> audit terminal state
```

同一设备重复连接时使用 connection generation；新连接接管未来任务，旧连接仍只允许完成或
查询已归属 task，随后有界关闭。不能把新任务随机发到身份相同但 generation 过期的 socket。

## 8. 中继

中继是可选模块：

- 控制面与中继可部署在不同进程，但共享 task 授权验证。
- 每个 relay ticket 绑定 task、调用方、provider、方向、期限和最大字节。
- 实现背压和全局/组织/设备并发及带宽上限。
- 不解析能力正文，不写普通日志；需要临时落盘时使用加密 GoodBuddy-owned 暂存并按 task 清理。
- 中继关闭、过载或策略禁止时返回准确路由错误，不静默转到其他节点。

## 9. Package 存储

上传先进入不可公开暂存：流式计算大小和 SHA-256，验证签名、manifest、版本、平台和权限后，
以 digest 发布为不可变对象。相同 digest 可去重，但组织授权和 Release 分别保存。

Release catalog 使用独立签名域。服务器不能重打包已签名 payload；镜像目标必须保持相同字节、
大小和 SHA-256。撤销更新目录和授权，不覆盖或原地删除仍受审计保留的对象。

## 10. 联邦协议

- 每个实例生成网关身份和可轮换证书，私钥不进入数据库备份明文。
- offer 包含双方可人工核对的组织名、端点、指纹、协议和 nonce。
- 双方确认后交换有界 capability projection 和本地映射 ID。
- 跨组织 task 带双方关联 ID 和短期签名声明；每端独立授权并各写审计。
- 不接受调用方提供的任意回调 URL、第三方 hop 或内部主体 ID。
- 证书轮换需要旧身份签名或双方重新确认；身份突变直接暂停关系。

## 11. Web 安全

- 使用 HttpOnly、Secure、SameSite cookie 和 CSRF 防护管理 Web session。
- OIDC 使用 state、nonce、PKCE 和固定回调地址。
- 富文本字段按纯文本显示；manifest/schema 使用安全代码查看器，不执行 HTML。
- 权限隐藏仅改善界面，所有 API 在服务端重新校验。
- 登录、设备注册、目录、审批、导出和联邦接口分别限速。
- 密钥字段只能替换、轮换和测试，永不回显。

## 12. 部署与配置

最小生产部署：

```text
TLS reverse proxy/load balancer
ShareServer API + Web
PostgreSQL
可选：S3 compatible object storage
可选：Relay worker
```

部署配置通过环境变量或挂载文件提供数据库、主密钥、公开 URL、OIDC、邮件、对象存储和限制。
普通 Web 管理员不能修改基础设施秘密。提供数据库迁移命令、不可变镜像、非 root 容器、健康
与就绪端点、优雅停止和部署示例。

## 13. 可观测性与备份

- 结构化日志只包含 request/task/organization 关联 ID、稳定事件和错误码。
- 指标覆盖请求、WebSocket、授权结果、任务状态、中继、Package 和联邦，不包含能力正文。
- tracing 跨内部服务传播关联 ID，跨联邦只传播双方同意的关联标识。
- 备份 PostgreSQL、Package 对象和网关身份；不备份缓存、Web session、nonce 或中继暂存。
- 恢复后撤销列表、组织 ID、签名目录和审计序列保持有效，所有设备重新连接。

## 14. 测试策略

### 14.1 自动化

- schema、认证 audience、CSRF、OIDC 和设备挑战。
- 每个 repository/API 的跨组织隔离与枚举防护。
- 拒绝优先授权、审批内容绑定、预算和并发。
- device generation、离线、撤销、重连和 provider 冻结。
- task 幂等、取消、结果未知和不自动重放。
- Package 流式校验、不可变性、权限 diff 和撤销。
- 联邦双方确认、策略交集、暂停、证书变化和禁止第三 hop。
- 审计事务、过滤、分页、导出和正文缺失。

### 14.2 集成与部署

- Desktop 与真实 ShareServer 完成注册、目录、调用、文件和取消。
- 两个隔离组织验证搜索、计数、错误、对象和审计不泄漏。
- 两个 ShareServer 完成联邦建立、跨组织调用和单方撤销。
- 中继关闭与开启、容量耗尽、连接中断和大文件背压。
- 数据库备份恢复、版本升级、滚动停止和设备重连。
- 生产 TLS、OIDC 和对象存储组合的端到端验证。

设计完成不代表服务已实现；只有独立部署和真实 Desktop 端到端路径通过后才能更新实施状态。
