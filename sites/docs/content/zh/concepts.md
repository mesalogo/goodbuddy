# 核心概念

GoodBuddy 把聊天、模型调用和文件操作放在几个相互关联的对象中。理解这些对象后，选择 Runtime、限制知识范围和查看执行记录会更容易。

## Project 与 Conversation

Project 是项目范围，包含项目目录、项目级 Runtime 选择、会话和任务。Conversation 是一条持续的聊天记录，保存消息、工具活动和引用。一条会话可以没有 Task，也可以关联多个 Task；关联 Task 不会改变会话类型。

## 模型连接与 Runtime

模型连接是可复用的服务配置，通常包含 URL、协议、模型名和凭据。Runtime 是执行请求的方式：直连模型由 GoodBuddy 调用模型服务，OpenCode 和 Continue 使用各自的 Agent 客户端，DeepSeek Harness 使用 GoodBuddy 管理的兼容执行路径。Runtime 的具体选择见[选择 Runtime](./runtimes.html)。

Runtime 会使用当前选择的能力和当前账号权限。项目可以设置默认 Runtime，会话可以继承项目设置或单独选择。模型连接被删除或不兼容时，选择器会说明回退或失败原因，不会悄悄换成另一个有凭据的模型。

## Capability 与执行空间

Capability 是一次请求可以使用的能力，例如知识检索、工作区文件、终端、浏览器或 MCP 服务。能力是否可用取决于 Runtime、项目设置、会话范围和执行空间。执行空间是文件、终端、受管进程和 Runtime 实际运行的位置，可以是本机项目目录，也可以是远程 SSH 项目目录。

## Task、Job 与 Run

Task 是用户明确创建或确认的工作单位，并且只关联一条 Conversation。Job 是 Task 内部的一次步骤或一次调度触发，Run 是 Job 或子任务的一次执行尝试和记录。普通聊天请求、工具调用和 Run 不会自动变成 Task；用户界面主要展示 Task，Job 和 Run 的细节在活动和执行记录中按需查看。

## 没有 Ask / Execute 模式

GoodBuddy 不提供 Ask / Execute 工作模式，也不会要求先切换模式才能调用已启用的能力。普通请求直接使用所选 Runtime、已启用能力和当前账号权限。某个 Runtime 不支持某项能力时，界面会报告能力缺失；内部摘要、笔记分析和监督回顾仍是专用的无工具文本请求。
