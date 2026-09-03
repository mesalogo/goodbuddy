# ShareServer 功能逻辑设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 设计中 |
| 版本 | 0.1 |
| 日期 | 2026-09-03 |
| 关联 PRD | [ShareServer PRD](./prd.md) |
| 共享规则 | [共享网络总体设计](../../architecture/share-network-architecture.md) |

## 1. 核心不变量

### INV-1 组织隔离先于角色

任何查询和变更先绑定 organization，再计算角色。系统管理员的跨组织操作使用独立系统管理
入口并形成审计，不能依靠省略 organization 条件获得全局数据。

### INV-2 注册不等于发布

设备注册只建立身份和连接资格。没有有效 Publication 时，目录中没有该设备能力。

### INV-3 目录不等于授权

看到能力不能推导可调用或可下载。创建任务和下载包时重新计算当前授权。

### INV-4 服务端授权不能扩大端点授权

ShareServer 的 `allow` 只是签发任务资格。Provider 和调用方仍执行各自本地策略；任一端拒绝
即终止动作。

### INV-5 策略拒绝优先

同一动作命中多个规则时使用 `deny > require_approval > allow`。没有匹配 allow 时默认 deny。

### INV-6 联邦为双边交集

单方创建或接受的关系不生效。双方 active 且两端发布、Grant 和数据策略均允许时才能跨组织
创建任务。

### INV-7 任务提供者不可改写

ShareServer 只路由调用方冻结的 provider，不在离线、繁忙或失败时替换节点。

### INV-8 不恢复短期权威

备份恢复不恢复 Web 会话、设备 socket、一次性挑战、审批 nonce 或任务数据通道。终端必须
重新连接并证明身份。

### INV-9 初始化入口一次性关闭

初始化只在实例尚无系统管理员时可用。首个系统管理员创建成功后，后续请求即使持有旧的
一次性引导材料也不能再次进入初始化流程。

## 2. 主要状态

### 2.1 成员

```text
invited -> active -> suspended -> active
invited -> expired | revoked
active/suspended -> removed
```

`suspended` 不能登录或创建新任务；历史归属保留。`removed` 不级联删除审计和已完成任务。

### 2.2 注册设备

```text
pending -> active <-> offline
pending -> expired | rejected
active/offline -> revoked
```

客户端心跳只决定 `active/offline`，不能清除 `revoked`。重新注册生成新设备 registration。

### 2.3 Publication

```text
draft -> pending_approval -> active
draft/pending_approval -> rejected
active <-> paused
active/paused -> revoked
```

provider 离线不会把 Publication 变为 paused；目录同时展示“已发布”和“当前离线”两个事实。

### 2.4 审批

```text
pending -> approved | rejected | cancelled | expired
```

审批对象内容摘要、申请主体或策略版本变化后，原审批不能复用。approved 只产生其声明范围内
的 Grant 或一次性决定。

### 2.5 Package Release

```text
draft -> verifying -> available -> paused -> available
verifying -> invalid
available/paused -> revoked
```

发布后的版本和字节不可变。修复内容必须使用新版本；revoked 不删除审计证据和对象摘要。

### 2.6 FederationTrust

```text
draft -> offered -> mutually_confirmed -> active
offered -> rejected | expired
active <-> paused
任意非终态 -> revoked
```

`mutually_confirmed` 只表示身份确认完成；双方策略同步成功后才进入 active。

## 3. 授权计算顺序

1. 验证请求身份、会话 audience 和 organization。
2. 验证用户、设备、provider、Publication 和 FederationTrust 当前状态。
3. 校验能力版本、动作、输入 schema、数据类别、大小和委托链。
4. 收集调用方组织、提供方组织、Publication 和 Grant 规则。
5. 按拒绝优先合并，计算 `deny/require_approval/allow`。
6. 校验次数、并发、预算和有效期。
7. 返回决定、稳定原因和策略引用；需要批准时建立内容绑定申请。
8. 创建任务时再次计算，并把决定快照写入任务。

目录查询可以预计算“可能可用”，但不能替代第 1 至 8 步。

## 4. 组织角色边界

