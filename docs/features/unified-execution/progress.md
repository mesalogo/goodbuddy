# 进度与证据

## 2026-10-04 调研与设计

用户确认彻底移除 Ask / Execute，包括界面、原生工具与 MCP 限制，并允许升级清理历史模式字段。本轮交付文档，不实施运行时或数据库改造。

已完成只读源码调研：共享合同、Renderer、Main IPC、Model/OpenCode/Continue/Harness、原生客户端、Agent/桥接/辅助程序、图片工具、子代理、通道、队列、日程和数据库迁移入口。具体路径见[源码调研](./source-audit.md)与[数据迁移](./data-migration.md)。历史检索未返回相关存储决策，设计依据为当前会话要求与源码。

调研基于有未提交改动的工作树，不对应冻结的发布提交。记录到 Desktop 版本 0.15.10、数据库 schema 59、Agent wire 2.0 和 runtime/acp capability 5；实施前须重新检查并发变更。

## 已知工作树改动

本会话较早阶段按“Ask 仅提供只读工具”的旧方向修改了浏览器权限、网关分类、IPC 发放及相关测试。那部分改动仍未提交，方向已被本次完全移除模式的需求替代。后续实施需收敛这些改动，不能在此基础上继续扩展只读名单。

旧方向的聚焦测试曾报告 280 通过、1 跳过，类型检查与 lint 通过；这不构成本功能的验收证据。后续源码调研还发现 Model/Continue 上层授权分支未贯通。图片服务原始模式检查仍存在。

工作树另有并发的任务统计、监督者、界面和文档改动，均不属于本次移除实现。未对其回退或覆盖。

## 2026-10-04 当前实现与定向验证

主要源码改造已落地。以下按组件区分实现与验收，不把定向通过记为全量验证通过；全量测试仍在运行，最终结果由主实施记录汇总。

| 技术设计阶段 | 状态 | 剩余工作 |
| --- | --- | --- |
| P1 合同与迁移 | schema 60、Runtime 设置 22 及无模式合同已实现；合成回归 44 个文件、538 项通过，见[迁移记录](./data-migration.md#8-本地存储验证) | 真实旧库与未声明历史形状取证 |
| P2 本地执行 | Model、OpenCode、Continue、Harness 模式分支及一般工具审批已移除；内部无工具构造保留 | 全量测试及各平台最终验收汇总 |
| P3 各入口与原生客户端 | 队列、日程、通道、委派、子任务及原生配置已改为无模式 | 外部委派服务、原生客户端发布包矩阵 |
| P4 远程协议 | runtime/acp 6 与当前源码真实 Linux Host 定向验证通过 | 配套签名包重建、升级与发布矩阵 |
| P5 界面与文档落地 | 模式与安全分类已删除；清除数据搬迁后的 Electron 定向验证通过 | 中英文、主题、键盘完整矩阵及最终文档汇总 |

### 真实 Host

原始证据：`C:/Users/jiang/AppData/Local/Temp/opencode/unified-execution-host/validation.md`。基于并发工作树，用 esbuild 重建 Desktop driver、Agent daemon 与 CLI/helper，连接共享 Linux x64 Host，在专用目录测试；上游 OpenCode/Continue 工件使用 Host 已安装版本。这是源码开发验证，不是签名包或发布验证。

| 场景 | 真实模型调用 | 实际结果 |
| --- | ---: | --- |
| OpenCode 无模式请求及进程重建后的原生历史 | 2 | 通过 |
| Continue 无模式请求及进程重建后的历史 | 2 | helper 原生模式修正前通过 |
| OpenCode 原生工具、detach、controller 恢复、测试 Agent 提升及重放 | 2 | 通过 |
| Continue 取消及新请求 | 2 | helper 原生模式修正前通过 |
| Continue 原生工具/detach 首次尝试 | 1 | 失败：没有 running tool 事件，helper 选择了原生 chat/`--readonly` |
| Continue 原生工具、detach、controller 恢复、测试 Agent 提升及重放 | 2 | helper 改为原生 agent 后通过 |
| Continue 取消及新请求 | 2 | helper 改为原生 agent 后通过 |

共 13 次真实模型调用，每次运行关闭后所属残留进程均为 0。真实图片提供商调用为 0；图片绑定、生成与保存仅由受控提供商测试覆盖。结构化提问由远程测试及既有原生二进制探针覆盖，没有真实 Host 提供商提问场景的结论。

最终远程回归命令：

```text
npx vitest run src/agent-daemon src/main/remote-agent src/main/agent/acp-remote-runtime.test.ts src/shared/remote-agent-contracts.test.ts src/shared/remote-runtime-launch-contracts.test.ts src/shared/agent-protocol --testTimeout=30000 --hookTimeout=60000
```

66 个文件通过、2 个跳过；723 项通过、33 项跳过。helper 最终修改后的局部 ESLint 通过。原始记录当时报告全仓 lint 通过，但 typecheck 仍被并发调用方和夹具阻塞，Agent-only 检查剩余 `DirectModelSubagentParent.workMode` 错误；这保留为当时结果，不作为最终聚合检查结论。

### 真实 Electron

实施方提供的通过结果与 [unified-execution-main.ts](../../../tests/support/unified-execution-main.ts) 对应：生产 App、preload、IPC、设置和 SQLite，隔离无关启动服务。种子消息证明首次点击不删除、取消保留、确认经生产 IPC 删除且重载后仍删除；同时检查输入区及项目表单无模式控件、安全分类消失、入口属于 General / Platform Features，模型请求为 0。该证据不等于完整启动服务或全部 UI 场景验收。

### 现行文档

根 README、双语 FEATURES、BUILD、UI-DESIGN、运行时约定与受影响功能 Markdown 已同步无模式规则。规划功能仍保持规划状态；历史发布、原型及日期明确的验证段保留当时结果。`sites/index.html` 和 `sites/en.html` 仍有双模式产品文案与示意，属于本轮未修改的站点源码，发布前需同步。

## 调研阶段验证边界

本轮没有执行产品迁移，没有读取真实用户数据库或 Agent 日志，没有启动 Runtime、调用模型/图片提供商，也没有连接测试 Host。调用次数为 0。源码阅读证明依赖存在，不证明升级或执行已通过。

仍需实际取证：旧 `runs` JSON 形状、Agent 不透明事件中的应用自有字段、旧远程操作跨升级恢复，以及外部委派服务兼容性。不得用递归删字段或清空日志回避这些问题。

## 调研阶段文档检查记录

已对九份文档进行交叉审查，核对范围、需求与故事映射、源码引用、相对链接和当前状态表述。审查发现的独立授权验收缺项、原生设置范围歧义和起草阶段备注已修正。

`deai-writing` 扫描九份文档，阻断项为 0。复核项主要为未验证状态、数据保留条件和字段枚举；结合技术文档语境保留这些限定，不将迁移计划改写为已完成事实。

`git diff --check -- docs/features/unified-execution docs/features/assistant-workbar/README.md` 通过已跟踪改动的空白检查。新建文档另经内容与链接核对；该命令不会把未跟踪文件当作已验证差异。文档检查不替代运行时验收，后者按用户故事与技术设计执行。
