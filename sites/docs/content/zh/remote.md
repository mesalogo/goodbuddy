# 远程项目

远程项目让 Workspace、终端和支持的 Runtime 在 SSH Host 上执行。远程路径不会被当成本机路径处理，文件、进程、网络和模型调用都受远端登录账号及远程环境限制。GoodBuddy Agent 不随桌面安装包提供，需要单独准备。

## 准备 SSH Host

在设置的远程项目入口添加 Host，填写地址、端口、用户名和认证方式。首次连接先查看 Host Key 的算法和 SHA-256 指纹并明确接受；指纹变化时必须单独确认替换。可用系统 SSH Agent 或支持的证书方式，凭据由桌面安全存储管理。GoodBuddy 不要求 root，也不默认启用 SSH Agent Forwarding。

Host 保存成功不等于远程环境已经就绪。按 Host 卡片的操作准备或更新签名 Agent 和 Runtime，等待环境检查通过。版本匹配只表示版本事实，不代表 Agent 正在运行或能力完整；安装失败、取消或网络中断会保留 Host 并提供重试。

## 创建项目和使用空间

创建远程项目时选择已验证的 Host，输入或通过有界目录选择器选择远端工作目录，再选择 OpenCode 或 Continue 等支持的远程 Runtime。项目保存 Host ID、远端路径和 Runtime 选择。普通切换项目只切换本地配置，不自动连接、安装或扫描主机；首次使用 Workspace 或 Runtime 时才建立或复用 Agent 连接。

远程 Workspace 提供有界目录、文件预览、Git 和导入操作；终端使用远端默认 Shell。所有操作使用 SSH 账号权限，不能获得 root 或账号本身没有的访问权。本机 Skills、stdio MCP 和工具环境不会自动上传到远端；远程能力以 Agent 报告的实际能力为准。

## 失败和边界

SSH 可达、认证成功、Agent 就绪、Workspace 可用和 Runtime 可启动是不同状态。分别检查网络、防火墙、端口、Host Key、凭据、远端目录、Agent 版本、Runtime 版本和项目权限。远端 Agent 不可用时不会退化成 SSH stdio Runtime，也不会把同一请求偷偷改在本机执行。

断开 SSH relay 不一定会停止已接受的远程请求；重新连接后 GoodBuddy 只恢复 Agent 已记录且能确认的输出。无法确认模型请求是否已处理时不会自动重放，以免重复计费或重复副作用。显式停止、Agent 关闭或远端进程失败会按请求状态显示取消、失败或结果未知。
