const projects = [
  { id: 'buddy', name: 'GoodBuddy', kind: 'local', location: '本地工作空间' },
  { id: 'web', name: '品牌官网', kind: 'local', location: '本地工作空间' },
  { id: 'data', name: '数据分析', kind: 'remote', host: 'dev-server', location: '远程 · dev-server' },
  { id: 'api', name: '后端服务', kind: 'remote', host: 'dev-server', location: '远程 · dev-server' },
  { id: 'lab', name: '模型实验', kind: 'remote', host: 'gpu-lab', location: '远程 · gpu-lab' },
  { id: 'channel', name: '产品讨论群', kind: 'channel', location: '消息通道' }
];
const hosts = [{ name: 'dev-server', status: '就绪' }, { name: 'gpu-lab', status: '未连接' }];
for (let index = 3; index <= 20; index++) {
  projects.push({ id: `local-${index}`, name: `本地项目 ${String(index).padStart(2, '0')}`, kind: 'local', location: '本地工作空间' });
}
for (let index = 4; index <= 20; index++) {
  const host = index % 2 ? 'gpu-lab' : 'dev-server';
  projects.push({ id: `remote-${index}`, name: `远程项目 ${String(index).padStart(2, '0')}`, kind: 'remote', host, location: `远程 · ${host}` });
}
projects.push(
  { id: 'channel-2', name: '研发协作群', kind: 'channel', location: '消息通道' },
  { id: 'channel-3', name: '运维通知群', kind: 'channel', location: '消息通道' }
);
const icons = {
  all: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  local: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  remote: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6h.01M7 17h.01"/>',
  channel: '<path d="M21 11a8 8 0 0 1-8 8H6l-4 3V11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8Z"/><path d="M7 9h9M7 13h6"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
for (const project of projects) {
  project.rootPath = project.kind === 'remote' ? `/srv/projects/${project.id}` : `D:/workspace/${project.id}`;
  project.description = '';
  project.defaultMode = 'ask';
  project.runtime = 'OpenCode';
}
const initialProjects = structuredClone(projects);
const initial = [
  { id: 1, project: 'buddy', title: '工作空间交互设计', state: 'idle', detail: '设计讨论已保存，随时可以继续。', prompt: '让项目与活动会话的关系更直观，做出操作系统的感觉。', answer: '左上角就是工作入口。\n\n展开项目与活动菜单，可以查看多个项目正在进行的会话，也可以直接处理等待你的工作。选择项目只筛选列表，进入会话才切换工作现场。\n\n所有状态都在这个下拉菜单中，不需要再打开独立页面。' },
  { id: 2, project: 'buddy', title: '登录流程调整', state: 'waiting', detail: '需要你选择：使用单点登录还是邮箱登录？', prompt: '帮我完善内部用户的登录流程。', answer: '已梳理现有认证入口。需要确定首选登录方式，然后继续调整界面。', question: true },
  { id: 3, project: 'buddy', title: '导航组件测试', state: 'running', detail: '正在检查键盘导航与焦点恢复。', prompt: '检查导航组件的交互和测试覆盖。', answer: '已经完成组件检查，正在验证键盘导航与焦点恢复。' },
  { id: 4, project: 'web', title: '发布新版首页', state: 'waiting', detail: '预览构建已就绪，等待你批准部署。', prompt: '构建新版首页，发布前让我确认。', answer: '预览构建已完成，页面检查通过。请确认是否继续部署。' },
  { id: 5, project: 'web', title: '首页文案精修', state: 'done', detail: '完成 3 处文案调整，结果等待查看。', prompt: '把首页介绍改得更简洁、自然。', answer: '首页文案调整已完成。\n\n首屏标题：把想法，变成已完成的工作。\n产品介绍：查资料、写方案、改代码。在一个工作空间里，与 AI 一起推进。\n行动按钮：开始你的第一项工作。' },
  { id: 6, project: 'data', title: '本周使用情况分析', state: 'running', detail: '正在汇总各项目的使用趋势。', prompt: '整理本周各项目的使用情况。', answer: '已完成示例数据整理，正在汇总各项目的使用趋势。' },
  { id: 7, project: 'api', title: '接口变更记录', state: 'idle', detail: '昨天的会话', prompt: '整理本次接口变更。', answer: '接口变更记录已整理。' },
  { id: 8, project: 'lab', title: '推理参数对比', state: 'idle', detail: '上次会话', prompt: '对比两组推理参数。', answer: '上次对比结果已保存。' },
  { id: 9, project: 'channel', title: '版本发布讨论', state: 'idle', detail: '今天的会话', prompt: '整理群里的版本讨论。', answer: '本轮发布讨论已整理。' }
];
for (const project of projects) {
  if (!initial.some((session) => session.project === project.id)) {
    initial.push({ id: initial.length + 1, project: project.id, title: '最近工作记录', state: 'idle', detail: '上次会话', prompt: '整理当前工作。', answer: '工作记录已保存。' });
  }
}
const labels = { waiting: '待处理', running: '运行中', done: '已完成' };
const symbols = { waiting: '!', running: '◌', done: '✓' };
const statusLabel = (session) => session.state === 'waiting'
  ? session.question ? '等待你的回答' : '等待审批'
  : labels[session.state] || '';
const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let sessions, current, scope = 'all', filter = 'all', projectTab = 'local', toastTimer, menuTrigger, activityOrder, settingsProjectId;
const remembered = {};
const drafts = {};
const overview = $('overview');
const projectOf = (session) => projects.find((p) => p.id === session.project);
const badge = (state) => `<span class="${state}">${symbols[state]} ${labels[state]}</span>`;
function notify(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}
function render() {
  const session = sessions.find((s) => s.id === current);
  const project = projectOf(session);
  $('project-name').textContent = project.name;
  $('breadcrumb').textContent = `${project.name} / ${session.title}`;
  $('activity-trigger').innerHTML = '<span class="muted">全部</span>' + ['waiting', 'running', 'done'].filter((state) => sessions.some((s) => s.state === state)).map((state) => `<span class="${state}">${symbols[state]} ${sessions.filter((s) => s.state === state).length} ${labels[state]}</span>`).join('');
  $('activity-trigger').hidden = !sessions.some((s) => labels[s.state]);
  $('sessions').innerHTML = sessions.filter((s) => s.project === session.project).map((s) => `<button data-open="${s.id}" aria-current="${s.id === current}">${statusLabel(s) ? `<span class="${s.state}" aria-label="${statusLabel(s)}">${symbols[s.state]}</span>` : ''}<span>${escapeHtml(s.title)}</span></button>`).join('');
  $('conversation').innerHTML = `<span class="eyebrow">${escapeHtml(project.location)}${statusLabel(session) ? ` / ${statusLabel(session)}` : ''}</span><h1>${escapeHtml(session.title)}</h1><div class="user-message">${escapeHtml(session.prompt)}</div><div class="assistant-label">G / GoodBuddy</div><div class="answer">${escapeHtml(session.answer)}</div>${session.state === 'waiting' ? `<section class="execution"><span class="waiting">! ${statusLabel(session)}</span><p>${escapeHtml(session.detail)}</p>${session.question ? '<button class="primary" data-resolve="单点登录">使用单点登录</button> <button data-resolve="邮箱登录">使用邮箱登录</button>' : '<button class="primary" data-resolve="批准部署">批准并继续</button> <button data-resolve="暂不部署">暂不部署</button>'}</section>` : session.state === 'running' ? `<section class="execution">${badge('running')}<p>${escapeHtml(session.detail)} 切换到其他工作空间后仍会继续。</p></section>` : ''}`;
  $('simulate').disabled = !sessions.some((s) => s.state === 'running');
  renderOverview();
}
function renderOverview() {
  const focused = document.activeElement;
  const focusScope = focused?.dataset.scope;
  const focusFilter = focused?.dataset.filter;
  const projectButton = (p) => {
    const list = sessions.filter((s) => p.id === 'all' || s.project === p.id);
    const counts = ['waiting', 'running', 'done'].filter((state) => list.some((s) => s.state === state)).map((state) => `<span class="${state}">${symbols[state]} ${list.filter((s) => s.state === state).length} 个${labels[state]}</span>`).join(' ');
    const active = sessions.find((s) => s.id === current).project === p.id;
    const detail = p.kind === 'local' ? `本地目录 · ${p.rootPath}` : p.kind === 'channel' ? `消息通道 · ${p.rootPath}` : p.rootPath;
    return `<div class="project-row"><button class="desktop" data-scope="${p.id}" title="${escapeHtml(p.name)}\n${escapeHtml(detail)}">${icon(p.kind === 'channel' ? 'channel' : 'folder')}<span class="project-copy"><span class="project-heading"><strong>${escapeHtml(p.name)}</strong></span>${counts ? `<span class="project-counts">${counts}</span>` : ''}<small class="project-path">${escapeHtml(detail)}</small></span><span class="current-project" ${active ? 'aria-label="当前项目"' : 'aria-hidden="true"'}>${active ? '✓' : ''}</span></button><button class="project-settings-button" data-settings="${p.id}" aria-label="管理项目 ${escapeHtml(p.name)}" title="项目设置"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3-.7 3-2 .9-2.7-.8-2 3.4 2 2.2v2.6l-2 2.2 2 3.4 2.7-.8 2 .9L9 23h4l.7-3 2-.9 2.7.8 2-3.4-2-2.2v-2.6l2-2.2-2-3.4-2.7.8-2-.9L13 3Z" transform="translate(1 -1) scale(.95)"/><circle cx="12" cy="12" r="3"/></svg></button></div>`;
  };
  const query = $('project-search').value.trim().toLocaleLowerCase();
  const kinds = { local: '本地', remote: '远程', channel: '消息通道' };
  if (!$('project-tabs').children.length) {
    $('project-tabs').innerHTML = Object.entries(kinds).map(([kind, label]) => `<button id="tab-${kind}" role="tab" data-tab="${kind}" aria-controls="desktops">${label} <small></small></button>`).join('');
  }
  $('project-tabs').hidden = Boolean(query);
  $('project-tabs').querySelectorAll('[data-tab]').forEach((button) => {
    const selected = button.dataset.tab === projectTab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    button.querySelector('small').textContent = projects.filter((p) => p.kind === button.dataset.tab).length;
  });
  $('desktops').setAttribute('aria-label', query ? '搜索结果' : kinds[projectTab]);
  $('all-projects').setAttribute('aria-pressed', String(scope === 'all'));
  const shown = projects.filter((p) => query
    ? `${p.name} ${p.rootPath} ${p.host || ''} ${kinds[p.kind]}`.toLocaleLowerCase().includes(query)
    : p.kind === projectTab);
  const projectMarkup = query
    ? shown.map((p) => `<div class="search-result">${projectButton(p)}<small>${kinds[p.kind]}${p.host ? ` · ${escapeHtml(p.host)}` : ''}</small></div>`).join('')
    : projectTab === 'remote'
      ? hosts.map((host) => `<section class="host-group" aria-label="${host.name}"><details open><summary class="host-heading"><span>${host.name}</span><span class="host-status ${host.status === '就绪' ? 'done' : 'muted'}">${host.status}</span></summary>${shown.filter((p) => p.host === host.name).map(projectButton).join('')}</details></section>`).join('')
      : shown.map(projectButton).join('');
  // Keep hovered project nodes stable while the right-hand list changes.
  if ($('desktops').dataset.markup !== projectMarkup) {
    $('desktops').innerHTML = projectMarkup || '<div class="empty">无匹配项目</div>';
    $('desktops').dataset.markup = projectMarkup;
  }
  $('desktops').querySelectorAll('[data-scope]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.scope === scope));
  });
  const list = sessions.filter((s) => scope === 'all' || s.project === scope);
  $('filters').innerHTML = ['all', 'waiting', 'running', 'done'].map((state) => `<button data-filter="${state}" aria-pressed="${filter === state}">${state === 'all' ? '全部' : labels[state]} <small>${list.filter((s) => state === 'all' || s.state === state).length}</small></button>`).join('');
  const targetProject = projects.find((p) => p.id === (scope === 'all' ? sessions.find((s) => s.id === current).project : scope));
  $('menu-new-chat').title = `在 ${targetProject.name} 中新建会话`;
  $('menu-new-chat').setAttribute('aria-label', $('menu-new-chat').title);
  const groups = filter === 'all' ? ['waiting', 'running', 'recent'] : [filter];
  $('windows').innerHTML = groups.map((state) => {
    const sorted = list.filter((s) => state === 'recent' ? s.state === 'done' || s.state === 'idle' : s.state === state)
      .sort((a, b) => b.lastActivity - a.lastActivity);
    const group = state === 'recent' ? sorted.slice(0, 5) : sorted;
    if (!group.length) return '';
    return `<section class="window-group"><h2 class="group-title">${state === 'recent' ? '最近会话' : badge(state)} <span class="muted">${group.length}</span></h2>${group.map((s) => `<button class="session-row" data-open="${s.id}" title="${escapeHtml(s.detail)}"><span class="session-copy"><strong>${escapeHtml(s.title)}</strong>${scope === 'all' ? `<small>${escapeHtml(projectOf(s).name)}</small>` : ''}</span><span class="row-action ${s.state}">${s.state === 'done' ? '✓ 已完成' : s.state === 'waiting' ? statusLabel(s) : s.id === current ? '当前' : '↗'}</span></button>`).join('')}</section>`;
  }).join('') || '<div class="empty">暂无会话</div>';
  if (focusScope) overview.querySelector(`[data-scope="${focusScope}"]`)?.focus();
  if (focusFilter) overview.querySelector(`[data-filter="${focusFilter}"]`)?.focus();
}
function openSession(id) {
  const session = sessions.find((s) => s.id === id);
  drafts[current] = $('message').value;
  current = id;
  session.lastActivity = ++activityOrder;
  remembered[session.project] = id;
  if (session.state === 'done') { session.state = 'idle'; session.detail = '结果已查看，可以继续这项工作。'; }
  closeMenu();
  $('message').value = drafts[id] || '';
  render();
  $('conversation').scrollTop = 0;
}
function positionMenu() {
  const anchor = document.querySelector('.workspace-control').getBoundingClientRect();
  const top = Math.max(8, Math.min(anchor.bottom + 8, window.innerHeight - 240));
  overview.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - overview.offsetWidth - 8))}px`;
  overview.style.top = `${top}px`;
  overview.style.maxHeight = `${window.innerHeight - top - 8}px`;
}
function closeMenu() {
  if (overview.matches(':popover-open')) overview.hidePopover();
}
function showOverview(project = 'all', trigger = $('workspace-trigger')) {
  if (overview.matches(':popover-open')) { closeMenu(); return; }
  menuTrigger = trigger;
  scope = project;
  projectTab = projects.find((p) => p.id === (project === 'all' ? sessions.find((s) => s.id === current).project : project)).kind;
  $('project-search').value = '';
  filter = 'all';
  $('project-form').hidden = true;
  $('new-project').setAttribute('aria-expanded', 'false');
  renderOverview();
  overview.showPopover();
  positionMenu();
  overview.querySelector('[data-scope][aria-pressed="true"]').focus();
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.settings) {
    settingsProjectId = button.dataset.settings;
    const project = projects.find((p) => p.id === settingsProjectId);
    $('settings-name').value = project.name;
    $('settings-name').readOnly = project.kind === 'channel';
    $('settings-description').value = project.description || '';
    $('settings-space').value = project.location;
    $('settings-path').value = project.rootPath;
    $('settings-mode').value = project.defaultMode || 'ask';
    $('settings-runtime').value = project.runtime || 'OpenCode';
    $('settings-runtime').querySelector('option:last-child').disabled = project.kind === 'remote';
    closeMenu();
    $('project-settings').showModal();
  }
  if (button.dataset.tab) {
    projectTab = button.dataset.tab;
    renderOverview();
    $('desktops').scrollTop = 0;
  }
  if (button.dataset.open) openSession(Number(button.dataset.open));
  if (button.dataset.scope === 'all') { scope = 'all'; renderOverview(); }
  else if (button.dataset.scope) {
    const project = button.dataset.scope;
    const session = sessions.find((s) => s.id === remembered[project]) ||
      sessions.filter((s) => s.project === project).sort((a, b) => b.lastActivity - a.lastActivity)[0];
    if (session) openSession(session.id); else createSession(project);
  }
  if (button.dataset.filter) { filter = button.dataset.filter; renderOverview(); }
  if (button.dataset.resolve) {
    const session = sessions.find((s) => s.id === current);
    const declined = button.dataset.resolve === '暂不部署';
    session.state = declined ? 'idle' : 'running';
    session.lastActivity = ++activityOrder;
    session.detail = declined ? '已暂缓部署，等待后续安排。' : `已确认${button.dataset.resolve}，正在继续执行。`;
    session.answer = session.detail;
    render();
    notify(declined ? '已暂缓本次部署' : '已处理，工作继续进行');
  }
});
$('desktops').addEventListener('pointerover', (event) => {
  if (event.pointerType === 'touch') return;
  const button = event.target.closest('[data-scope]');
  if (!button || button.dataset.scope === scope) return;
  scope = button.dataset.scope;
  renderOverview();
});
$('project-search').addEventListener('input', () => { renderOverview(); $('desktops').scrollTop = 0; });
$('project-tabs').addEventListener('keydown', (event) => {
  const tabs = [...$('project-tabs').querySelectorAll('[data-tab]')];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
});
$('settings-form').onsubmit = (event) => {
  event.preventDefault();
  const project = projects.find((p) => p.id === settingsProjectId);
  const name = $('settings-name').value.trim();
  const path = $('settings-path').value.trim();
  if (!name || !path) return;
  if (project.kind !== 'channel') project.name = name;
  project.rootPath = path;
  project.description = $('settings-description').value;
  project.defaultMode = $('settings-mode').value;
  project.runtime = $('settings-runtime').value;
  render();
  $('project-settings').close();
};
$('close-settings').onclick = $('cancel-settings').onclick = () => $('project-settings').close();
$('project-settings').addEventListener('close', () => {
  showOverview(settingsProjectId);
  overview.querySelector(`[data-settings="${settingsProjectId}"]`)?.focus();
});
$('workspace-trigger').onclick = () => showOverview(sessions.find((s) => s.id === current).project);
$('activity-trigger').onclick = () => showOverview('all', $('activity-trigger'));
$('close-overview').onclick = () => { closeMenu(); menuTrigger?.focus(); };
$('simulate').onclick = () => {
  const session = sessions.find((s) => s.state === 'running' && s.id !== current) || sessions.find((s) => s.state === 'running');
  if (!session) return;
  const visible = session.id === current && !overview.matches(':popover-open') && !document.hidden;
  session.state = visible ? 'idle' : 'done';
  session.lastActivity = ++activityOrder;
  session.detail = visible ? '结果已查看，可以继续这项工作。' : '工作已完成，结果等待查看。';
  session.answer = '本轮工作已完成。\n\n示例结果：检查项已通过，相关说明已整理。你可以继续追问，或者切换到下一项工作。';
  render();
  notify(`${projectOf(session).name} / ${session.title} 已完成`);
};
overview.addEventListener('toggle', (event) => {
  const open = event.newState === 'open';
  $('workspace-trigger').setAttribute('aria-expanded', String(open));
  $('activity-trigger').setAttribute('aria-expanded', String(open));
  if (open) return;
  const session = sessions.find((s) => s.id === current);
  if (session.state === 'done') { session.state = 'idle'; session.detail = '结果已查看，可以继续这项工作。'; render(); }
});
$('theme').onclick = () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme').textContent = dark ? '切换浅色' : '切换深色';
};
function createSession(project) {
  const id = Math.max(...sessions.map((s) => s.id)) + 1;
  sessions.push({ id, project, title: '新的工作', state: 'idle', detail: '等待你的第一条消息。', prompt: '开始一项新的工作。', answer: '在下方输入你的想法。' });
  openSession(id);
  $('message').focus();
}
$('new-chat').onclick = () => createSession(sessions.find((s) => s.id === current).project);
$('menu-new-chat').onclick = () => createSession(scope === 'all' ? sessions.find((s) => s.id === current).project : scope);
$('new-project').onclick = () => {
  $('project-form').hidden = !$('project-form').hidden;
  $('new-project').setAttribute('aria-expanded', String(!$('project-form').hidden));
  if (!$('project-form').hidden) $('project-input').focus();
};
$('cancel-project').onclick = () => {
  $('project-form').hidden = true;
  $('new-project').setAttribute('aria-expanded', 'false');
  $('new-project').focus();
};
$('project-form').onsubmit = (event) => {
  event.preventDefault();
  const name = $('project-input').value.trim();
  if (!name) { $('project-input').focus(); return; }
  const id = `project-${projects.length + 1}`;
  projects.push({ id, name, kind: 'local', location: '本地工作空间', rootPath: `D:/workspace/${id}`, description: '', defaultMode: 'ask', runtime: 'OpenCode' });
  scope = id;
  $('project-form').reset();
  $('project-form').hidden = true;
  $('new-project').setAttribute('aria-expanded', 'false');
  createSession(id);
};
$('composer').onsubmit = (event) => {
  event.preventDefault();
  const text = $('message').value.trim();
  if (!text) return;
  const session = sessions.find((s) => s.id === current);
  if (session.state === 'running' || session.state === 'waiting') { notify('请先完成当前模拟执行或处理待办，再发送消息。'); return; }
  session.prompt = text;
  session.state = 'running';
  session.lastActivity = ++activityOrder;
  session.detail = '正在处理你的消息。';
  session.answer = '已开始模拟执行。你可以切换工作空间，然后点击页面上方“模拟后台完成”查看通知效果。';
  $('message').value = '';
  render();
};
function reset() {
  projects.splice(0, projects.length, ...structuredClone(initialProjects));
  scope = 'all';
  projectTab = 'local';
  $('project-search').value = '';
  filter = 'all';
  $('project-form').reset();
  sessions = structuredClone(initial);
  sessions.forEach((session, index) => { session.lastActivity = initial.length - index; });
  activityOrder = initial.length;
  current = 1;
  Object.keys(remembered).forEach((key) => delete remembered[key]);
  Object.keys(drafts).forEach((key) => delete drafts[key]);
  remembered.buddy = 1;
  closeMenu();
  $('message').value = '';
  render();
}
$('reset').onclick = reset;
document.addEventListener('keydown', (event) => {
  if ($('project-settings').open) return;
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyK') {
    event.preventDefault();
    if (overview.matches(':popover-open')) { closeMenu(); menuTrigger?.focus(); } else showOverview();
  }
  if (event.key === 'Escape' && overview.matches(':popover-open')) {
    event.preventDefault(); closeMenu(); menuTrigger?.focus();
  }
});
window.addEventListener('resize', () => { if (overview.matches(':popover-open')) positionMenu(); });
reset();
