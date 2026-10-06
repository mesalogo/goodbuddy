# Agent 功能维护约束

本文面向在 GoodBuddy 中新增功能的 Agent。它只记录做决定时必须遵守的维护规则，
不替代架构设计、性能规范或功能文档。若本文与代码或权威文档不一致，以已验证的生产
代码和下列权威文档为准，并修正文档链接或内容：

- [桌面存储与并发执行](../architecture/desktop-storage-direction.md)：职责边界、存储所有权和操作边界。
- [桌面存储基础集成](../architecture/desktop-storage-foundation.md)：`DesktopStorageClient`、domain operation 和生命周期。
- [桌面 Runtime 存储集成](../architecture/desktop-storage-runtime-integration.md)：binding、model-call ledger 和关闭顺序。
- [性能原则](../architecture/performance-principles.md)：唯一的性能数值、并发规则和评审清单。
- [桌面并发架构验收](../quality/concurrent-desktop-acceptance.md)：真实生产路径、负载和证据要求。
- [运行时存储与后台读取](../architecture/runtime-storage.md)：输出正文、预览、临时资源和当前迁移状态。
- [数据库迁移与大数据升级指南](./database-migrations.md)：已发布用户数据的迁移边界。
- [AGENTS.md](../../AGENTS.md)：临时文件、真实 Host 验证、测试和文档维护规则。

## 决策检查

开始编码前，逐项回答下面的问题。任一项没有答案时，先补充设计或查找现有机制，
不要直接增加新的 owner、队列、缓存或恢复记录。

- 数据的唯一权威来源和写入 owner 是什么？它是否已经存在？
- 该功能是否需要数据库事务、跨表快照、文件引用或运行时 ledger？若需要，操作是否落在对应 owner 内？
- Main 是否只负责 IPC 校验、凭据、生命周期和调度？是否把 SQL、大文件读写、哈希或模型工作留在了 Main？
- 新操作能否使用现有 domain port 和显式 allowlist？是否误把 SQL、回调、实例、函数或 handle 放进跨进程 DTO？
- 依赖链是否按“先提交，再通知、ACK、读取或返回成功”的顺序实现？提交未确认时是否禁止盲目重放？
- 排队取消、在途取消、执行结算和资源释放分别是什么时刻？容量是否一直占用到实际结算或确认的 Host 退出？
- 输出是预览还是完整正文？完整正文是否只有一个所属存储，引用是否随历史、分支和重启继续有效？
- 是否创建了临时文件？创建者、使用者、删除条件、子进程退出确认和删除失败后的重试位置是否明确？
- 新的操作数、排队数、字节数、句柄数和缓存是否有界？是否复用了已有预算并避免无限缓冲？
- 测试是否覆盖真实 UI 到生产实现的路径、失败、取消、重试、关闭和迟到响应？是否需要真实数据、模型或 Host？
- 受影响的架构、功能、质量、构建或运维文档由谁维护？是否已有同一事实的权威定义，新增内容能否只链接它？

## 存储所有权

桌面业务 SQLite 由一个 storage utility process 持有。Main 通过
`DesktopStorageClient.call(domain, method, args, { signal })` 使用显式操作；
`src/main/desktop-storage-contracts.ts` 的 allowlist 是可调用面的边界。Main 不得再
打开同一业务数据库，也不得通过 helper、同步回退或隐藏的 repository 构造绕过 owner。
远程 Agent 的数据库仍由远程 Agent 持有，不能因桌面存储改造而迁移。

新增持久化时，优先扩展已有 domain repository 和 owner operation。完整事务、跨表快照、
去重、checkpoint 与发布规则留在 owner 内；模型、网络、解析和文件准备在事务外完成，
进入事务后只校验当前前提并提交完整结果。需要多个语句的读快照，应增加一个有名字的
owner/reader operation，不要在 Main 中拆成多次 `await`。

Main 侧服务只持有异步 port 和普通 DTO。live repository、数据库连接、事务 callback、
订阅、函数、AbortSignal 和运行时 handle 不跨 utility transport。`StorageData` 允许的
值以当前契约为准；新增类型先确认序列化、大小计算和错误传播，再加入 allowlist。

文件和输出也有 owner。附件引用、document result、paged output backing、Runtime
binding 和 native model-call ledger 应通过既有 storage facade 访问。文件所在目录不等于
可删除的临时目录；持久化引用、WAL/SHM、native history、用户导出文件和仍被分支引用的
正文都必须按 owner 释放。

