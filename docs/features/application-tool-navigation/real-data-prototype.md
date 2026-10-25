# 便携版真实数据结构原型

本版现保留为数据结构核对样本。当前外观评审入口是[工作台 Demo](./workbench-demo/index.html)，其内容与数据使用边界见[工作台原型说明](./workbench-prototype.md)。以下保留本结构版的导出规则与历史验证范围。

2026-10-26，依据用户指定的 `dist/GoodBuddy-windows-x64/data`，制作[真实数据结构 Demo](./real-data-demo/index.html)。本轮将真实数量、关联与状态用于页面排列，重点覆盖聊天、魔法笔记和知识库。正式客户端未改动。

## 数据来源与导出范围

通过 Python SQLite 的 `mode=ro` 和 `query_only` 读取 `assistant.sqlite`、`knowledge.sqlite`，各数据库在各自的读事务中取样。两库并非同一原子快照；页面不据此推断跨库同时发生的事件。配置只导出 `application-settings.json` 中四个指定布尔值。

| 对象 | 本次快照 | 展示方式 |
| --- | --- | --- |
| 项目与会话 | 13 个项目、319 个会话 | 项目范围选择、会话搜索、每批追加 40 项；保留归属、时间、置顶与消息数量 |
| 消息 | 数据库共 4,906 条 | 每会话最近 12 条的角色、状态、序号、时间及长度；显示会话总量与最长消息长度 |
| 魔法笔记 | 10 篇、41 条记录 | 总览与连续记录，保留真实记录数量、更新时间、置顶和原文长度 |
| 知识库 | 2 个本地库、2 份文档、27 个分块 | 库选择、文档来源状态、分块及向量记录数；无外部绑定 |
| 知识处理任务 | 47 条 | 按库与状态筛选，查看文档关联和任务详情 |
| 图谱 | 全部库共 18 个实体、14 条关系 | 只说明全局数量，不绘制虚构关系图，不冒充当前库的数量 |
| 设置 | 通知、聊天缩略导航、磨砂特效、会话 HTML 渲染 | 以真实布尔值初始化；在弹窗内模拟切换，不执行对应产品能力 |

两份文档的来源状态均为 `ready`；处理历史包含 `succeeded`、`failed`、`cancelled` 和 `skipped`。历史失败不改写当前来源状态。向量记录数量不证明当前模型可用或索引已通过真实检索验收。

### 脱敏与替代内容

导出查询使用字段白名单。项目、会话、笔记及文档只读取标题长度，消息和笔记记录只读取正文长度，不导出原文。原始对象 ID 在内存中映射为临时编号；数据库路径、文件位置、账号、地址、Runtime 配置、错误原文及凭据不写入快照。SSH、模型和消息渠道配置未读取。

名称用别名替代；在编号前缀所需长度与 100 字上限之间参考原标题长度，因此不保证与原始名称具有相同字数或像素宽度。正文以替代文案展示，初始最多 360 字，展开最多 1,600 字，原始字数持续显示。代码、图片、表格和 Markdown 嵌套结构未保留，不能用本版评估真实富文本排版或长历史性能。

## 页面与真实组件的对应

| 页面 | 生产依据 | 本版处理及剩余差距 |
| --- | --- | --- |
| 聊天 | [ConversationSidebar](../../../src/renderer/src/ConversationSidebar.tsx)、[ChatHistoryPane](../../../src/renderer/src/ChatHistoryPane.tsx)、[Composer](../../../src/renderer/src/Composer.tsx) | 用真实会话数量、角色和文本长度检查密度；草稿按会话保留。未复刻任务子项、虚拟滚动、富文本、工具调用、附件、队列和 Runtime 选择 |
| 笔记 | [MagicNotesWorkspace](../../../src/renderer/src/MagicNotesWorkspace.tsx) | 保留全局笔记与连续记录；草稿按笔记保留，新增记录只存当前页面。评论、标签、待办、画布和来源内容未导出 |
| 知识库 | [KnowledgeWorkspace](../../../src/renderer/src/KnowledgeWorkspace.tsx)、[DocumentsView](../../../src/renderer/src/knowledge-workspace/DocumentsView.tsx)、[任务契约](../../../src/shared/knowledge-task-contracts.ts) | 第二栏选择库，主区保留文档／图谱／处理任务／设置；文件、目录、网页导入分别保留入口。当前样本只有文件来源，目录分组、任务父子层级及生产文档派生状态未复刻 |
| 设置 | [SettingsPanel](../../../src/renderer/src/SettingsPanel.tsx)、[WorkspacePrimitives](../../../src/renderer/src/WorkspacePrimitives.tsx) | 维持弹窗入口，区分设置快照值和 Demo 主题选择。只展示四项配置，完整分类、提交及离开保护待生产组件验证 |

当前工作区在各页面展示相关结构摘要，用于检查主内容被压缩后的空间。它不是生产工作栏的文件、浏览器或终端实现。宽窗口可分别收起对象列表和工作区；窄窗口可展开对象列表，主内容与工作区按需切换。这是候选响应式交互，不替代生产工作栏的停靠规则。

导入、检索、删除、重建等未接线操作打开说明，不显示模拟成功。任务详情保留历史状态、阶段、进度和时间；错误原文缺省时明确说明未导出，不补写失败原因。页签采用 `tablist/tab/tabpanel` 与方向键；筛选使用有标签的选择器；四项布尔偏好采用 Switch；预览新增消息按钮标为“添加到预览”。

## 维护与复现

```text
real-data-demo/
  index.html          # 外壳与静态资源入口
  style.css           # 候选布局；颜色和字体沿用产品基础令牌
  app.js              # 页面、状态及交互
  snapshot.js         # 已脱敏的生成数据，不含原始标题或正文
  export_snapshot.py  # 只读导出白名单元数据
  validate.cjs        # Electron 原型交互与尺寸检查
```

更新快照时，从仓库根目录执行：

```powershell
python docs/features/application-tool-navigation/real-data-demo/export_snapshot.py dist/GoodBuddy-windows-x64/data
node --check docs/features/application-tool-navigation/real-data-demo/app.js
node docs/features/application-tool-navigation/real-data-demo/validate.cjs
```

导出脚本只覆盖同目录生成的 `snapshot.js`。检查脚本中的数量断言固定为本次快照基线；更换数据后，应核对导出汇总再更新断言和本页数量，不可为测试通过随意改写。截图与隔离 Electron 用户目录位于仓库 `temp/real-data-demo-check`；审阅后运行 `node docs/features/application-tool-navigation/real-data-demo/validate.cjs --clean` 清理。

直接打开 HTML 或以仓库根目录提供 HTTP 静态服务均可。HTTP 服务的根目录不能只指向本 Demo，否则引用的产品基础样式不可达。快照随页面加载，浏览器不再访问 SQLite 或原始便携版配置。

## 评审边界

本版是基于真实元数据的结构原型，仍使用静态 HTML 组件，不是生产 React 页面、真实页面截图或完整能力对照。早期[多页面视觉 Demo](./page-design-demo/index.html)继续作为其他页面的视觉探索，不混称真实数据版。

后续复用真实组件时，优先补齐消息富文本与工具过程、笔记评论／画布和知识库操作流程，再比较同一数据下现有界面与候选界面。组件语义和维护规则见[页面内容检查](./page-content-review.md#组件语义与用户预期)，执行证据见[实施进度](./progress.md)。
