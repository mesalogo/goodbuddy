# 本地知识库文档引用

对应 [FR-LOCAL-REF](./prd.md#fr-local-ref-指定本地知识库文档) 和
[US-A-REF](./user-stories.md#us-a-ref-引用指定文件)。交互规则见 [UI 设计](./ui-design.md#9-对话中的本地文档引用)，验证见 [进度](./progress.md)。

## 文件名搜索

`Composer` 根据会话选择和知识库类型派生本地搜索范围，复用 `ExternalReferenceMenu`
及会话级引用 store。`knowledge.searchDocuments` 经生产 Preload、可信 sender 校验和
共享 Zod schema 到 `KnowledgeStoragePort.searchDocumentNames`，查询由既有 storage
utility process 执行。Main 不打开 SQLite，输入框不加载完整文档列表。

查询匹配标题及来源路径，按精确标题优先、标题、文档 ID 排序，最多返回 30 条元数据。
筛选发生在限制结果数之前，因此不受知识库普通列表的 500 条上限影响。文件名中的
`%`、`_` 按字面匹配。未启用本地库不发出查询，空范围在存储层同样返回空数组。

引用用 `local:documentId` 去重。草稿字符串使用仅在编辑器内解释的引用标记，位置与正文
保持在同一份草稿中。会话引用 store 保存标记对应的元数据；删除引用后暂留元数据供撤销
使用，发送或删除会话时释放。候选去重和 5 篇限制只计算正文中仍存在的引用。

`ComposerInput` 在第一次插入引用后使用 contenteditable 编辑，引用节点为不可编辑的
整体，来源图标复用 `ChannelIcon` 和 `Library`。普通文字输入沿用 textarea。DOM 与草稿
相同时不重建编辑区域，保留光标和输入法组合；插入、删除、撤销等操作恢复对应选择范围。
剪贴板输出可读标签，发送前将标记转换为 `@文件名 [序号]`，并按正文顺序附上库名、路径、
文档 ID 和读取说明。原始草稿标记不进入模型请求或历史。既有消息、队列和历史保存转换后
的提示，不新增持久化格式或数据库迁移。

聊天行通过 `referencedMessagePresentation` 从用户消息末尾识别完整的生成引用说明，
并回写格式比对后才拆分展示。正文按消息内容变化 memo；`MessageDocumentReferences`
复用引用折叠样式、来源图标及消息展开状态。带 text blocks 的用户消息也采用同一展示。
缺失、截断或后面附有其他正文的说明保持原文，助手消息不作拆分。历史和模型请求保留完整
提示，复制按钮输出展示正文。此改动仅涉及 Renderer，桌面与远程 Runtime 协议不变。

## 按 ID 读取

`knowledge_read` 加入共享 scoped-data tool catalog。直连模型通过 `ModelToolProvider`
调用 `KnowledgeMcpGateway.readDocument`；支持知识库 MCP 的外部 Runtime 通过同一网关的工具入口
调用。模型传入 `documentId`，网关按当前请求的 `libraryIds` 校验所属库。

正文仍以知识库存储中的分块为准。`readDocumentPage` 按 ordinal 读取已启用的非 parent
分块，避免重复读取父块。默认单次最多 12,000 个 Unicode 码点，可请求 1–24,000；SQLite
先截取文本再跨进程返回，不将完整大块传到 Main。返回的 `next` 提供下一次 ordinal 和
offset，`null` 表示结束。分页逐块进行，不承诺一次读取覆盖多块。分块重叠沿用知识库
已有设置；停用分块不出现在工具结果中。

网关在读取前后检查请求取消，文档不存在或不在本次范围内时返回错误；无可读文本时返回
文档状态和说明。引用后再关闭知识库不会绕过发送时冻结的范围。返回内容属于证据，不作为
系统指令执行。

## 本机和远程

知识正文始终由桌面知识库存储持有。支持知识库 MCP 的远程 Runtime 通过现有桥接获得同一工具目录和
读取结果，无需在远端复制文件或新增协议。共享 Linux Host 的验证从 Host 发起 MCP 请求，
读取桌面端文档的连续分页；完整桌面发送验证覆盖 App、Preload、IPC、storage utility、
模型 HTTP、工具调用及会话重载。Host 验证不等同于逐一验证全部第三方 Runtime。
