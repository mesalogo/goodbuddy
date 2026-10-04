# Telegram 消息通道

Telegram 消息通道通过用户自行创建的 Bot，将授权用户的普通私聊文字接入 GoodBuddy 通道项目，复用项目的模型、Runtime 和工作目录。首版采用长轮询，运行 GoodBuddy 的电脑需要在线；生产驱动通过 Electron `net.fetch` 使用系统代理访问 Telegram。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [Telegram 通道 PRD](./prd.md) | 产品目标、首版范围、配置流程、功能要求、限制与验收标准 |
| [技术设计](./technical-design.md) | 生产模块、身份与持久化、IPC 状态、生命周期及实现边界 |
| [实施与验证进度](./progress.md) | 日期化验证证据、当前阻塞与待验收项目 |
| [API 联调操作说明](./api-testing.md) | 两类探针的命令、网络路径、输出含义及副作用 |
| [独立 Node 探针](./telegram-probe.mjs) | 独立调用 Bot API，不经过生产驱动或模型 |
| [生产探针启动器](./run-live-probe.mjs) | 构建探针、启动隔离 Electron 进程并清理临时目录 |
| [生产探针入口](./live-probe-main.ts) | 生产驱动连接检查及可选 ChannelService 固定回复，不调用模型 |

生产接入代码与本地自动化验证已落地，真实 Bot 与模型的完整链路尚未证明，不能记为全面验收通过。当前结果和待办以[进度记录](./progress.md)为准；2026-10-04 独立 Node 探针成功仅是历史 API 证据。

## 术语与依赖

- BotFather：Telegram 官方的 Bot 创建和管理入口。
- Bot Token：GoodBuddy 调用 Bot API 的凭据，由用户从 BotFather 获取。
- 通道项目：GoodBuddy 中承载该渠道默认工作目录和处理后端的系统管理项目。
- 远程会话：某个 Bot 下一个私聊对应的连续对话。

现有通道项目约定参见[远程消息通道项目 PRD](../wechat-channel/prd.md)。[远程主机](../remote-host/README.md)负责远端工作区执行，[设备共享](../device-sharing/README.md)负责设备共享能力；Telegram 接入不扩展这两项功能的范围。
