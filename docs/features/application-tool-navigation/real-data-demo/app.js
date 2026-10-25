'use strict';
const data = window.PORTABLE_SNAPSHOT;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {ready:'已就绪',idle:'空闲',active:'活动',archived:'已归档',running:'运行中',completed:'已完成',succeeded:'成功',failed:'失败',cancelled:'已取消',skipped:'已跳过',interrupted:'已中断',queued:'排队中',unknown:'未映射',paused:'已暂停',syncing:'同步中',streaming:'输出中',done:'已完成',pending:'待处理',user:'用户',assistant:'助手',system:'系统',tool:'工具',parsing:'解析',chunking:'分块',embedding:'向量索引',indexing:'索引',graph:'图谱',reading:'读取',finalizing:'收尾','source-sync':'同步来源','document-process':'处理文档','document-rebuild':'重建文档','library-rebuild':'重建知识库','embedding-rebuild':'重建向量索引','graph-rebuild':'重建图谱'};
labels.complete = '已完成'; labels.error = '错误';
const text = code => labels[code] || code;
const date = value => value ? new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : '时间未知';
const button = (name, action, value='', cls='secondary') => `<button type="button" class="${cls}" data-action="${action}" data-value="${esc(value)}">${esc(name)}</button>`;
const status = code => `<span class="status ${['ready','succeeded','completed','done'].includes(code)?'good':['failed','interrupted'].includes(code)?'bad':['running','streaming','syncing'].includes(code)?'active':''}">${esc(text(code))}</span>`;
const alias = (row, kind) => {
  const base = `${kind} ${row.id.slice(1).padStart(2,'0')}`;
  if (!row.titleLength || row.titleLength < base.length + 4) return base;
  return (base + ' · ' + '资料整理与工作过程记录'.repeat(40)).slice(0, Math.min(row.titleLength, 100));
};
const placeholder = count => '以下文字用于检查阅读密度与换行。原始内容已移除，操作含义与来源说明应保持可见。'.repeat(Math.ceil(count / 40)).slice(0,count);
const state = {page:'chat', project:'all', query:'', conversation:data.conversations[0]?.id, note:null, library:data.libraries[0]?.id, tab:'documents', docQuery:'', taskStatus:'all', draft:{}, sent:{}, noteDraft:{}, added:{}, scroll:{}, objects:true, work:true, narrowObjects:false, narrowWork:false, layout:'workbench', settings:{...data.settings}};
const currentConversation = () => data.conversations.find(c=>c.id===state.conversation);
const currentNote = () => data.notes.find(n=>n.id===state.note);
const currentLibrary = () => data.libraries.find(k=>k.id===state.library);
const tabs = (items, selected, action) => `<div class="tabs" role="tablist" aria-label="知识库内容">${items.map(([id,label])=>`<button id="tab-${id}" role="tab" aria-selected="${id===selected}" aria-controls="knowledge-panel" tabindex="${id===selected?0:-1}" data-action="${action}" data-value="${id}">${label}</button>`).join('')}</div>`;
function modal(title, html) { $('#dialog-title').textContent=title;$('#dialog-body').innerHTML=html;if(!$('#dialog').open)$('#dialog').showModal();$('#dialog-close').focus(); }
function notify(message) {const n=$('#notice');n.textContent=message;n.hidden=false;clearTimeout(notify.timer);notify.timer=setTimeout(()=>n.hidden=true,3000);}
function sourceInfo() {
  modal('这份预览使用了哪些真实数据？',`<p>导出时间：${esc(new Date(data.capturedAt).toLocaleString('zh-CN'))}。这是便携版数据库的只读结构快照，不是实时运行状态。</p><div class="facts">${[[data.projects.length,'项目'],[data.conversations.length,'会话'],[data.messageCount,'消息'],[data.notes.length,'笔记'],[data.notes.reduce((n,x)=>n+x.entries.length,0),'笔记记录'],[data.tasks.length,'知识处理任务']].map(([n,s])=>`<div class="fact"><b>${n.toLocaleString()}</b>${s}</div>`).join('')}</div><ul><li>真实保留：对象数量、关联、时间、状态、消息角色、文本长度、分块与向量记录数量。</li><li>替代内容：项目、会话、笔记及文档名称全部换成别名；正文为明确标注的排版替代文案。原始 ID 重新编号。</li><li>没有导出：消息原文、笔记原文、文件路径、地址、账号、模型配置、凭据、错误原文。</li><li>每个会话仅取最后 12 条消息的元数据。长正文最多展示 1,600 字替代文案，因此不是长会话性能验收。</li><li>本版重点对应聊天、笔记与知识库，并展示四个真实设置值。其余页面仍在早期视觉探索版中，未据此声称已完成真实数据改版。</li></ul><p>目录与操作层级参考当前产品源码；组件是静态原型实现，尚未复用生产 React 组件，也不是当前客户端截图。</p><a href="../real-data-prototype.md">查看来源、页面映射与验证范围</a>`);
}
function renderRail() {
  $('#rail').innerHTML=[['chat','◫','聊天'],['notes','▤','笔记'],['knowledge','▥','知识库']].map(([id,icon,label])=>`<button data-action="page" data-value="${id}" title="${label}" ${state.page===id?'aria-current="page"':''}><span aria-hidden="true">${icon}</span><small>${label}</small></button>`).join('')+`<div style="flex:1"></div><button data-action="settings" title="设置"><span aria-hidden="true">⚙</span><small>设置</small></button>`;
}
function objectButton(row,kind,action,selected,meta) {return `<button class="object" data-action="${action}" data-value="${row.id}" title="${esc(alias(row,kind))}" ${selected?'aria-current="page"':''}><strong>${esc(alias(row,kind))}</strong><small>${meta}</small></button>`;}
function conversationList() {
  const rows=data.conversations.filter(c=>(state.project==='all'||c.project===state.project)&&alias(c,'会话').includes(state.query));
  return `<p class="object-note">${rows.length} 个匹配 · 全部 ${data.conversations.length} 个<br>列表分批展示，每批 40 个</p><div id="conversation-rows">${rows.slice(0,40).map(c=>objectButton(c,'会话','conversation',c.id===state.conversation,`${c.pinned?'置顶 · ':''}${c.messageCount} 条消息 · ${date(c.updatedAt)}`)).join('') || '<p class="empty">没有匹配的会话</p>'}</div>${rows.length>40?button(`继续显示（剩余 ${rows.length-40} 个）`,'more-conversations','40','link'):''}`;
}
function renderObjects() {
  let html='';
  if(state.page==='chat')html=`<h2>项目与会话</h2><label class="meta" for="project">项目范围</label><select id="project"><option value="all">全部项目（${data.projects.length}）</option>${data.projects.map(p=>`<option value="${p.id}" ${state.project===p.id?'selected':''}>${esc(alias(p,'项目'))} · ${data.conversations.filter(c=>c.project===p.id).length} 会话</option>`).join('')}</select><input id="conversation-query" aria-label="搜索会话别名" placeholder="搜索会话别名" value="${esc(state.query)}"><div id="conversation-list">${conversationList()}</div>`;
  if(state.page==='notes')html=`<h2>魔法笔记</h2>${button(`全部笔记（${data.notes.length}）`,'note','',state.note===null?'selected':'')}<p class="object-note">全局笔记 · 按更新时间排列</p>${data.notes.map(n=>objectButton(n,'笔记','note',state.note===n.id,`${n.pinned?'置顶 · ':''}${n.entries.length} 条记录 · ${date(n.updatedAt)}`)).join('')}`;
  if(state.page==='knowledge')html=`<h2>知识库</h2><p class="object-note">${data.libraries.length} 个本地库 · 无外部绑定</p>${data.libraries.map(k=>objectButton(k,'知识库','library',k.id===state.library,`${k.storage==='managed'?'托管存储':k.storage==='reference'?'引用存储':'存储模式未映射'} · ${data.documents.filter(d=>d.library===k.id).length} 文档`)).join('')}<p class="object-note">库列表替代会话列表；库内继续使用文档、图谱、处理任务和设置页签。</p>`;
  $('#objects').innerHTML=html;
}
function bodySample(characters) {
  const size=Math.min(characters,1600), short=Math.min(size,360);
  return `<p>${esc(placeholder(short))}</p>${size>short?`<details><summary>展开替代文案（最多 ${size} 字）</summary><p>${esc(placeholder(size-short))}</p></details>`:''}`;
}
function chatPage() {
  const c=currentConversation();if(!c)return '<p class="empty">没有可展示的会话</p>';
  const p=data.projects.find(p=>p.id===c.project);
  return `<section class="chat"><header class="chat-head"><h1>${esc(alias(c,'会话'))}</h1><small>${p?esc(alias(p,'项目')):'项目不可用'} · ${c.messageCount} 条消息 · 标题原长 ${c.titleLength} 字</small></header><div class="history" id="history"><div class="reading"><p class="snapshot-note">最近 ${c.messages.length} 条消息的结构快照 · 最长原文 ${c.maxMessageLength.toLocaleString()} 字。下方文字均为替代文案。</p>${c.messages.map(m=>`<article class="message ${m.role}"><div class="actions"><strong>${esc(text(m.role))}</strong>${status(m.state)}<small>第 ${m.sequence} 条 · ${date(m.createdAt)} · 原长 ${m.characters.toLocaleString()} 字</small></div>${m.characters?bodySample(m.characters):'<p class="meta">原内容为空，保留消息位置。</p>'}</article>`).join('')}${(state.sent[c.id]||[]).map(m=>`<article class="message user"><small>本次预览输入 · 未发送模型</small><p>${esc(m)}</p></article>`).join('')}</div></div><div class="composer"><form id="chat-form"><textarea id="chat-draft" aria-label="会话草稿" placeholder="输入草稿，切换会话后仍保留…">${esc(state.draft[c.id]||'')}</textarea><div class="actions">${button('附件入口说明','boundary','附件导入','')}<span class="meta">静态预览 · 未连接 Runtime</span><button type="submit" class="primary">添加到预览</button></div></form></div></section>`;
}
function notesPage() {
  const n=currentNote();
  if(!n)return `<div class="page"><header class="page-heading"><div><small>全局 · 真实笔记结构</small><h1>魔法笔记</h1><p class="meta">${data.notes.length} 篇笔记 · ${data.notes.reduce((a,n)=>a+n.entries.length,0)} 条记录</p></div>${button('新建笔记入口说明','boundary','新建笔记')}</header><div class="cards">${data.notes.map(n=>`<button class="note-card" data-action="note" data-value="${n.id}"><span class="eyebrow">${n.pinned?'已置顶':'笔记'}</span><h2>${esc(alias(n,'笔记'))}</h2><p class="meta">${n.entries.length} 条记录 · ${n.entries.reduce((a,e)=>a+e.characters,0).toLocaleString()} 字原文</p><small>${date(n.updatedAt)} · 原标题 ${n.titleLength} 字</small></button>`).join('')}</div></div>`;
  return `<div class="page"><header class="page-heading"><div><small>全局 · 笔记详情</small><h1>${esc(alias(n,'笔记'))}</h1><p class="meta">${n.entries.length} 条快照记录，按时间倒序连续阅读</p></div>${button('返回笔记总览','note')}</header><div class="reading"><form id="note-form"><label for="note-draft">追加一条预览记录</label><textarea id="note-draft" rows="3" placeholder="草稿按笔记保留">${esc(state.noteDraft[n.id]||'')}</textarea><div class="toolbar"><small>仅写入当前页面内存</small><button class="primary" type="submit">保存预览记录</button></div></form>${(state.added[n.id]||[]).map(t=>`<article class="record"><small>本次预览新增</small><p>${esc(t)}</p></article>`).join('')}${n.entries.map((e,i)=>`<article class="record"><small>记录 ${n.entries.length-i} · ${date(e.createdAt)} · 原长 ${e.characters.toLocaleString()} 字${e.hasImage?' · 含图片数据，未导出':''}</small>${bodySample(e.characters)}</article>`).join('')}</div></div>`;
}
function knowledgePage() {
  const k=currentLibrary();if(!k)return '<p class="empty">没有知识库</p>';
  const docs=data.documents.filter(d=>d.library===k.id), tasks=data.tasks.filter(t=>t.library===k.id);
  let body='';
  if(state.tab==='documents')body=`<div class="toolbar"><input id="doc-query" placeholder="搜索文档别名" aria-label="搜索文档别名" value="${esc(state.docQuery)}">${button('导入文件','boundary','导入文件')}${button('导入目录','boundary','导入目录')}${button('导入网页','boundary','导入网页')}</div><div class="table-scroll"><table><thead><tr><th>文档 / 来源</th><th>来源状态</th><th>索引记录</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${docs.map(d=>`<tr data-document-row="${esc(alias(d,'文档'))}" ${!alias(d,'文档').includes(state.docQuery)?'hidden':''}><td><strong>${esc(alias(d,'文档'))}</strong><small>${esc(d.format)} · ${d.sourceType==='file'?'文件来源':d.sourceType==='directory'?'目录来源':d.sourceType==='url'?'网页来源':'来源未映射'}<br>路径未导出 · 原标题 ${d.titleLength} 字</small></td><td>${status(d.sourceStatus)}</td><td>${d.chunks} 分块<br>${d.embeddings} 向量记录</td><td>${date(d.updatedAt)}</td><td>${button('查看结构','document',d.id,'link')}${button('处理历史','document-tasks',d.id,'link')}${button('更多操作说明','boundary','文档重建、同步与移除','link')}</td></tr>`).join('')}</tbody></table></div><p id="doc-empty" class="empty" ${docs.some(d=>alias(d,'文档').includes(state.docQuery))?'hidden':''}>没有匹配的文档，请调整搜索词。</p><p class="snapshot-note">“已就绪”来自来源记录；向量数量是数据库记录数，不代表已实测当前模型可用。历史失败单独保留在处理任务中。</p>`;
  if(state.tab==='tasks') {
    const filtered=tasks.filter(t=>state.taskStatus==='all'||t.status===state.taskStatus);
    body=`<div class="toolbar"><label>任务状态 <select id="task-filter"><option value="all">全部（${tasks.length}）</option>${[...new Set(tasks.map(t=>t.status))].map(s=>`<option value="${s}" ${state.taskStatus===s?'selected':''}>${esc(text(s))}（${tasks.filter(t=>t.status===s).length}）</option>`).join('')}</select></label><span class="meta">${filtered.length} 条 · 历史快照，不是当前运行队列</span></div>${filtered.map(t=>`<div class="row"><div><strong>${esc(text(t.kind))}</strong><p class="meta">${t.document?esc(alias(data.documents.find(d=>d.id===t.document),'文档')):'库或来源级任务'} · ${date(t.createdAt)}</p><p class="meta">阶段：${esc(text(t.stage))} · ${t.progress}%${t.totalItems!==null?` · ${t.completedItems??0}/${t.totalItems}`:''}</p></div>${status(t.status)}${button('详情','task',t.id,'link')}</div>`).join('')||'<p class="empty">没有此状态的任务。</p>'}`;
  }
  if(state.tab==='graph')body=`<h2>知识图谱</h2><p class="snapshot-note">当前库图谱开关：${k.graphEnabled?'开启':'关闭'}。快照中全部知识库共有 ${data.graph.entities} 个实体、${data.graph.relations} 条关系；未导出节点名称与关系内容，不能按当前库归属展示这些总数。</p><p class="empty">图谱内容未导出。本版保留入口，不用虚构节点代替真实图谱。</p>`;
  if(state.tab==='settings')body=`<h2>知识库设置</h2><div class="row"><div><strong>存储方式</strong><p class="meta">来自当前库快照</p></div><span>${k.storage==='managed'?'托管存储':k.storage==='reference'?'引用存储':'未映射'}</span></div><div class="row"><strong>图谱功能</strong><span>${k.graphEnabled?'已开启':'已关闭'}</span></div><p class="snapshot-note">分块、检索、模型及本体参数未导出。正式编辑继续归属原有知识库设置，不在原型中伪造已保存配置。</p>`;
  return `<div class="page"><header class="page-heading"><div><small>知识库 · 本地库</small><h1>${esc(alias(k,'知识库'))}</h1><p class="meta">${docs.length} 份文档 · ${docs.reduce((n,d)=>n+d.chunks,0)} 分块 · ${tasks.length} 条处理历史</p></div><div class="actions">${button('检索入口说明','boundary','检索测试')}${button('库管理说明','boundary','编辑与删除知识库')}</div></header>${tabs([['documents','文档'],['graph','知识图谱'],['tasks','处理任务'],['settings','设置']],state.tab,'tab')}<section id="knowledge-panel" role="tabpanel" aria-labelledby="tab-${state.tab}">${body}</section></div>`;
}
function renderWorkbar() {
  let content='';
  if(state.page==='chat'){const c=currentConversation();content=`<h3>当前会话结构</h3><div class="facts"><div class="fact"><b>${c?.messageCount||0}</b>消息总数</div><div class="fact"><b>${c?.messages.length||0}</b>展示元数据</div></div><p class="meta">工作区是并列窗格。此处用资料结构检查可用宽度；文件、终端和浏览器的真实生命周期仍需生产组件验证。</p>${button('打开知识文档','page','knowledge','link')}`;}
  if(state.page==='notes'){const n=currentNote();content=`<h3>${n?'当前笔记':'笔记概览'}</h3><p class="snapshot-note">${n?`${n.entries.length} 条真实记录 · ${n.entries.reduce((a,e)=>a+e.characters,0).toLocaleString()} 字原文`:'10 篇笔记的真实条目数和更新时间'}</p><h3>评论与来源</h3><p class="meta">评论正文及来源链接未导出。本版不生成替代 AI 结论，正式界面须保留评论、待办和原始来源入口。</p>`;}
  if(state.page==='knowledge'){const tasks=data.tasks.filter(t=>t.library===state.library);content=`<h3>当前库处理记录</h3><p class="snapshot-note">文档当前状态与历史执行结果分别展示。</p>${[...new Set(tasks.map(t=>t.status))].map(s=>`<div class="row">${status(s)}<strong>${tasks.filter(t=>t.status===s).length}</strong></div>`).join('')}${button('查看处理任务','tab','tasks','link')}`;}
  $('#workbar').innerHTML=`<div class="work-title"><h2>工作区</h2><small>结构预览</small></div>${content}<details style="margin-top:24px"><summary>预览范围</summary><p class="meta">名称和正文已替换。宽度、背景和排列为候选设计，未修改客户端。</p></details>`;
}
function viewKey(){return `${state.page}:${state.page==='chat'?state.conversation:state.page==='notes'?state.note:state.library+':'+state.tab}`;}
function saveView(){state.scroll[viewKey()]={main:$('#main').scrollTop,history:$('#history')?.scrollTop||0};}
function render() {
  renderRail();renderObjects();$('#main').innerHTML=state.page==='chat'?chatPage():state.page==='notes'?notesPage():knowledgePage();renderWorkbar();
  $('#breadcrumb').textContent=state.page==='chat'?'聊天 / 会话快照':state.page==='notes'?'魔法笔记 / 全局':'知识库 / 本地资料';
  const position=state.scroll[viewKey()];$('#main').scrollTop=position?.main||0;if($('#history'))$('#history').scrollTop=position?.history||0;
  syncPanels();
}
function syncPanels(){const narrow=matchMedia('(max-width:900px)').matches;
  document.body.classList.toggle('objects-hidden',!state.objects);document.body.classList.toggle('work-hidden',!state.work&&!narrow);
  document.body.classList.toggle('objects-open',state.narrowObjects&&narrow);document.body.classList.toggle('work-open',state.narrowWork&&narrow);
  const objects=narrow?state.narrowObjects:state.objects, work=narrow?state.narrowWork:state.work;
  $('#objects-toggle').textContent=objects?'收起列表':'展开列表';$('#objects-toggle').setAttribute('aria-expanded',String(objects));
  $('#work-toggle').textContent=work?'收起工作区':'展开工作区';$('#work-toggle').setAttribute('aria-expanded',String(work));
}
function settings() {
  const fields={desktopNotificationsEnabled:['桌面通知','任务结果的桌面通知偏好'],chatMinimapEnabled:['聊天缩略导航','长会话的定位入口'],transparentFrostedEffectEnabled:['透明磨砂特效','产品窗口表面的磨砂偏好'],conversationHtmlRenderingEnabled:['会话 HTML 渲染','会话内容的 HTML 展示偏好']};
  modal('设置 · 外观与会话',`<p class="snapshot-note">以下四项初值取自真实配置。切换仅改变本次预览值，不请求系统权限或应用相应产品能力。</p>${Object.entries(fields).map(([key,[label,desc]])=>`<div class="row"><div><strong id="label-${key}">${label}</strong><p class="meta">${desc} · 快照：${data.settings[key]===true?'开启':data.settings[key]===false?'关闭':'未提供'}</p></div><button class="switch" role="switch" aria-labelledby="label-${key}" aria-checked="${state.settings[key]===true}" data-action="setting" data-value="${key}" ${!(key in data.settings)?'disabled':''}></button></div>`).join('')}<div class="row"><div><strong>预览主题</strong><p class="meta">立即改变此 Demo 的亮暗配色</p></div><select id="theme-select" aria-label="预览主题"><option value="light" ${document.documentElement.dataset.theme==='light'?'selected':''}>亮色</option><option value="dark" ${document.documentElement.dataset.theme==='dark'?'selected':''}>暗色</option></select></div><p class="meta">完整设置分类、保存与未保存保护仍需正式组件验证；本版没有读取模型、Host 或账号配置。</p>`);
}
function switchPage(page){saveView();state.page=page;state.narrowObjects=false;state.narrowWork=false;render();history.replaceState(null,'','#'+page);$('#main').focus({preventScroll:true});}
const actions={
  page:switchPage,
  conversation:id=>{saveView();state.conversation=id;state.narrowObjects=false;render();},
  note:id=>{saveView();state.note=id||null;state.narrowObjects=false;render();},
  library:id=>{saveView();state.library=id;state.docQuery='';state.taskStatus='all';state.narrowObjects=false;render();},
  tab:id=>{saveView();state.tab=id;state.narrowWork=false;render();$(`#tab-${id}`)?.focus();},
  settings,
  setting:(key,el)=>{state.settings[key]=!state.settings[key];el.setAttribute('aria-checked',String(state.settings[key]));},
  boundary:name=>modal(name,`<p>此入口在正式产品中处理“${esc(name)}”。本版保留操作位置与语义，未连接对应服务。</p><p>不会读取文件、启动任务、删除数据或返回虚构的成功结果。</p>`),
  document:id=>{const d=data.documents.find(d=>d.id===id);modal(alias(d,'文档'),`<p>${status(d.sourceStatus)} · 来源状态</p><div class="facts"><div class="fact"><b>${d.chunks}</b>分块</div><div class="fact"><b>${d.embeddings}</b>向量记录</div></div><p>分块内容累计 ${d.characters.toLocaleString()} 字。文档名、正文、路径及来源地址未导出。</p><p class="meta">数据库统计不等于解析结果或当前索引可用性验收。</p>${button('查看该文档处理记录','document-history',d.id)}`);},
  'document-history':id=>{const tasks=data.tasks.filter(t=>t.document===id);modal('文档处理记录',tasks.map(t=>`<div class="row"><div><strong>${esc(text(t.kind))}</strong><p>${date(t.createdAt)}</p></div>${status(t.status)}${button('详情','task',t.id,'link')}</div>`).join('')||'<p>没有直接关联此文档的任务，库或来源级任务请在处理任务中查看。</p>');},
  'document-tasks':id=>actions['document-history'](id),
  task:id=>{const t=data.tasks.find(t=>t.id===id);modal('处理任务详情',`<p>${status(t.status)} · ${esc(text(t.kind))}</p><div class="row"><span>记录阶段</span><strong>${esc(text(t.stage))}</strong></div><div class="row"><span>记录进度</span><strong>${t.progress}%</strong></div><div class="row"><span>开始记录</span><span>${date(t.createdAt)}</span></div><div class="row"><span>完成时间</span><span>${date(t.completedAt)}</span></div><p class="${t.hasError?'error':'meta'}">${t.hasError?'原任务含错误信息；错误原文及补救建议未导出，不推断失败原因。':'此快照未记录错误文本。'}</p><p class="meta">这是历史记录，未据此提供实时取消或重试操作。</p>`);},
  'more-conversations':(offset,el)=>{const start=Number(offset),rows=data.conversations.filter(c=>(state.project==='all'||c.project===state.project)&&alias(c,'会话').includes(state.query));$('#conversation-rows').insertAdjacentHTML('beforeend',rows.slice(start,start+40).map(c=>objectButton(c,'会话','conversation',c.id===state.conversation,`${c.messageCount} 条消息 · ${date(c.updatedAt)}`)).join(''));if(start+40>=rows.length)el.remove();else{el.dataset.value=String(start+40);el.textContent=`继续显示（剩余 ${rows.length-start-40} 个）`;}},
};
document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(el)actions[el.dataset.action]?.(el.dataset.value,el);});
document.addEventListener('input',e=>{const el=e.target;if(el.id==='chat-draft')state.draft[state.conversation]=el.value;if(el.id==='note-draft')state.noteDraft[state.note]=el.value;if(el.id==='conversation-query'){state.query=el.value;$('#conversation-list').innerHTML=conversationList();}if(el.id==='doc-query'){state.docQuery=el.value;let count=0;document.querySelectorAll('[data-document-row]').forEach(row=>{row.hidden=!row.dataset.documentRow.includes(el.value);if(!row.hidden)count++;});$('#doc-empty').hidden=count>0;}});
document.addEventListener('change',e=>{const el=e.target;if(el.id==='project'){state.project=el.value;$('#conversation-list').innerHTML=conversationList();}if(el.id==='task-filter'){state.taskStatus=el.value;render();$('#task-filter').focus();}if(el.id==='theme-select')setTheme(el.value);});
document.addEventListener('submit',e=>{if(e.target.id==='chat-form'){e.preventDefault();const value=(state.draft[state.conversation]||'').trim();if(!value)return;(state.sent[state.conversation]??=[]).push(value);state.draft[state.conversation]='';render();$('#history').scrollTop=$('#history').scrollHeight;$('#chat-draft').focus();}if(e.target.id==='note-form'){e.preventDefault();const value=(state.noteDraft[state.note]||'').trim();if(!value)return;(state.added[state.note]??=[]).unshift(value);state.noteDraft[state.note]='';render();$('#note-draft').focus();notify('预览记录已保存在页面内存，未修改原笔记');}});
document.addEventListener('keydown',e=>{const tab=e.target.closest('[role=tab]');if(!tab)return;const all=[...tab.parentElement.querySelectorAll('[role=tab]')],i=all.indexOf(tab);const next=e.key==='ArrowRight'?(i+1)%all.length:e.key==='ArrowLeft'?(i+all.length-1)%all.length:e.key==='Home'?0:e.key==='End'?all.length-1:-1;if(next>=0){e.preventDefault();all[next].click();}});
function setTheme(value){document.documentElement.dataset.theme=value;$('#theme').setAttribute('aria-label',value==='dark'?'切换到亮色':'切换到暗色');}
$('#theme').onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');$('#source').onclick=sourceInfo;$('#dialog-close').onclick=()=>$('#dialog').close();
$('#objects-toggle').onclick=()=>{if(matchMedia('(max-width:900px)').matches)state.narrowObjects=!state.narrowObjects;else state.objects=!state.objects;syncPanels();};
$('#work-toggle').onclick=()=>{if(matchMedia('(max-width:900px)').matches){state.narrowWork=!state.narrowWork;state.narrowObjects=false;}else state.work=!state.work;syncPanels();};
matchMedia('(max-width:900px)').addEventListener('change',syncPanels);
if(['chat','notes','knowledge'].includes(location.hash.slice(1)))state.page=location.hash.slice(1);
render();
