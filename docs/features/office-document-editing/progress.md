# Office 协同编辑实施进度

## 2026-10-25：统一 ShareServer 后端后的 IP 内网复测

ShareServer 的 Office 已迁入统一 Node/Hono 后端，React 前端独立部署；不再依赖 FastAPI。
两仓库 AGENTS.md 明确内网仅有 IP、无域名是正常开发测试场景。主机服务现运行于
`http://192.168.0.23:8088`，Docs 为 `http://192.168.0.23:8080`，地址只用于本次验收记录。

`scripts/verify-office-desktop.py` 连接这套真实服务通过：生产面板上传和编辑、插件选区读取、
替换、单步撤销、过期目标拒绝、保存回本地、外部修改冲突保护、冲突后另存为及关闭。
系统文件对话框仍由测试夹具返回隔离路径，尚不能视为三平台完整交互验收。
脚本的 DOCX 夹具改从相邻仓库 `scripts/office-e2e/fixtures.py` 导入，不依赖 Python 后端。

完整构建应用的 `scripts/verify-office-chat.py` 也已通过：选区 → 现有会话队列 → 所选
Model Runtime → 回复应用到原选区 → 保存回源文件。使用隔离本地确定性模型端点，实际请求
累计 2 次（含最终服务与重启后的复测），外部供应商请求 0 次；证明产品队列和模型协议接通，
不等同于真实供应商质量验收。
修正了测试驱动阻塞 Playwright 事件循环及通过 IPC 更新配置后未刷新渲染层的夹具问题。

以下为较早阶段的历史记录，当前架构以本节和 ShareServer 部署文档为准。

## 2026-10-25：本地 DOCX Desktop 首条链路

已实现工作栏多实例 `document`、本地文件选择、独立 WebContentsView、后台上传、保存回文件、
另存为、SHA-256 冲突检查和关闭确认。相同源文件重复选择返回已有实例，面板聚焦原页签；
切换页签隐藏视图而不销毁会话。退出取消不销毁前面已确认的文档视图。服务端新增简洁编辑页、
指定 revision 下载与摘要，详见[服务端接口](../../../../goodbuddy-shareserver/docs/features/share-server/technical-design.md#101-私有部署第一阶段待实现)。

真实验证使用 Linux Electron、生产 `OfficePanel → preload IPC → OfficeService → Worker`，连接
独立 Community 10.0 栈。系统文件对话框在测试驱动中返回隔离测试路径，其余编辑、保存、回调、
下载及写入均使用实际实现。通过：DOCX 打开、键盘修改后回写、源文件外部修改后拒绝覆盖、
冲突后另存为、通过 IPC 关闭。不是完整 App、操作系统文件对话框或三平台验收。

复现：先启动独立 Office 测试栈、安装 Python Playwright 和相邻 ShareServer 测试依赖，确保
Node、Xvfb 可用，在 GB 根目录执行 `python scripts/verify-office-desktop.py --web http://127.0.0.1:18088`。
脚本编译当前生产模块，在 `temp/office-desktop-*` 使用隔离数据并清理；服务端上传副本留在
调用者指定的测试栈。禁止指向业务文档服务。

定向 105 项测试通过（文件传输、工作栏契约、工作栏交互及侧栏）；最终三套 TypeScript 检查
分项通过，lint 与 `npm run build:bundle` 通过，构建出的 ESM Office Worker 实际上传通过。
全量 GB 测试尝试时主机 swap 耗尽、负载超过 200，已停止本轮测试，不能声明全量通过。
本地预览 Demo 的浏览器／Node 全局变量 ESLint 配置已补齐。

尚未完成：工作区／成果／附件快捷入口，远程源文件，操作取消与重启恢复，真实聊天 Runtime
选区桥，XLSX／PPTX，系统输入法及完整应用退出的端到端验收。完整 PRD 仍未交付；没有模型调用。

## 2026-10-25：同步本地预览与 ShareServer 10.0 验证

本轮先在干净的 `main` 执行 `git pull --ff-only`，从 `849badf7` 快进到 `c8ef4ed4`。
新增提交为设置导航间距修正 `f5fb1efe` 和本地 Office 预览 Demo `c8ef4ed4`。
已核对 Demo 的解析路径、依赖、ONLYOFFICE 未接入状态及验证脚本；本轮未重跑 Demo，
其 Windows Edge 结果引用 [Demo 原始验证记录](./local-preview-demo/README.md#验证记录)。

| 范围 | 已核实事实 | 尚未完成 |
| --- | --- | --- |
| 本地只读预览 | 独立网页按需加载 DOCX、XLSX、PPTX、PDF 解析器，文件内容不上传 | Desktop 入口、远程文件读取、产品性能及跨平台验收 |
| 服务端 DOCX 编辑（FR-3／FR-4 的服务端部分） | 独立 FastAPI + React + Community Docs 10.0；真实编辑保存、关闭重开、API 重启持久化通过 | GB 文档页签、保存回本地／远程源文件、另存为与冲突处理 |
| 选区能力探针（FR-6／FR-14 的部分依据） | 普通插件读取未保存选区、局部文本替换、一次撤销、中文修改保存重开通过 | 真实模型往返、请求期间目标变化检查、高亮、重做、多操作事务及复杂格式 |

服务端环境、镜像 digest、测试步骤与脚本由
[ShareServer 10.0 验证记录](../../../../goodbuddy-shareserver/docs/office-10-validation.md)统一维护。
插件探针通过浏览器测试配置加载，尚未成为生产插件或 Desktop IPC；未调用模型。
DOCX 简单文本成功不能推导 XLSX／PPTX 编辑、Automation API 或 Electron 已通过。

本轮更新文档以对齐实际接口、前后端分离、普通插件接入方向及本地预览边界；未修改产品代码。
后续顺序见[技术设计第 10 节](./technical-design.md#10-实施顺序)。Desktop 完整验收仍按 PRD，
不将独立 Demo 或浏览器探针标记为产品已交付。
