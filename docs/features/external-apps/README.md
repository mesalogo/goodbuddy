# 外部应用

外部应用把飞书、企业微信、钉钉、微信 ClawBot、Telegram 接入 GoodBuddy。入口在左下角“应用 › 管理应用”（应用中心），替代设置中心的“消息通道”。由于暂不支持第三方插件，这几个应用都是内置应用，在应用中心单独成组。它们不常驻左侧：飞书、企业微信在对话右侧工作区以面板打开，其余进入各自的通道项目。

接入模型以 OpenClaw 为准：一个平台账号对应一套凭据，同一套凭据同时提供消息和工具。凭据可以扫码创建，也可以手动填写；访问控制只有私聊策略和群策略两项。不做单独的用户 OAuth、访问范围或操作权限矩阵。

工具实现：企业微信使用官方 `wecom-cli` 和官方 Skill，由 GoodBuddy 校验类别后代为执行（`wecom_guide`、`wecom_cli`、`wecom_script`）；飞书按 OpenClaw 飞书插件的工具分组实现为 `feishu_*` 内置工具，并作为第五个消息通道通过长连接收发消息。详见 [PRD 第 7 节](./prd.md#7-实现方式)。

## 文档导航

| 文档 | 权威职责 |
| --- | --- |
| [PRD](./prd.md) | 用户问题、范围、平台差异、功能要求与验收 |
| [交互 Demo](./demo.html) | 应用中心、连接流程、应用设置、对话与右侧工作区面板、通道项目和消息请求的界面原型 |
| [进度](./progress.md) | 已实现内容、与 PRD 的差距和验证记录 |

尚无 User Stories、逻辑、UI 和技术设计文档，后续按 [`docs/features/AGENTS.md`](../AGENTS.md) 补充。

Demo 只用演示数据，不连接任何平台、不读写真实设置。可以直接打开，也可以通过本地 HTTP 服务打开，用 `?s=<场景>&a=<应用>&t=<标签>` 跳转，例如 `?s=connect&a=wecom`、`?s=settings&a=feishu&t=tools`、`?s=chat&a=wecom`（对话 + 企业微信面板）、`?s=channel-chat&a=weixin`（微信通道项目）。

## 术语

| 术语 | 定义 |
| --- | --- |
| 外部应用 / 平台应用 | 连接第三方平台账号的内置应用，提供消息、工具或两者 |
| 凭据 | 平台账号的应用身份：飞书 App ID / App Secret，企业微信智能机器人 Bot ID / Secret，钉钉 Client ID / Client Secret，Telegram Bot Token，微信 ClawBot 绑定信息 |
| 扫码创建 | 用平台手机端扫码，自动创建应用或机器人并取得凭据。扫码完成后，私聊策略自动设为“仅我自己” |
| 工具 | 外部应用提供给对话的平台操作，例如读写飞书文档、查询企业微信日程。按类别开关 |
| 工具身份 | 工具调用平台接口时使用的身份。飞书是应用身份，企业微信智能机器人是授权人本人 |
| 通道项目 | 处理某个外部应用收到的消息的系统项目，承载工作目录和处理后端 |
| 私聊策略 | 谁可以私聊 GoodBuddy：仅我自己、白名单、配对审批、关闭 |
| 群策略 | GoodBuddy 响应哪些群：仅指定群、所有群（都需要 @），或关闭 |

## 参考

- OpenClaw 飞书：[概览](https://docs.openclaw.ai/channels/feishu)、[接入](https://docs.openclaw.ai/channels/feishu/setup)、[工具与多账号](https://docs.openclaw.ai/channels/feishu/advanced-configuration)
- OpenClaw 企业微信：[入口](https://docs.openclaw.ai/channels/wecom)，配置以腾讯维护的 `@wecom/wecom-openclaw-plugin` 说明为准
- 企业微信 [`wecom-cli`](https://github.com/WecomTeam/wecom-cli)：智能机器人凭据、扫码接入及业务工具清单

## 相关功能

- [应用导航与系统工具入口](../application-tool-navigation/README.md)：应用中心、应用菜单、常驻与排序
- [微信消息通道](../wechat-channel/README.md)、[Telegram 消息通道](../telegram-channel/README.md)：现有通道的连接与消息处理，迁入应用中心后行为不变
