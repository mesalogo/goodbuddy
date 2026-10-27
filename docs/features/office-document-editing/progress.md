# Office 协同编辑实施进度

## 2026-10-26：Developer Edition 品牌复测

- ShareServer 主机已切换 Developer Edition 10.0.0-169，使用本地 GoodBuddy Logo 并隐藏聊天、反馈、帮助和内置 AI；GB 右键 AI 保留。
- Developer 下三格式右键、弹窗、受控回复、源文件回写及单次撤销／重做通过。验证脚本明确等待 GB 插件就绪，避免将文档就绪等同于插件就绪。
- 当前 Developer 试用支持标准品牌；扩展 White Label 未授权，加载文字／Logo、关于和试用标识没有被绕过隐藏。
  部署及许可证唯一说明见[ShareServer 品牌配置](../../../../goodbuddy-shareserver/docs/office-branding.md)。客户端代码不依赖许可证内容。

## 2026-10-26：三格式右键 AI 弹窗

- 移除文档顶部 AI 表单，Word／PPT 文字选区右键“AI 润色…”，Excel 区域右键“AI 处理所选单元格…”。
  编辑区域内弹窗提供要求、自动生成进度、可编辑结果及应用；Excel 以表格展示结果，公式默认保护，显式允许后才可变更。
- 新增独立沙箱 Office preload，仅暴露受主 frame／文档 URL 校验的四种 AI 动作。生成复用当前对话队列和 Runtime，
  窗口打开时绑定对话，结果按请求 ID 关联，切换会话或伪造 frame 不会改发到其他目标。
- 真实 Linux Electron／Docs 10 完成三格式右键、弹窗生成、回复应用、回写、单次撤销／重做；Excel 验证公式保护、字体样式，
  PPT 验证对象坐标与尺寸（允许 OOXML 往返不超过 2 EMU 的取整）。此三格式探针使用受控会话回复；Excel 另通过原有数字格式保留验证。
- 完整构建的 GB 从 UI 创建当前对话，经过弹窗的专用 preload、生产 Main 队列和 Model Runtime，完成生成、应用与源文件回写。
  使用隔离本地模型实际请求 1 次，外部供应商请求 0 次。`verify-office-chat.py` 验证完整队列，`verify-office-ai.py` 验证真实右键及三格式编辑。
- GB 13 项定向测试、三套类型检查和生产构建通过；服务端全量 189 项测试、类型检查、lint 与生产构建通过。
  未运行 GB 全量测试、真实供应商、三平台安装包验收；本轮不包含整页生成、图表或 PPT 对象属性 AI 操作。
- 主机 ShareServer 前后端已更新，插件配置包含三格式和右键事件；需要新版 GB 的专用 Office preload，旧客户端仅展示升级提示。未发布客户端安装包。

## 2026-10-26：AI 选区应用误拒绝修正

- 服务端插件改为验证实际选区位置、段落身份和原文，不再把目标位置通知次数当作文档版本。
- 真实 Electron 增加选区读取后展开 GB AI 面板并填写要求的操作，验证失焦／布局变化后仍可应用、撤销和保存。
  DOCX 与旧 DOC 转换链路通过；实际目标变化仍被拒绝。没有模型请求，GB 产品代码无需为此修复更新。
- 插件实现与回归证据见[服务端验证记录](../../../../goodbuddy-shareserver/docs/office-10-validation.md)。

## 2026-10-26：复用连接与嵌入编辑布局

- 文档 Tab 移除地址表单，优先使用已有 Office 连接，未单独配置时复用设备共享连接。
  ShareServer `/config` 返回可选 `webUrl`，支持从 API 地址发现 Web 编辑入口。
- 移除 GB 顶部重复文件名、保存／另存为按钮与常驻保存说明；ShareServer 嵌入页移除第二层保存栏、版本和内边距。
  编辑器自身保存进入服务器，GB 原生 Ctrl/Cmd+S 回写源文件，Ctrl/Cmd+Shift+S 另存为；关闭确认仍保留。
- GB 90 项定向测试、三套类型检查、修改文件 lint 和生产构建通过。真实 Linux Electron 验证无地址输入、自动打开、
  嵌入编辑器边界等于视口、原生键盘回写、外部修改拒绝、冲突后另存为及 DOC 转换保留原件。
  测试对话框返回隔离路径，按实际保存完成状态等待后发送下一次原生按键；未声称系统对话框和三平台完整验收。
- 六格式原生保存与浏览器回调验证由[服务端记录](../../../../goodbuddy-shareserver/docs/office-10-validation.md)维护。
  本轮未调用模型，完整聊天脚本仅同步新入口，未重新运行完整 AI 往返。

## 2026-10-25：三类 Office 与旧格式转换

