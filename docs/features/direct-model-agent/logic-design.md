# 直连模型 Agent 能力功能逻辑设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 已实施 |
| 版本 | 0.3 |
| 日期 | 2026-09-03 |
| 关联 PRD | [PRD](./prd.md) |
| 关联故事 | [User Stories](./user-stories.md) |

## 1. 权威不变量

1. `process_execute` 和 `subagent_delegate` 只属于直连文本模型。
2. Ask 永远不能启动命令、写入工作区或创建 Execute Subagent。
3. 子级的项目、执行空间、工作模式、模型连接和能力范围只能继承或缩小。
4. 子级工具清单不包含 `subagent_delegate`，最大深度固定为 1。
5. 命令必须在父请求绑定的执行空间运行，禁止跨设备静默回退。
6. 一个 `process_execute` 调用只拥有自己创建的前台进程树，不能管理无关进程。
7. 非零退出码是命令结果；启动失败、输入无效和后端不可用才是工具失败。
8. 子任务是父请求内部 Job/Subjob，不创建顶层 Task 或独立 Conversation。
9. 父请求取消、Runtime 释放或应用退出会传播到全部活动子级和进程。
10. OpenCode、Continue 和 DeepSeek Harness 的原生能力不被本功能替换或包装。
11. 直连模型只在尚未显示文本或推理内容时自动重试瞬时网络错误或请求超时，最多重试
    3 次；用户取消和已显示的部分输出禁止重放。

## 2. 状态维度

| 维度 | 值 |
| --- | --- |
| Runtime | `model`、`opencode`、`continue`、`deepseek-harness` |
| 工作模式 | `ask`、`execute` |
| 执行空间 | `local`、`ssh` |
| 本机 Shell | `available`、`unavailable` |
| Subagent 深度 | `0`、`1` |
| 父请求 | `active`、`cancelling`、`terminal` |
| 模型请求重试 | `initial`、`retry 1..3`、`terminal` |

## 3. 工具可见性决策表

| Runtime | 模式 | 执行空间 | `process_execute` | `subagent_delegate` |
| --- | --- | --- | --- | --- |
| `model` | Ask | 本机 | 隐藏 | 提供，只读继承 |
| `model` | Execute | 本机且 Shell 可用 | 提供 | 提供，Execute 继承 |
| `model` | Execute | 本机但 Shell 不可用 | 隐藏并报告诊断 | 提供，但子级同样没有进程工具 |
| `model` | Ask/Execute | SSH，远端后端未实现 | 隐藏 | 当前远端直连模型产品入口不开放 |
| 其他 Runtime | 任意 | 任意 | 隐藏 | 隐藏 |

工具清单隐藏不是最终授权边界。`callTool` 仍须重新验证 Runtime、工作模式、执行空间和父请求
是否活动，以拒绝旧快照或伪造调用。

## 4. 进程状态机

```text
validating
  ├─ invalid → failed
  └─ valid → starting
               ├─ spawn_failed → failed
               └─ running
                    ├─ exit 0 → completed
                    ├─ exit nonzero → completed_nonzero
                    ├─ timeout → terminating → timed_out
                    ├─ parent cancel → terminating → cancelled
                    └─ output/lifecycle failure → terminating → failed
```

规则：

- `completed_nonzero` 仍产生正常工具结果。
- 超时和取消结果包含已经取得的有界输出。
- 进入 `terminating` 后不再接受新输入，也不启动替代命令。
- 终止只针对本次调用记录的进程树。
- 迟到的 `close` 只用于清理，不得覆盖已提交的取消或超时原因。

## 5. 工作目录决策

| 输入 | 结果 |
| --- | --- |
| 未提供 | 当前工作区根目录 |
| `.` 或合法相对子目录 | 解析到工作区内目录 |
| 绝对路径 | 拒绝 |
| `..` 越界、符号链接越界 | 拒绝 |
| 不存在或不是目录 | 拒绝 |
| 当前工作区身份在验证期间变化 | 拒绝本次调用 |

首版进程工具比 Execute 的 OS 权限范围更窄地固定工作目录输入，只是为了保持请求与项目
一致；命令本身仍以当前用户权限运行，可以显式访问该账号有权访问的其他绝对路径。该规则
不是 Runtime OS 沙箱，也不能宣称文件系统 containment。

## 6. Shell 选择

