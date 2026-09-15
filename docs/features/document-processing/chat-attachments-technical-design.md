# 聊天附件技术说明

产品规则见 [PRD 的聊天附件入口](./prd.md#321-聊天附件入口)，输入区布局与反馈遵循
[UI 设计系统](../../../UI-DESIGN.md)。本文说明本地文件选择、文件粘贴和截图粘贴的实现。

## 文件导入链路

`App.tsx` 在 textarea 的 `paste` 事件中同步读取 `clipboardData.files`。没有文件时
保留浏览器默认文本粘贴。有文件时阻止默认插入，并通过 preload 的
`context.getFilePath(file)` 调用 Electron `webUtils.getPathForFile`。

有本地路径的文件调用 `context.importFiles(paths)`，经 `context:import-files` IPC 到
Main。IPC 先验证可信 sender，再使用共享 `contextImportFilesSchema` 校验输入。
没有本地路径的截图沿用 `context.addPastedImage`；无路径的非图片文件和混有无路径项目
的本地文件批次显示可处理的错误，不静默丢弃项目。

`ContextManager.selectFiles` 只负责文件对话框，再调用与粘贴共用的 `importFiles`。
这个方法完成路径规范化、格式及大小检查、文本读取、图片转换、文档解析与上下文暂存。
任一文件失败时删除本批次已经暂存的项目，保留之前的附件。文件系统错误不向 Renderer
暴露绝对路径。

两种文件入口均发送 `context:file-selection-progress`。Renderer 共用正在导入状态、
附件上限处理和附件清理逻辑，解析期间禁用附件按钮并阻止发送。成功结果加入发起操作的
会话草稿；发送时通过已有 `contextIds` 和 `ContextManager.enrichRequest` 生成请求上下文。
本次变更不修改 Agent、远端协议或 Runtime 的附件消费实现。

## PPTX 图片识别与 OCR 生命周期

产品策略与限制分别见 [PPTX 图片流程](./prd.md#75-pptx-图片流程)、
[OCR 空闲资源回收](./prd.md#76-ocr-空闲资源回收)。

`DocumentParsingService` 在非快速工作流中使用 `knowledge/pptx-parser.ts` 读取
演示文稿顺序、幻灯片文字、图片关系和内嵌图片。Office ZIP 读取复用
`document-parser.ts` 的条目数量、单条目及总展开大小检查；不读取工作区中的关联文件。
每张引用图片通过现有 `DocumentOcrBroker` 的图片请求契约，进入生产
`document-ocr-bridge.ts` 和 WASM Worker。结果合并时保留原生文字，附上幻灯片页码、
图片定位及 OCR 置信度，诊断中的 OCR 页数按页码去重。

Bridge 用待完成请求计数判断队列是否空闲，正常完成后安排一次空闲计时；
新请求和 `terminateWorker` 均清除计时。到期通过 `Worker.terminate()` 释放整个推理环境，
而不是只清空 JavaScript 引用或反复触发垃圾回收。此机制由 PDF 与 PPTX 共用，
不增加 IPC、持久化设置或模型安装状态。

解析与回收发生在 Desktop 的 Main/Renderer，`gbagent` 不运行此 OCR Worker。
远程 Runtime 消费的仍是 Desktop 已提取的附件文本，没有单独的 Agent 解析器或
需要同步修改的远程 OCR 生命周期。

## Electron 验证

2026-09-15 在 Windows 的 Electron 43.2.0 上，从当前源码构建隔离输出并启动完整应用，
使用独立用户数据目录，保持 `sandbox: true`、`contextIsolation: true`。

已实际验证：

- Windows `Shell.Application` 的文件 `copy` verb 生成系统剪贴板后，原生粘贴事件提供
  `File` 和有效路径，TXT 出现在聊天附件区。
- `CF_HDROP` 同时携带 TXT、DOCX 时，两个文件经生产 preload、IPC 和解析器成为附件；
  DOCX 发出 `reading`、`parsing` 进度，包含正确文件名及 `2 / 2` 批次序号。
- 普通文本原生粘贴进入草稿，后续文件粘贴保持文字不变。
- ZIP 经生产导入路径报出不支持类型，已添加附件仍在。
- 系统图片剪贴板产生的 `image.png` 没有本地路径，仍通过截图入口生成图片附件。

以上使用原生 `webContents.paste()`，未伪造 DOM 粘贴事件或替换附件实现。Windows Shell
复制测试没有操纵资源管理器窗口中的键盘。产品未增加 Win32 剪贴板读取或兼容代码。
探测程序的原生调用仅用于构造文件剪贴板和保存、恢复测试前的剪贴板对象；最终探测的
`OleSetClipboard`、`OleFlushClipboard` 均返回成功。早期一次探测的恢复调用返回错误，
无法追溯确认该次剪贴板是否完整恢复。

macOS、Linux 文件管理器的实际剪贴板行为尚未在本次环境验证。没有发起模型调用；附件
进入发送请求的 `contextIds` 由 Renderer 回归测试验证，完整文档内容进入请求由生产
`ContextManager` 的真实文件解析测试验证。

## 自动检查

聚焦用例位于 `src/main/context-manager.test.ts`、`src/main/ipc.test.ts`、
`src/preload/context-files.test.ts`、`src/shared/context-contracts.test.ts` 和
`src/renderer/src/App.test.tsx`，覆盖多文件、进度、重复粘贴、发送上下文、错误与草稿保留、
大小及数量限制、批次回滚、可信 sender、输入契约和截图/文本回归。

```text
npx vitest run src/main/context-manager.test.ts src/main/ipc.test.ts src/preload/context-files.test.ts src/shared/context-contracts.test.ts src/renderer/src/App.test.tsx
npm test
npm run typecheck
npm run lint
```

本次最终拆分检查通过 6 项附件相关 Renderer 用例和 160 项 Main、IPC、preload、契约及
沙箱用例，类型检查与 lint 通过。完整 `npm test` 运行结果为 4214 项通过、67 项跳过、
6 项窗口恢复用例失败；这些用例属于并行修改的 `window.test.ts`，随后该文件单独复跑
10 项全部通过。本次没有再次完整重跑全仓测试。

## 2026-09-15 PPTX OCR 与空闲回收验证

在 Windows x64、Electron 43.2.0 上，从本次源码构建独立输出，使用独立用户数据目录和
本机已安装的 PP-OCRv6 Tiny 模型完成真实验证。测试仅替换系统文件选择对话框的返回路径，
保留生产 UI、preload、IPC、`ContextManager`、解析服务、OCR Broker 与 WASM Worker，
未替换解析或推理实现。

- 从“添加附件”一次导入 4 份图片型 PPTX，共 40 页；4 个附件均成功显示，连续处理期间
  仅创建 1 个 OCR Worker。
- 队列空闲后观察到 Worker 被终止。每 5 秒读取 Electron `app.getAppMetrics()`：
  Renderer 工作集采样高点为 733,492 KiB（约 716 MiB），回收后为 162,716 KiB
  （约 159 MiB），启动基线约 163 MiB。该结果是本次设备与文件上的测量，不是固定内存承诺。
- 回收后，通过生产 `context.importFiles` 再导入一份 9 页 PPTX；新建第 2 个 Worker，
  9 页均返回非空文字，共 2,462 字符，附件成功生成。
- 本次合计 49 次本地图片 OCR 请求，文本模型调用 0 次；没有发送聊天消息，也没有将文件
  交给云端模型。未修改源文件。未在 macOS、Linux 或其他 OCR 模型档位上做本次实测。

新增聚焦回归覆盖 PPTX 关系与顺序、各场景路由、原生文字合并、快速模式、页数上限、
OCR 错误和取消；Worker 回归覆盖空闲到期、连续请求复用、队列保护、关闭清理与立即取消。
空闲回收后重新加载也在真实模型路径上验证，不能只用模型配置检查代替。

最终检查：`npm test` 4,293 项通过、67 项跳过；`npm run typecheck`、
`npm run lint` 通过。当前源码的隔离 Electron 生产构建通过；文档的 10 个相对文件链接
均有效。测试应用已关闭，包含附件草稿的独立用户数据目录已删除，原文件和原模型安装未改动。