| 动作 | 系统管理员 | 组织管理员 | 发布者 | 审批人 | 审计员 | 成员 |
| --- | --- | --- | --- | --- | --- | --- |
| 实例设置 | 是 | 否 | 否 | 否 | 只读有限项 | 否 |
| 成员与组 | 紧急管理 | 是 | 否 | 否 | 只读 | 自己 |
| 注册设备 | 只读/撤销 | 是 | 自己 | 否 | 只读 | 自己 |
| 发布能力/包 | 否 | 是 | 授权范围 | 否 | 只读 | 否 |
| 编辑策略 | 否 | 是 | 否 | 否 | 只读 | 否 |
| 处理审批 | 否 | 可配置 | 否 | 授权范围 | 只读 | 自己的申请 |
| 联邦关系 | 实例级许可 | 是 | 否 | 可共同审批 | 只读 | 否 |
| 审计导出 | 实例级 | 组织级 | 自己相关 | 自己相关 | 授权范围 | 自己相关 |

实际权限仍由策略计算，表格定义产品默认职责而非硬编码角色名称。

## 5. 任务路由决策

| 条件 | 结果 |
| --- | --- |
| provider 在线且双方可直连 | 签发短期直连协商信息 |
| 无法直连且双方策略允许中继 | 建立有界中继通道 |
| 中继关闭或任一方禁止 | 创建失败，说明无可用路由 |
| provider 离线 | 不排队到无限期，按能力配置有界等待或拒绝 |
| provider 接受后连接中断 | 保留 task，等待同一 provider 恢复/查询 |
| provider 终态未知且恢复期结束 | `outcome_unknown` |
| 调用方取消 | 转发取消；provider 确认后终态 cancelled |

中继容量不足只产生排队或资源错误，不切换 provider，不改变是否允许中继。

## 6. 更新策略优先级

```text
紧急撤销
> 组织强制固定版本/禁止版本
> 设备组发布通道
> 用户允许的版本范围
> 当前已安装版本
```

任何权限扩大都从自动路径转为 `require_approval`。降级只有在目标版本仍被签名目录允许且
策略明确指定时才提供，不自动视为故障回滚。

## 7. 联邦可见性

联邦目录只导出对方明确允许的能力投影：组织显示名、能力、版本范围、数据政策和可用性摘要。
不导出内部设备名、成员清单、组结构、节点地址、内部策略全文或审计记录。跨组织请求使用
双方关联 ID，双方各自解析本地主体。

## 8. 删除、撤销与保留

- 删除组织前必须停止新任务、撤销联邦和设备，并按保留策略归档审计；不提供无提示级联。
- 删除用户不删除其历史动作，审计显示不可变主体摘要。
- 撤销设备、Publication、Grant、Package 或联邦后立即阻止新令牌。
- 对象存储中的未完成任务正文按任务期限清理；审计元数据按组织保留策略清理。
- 法定保留只锁定匹配审计事件，不使被撤销身份重新可用。

## 9. 需求追踪

| 需求 | 主要逻辑 |
| --- | --- |
| `FR-1` | `INV-1`、`INV-9` 和系统管理员角色边界 |
| `FR-2` | 组织隔离不变量、成员状态和角色边界 |
| `FR-3` | 注册不等于发布、设备状态和短期权威恢复规则 |
| `FR-4` | 注册、Publication、目录与授权不变量 |
| `FR-5` | 拒绝优先不变量和授权计算顺序 |
| `FR-6` | 审批状态、内容绑定和授权重算 |
| `FR-7` | provider 冻结不变量和任务路由决策 |
| `FR-8` | Package Release 状态和更新策略优先级 |
| `FR-9` | 联邦双边交集、FederationTrust 状态和联邦可见性 |
| `FR-10` | 组织隔离、删除撤销与保留规则 |
| `FR-11` | 组织角色边界及各对象状态；展示行为由 UI 设计定义 |
| `FR-12` | 短期权威恢复规则和逻辑完整性；部署结构由技术设计定义 |

## 10. 逻辑完整性

本设计覆盖实例、组织、成员、设备、发布、授权、审批、任务、更新、联邦、撤销和恢复。实现
前仍需确定首个 OIDC 提供者矩阵、默认审计保留期、部署规模目标和中继带宽上限；这些部署
参数应可配置，不改变拒绝优先、双边联邦和 provider 冻结规则。
