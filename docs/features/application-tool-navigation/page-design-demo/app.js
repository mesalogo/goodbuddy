'use strict';
const $ = selector => document.querySelector(selector);
const state={page:'chat',workbar:true,workbarTab:'files',chatDraft:'',messages:[],note:null,noteDraft:'',records:{},todos:false,done:[],knowledgeTab:'documents',docFilter:'全部',document:null,supervisorTab:'overview',activityTab:'tasks',hostsTab:'hosts',hosts:['开发主机','实验环境'],connected:[true,false],switches:{},layoutChoice:'workbench'};
const pages=[['chat','◫','聊天'],['notes','▤','魔法笔记'],['knowledge','▥','知识库'],['supervisor','⌁','监督者'],['activity','◴','运行记录'],['hosts','▣','远程主机'],['sharing','⇄','设备共享']];
const renderers={chat:renderChat,notes:renderNotes,knowledge:renderKnowledge,supervisor:renderSupervisor,activity:renderActivity,hosts:renderHosts,sharing:renderSharing};
const cache=new Map();
const audits={
 chat:['消息与工具工作区','保留会话范围和输入区；工具过程用折叠记录展示。右侧文件、任务、终端是辅助内容，不增加一级导航。','示例只模拟消息；真实流式、附件、停止、队列与审批仍须逐项验收。'],
 notes:['笔记总览与连续记录','总览采用轻边框卡片；详情保持记录连续阅读，评论独立呈现。新记录、历史记录与评论用空间和细线划分。','画布、索引、标签管理、编辑和删除确认没有在本 Demo 中完整实现。'],
 knowledge:['知识库与文档状态','范围、库名和摘要集中在页头；文档表格保留状态、更新时间与来源。失败可进入详情，不能为了简洁隐藏。','图谱是静态关系示意；未接入导入、索引、检索或外部知识服务。'],
 supervisor:['工作回顾与故事线','保留现有五个顶层视图；回顾正文为主，覆盖范围与生成时间持续可见，来源作为辅助信息。','回顾、图谱和心跳计划均是模拟，未执行监督模型调用。'],
 activity:['活动与用量','保留任务与会话、时间线、用量统计三个视图。行内显示状态与时间，详情按需展开。','此处时间线只展示纵向阅读样式；正式产品的多轨并发时间线必须保留，不能用本例替代。'],
 hosts:['主机与安装包','列表优先显示主机身份、连接状态和 Agent 状态，安装包清单单独切换。','连接操作为模拟；认证、真实安装、断线恢复和草稿保护仍使用现有流程。'],
 sharing:['设备与共享元数据','设备登记与已发布目录分组，配置和发布表单按需打开。能力范围常驻说明。','只有元数据演示，不表示文件同步、知识检索或远程能力调用已经实现。']
};
function renderRail(){
 $('#rail').innerHTML=pages.map(([id,symbol,title])=>`<button data-action="go" data-value="${id}" aria-label="${title}" title="${title}" ${state.page===id?'aria-current="page"':''}><span aria-hidden="true">${symbol}</span></button>`).join('')+'<span class="rail-spacer"></span>'+[['apps','⊞','应用中心'],['inference','◉','本机推理监控'],['settings','⚙','设置']].map(([id,symbol,title])=>`<button data-action="${id}" aria-label="${title}" title="${title}"><span aria-hidden="true">${symbol}</span></button>`).join('');
}
function contextItem(label,actionName,value,active=false,meta=''){return `<button class="context-item ${active?'active':''}" data-action="${actionName}" data-value="${value}" ${active?'aria-current="page"':''}>${escapeHTML(label)}${meta?`<small>${meta}</small>`:''}</button>`;}
function renderContext(){
 const titles={chat:['GoodBuddy','本地项目'],notes:['魔法笔记','全局 · 个人'],knowledge:['知识库','全局 · 本地与外部'],supervisor:['监督者','工作回顾与故事线'],activity:['运行记录','全部项目'],hosts:['远程主机','全局'],sharing:['设备共享','全局 · 元数据目录']};
 const [title,scope]=titles[state.page];let items='';
 if(state.page==='chat')items=`${contextItem('＋ 新建会话','new-chat','')}<div class="context-group">今天</div>${contextItem('让页面内容更清晰','go','chat',true)}${contextItem('四栏布局设计','layout-link','')}<div class="context-group">相关内容</div>${contextItem('工作空间设计笔记','note','0')}${contextItem('团队知识','go','knowledge')}`;
 else if(state.page==='notes')items=contextItem('全部笔记','note-overview','',state.note===null&&!state.todos)+contextItem('待办','todos-on','',state.todos)+`<div class="context-group">最近笔记</div>`+noteData.map((n,i)=>contextItem(n[0],'note',i,state.note===i&&!state.todos)).join('');
 else if(state.page==='knowledge')items=contextItem('团队知识','knowledge-home','',true,'4')+`<div class="context-group">管理</div>${contextItem('知识库范围说明','library-scope','')}${contextItem('检索测试','retrieval','')}`;
 else if(state.page==='supervisor')items=contextItem('当前回顾','supervisor-overview','',true)+`<div class="context-group">回顾范围</div><p class="context-foot">GoodBuddy<br>10 月 24–25 日<br><br>历史结果保留生成时间与覆盖区间。</p>`;
 else if(state.page==='activity')items=contextItem('全部项目','activity-home','',true)+`<p class="context-foot">项目、会话与任务的归属持续可见。详情内保留中间失败和最终结果。</p>`;
 else if(state.page==='hosts')items=contextItem('主机列表','hosts-home','',true)+`<p class="context-foot">连接状态、Agent 状态和安装包状态分别展示。</p>`;
 else items=contextItem('设备与目录','go','sharing',true)+`<p class="context-foot">当前仅登记设备和发布能力说明。</p>`;
 $('#context').innerHTML=`<h2>${title}</h2><p class="meta">${scope}</p>${items}`;
}
function renderPage(){
 const scroll=$('#main').scrollTop;
 $('#main').innerHTML=renderers[state.page]();
 $('#main').scrollTop=scroll;renderRail();renderContext();
}
function go(page){
 if(!renderers[page])return;
 const main=$('#main');
 if(page!==state.page){cache.set(state.page,{nodes:[...main.childNodes],scroll:main.scrollTop});state.page=page;const saved=cache.get(page);if(saved){main.replaceChildren(...saved.nodes);main.scrollTop=saved.scroll;}else{main.innerHTML=renderers[page]();main.scrollTop=0;}renderRail();renderContext();}
 else renderPage();
 history.replaceState(null,'','#'+page);main.focus({preventScroll:true});
}
function refreshRoute(page){cache.delete(page);if(state.page===page)renderPage();else go(page);}
function showModal(title,html,kicker='布局与内容预览'){
 const toast=$('#toast');if(toast)document.body.append(toast);
 $('#modal-title').textContent=title;$('#modal-kicker').textContent=kicker;$('#modal-body').innerHTML=html;
 if(!$('#modal').open)$('#modal').showModal();
 $('#modal .icon-button').focus();
}
function closeModal(){if($('#modal').open)$('#modal').close();}
function notify(text){const toast=$('#toast');toast.textContent=text;toast.hidden=false;($('#modal').open?$('#modal-body'):document.body).append(toast);clearTimeout(notify.timer);notify.timer=setTimeout(()=>{toast.hidden=true;document.body.append(toast);},3000);}
function design(){const [title,proposal,boundary]=audits[state.page];showModal('页面检查与设计说明',`<div class="notice"><strong>${title}</strong><p>${proposal}</p><p class="meta">${boundary}</p></div><div class="review-grid"><article><h3>共享视觉基础</h3><p>复用产品基础色与字体令牌。标题、范围、工具栏和正文有固定层级；仅在有明确分组意义时使用卡片。</p></article><article><h3>按内容选择结构</h3><p>阅读页限制行宽，表格页利用横向空间，笔记保持连续记录。弹窗类功能继续保留底层工作区。</p></article><article><h3>真实信息不能丢</h3><p>保留失败、处理中、未知、来源和更新时间。二级操作可收纳，状态和用户输入仍需持续可见。</p></article><article><h3>检查范围</h3><p>本轮依据组件、样式和设计文档检查主要页面结构，未逐页连接生产数据截图。此 Demo 展示代表场景，并非功能完整替代品。</p></article></div><a class="callout-link" href="../page-content-review.md">查看完整检查记录 ↗</a>`,'当前页面与整体规则');}
function formModal(title,fields,submitLabel,submit){showModal(title,`<form id="demo-form">${fields}<div class="actions"><span class="meta">仅修改当前页面示例</span><button type="submit" class="primary push">${submitLabel}</button></div></form>`,'示例操作');$('#demo-form').onsubmit=e=>{e.preventDefault();submit(new FormData(e.currentTarget));};}
function toggleTheme(){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}
const handlers={
 go:value=>{closeModal();go(value);},
 workbar:()=>{state.workbar=!state.workbar;renderPage();},
 tool:value=>{state.workbar=true;state.workbarTab=value;refreshRoute('chat');},
 'new-chat':()=>{state.messages=[];state.chatDraft='';refreshRoute('chat');$('#chat-draft').focus();},
 'layout-link':()=>{location.href='../four-column-demo.html';},
 note:value=>{state.note=Number(value);state.todos=false;refreshRoute('notes');},
 'note-overview':()=>{state.note=null;state.todos=false;refreshRoute('notes');},
 todos:()=>{state.todos=!state.todos;state.note=null;refreshRoute('notes');},
 'todos-on':()=>{state.todos=true;state.note=null;refreshRoute('notes');},
 'new-note':()=>formModal('新建笔记','<label class="field">笔记标题<input name="title" required maxlength="80" placeholder="给这篇笔记起个名字"></label>','创建示例',data=>{noteData.push([data.get('title'),'新的记录从这里开始。','未分类','刚刚']);state.note=noteData.length-1;state.todos=false;closeModal();refreshRoute('notes');notify('已创建示例笔记');}),
 'doc-filter':value=>{state.docFilter=value;renderPage();},
 document:value=>{state.document=Number(value);state.knowledgeTab='documents';refreshRoute('knowledge');$('#main .document-detail')?.scrollIntoView({block:'nearest'});},
 'document-close':()=>{state.document=null;renderPage();},
 'retry-doc':()=>{notify('模拟重试已结束：示例扫描页仍缺少可提取文字。');},
 'knowledge-home':()=>{state.knowledgeTab='documents';refreshRoute('knowledge');},
 'library-scope':()=>showModal('知识库范围','<p>团队知识 · 全局 · 本地存储</p><div class="notice">来源、权限、外部知识库类型仍需在正式页面保留。此处只使用本地示例库。</div>'),
 import:()=>showModal('导入文档','<p>正式入口支持文件、目录和网页来源。</p><div class="notice">此处演示导入入口与进度的归属，不读取本机文件。</div>'+action('查看处理任务','knowledge-tasks','','primary'),'知识库 · 团队知识'),
 'knowledge-tasks':()=>{closeModal();state.knowledgeTab='tasks';refreshRoute('knowledge');},
 retrieval:()=>{formModal('检索测试','<label class="field">问题<input name="query" required placeholder="例如：页面如何组织？"></label><div id="retrieval-result"></div>','检索示例',()=>{$('#retrieval-result').innerHTML='<div class="notice"><strong>示例命中：界面设计规范.md</strong><p>标题说明对象，范围持续可见，主操作位于标题右侧。</p><small>固定示例结果，未执行真实检索。</small></div>';});},
 'supervisor-overview':()=>{state.supervisorTab='overview';refreshRoute('supervisor');},
 'supervisor-graph':()=>{state.supervisorTab='graph';renderPage();},
 review:()=>showModal('生成新回顾','<span class="scope">GoodBuddy · 最近两天</span><p>正式操作会创建回顾请求，并显示实际进度及生成时间。</p><div class="notice">此原型不调用模型，可查看示例执行记录。</div>'+action('查看示例活动','review-activity','','primary')),
 'review-activity':()=>{closeModal();state.supervisorTab='activity';refreshRoute('supervisor');},
 'new-plan':()=>formModal('新建心跳计划','<label class="field">名称<input required name="name" value="每天的项目回顾"></label><label class="field">时间<input type="time" required value="18:00" name="time"></label>','保存示例',()=>{closeModal();notify('已演示计划表单保存；未创建真实计划。');}),
 'save-review':()=>{const field=$('#review-timeout');if(field.reportValidity())notify('示例参数已确认；未修改正式配置。');},
 'graph-node':(value,button)=>{document.querySelectorAll('.graph-node').forEach(x=>x.setAttribute('aria-pressed',String(x===button)));$('#graph-detail').textContent=value+'：示例关系节点。来源为本次设计讨论，完整生产图谱支持的查询与编辑流程仍需保留。';},
 'activity-home':()=>{state.activityTab='tasks';refreshRoute('activity');},
 'hosts-home':()=>{state.hostsTab='hosts';refreshRoute('hosts');},
 'new-host':()=>formModal('添加主机','<label class="field">显示名称<input required name="name" maxlength="80" placeholder="例如：测试环境"></label><p class="meta">此原型仅添加列表条目，不收集凭据或创建连接。</p>','添加示例',data=>{state.hosts.push(data.get('name'));state.connected.push(false);closeModal();refreshRoute('hosts');}),
 'connect-host':value=>{state.connected[Number(value)]=true;renderPage();notify('示例状态已切换为已连接，未访问远程主机。');},
 'host-detail':value=>showModal(state.hosts[Number(value)],'<div class="data-row"><div><strong>Agent 状态</strong><p>示例服务已就绪</p></div>'+badge('已连接')+'</div><div class="flat-section"><h3>执行空间</h3><p>关联项目、安装版本与连接错误在各自的详情位置展示。</p></div>','主机详情 · 示例'),
 package:value=>showModal(value+' 安装包','<p>架构、版本、本地校验状态与下载进度分别展示。</p><div class="notice">此处不下载或安装任何程序。</div>','Agent 安装包 · 示例'),
 'device-config':()=>formModal('当前设备','<label class="field">设备名称<input required value="设计工作站" name="name"></label><label class="field">服务地址<input type="url" required value="https://sharing.example" name="url"></label>','保存示例',()=>{closeModal();notify('已演示保存反馈，未注册真实设备。');}),
 publish:()=>formModal('发布元数据','<label class="field">名称<input name="name" required placeholder="能力或知识来源名称"></label><label class="field">说明<textarea name="description" rows="3"></textarea></label><p class="meta">发布目标：示例目录。仅描述能力，不传输文件。</p>','确认示例',()=>{closeModal();notify('已演示发布反馈，未向外部服务写入。');}),
 publication:()=>showModal('团队设计知识','<span class="scope">来源：团队知识服务 · 示例</span><h3>知识目录说明</h3><p>设计规范、产品手册与参考资料的元数据。</p><details open><summary>声明的权限</summary><p>搜索、阅读；下载关闭。此处不执行远程访问。</p></details>'),
 settings:()=>showModal('设置',renderSettings(),'保留底层工作区'),
 'settings-category':value=>{showModal('设置',renderSettings(value),'保留底层工作区');$(`[data-action="settings-category"][data-value="${value}"]`).focus();},
 'settings-models':()=>showModal('设置',renderSettings('models'),'模型与连接'),
 apps:()=>showModal('应用中心',renderApps(),'内置应用 · 当前客户端'),
 inference:()=>showModal('本机推理监控',renderInference(),'全局 · 服务状态'),
 switch:(value,button)=>{const checked=button.getAttribute('aria-checked')!=='true';state.switches[value]=checked;button.setAttribute('aria-checked',String(checked));if(value==='theme')document.documentElement.dataset.theme=checked?'dark':'light';if(value==='density'){document.body.dataset.density=checked?'compact':'relaxed';$('#density').value=document.body.dataset.density;}},
 refresh:()=>notify('已刷新示例展示；未请求真实服务。'),
 'save-demo':()=>notify('示例表单已确认；未保存正式配置。'),
 design
};
document.addEventListener('click',event=>{
 const button=event.target.closest('[data-action]');if(!button)return;
 const name=button.dataset.action;
 if(name==='tab'){
  const group=button.dataset.group, value=button.dataset.value;
  const fields={workbar:'workbarTab',knowledge:'knowledgeTab',supervisor:'supervisorTab',activity:'activityTab',hosts:'hostsTab'};
  state[fields[group]]=value;renderPage();document.getElementById(group+'-'+value)?.focus();return;
 }
 handlers[name]?.(button.dataset.value,button);
});
document.addEventListener('keydown',event=>{
 const tab=event.target.closest('[role="tab"]');if(!tab)return;
 const list=[...tab.parentElement.querySelectorAll('[role="tab"]')];let index=list.indexOf(tab);
 if(event.key==='ArrowRight')index=(index+1)%list.length;else if(event.key==='ArrowLeft')index=(index-1+list.length)%list.length;else if(event.key==='Home')index=0;else if(event.key==='End')index=list.length-1;else return;
 event.preventDefault();list[index].click();
});
document.addEventListener('input',event=>{
 const input=event.target;if(input.id==='chat-draft')state.chatDraft=input.value;if(input.id==='note-draft')state.noteDraft=input.value;
 if(!input.dataset.search)return;
 const root=input.closest('.page')||$('#modal-body');const group=input.dataset.search;let count=0;
 root.querySelectorAll(`[data-search-item="${group}"]`).forEach(item=>{item.hidden=!item.textContent.toLowerCase().includes(input.value.trim().toLowerCase())||(group==='docs'&&state.docFilter!=='全部'&&item.dataset.status!==state.docFilter);if(!item.hidden)count++;});
 const empty=root.querySelector('.search-empty');if(empty)empty.hidden=count>0;
});
document.addEventListener('change',event=>{const input=event.target;if(input.dataset.todo!==undefined)state.done[Number(input.dataset.todo)]=input.checked;if(input.name==='layout-preview')state.layoutChoice=input.value;});
document.addEventListener('submit',event=>{
 if(event.target.id==='chat-form'){event.preventDefault();const text=state.chatDraft.trim();if(!text){$('#chat-draft').focus();return;}state.messages.push(text);state.chatDraft='';renderPage();$('#chat-draft').focus();$('.chat-history').scrollTop=$('.chat-history').scrollHeight;}
 if(event.target.id==='note-form'){event.preventDefault();if(!state.noteDraft.trim()){$('#note-draft').focus();return;}(state.records[state.note]??=[]).unshift(state.noteDraft);state.noteDraft='';renderPage();notify('示例记录已保存到本页内存');}
});
$('#modal').addEventListener('close',()=>{const toast=$('#toast');if(toast)document.body.append(toast);});
$('#theme').onclick=toggleTheme;$('#density').onchange=event=>document.body.dataset.density=event.target.value;$('#design').onclick=design;
const initial=location.hash.slice(1);if(renderers[initial])state.page=initial;renderPage();
