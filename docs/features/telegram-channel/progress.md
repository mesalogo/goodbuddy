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
- 跟踪全量测试中的 Runtime 清理与帮助弹层间歇性失败；两者均有原样复跑通过证据，未为此修改无关产品逻辑。
- 提供有效测试凭据后运行生产实时探针，记录连接及固定回复结果；本次缺少凭据的阻塞不以历史 Node 成功替代。
- 从真实设置页保存并启用专用 Bot，在手机发送授权请求，经过实际模型产生回复并核对桌面历史；再按 PRD 验证连续上下文、隔离、无害工具任务和恢复场景。当前没有真实 Bot 与模型完整链路的通过记录。
- Main 测量未覆盖迁移和完整 UI；后续验收需按[性能原则](../../architecture/performance-principles.md)区分实测路径与未测路径。
