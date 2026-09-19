# 文档处理生产实现

2026-09-19。本文描述当前源码，验收证据单独见 [progress.md](./progress.md#2026-09-19-实现与验证)。
需求 ID 沿用 [PRD](./prd.md)，界面原则沿用 [UI 设计](./ui-design.md)。

## 解析与设置

`DocumentParsingService` 统一服务聊天文档、知识库、成果导入和设置测试。`HttpDocumentOcr`
在 Main 调用 PaddleOCR-VL，`render-ocr-pdf.ts` 使用 PDF.js 和本机 Canvas 渲染选中页，
不需要本地 OCR 权重。来源未配置时继续原有本地行为；产品没有测试地址默认值。

设置文件版本为 4，读取版本 1、2、3 时保留原有设置。认证支持无需认证和 Bearer API Key，
复用 Electron safeStorage，公开快照只显示是否配置。空密钥保持现值，显式清除才删除；
任务同时固定设置与凭据读取对象，中途保存不会更换在飞请求的地址或密钥。

快速文本/索引不上传。自动 PDF 只渲染需要 OCR 的页，高保真可直接发送全 PDF。
跨页整理开启时，连续待 OCR 页组成一个 PDF 请求；不连续页分组，避免把不相邻页面合表。
PPTX 仍按原生文本和直接引用的内嵌图片处理，定位保留幻灯片号与图片序号。
普通聊天图片直传；“提取图片文字”独立调用已保存来源，忽略快速工作流的自动跳过设置。

HTTP 请求固定返回 Markdown 图片、关闭调试可视化。高级布尔值保留省略、true、false；
过滤分别保存服务默认、全部保留、自定义及其排除集合。自定义隐藏后不清空未知标签。
页面处理、图表/印章/图片块识别、Markdown 格式、跨页整理和类型化版面/生成参数可配置。
部署模型能力需以用户样例确认，连接检查只执行 health 和 OpenAPI。

响应流上限 32 MiB，单张解码图上限 12 MiB、4000 万像素，文档文字上限 500 万字符。
请求超时独立于本地单页超时；HTTP 状态和服务错误码保留，凭据和响应正文不出现在错误中。
不下载服务返回的图片 URL，不自动重试或切换 Provider。

图片按来源页和页内键解码，以 UUID 替换 Markdown 与 HTML img 引用。同名键跨页不会覆盖。
跨页整理的变化输出作为一个带完整 `sourcePages` 的分组正文；图片按实际返回字节匹配原页。
无法唯一匹配时保留原逐页结果并警告。严格索引/高保真遇缺图或重组失败拒绝替换。
服务无置信度时字段缺省，详情显示“未提供”。

## 文件与引用

```text
<userData>/
  conversation-attachments.sqlite
  conversation-assets/<conversationId>/
    images/<resourceId>/original.<ext>
    documents/<resourceId>/original.<ext>
    documents/<resourceId>/parsed.md
    documents/<resourceId>/manifest.json
    documents/<resourceId>/images/<imageId>
  knowledge/<libraryId>/<sourceId>/<managed-original>
  knowledge-assets/<libraryId>/<documentId>/<resultId>/
    parsed.md
    manifest.json
    images/<imageId>
  temp/document-parsing/<resourceId>/
```

会话资产的 `request.json` 保存已转换的请求内容，用于恢复内存 context；原件字节单独保存，
缩放和 JPEG 请求副本不覆盖原图。提取图片文件使用 UUID 无扩展名，MIME 在清单记录。
图片显式 OCR 后生成解析文件。切回原图保留已有结果，并重新进入图片能力校验。

`ConversationAttachmentStorage` 的专用 SQLite schema 1 保存描述、路径与
`draft/message/queue/parsing` 引用，不在这些描述字段内存入原图 Base64。纯图片无需解析清单。
Main 先保存资产，再保存草稿或接受队列；消息、分支建立独立引用。无有效引用才回收文件。
会话删除、项目删除及清空数据均核对引用，启动回收已无归属的记录和孤立 UUID 目录。
清理失败保留无引用数据库记录供下次重试，不回滚已接受的草稿。

助手库 schema 39 标记新附件元数据，阻止旧客户端将其当旧格式读取；没有批量改写历史附件。
知识库 schema 13 新增 `metadata.parsedResultId` 表达式索引，结果按主键定位，不扫描全部文档。
知识库新结果先写入独立 resultId 目录，数据库正文/chunks 发布成功后替换引用，再清理旧目录。
原件继续遵循 managed/reference 原有布局，reference 派生文件不写入外部目录。
旧正文重解析为空索引时保留旧结果；首次仅图片结果可预览，但显示无可索引文字。

会话图片从文档结果复制为独立原图文件，保存文档名、页码、resultId、imageId。
源文档重解析或删除不影响会话副本。添加批次串行，重复来源在同一草稿内返回已有项；
提交前重新读取目标草稿，数量/容量不符整批回滚。限额集中在 `attachment-limits.ts`：
每消息 8 项、内存 context 16 项和 12 MiB；原文件上限仍为图片 12 MiB、文档 20 MiB。

重解析与发送方式改变采用新文件资源替换草稿位置，旧消息/队列保持原 resourceId。
`attachmentId` 保留同一草稿附件身份，context 的 `id/resourceId` 随新产物更换，原始名称和来源保持。
图片 OCR 后再次切回原图会保留原 OCR 结果的副本，用户无需重跑 OCR 才能查看。

## 任务与队列

文件导入提供 operationId、读取/解析/保存阶段和取消。HTTP AbortSignal 贯穿页渲染、识别、
重组与提交检查。首次失败回滚本批附件，已保存原件用独立解析失败记录供重试，不作为可发送
草稿项。用户取消清理本批暂存；退出或进程中断后，启动将未完成记录标为中断，不自动请求 OCR。
旧结果重解析失败时保留旧草稿或知识索引。

队列保存接受时的附件和发送方式。入队、分发、实际执行分别检查图片能力。
分发失败保留队列及可恢复错误，队列预览只读；“恢复到草稿”先合并并保存附件引用，
再移除队列项，文字用空行追加，超限保持原队列。恢复后的文字由 Renderer 草稿管理。
文件附件的启动恢复不再把提前保存的用户消息误认为 Runtime 已接受并删除队列。

## 界面与边界

设置页头的测试菜单选择聊天或知识库场景，未保存禁止测试/连接检查。测试中锁定设置退出，
可取消。诊断关闭释放测试资源，没有添加到会话入口。

`DocumentResultPreview` 共用于设置测试、聊天 Modal、知识文档详情。正文支持 Markdown、
受限 HTML 表格和已登记图片；脚本、事件属性、外部资源不渲染。图片按可见区域加载 640px
缩略图，点击大图才读原图。正文/图片定位与 PageTabs 使用结果页码；详情展示保存时配置。
知识库返回列表保留查询和位置。历史附件可复制到当前草稿重新解析，不修改原消息。

附件名称、解析状态及大小与操作行分开排列；查看结果和更多操作复用 32px 图标按钮，
提供悬停与键盘焦点提示。草稿、历史和队列共用相同操作组件，菜单及 Modal 的焦点恢复
继续由共享机制处理。具体布局见 [附件操作菜单](./ui-design.md#12-附件操作菜单)。

目标会话选择显示项目与名称；新建沿用 App 的项目限制和空会话复用，保持预览。
选择、已在草稿、移除、添加、前往会话分别处理。当前没有可编辑目标时需先选择或创建。
草稿图片可提示模型/Runtime 能力问题，但允许保留；Main 才是发送与入队校验边界。
本机推理监控的模型入口直达 `model`，OCR 行直达 `document-parsing`，HTTP 服务不加入本机服务列表。

OCR 和资产管理运行于 Desktop。直连模型及托管 OpenCode 已验证实际图片输入；Agent 未增加 OCR
解析器或新附件传输协议。当前桌面消费已有图片协议；Continue、DeepSeek Harness 的本次真实视觉
调用未执行，不能由设置声明推断这些组合已经过本轮验收。
