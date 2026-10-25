/* Curated example copy. Identity, counts and states come from the existing sanitized snapshot.
   None of these titles or paragraphs are exported private user content. */
'use strict';
const icons = {
  chat:'<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h6"/>',
  notes:'<rect x="5" y="3" width="15" height="18" rx="2"/><path d="M3 7h4M3 12h4M3 17h4M10 8h6M10 12h6"/>',
  knowledge:'<path d="M3 4h6a4 4 0 0 1 3 2 4 4 0 0 1 3-2h6v15h-6a4 4 0 0 0-3 2 4 4 0 0 0-3-2H3ZM12 6v15"/>',
  settings:'<path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  panel:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  work:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  arrow:'<path d="M12 19V5m-6 6 6-6 6 6"/>',
  file:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9ZM14 3v6h6M8 13h8M8 17h6"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  terminal:'<path d="m5 6 6 6-6 6m8 0h6"/>',
  clip:'<path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`;
const projectNames = ['个人空间','日常交流','GoodBuddy','团队协作','产品设计','技术研究','随手记','知识管理与资料整理','开发工具','跨项目工作流与客户端体验优化','工作通知','文档与交付','消息'];
const conversationNames = ['一起打磨新的工作台','把组件的含义讲清楚','知识库的导入与检索体验','整理本周的设计决定','长会话里如何快速找到上下文','笔记记录与 AI 评论的关系','让亮色和暗色同样清晰','检查文档预览的阅读体验','远程工作空间的连接状态','模型选择与输入区的布局','项目切换时保留正在做的事','设计规范与后续维护'];
const noteCopy = [
  ['工作台设计手记','让聊天和手头的资料自然地放在一起。','产品设计'],
  ['知识库使用观察','资料导入之后，用户还需要知道哪些内容可以检索。','知识管理'],
  ['本周待办','留一点时间，把日常使用中不顺手的地方记下来。','工作计划'],
  ['组件语义与交互','一个按钮，应当让人知道点击之后会发生什么。','交互设计'],
  ['阅读摘记','好的工具让人专注于内容，同时随时找得到操作。','阅读'],
  ['亮暗主题对照','在不同光线下检查正文、分隔线与选中状态。','视觉设计'],
  ['远程工作记录','连接状态、执行位置与项目归属需要清楚可见。','开发'],
  ['文档交付清单','完成内容之后，再核对目录、引用和导出效果。','文档'],
  ['一些零散的想法','先记录，稍后再整理成完整的方案。','随手记'],
  ['回顾与下一步','保留决定的依据，也记下仍然没有答案的问题。','工作回顾']
];
const recordCopy = [
  ['先安排好内容的位置','聊天应该保留完整的阅读空间。需要对照资料时，在旁边打开文档；只想专注思考时，就把列表和工作区收起来。','今天先把这两种状态放在同一个窗口里比较，不为固定栏数牺牲正文宽度。'],
  ['关于组件的一个约定','导航负责进入页面，页签负责切换同级内容，筛选只改变当前列表的范围。它们的外观可以接近，含义必须明确。','状态用文字说明；正在执行、已经完成和等待确认，不应仅靠一个彩色圆点区分。'],
  ['真实内容带来的提醒','长标题需要能读到全文，大量会话需要搜索，历史失败也不能覆盖文档当前的就绪状态。','这些信息应该在需要时找得到，而不是全部挤进页面第一屏。'],
  ['留白与信息密度','阅读区域适当放松，导航和工具栏保持紧凑。相邻记录用时间和细线区分，减少重复的卡片边框。','下一次评审同时查看亮色、暗色和窄窗格，确认它们保留相同的信息层级。']
];
const documentArticle = () => `<article class="document-paper"><div class="document-kicker">GOODBUDDY / DESIGN NOTES</div><h1>一个更从容的<br>工作空间</h1><p class="document-lead">让对话、资料与行动各得其所。<br>打开需要的内容，收起暂时的干扰。</p><div class="document-rule"></div><h2><span>01</span> 从正在做的事开始</h2><p>左侧选择项目和会话，中间继续讨论，右侧阅读正在修改的文档。应用入口保持在固定位置，切换功能时不用重新寻找。</p><div class="layout-sketch" aria-label="应用导航、对象列表、聊天、工作区四栏示意"><i></i><i></i><i><span>对话</span></i><i><span>资料</span></i></div><h2><span>02</span> 给内容留出呼吸的空间</h2><p>一页只需要清楚的标题、稳定的操作位置和合适的阅读宽度。笔记保留连续记录，知识库使用列表，配置项按用途分组。</p><blockquote>信息没有变少，只是出现在更合适的地方。</blockquote><h2><span>03</span> 每个控件都有明确含义</h2><p>“关闭预览”只收起当前面板；“停止执行”才会中止任务。按钮、页签、开关和状态标签应保持可辨的边界。</p><div class="document-end">设计讨论稿 · 示例内容</div></article>`;
