/* global document, window, history, location, matchMedia, innerWidth, Event, setTimeout, clearTimeout */
const paths = {
  note: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  book: '<path d="M12 5v16M12 5C8 2 4 3 2 4v15c4-1 7-1 10 2 3-3 6-3 10-2V4c-2-1-6-2-10 1Z"/>',
  chat: '<path d="M21 11a9 9 0 0 1-9 9H3l1-5A9 9 0 1 1 21 11Z"/>',
  history: '<path d="M3 4v5h5M3 9a9 9 0 1 1 0 6m9-8v5l3 2"/>',
  settings: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
  activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 17l10 5 10-5"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.layers}</svg>`;
const items = [
  { id: 'notes', name: '魔法笔记', icon: 'note', detail: '记录想法、整理待办', summary: '把刚才的灵感留在这里', builtin: true },
  { id: 'knowledge', name: '知识库', icon: 'book', detail: '整理资料、检索知识', summary: '下一次提问，从已有知识开始', builtin: true },
  { id: 'heartbeat', name: '智能心跳', icon: 'activity', detail: '管理定时任务与主动提醒', summary: '让例行任务按计划发生', builtin: true },
  { id: 'projects', name: '项目管理', icon: 'layers', detail: '跟踪项目、任务与进度', summary: '把一个想法变成可跟进的项目', builtin: false },
  { id: 'reading', name: '阅读空间', icon: 'book', detail: '集中阅读、批注与摘录', summary: '给长文和深度阅读留一个空间', builtin: false }
];
const variants = {
  dock: ['A / 紧凑入口', '最底部保留一个应用中心入口，向上展开紧凑列表。', '适合希望把侧栏空间留给对话的用户。'],
  grid: ['B / 应用宫格', '底部入口展示应用数量，展开后用宫格浏览已安装应用。', '图标与名称同时可见，常驻位置由用户选择。'],
  cards: ['C / 应用预览', '入口展示内置应用图标，展开后用卡片说明每个应用的用途。', '适合通过内容理解应用，卡片不代表后台持续运行。'],
  launcher: ['D / 搜索启动台', '最底部就是搜索入口，也可以按 Ctrl / ⌘ K 打开。', '输入名称，用方向键与 Enter 打开已安装应用。'],
  favorites: ['E / 常驻管理', '从底部管理哪些应用常驻菜单，未常驻应用也可直接打开。', '常驻应用优先排列；入口显隐不影响安装和运行状态。'],
  scenes: ['F / 商店发现', '底部入口强调应用发现，展开后查看商店应用与安装位置。', '先模拟安装，再决定是否常驻；我的应用始终可切换访问。']
};
const $ = selector => document.querySelector(selector);
const demoProjects = [
  { id: 'goodbuddy', name: 'GoodBuddy', group: '本地', conversations: ['优化项目导航', '检查构建问题'] },
  { id: 'website', name: '官网改版', group: '本地', conversations: ['发布首页'] },
  { id: 'remote', name: '客户方案与交付文档工作空间', group: 'SSH', conversations: ['整理报价'] },
  { id: 'channel', name: '团队助手', group: '通道', conversations: ['本周工作计划'] }
];
let currentProject = 'goodbuddy';
let projectActivity = [];
let expandedActivityProject = '';
function renderProjects() {
  const scenario = $('#project-scenario').value;
  const activity = demoProjects.flatMap(project => project.conversations.map((name, index) => ({ project, name, index,
    state: scenario === 'idle' || project.id === 'channel' || (scenario === 'current' && project.id !== currentProject) ? '' : scenario === 'waiting' && project.id === 'website' ? '等待审批' : '运行中'
  }))).filter(row => row.state);
  projectActivity = activity;
  const waiting = activity.filter(row => row.state !== '运行中').length;
  const running = activity.length - waiting;
  const project = demoProjects.find(entry => entry.id === currentProject);
  $('#project-name').textContent = project.name;
  $('#project-trigger').setAttribute('aria-label', `切换项目，当前项目：${project.name}`);
  $('#activity-trigger').hidden = !activity.length;
  if (!activity.length && $('#project-activity').matches(':popover-open')) $('#project-activity').hidePopover();
  $('#activity-summary').innerHTML = `${running ? `运行中 ${running}` : ''}${waiting && running ? ' · ' : ''}${waiting ? `<span class="project-waiting">待处理 ${waiting}</span>` : ''}`;
  $('#activity-trigger').setAttribute('aria-label', `所有项目活动：${$('#activity-summary').textContent}`);
  $('#project-list').innerHTML = ['本地', 'SSH', '通道'].map(group => `<section><h3>${group}</h3>${demoProjects.filter(entry => entry.group === group).map(entry => {
    const rows = activity.filter(row => row.project.id === entry.id);
    const pending = rows.filter(row => row.state !== '运行中').length;
    const active = rows.length - pending;
    return `<button data-project="${entry.id}" ${entry.id === currentProject ? 'aria-current="true"' : ''}><span class="project-row-name">${entry.name}</span>${entry.id === currentProject ? '<span aria-hidden="true">✓</span>' : ''}${rows.length ? `<small>${pending ? `<span class="project-waiting">待处理 ${pending}</span>` : ''}${active ? `<span>运行中 ${active}</span>` : ''}</small>` : ''}</button>`;
  }).join('')}</section>`).join('');
  $('#activity-project-list').innerHTML = demoProjects.map(entry => {
    const rows = activity.filter(row => row.project.id === entry.id);
    if (!rows.length) return '';
    const pending = rows.filter(row => row.state !== '运行中').length;
    return `<button data-activity-project="${entry.id}" aria-expanded="false" aria-controls="activity-sessions"><span>${entry.name}</span><small>${pending ? `<span class="project-waiting">待处理 ${pending}</span>` : `运行中 ${rows.length}`}</small><span aria-hidden="true">›</span></button>`;
  }).join('') || '<p class="muted">暂无运行中或待处理会话。</p>';
  expandActivityProject('');
  $('.history').innerHTML = `<span class="eyebrow">当前项目对话</span>${project.conversations.map((name, index) => {
    const row = activity.find(entry => entry.project.id === currentProject && entry.index === index);
    return `<button data-conversation="${currentProject}" data-conversation-index="${index}">${name}${row ? `<small>${row.state}</small>` : ''}</button>`;
  }).join('')}`;
}
$('#project-scenario').onchange = renderProjects;
const projectMenu = $('#project-menu');
function positionProjectMenu() {
  const rect = $('#project-trigger').getBoundingClientRect();
  projectMenu.style.left = `${Math.max(16, Math.min(rect.left, innerWidth - projectMenu.offsetWidth - 16))}px`;
  projectMenu.style.top = `${Math.max(16, Math.min(rect.bottom + 8, window.innerHeight - projectMenu.offsetHeight - 16))}px`;
}
projectMenu.addEventListener('toggle', event => {
  $('#project-trigger').setAttribute('aria-expanded', String(event.newState === 'open'));
  if (event.newState === 'open') positionProjectMenu();
});
window.addEventListener('resize', () => { if (projectMenu.matches(':popover-open')) positionProjectMenu(); });
window.addEventListener('scroll', () => { if (projectMenu.matches(':popover-open')) positionProjectMenu(); }, true);
function positionActivityMenu() {
  const panel = $('#project-activity');
  const rect = $('#activity-trigger').getBoundingClientRect();
  panel.classList.toggle('activity-compact', innerWidth < 620);
  panel.classList.toggle('activity-left', innerWidth >= 620 && rect.left + panel.offsetWidth > innerWidth - 16 && rect.right >= panel.offsetWidth + 16);
  const left = panel.classList.contains('activity-left') ? rect.right - panel.offsetWidth : rect.left;
  panel.style.left = `${Math.max(16, Math.min(left, innerWidth - panel.offsetWidth - 16))}px`;
  panel.style.top = `${Math.max(16, Math.min(rect.bottom + 4, window.innerHeight - panel.offsetHeight - 16))}px`;
}
function expandActivityProject(id, focus = false) {
  expandedActivityProject = id;
  $('#activity-sessions').hidden = !id;
  $('#project-activity').classList.toggle('has-submenu', Boolean(id));
  document.querySelectorAll('[data-activity-project]').forEach(button => button.setAttribute('aria-expanded', String(button.dataset.activityProject === id)));
  if (id) {
    $('#activity-project-title').textContent = demoProjects.find(project => project.id === id).name;
    $('#activity-list').innerHTML = projectActivity.filter(row => row.project.id === id).sort((a, b) => Number(a.state === '运行中') - Number(b.state === '运行中')).map(row => `<button data-conversation="${id}" data-conversation-index="${row.index}"><strong>${row.name}</strong><small>${row.state}</small></button>`).join('');
  }
  if ($('#project-activity').matches(':popover-open')) positionActivityMenu();
  if (focus) $('#activity-list button')?.focus();
}
$('#project-activity').addEventListener('toggle', event => {
  $('#activity-trigger').setAttribute('aria-expanded', String(event.newState === 'open'));
  if (event.newState === 'open') { expandActivityProject(''); positionActivityMenu(); }
});
$('#activity-project-list').addEventListener('pointerover', event => {
  const button = event.target.closest('[data-activity-project]');
  if (event.pointerType === 'mouse' && innerWidth >= 620 && button && button.dataset.activityProject !== expandedActivityProject) expandActivityProject(button.dataset.activityProject);
});
$('#activity-project-list').addEventListener('click', event => {
  const button = event.target.closest('[data-activity-project]');
  if (button) expandActivityProject(button.dataset.activityProject, true);
});
$('#activity-back').onclick = () => {
  const id = expandedActivityProject;
  expandActivityProject('');
  $(`[data-activity-project="${id}"]`)?.focus();
};
$('#project-activity').addEventListener('keydown', event => {
  const button = event.target.closest('[data-activity-project]');
  if (event.key === 'ArrowRight' && button) { event.preventDefault(); expandActivityProject(button.dataset.activityProject, true); }
  if ((event.key === 'ArrowLeft' || event.key === 'Escape') && expandedActivityProject) { event.preventDefault(); event.stopPropagation(); $('#activity-back').click(); }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const buttons = [...document.querySelectorAll(button ? '[data-activity-project]' : '#activity-list button')];
    const index = buttons.indexOf(document.activeElement);
    if (index >= 0) { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus(); }
  }
});
window.addEventListener('resize', () => { if ($('#project-activity').matches(':popover-open')) positionActivityMenu(); });
window.addEventListener('scroll', () => { if ($('#project-activity').matches(':popover-open')) positionActivityMenu(); }, true);
renderProjects();
let variant = 'dock';
let catalogMode = 'apps';
let residentApps = ['notes', 'knowledge'];
let editingApps = false;
let draggedApp = '';
let installed = new Set(items.filter(item => item.builtin).map(item => item.id));
let toastTimer;
let settingsOpen = false;
const noteSettings = { showCount: true, mode: 'immediate', format: 'combined' };
const noteModes = { immediate: '即时', 'after-save-auto': '保存后自动', 'after-save-manual': '保存后手动' };
const noteFormats = { combined: '长评 + 要点', narrative: '长评', structured: '要点' };
function renderNoteSettings() {
  $('#app-settings').innerHTML = `<div class="note-setting-row"><div><strong>常驻左侧菜单</strong><p>对应“显示魔法笔记入口”，移除后仍可从应用中心打开。</p></div><button class="demo-switch" role="switch" aria-label="常驻左侧菜单" aria-checked="${residentApps.includes('notes')}" data-note-toggle="resident"></button></div>
    <div class="note-setting-row"><div><strong>显示未完成待办数量</strong><p>在左侧入口显示数量，超过 99 项显示 99+。本 Demo 使用 3 项示例。</p></div><button class="demo-switch" role="switch" aria-label="显示未完成待办数量" aria-checked="${noteSettings.showCount}" data-note-toggle="showCount"></button></div>
    <fieldset class="note-setting-options"><legend>AI 评论方式</legend><div class="note-segments" role="group" aria-label="AI 评论方式">${Object.entries(noteModes).map(([value, label]) => `<button data-note-mode="${value}" aria-pressed="${noteSettings.mode === value}">${label}</button>`).join('')}</div><p>即时：按回车并停止输入 5 秒后评论未保存草稿。保存后自动：保存后评论。保存后手动：点击 AI 分析后评论。</p></fieldset>
    <fieldset class="note-setting-options"><legend>AI 评论形式</legend><div class="note-segments" role="group" aria-label="AI 评论形式">${Object.entries(noteFormats).map(([value, label]) => `<button data-note-format="${value}" aria-pressed="${noteSettings.format === value}">${label}</button>`).join('')}</div><p>默认同时生成流式长评和结构化要点，也可只保留其中一种。</p></fieldset>
    <div class="note-settings-preview"><span class="eyebrow">当前配置预览</span><p>${noteModes[noteSettings.mode]} · ${noteFormats[noteSettings.format]}</p><small>选择后即时保留于本次 Demo 会话，不调用 AI、不修改真实设置。</small></div>`;
  if ($('#note-settings-summary')) $('#note-settings-summary').textContent = `当前设置：${noteModes[noteSettings.mode]} · ${noteFormats[noteSettings.format]}。待办数量${noteSettings.showCount ? '显示' : '隐藏'}。`;
}
function showNoteSettings() {
  if (!$('#catalog').open) { catalogMode = 'apps'; $('#search').value = ''; }
  settingsOpen = true;
  $('#catalog').dataset.variant = variant;
  $('#catalog-title').textContent = '魔法笔记设置';
  $('#catalog-description').textContent = '调整入口与 AI 评论行为。应用中心和笔记页面共享这份演示配置。';
  $('#back-to-apps').hidden = false; $('#app-settings').hidden = false;
  for (const selector of ['.center-switch', '#search', '#catalog-items']) $(selector).hidden = true;
  renderNoteSettings();
  if (!$('#catalog').open) $('#catalog').showModal();
  $('#back-to-apps').focus();
}
function notify(text) {
  $('#toast').textContent = text; $('#toast').classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2200);
}
function renderApps() {
  $('#edit-apps').textContent = editingApps ? '完成' : '编辑';
  $('#resident-list').innerHTML = residentApps.map((id, index) => {
    const item = items.find(entry => entry.id === id);
    return `<div class="resident-row" data-resident="${id}" draggable="${editingApps}"><button data-open="${id}" ${$('#page-label').textContent === item.name ? 'aria-current="page"' : ''}>${icon(item.icon)}<span>${item.name}</span>${id === 'notes' && noteSettings.showCount ? '<small class="note-count" aria-label="3 项未完成待办（示例）">3</small>' : ''}</button>${editingApps ? `<div class="edit-actions"><button data-move="${id}" data-direction="-1" aria-label="上移${item.name}" ${index === 0 ? 'disabled' : ''}>↑</button><button data-pin="${id}" aria-label="移除${item.name}">×</button><button data-move="${id}" data-direction="1" aria-label="下移${item.name}" ${index === residentApps.length - 1 ? 'disabled' : ''}>↓</button></div>` : ''}</div>`;
  }).join('') || '<p class="empty-apps">点击 ＋，选择常驻应用。</p>';
  const subtitles = { dock: '', grid: `${installed.size} 个已安装应用`, cards: '笔记 · 知识 · 自动化', launcher: 'Ctrl / ⌘ K', favorites: `${residentApps.length} 个应用常驻菜单`, scenes: '发现你的下一个好应用' };
  $('#center-entry').innerHTML = `<button id="open-center" aria-haspopup="dialog"><span class="brand-mark">${variant === 'launcher' ? icon('search') : 'GB'}</span><span><strong>${variant === 'launcher' ? '搜索应用…' : '应用中心'}</strong>${subtitles[variant] ? `<small>${subtitles[variant]}</small>` : ''}</span><span class="entry-arrow">${variant === 'scenes' ? '↗' : '⌃'}</span></button>`;
}
function renderCatalog() {
  const query = $('#search').value.trim().toLowerCase();
  const matches = items.filter(item => (catalogMode === 'store' ? !item.builtin : installed.has(item.id)) && `${item.name}${item.detail}`.toLowerCase().includes(query));
  if (variant === 'favorites') matches.sort((a, b) => Number(residentApps.includes(b.id)) - Number(residentApps.includes(a.id)));
  $('#catalog-items').innerHTML = matches.map(item => {
    const ready = installed.has(item.id); const pinned = residentApps.includes(item.id);
    return `<article class="center-app">${icon(item.icon)}<div class="center-app-info"><strong>${item.name}</strong><p>${item.builtin ? '内置应用' : '商店应用 · 示例'}</p><p class="app-detail">${variant === 'cards' ? item.summary : item.detail}</p></div><div class="center-actions">${ready ? `<button data-open="${item.id}">打开</button>${item.id === 'notes' ? '<button data-note-settings aria-label="魔法笔记设置">设置</button>' : ''}<button data-pin="${item.id}" aria-pressed="${pinned}">${pinned ? '取消常驻' : '常驻左侧'}</button>` : `<button data-install="${item.id}">模拟安装</button><button data-install-pin="${item.id}">安装并常驻</button>`}</div></article>`;
  }).join('') || '<p class="empty-apps">没有匹配的应用。可以换个关键词，或切换到商店。</p>';
  document.querySelectorAll('.center-switch button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.catalog === catalogMode)));
}
function openCatalog(mode = 'apps') {
  settingsOpen = false; $('#back-to-apps').hidden = true; $('#app-settings').hidden = true;
  for (const selector of ['.center-switch', '#search', '#catalog-items']) $(selector).hidden = false;
  catalogMode = mode; $('#catalog').dataset.variant = variant;
  $('#catalog-title').textContent = mode === 'store' ? '发现新应用' : '应用中心';
  $('#catalog-description').textContent = mode === 'store' ? '安装你需要的应用，自主决定是否常驻左侧菜单。' : '打开应用，或把常用应用留在左侧。系统工具请使用右侧工作栏。';
  $('#search').value = ''; renderCatalog();
  if (!$('#catalog').open) $('#catalog').showModal();
  $('#search').focus();
}
function openPage(name) {
  if ($('#catalog').open) $('#catalog').close();
  $('#page-label').textContent = name;
  $('#page-content').replaceChildren();
  const title = document.createElement('h1'); title.textContent = name;
  const description = document.createElement('p'); description.className = 'muted'; description.textContent = '主内容区页面预览。右侧工作栏保持当前工具状态。';
  $('#page-content').append(title, description);
  $('#page-actions').innerHTML = name === '魔法笔记' ? `<button data-note-settings>${icon('settings')} 笔记设置</button>` : '';
  if (name === '魔法笔记' || name === '设置') {
    const summary = document.createElement('p'); summary.id = 'note-settings-summary'; summary.className = 'muted'; $('#page-content').append(summary);
    if (name === '设置') { const button = document.createElement('button'); button.dataset.noteSettings = ''; button.textContent = '魔法笔记设置'; $('#page-content').append(button); }
    renderNoteSettings();
  }
  document.querySelectorAll('.navigation button').forEach(button => button.classList.toggle('selected', button.dataset.page === name));
  renderApps(); notify(`已打开${name}`);
}
function selectVariant(name) {
  variant = name; $('.app').dataset.variant = name;
  document.querySelectorAll('button[data-variant]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.variant === name)));
  [$('#variant-label').textContent, $('#variant-description').textContent, $('#design-tradeoff').textContent] = variants[name];
  history.replaceState(null, '', `#${name}`); renderApps();
}
function selectTool(id) {
  const content = {
    files: '<span class="eyebrow">本机 / goodbuddy · 示例</span><div class="file-row">src /</div><div class="file-row">docs /</div><div class="file-row">resources /</div><div class="file-row">README.md</div>',
    terminal: '<span class="eyebrow">当前项目 · 演示终端</span><pre>PS &gt; git status\nOn branch main\nworking tree clean\n\nPS &gt;</pre>',
    browser: '<span class="eyebrow">浏览器 · 静态示例</span><div class="file-row">https://example.com</div><h2>Example Domain</h2>',
    resources: '<span class="eyebrow">本机 · 静态演示数据</span><div class="metric">CPU <strong>18%</strong><progress value="18" max="100"></progress></div><div class="metric">内存 <strong>9.6 / 32 GB</strong><progress value="30" max="100"></progress></div><p>磁盘 IO：读 12 MB/s · 写 3 MB/s</p>'
  };
  $('#tool-content').innerHTML = content[id]; $('#tool-content').setAttribute('aria-labelledby', `tab-${id}`);
  document.querySelectorAll('[data-tool]').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.tool === id)); button.tabIndex = button.dataset.tool === id ? 0 : -1; });
}
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  const data = button.dataset;
  if (data.project || data.conversation) {
    currentProject = data.project || data.conversation;
    if (projectMenu.matches(':popover-open')) projectMenu.hidePopover();
    if ($('#project-activity').matches(':popover-open')) $('#project-activity').hidePopover();
    renderProjects();
    const project = demoProjects.find(entry => entry.id === currentProject);
    openPage(data.conversation ? project.conversations[Number(data.conversationIndex)] : '当前对话');
    $('#page-label').textContent = `${project.name} / ${data.conversation ? project.conversations[Number(data.conversationIndex)] : '当前对话'}`;
    $('#project-trigger').focus();
  }
  if (data.variant) selectVariant(data.variant);
  if (data.catalog) openCatalog(data.catalog);
  if (data.page) openPage(data.page);
  if (data.open) openPage(items.find(item => item.id === data.open).name);
  if (data.tool) selectTool(data.tool);
  if (button.hasAttribute('data-note-settings')) showNoteSettings();
  if (data.noteToggle || data.noteMode || data.noteFormat) {
    if (data.noteToggle === 'resident') residentApps = residentApps.includes('notes') ? residentApps.filter(id => id !== 'notes') : [...residentApps, 'notes'];
    if (data.noteToggle === 'showCount') noteSettings.showCount = !noteSettings.showCount;
    if (data.noteMode) noteSettings.mode = data.noteMode;
    if (data.noteFormat) noteSettings.format = data.noteFormat;
    renderApps(); renderNoteSettings();
    const selector = data.noteToggle ? `[data-note-toggle="${data.noteToggle}"]` : data.noteMode ? `[data-note-mode="${data.noteMode}"]` : `[data-note-format="${data.noteFormat}"]`;
    $(selector).focus();
  }
  if (button.id === 'open-center') openCatalog(variant === 'scenes' ? 'store' : 'apps');
  if (button.id === 'edit-apps') { editingApps = !editingApps; renderApps(); $('#edit-apps').focus(); }
  if (data.pin || data.install || data.installPin) {
    const id = data.pin || data.install || data.installPin;
    if (data.install || data.installPin) installed.add(id);
    if (data.pin || data.installPin) residentApps = residentApps.includes(id) ? residentApps.filter(entry => entry !== id) : [...residentApps, id];
    renderApps();
    if ($('#catalog').open) { renderCatalog(); ($(`#catalog [data-pin="${id}"]`) || $('#search')).focus(); }
    else $('#edit-apps').focus();
  }
  if (data.move) {
    const from = residentApps.indexOf(data.move); const to = from + Number(data.direction);
    if (to >= 0 && to < residentApps.length) [residentApps[from], residentApps[to]] = [residentApps[to], residentApps[from]];
    renderApps(); $(`#resident-list [data-pin="${data.move}"]`).focus();
  }
});
$('#resident-list').addEventListener('dragstart', event => { draggedApp = event.target.closest('[data-resident]')?.dataset.resident || ''; if (!editingApps || !draggedApp) { event.preventDefault(); return; } event.dataTransfer.setData('text/plain', draggedApp); });
$('#resident-list').addEventListener('dragover', event => { if (editingApps && draggedApp) event.preventDefault(); });
$('#resident-list').addEventListener('drop', event => {
  event.preventDefault(); const target = event.target.closest('[data-resident]')?.dataset.resident;
  if (!editingApps || !residentApps.includes(draggedApp) || !target || target === draggedApp) return;
  const to = residentApps.indexOf(target); residentApps.splice(residentApps.indexOf(draggedApp), 1); residentApps.splice(to, 0, draggedApp); draggedApp = ''; renderApps(); $('#edit-apps').focus();
});
$('#resident-list').addEventListener('dragend', () => { draggedApp = ''; });
$('#search').addEventListener('input', renderCatalog);
$('#close-catalog').onclick = () => $('#catalog').close();
$('#back-to-apps').onclick = () => { const query = $('#search').value; openCatalog(catalogMode); $('#search').value = query; renderCatalog(); ($('#catalog [data-note-settings]') || $('#search')).focus(); };
function toggleWorkbar(visible) { $('.workbar').hidden = !visible; $('#toggle-workbar').setAttribute('aria-expanded', String(visible)); }
$('#toggle-workbar').onclick = () => toggleWorkbar($('.workbar').hidden);
$('#close-tool').onclick = () => { toggleWorkbar(false); $('#toggle-workbar').focus(); };
$('.tool-tabs').addEventListener('keydown', event => {
  const tabs = [...document.querySelectorAll('[data-tool]')]; const index = tabs.indexOf(event.target);
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  selectTool(tabs[next].dataset.tool); tabs[next].focus();
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCatalog(); }
  if (!$('#catalog').open || settingsOpen || variant !== 'launcher') return;
  const actions = [...document.querySelectorAll('#catalog [data-open]')]; if (!actions.length) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const index = actions.indexOf(document.activeElement); const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : actions.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + actions.length) % actions.length; actions[next].focus(); }
  if (event.key === 'Enter' && document.activeElement === $('#search')) { event.preventDefault(); actions[0].click(); }
});
$('#theme').onclick = () => { const dark = document.documentElement.dataset.theme !== 'dark'; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; $('#theme').textContent = dark ? '切换浅色' : '切换深色'; };
$('#reset').onclick = () => { installed = new Set(items.filter(item => item.builtin).map(item => item.id)); residentApps = ['notes', 'knowledge']; editingApps = false; renderApps(); notify('应用安装与常驻配置已恢复默认'); };
let demoRunning = false;
let demoRecording = false;
let demoAttachments = [];
let demoQueue = [];
let demoReplyTimer;
function renderComposer() {
  const tags = $('#composer-tags'); tags.replaceChildren();
  const addTag = (text, clear) => {
    const button = document.createElement('button'); button.textContent = `${text} ×`; button.setAttribute('aria-label', `移除${text}`);
    button.onclick = () => { clear(); renderComposer(); $('#message').focus(); }; tags.append(button);
  };
  demoAttachments.forEach((name, index) => addTag(name, () => demoAttachments.splice(index, 1)));
  for (const id of ['composer-expert', 'composer-agent', 'composer-command']) {
    const select = $(`#${id}`);
    if (select.value) addTag(select.selectedOptions[0].textContent, () => { select.value = ''; });
  }
  document.querySelectorAll('[data-knowledge]:checked').forEach(input => addTag(input.dataset.knowledge, () => { input.checked = false; }));
  if ($('#composer-retrieval').value === 'always') addTag('每次检索', () => { $('#composer-retrieval').value = 'auto'; });
  tags.hidden = !tags.childElementCount;
  $('#stop').hidden = !demoRunning;
  $('#send').disabled = !$('#message').value.trim() && $('#composer-command').value !== 'command';
  $('#send').title = demoRunning ? '加入队列' : '发送';
  $('#send').setAttribute('aria-label', demoRunning ? '加入演示队列' : '发送演示消息');
  $('#composer-status').textContent = demoRecording ? '模拟录音中 · 再次点击结束' : demoRunning ? '模拟回复中 · 可继续发送加入队列' : '交互演示 · 不调用 AI';
  for (const id of ['composer-runtime', 'composer-mode', 'composer-expert', 'composer-agent', 'composer-command']) $(`#${id}`).disabled = demoRunning;
  $('#compact').disabled = demoRunning;
  $('#runtime-options').hidden = $('#composer-runtime').value === '直连模型';
  $('#compact').hidden = $('#composer-runtime').value === '直连模型';
  $('#demo-queue').replaceChildren();
  demoQueue.forEach((text, index) => {
    const row = document.createElement('div'); row.className = 'queue-row';
    const label = document.createElement('span'); label.textContent = text; label.title = text;
    const insert = document.createElement('button'); insert.textContent = '立即插入'; insert.setAttribute('aria-label', `立即中断并插入：${text}`);
    insert.onclick = () => { demoQueue.splice(index, 1); startDemoReply(text); };
    const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', `删除待发送消息：${text}`);
    remove.onclick = () => { demoQueue.splice(index, 1); renderComposer(); };
    row.append(label, insert, remove); $('#demo-queue').append(row);
  });
  $('#demo-queue').hidden = !demoQueue.length;
}
function startDemoReply(text) {
  clearTimeout(demoReplyTimer); demoRunning = true;
  if ($('#composer-options').matches(':popover-open')) $('#composer-options').hidePopover();
  notify(`模拟处理：${text}`); renderComposer();
  demoReplyTimer = setTimeout(() => {
    demoRunning = false;
    if (demoQueue.length) startDemoReply(demoQueue.shift());
    else { renderComposer(); notify('演示回复已完成，未调用 AI'); }
  }, 8000);
}
$('#send').onclick = () => {
  if ($('#send').disabled) return;
  const text = $('#composer-command').value === 'command' ? `/init ${$('#message').value.trim()}` : $('#message').value.trim();
  $('#message').value = ''; $('#message').style.height = ''; demoAttachments = [];
  if (demoRunning) { demoQueue.push(text); renderComposer(); }
  else startDemoReply(text);
};
$('#stop').onclick = () => {
  clearTimeout(demoReplyTimer); demoRunning = false;
  if (demoQueue.length) startDemoReply(demoQueue.shift());
  else { renderComposer(); notify('已停止演示回复'); }
};
$('#message').addEventListener('input', () => { $('#message').style.height = 'auto'; $('#message').style.height = `${Math.min(180, $('#message').scrollHeight)}px`; renderComposer(); });
$('#message').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#send').click(); } });
$('#attach').onclick = () => $('#attachment-input').click();
$('#attachment-input').onchange = () => { demoAttachments.push(...Array.from($('#attachment-input').files, file => file.name)); $('#attachment-input').value = ''; renderComposer(); };
$('#voice').onclick = () => {
  demoRecording = !demoRecording; $('#voice').setAttribute('aria-pressed', String(demoRecording));
  if (!demoRecording) { $('#message').value += '请帮我整理一下今天的工作计划。'; $('#message').dispatchEvent(new Event('input')); }
  renderComposer();
};
$('#composer-options').addEventListener('change', event => {
  if (event.target.id === 'composer-command' && event.target.value === 'prompt') {
    $('#message').value = '请总结当前讨论，列出关键结论和下一步行动。'; event.target.value = ''; $('#message').dispatchEvent(new Event('input'));
  }
  renderComposer();
});
$('#composer-runtime').onchange = () => {
  $('#composer-agent').value = ''; $('#composer-command').value = '';
  $('#agent-label').textContent = $('#composer-runtime').value === 'Continue' ? '预设' : 'Agent';
  $('#composer-command').querySelector('[value="command"]').hidden = $('#composer-runtime').value !== 'OpenCode';
  renderComposer();
};
$('#compact').onclick = () => {
  $('#context-value').textContent = '18%'; $('#context-progress').value = 18;
  $('#context-description').textContent = '压缩后对话估算：36k / 200k tokens';
  $('#context-details').hidePopover(); notify('已模拟压缩上下文');
};
for (const [panelId, triggerId] of [['composer-options', 'composer-options-trigger'], ['context-details', 'context-trigger']]) {
  const panel = $(`#${panelId}`); const trigger = $(`#${triggerId}`);
  const position = () => {
    const rect = trigger.getBoundingClientRect();
    panel.style.left = `${Math.max(16, Math.min(rect.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 16))}px`;
    panel.style.top = `${Math.max(16, rect.top - panel.offsetHeight - 8)}px`;
  };
  panel.addEventListener('toggle', event => { trigger.setAttribute('aria-expanded', String(event.newState === 'open')); if (event.newState === 'open') position(); });
  window.addEventListener('resize', () => { if (panel.matches(':popover-open')) position(); });
  window.addEventListener('scroll', () => { if (panel.matches(':popover-open')) position(); }, true);
}
renderComposer();
document.querySelectorAll('[data-icon]').forEach(element => { element.innerHTML = icon(element.dataset.icon); });
window.addEventListener('hashchange', () => { if (Object.hasOwn(variants, location.hash.slice(1))) selectVariant(location.hash.slice(1)); });
selectVariant(Object.hasOwn(variants, location.hash.slice(1)) ? location.hash.slice(1) : 'dock'); selectTool('files');
if (matchMedia('(max-width: 1080px)').matches) toggleWorkbar(false);
