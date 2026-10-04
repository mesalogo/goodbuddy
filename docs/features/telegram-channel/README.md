# Telegram 消息通道

Telegram 消息通道计划通过用户自行创建的 Bot，将 Telegram 私聊接入 GoodBuddy 通道项目，支持文字问答和执行任务。首版采用长轮询，运行 GoodBuddy 的电脑需要在线并能访问 Telegram。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [Telegram 通道 PRD](./prd.md) | 产品目标、首版范围、配置流程、功能要求、限制与验收标准 |

当前处于 PRD 草案阶段，尚未实现 Telegram 通道。详细逻辑、UI 和技术设计在实现前按需补充，不以本目录的建立作为功能完成证据。

## 术语与依赖

- BotFather：Telegram 官方的 Bot 创建和管理入口。
- Bot Token：GoodBuddy 调用 Bot API 的凭据，由用户从 BotFather 获取。
- 通道项目：GoodBuddy 中承载该渠道默认工作目录和处理后端的系统管理项目。
- 远程会话：某个 Bot 下一个私聊对应的连续对话。

现有通道项目约定参见[远程消息通道项目 PRD](../wechat-channel/prd.md)。[远程主机](../remote-host/README.md)负责远端工作区执行，[设备共享](../device-sharing/README.md)负责设备共享能力；Telegram 接入不扩展这两项功能的范围。
