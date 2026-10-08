# 选择 Runtime

Runtime 决定请求由哪条执行路径处理。它与模型连接不同：连接回答“调用哪个模型服务”，Runtime 回答“由谁组织请求、工具和执行空间”。每次请求都会保留可查看的状态、工具活动、取消或失败结果。

## 四种选择

| Runtime | 适合场景 | 模型配置 |
| --- | --- | --- |
| 直连模型 | 普通问答、知识检索、图片生成和 GoodBuddy 内置能力 | GoodBuddy 模型连接 |
| OpenCode | 编程 Agent、文件和命令工具、Skills | GoodBuddy 连接或 OpenCode 自有配置 |
| Continue | 使用 Rules、Prompt 预设和编程工作 | GoodBuddy 连接或 Continue 自有配置 |
| DeepSeek Harness | 固定 Host 和兼容插件能力 | GoodBuddy 管理的兼容连接 |

先用直连模型完成普通问答或知识检索；需要持续操作项目文件、命令和 Skills 时选择 OpenCode 或 Continue；需要其固定 Host 能力时再选择 DeepSeek Harness。不同 Runtime 的工具、问答和原生客户端能力可能不同，选择器会显示当前可用项。

## 选择范围和能力

项目设置必须选择具体 Runtime。会话默认跟随项目，也可以在输入框的两栏选择器中为本会话单独选择。模型栏会显示“默认”、具体连接和 Runtime 自有配置，并标明来源。切换 Runtime 后，原来不属于该 Runtime 的模型选择不会被强行沿用。

请求使用当前 Runtime、已启用 Capability、知识库范围、执行空间和当前账号权限。GoodBuddy 不提供 Ask / Execute 模式，也没有一个额外的通用工具审批开关；不支持的能力会明确报告，不会用隐藏模式代替。

## 本地、远程和记录

本地 Runtime 在本机项目执行。远程项目目前使用 SSH Host 上的 GoodBuddy Agent 和受管 Runtime，远程执行的文件、终端和进程使用 SSH 登录账号权限。远程 Agent 不随桌面安装包提供，需要先按[远程项目](./remote.html)准备。

查看请求消息的活动或助手工作栏，可以看到 Runtime、模型连接、工具状态、取消、错误和已保存结果。关闭面板不会自动取消后台请求；停止请求只影响所属请求。请求失败或取消时，已经保存的正文和工具记录会保留。