工作区、会话文件预览、附件菜单和本地文件选择均使用同一六格式候选列表：DOCX、XLSX、PPTX、DOC、XLS、PPT。
实际打开仍检查所连接 ShareServer 的能力。旧格式由服务端转换，GB 根据 `requiresSaveAs` 选择另存为，
Worker 拒绝将现代格式写入旧扩展名。另存成功后后续保存更新新文件；原来的本地或 Agent 文件保持不变。
Word AI 选区桥保持可用，表格／幻灯片暂不显示此工具。

实测与边界：

- 152 项 GB 定向测试通过，覆盖工作区、附件、会话预览六格式入口、传输、旧扩展名拒绝、工作栏及真实 Host 协议。
  TypeScript 检查和修改文件 lint 通过；全量测试／lint 的上一节限制仍未消除。
- ShareServer 的真实六格式上传、转换、浏览器键盘编辑、回调保存和下载内容检查通过，证据由
  [服务端验证记录](../../../../goodbuddy-shareserver/docs/office-10-validation.md)维护。
- `verify-office-desktop.py --legacy` 用真实 DOC，经产品 OfficeService／Worker／Electron／Docs 转换编辑，
  保存到 DOCX 后验证原 DOC 字节完全一致。系统文件对话框由夹具返回隔离路径，未宣称完整 App／三平台验收。
- 真实测试使用独立 API/Web 的主机 IP 地址和现有 Docs 10.0，不重启常驻 ShareServer。临时数据与进程已清理。
  本轮没有切换常驻容器、发布安装包或调用模型。

尚未完成：PDF.js 产品阅读器、开放文档格式、复杂版式／公式保真度、Excel/PPT AI 操作、远程另存为界面及三平台完整验收。
以下章节保留此前阶段的历史范围。

## 2026-10-25：共享连接、能力检查与文件入口

设置的“平台功能”新增 ShareServer 连接配置，与文档面板共用地址及能力状态；沿用原偏好键，
不预填 localhost。连接通过 Main IPC 查询 Office 配置，展示启用状态、格式及上限。
Main 打开前检查能力，未启用时不解析／读取远程来源；Worker 上传前校验格式和上限。
本轮复用既有 ShareServer API，没有新增服务或 Python 运行依赖。

工作区／附件的文件请求已改为复用连接自动打开；正在打开和已打开的相同引用不重复上传。
会话生成文件链接的预览页新增显式 DOCX 在线编辑操作，保留项目与路径进入相同分发。
无连接与失败时保留来源供配置／重试。默认阅读没有接入上传；本地 Office 阅读器仍不属于本轮交付。

验证：

- Office 传输、来源适配、文件分发、侧栏及真实 Agent 子进程协议测试共 83 项通过；设置测试 119 项通过。
- 三套 TypeScript 检查和本轮修改文件的 ESLint 检查通过。
- Linux 真实 Electron 对 `http://192.168.0.23:8088` 的生产组件测试通过：连接检查、本地选择上传、
  文件引用自动上传、插件读取／替换／撤销、保存回文件、外部修改冲突保护及另存为。
  `scripts/verify-office-desktop.py --file-entry` 可复现引用分发；测试夹具提供来源路径和系统对话框结果，
  不等同于完整 App 中所有文件来源或三平台验收。测试使用隔离本地文件，服务器保留测试上传副本。
- 全量 `npm test -- --maxWorkers=2` 在 60 秒执行窗口超时，期间数据库生命周期用例报告失败；
  该用例单独重跑通过，未定位全量运行时的原因，不能声明全量通过。
- 全量 lint 仍被既有 `tests/office-host.integration.test.ts:51` 缺少 cause 的检查错误阻挡。

本轮没有模型调用。XLSX／PPTX、完整本地阅读器及完整应用跨平台验收仍待完成。

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
# 2026-10-26 内置保存自动回写

- Office 内置保存生成服务器版本后，嵌入页经专用 preload 通知 Main，复用版本下载、摘要检查及来源 commit 自动回写；不再二次请求 forcesave。
- 重复版本、手动保存并发、关闭确认、冲突暂停和首次另存为取消均有定向回归。失败后可用保存／另存为快捷键恢复。
- 真实 Linux Electron + 主机 IP 的 Community 10.0：点击可见的内置保存按钮后，本地 DOCX 自动回写；外部修改冲突被拒绝，另存为成功；DOC 转换后自动首次另存为，原 DOC 字节不变。使用 `scripts/verify-office-desktop.py --native-save --file-entry` 和 `--native-save --legacy` 复现。系统文件对话框由测试返回隔离路径。
- 本轮未进行 Windows/macOS 验证，未发布安装包。
- 验证：GB 16 项定向测试（包含当前源码的真实 Host 子进程协议回写与旧摘要拒绝）、三套类型检查及修改文件 lint 通过；ShareServer 193 项测试、类型检查及 lint 通过。远程 Host 协议验证与 Electron 本地文件验证分别执行，未将其描述为完整远程桌面 UI 验收。
