'use strict';
const paths = {
  home:'M3 10 12 3l9 7M5 9v11h5v-6h4v6h5V9', note:'M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM8 8h8M8 12h8M8 16h5',
  book:'M12 5v15M12 5C8 2 4 3 2 4v15c4-2 7-1 10 1 3-2 6-3 10-1V4c-2-1-6-2-10 1Z', pulse:'M3 12h4l3-7 4 14 3-7h4',more:'M4 12h1m6 0h1m6 0h1',grid:'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',info:'M12 11v6m0-10v.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',sun:'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1',search:'m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',edit:'m13 5 6 6M4 16l-1 5 5-1L21 7l-6-6ZM4 10V4h6',folder:'M3 5h6l2 3h10v12H3Z',file:'M5 2h9l5 5v15H5ZM14 2v6h5M8 13h8M8 17h6',terminal:'m5 6 5 6-5 6m8 0h6',globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',plus:'M12 4v16M4 12h16',arrow:'M12 20V4m-7 7 7-7 7 7',sidebar:'M3 3h18v18H3ZM9 3v18',split:'M3 3h18v18H3ZM14 3v18',expand:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',close:'m6 6 12 12M6 18 18 6',refresh:'M20 7V2m0 5h-5M4 17v5m0-5h5M4 8a8 8 0 0 1 14-3l2 2M4 17l2 2a8 8 0 0 0 14-3',change:'M6 3v12a4 4 0 0 0 4 4h8M15 16l3 3-3 3M3 6l3-3 3 3'
};
const $ = (selector) => document.querySelector(selector);
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
function paintIcons(root = document){root.querySelectorAll('[data-icon]').forEach(el => {el.innerHTML = icon(el.dataset.icon);});}
const projects = [
  {name:'GoodBuddy',host:'本地',items:['四栏工作空间设计','完善项目基础文档','梳理应用导航与工具入口']},
  {name:'产品设计',host:'本地',items:['下一次迭代的想法','整理用户访谈记录']},
  {name:'知识服务',host:'dev-server',items:['检查索引更新进度','优化文档阅读体验']},
  {name:'个人工作空间',host:'本地',items:['本周的工作安排','一些值得记录的想法']}
];
let selectedProject = 'GoodBuddy', selectedConversation = '', nextTab = 1, activeTab = 0;
let tabs = [{id:0,type:'start',title:'新标签页'}];
const conversations = new Map();
let draftKey = 'GoodBuddy/';
const shell = $('.shell');
const demoPreferenceKey = 'goodbuddy.demo.four-column-layout.v1';
const defaultPreferences = () => ({selected:'workbench',classic:{objects:true,workspace:false,share:62},workbench:{objects:true,workspace:true,share:46}});
let preferences = defaultPreferences(), applyingLayout = false, autoObjectsHidden = false;
try {
  const saved = JSON.parse(localStorage.getItem(demoPreferenceKey));
  if (saved && ['classic','workbench'].includes(saved.selected)) {
    preferences.selected = saved.selected;
    for (const name of ['classic','workbench']) {
      const value = saved[name];
      if (value && typeof value.objects === 'boolean' && typeof value.workspace === 'boolean' && Number.isFinite(value.share))
        preferences[name] = {objects:value.objects,workspace:value.workspace,share:Math.max(30,Math.min(65,value.share))};
    }
  }
} catch { /* Demo remains usable without browser storage. */ }
const navigation = $('.rail-top'), navigationFooter = $('.rail-bottom');
function rememberLayout(){
  if(applyingLayout)return;
  preferences[preferences.selected]={objects:autoObjectsHidden?preferences[preferences.selected].objects:!shell.classList.contains('objects-hidden'),workspace:!shell.classList.contains('workspace-hidden'),share:Number($('#resize').getAttribute('aria-valuenow'))};
  try{localStorage.setItem(demoPreferenceKey,JSON.stringify(preferences));}catch{/* In-memory preference still applies. */}
  syncPresets();
}
function syncPresets(){
  const objects=!shell.classList.contains('objects-hidden'), workspace=!shell.classList.contains('workspace-hidden');
  document.querySelectorAll('[data-layout]').forEach(button=>{
    const selected=button.dataset.layout===(workspace?(objects?'work':''):(objects?'chat':'focus'));
    button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));
  });
}
function selectLayout(name){
  applyingLayout=true;
  preferences.selected=name;shell.dataset.shellLayout=name;
  (name==='classic'?$('#classic-navigation'):$('.rail')).append(navigation);
  (name==='classic'?$('#classic-footer'):$('.rail')).append(navigationFooter);
  const value=preferences[name];shell.classList.remove('maximized');autoObjectsHidden=innerWidth<=900;setObjects(autoObjectsHidden?false:value.objects);setWorkspace(value.workspace);setShare(value.share);
  document.querySelectorAll('[name="shell-layout"]').forEach(input=>input.checked=input.value===name);
  $('#layout-status').textContent='当前：'+(name==='classic'?'经典布局':'工作台布局')+' · 可关闭设置查看，随时切回';
  applyingLayout=false;rememberLayout();
}
function showLayoutSettings(){
  if($('#account-menu').matches(':popover-open'))$('#account-menu').hidePopover();
  $('#layout-dialog').showModal();
}
function notify(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(notify.timer);notify.timer=setTimeout(()=>$('#toast').hidden=true,3000);}
function setObjects(open){if(!applyingLayout)autoObjectsHidden=false;shell.classList.toggle('objects-hidden',!open);$('#toggle-objects').setAttribute('aria-expanded',String(open));$('#toggle-objects').setAttribute('aria-label',open?'收起项目与会话':'展开项目与会话');rememberLayout();}
function setWorkspace(open){shell.classList.toggle('workspace-hidden',!open);if(!open)shell.classList.remove('maximized');$('#toggle-workspace').setAttribute('aria-expanded',String(open));$('#toggle-workspace').setAttribute('aria-label',open?'关闭工作区':'打开工作区');$('#maximize').setAttribute('aria-label',shell.classList.contains('maximized')?'恢复工作区':'最大化工作区');rememberLayout();}
function layout(mode){shell.classList.remove('maximized');setObjects(mode!=='focus');setWorkspace(mode==='work');syncPresets();}
function renderProjects(){
  const query=$('#search').value.trim().toLowerCase(); const list=$('#project-list');list.replaceChildren();
  projects.forEach(project=>{
    const matches=project.items.filter(name=>name.toLowerCase().includes(query)||project.name.toLowerCase().includes(query));if(query&&!matches.length)return;
    const section=document.createElement('section');section.className='project';
    const header=document.createElement('button');header.className='project-button'+(project.name===selectedProject?' current':'');header.innerHTML=icon('folder');
    const label=document.createElement('span');label.className='project-label';label.textContent=project.name;header.append(label);
    const host=document.createElement('span');host.className='host';host.textContent=project.host;header.append(host);
    const dot=document.createElement('span');dot.className='status-dot';header.append(dot);header.setAttribute('aria-expanded','true');section.append(header);
    const children=document.createElement('div');header.onclick=()=>{children.hidden=!children.hidden;header.setAttribute('aria-expanded',String(!children.hidden));};
    matches.forEach(name=>{const button=document.createElement('button');button.className='conversation'+(name===selectedConversation&&project.name===selectedProject?' selected':'');button.textContent=name;button.title=name;button.onclick=()=>selectConversation(project.name,name);children.append(button);});section.append(children);list.append(section);
  });
  if(!list.children.length){const empty=document.createElement('p');empty.className='empty-result';empty.textContent='没有匹配的项目或会话';list.append(empty);}
}
function current(){if(!conversations.has(draftKey))conversations.set(draftKey,{draft:'',messages:[]});return conversations.get(draftKey);}
function selectConversation(project,name){current().draft=$('#prompt').value;selectedProject=project;selectedConversation=name;draftKey=project+'/'+name;$('#project-name').textContent=project;$('#context-name').textContent=project;$('#conversation-title').textContent=name||'新的开始';$('#prompt').value=current().draft;renderProjects();renderMessages();if(innerWidth<=900)setObjects(false);}
function renderMessages(){const messages=current().messages;$('#welcome').hidden=messages.length>0;$('#messages').hidden=!messages.length;$('#chat-body').classList.toggle('has-messages',messages.length>0);$('#messages').replaceChildren();messages.forEach(message=>{const node=document.createElement('div');node.className='message '+message.role;node.textContent=message.text;$('#messages').append(node);});}
const toolNames={start:'新标签页',browser:'浏览器',files:'项目文件',terminal:'终端',changes:'变更',notes:'魔法笔记',knowledge:'知识库',supervisor:'监督者'};
function openTool(type){let existing=tabs.find(tab=>tab.type===type&&type!=='start');if(!existing){existing={id:nextTab++,type,title:toolNames[type]||type};tabs.push(existing);}activeTab=existing.id;setWorkspace(true);renderWorkspace();document.querySelectorAll('[popover]').forEach(el=>{if(el.matches(':popover-open'))el.hidePopover();});}
function renderWorkspace(){
  const bar=$('#tabs');bar.replaceChildren();tabs.forEach(tab=>{const wrapper=document.createElement('div');wrapper.className='tab'+(tab.id===activeTab?' active':'');const button=document.createElement('button');button.id='tab-'+tab.id;button.setAttribute('role','tab');button.setAttribute('aria-selected',String(tab.id===activeTab));button.setAttribute('aria-controls','workspace-content');button.tabIndex=tab.id===activeTab?0:-1;button.innerHTML=icon(tab.type==='start'||tab.type==='browser'?'globe':tab.type==='terminal'?'terminal':'file');const label=document.createElement('span');label.textContent=tab.title;button.append(label);button.onclick=()=>{activeTab=tab.id;renderWorkspace();$('#tab-'+tab.id).focus();};button.onkeydown=event=>{let index=tabs.indexOf(tab);if(event.key==='ArrowRight')index=(index+1)%tabs.length;else if(event.key==='ArrowLeft')index=(index-1+tabs.length)%tabs.length;else if(event.key==='Home')index=0;else if(event.key==='End')index=tabs.length-1;else return;event.preventDefault();activeTab=tabs[index].id;renderWorkspace();$('#tab-'+activeTab).focus();};const close=document.createElement('button');close.className='tab-close';close.setAttribute('aria-label','关闭 '+tab.title);close.innerHTML=icon('close');close.onclick=()=>{const index=tabs.indexOf(tab);tabs=tabs.filter(item=>item.id!==tab.id);if(!tabs.length)tabs=[{id:nextTab++,type:'start',title:'新标签页'}];if(activeTab===tab.id)activeTab=tabs[Math.min(index,tabs.length-1)].id;renderWorkspace();$('#tab-'+activeTab).focus();};wrapper.append(button,close);bar.append(wrapper);});
  const tab=tabs.find(item=>item.id===activeTab);const content=$('#workspace-content');content.setAttribute('aria-labelledby','tab-'+activeTab);
  if(tab.type==='start'||tab.type==='browser'){
    content.innerHTML=`<form class="addressbar" id="address-form"><span data-icon="globe"></span><input aria-label="示例网址" placeholder="搜索或输入网址" value="${tab.address?'https://goodbuddy.example/docs':''}"><button class="icon-button" title="打开示例页面" aria-label="打开示例页面" data-icon="arrow"></button></form><div class="start-page"><p class="section-label">工作空间工具</p><div class="tool-grid"><button class="tool-card" data-tool="changes"><span data-icon="change"></span>变更<small>3 个文件</small></button><button class="tool-card" data-tool="terminal"><span data-icon="terminal"></span>终端<small>本地</small></button><button class="tool-card" data-tool="files"><span data-icon="folder"></span>文件<small>GoodBuddy</small></button><button class="tool-card" data-tool="notes"><span data-icon="edit"></span>新建笔记</button></div><p class="section-label">继续手头的工作</p><button class="recent-card" data-tool="files"><span class="doc-icon">▤</span><strong>让工作空间更专注</strong><p>设计说明 · 刚刚编辑</p></button><button class="recent-card" data-tool="changes"><span class="doc-icon">⌘</span><strong>查看本次界面调整</strong><p>3 个文件变更 · main</p></button></div>`;
    $('#address-form').onsubmit=event=>{event.preventDefault();tab.address=true;content.innerHTML='<article class="document"><div class="doc-meta">浏览器 · 本地示例页面</div><h1>GoodBuddy 使用指南</h1><p>让对话与手头的工作保持在同一个空间。</p><h2>从一个问题开始</h2><p>在左侧继续讨论，在右侧阅读文档、查看文件或检查执行结果。</p><blockquote>这是浏览器布局预览，没有请求输入的网址。</blockquote><button class="primary-button" id="browser-home">返回新标签页</button></article>';$('#browser-home').onclick=()=>{tab.address=false;renderWorkspace();};};
  }else if(tab.type==='files'){
    content.innerHTML='<div class="file-layout"><nav class="file-tree" aria-label="示例文件"><button class="selected" data-file="README.md">▤ README.md</button><button data-file="ui-design.md">▤ ui-design.md</button><button data-file="notes.md">▤ notes.md</button></nav><article class="document" id="document"></article></div>';renderDocument('README.md');
  }else if(tab.type==='terminal'){
    content.innerHTML='<div class="terminal"><span class="dim">GoodBuddy / 本地终端 · 演示输出</span>\n\n<span class="green">❯</span> git status\nOn branch main\nYour branch is up to date.\n\nChanges not staged for commit:\n  <span class="green">modified:   docs/ui-design.md\n  modified:   src/layout.css\n  modified:   src/workspace.tsx</span>\n\n<span class="green">❯</span> npm run dev\n\n  VITE ready in 284 ms\n\n  <span class="green">➜</span> Local: http://localhost:5173/\n\n<span class="dim">此面板仅展示示例，不执行命令。</span>\n<span class="green">❯</span> ▍</div>';
  }else if(tab.type==='changes'){
    content.innerHTML='<article class="document"><div class="doc-meta">GoodBuddy / main · 示例变更</div><h1>工作区变更</h1><p>3 个文件 · 尚未提交</p><div class="change-row"><span>docs/ui-design.md</span><span>+24 −6</span></div><div class="change-row"><span>src/layout.css</span><span>+86 −32</span></div><div class="change-row"><span>src/workspace.tsx</span><span>+42 −18</span></div><blockquote>在这里检查工作成果，同时保留左侧对话。</blockquote></article>';
  }else{content.innerHTML=`<article class="document"><div class="doc-meta">应用内容预览 · ${toolNames[tab.type]}</div><h1>${tab.type==='notes'?'记下一个好想法':tab.type==='knowledge'?'团队知识，随手可得':'今天的工作进展'}</h1><p>这个页面展示应用内容与聊天并排时的空间关系。</p><h2>四栏布局的讨论记录</h2><ul><li>全局应用入口保持在最左侧。</li><li>项目和会话列表可以独立收起。</li><li>阅读与操作内容拥有完整工作区。</li></ul><blockquote>此处为候选内容预览，应用完整页面尚未接入。</blockquote></article>`;}
  paintIcons(content);
}
function renderDocument(file){$('#document').innerHTML=`<div class="doc-meta">GoodBuddy / ${file} · 示例文档</div><h1>${file==='README.md'?'让工作空间更专注':file==='ui-design.md'?'界面与交互约定':'设计讨论记录'}</h1><p>把对话、资料与工具放在触手可及的位置，让每一次切换都更自然。</p><h2>一个完整的工作空间</h2><p>左侧找到项目与会话，中间推进讨论，右侧展开正在处理的内容。各区域拥有清晰的边界，也能一起完成同一件事。</p><blockquote>聊天与工作内容共享空间，按任务需要调整比例。</blockquote><h2>保持上下文</h2><ul><li>收起列表，继续当前工作。</li><li>打开多个标签，在资料之间切换。</li><li>展开工作区，专注阅读和检查。</li></ul><h2>接下来</h2><p>验证常用窗口宽度下的阅读体验，以及输入区、标签栏和导航的收放。</p>`;}
document.addEventListener('click',event=>{const tool=event.target.closest('[data-tool]');if(tool)openTool(tool.dataset.tool);const app=event.target.closest('[data-app]');if(app){document.querySelectorAll('.rail [data-app]').forEach(button=>{button.classList.toggle('active',button.dataset.app===app.dataset.app);if(button.dataset.app===app.dataset.app)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});if(app.dataset.app==='chat'){shell.classList.remove('maximized');setWorkspace(false);}else openTool(app.dataset.app);}const file=event.target.closest('[data-file]');if(file){document.querySelectorAll('[data-file]').forEach(button=>button.classList.toggle('selected',button===file));renderDocument(file.dataset.file);}});
document.querySelectorAll('[data-layout]').forEach(button=>button.onclick=()=>layout(button.dataset.layout));
$('#toggle-objects').onclick=()=>setObjects(shell.classList.contains('objects-hidden'));
$('#toggle-workspace').onclick=()=>setWorkspace(shell.classList.contains('workspace-hidden'));
$('#close-workspace').onclick=()=>{setWorkspace(false);$('#toggle-workspace').focus();};
$('#maximize').onclick=()=>{shell.classList.toggle('maximized');$('#maximize').setAttribute('aria-label',shell.classList.contains('maximized')?'恢复工作区':'最大化工作区');};
$('#add-tab').onclick=()=>openTool('start');
$('#theme').onclick=$('#account-theme').onclick=()=>document.body.classList.toggle('dark');
$('#reset').onclick=()=>{preferences=defaultPreferences();selectLayout('workbench');document.body.classList.remove('dark');$('#account-menu').hidePopover();};
$('#layout-settings').onclick=$('#account-layout').onclick=showLayoutSettings;
document.querySelectorAll('[name="shell-layout"]').forEach(input=>input.onchange=()=>selectLayout(input.value));
$('#help').onclick=()=>$('#info-dialog').showModal();
$('#search-toggle').onclick=()=>{$('#search').hidden=!$('#search').hidden;if(!$('#search').hidden)$('#search').focus();else{$('#search').value='';renderProjects();}};
$('#search').oninput=renderProjects;
$('#context-project').onclick=()=>setObjects(true);
$('#new-chat').onclick=()=>{const project=projects.find(item=>item.name===selectedProject);const name='新会话 '+(project.items.length+1);project.items.unshift(name);selectConversation(selectedProject,name);$('#prompt').focus();};
$('#prompt').oninput=()=>current().draft=$('#prompt').value;
$('#composer').onsubmit=event=>{event.preventDefault();const text=$('#prompt').value.trim();if(!text){$('#prompt').focus();return;}current().messages.push({role:'user',text},{role:'assistant',text:'这是一条演示回复。我们可以在这里继续讨论，同时在右侧打开文件、终端或网页。\n\n试着拖动中间的分隔线，或者收起项目列表，看看哪种比例更适合当前工作。'});current().draft='';$('#prompt').value='';renderMessages();$('#chat-body').scrollTop=$('#chat-body').scrollHeight;};
function setShare(value){const share=Math.max(30,Math.min(65,value));$('.content-frame').style.setProperty('--share-number',share/100);$('#resize').setAttribute('aria-valuenow',String(Math.round(share)));rememberLayout();}
let dragging=false;
$('#resize').onpointerdown=event=>{if(event.button!==0)return;dragging=true;$('#resize').setPointerCapture(event.pointerId);document.body.classList.add('resizing');event.preventDefault();};
$('#resize').onpointermove=event=>{if(!dragging)return;const frame=$('.content-frame').getBoundingClientRect();const objects=$('#objects');const width=getComputedStyle(objects).display==='none'||innerWidth<=900?0:objects.getBoundingClientRect().width;setShare((event.clientX-frame.left-width)/(frame.width-width)*100);};
function endDrag(){dragging=false;document.body.classList.remove('resizing');}
$('#resize').onpointerup=endDrag;$('#resize').onpointercancel=endDrag;$('#resize').onlostpointercapture=endDrag;
$('#resize').onkeydown=event=>{const value=Number($('#resize').getAttribute('aria-valuenow'));if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();setShare(value+(event.key==='ArrowRight'?2:-2));}};
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&innerWidth<=900)setObjects(false);});
paintIcons();renderProjects();renderWorkspace();selectLayout(preferences.selected);
matchMedia('(max-width:900px)').addEventListener('change',event=>{
  applyingLayout=true;autoObjectsHidden=event.matches;setObjects(event.matches?false:preferences[preferences.selected].objects);applyingLayout=false;syncPresets();
});
// The same navigation nodes live in either layout.
document.addEventListener('click',event=>{
  const app=event.target.closest('[data-app]');if(!app)return;
  navigation.querySelectorAll('[data-app]').forEach(button=>{
    const active=button.dataset.app===app.dataset.app;button.classList.toggle('active',active);
    if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
  });
});