| 平台 | 顺序 | 不可用结果 |
| --- | --- | --- |
| Windows | `pwsh` → `powershell.exe` | 进程工具不注册，设置诊断显示 PowerShell 不可用 |
| macOS | `/bin/bash` → `/bin/sh` | 两者都不可用时不注册 |
| Linux | `/bin/bash` → `/bin/sh` | 两者都不可用时不注册 |

一次父请求冻结实际 Shell 描述。PATH 或工具环境设置变化只影响新创建的 Runtime/执行服务，
不在运行中的命令或 Subagent 中途切换。

## 7. Subagent 状态机

```text
validating
  ├─ invalid/depth_exceeded → failed
  └─ queued
       ├─ parent_cancelled → cancelled
       └─ running
            ├─ model done → completed
            ├─ child failure → failed_with_partial_output
            ├─ timeout → cancelled
            └─ parent cancel → cancelled
```

父模型收到结构化终态：

```ts
type SubagentDelegateResult = {
  status: 'completed' | 'failed' | 'cancelled'
  output: string
  error?: string
  modelUsage?: {
    inputTokens?: number
    outputTokens?: number
  }
}
```

失败和取消是父模型可以解释的子任务结果。只有契约损坏、未知子任务身份或服务已经释放等
内部不变量失败才终止父工具循环。

## 8. 权限与能力继承

| 父请求 | 子级模式 | 子级能力 |
| --- | --- | --- |
| Ask | Ask | 父级只读工具的子集，不含进程、写入和再次委派 |
| Execute | Execute | 父级已启用工具的子集，包含本机进程能力，不含再次委派 |

- 子级不能请求更高模式。
- 子级使用父请求开始时的工具与能力快照；运行中设置变化不重写快照。
- 子级调用 MCP、浏览器或知识能力时继续经过这些能力已有的作用域和生命周期边界。
- Execute 子级不弹出额外的“Subagent 执行授权”，也不获得父级没有的 MCP 分配。

## 9. 并发和顺序

- 全局编程 Subagent 最大并发为 3，额外请求进入有界队列。
- 单个父模型的工具调用仍按直连模型现有顺序结算，不为本功能改写全部工具并发语义。
- 不同父请求的 Subagent 可以并发；共享工作区的并发写入属于用户已授权的 Execute 行为，
  活动记录必须保留实际顺序和结果。
- 首版不自动创建工作树、锁文件或回滚层。出现真实冲突时由父模型读取当前工作区事实并处理。

## 10. 结果优先级

当多个终止原因竞争时，使用以下优先级：

```text
用户/父请求取消 > 工具超时 > 输出或协议边界 > 进程退出 > 普通工具错误
```

已经提交的正常终态不被稍后到达的取消覆盖。父请求进入终态后，迟到的子级文本和工具事件
只用于资源清理，不再写入会话。

## 11. 模型请求重试

```text
attempt
  ├─ success → completed
  ├─ cancel → cancelled
  ├─ non-retryable failure → failed
  ├─ transient failure after visible output → failed_with_partial_output
  └─ transient failure before visible output
       ├─ retry count < 3 → backoff → attempt
       └─ retry count = 3 → failed
```

- 瞬时失败包括常见连接重置、连接/网络不可达、DNS 临时失败、连接管道中断和请求超时。
- 三次重试分别等待 500 ms、1 s 和 2 s；每次尝试重新建立请求并使用独立请求超时。
- 普通问答、工具模型轮次和上下文摘要使用同一规则。
- 重试不重复已经执行的工具；工具只会在模型完整返回一轮工具调用后开始执行。
- 退避等待绑定父请求取消信号，取消优先于启动下一次尝试。

## 12. 逻辑完整性评估

| 领域 | 结论 |
| --- | --- |
| Runtime 隔离 | 完整，工具只注入 `model` |
| Ask/Execute | 完整，清单过滤和调用边界双重检查 |
| 本机三平台 | 完整，统一契约和平台 Shell 决策已定义 |
| Subagent 递归 | 完整，深度固定为 1 |
| 取消与失败 | 完整，父子和进程传播及优先级已定义 |
| 模型网络恢复 | 完整，有限重试、输出重放和取消边界已定义 |
| 产品对象 | 完整，遵循 Task/Job 权威模型 |
| SSH 远端执行 | 明确不在首版；未来必须增加 Agent 后端后才能开放 |

当前没有需要在实施前由用户补充的产品决策。
