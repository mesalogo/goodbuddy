# Obsidian 本机仓库接入

GoodBuddy 通过内置 MCPVault 访问本机 Obsidian 仓库，供会话读取、搜索和修改笔记。功能默认关闭；默认范围为本机已注册的全部仓库，也可指定一个文件夹。接入直接访问本地文件，不要求 Obsidian 正在运行或安装插件。

当前源码已实现主服务、设置 IPC、HTTP 网关和直连工具提供器。自动化覆盖 19 个共享工具；Windows 真实 Electron 设置操作、原生目录对话框取消、键盘开关、浅深主题窄窗口，以及 OpenCode / Continue 从聊天输入框发起的实际笔记读写均已通过。Windows x64 解包应用也通过设置到随包 MCPVault 的连接与保存验证，测试限制了子进程 Node 网络 API 和 Chromium 代理。物理断网、安装器及其他目标系统仍待验收；命令、模型调用次数和全量检查阻塞见[进度](./progress.md)。

## 文档职责

| 文档 | 唯一职责 |
| --- | --- |
| [产品需求](./prd.md) | 用户问题、范围、稳定需求 ID 和产品验收 |
| [用户故事](./user-stories.md) | 使用场景及 Given/When/Then 验收 |
| [功能逻辑](./logic-design.md) | 范围决策、状态转换、失败和取消规则 |
| [技术设计](./technical-design.md) | 模块、契约、打包、验证，以及独立章节中的 UI 设计 |
| [进度](./progress.md) | 已核对的实现事实、剩余工作和验证记录 |

界面仅在现有 MCP 设置中增加一个卡片，因此不另设 `ui-design.md`。技术设计的“UI 设计”章节承担信息结构、控件、反馈、无障碍和窄窗口适配职责；全局视觉规范仍由 [UI-DESIGN.md](../../../UI-DESIGN.md)定义。

## 术语与依赖

| 术语 | 含义 |
| --- | --- |
| 仓库（vault） | 一个本机笔记文件夹；显示名称不作为调用身份 |
| 注册仓库 | 本机 Obsidian 的 `obsidian.json` 中登记的仓库，包含当前未打开的仓库 |
| `vaultPath` | 保存的范围设置；空字符串代表注册仓库集合，非空代表指定文件夹 |
| `vaultId` | 一次工具调用选择的仓库标识，与文件相对路径分开传递 |
| MCPVault | npm 包 `@bitbonsai/mcpvault`，本功能固定使用 `0.16.0` |
| 草稿 | 设置页面尚未保存的范围，可单独测试 |

共享目录包含 `obsidian_list_vaults` 和 18 个加 `obsidian_` 前缀的上游工具。连接测试显示的上游工具数仍为 18。保存范围、切换开关或修改分配会撤销此前含 Obsidian 的请求授权，规则见[功能逻辑](./logic-design.md#授权撤销与清理)。

Node 启动环境复用[工具执行环境](../local-tool-environment/README.md)，不建立第二套解释器安装或下载配置。接入目标为直连模型、GoodBuddy 管理的本机 OpenCode 和 Continue；DeepSeek Harness 与远程执行路径沿用现有不可用边界。本功能的仓库位于桌面所在设备。
