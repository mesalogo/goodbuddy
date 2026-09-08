# Runtime 交互边界

本文定义当前原生交互的适配范围，不增加工作模式或第二层 Execute 审批。

| Runtime | 权限确认 | 业务问答 |
| --- | --- | --- |
| 本机 GoodBuddy 管理的 OpenCode | 内部默认配置允许权限；每个 Ask 请求仍使用 deny-all 与显式只读能力。Execute 自动回复属于当前请求的父、子孙会话权限事件，不处理其他并行请求 | 通过 `question.asked` 转交父、子孙会话问题，支持原生单选、多选、yes/no、自由文本及跳过；使用公开 ID 回传 `question.reply/reject` |
| Continue | Execute 启动传入 `--auto`，剩余原生权限请求按当前模式自动答复 | 对接 `1.5.47` QuizService 的扁平 `pendingQuestion`，其中 `question` 是字符串。选项回答与自定义文本分别回传正确的 `isCustomAnswer`；跳过发送拒绝回答的文本 |
| DeepSeek Harness | 固定 Host 的 Execute 文件与命令工具不询问目录权限；若收到 ACP 权限请求，活跃 Execute 直接选一次性允许，缺少该选项时使用 Runtime 提供的允许选项，Ask 拒绝，不等待额外 authorizer | 固定 Host 当前未提供通用原生业务问答服务，不把普通模型正文误识别成待答协议。模型以普通回复提问时，用户通过下一条消息回答 |

托管 SSH OpenCode 的 ACP 权限处理与直接启动配置由
[远程主机技术设计](../remote-host/technical-design.md)定义；本机 SDK 问答适配不代表远程
ACP 已提供相同业务问答接口。

## 运行与失败

- 结构化 yes/no 是普通选项，不从日志、自然语言或 Shell 输出猜测用户意图。
- 前台问题停留在现有问答卡片，保留回答、提交失败提示与跳过入口。
- 后台任务收到结构化提问时，通过现有 Main 路径明确失败并提示改为前台对话，不永久等待。
- 请求结束或取消后清除对应待答映射；过期回答明确报错，不转交给后来的请求。
- 任意终端程序的密码、OAuth 登录、许可证确认或 stdin 提示不自动回复 `yes`。这类程序应
  使用其非交互参数，或由用户在终端完成；不能把权限确认和业务决策混为一谈。Shell
  工具保留其现有取消与超时，不新增日志解析或通用交互代理。

实现与真实 Runtime 验证证据见[进度记录](./progress.md)。
