const conversations = [
  { id: 'layout', title: '会话统计信息设计', userCount: 12, assistantCount: 12, start: '14:05', end: '14:32', replies: [[0, 12], [50, 74], [120, 136], [220, 240], [300, 332], [440, 458], [590, 615], [720, 750], [890, 930], [1100, 1145], [1350, 1378], [1580, 1620]], user: '任务中心可以增加当前会话、任务的时长和消息数，信息可能没多少。', reply: '右侧累计每次 Agent 从开始回复到结束回复的时间，不计两次回复之间的空闲。下方管理当前项目的全部任务，也可以直接新建任务。\n\n切换会话时只更新会话统计，项目任务列表保留。', tasks: [
    { title: '制作统计布局 Demo', status: '进行中', duration: '6 分钟', time: '14:26 开始', active: true },
    { title: '核对统计字段', status: '已完成', duration: '3 分钟', time: '14:21 至 14:24', active: false }
  ] },
  { id: 'review', title: '导航方案评审', userCount: 5, assistantCount: 7, start: '10:18', end: '11:46', replies: [[0, 30], [300, 350], [700, 740], [1400, 1470], [2200, 2260], [3500, 3580], [5230, 5280]], user: '整理一下导航方案中的问题，形成一份评审清单。', reply: '评审清单已整理完成，包括项目入口、会话导航和任务状态展示。', tasks: [
    { title: '整理导航评审清单', status: '已完成', duration: '8 分钟', time: '11:38 至 11:46', active: false },
    { title: '补充导航交互说明', status: '已暂停', duration: '2 分钟', time: '11:48 开始', active: true }
  ] },
  { id: 'ideas', title: '随手聊聊产品想法', userCount: 3, assistantCount: 3, start: '16:20', end: '16:38', replies: [[0, 8], [400, 411], [1071, 1080]], user: '消息数量应该算条数，还是算对话轮数？', reply: '显示消息条数更直观。用户发言和助手回复分别计数，工具调用不单独算成聊天消息。', tasks: [] }
]
let conversationId = 'layout'
const $ = (id) => document.getElementById(id)
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
function render() {
  const conversation = conversations.find((item) => item.id === conversationId)
  $('session-count').textContent = `${conversations.length} 个`
  $('sessions').innerHTML = conversations.map((item) => `<button data-conversation="${item.id}" aria-current="${item.id === conversationId}">${escape(item.title)}<small>${item.userCount + item.assistantCount} 条消息</small></button>`).join('')
  $('conversation-title').textContent = conversation.title
  $('stats-title').textContent = conversation.title
  // Demo intervals are reply start/end offsets in seconds, including idle gaps.
  const replySeconds = conversation.replies.reduce((sum, [start, end]) => sum + end - start, 0)
  $('duration').textContent = replySeconds >= 60 ? `${Math.floor(replySeconds / 60)} 分 ${replySeconds % 60} 秒` : `${replySeconds} 秒`
  $('message-count').textContent = `${conversation.userCount + conversation.assistantCount} 条`
  $('message-breakdown').textContent = `你 ${conversation.userCount} 条 · 助手 ${conversation.assistantCount} 条`
  $('time-description').textContent = `本会话 ${conversation.replies.length} 次已结束回复，累计 ${replySeconds} 秒。演示按每次回复的起止时间计算。`
  $('messages').innerHTML = conversation.userCount ? `<article class="message user"><div class="message-author">你 <time>${conversation.start}</time></div><p>${escape(conversation.user)}</p></article><article class="message"><div class="message-author">GoodBuddy <time>${conversation.end}</time></div><p>${escape(conversation.reply)}</p></article>` : '<p class="empty">任务已关联此会话，尚无消息。Demo 不执行真实 Agent。</p>'
  const projectTasks = conversations.flatMap((session) => session.tasks.map((task, index) => ({ task, session, index })))
  const status = $('task-status').value
  const filtered = status !== 'all'
  const filterLabel = $('task-status').selectedOptions[0].textContent
  $('filter-toggle').classList.toggle('is-active', filtered)
  $('filter-toggle').setAttribute('aria-label', filtered ? `筛选任务：${filterLabel}` : '筛选任务')
  $('filter-toggle').title = filtered ? `筛选任务：${filterLabel}` : '筛选任务'
  $('active-filter').hidden = !filtered
  $('active-filter').textContent = `筛选：${filterLabel}`
  const visibleTasks = projectTasks.filter(({ task }) => status === 'all' || (status === 'ended' ? !task.active : task.status === status))
  $('task-count').textContent = `${visibleTasks.length} / ${projectTasks.length} 项`
  $('task-list').innerHTML = visibleTasks.length ? visibleTasks.map(({ task, session, index }) => `<article class="task-card" data-session="${session.id}" data-index="${index}"><div class="section-heading"><h3>${escape(task.title)}</h3><span class="status ${task.active ? '' : 'done'}">${task.status}</span></div><button class="task-session" data-open="${session.id}">${session.id === conversationId ? '当前会话' : '会话'} · ${escape(session.title)}</button><div class="task-duration"><span>${task.active ? '已用时' : '总用时'}</span><strong>${task.duration}</strong></div><p>${escape(task.time)}</p>${task.active ? `<div class="task-actions"><button data-action="toggle">${task.status === '已暂停' ? '继续' : '暂停'}</button><button data-action="cancel">取消任务</button></div>` : ''}</article>`).join('') : '<p class="empty">当前项目暂无此状态的任务</p>'
}
$('task-status').addEventListener('change', render)
$('filter-toggle').addEventListener('click', () => {
  const expanded = $('task-filter').hidden
  $('task-filter').hidden = !expanded
  $('filter-toggle').setAttribute('aria-expanded', String(expanded))
  if (expanded) $('task-status').focus()
})
$('task-filter').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  $('task-filter').hidden = true
  $('filter-toggle').setAttribute('aria-expanded', 'false')
  $('filter-toggle').focus()
})
$('task-list').addEventListener('click', (event) => {
  const button = event.target.closest('button')
  if (!button) return
  if (button.dataset.open) {
    conversationId = button.dataset.open
    render()
    $('conversation-title').tabIndex = -1
    $('conversation-title').focus()
    return
  }
  const card = button.closest('[data-session]')
  const task = conversations.find((session) => session.id === card.dataset.session).tasks[Number(card.dataset.index)]
  if (button.dataset.action === 'cancel') {
    task.status = '已取消'
    task.active = false
  } else {
    if (task.status === '已暂停') {
      task.status = task.resumeStatus || '进行中'
    } else {
      task.resumeStatus = task.status
      task.status = '已暂停'
    }
  }
  const sessionId = card.dataset.session
  const index = card.dataset.index
  render()
  const next = $('task-list').querySelector(`[data-session="${sessionId}"][data-index="${index}"] button`)
  ;(next || ($('task-filter').hidden ? $('filter-toggle') : $('task-status'))).focus()
})
$('sessions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-conversation]')
  if (!button) return
  conversationId = button.dataset.conversation
  render()
  $('sessions').querySelector(`[data-conversation="${conversationId}"]`).focus()
})
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark'
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  $('theme').setAttribute('aria-pressed', String(dark))
  $('theme').textContent = dark ? '浅色模式' : '深色模式'
})
$('new-task').addEventListener('click', () => {
  $('task-form').hidden = false
  $('new-task').setAttribute('aria-expanded', 'true')
  $('task-conversation').innerHTML = conversations.map((session) => `<option value="${session.id}">${escape(session.title)}</option>`).join('') + '<option value="new">新建会话</option>'
  $('task-conversation').value = conversationId
  $('task-content').focus()
})
$('close-form').addEventListener('click', () => {
  $('task-form').hidden = true
  $('new-task').setAttribute('aria-expanded', 'false')
  $('new-task').focus()
})
$('task-timing').addEventListener('change', () => {
  const scheduled = $('task-timing').value === 'scheduled'
  $('schedule-field').hidden = !scheduled
  $('task-date').required = scheduled
  $('task-date').disabled = !scheduled
})
$('task-content').addEventListener('input', () => $('task-content').setCustomValidity(''))
$('task-date').addEventListener('input', () => $('task-date').setCustomValidity(''))
$('task-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const title = $('task-content').value.trim()
  $('task-content').setCustomValidity(title ? '' : '请输入任务内容')
  const scheduled = $('task-timing').value === 'scheduled'
  $('task-date').setCustomValidity(scheduled && !(new Date($('task-date').value).getTime() > Date.now()) ? '请选择未来的时间' : '')
  if (!$('task-form').reportValidity()) return
  let session = conversations.find((item) => item.id === $('task-conversation').value)
  if (!session) {
    session = { id: `new-${conversations.length}`, title: title.slice(0, 24), userCount: 0, assistantCount: 0, replies: [], tasks: [] }
    conversations.push(session)
  }
  session.tasks.unshift({ title, status: scheduled ? '待执行' : '进行中', duration: '0 秒', time: scheduled ? `计划于 ${$('task-date').value.replace('T', ' ')}` : '刚刚创建 · 模拟执行', active: true })
  $('task-status').value = 'all'
  $('task-form').reset()
  $('schedule-field').hidden = true
  $('task-date').required = false
  $('task-date').disabled = true
  $('task-form').hidden = true
  $('new-task').setAttribute('aria-expanded', 'false')
  render()
  const created = $('task-list').querySelector(`[data-session="${session.id}"][data-index="0"] .task-session`)
  created.focus()
})
render()
