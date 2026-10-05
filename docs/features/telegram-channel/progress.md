# Telegram 实施与验证进度

## 2026-10-05 当前结果

生产设置入口、驱动、项目路由、执行、持久化和状态推送已接入，行为见[技术设计](./technical-design.md)。真实 Telegram Bot 与模型的完整链路尚未证明，[PRD 验收](./prd.md#5-产品验收)仍待完成。

以下计数来自本次开发会话提供的验证结果，本轮文档修订未重跑这些测试。集合可能重叠，不相加计算覆盖总数。

| 验证范围 | 结果 | 证据边界 |
| --- | --- | --- |
| Driver / Service / Manager 聚焦测试 | 74 通过 | 解析、授权、重试、身份隔离与生命周期等自动化覆盖 |
| 集成测试集合 | 251 通过，1 跳过 | 包含 Electron 生产 UI / IPC / store / executor 与本地模型 fixture，Telegram 网络响应为替身 |
| Electron 场景 | 2 次本地模型调用，0 次外部调用 | 配置测试与加密保存、授权和去重、结果入库与回复、重载恢复、停用取消；错误及重连状态推送保留草稿；启用状态清除 Token 后停止连接并保留项目和历史 |
| Typecheck / lint | 最终复跑均通过 | 静态检查，不能替代真实 Bot 联调 |
| 全量测试原始结果 | 6086 通过，86 跳过，2 失败 | 保留当次失败记录；后续修复与复跑见下两行，尚无新的全量通过结论 |
| Schema 断言修复 | 已改用 schema 版本常量；四个 suite 共 301 通过 | 修复原先预期 60、实际 61 的 worker 断言，不将局部复跑计为全量通过 |
| OpenCode cleanup-timeout 复跑 | 单独运行 3 次通过，整个 runtime suite 通过 | 原因尚未证明，记录为全量运行中出现的间歇性失败，不宣称已修复 |
| 最终全量测试 | 6087 通过，87 跳过，1 失败；耗时 879.68 秒 | 唯一失败为 `tests/inline-help.electron.test.ts` 的 Hover Escape 场景；原样单独复跑通过，仍保留间歇性失败记录。此前 schema 和 Runtime 失败未在本轮出现 |
| 生产实时探针 | 本次未运行 | 当前会话缺少 `TELEGRAM_BOT_TOKEN` |
| 生产探针 dry-run | 打包与语法检查通过 | 未启动 Electron，未发出网络请求 |
| 真实本地代理 fixture | 真实 Electron 生产默认传输曾成功运行 1 次；最终运行因临时 CA 信任导入超时失败 | 后续 Windows 临时 CA 信任导入需要操作系统确认；测试已改为显式启用，默认跳过。不宣称可无人值守复现 |
| Main 性能测量 | 基线与当前版本交替各运行 3 轮 | 结果见下节；没有证据证明性能改善或 Telegram 引入回退，不宣称全局预算通过 |

Electron 证据对应 [`tests/telegram-channel.electron.test.ts`](../../../tests/telegram-channel.electron.test.ts) 与 [`tests/support/telegram-main.ts`](../../../tests/support/telegram-main.ts)。它使用生产组件、Preload、IPC、配置存储、executor 和 SQLite；在 `net.fetch` 边界替换 Telegram 响应，模型为本地 HTTP fixture。因此它验证内部产品路径，不能证明外部 Telegram 网络、系统代理或真实模型服务可用。

可复跑的聚焦命令：

```powershell
npx vitest run src/main/channels/telegram-channel-driver.test.ts src/main/channels/channel-service.test.ts src/main/channels/channel-manager.test.ts
npx vitest run tests/telegram-channel.electron.test.ts
npm run typecheck
npm run lint
npm test
```

集成集合及 301 项复跑的完整命令未随计数提供，这里不推测其文件清单。真实本地代理 fixture 见 [`tests/telegram-proxy.electron.test.ts`](../../../tests/telegram-proxy.electron.test.ts)；其本地代理结果不证明外部 Telegram Bot 可用。探针操作见 [API 联调](./api-testing.md)，探针成功也不包含模型验收。

## 2026-10-05 通道审计修复验证

A06 的图片结果回归使用现有 IPC executor 图片事件 fixture，接入生产 `ChannelService` 和内存 SQLite 发件箱。修复前回复状态为 `failed`；修复后状态为 `completed`，图片附件字节保持一致，桌面会话仍记录成果 ID。未调用付费图片模型。

A07 的 Renderer 回归覆盖推送状态为 `error`、`stopped`、`running`、`starting`、`disabled` 的无修改保存。前两种状态在修复前没有提交配置，修复后能够提交；其余状态保持不提交。扩展的 Electron 场景通过真实设置 UI、Preload、IPC、Manager 和驱动验证 409 后无修改保存恢复轮询，以及正常连接时再次保存不重启。Telegram API 在网络边界使用替身；本次运行有 2 次本地 HTTP 模型调用、0 次外部请求。

A08 的钉钉回归使用生产传输、服务和 SQLite 发件箱，HTTP 请求只发送到 loopback fixture。首次 HTTP 200 携带非零 `errcode`，修复前被当作成功；修复后记录一次失败并保留上下文，第二次成功响应完成投递，executor 只执行一次。另有空响应、缺少错误码、JSON null、无效 JSON 和超限响应回归。

本轮聚焦验证：6 个 channel / Renderer suite 共 106 项通过；IPC 图片、文件与 Telegram 场景 3 项通过；Electron 场景 1 项通过。修复前选择性回归为 9 项失败、3 项通过。命令如下：

```powershell
npm test -- src/main/channels/dingtalk-channel-driver.test.ts src/renderer/src/ChannelSettingsSection.test.tsx src/main/channels/channel-manager.test.ts src/main/channels/channel-service.test.ts src/main/channels/telegram-channel-driver.test.ts src/main/channels/sqlite-channel-state.test.ts
npm test -- src/main/ipc.test.ts -t "returns a generated image only|creates a bounded result file|routes Telegram settings"
npm test -- tests/telegram-channel.electron.test.ts
```

这些结果验证本地生产连接关系，不替代真实平台收发或图片模型验收。本轮未改 Agent、Runtime 协议或执行策略，未做性能改善声明。

补充检查：钉钉错误码断言加入后，单独复跑 9 项通过；修改的 TS 文件 ESLint、Renderer typecheck 和 `git diff --check` 通过。早期全仓检查受到并行修改中的类型与 lint 错误阻塞，负责方修正后最终检查均通过；完整测试为 6,136 项通过、0 失败、87 跳过。汇总见[阶段修复验收](../../review/stage-audit-fixes-2026-10-05.md#最终检查)。

## 2026-10-05 K09 投递修复

本轮只修改 Telegram 驱动、Manager 及其测试，复用现有服务重试、SQLite 发件箱和状态 IPC。未改数据库结构、Main IPC、Runtime 或 Agent；本地与远程任务完成后的通道结果均使用同一发送路径，无需独立 Agent 修复。

修复前先运行持久回归：`telegram-delivery.test.ts` 的 3 项 loopback HTTP／SQLite 用例和 Manager 的状态用例共 4 项失败。启动 webhook 冲突时，同 Bot 的待发回复未发出且变为终止记录；403 后状态仍为 `running` 且无错误；连续 429 的最后响应要求等待 3 秒，下一次发送却只间隔约 1.010 秒。扩展的 Electron 设置 fixture 也在“已连接时显示发送失败”断言处失败。

修复后，启动阶段保留 `getMe` 确认的身份，已有 webhook 时发送同 Bot 的待发回复，其他 Bot 的记录仍被拒绝，轮询状态仍报告冲突。发送错误经脱敏后由现有状态区域显示，健康轮询不清除；发送成功清除投递提示但不覆盖轮询错误。驱动在内部重试耗尽后仍完成最后一次 `retry_after` 等待，再返回发件箱；新增取消用例验证等待可中断、记录保持 `pending / attempts=0`，重新启用后只补发一次且不运行 executor。

| 检查 | 最终结果 |
| --- | --- |
| 9 个通道／Renderer 聚焦文件 | 127 项通过，包含 4 项 loopback HTTP／SQLite 回归 |
| 现有 Electron 设置 fixture | 1 项通过；生产设置 UI、Preload、IPC、Manager、驱动与 SQLite，403 提示、已连接状态、Token／白名单草稿、重载恢复均通过 |
| 修改的 6 个 TS 文件 ESLint | 通过 |
| `npm run typecheck` | Main、Agent 通过；Renderer 被并行工作区的 `App.tsx:174` 未使用 `refreshArtifacts` 导入阻塞，未修改该文件 |

最终聚焦命令：

```powershell
npm exec -- vitest run src/main/channels/telegram-delivery.test.ts src/main/channels/telegram-channel-driver.test.ts src/main/channels/channel-manager.test.ts src/main/channels/channel-service.test.ts src/main/channels/channel-settings-store.test.ts src/main/channels/sqlite-channel-state.test.ts src/renderer/src/ChannelSettingsSection.test.tsx src/renderer/src/channel-status-store.test.ts src/main/channels/dingtalk-channel-driver.test.ts
npm exec -- vitest run tests/telegram-channel.electron.test.ts
npm exec -- eslint src/main/channels/telegram-channel-driver.ts src/main/channels/channel-manager.ts src/main/channels/telegram-delivery.test.ts src/main/channels/telegram-channel-driver.test.ts src/main/channels/channel-manager.test.ts tests/support/telegram-main.ts
npm run typecheck
```

Electron 最终运行使用 2 次本地 HTTP 模型响应；连同修复前失败运行和中间验证，本轮共 6 次本地 fixture 请求、0 次外部 Provider 请求、0 次真实 Telegram 收件人消息。未读取 `.env`，未运行生产构建。完整测试、全仓 lint 及合并后的类型检查由协调方执行；本节不声明全仓验收通过或性能提升。

## Main 性能对比

基线为 `78afec77758f3c175f8e2b80e5be4327e13b4689` 的临时 detached worktree，当前为包含 Telegram 改动的工作区。按基线、当前交替执行 `npm run perf:main` 各 3 次。环境为 Windows x64、Intel Core Ultra X7 358H、Electron 44.5.1、Node 24.21.0；每轮使用隔离数据库，包含 1000 个会话、20008 条生成消息、24000 条活动记录，每个场景预热后测量 15 次，无外部模型调用。

下表为每轮调用耗时 p95，单位为毫秒。对比相同生产路径，不将脚本内部的历史同步算法视为基线版本。

| 场景 | 基线三轮 | 当前三轮 |
| --- | --- | --- |
| 会话摘要 worker | 25.0 / 20.9 / 29.3 | 18.8 / 26.6 / 53.3 |
| 最大会话 worker | 1.1 / 0.6 / 1.1 | 0.8 / 1.0 / 1.2 |
| 活动增量更新 | 1.3 / 2.3 / 2.0 | 1.3 / 1.5 / 1.7 |
| 活动启动 worker | 17.7 / 18.7 / 29.2 | 13.7 / 23.0 / 25.2 |
| 整份活动替换，一条变化 | 61.8 / 84.9 / 73.1 | 52.0 / 84.0 / 73.8 |

worker 读取、活动启动、增量更新和同步首页查询在六轮中均满足 Main 阻塞与事件循环延迟预算；当前这些路径的最大循环间隔为 3.7 ms，最高循环延迟 p99 为 4.4 ms。整份活动替换在两个版本中均超预算，当前最大循环间隔为 47.0–84.2 ms；同步活动汇总也存在超过 16 ms 的情况。这些已有路径不属于本次 Telegram 优化范围。

版本差异与轮次波动交叠，不能据此归因于 Telegram 或声称性能提升。测量在新数据库初始化后进行，不覆盖已填充 schema 60 数据库升级到 61 的耗时、Telegram 流量或完整 UI 响应。原始结果保存在本次机器临时目录 `telegram-main-results-20261005-a`，不作为仓库依赖。

## 2026-10-04 历史 API 证据

独立 `telegram-probe.mjs` 在 Windows / PowerShell 5.1 / Node.js 24.21.0 下测试。首次直连曾有关闭 TLS 校验的环境配置，不作为正常 HTTPS 证据；开启校验后直连超时。将 Windows 系统代理临时传给 Node 后，`getMe`、`getWebhookInfo` 成功，无 webhook。

初次监听窗口未收到匹配指令；随后 `--pending` 从 2 条积压中匹配 `/goodbuddy_test`，`sendMessage` 返回成功，输出 `privateMessageRoundTrip: ok=true`。没有模型调用，手机端实际展示仍需用户确认。该记录只证明当日独立 Node API 路径，不证明当前凭据有效、生产驱动可用或完整产品验收通过。历史凭据曾公开，应撤销后换新，文档不保留 Token。

## 待完成

- 在可完成操作系统信任确认的环境中复跑显式启用的代理测试，记录最终结果；保留单次成功和后续导入超时两项证据，不把默认跳过视为通过。
- Runtime 清理用例的 GC 生命周期问题已定位并修正测试夹具，完整集成测试通过，见[GC 复查](../unified-execution/progress.md#sdk-cleanup-timeout-复查)。历史帮助弹层间歇性失败在本轮完整测试中未出现。
- 提供有效测试凭据后运行生产实时探针，记录连接及固定回复结果；本次缺少凭据的阻塞不以历史 Node 成功替代。
- 从真实设置页保存并启用专用 Bot，在手机发送授权请求，经过实际模型产生回复并核对桌面历史；再按 PRD 验证连续上下文、隔离、无害工具任务和恢复场景。当前没有真实 Bot 与模型完整链路的通过记录。
- Main 测量未覆盖迁移和完整 UI；后续验收需按[性能原则](../../architecture/performance-principles.md)区分实测路径与未测路径。