## 增加领域操作

按以下顺序定位扩展点：

1. 找到已有 repository、port 或 facade，以及它实际打开的数据库和文件。
2. 在 owner 内保留原有事务和 ID、顺序、去重、耐久性语义，必要时抽出可复用的内部函数。
3. 为外部调用增加一个有明确名称的 domain operation，更新类型 allowlist 和 transport handler。
4. 在 Main 组合处注入已有 typed port；调用者等待 Promise，不保存第二份可写事实。
5. 为提交前、提交后响应前、取消、失败、重试、关闭和重启增加针对性断言。

操作应表达业务动作，例如 `appendRemoteTaskEventsBatch`、`publishDocument` 或
`transition`。不要暴露 `executeSql`、任意方法代理、通用对象代理或把 repository
整个返回给调用者。一个已有操作能表达需求时，扩展其参数或返回值并更新权威文档，
不要平行创建同义 operation。

通知不是提交确认。持久化成功后才能发送依赖该事实的 change notification、远程 ACK、
模型下一轮输入或成功响应；通知失败要按现有语义处理，不能把已提交事实伪装成未提交。

## Main 与 utility 的边界

Main 保留窗口、可信 sender 和 schema 校验、凭据解密、网络与 Runtime 编排、OS API、
请求归属和进程生命周期。utility storage 保留业务 SQLite、owner-local 事务、升级后
的读 worker 生命周期和必要的同步 SQL。Parser、OCR、embedding、模型请求和远程 Agent
继续使用各自宿主，不因“改成异步”而塞入 storage 事务。

Main 里的同步数据库调用、同步文件 IO 和可能超过 16 ms 的计算都要按性能原则处理。
Promise 返回本身不能证明工作已离开 Main。启动顺序是先完成 storage readiness，再发布
依赖它的服务；关闭顺序是先停止生产者并等待必要的持久化，再关闭 ledgers、bindings、
读 worker、数据库 owner 和 utility process。失败或未确认退出时保留可能仍被 child
持有的文件，并将错误传播给调用方。

## 异步顺序与取消

为每个操作写清四个时点：入队、开始执行、提交或执行结算、资源释放。最小必要范围内
保持顺序：同一会话事件按序提交，同一数据库事务按序落盘；不同项目、会话和子任务
不得共用长时间的全局等待。

取消规则如下：

- 排队中的请求在 dispatch 前检查 abort，取消后不得执行。
- 在途请求先向实际 owner 或 Host 发送取消，调用方可以先得到取消结果，但容量只能在执行结算或确认 Host 退出后释放。
- 同步 SQL 无法被 IPC 消息打断；安全批次之间检查取消，已经提交的事务必须报告为已提交。
- 取消一个请求不得杀掉仍被其他请求使用的共享 Runtime、utility process 或 Worker。
- 迟到结果必须携带已有项目、会话、任务或 operation 归属，先通过归属检查，再改变代次、缓存或队列。
- 存储进程替换前等待旧进程退出并结算旧请求；未确认写入按 domain identity reconciliation 处理，不能自动重放写入。

`AbortSignal` 是 transport option，不是业务 DTO 字段。不要用 UI 隐藏、组件卸载或清空
按钮代替服务层取消。控制和取消不得等待新的执行槽位。

## 输出引用与临时文件

短输出可以保留有界预览；超过预览上限的输出必须由所属 backing store 保存完整正文，
并在后续模型 `output_read`、历史和分支路径中复用同一 handle。分别核对模型收到的内容、
工具事件预览和历史正文，不能用最终回答代替工具全文，也不能把正文再次复制成临时全文。
输出 writer 的 append 必须被生产者等待；容量错误要显式传播，不能丢块或无限排队。

创建临时配置、插件、socket 或 launch 目录的函数承担创建失败清理。删除前关闭拥有
文件或目录的 child、ledger 和句柄，并确认 child 已退出；无法确认时保留材料和 owner
metadata，等待后续有界回收。应用临时文件使用仓库根目录 `temp/<task>/`，远程 Host
使用专用 `/root/tmp` 子目录。不要扫描或删除用户 Temp、未知归属目录或仅凭名称和年龄
判断为过期的资源。

持久化目录可以位于 `temp/` 下，位置本身不能授权删除。删除前先检查 attachment、
document result、history、branch 或其他 durable reference；释放一个调用引用不能删除
仍被历史引用的正文。旧数据清理沿用所属 owner，不增加全局 Temp sweep。

