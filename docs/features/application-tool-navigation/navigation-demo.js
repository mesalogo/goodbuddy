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
  { id: 'models', name: '本机推理监控', icon: 'layers', detail: '语音、OCR、向量任务统一管理 · 计划预览', summary: '查看本机推理任务、使用方和资源占用', builtin: true },
  { id: 'projects', name: '项目管理', icon: 'layers', detail: '跟踪项目、任务与进度', summary: '把一个想法变成可跟进的项目', builtin: false },
  { id: 'reading', name: '阅读空间', icon: 'book', detail: '集中阅读、批注与摘录', summary: '给长文和深度阅读留一个空间', builtin: false }
];
const variants = {
  dock: ['A / 紧凑入口', '最底部保留一个应用中心入口，向上展开紧凑列表。', '适合希望把侧栏空间留给对话的用户。'],
  grid: ['B / 应用宫格', '底部入口展示应用数量，展开后用宫格浏览已安装应用。', '图标与名称同时可见，常驻位置由用户选择。'],
  cards: ['C / 应用预览', '入口展示内置应用图标，展开后用卡片说明每个应用的用途。', '适合通过内容理解应用，卡片不代表后台持续运行。'],
  launcher: ['D / 搜索启动台', '最底部就是搜索入口，也可以按 Ctrl / ⌘ K 打开。', '输入名称，用方向键与 Enter 打开已安装应用。'],
  favorites: ['E / 常驻管理', '从底部管理哪些应用常驻菜单，未常驻应用也可直接打开。', '常驻应用优先排列；入口显隐不影响安装和运行状态。'],
  scenes: ['F / 私有市场预览', '未来实验：私有市场 URL、模拟目录获取与 YAML 交换。', '不联网、不写入文件；mock schema 不代表正式协议。']
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
let residentApps = items.filter(item => item.builtin && item.id !== 'models').map(item => item.id);
let enabledApps = new Set(items.filter(item => item.builtin).map(item => item.id));
let currentPage = '当前对话';
let settingsApp = 'notes';
let marketReady = false;
let importDraft = null;
const definitions = new Map();
const modelServices = [
  { id: 'ocr', name: 'OCR 文字识别', purpose: '文档入库 #12 · 正在识别第 8 / 24 页', engine: 'PaddleOCR worker', management: '受管进程', running: true, usage: '420 MB', users: '知识库 / 文档入库任务 #12' },
  { id: 'speech', name: '语音识别', purpose: '语音输入 #18 · 正在转写', engine: '本机语音识别引擎', management: '受管进程', running: true, usage: '310 MB', users: '当前会话 / 语音输入 #18' },
  { id: 'tts', name: '语音合成', purpose: '回复朗读 #19 · 正在合成', engine: '本机语音合成引擎', management: '进程内', running: true, usage: '180 MB', users: '当前会话 / 回复朗读 #19' },
  { id: 'embedding', name: '向量生成', purpose: '文档向量化 #7 · 已处理 32 / 80 个片段', engine: 'BGE-small / ONNX Runtime', management: '进程内', running: true, usage: '128 MB', users: '知识库 / 文档向量化任务 #7' }
];
let modelConfirmation = null;
let editingApps = false;
let draggedApp = '';
let installed = new Set(items.filter(item => item.builtin).map(item => item.id));
let toastTimer;
let settingsOpen = false;
const noteSettings = { showCount: true, mode: 'immediate', format: 'combined' };
const noteModes = { immediate: '即时', 'after-save-auto': '保存后自动', 'after-save-manual': '保存后手动' };
const noteFormats = { combined: '长评 + 要点', narrative: '长评', structured: '要点' };
function renderAppSettings() {
  const item = items.find(entry => entry.id === settingsApp);
  $('#app-settings').innerHTML = `<div class="note-setting-row"><div><strong>启用应用</strong><p>关闭后隐藏业务入口，保留常驻偏好、数据和后台状态。可在此重新开启。</p></div><button class="demo-switch" role="switch" aria-label="启用${item.name}" aria-checked="${enabledApps.has(item.id)}" data-app-toggle="enabled"></button></div>
    <div class="note-setting-row"><div><strong>常驻左侧菜单</strong><p>仅控制主导航捷径；应用关闭时记住此偏好。</p></div><button class="demo-switch" role="switch" aria-label="常驻左侧菜单" aria-checked="${residentApps.includes(item.id)}" data-app-toggle="pinned"></button></div>`;
  if (settingsApp === 'notes') $('#app-settings').innerHTML += `
    <div class="note-setting-row"><div><strong>显示未完成待办数量</strong><p>在左侧入口显示数量，超过 99 项显示 99+。本 Demo 使用 3 项示例。</p></div><button class="demo-switch" role="switch" aria-label="显示未完成待办数量" aria-checked="${noteSettings.showCount}" data-note-toggle="showCount"></button></div>
    <fieldset class="note-setting-options"><legend>AI 评论方式</legend><div class="note-segments" role="group" aria-label="AI 评论方式">${Object.entries(noteModes).map(([value, label]) => `<button data-note-mode="${value}" aria-pressed="${noteSettings.mode === value}">${label}</button>`).join('')}</div><p>即时：按回车并停止输入 5 秒后评论未保存草稿。保存后自动：保存后评论。保存后手动：点击 AI 分析后评论。</p></fieldset>
    <fieldset class="note-setting-options"><legend>AI 评论形式</legend><div class="note-segments" role="group" aria-label="AI 评论形式">${Object.entries(noteFormats).map(([value, label]) => `<button data-note-format="${value}" aria-pressed="${noteSettings.format === value}">${label}</button>`).join('')}</div><p>默认同时生成流式长评和结构化要点，也可只保留其中一种。</p></fieldset>
    <div class="note-settings-preview"><span class="eyebrow">当前配置预览</span><p>${noteModes[noteSettings.mode]} · ${noteFormats[noteSettings.format]}</p><small>选择后即时保留于本次 Demo 会话，不调用 AI、不修改真实设置。</small></div>`;
  if ($('#note-settings-summary')) $('#note-settings-summary').textContent = `当前设置：${noteModes[noteSettings.mode]} · ${noteFormats[noteSettings.format]}。待办数量${noteSettings.showCount ? '显示' : '隐藏'}。`;
}
function showAppSettings(id = 'notes') {
  settingsApp = id;
  const item = items.find(entry => entry.id === id);
  if (!$('#catalog').open) { catalogMode = 'apps'; $('#search').value = ''; }
  settingsOpen = true;
  $('#catalog').dataset.variant = variant;
  $('#catalog-title').textContent = `${item.name}设置`;
  $('#catalog-description').textContent = '应用中心、应用页面和全局设置共用本次演示配置。';
  $('#back-to-apps').hidden = false; $('#app-settings').hidden = false;
  for (const selector of ['.center-switch', '#search', '#catalog-items', '#market-preview']) $(selector).hidden = true;
  renderAppSettings();
  if (!$('#catalog').open) $('#catalog').showModal();
  $('#back-to-apps').focus();
}
function notify(text) {
  $('#toast').textContent = text; $('#toast').classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2200);
}
function renderApps() {
  $('#edit-apps').textContent = editingApps ? '完成' : '编辑';
  $('#resident-list').innerHTML = residentApps.filter(id => enabledApps.has(id) && (variant === 'scenes' || items.find(item => item.id === id).builtin)).map(id => {
    const index = residentApps.indexOf(id);
    const item = items.find(entry => entry.id === id);
    return `<div class="resident-row" data-resident="${id}" draggable="${editingApps}"><button data-open="${id}" ${$('#page-label').textContent === item.name ? 'aria-current="page"' : ''}>${icon(item.icon)}<span>${item.name}</span>${id === 'notes' && noteSettings.showCount ? '<small class="note-count" aria-label="3 项未完成待办（示例）">3</small>' : ''}</button>${editingApps ? `<div class="edit-actions"><button data-move="${id}" data-direction="-1" aria-label="上移${item.name}" ${index === 0 ? 'disabled' : ''}>↑</button><button data-pin="${id}" aria-label="移除${item.name}">×</button><button data-move="${id}" data-direction="1" aria-label="下移${item.name}" ${index === residentApps.length - 1 ? 'disabled' : ''}>↓</button></div>` : ''}</div>`;
  }).join('') || '<p class="empty-apps">点击 ＋，选择常驻应用。</p>';
  const subtitles = { dock: '', grid: '内置应用', cards: '笔记 · 知识 · 自动化 · 模型', launcher: 'Ctrl / ⌘ K', favorites: '管理常驻偏好', scenes: '未来私有市场 · 模拟' };
  $('#center-entry').innerHTML = `<button id="open-center" aria-haspopup="dialog"><span class="brand-mark">${variant === 'launcher' ? icon('search') : 'GB'}</span><span><strong>${variant === 'launcher' ? '搜索应用…' : '应用中心'}</strong>${subtitles[variant] ? `<small>${subtitles[variant]}</small>` : ''}</span><span class="entry-arrow">${variant === 'scenes' ? '↗' : '⌃'}</span></button>`;
}
function renderCatalog() {
  const query = $('#search').value.trim().toLowerCase();
  const matches = items.filter(item => (catalogMode === 'store' ? marketReady && !item.builtin : installed.has(item.id) && (variant === 'scenes' || item.builtin)) && `${item.name}${item.detail}`.toLowerCase().includes(query));
  if (variant === 'favorites') matches.sort((a, b) => Number(residentApps.includes(b.id)) - Number(residentApps.includes(a.id)));
  $('#catalog-items').innerHTML = matches.map(item => {
    const ready = installed.has(item.id); const pinned = residentApps.includes(item.id);
    return `<article class="center-app">${icon(item.icon)}<div class="center-app-info"><strong>${item.name}</strong><p>${item.builtin ? '内置应用' : '私有市场 · 示例'}${item.id === 'models' ? ' · 计划预览' : ''}${ready ? enabledApps.has(item.id) ? ' · 已启用' : ' · 已关闭' : ''}</p><p class="app-detail">${variant === 'cards' ? item.summary : item.detail}</p></div><div class="center-actions">${ready ? `${enabledApps.has(item.id) ? `<button data-open="${item.id}">打开</button>` : ''}<button data-app-settings="${item.id}">${enabledApps.has(item.id) ? '设置' : '设置 / 重新开启'}</button><button data-pin="${item.id}" aria-pressed="${pinned}">${pinned ? '取消常驻' : '常驻左侧'}</button>` : `<button data-install="${item.id}">模拟安装</button><button data-install-pin="${item.id}">模拟安装并常驻</button>`}</div></article>`;
  }).join('') || `<p class="empty-apps">${catalogMode === 'store' && !marketReady ? '请先模拟获取私有市场目录。' : '没有匹配的应用，请换个关键词。'}</p>`;
  $('#yaml-app').innerHTML = items.filter(item => installed.has(item.id)).map(item => `<option value="${item.id}">${item.name}</option>`).join('');
  document.querySelectorAll('.center-switch button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.catalog === catalogMode)));
}
function openCatalog(mode = 'apps') {
  importDraft = null; $('#import-preview').hidden = true;
  if (variant !== 'scenes') mode = 'apps';
  settingsOpen = false; $('#back-to-apps').hidden = true; $('#app-settings').hidden = true;
  for (const selector of ['.center-switch', '#search', '#catalog-items']) $(selector).hidden = false;
  $('.center-switch').hidden = variant !== 'scenes';
  $('#market-preview').hidden = mode !== 'store';
  catalogMode = mode; $('#catalog').dataset.variant = variant;
  $('#catalog-title').textContent = mode === 'store' ? '私有市场 · 未来预览' : '应用中心';
  $('#catalog-description').textContent = mode === 'store' ? '目录和安装均为模拟，未接入 ShareServer。导入不会启动模型或任务。' : '内置应用无需安装；启用与常驻分别设置。系统工具请使用右侧工作栏。';
  $('#search').value = ''; renderCatalog();
  if (!$('#catalog').open) $('#catalog').showModal();
  $('#search').focus();
}
function openPage(name, keepSettings = false) {
  currentPage = name;
  modelConfirmation = null;
  if ($('#catalog').open && !keepSettings) $('#catalog').close();
  $('#page-label').textContent = name;
  $('#page-content').replaceChildren();
  const title = document.createElement('h1'); title.textContent = name;
  const description = document.createElement('p'); description.className = 'muted'; description.textContent = '主内容区页面预览。右侧工作栏保持当前工具状态。';
  $('#page-content').append(title, description);
  const app = items.find(item => item.name === name);
  $('.composer-area').hidden = Boolean(app) || name === '设置' || name === '运行记录';
  $('#page-content').classList.toggle('app-page', $('.composer-area').hidden);
  for (const panel of ['#composer-options', '#context-details']) if ($(panel).matches(':popover-open')) $(panel).hidePopover();
  $('#page-actions').replaceChildren();
  if (app && !enabledApps.has(app.id)) {
    description.textContent = '此应用已关闭，当前页面不可用。已有数据和选择保留；此操作不停止后台任务或模型服务。';
    renderApps(); return;
  }
  if (app?.id === 'models') renderModels();
  if (name === '魔法笔记' || name === '设置') {
    const summary = document.createElement('p'); summary.id = 'note-settings-summary'; summary.className = 'muted'; $('#page-content').append(summary);
    renderAppSettings();
  }
  document.querySelectorAll('.navigation button').forEach(button => button.classList.toggle('selected', button.dataset.page === name));
  renderApps(); if (!keepSettings) notify(`已打开${name}`);
}
function selectVariant(name) {
  variant = name; $('.app').dataset.variant = name;
  document.querySelectorAll('button[data-variant]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.variant === name)));
  [$('#variant-label').textContent, $('#variant-description').textContent, $('#design-tradeoff').textContent] = variants[name];
  history.replaceState(null, '', `#${name}`); renderApps();
  if ($('#catalog').open) openCatalog();
  const pageApp = items.find(item => item.name === currentPage);
  if (name !== 'scenes' && pageApp && !pageApp.builtin) openPage('当前对话');
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
function renderModels() {
  $('#page-content').innerHTML = `<h1>本机推理监控</h1><p class="muted">统一查看语音、OCR、向量等本机推理任务与执行服务。任务进度、引擎及占用均为模拟数据。</p><h2>推理任务与服务</h2><p class="muted">下方操作作用于执行服务；启动或加载服务不会自动恢复已中断的任务。</p><div class="model-list">${modelServices.map(service => {
    const external = service.management === '外部管理';
    const active = service.management === '进程内' ? '已加载' : '运行中';
    const actions = external ? ['config'] : service.management === '进程内' ? [service.running ? 'release' : 'load'] : service.running ? ['stop', 'restart'] : ['start'];
    return `<article class="model-service"><strong>${service.name}</strong><p>${service.interrupted ? '任务已中断，需由原应用重新发起' : service.purpose}</p><p>执行服务：${service.running ? active : '未运行'} · 内存：${service.running ? service.usage : '已释放（模拟）'}</p><p>使用方：${service.interrupted ? '暂无活动使用方' : service.users}</p><div class="model-actions">${actions.map(action => `<button data-model="${service.id}" data-model-action="${action}">${modelActionLabels[action]}</button>`).join('')}</div>${modelConfirmation?.id === service.id ? `<div class="inline-confirm" role="group" aria-label="推理服务操作确认"><p>${modelActionLabels[modelConfirmation.action]} ${service.name} 将影响 ${service.interrupted ? '该执行服务，当前没有活动任务' : service.users}。仅模拟状态变化。</p><button data-model-cancel>取消</button><button data-model-confirm>确认${modelActionLabels[modelConfirmation.action]}</button></div>` : ''}<details><summary>引擎与错误详情</summary><p>${service.engine} · ${service.management}</p><p>最近错误：无（示例）。操作仅更新本页内存状态。</p></details></article>`;
  }).join('')}</div>`;
}
const modelActionLabels = { start: '启动', stop: '停止', restart: '重启', load: '加载', release: '释放', config: '连接配置' };
function applyModelAction(id, action) {
  const service = modelServices.find(entry => entry.id === id);
  service.running = !['stop', 'release'].includes(action);
  if (['stop', 'release', 'restart'].includes(action)) service.interrupted = true;
  modelConfirmation = null;
  renderModels();
  $(`[data-model="${id}"]`)?.focus();
  notify(`已模拟${modelActionLabels[action]} ${service.name}`);
}
function previewImport() {
  importDraft = null;
  const preview = $('#import-preview'); preview.hidden = false; preview.replaceChildren();
  const values = {};
  const fields = ['schema', 'id', 'name', 'version', 'entry', 'dependencies', 'resources'];
  for (const line of $('#yaml-input').value.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))) {
    const match = line.match(/^([a-z]+):\s*(.+)$/);
    if (!match || !fields.includes(match[1]) || Object.hasOwn(values, match[1])) { preview.textContent = '仅支持示例中的七个扁平字段，不接受重复或未知字段；请修正后重新预览。'; return; }
    values[match[1]] = match[2].trim();
  }
  if (fields.some(field => !values[field]) || values.schema !== 'mock-v1' || !/^[a-z][a-z0-9-]*$/.test(values.id) || values.entry !== 'main') { preview.textContent = '请填写完整 mock-v1 示例，id 使用小写字母、数字或连字符，entry 为 main。'; return; }
  const existing = items.find(item => item.id === values.id);
  const dependencies = values.dependencies === 'none' ? [] : values.dependencies.split(',').map(value => value.trim());
  const missing = dependencies.filter(value => !value.startsWith('builtin:') || !installed.has(value.slice(8)) || !enabledApps.has(value.slice(8)));
  const blocked = existing?.builtin || missing.length || values.resources !== 'bundled';
  const conflict = installed.has(values.id);
  const text = document.createElement('p');
  text.textContent = `${values.name} · ${values.id} · v${values.version} · 主内容区入口。依赖：${values.dependencies}。${missing.length ? `缺失或关闭：${missing.join('、')}。` : '依赖已具备（模拟）。'}资源：${values.resources}。${values.resources !== 'bundled' ? '需补充外部资源，不能安装为可用。' : ''}${existing?.builtin ? '与内置应用冲突，不允许覆盖。' : conflict ? '同标识冲突：需显式更新定义，保留启用与常驻偏好。' : '没有同标识冲突。'}`;
  preview.append(text);
  const cancel = document.createElement('button'); cancel.textContent = '取消'; cancel.onclick = () => { importDraft = null; preview.hidden = true; $('#yaml-preview').focus(); }; preview.append(cancel);
  if (!blocked) {
    importDraft = values;
    const confirm = document.createElement('button'); confirm.id = 'import-confirm'; confirm.textContent = conflict ? '确认模拟更新定义' : '确认模拟安装';
    confirm.onclick = () => {
      if (!importDraft) return;
      const draft = importDraft;
      const item = items.find(entry => entry.id === draft.id);
      if (!item) items.push({ id: draft.id, name: draft.id, icon: 'layers', detail: 'YAML 导入 · 未来示例', summary: '导入的应用定义预览', builtin: false });
      // Imported text stays in textContent/textarea; catalog markup uses the validated identifier.
      definitions.set(draft.id, { ...draft });
      if (!installed.has(draft.id)) { installed.add(draft.id); enabledApps.add(draft.id); }
      importDraft = null; preview.hidden = true; renderCatalog(); renderApps(); $('#yaml-preview').focus(); notify('已模拟安装 / 更新定义，未启动模型或任务');
    };
    preview.append(confirm);
  }
}
$('#market-fetch').onclick = () => {
  const valid = /^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test($('#market-url').value.trim());
  marketReady = valid;
  $('#market-status').textContent = valid ? `已模拟获取目录：${$('#market-url').value.trim()}，无网络请求。` : '请输入 http(s) 市场 URL 后重试。';
  renderCatalog();
};
$('#market-fail').onclick = () => { marketReady = false; $('#market-status').textContent = '模拟来源不可达，请点击模拟获取目录重试。未切换公共市场，已安装应用仍可使用。'; renderCatalog(); };
$('#market-url').oninput = () => { marketReady = false; $('#market-status').textContent = '来源已修改，请重新模拟获取目录。'; renderCatalog(); };
$('#yaml-preview').onclick = previewImport;
$('#yaml-input').oninput = () => { importDraft = null; $('#import-preview').hidden = true; };
$('#yaml-export').onclick = () => {
  const item = items.find(entry => entry.id === $('#yaml-app').value);
  const definition = definitions.get(item.id) || { schema: 'mock-v1', id: item.id, name: item.name, version: '1.0', entry: 'main', dependencies: 'none', resources: 'bundled' };
  $('#yaml-output').hidden = false;
  $('#yaml-output').textContent = '# Mock schema only; no credentials or business data\n' + Object.entries(definition).map(([key, value]) => `${key}: ${value}`).join('\n');
};
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
  if (data.appSettings) showAppSettings(data.appSettings);
  if (data.appToggle) {
    const id = settingsApp;
    if (data.appToggle === 'enabled') enabledApps.has(id) ? enabledApps.delete(id) : enabledApps.add(id);
    else residentApps = residentApps.includes(id) ? residentApps.filter(entry => entry !== id) : [...residentApps, id];
    renderApps(); renderComposer();
    if (currentPage === items.find(item => item.id === id).name) {
      openPage(currentPage, true);
    }
    renderAppSettings(); $(`[data-app-toggle="${data.appToggle}"]`).focus();
  }
  if (data.modelAction) {
    if (data.modelAction === 'config') {
      const row = button.closest('.model-service');
      let config = row.querySelector('.model-config');
      if (!config) { config = document.createElement('p'); config.className = 'model-config'; config.textContent = '连接配置预览：Ollama · http://localhost:11434 · 外部管理。仅展示示例，不连接或保存配置。'; row.append(config); }
    } else {
      const service = modelServices.find(entry => entry.id === data.model);
      if (service.running && service.users) { modelConfirmation = { id: data.model, action: data.modelAction }; renderModels(); $('[data-model-cancel]').focus(); }
      else applyModelAction(data.model, data.modelAction);
    }
  }
  if (button.hasAttribute('data-model-cancel')) { const id = modelConfirmation.id; modelConfirmation = null; renderModels(); $(`[data-model="${id}"]`).focus(); }
  if (button.hasAttribute('data-model-confirm') && modelConfirmation) applyModelAction(modelConfirmation.id, modelConfirmation.action);
  if (data.noteToggle || data.noteMode || data.noteFormat) {
    if (data.noteToggle === 'showCount') noteSettings.showCount = !noteSettings.showCount;
    if (data.noteMode) noteSettings.mode = data.noteMode;
    if (data.noteFormat) noteSettings.format = data.noteFormat;
    renderApps(); renderAppSettings();
    const selector = data.noteToggle ? `[data-note-toggle="${data.noteToggle}"]` : data.noteMode ? `[data-note-mode="${data.noteMode}"]` : `[data-note-format="${data.noteFormat}"]`;
    $(selector).focus();
  }
  if (button.id === 'open-center') openCatalog(variant === 'scenes' ? 'store' : 'apps');
  if (button.id === 'edit-apps') { editingApps = !editingApps; renderApps(); $('#edit-apps').focus(); }
  if (data.pin || data.install || data.installPin) {
    const id = data.pin || data.install || data.installPin;
    if (data.install || data.installPin) { importDraft = null; $('#import-preview').hidden = true; installed.add(id); enabledApps.add(id); notify('已模拟安装，未启动任务或模型'); }
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
$('#back-to-apps').onclick = () => { const query = $('#search').value; openCatalog(catalogMode); $('#search').value = query; renderCatalog(); ($(`#catalog [data-app-settings="${settingsApp}"]`) || $('#search')).focus(); };
$('#app-settings').addEventListener('keydown', event => {
  const group = event.target.closest('.note-segments');
  if (!group || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const buttons = [...group.querySelectorAll('button')];
  const index = buttons.indexOf(event.target);
  buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length].click();
});
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
$('#reset').onclick = () => { installed = new Set(items.filter(item => item.builtin).map(item => item.id)); residentApps = [...installed].filter(id => id !== 'models'); enabledApps = new Set(installed); Object.assign(noteSettings, { showCount: true, mode: 'immediate', format: 'combined' }); editingApps = false; definitions.clear(); importDraft = null; $('#import-preview').hidden = true; renderApps(); renderComposer(); openPage('当前对话'); notify('应用启用、常驻和笔记设置已恢复默认'); };
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
  document.querySelectorAll('[data-knowledge-control]').forEach(element => { element.hidden = !enabledApps.has('knowledge'); });
  if (enabledApps.has('knowledge')) {
    document.querySelectorAll('[data-knowledge]:checked').forEach(input => addTag(input.dataset.knowledge, () => { input.checked = false; }));
    if ($('#composer-retrieval').value === 'always') addTag('每次检索', () => { $('#composer-retrieval').value = 'auto'; });
  }
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
