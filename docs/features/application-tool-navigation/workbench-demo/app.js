'use strict';
const data = window.PORTABLE_SNAPSHOT;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button = (label, action, value = '', cls = '') => `<button type="button" class="${cls}" data-action="${action}" data-value="${esc(value)}">${label}</button>`;
const date = value => value ? new Intl.DateTimeFormat('zh-CN', {month:'short',day:'numeric'}).format(new Date(value)) : '刚刚';
const names = new Map(data.conversations.map((c,i) => [c.id, i < conversationNames.length ? conversationNames[i] : `${['讨论','梳理','检查','改进','记录'][Math.floor(i/conversationNames.length)%5]}${['项目导航','文档处理','知识检索','笔记编辑','模型配置','页面交互','任务执行','内容排版','应用入口','运行反馈','数据同步','发布流程'][i%12]} · ${Math.floor(i/60)+1}`]));
const projectName = id => projectNames[data.projects.findIndex(p=>p.id===id)] || '当前项目';
const noteTitle = n => n.title || noteCopy[data.notes.indexOf(n)%noteCopy.length][0];
const noteDescription = n => noteCopy[data.notes.indexOf(n)%noteCopy.length][1];
const libraryName = id => data.libraries.findIndex(k=>k.id===id)===0 ? '产品与设计资料' : '日常参考资料';
const formatName = d => ({'application/pdf':'PDF','text/markdown':'Markdown','text/plain':'TXT','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'DOCX'}[d.format] || '文档');
const docName = d => `${data.documents.indexOf(d)===0?'工作空间设计规范':'产品使用与维护指南'}.${({'PDF':'pdf','Markdown':'md','TXT':'txt','DOCX':'docx'}[formatName(d)] || 'txt')}`;
const labels = {ready:'已就绪',succeeded:'成功',failed:'失败',cancelled:'已取消',skipped:'已跳过',queued:'排队中',running:'运行中','document-process':'处理文档','source-sync':'同步来源','document-rebuild':'重建文档','library-rebuild':'重建知识库','embedding-rebuild':'重建向量索引','graph-rebuild':'重建图谱'};
Object.assign(labels,{parsing:'解析文档',embedding:'生成向量',graph:'提取图谱',syncing:'同步来源',reading:'读取内容',chunking:'划分分块',indexing:'建立索引',finalizing:'完成处理',interrupted:'已中断'});
const status = s => `<span class="status ${['ready','succeeded'].includes(s)?'good':s==='failed'?'bad':''}">${['ready','succeeded'].includes(s)?icon('check'):''}${esc(labels[s] || s)}</span>`;
const state = {page:'chat',conversation:data.conversations[0].id,project:'all',query:'',limit:24,note:null,noteQuery:'',library:data.libraries[0].id,tab:'documents',docQuery:'',filter:'all',work:innerWidth>1000,workTab:'document',drafts:{},sent:{},noteDrafts:{},added:{},objects:true,drawer:false,share:51,selection:null,todos:[true,true,false],scroll:{}};
const nav = [['chat','聊天'],['notes','笔记'],['knowledge','知识库']];
const current = () => data.conversations.find(c=>c.id===state.conversation);
function notify(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(notify.timer);notify.timer=setTimeout(()=>$('#toast').hidden=true,3200);}
function modal(title,content){$('#dialog-title').textContent=title;$('#dialog-body').innerHTML=content;if(!$('#dialog').open)$('#dialog').showModal();}
function searchbox(id,placeholder,value=''){return `<label class="searchbox">${icon('search')}<input id="${id}" aria-label="${placeholder}" placeholder="${placeholder}" value="${esc(value)}"></label>`;}
function tabset(group,items,selected,action,cls='tabs'){return `<div class="${cls}" role="tablist" aria-label="${group==='work'?'工作区内容':'知识库内容'}">${items.map(([id,label])=>`<button type="button" role="tab" id="${group}-${id}" aria-controls="${group}-panel" aria-selected="${id===selected}" tabindex="${id===selected?0:-1}" data-action="${action}" data-value="${id}">${label}</button>`).join('')}</div>`;}
function renderRail(){
  $('#rail').innerHTML=nav.map(([id,label])=>`<button data-action="page" data-value="${id}" aria-label="${label}" title="${label}" ${state.page===id?'aria-current="page"':''}>${icon(id)}<span>${label}</span></button>`).join('')+`<div class="rail-line"></div>${button(icon('grid')+'<span>组件</span>','components')}<div class="rail-spacer"></div>${button(icon('settings')+'<span>设置</span>','settings')}`;
}
function conversationRows(){
  const rows=data.conversations.filter(c=>(state.project==='all'||c.project===state.project)&&names.get(c.id).includes(state.query));
  return `<div class="list-caption"><span>最近会话</span><span>${rows.length}</span></div>${rows.slice(0,state.limit).map(c=>`<button class="object-row" data-action="conversation" data-value="${c.id}" title="${esc(names.get(c.id))}" ${c.id===state.conversation?'aria-current="true"':''}><strong>${esc(names.get(c.id))}</strong><small>${date(c.updatedAt)}${c.pinned?' · 已置顶':''}</small></button>`).join('')||'<p class="empty">没有匹配的会话</p>'}${rows.length>state.limit?button('显示更多','more','','quiet'):''}`;
}
function renderObjects(){
  let content='';
  if(state.page==='chat')content=`<div class="object-header"><select id="project" aria-label="项目范围"><option value="all">全部项目</option>${data.projects.map(p=>`<option value="${p.id}" ${state.project===p.id?'selected':''}>${projectName(p.id)}</option>`).join('')}</select>${button(icon('plus'),'new-chat','','icon')}</div>${searchbox('conversation-search','搜索会话',state.query)}<div class="object-list" id="conversation-list">${conversationRows()}</div><div class="object-foot">${icon('chat')}<span>${data.projects.length} 个项目 · ${data.conversations.length} 个会话</span></div>`;
  if(state.page==='notes')content=`<div class="object-header"><h2 class="grow">魔法笔记</h2>${button(icon('plus'),'new-note','','icon')}</div>${button('全部笔记 <small>'+data.notes.length+'</small>','note','','object-row')}<div class="object-list"><div class="list-caption">最近更新</div>${data.notes.map(n=>`<button class="object-row" data-action="note" data-value="${n.id}" ${state.note===n.id?'aria-current="true"':''}><strong>${esc(noteTitle(n))}</strong><small>${n.entries.length+(state.added[n.id]?.length||0)} 条记录</small></button>`).join('')}</div><div class="object-foot">${icon('notes')}<span>全局 · 个人笔记</span></div>`;
  if(state.page==='knowledge')content=`<div class="object-header"><h2>知识库</h2></div><div class="list-caption">本地知识库</div><div class="object-list">${data.libraries.map(k=>`<button class="object-row" data-action="library" data-value="${k.id}" ${state.library===k.id?'aria-current="true"':''}><strong>${libraryName(k.id)}</strong><small>${data.documents.filter(d=>d.library===k.id).length} 份文档 · ${k.storage==='managed'?'托管存储':'引用存储'}</small></button>`).join('')}</div><div class="object-foot">${icon('knowledge')}<span>资料与来源</span></div>`;
  $('#objects').innerHTML=content;
  $('#objects [data-action=new-chat]')?.setAttribute('aria-label','新建会话');
  $('#objects [data-action=new-note]')?.setAttribute('aria-label','新建笔记');
}
function chatPage(){
  const isFirst=state.conversation===data.conversations[0].id;
  return `<section class="chat"><div class="history" id="history"><div class="reading"><div class="user-message">${isFirst?'我想让新的界面更清爽，但真实的内容和操作都要保留下来。我们从哪里开始？':`我们一起看看「${esc(names.get(state.conversation))}」，把接下来要做的事梳理清楚。`}</div><article class="assistant-copy"><div class="assistant-mark"><span class="brand">G</span> GoodBuddy</div><p>${isFirst?'先从每天使用最多的工作空间开始：左边找到会话，中间继续讨论，右边对照资料。让每个区域承担清楚的职责。':'先明确当前任务和需要保留的信息，再检查它们在实际窗口中的位置。我整理了一个可以边讨论、边查看的文档。'}</p><details class="process"><summary>查看设计依据</summary><p>沿用当前产品的项目选择、会话列表、笔记连续记录和知识库文档／处理任务分区。文档内容根据本次设计讨论编写。</p></details><h2>把空间留给正在做的事</h2><p>应用入口保持稳定；项目列表可以收起。打开资料后，文档有自己的阅读空间，聊天也能继续。</p><ul><li><strong>聊天：</strong>正文与输入框对齐，工具过程按需展开。</li><li><strong>笔记：</strong>保留连续记录，让新的想法自然接上。</li><li><strong>知识库：</strong>当前文档状态与历史处理结果分开呈现。</li></ul><p>右边是这次讨论的设计稿。可以拖动分隔线调整宽度，也可以先把决定记进笔记。</p>${button(`<span class="file-glyph">${icon('file')}</span><span class="grow"><strong>工作空间设计.md</strong><small>设计讨论稿 · 点击在工作区阅读</small></span><span>↗</span>`,'open-document','','file-link')}<div class="message-actions">${button('记入笔记','capture')}${button('查看知识库','page','knowledge')}</div></article><div id="sent-messages">${(state.sent[state.conversation]||[]).map(t=>`<div class="user-message">${esc(t)}</div><p class="meta">已添加到预览，未调用模型。</p>`).join('')}</div></div></div><div class="composer-wrap"><form id="chat-form" class="composer"><textarea id="chat-draft" aria-label="消息草稿" placeholder="继续讨论，或者提出一个新的想法…">${esc(state.drafts[state.conversation]||'')}</textarea><div class="actions">${button(icon('clip'),'attach','','icon')}<span class="runtime">OpenCode</span><span class="grow"></span>${button('GPT-6 ⌄','model','','runtime model')}<button class="icon send" type="submit" aria-label="发送预览消息">${icon('arrow')}</button></div></form><div class="composer-foot"><span>${esc(projectName(current()?.project))}</span><span>演示会话 · 不调用模型</span></div></div></section>`;
}
function notesPage(){
  const n=data.notes.find(n=>n.id===state.note);
  if(!n)return `<div class="page"><header class="page-header"><div><span class="eyebrow">全局 · 个人空间</span><h1>把想法留在这里</h1><p>${data.notes.length} 篇笔记，随时接着写。</p></div>${button(icon('plus')+'新建笔记','new-note','','primary')}</header><div class="toolbar">${searchbox('note-search','搜索笔记',state.noteQuery)}<span class="meta">最近更新</span></div><div class="note-grid" id="note-grid">${noteCards()}</div></div>`;
  return `<div class="page"><div class="note-reading"><header class="page-header"><div><span class="eyebrow">魔法笔记 · ${date(n.updatedAt)}</span><h1>${esc(noteTitle(n))}</h1></div>${button('全部笔记','note','','quiet')}</header><span class="tag">${noteCopy[data.notes.indexOf(n)%10][2]}</span><form id="note-form" class="note-compose"><textarea id="note-draft" aria-label="新记录" placeholder="有了新的想法，就接着记下来…">${esc(state.noteDrafts[n.id]||'')}</textarea><div class="actions"><small>追加记录</small><button type="submit" class="primary">保存记录</button></div></form>${(state.added[n.id]||[]).map(t=>`<article class="record"><small>刚刚 · 新记录</small><p>${esc(t)}</p></article>`).join('')}${n.entries.map((e,i)=>{const r=recordCopy[(i+data.notes.indexOf(n))%4];return `<article class="record"><small><span class="record-number">${String(n.entries.length-i).padStart(2,'0')}</span>${date(e.createdAt)}</small><h2>${r[0]}</h2><p>${r[1]}</p><p>${r[2]}</p></article>`;}).join('')||'<div class="empty">还没有记录，从上面写下第一条。</div>'}</div></div>`;
}
function noteCards(){return data.notes.filter(n=>(noteTitle(n)+noteDescription(n)).includes(state.noteQuery)).map(n=>`<button class="note-card" data-action="note" data-value="${n.id}"><span class="note-symbol">${icon('notes')}${n.pinned?'置顶笔记':''}</span><h2>${esc(noteTitle(n))}</h2><p>${esc(noteDescription(n))}</p><small>${date(n.updatedAt)} · ${n.entries.length+(state.added[n.id]?.length||0)} 条记录</small></button>`).join('')||'<p class="empty">没有找到笔记，试试其他关键词。</p>';}
function knowledgePage(){
  const docs=data.documents.filter(d=>d.library===state.library),tasks=data.tasks.filter(t=>t.library===state.library),k=data.libraries.find(k=>k.id===state.library);
  let body='';
  if(state.tab==='documents')body=`<div class="toolbar">${searchbox('doc-search','搜索文档',state.docQuery)}<span class="meta grow">${docs.length} 份文档</span>${button('导入目录','import','目录','quiet')}${button('导入网页','import','网页','quiet')}</div><div class="table-scroll"><table><thead><tr><th>文档</th><th>来源状态</th><th>更新时间</th><th></th></tr></thead><tbody>${docs.map(d=>`<tr data-doc="${esc(docName(d))}" ${docName(d).includes(state.docQuery)?'':'hidden'}><td><strong>${esc(docName(d))}</strong><small>${d.chunks} 个分块 · ${formatName(d)} 文件</small></td><td>${status(d.sourceStatus)}</td><td class="meta">${date(d.updatedAt)}</td><td>${button('预览','document',d.id,'link')}${button('处理历史','document-history',d.id,'quiet')}</td></tr>`).join('')}</tbody></table></div><p class="empty" id="doc-empty" ${docs.some(d=>docName(d).includes(state.docQuery))?'hidden':''}>没有匹配的文档</p>`;
  if(state.tab==='tasks')body=`<div class="toolbar"><label>状态 <select class="control" id="task-filter"><option value="all">全部状态</option>${[...new Set(tasks.map(t=>t.status))].map(s=>`<option value="${s}" ${state.filter===s?'selected':''}>${labels[s]||s}</option>`).join('')}</select></label><span class="meta">${tasks.length} 条处理历史</span></div>${tasks.filter(t=>state.filter==='all'||state.filter===t.status).map(t=>`<div class="task-row"><div><strong>${esc(labels[t.kind]||t.kind)}</strong><small>${t.document?esc(docName(data.documents.find(d=>d.id===t.document))):'知识库处理'} · ${date(t.createdAt)}</small></div>${status(t.status)}${button('详情','task',t.id,'quiet')}</div>`).join('')||'<p class="empty">没有此状态的处理任务</p>'}`;
  if(state.tab==='graph')body=`<div class="empty">${icon('knowledge')}<h2>知识图谱</h2><p>此预览没有载入实体与关系内容。</p><p>当前库图谱功能${k.graphEnabled?'已开启':'未开启'}；文档和处理记录可在相邻页签查看。</p></div>`;
  if(state.tab==='settings')body=`<h2>知识库配置</h2><div class="setting-row"><div><strong>存储方式</strong><p>当前知识库的资料管理方式</p></div><span>${k.storage==='managed'?'托管存储':'引用存储'}</span></div><div class="setting-row"><div><strong>知识图谱</strong><p>显示快照中的配置状态</p></div><span>${k.graphEnabled?'已开启':'未开启'}</span></div><p class="meta" style="margin-top:24px">本预览只展示已导出的配置。模型与索引参数未载入。</p>`;
  return `<div class="page"><header class="page-header"><div><span class="eyebrow">知识库 · 本地</span><h1>${libraryName(state.library)}</h1><p>管理资料、阅读来源，查看处理进展。</p></div><div class="actions">${button('检索','retrieval','','secondary')}${button(icon('plus')+'导入文件','import','文件','primary')}</div></header>${tabset('knowledge',[['documents','文档'],['graph','知识图谱'],['tasks','处理任务'],['settings','设置']],state.tab,'tab')}<section role="tabpanel" id="knowledge-panel" aria-labelledby="knowledge-${state.tab}">${body}</section></div>`;
}
function renderWork(){
  let body='',items=[['document','文档'],['tasks','清单'],['terminal','终端']];
  if(state.page==='notes'){items=[['document','评论'],['tasks','待办']];if(state.workTab==='terminal')state.workTab='document';}
  if(state.workTab==='document'){
    if(state.page==='notes')body=`<div class="detail"><span class="eyebrow">AI 评论 · 示例</span><h2>先把一个工作流程做好</h2><p>这些记录反复提到同一个问题：页面变得清爽之后，原来需要的信息是否仍然容易找到？</p><p>可以先检查“讨论 → 阅读 → 记下决定”这条路径。切换页面时保留草稿，返回时继续阅读。</p><h3>值得继续验证</h3><ul><li>会话标题很长时能否辨认。</li><li>右侧打开后，正文是否仍然舒适。</li><li>关闭面板与停止任务是否容易区分。</li></ul><small>根据示例记录编写，未调用模型。</small></div>`;
    else if(state.selection?.type==='task'){const t=data.tasks.find(t=>t.id===state.selection.id);body=`<div class="detail"><span class="eyebrow">处理历史 · ${date(t.createdAt)}</span><h2>${esc(labels[t.kind]||t.kind)}</h2>${status(t.status)}<div class="setting-row"><span>阶段</span><span>${esc(t.stage)}</span></div><div class="setting-row"><span>进度</span><span>${t.progress}%</span></div><p>${t.hasError?'快照未包含错误正文，不能从状态推断失败原因。':'这是已保存的历史处理记录。'}</p><p>该记录的执行结果与文档当前来源状态分别展示。</p></div>`;}
    else body=`<div class="file-bar">${icon('file')}<span>${state.selection?.type==='document'?esc(docName(data.documents.find(d=>d.id===state.selection.id))):'工作空间设计.md'}</span><span class="grow"></span><span>只读预览</span></div>${documentArticle()}`;
  }
  if(state.workTab==='tasks')body=`<div class="detail"><span class="eyebrow">本次设计 · 示例清单</span><h2>接下来要做的事</h2>${['确定应用导航与会话列表的边界','核对知识库当前状态与处理历史','检查窄窗格和亮暗主题的阅读效果'].map((t,i)=>`<label class="check-row"><input type="checkbox" data-todo="${i}" ${state.todos[i]?'checked':''}><span>${t}</span></label>`).join('')}<p class="meta">勾选只更新当前预览。</p></div>`;
  if(state.workTab==='terminal')body=`<div class="file-bar">${icon('terminal')}<span>终端输出示例</span></div><pre class="terminal">PS workspace&gt; node --check app.js\n\n语法检查完成。\n\nPS workspace&gt; _</pre><div class="detail"><p>此处用于检查等宽文本的阅读效果，未连接 Shell。</p></div>`;
  $('#work').innerHTML=`<div class="work-head">${tabset('work',items,state.workTab,'work-tab','work-tabs')}${button('×','work','','icon')}</div><div class="work-body" id="work-panel" role="tabpanel" aria-labelledby="work-${state.workTab}">${body}</div><footer class="work-foot"><span>${state.page==='notes'?'魔法笔记':'当前工作区'}</span><span>示例内容</span></footer>`;
  $('#work [data-action=work]').setAttribute('aria-label','收起工作区');
}
function viewKey(){return `${state.page}:${state.page==='chat'?state.conversation:state.page==='notes'?state.note:state.library+state.tab}`;}
function saveScroll(){state.scroll[viewKey()]={main:$('#main').scrollTop,chat:$('#history')?.scrollTop||0};}
function renderMain(){
  $('#main').innerHTML=state.page==='chat'?chatPage():state.page==='notes'?notesPage():knowledgePage();
  if(state.page==='chat'&&state.conversation.startsWith('demo-')){
    $('#history .reading').innerHTML=(state.sent[state.conversation]||[]).length
      ? state.sent[state.conversation].map(t=>`<div class="user-message">${esc(t)}</div><p class="meta">已添加到预览，未调用模型。</p>`).join('')
      : '<div class="empty"><span class="brand">G</span><h2>今天，想一起做点什么？</h2><p>写下你的想法，从这里开始。</p></div>';
  }
  const saved=state.scroll[viewKey()];$('#main').scrollTop=saved?.main||0;if($('#history'))$('#history').scrollTop=saved?.chat||0;
  const title=state.page==='chat'?names.get(state.conversation):state.page==='notes'?'魔法笔记':libraryName(state.library);
  $('#heading').innerHTML=`<strong>${esc(title)}</strong><small>${state.page==='chat'?esc(projectName(current()?.project)):state.page==='notes'?'全局 · 记录与思考':'知识库 · 本地资料'}</small>`;
}
function syncPanels(){
  document.body.classList.toggle('has-work',state.work);document.body.classList.toggle('objects-hidden',!state.objects);document.body.classList.toggle('drawer-open',state.drawer);
  $('#objects-toggle').setAttribute('aria-expanded',String(innerWidth<=1000?state.drawer:state.objects));$('#work-toggle').setAttribute('aria-expanded',String(state.work));
  document.documentElement.style.setProperty('--chat-share',state.share+'%');$('#resize').setAttribute('aria-valuenow',state.share);
}
function render(){renderRail();renderObjects();renderMain();renderWork();syncPanels();}
function page(id){saveScroll();state.page=id;state.work=id==='chat'&&innerWidth>1000;state.drawer=false;state.selection=null;state.workTab='document';render();history.replaceState(null,'','#'+id);}
function info(){modal('关于这个工作台预览',`<p>这次以早期 Demo 的留白、分栏和阅读层级为基线，把聊天、笔记与知识库放进同一个工作台。</p><h3>真实的数据规模</h3><p>沿用 ${esc(date(data.capturedAt))} 的脱敏快照：${data.projects.length} 个项目、${data.conversations.length} 个会话、${data.notes.length} 篇笔记、${data.documents.length} 份文档、${data.tasks.length} 条知识处理任务。对象关联、笔记记录数和任务状态来自快照。</p><h3>自然的示例内容</h3><p>名称、聊天正文、笔记正文、文档和评论根据本次讨论重新编写，并非私人原文，也不与原始字数逐项对应。右侧终端为示例输出。</p><h3>操作范围</h3><p>切换、搜索、调宽、草稿、笔记追加和清单勾选可体验。消息与记录只保存在当前页面，刷新后恢复。主题保存到此浏览器；导入和检索不连接真实服务。</p><a href="../workbench-prototype.md">查看设计与维护说明 ↗</a>`);}
function settings(){modal('外观设置',`<p>调整当前预览的阅读与工作空间。</p><div class="setting-row"><div><strong>外观模式</strong><p>仅保存当前浏览器的主题选择</p></div><select id="theme-select" aria-label="外观模式">${[['light','亮色'],['dark','暗色'],['system','跟随系统']].map(([id,t])=>`<option value="${id}" ${themeChoice===id?'selected':''}>${t}</option>`).join('')}</select></div><div class="setting-row"><div><strong>显示工作区</strong><p>在当前页面旁边查看资料</p></div><button class="switch" data-action="settings-work" role="switch" aria-label="显示工作区" aria-checked="${state.work}"></button></div><div class="setting-row"><div><strong>界面布局</strong><p>此版本专注工作台内容设计。</p></div><a href="../four-column-demo.html">比较经典与工作台 ↗</a></div>`);}
function components(){modal('组件与含义',`<p>同一种含义保持一致；不同操作有清楚的边界。</p><section class="component-section"><h3>按钮 · 执行动作</h3><div class="actions">${button('保存记录','component-example','主操作按钮','primary')}${button('查看详情','component-example','次要操作按钮','secondary')}<button disabled>处理中</button></div></section><section class="component-section"><h3>开关 · 立即改变持续状态</h3><div class="setting-row"><span>显示工作区</span><button class="switch" role="switch" aria-label="显示工作区" aria-checked="${state.work}" data-action="settings-work"></button></div></section><section class="component-section"><h3>勾选框 · 选择或完成一项</h3><label class="check-row"><input type="checkbox">检查窄窗口的阅读效果</label></section><section class="component-section"><h3>状态 · 告知结果，不执行动作</h3><div class="actions">${status('ready')}${status('failed')}${status('cancelled')}</div></section><p style="margin-top:20px">知识库页签使用方向键切换；搜索只筛选当前列表；收起工作区不会停止任务。</p><div id="component-feedback" role="status"></div>`);}
let themeChoice='light';try{themeChoice=localStorage.getItem('goodbuddy-workbench-preview-theme')||'light';}catch{}
const systemTheme=matchMedia('(prefers-color-scheme: dark)');
function applyTheme(value){themeChoice=value;document.documentElement.dataset.theme=value==='system'?(systemTheme.matches?'dark':'light'):value;try{localStorage.setItem('goodbuddy-workbench-preview-theme',value);}catch{} }
systemTheme.addEventListener('change',()=>{if(themeChoice==='system')applyTheme('system');});
const actions={
  page,info,settings,components,
  theme:()=>applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'),
  objects:()=>{if(innerWidth<=1000)state.drawer=!state.drawer;else state.objects=!state.objects;syncPanels();},
  work:()=>{state.work=!state.work;syncPanels();},
  'settings-work':()=>{state.work=!state.work;syncPanels();document.querySelectorAll('#dialog [role=switch]').forEach(el=>el.setAttribute('aria-checked',String(state.work)));},
  conversation:id=>{saveScroll();state.conversation=id;state.drawer=false;renderObjects();renderMain();syncPanels();},
  more:()=>{state.limit+=24;$('#conversation-list').innerHTML=conversationRows();},
  'new-chat':()=>{const id='demo-'+Date.now();const p=state.project==='all'?data.projects[0].id:state.project;data.conversations.unshift({id,project:p,updatedAt:new Date().toISOString(),messageCount:0});names.set(id,'新的讨论');state.conversation=id;state.drafts[id]='';renderObjects();renderMain();notify('已新建演示会话');},
  note:id=>{saveScroll();state.note=id||null;state.work=Boolean(id)&&innerWidth>1100;state.workTab='document';state.drawer=false;render();},
  'new-note':()=>modal('新建笔记',`<form id="new-note-form"><label class="field">笔记标题<input id="new-note-title" required maxlength="120" placeholder="为这篇笔记起个名字" autofocus></label><button class="primary" type="submit">创建笔记</button></form>`),
  capture:()=>{const text='应用入口保持稳定；项目列表可以收起。聊天与文档并列，笔记保留连续记录，知识库区分当前来源状态与历史处理结果。';state.note=data.notes[0].id;state.noteDrafts[state.note]=text;page('notes');notify('已放入笔记草稿，确认后保存');},
  library:id=>{saveScroll();state.library=id;state.filter='all';state.docQuery='';state.drawer=false;state.work=false;render();},
  tab:id=>{saveScroll();state.tab=id;renderMain();},
  'work-tab':id=>{state.workTab=id;renderWork();},
  'open-document':()=>{state.selection=null;state.work=true;state.workTab='document';renderWork();syncPanels();},
  document:id=>{state.selection={type:'document',id};state.work=true;state.workTab='document';renderWork();syncPanels();},
  'document-history':()=>{state.tab='tasks';state.filter='all';renderMain();},
  task:id=>{state.selection={type:'task',id};state.work=true;state.workTab='document';renderWork();syncPanels();},
  import:kind=>modal('导入'+kind,`<p>正式客户端会将${esc(kind)}加入当前知识库并创建处理任务。本次预览不访问文件、网址或后台服务。</p><p>可在“处理任务”页签查看这份快照中已有的成功、失败、取消与跳过记录。</p>${button('查看处理任务','show-tasks','','primary')}`),
  'show-tasks':()=>{$('#dialog').close();state.tab='tasks';renderMain();},
  retrieval:()=>modal('检索',`<p>此预览未连接向量模型与知识服务，不提供模拟检索结果。可以打开文档预览，检查来源和正文的阅读空间。</p>`),
  attach:()=>modal('添加附件',`<p>此原型没有连接附件上传。正式输入区保留文件、图片和文档导入入口。</p>`),
  model:()=>modal('当前模型',`<p>这里展示 OpenCode 与 GPT-6 的输入区位置。原型未读取真实模型配置，也不发送请求。</p>`),
  'component-example':label=>{$('#component-feedback').textContent=label+'：这是组件交互示例。';}
};
document.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(b)actions[b.dataset.action]?.(b.dataset.value);});
document.addEventListener('input',e=>{
  const el=e.target;
  if(el.id==='chat-draft')state.drafts[state.conversation]=el.value;
  if(el.id==='note-draft')state.noteDrafts[state.note]=el.value;
  if(el.id==='conversation-search'){state.query=el.value;state.limit=24;$('#conversation-list').innerHTML=conversationRows();}
  if(el.id==='note-search'){state.noteQuery=el.value;$('#note-grid').innerHTML=noteCards();}
  if(el.id==='doc-search'){state.docQuery=el.value;let visible=0;document.querySelectorAll('[data-doc]').forEach(row=>{row.hidden=!row.dataset.doc.includes(el.value);if(!row.hidden)visible++;});$('#doc-empty').hidden=visible>0;}
});
document.addEventListener('change',e=>{
  if(e.target.id==='project'){state.project=e.target.value;state.limit=24;$('#conversation-list').innerHTML=conversationRows();}
  if(e.target.id==='task-filter'){state.filter=e.target.value;renderMain();$('#task-filter').focus();}
  if(e.target.id==='theme-select')applyTheme(e.target.value);
  if(e.target.dataset.todo!==undefined)state.todos[Number(e.target.dataset.todo)]=e.target.checked;
});
document.addEventListener('submit',e=>{
  if(e.target.id==='chat-form'){e.preventDefault();const text=$('#chat-draft').value.trim();if(!text)return;(state.sent[state.conversation]??=[]).push(text);state.drafts[state.conversation]='';saveScroll();renderMain();$('#history').scrollTop=$('#history').scrollHeight;$('#chat-draft').focus();}
  if(e.target.id==='note-form'){e.preventDefault();const text=$('#note-draft').value.trim();if(!text)return;(state.added[state.note]??=[]).unshift(text);state.noteDrafts[state.note]='';renderObjects();renderMain();notify('记录已保存在本次预览中');}
  if(e.target.id==='new-note-form'){e.preventDefault();const title=$('#new-note-title').value.trim();if(!title)return;const id='note-demo-'+Date.now();data.notes.push({id,title,entries:[],updatedAt:new Date().toISOString()});state.note=id;state.page='notes';$('#dialog').close();render();}
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&!$('#dialog').open&&state.drawer){state.drawer=false;syncPanels();$('#objects-toggle').focus();}
  const tab=e.target.closest('[role=tab]');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
  const tabs=[...tab.parentElement.querySelectorAll('[role=tab]')],i=tabs.indexOf(tab),next=tabs[e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];e.preventDefault();const id=next.id;next.click();document.getElementById(id).focus();
});
const separator=$('#resize');
function setShare(value){state.share=Math.max(35,Math.min(70,Math.round(value)));syncPanels();}
separator.addEventListener('pointerdown',e=>{separator.setPointerCapture(e.pointerId);separator.dataset.dragging='true';e.preventDefault();});
separator.addEventListener('pointermove',e=>{if(separator.dataset.dragging!=='true')return;const r=$('.panes').getBoundingClientRect();setShare((e.clientX-r.left)/r.width*100);});
separator.addEventListener('lostpointercapture',()=>delete separator.dataset.dragging);
separator.addEventListener('pointerup',e=>{separator.releasePointerCapture(e.pointerId);});
separator.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();setShare(e.key==='Home'?35:e.key==='End'?70:state.share+(e.key==='ArrowRight'?2:-2));}});
addEventListener('resize',syncPanels);
$('#objects-toggle').innerHTML=icon('panel');$('#work-toggle').innerHTML=icon('work');$('#theme-button').innerHTML=icon('sun');
if(['notes','knowledge'].includes(location.hash.slice(1))){state.page=location.hash.slice(1);state.work=false;}
applyTheme(themeChoice);render();