## 并发预算

数值只引用[性能原则](../architecture/performance-principles.md)，负载和证据只引用
[并发验收](../quality/concurrent-desktop-acceptance.md)。当前 storage client 的请求、
读写 pending 和 32 MiB admission budget 是实现约束；paged output 的 8 MiB capture、
每 writer 1,024 个 pending chunks、4,096 个 active/retained handles 和 64 KiB backing
write 也必须服从当前实现与测试。修改前先确认代码中的常量和适用范围，不在本文件复制
一套新数字。

容量应同时约束操作数和字节数。读 worker、写 owner、输出 backing、模型池和 UI 刷新各自
使用现有有限机制；队列满时等待或返回可恢复的 busy/capacity 错误。禁止静默丢事件、
无限重启、按项目预建服务、为每个调用新增 scheduler，或用串行夹具掩盖饱和。

## 测试与真实验证

单元测试用于确定字节边界、事务回滚、顺序、归属、取消竞态、失败清理和重试。行为改动
还必须覆盖生产组合：正常 UI action 经过 Preload、Main、storage/Runtime 宿主并产生
实际结果。mock bridge、独立 SQL、只测试握手或只测试 schema 都不能替代这条路径。

需要持久化时使用真实 SQLite owner 和隔离数据库；需要文件时使用真实异步文件；需要
Runtime 时使用本地确定性模型验证工具、事件、取消和关闭。不要把真实提供商网络速度
混入性能基准。需要模型能力证明时，配置检查不够，必须发起实际生成或工具请求，并
记录实际请求数和范围。

涉及桌面到 Agent 的 Runtime、安装、workspace、模型 bridge 或生命周期时，按
`AGENTS.md` 在共享 Linux x64 Host 使用当前源码验证。覆盖面应对应改动，包括断开、重连、
取消或重启；远程临时目录必须专用，验证后清理。未能连接 Host 时记录为验证阻塞，不能
用单测或旧发布包替代当前源码证据。

性能改动先取得基线，至少按权威验收矩阵记录 offered load、排队、吞吐、排空、资源高水位、
Main/Renderer 指标和样本条件。功能测试通过不等于并发预算通过；未测平台和缺失指标保留
为缺口。

## 文档与重复设计

代码行为改变后，检查受影响的架构、功能、质量、构建和运维文档，更新真正的 owner、
顺序、限制和验证证据。每项事实只保留一个权威定义：本文件写维护决策，架构文档写
职责与边界，性能原则写数值，验收文档写场景和证据，功能 README 或 progress 写功能
行为和状态。其他地方使用链接，不复制完整表格、状态机、预算或验收结果。

新增机制前先搜索同类名称、队列、owner、transport、shutdown 和测试。若现有机制只缺
一个操作、一个容量检查或一个清理分支，扩展它并补测试；只有现有 owner 无法表达真实
边界时才提出新设计，并在对应架构文档中记录问题、取舍和验证条件。未提交的实验代码、
测试夹具或接口存在，不等于生产路径已经接入。

## 允许与禁止的模式

| 允许 | 禁止 |
| --- | --- |
| 在已有 storage domain 增加命名 operation，并由 owner 完成事务 | 在 Main 新建同一 SQLite 的第二个连接、同步回退或隐藏 writer |
| 先在 Main 完成模型/解析，再把不可变 DTO 交给 owner 原子发布 | 在 SQLite 事务内 `await` 模型、网络、IPC 或文件回调 |
| `storage.call('assistant', 'appendRemoteTaskEventsBatch', [batch], { signal })`，提交后再 ACK | 暴露 `executeSql`、任意 repository proxy，或把 live repository/callback 放进 DTO |
| 使用同一 output handle 进行预览、分页、历史引用和 release | 每个工具结果写一个临时全文，再复制到 history 或用最终回答代替全文 |
| child 退出确认后删除创建者拥有的 launch material | 按目录前缀、年龄或路径位置删除未知归属的用户文件 |
| 取消在途请求并等待 settlement，再归还容量 | 调用方停止等待后立即释放槽位，或取消一个请求时杀共享宿主 |
| 用真实 owner、隔离数据、确定性模型和生产 UI 路径验证 | 只验证 schema、mock bridge、旧包或 utility ready 就宣称功能完成 |
| 更新一个权威文档，其他文档链接它 | 在多个文档复制同一预算、状态机、所有权表并分别维护 |
