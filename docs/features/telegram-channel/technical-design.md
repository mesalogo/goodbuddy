# Telegram 通道技术设计

本文对应 [PRD FR-1～12](./prd.md)，记录当前生产实现。验证状态见[进度记录](./progress.md)。实现约束沿用[性能原则](../../architecture/performance-principles.md)，下述结构不构成性能测量结论。

## 生产路径与网络

设置页经生产 Preload 和 IPC 调用 `ChannelManager`，由 `ChannelSettingsStore` 保存配置。Manager 按需加载 `TelegramChannelDriver`，向其注入 Electron `net.fetch`；驱动默认网络实现也使用 `net.fetch`。请求走 Electron 网络栈及系统代理，不依赖 Node 的 `HTTPS_PROXY` 配置，不使用 grammY 或 Telegraf。

驱动先调用 `getMe` 与 `getWebhookInfo`，拒绝已有 webhook，不删除外部配置。测试连接只做这两项检查，不启动轮询。启用后使用 `getUpdates`，`timeout=30`、`limit=100`、`allowed_updates=['message']`；普通请求超时 15 秒，轮询请求超时 40 秒。临时错误以 1～30 秒退避重连，429 按 `retry_after` 等待；其他 4xx 停止轮询并报告错误。

## 身份、执行与保存

| 对象 | 实现约定 |
| --- | --- |
| 配置 | 单 Bot；Token 加密保存，快照只返回是否已配置；保留、替换、清除三种动作 |
| 环境覆盖 | `GOODBUDDY_TELEGRAM_BOT_TOKEN`、`GOODBUDDY_TELEGRAM_ENABLED`、`GOODBUDDY_TELEGRAM_ALLOWED_SENDERS`；发送者为逗号分隔的数字 ID，空列表只提供帮助；配置只读，群聊不支持 |
| 入站身份 | `accountId=Bot ID`，`conversationId=Bot ID:chat ID`，`eventId=update_id`，授权使用数字发送者 ID |
| 执行 | 普通私聊文字经 `ChannelService` 队列进入现有远程通道 executor，使用 Telegram 项目后端与工作目录；同会话串行 |
| 内置反馈 | `/start`、`/whoami` 和授权媒体提示由驱动直接回复，不调用模型或写业务上下文；每个用户每类反馈冷却 5 秒 |
| 持久化 | 复用 SQLite 远程会话、去重和发件箱；schema 61 将相关 channel 约束扩展到 Telegram，保留既有数据；设置文件仍为版本 3，缺失 Telegram 配置时使用默认值 |

驱动只接收普通私聊，忽略群、频道、话题、编辑更新及无有效发送者的消息。媒体附带文字也不作为业务输入。驱动与服务均检查授权，白名单更新可原位应用，不取消已开始的任务；排队任务执行前再次检查授权。

入站进入内存队列后确认，驱动随后推进内存 offset。去重键为通道、Bot ID、事件 ID；入站队列和 offset 不持久化，不承诺崩溃后自动续跑或零丢失。重连接收平台仍保留的积压消息，工具请求也可能在重新启用后执行。

## 发送与生命周期

结果先进入现有发件箱，发送失败由服务有限重试，不重新调用模型；失败计数达到 5 或遇到永久错误后停止补发。发送前校验目标会话中的 Bot ID，拒绝把旧 Bot 结果交给新 Bot。附件只附加桌面查看提示。

驱动按最多 4096 个 UTF-16 码元拆分纯文本，并避开代理对中间位置；不设置 `parse_mode` 或引用原消息。分段进度只在驱动内存保存，最多 128 条，停止时清空。单次发送的 429 最多等待重试 3 次，仍失败则交回发件箱处理。跨重启补发与不确定网络结果允许产生重复段落。

停用会中止轮询、发送等待、活动执行与排队工作，等待活动操作结束后报告停止。清除凭据时设置页同时提交 `enabled=false`；底层拒绝启用但无 Token 的配置。Token 替换先验证，失败不停止旧服务。项目与历史不因停用或清除凭据删除。

## 状态与界面

Manager 通过 `{ channel, status }` 增量 IPC 推送状态，忽略旧服务实例的迟到事件。Telegram 连接状态由驱动维护，发送成功不会覆盖轮询错误。状态值为 `disabled`、`starting`、`running`、`stopped`、`error`；重连使用 `starting` 加错误说明，未配置由界面结合凭据状态显示。

Renderer 的 `channel-status-store.ts` 订阅事件，selector 只向状态区域提供对应通道数据。首次快照不会覆盖已收到的较新事件；状态更新不重新加载整份设置，不重置 Token 或白名单草稿。配置页复用共享页签、开关、项目设置字段和通知控件。

源码入口：[`telegram-channel-driver.ts`](../../../src/main/channels/telegram-channel-driver.ts)、[`channel-manager.ts`](../../../src/main/channels/channel-manager.ts)、[`channel-service.ts`](../../../src/main/channels/channel-service.ts)、[`channel-settings-store.ts`](../../../src/main/channels/channel-settings-store.ts)、[`channel-status-store.ts`](../../../src/renderer/src/channel-status-store.ts)、[`ChannelSettingsSection.tsx`](../../../src/renderer/src/ChannelSettingsSection.tsx)。
