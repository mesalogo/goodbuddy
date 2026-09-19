# HTTP PaddleOCR-VL 技术设计

本设计实现 [PRD 的 HTTP 扩展](./prd.md#13-http-paddleocr-vl-扩展规划)和
[逻辑规则](./logic-design.md)。下文保留实施前的接口分析与目标约定，当前文件布局、
迁移编号、IPC 及生命周期以[生产实现说明](./implementation.md)为准；
接口证据包含 2026-09-18 探索和[2026-09-19 生产验证](./progress.md#2026-09-19-实现与验证)。

## 现有接入点

`src/main/document-parsing-service.ts` 的 `DocumentParsingService` 统一处理聊天、知识库、
成果导入及诊断。PDF 使用原生文本质量选择待 OCR 页；当前 `Map<pageNumber, section>`
只保留每页一个 OCR section。PPTX 在原生文字外识别直接引用的内嵌图片。

本地 OCR 经 `DocumentOcrBroker`、Renderer bridge 和 PP-OCRv6 WASM Worker 运行，
服务中的 PDF、PPTX 分支先检查已安装模型。`documentOcrSectionSchema.confidence`
目前必填，但 `ParsedSection.confidence` 已可选。`ParsedDocument` 尚无图片资源字段。
这些差异需显式修改，不能只替换一次网络请求。

计划在 Desktop Main 中增加一个小型 HTTP Provider，由解析服务按来源调用；本地 Broker
保留原路径。HTTP、认证、图片解码和持久化全部留在 Main，Renderer 只收状态、预览和
受管资源标识。现有 Desktop 文档解析后向 Runtime 传文本的边界继续适用；普通图片已有
独立图片请求路径。`gbagent` 无独立 OCR Worker，HTTP OCR 本身不要求 Agent 部署变更。
图片输入支持须核对本次有效模型配置及本地、远端 Runtime 实际消费路径，不作全 Runtime 保证。

## 配置与请求

计划扩展 `document-parsing-contracts.ts` 和 `DocumentParsingSettingsStore`：来源默认
`local`，HTTP 类型固定为 `paddleocr-vl`，保存用户输入的 base URL、Main 加密凭据和
类型化高级选项。设置缺少新字段时读为原有本地行为；不能把本次实测地址写为默认值。
旧设置兼容有已保存用户配置这一具体需求。设置写入仍经共享 Zod 与可信 sender 校验。

认证契约为无需认证或 Bearer API Key，不新增任意请求头编辑器。Main 从加密设置读取
密钥并构造 Authorization；Renderer 只收 configured 状态，空密钥输入表示保持现值，
清除使用显式操作。切换来源或地址不删除凭据。当前探测未验证认证部署，不能把该计划写成
已通过服务测试；实现须覆盖无认证、有效 Bearer、401 及凭据未配置的真实入口。

设置保存保留本地与 HTTP 两组值，只切换活动来源。高级布尔值采用省略/true/false，
过滤模式及自定义标签值分开保存，发送时按 L-H2 生成 `markdownIgnoreLabels`。服务默认
不展开成客户端猜测值，结果记录显式请求选项及服务返回的有效值（若有）。连接检查和
测试解析要求无未保存修改；正式解析直接走 Provider，不调用 health 或 test 作为前置。

| 接口 | 计划用途与请求 |
| --- | --- |
| `GET /health` | 连通性检查，不证明推理能力 |
| `GET /openapi.json` | 诊断部署声明的字段、类型与默认值；不动态生成任意网络调用 |
| `POST /layout-parsing` | `file` 为 Base64；`fileType: 0` 是 PDF，`1` 是图片；固定 `returnMarkdownImages: true`、`visualize: false` |
| `POST /restructure-pages` | 发送 `pages: [{ prunedResult, markdownImages }]`，其中 `markdownImages` 来自页面的 `markdown.images`；显式设置 `mergeTables`、`relevelTitles` |

默认按选中页渲染图片请求，保留准确输入页号；全页高保真可在核验页数及请求限制后使用
整份 PDF。OpenAPI 未声明页范围参数，不能发送一个猜测的 `pageNumbers` 参数并假定生效。
单页图片策略需要独立实现 HTTP 用的渲染入口，不能为使用旧 Worker 而要求安装 OCR 模型。

每次任务冻结配置，沿用原文件大小、页数、文本输出与取消边界；HTTP 增加有界响应读取和
独立请求超时。多页请求超时不能冒称单页耗时。HTTP 状态、服务 `errorCode`、任务取消及
图片解码错误分别保留，错误正文脱敏后限制长度。没有自动重试或 Provider 轮换。

## 高级参数

下表是接口字段映射，产品可配置性是规划；“声明”不代表部署模型可用。
空值语义遵循 L-H2。探测未请求 `visualize: true`，调试渲染图片不作为正文插图。

| 选项 | 类型或服务 schema 默认 | 本次证据 |
| --- | --- | --- |
| `markdownIgnoreLabels` | 可空字符串数组；schema 未列默认标签集合 | 省略、`[]`、显式排除 `text/header/footer/number` 均实测有效 |
| `useDocOrientationClassify`、`useDocUnwarping` | 可空 boolean | 仅声明，未启用验证 |
| `useLayoutDetection` | 可空 boolean | 默认结果有版面标签；未比较开关 |
| `useChartRecognition`、`useSealRecognition`、`useOcrForImageBlock` | 可空 boolean | 仅声明，未比较开关，不能推断对应模型已安装 |
| `prettifyMarkdown`、`showFormulaNumber` | boolean，默认 true / false | 使用默认值；格式开关及公式编号效果未验证 |
| `formatBlockContent`、`mergeLayoutBlocks` | 可空 boolean | 仅声明 |
| `layoutThreshold`、`layoutNms`、`layoutUnclipRatio`、`layoutMergeBboxesMode` | 数字、boolean、数组或对象等，以 schema 为准 | 仅声明 |
| `layoutShapeMode` | `rect/quad/poly/auto`，默认 auto | 未比较 |
| `promptLabel`、`repetitionPenalty`、`temperature`、`topP` | 可空字符串或数字 | 仅声明，不承诺调参收益 |
| `minPixels`、`maxPixels`、`maxNewTokens` | 可空正整数 | 仅声明，需另验有效边界 |
| `vlmExtraArgs` | 可空 object | 任意参数对象编辑不在约定范围；不影响已约定类型化高级选项的实现 |
| `restructurePages` | layout 请求中默认 false | 未测试该一体化入口，使用独立重组接口 |
| `mergeTables`、`relevelTitles` | 默认 true | 独立重组接口成组 false / true 请求成功，但结果相同 |
| `concatenatePages` | 仅独立重组请求，默认 false | 未启用验证 |
| `outputFormats` | 可空字符串数组，如 `docx` | 仅声明，导出不在本次范围 |

已知服务默认排除集合为 `number`、`footnote`、`header`、`header_image`、`footer`、
`footer_image`、`aside_text`；本次样例只实证页眉、页脚和页码的默认过滤。脚注、页眉图、
页脚图、侧栏未构造，不把完整集合误写成 OpenAPI 明示默认或全部通过测试。

## 结果与资源

`result.layoutParsingResults[]` 包含 `prunedResult`、`markdown.text`、`markdown.images`。
此部署的 `prunedResult` 没有 `page_index`，`page_count` 为 null；使用输入页映射和响应
数量检查。字段缺失是本次真实差异，无需猜测版本或伪造置信度。内部 Provider 结果计划将
confidence 改为可选，保持本地返回原值；多块内容组成逐页 section 并保留块到源页的关联，
避免当前按页 Map 丢失块。跨页输出另带原始页集合，不覆盖逐页来源事实。

插图实测为裸 Base64 JPEG，Markdown 使用 `<img src="imgs/…jpg">`。同一键可在不同页
出现，因此资源 ID 由客户端生成，Provider 图片键仅作为页内关联。计划给 `ParsedDocument`
增加图片集合，记录页号、页内键、MIME、尺寸及受管资源标识；解析暂存阶段携带有界字节，
由调用方提交所有权。只解码内联数据，验证格式及尺寸，不请求返回 URL。

现有存储不能直接宣称已覆盖该需求：

| 现有机制 | 计划复用与需补齐之处 |
| --- | --- |
| `AssistantDatabase.createImageArtifact` | 图片目前存 `artifacts.inline_content` data URI，`createInlineArtifact` 限制编码后 5 MiB。聊天解析文档改用 userData 下的文件资产与数据库引用，不复用该内联字节存储，也不借用图片生成 operation 或最多 8 项的消息生成图片列表。 |
| `deleteLocalConversation` | 当前直接删除的任务成果仅限 markdown；新 OCR 图片必须按新增文档所有者关系显式清理，不能假设删会话自动删图。项目删除已有项目成果清理路径，需合并验证。 |
| `KnowledgeService` 的 `managedRoot` | 现有受管原文件位于 knowledge/库 ID/来源 ID 下，reference 模式保留外部原文件路径。规划的 knowledge-assets 单独保存文档级解析产物，两种模式均不将派生图片写入用户原文件旁。 |
| `KnowledgeDatabase` 的文档、chunk metadata | 计划保存文档图片清单与页级引用，分块只放关联 ID，不复制 Base64；删除文档、删除来源、同步替换时一并处理图片。reference 来源删除当前不清理 managedRoot，需为派生图片补齐清理。 |

按 FR-H8 至 FR-H12 和 FR-I3，以下为约定的 `userData` 资源目录规划，不放入 Runtime 项目
工作目录。只有 `knowledge/<kbId>/<sourceId>/` 受管原文件布局已存在，其余目录待实现；
这里仅列文档与附件相关资源，不是 userData 的完整文件清单。

```text
<userData>/
  conversation-assets/<conversationId>/
    images/<attachmentId>/
      original.<ext>
    documents/<attachmentId>/
      original.<ext>
      parsed.md
      manifest.json
      images/<imageId>.<ext>
  knowledge/<kbId>/<sourceId>/
    <managed-original-files>
  knowledge-assets/<kbId>/<documentId>/
    parsed.md
    manifest.json
    images/<imageId>.<ext>
  temp/document-parsing/<operationId>/
    <staged-input-and-results>
```

会话附件原文件统一使用 `original.<ext>`，扩展名与保存字节的格式一致；原始显示名称、MIME、尺寸
及会话、消息、附件归属由数据库维护，不依赖磁盘文件名表达。文件导入保留输入原始字节；
剪贴板或截图没有源文件时保留该入口取得的原始图像，不能把请求转码副本称为外部原文件。
纯图片不要求 `parsed.md` 或 `manifest.json`。显式 OCR 后才保存关联的文档解析产物，
通过数据库引用原图片附件，无需重复复制原图。请求用的缩放、转码副本不替换 `original.<ext>`。

文档清单只描述结果需要的页码、页内图片键、受管图片 ID 和正文
引用映射，不建立版本历史或完整配置快照；数据库作为归属与引用的判断依据。随结果记录
解析时所选 Provider 和生效选项，凭据仍只在加密设置中，查看历史结果不重新读取当前配置解析。

结果契约至少增加 resultId、完整程度（完整/部分/仅图片）、页/section 到资源的映射、
来源页集合、缺页缺图诊断和上述解析元数据。任务运行状态与结果完整程度分开，避免失败
重解析覆盖旧成功结果。无文本但有图片可持久化为仅图片结果；知识库不生成空 chunk，
聊天不生成可发送的空 text context。原生、本地和 HTTP 结果使用同一预览契约，图片
集合可以为空；原生解析器不因字段存在就被宣称具有新增提图能力。

当前聊天解析文本仅在 contexts 和发送队列中使用，不能据此宣称已长期保存。
规划中草稿原文件、文本和图片先由应用暂存承接；撤销附件、批次失败或取消时仅清理本次
无有效引用的资源。`temp/document-parsing/<operationId>` 用于解析任务，不能作为一律可删
的判断依据；可恢复草稿仍引用的文件须保留，或先转入稳定资源并更新引用，再清理暂存。
启动、退出清理同样检查引用。发送被接受及队列记录持久化前须完成资源持久化及会话归属，队列保存可恢复的附件引用，
恢复发送不依赖内存 context ID 或外部原路径。持久化失败则不报告发送已接受，保留草稿供重试。
取消生成不回收已归属会话的附件。删除会话时检查有效引用，仅清理独占资源；项目删除路径
也需验证同一规则。采用暂存、现有事务和按数据库引用核对清理，不新增恢复引擎。

测试解析使用任务临时目录，结束预览且无有效引用后清理。知识库正文及 chunks 继续存数据库，
`knowledge-assets` 的 `parsed.md` 为解析正文文件，随同一次结果提交保持一致，不独立修改
或替代数据库中的检索内容。图片归知识库文档所有，不依赖聊天存活；managed 与 reference
派生文件均存该目录，reference 外部原件保持原路径，现有 managed 原件目录不迁移。
重解析或同步先在本次暂存目录完成新结果与必要资源校验，成功提交替换后清理无引用旧资源；
失败或取消只删除新暂存，保留旧正文、chunks、图片及关联。聊天草稿重解析同样成功后替换
草稿引用；历史消息和队列保持已接受结果，再解析时创建新草稿附件。若同一旧结果仍被消息
或队列引用，新结果使用新的资源 ID 和目录，不覆盖原文件字节；这是有效引用保护，不是
产品版本历史。旧结果没有有效引用后即可清理。

Markdown 提交前将 HTML 与 Markdown 图片引用改为受管资源引用，预览通过 Main 读取。
文件资产不套用内联成果的 5 MiB 编码上限；实际文件与响应容量需在实施时明确，超限须报错，
不静默压缩或丢弃。模型上下文仍按现有规则检查，不把图片文件全部计作提示词。跨页重组先传回页内图片
映射，重组后再次验证引用和源页。按 FR-I5，持久化图片集合与请求图片集合分开；后者须有
明确选中项，并校验有效模型、Runtime、数量及容量限制。选图按下节提交独立会话副本，
数量和发送容量复用既有附件限制，不能遍历已保存图片全部发送。知识库图片文字提取与索引按
知识库工作流路由，不依赖聊天模型视觉能力；图片向量索引不在本轮范围。
涉及已发布数据库结构时，实施前遵循
[数据库迁移规则](../../development/database-migrations.md)，本文不预先编造迁移编号。

## 选图与附件请求

实现 L-I3 至 L-I5、L-H9 和 [UI 第 4、5 节](./ui-design.md#4-文档插图加入会话)。
以下为需增加的契约内容，名称按实现模块风格确定，不是现有可用 IPC。

| 契约 | Main 行为与持久化 |
| --- | --- |
| 获取解析结果 | 输入归属对象 ID 与 resultId，返回正文、定位、图片描述、诊断和无凭据配置；不重新解析，不一次把全部图片 Base64 发给 Renderer |
| 读取图片或打开原件 | 输入受管资源 ID，Main 解析已登记路径；按需提供预览图/原图或用现有系统打开入口；Renderer 不提交任意磁盘路径 |
| 添加选图 | 输入目标 conversationId、sourceResultId 和去重 imageIds；核对目标可编辑、来源存在及共享限制，复制后提交草稿引用，返回新增和已存在附件 |
| 提取图片文字 | 输入图片附件 ID，使用已保存 OCR 设置启动可取消任务，成功保存结果后更新草稿的发送方式，保留原图与 provenance |
| 修改发送方式/移除附件 | 只修改目标草稿；切回图片校验能力，移除解除草稿引用并清理无引用资产，不按来源 ID 级联删除 |
| 进度/取消/结束预览 | 通过 operationId 关联任务与所属会话或测试；扩展当前只有 reading/parsing 的进度契约以表示请求、校验、保存与取消，不伪造百分比 |

共享 Zod、可信 sender 和显式 preload 方法继续使用现有边界。结果读取和归属查找用
数据库主键或索引，不扫描全部会话/全部知识库文档。UI 的目标选择由 App 通过现有项目、
会话导航和 `startNewConversation` 管理；KnowledgeWorkspace 接收回调，不自行创建
会话 store。已有 `onUseInChat` 会修改检索选择，不能用它代替图片添加回调。

文档插图复制到 `conversation-assets/<conversationId>/images/<attachmentId>/original.<ext>`，
由 Main 从已验证的源文件复制，禁止 Renderer 回传 Base64 再导入。附件数据库字段记录
原名称、显示名称所需信息、MIME、尺寸、原始字节数、resourceId、发送方式，以及来源类型、
源文档/附件 ID、resultId、imageId、文档名、页码/定位。provenance 的可读信息在源删除后
仍保留，源 ID 仅用于仍有效时跳转。跨库复制不建立删除级联外键，不做跨会话物理去重。

添加前在 Main 先去掉同一草稿已经引用的来源图片，再计算全批数量和请求容量；重复调用
沿用已有附件 ID。草稿操作串行提交并用数据库唯一性约束保证幂等，不以禁用按钮作为唯一
保证。文件复制到本次暂存后移入新附件目录，再在事务内登记文件与草稿归属；失败删除
本批新文件，不删除已有副本。重启只核对无数据库引用的暂存或孤立新目录，已登记草稿
资源继续保留，不增加写前日志或恢复引擎。

当前限制来源是 `src/shared/contracts.ts` 的 `contextIds.max(8)`、导入数组上限及
`maximumPastedImageBytes`，Main 的 `ContextManager` 另有 8/16/12 MiB 常量；实现时将
这些同义值集中到共享附件契约供现有导入、选图、草稿与发送复用，保持已发布数值。源文件
限制仍区分图片与文档，不能套用生成成果 5 MiB 编码限制或发明“文档最多选几张”。
Provider 响应和解码资源的有界读取属于解析限制，不等同发送附件数量。超过任何限制均给
具体原因；选图整批拒绝，不复用 App 当前对新增文件 `slice` 接受剩余位置的行为。

`ContextManager` 对持久化图片生成既有有界请求副本，原图保持不变；提取文字模式只构造
text context。解析父文档只拼入一次全文，图片副本仅携带简短来源及图像。草稿、消息和
队列保存附件资源引用与发送方式，不能仅序列化会过期的内存 contextId。执行从这些资源
恢复 context 并重新检查真实模型/Runtime 能力，完整校验后才接受发送或入队。
仅图片父文档计入消息附件数并保留原件引用，但不创建空文本 context；发送前核对同批已有
来自该结果的选图或提取文字，提示及恢复操作遵循 L-I5。

队列开始执行及重启恢复再次检查实际能力；失配沿用可恢复队列错误，保持资源及内容，
提供恢复到草稿修正。恢复时先提交草稿引用再删队列引用，失败保留队列；用户修改提取文字
方式再发送产生新的队列输入。取消生成保留已发送附件，删除队列只释放该项引用。分支
会话复制已发送附件时也必须建立有效归属引用或独立副本，不能只复制原目录字符串；不改变
既有分支产品范围。会话和项目删除使用同一按有效引用清理路径。

图片能力检查必须落在 Main/Runtime 请求边界，并在 UI 展示同一结果。Desktop 直连模型、
本地 Runtime 与托管 SSH 的图片消费须分别核对；仅工具持有引用不算模型收到图。HTTP
OCR 位于 Desktop 不自动证明选图发送不涉及 Agent；若实现改动远端附件协议或消费路径，
必须按根 AGENTS 的共享 Linux Host 规则实测，记录具体 Runtime/模型组合及模型收到的输入。

## 预览实现

共享预览组件只接收受管结果、目标草稿状态与动作回调。设置、聊天 Modal 和知识库详情
负责外壳，沿用 [UI 容器映射](./ui-design.md#1-容器与共享组件)。PageTabs 的 idPrefix
按实例区分，详情滚动、页码定位和勾选状态在同一预览内保留，切换对象时清除旧对象选择。

现有 `MarkdownRenderer` 使用 `skipHtml`，`renderHtml` 只处理完整 HTML 或围栏，不能
直接显示混合 Markdown 中的 OCR `<img>`、`<table>`。需为解析预览增加受限内容适配：
用结构化 HTML 解析将已支持表格元素及受管图片节点映射到既有排版组件，移除脚本、事件
属性和外部资源，不开启全局任意 HTML 渲染。Markdown 与 HTML 图片统一通过清单解析
imageId，缺失引用换成诊断文字；HTML 表格保留行列及合并关系。页码链接使用结果的
sourcePages，不从文件名猜测。继续沿用应用既有静态内容安全边界，不引入新的文档授权流程。

图片按可见内容加载，缩略图与原字节分开；组件关闭释放本次预览 URL。结果读取失败只
替换相应面板并提供重试，不清掉其他正文或草稿。测试任务目录在关闭结果后清理；未关闭
预览期间不能因为 HTTP 任务已完成就删除图片。测试重跑成功后才替换当前预览，失败
保留上次结果并标明该结果属于上次测试。测试不建立草稿、会话或知识库引用。

取消贯穿渲染、Provider、重组和保存，在资源提交前检查取消；迟到响应不写入当前对象。
保存事务已成功后的取消按完成结算，不把已提交结果删除后报告“取消成功”。退出后未完成
任务只标中断并允许手动重试；数据库引用是清理依据，任务目录名不是删除许可。

## 实施与验证顺序

以下是同一完整功能的依赖顺序，不定义缩减版交付。验收范围以
[完整矩阵](./ui-design.md#8-完整验收矩阵)为准。

1. 按已完成的 UI 设计实现来源设置、Main HTTP Provider 和可选 confidence，验证无本地模型的真实解析入口、保存前禁止测试及凭据保留。
2. 补文件结果契约、纯图片与文档分目录、聊天与知识库归属、发送入队及删除；验证原图保留、重启重开、草稿引用保护、外部原文件移除、队列恢复、同名图片键、reference 来源删除、重解析失败和测试清理。
3. 接入类型化高级选项及逐页 PDF/PPTX 路由；以真实开关样例验证高级模型能力。
4. 补能触发合并的连续表格样例与来源映射，再接入可选跨页重组。不能以本次两组输出相同的请求作为该步骤完成依据。
5. 按 L-I1 至 L-I5 接入有效图片能力、不支持提示、显式提取文字及选图入草稿和发送；覆盖成功后的文本模式、父文档正文去重、独立移除、目标选择/新建、添加幂等、共享限额、来源删除后副本持久和本地/远端 Runtime 消费。
6. 从设置、聊天和知识库真实入口验收共享预览、完整/部分/仅图片状态、取消与重启、队列修正、资产清理；验证键盘、两主题、窄容器和原生浏览器遮挡。只有这些产品路径均完成，才可将对应需求记为已实现。

产品验收覆盖聊天、知识库和测试解析、HTTP 错误、缺图、取消和重开。已运行的层次、
全仓测试及尚未覆盖的场景见进度。原独立探测脚本及历史记录保留，不与本轮调用数混算。
