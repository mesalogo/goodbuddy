/* global document */
const stories = [
  { id: 'graph', title: '监督者 · 故事图谱', color: 'var(--accent)', cx: 270, cy: 230, r: 172, description: '从工作过程到可追溯的故事' },
  { id: 'knowledge', title: '个人知识库', color: 'var(--success)', cx: 625, cy: 260, r: 146, description: '从学习记录到可复用的知识' },
  { id: 'memory', title: '记忆架构', color: 'var(--warning)', cx: 451, cy: 463, r: 118, description: '从原始数据到分层理解' }
];
const nodes = [
  { id: 'g0', story: 'graph', stage: 0, x: 160, y: 205, label: '观察工作过程', title: '让工作过程可以回看', copy: '监督者按时间记录工作的推进。我们希望在记录之上保留阶段性的理解，帮助用户重新进入一段未完成的工作。', source: '监督者功能讨论', quote: '过一周再回来，我需要知道之前为什么这样做，而不只是看到最后的结果。' },
  { id: 'g1', story: 'graph', stage: 1, x: 261, y: 260, label: '阶段总结', title: '把连续记录整理成阶段', copy: '每个阶段保留讨论的问题、形成的判断和仍未解决的事项。阶段节点沿时间连接，组成一条能够继续展开的故事。', source: '阶段总结交互草案', quote: '以一个阶段为单位总结。保留关键决定，也保留没有走通的尝试和原始记录。' },
  { id: 'g2', story: 'graph', stage: 2, x: 326, y: 215, label: '保留知识来路', title: '总结之后，仍能找到来路', copy: '故事图谱把阶段总结和原始记录连接起来。跨时间线聚合出的知识，也应保留每条贡献来源，方便核对结论、理解语境。', source: 'Story Graph 方案讨论', quote: '阶段总结与聚合知识应保留来源，支持追溯原始记录。', related: 'k2', reason: '共同要求：聚合知识仍可回到原始记录' },
  { id: 'k0', story: 'knowledge', stage: 0, x: 706, y: 213, label: '学习记录', title: '记录学习中的问题', copy: '学习时产生的笔记与问答散落在不同会话中。先保留它们的上下文，再考虑如何归入个人知识库。', source: '学习知识图谱讨论', quote: '学习时的提问和笔记可以放在一起，之后能够继续补充。' },
  { id: 'k1', story: 'knowledge', stage: 1, x: 635, y: 304, label: '知识关联', title: '把同一个问题的线索连起来', copy: '不同笔记可能围绕同一个问题。关联需要说明它们共有的主题，以及各自提供了什么补充。', source: '个人知识库设计记录', quote: '关联不只是两段内容相似，还要说明这条联系为什么有用。' },
  { id: 'k2', story: 'knowledge', stage: 2, x: 562, y: 240, label: '来源追溯', title: '知识条目携带出处', copy: '知识库中的归纳附带原始笔记和讨论位置。用户可以从结论返回上下文，判断它是否适用于当前问题。', source: '知识条目来源设计', quote: '每条归纳都应该能够展开出处，看到原话和产生结论时的上下文。', related: 'g2', reason: '共同要求：聚合知识仍可回到原始记录' },
  { id: 'm0', story: 'memory', stage: 0, x: 380, y: 475, label: '原始数据', title: '从真实记录开始', copy: '原始会话、笔记和执行结果构成记忆的基础。上层归纳需要能指向这些记录。', source: '记忆基础讨论', quote: '先有记录，再有总结；总结不能取代原始记录。' },
  { id: 'm1', story: 'memory', stage: 1, x: 465, y: 504, label: 'DIKW 分层', title: '区分记录与理解的层次', copy: '尝试按数据、信息、知识、智慧组织记忆。图谱中的阶段总结与知识聚合，可能成为这些层次之间的连接。', source: 'DIKW 设计草案', quote: '数据、信息、知识、智慧应当分层呈现，让用户知道当前看到的是什么。' },
  { id: 'm2', story: 'memory', stage: 2, x: 478, y: 438, label: '可解释的归纳', title: '让每层归纳都能被解释', copy: '从数据到知识的每一步，都应说明归纳依据。阶段总结可以连接过程记录，聚合知识可以连接多个阶段。', source: '记忆分层讨论', quote: '一条知识来自哪些信息、信息又来自哪些数据，需要能够顺着关系找回去。', related: 'g2', reason: '共同要求：上层归纳保留底层依据' }
];
const dates = ['09.01 · 故事起点', '09.07 · 持续探索', '09.14 · 知识汇聚'];
let activeStory = null;
let selected = 'g2';
let stage = 2;
const graph = document.querySelector('#graph');
const detail = document.querySelector('#detail');

function showDetail() {
  const node = nodes.find(item => item.id === selected);
  const story = stories.find(item => item.id === node.story);
  const related = node.related && nodes.find(item => item.id === node.related);
  detail.innerHTML = `<div class="detail-intro"><div class="detail-kicker">${story.title} / 阶段 ${node.stage + 1}</div><h2 class="detail-title">${node.title}</h2><p class="detail-copy">${node.copy}</p></div>
    <div class="detail-block"><h3>跨时间线关联</h3>${related && related.stage <= stage ? `<button class="relation-link" data-target="${related.id}">${related.title} ↗<small>${node.reason}</small></button>` : '<p class="muted">此阶段尚未建立跨线关联。</p>'}</div>
    <div class="detail-block"><h3>来源记录 · 1 条</h3><details class="source"><summary>${node.source}</summary><small>模拟会话 / 2026.${dates[node.stage].slice(0, 5)} / 消息 #${node.stage + 1}</small><p>“${node.quote}”</p></details><small>演示来源，可展开查看模拟原文。</small></div>`;
}

function render() {
  document.querySelector('#timeline-list').innerHTML = stories.map(story => `<button class="timeline" data-story="${story.id}" aria-pressed="${activeStory === story.id}" style="--story-color:${story.color}"><span class="timeline-top"><i class="timeline-color"></i><span>0${stage + 1} 个阶段</span></span><strong>${story.title}</strong><small>${story.description}</small></button>`).join('');
  document.querySelector('#graph-title').textContent = activeStory ? stories.find(item => item.id === activeStory).title : '全部故事';
  document.querySelector('#node-count').textContent = ` / ${(stage + 1) * (activeStory ? 1 : 3)} 个阶段`;
  document.querySelector('#date-label').textContent = dates[stage];
  const showRelations = document.querySelector('#relations').checked;
  const flat = document.querySelector('#view').value === 'flat';
  document.querySelector('.sidebar-note p').innerHTML = flat ? '时间沿外圈逆时针推进。<br>内部平铺知识节点，<br>时间点直接连接对应节点。' : '一个圆，一条时间线。<br>圆内节点是阶段总结，<br>圆间虚线是知识关联。';
  document.querySelector('.canvas-caption').innerHTML = `<span class="live-dot"></span> ${flat ? '外圈时间逆时针推进 · 点击节点高亮时间连线' : '阶段总结构成故事，关联让知识相遇'}`;
  const plotted = nodes.map(node => flat ? { ...node, x: [280, 430, 580][stories.findIndex(story => story.id === node.story)], y: [210, 330, 450][node.stage] } : node);
  let markup = stories.map(story => `<g style="--story-color:${story.color}" class="${activeStory && activeStory !== story.id ? 'dim' : ''}"><circle class="orbit" cx="${story.cx}" cy="${story.cy}" r="${story.r}"/><circle class="orbit-inner" cx="${story.cx}" cy="${story.cy}" r="${story.r * .62}"/><text class="orbit-label" x="${story.cx}" y="${story.cy - story.r + 36}" text-anchor="middle">${story.title}</text><text class="orbit-caption" x="${story.cx}" y="${story.cy - story.r + 55}" text-anchor="middle">${stage + 1} 个阶段 · ${story.id === 'graph' ? '持续收敛' : story.id === 'knowledge' ? '多向探索' : '逐步归纳'}</text><path class="story-path" d="${nodes.filter(node => node.story === story.id && node.stage <= stage).map((node, index) => `${index ? 'L' : 'M'}${node.x},${node.y}`).join(' ')}"/></g>`).join('');
  if (showRelations && stage === 2) markup += '<path class="cross-path" d="M326 215 Q439 153 562 240 M326 215 Q366 362 478 438 M562 240 Q565 365 478 438"/><text class="bridge-label" x="413" y="188">来源追溯</text><text class="bridge-label" x="372" y="367">归纳依据</text>';
  if (flat) {
    const anchors = [{ x: 430, y: 65 }, { x: 95, y: 310 }, { x: 765, y: 310 }];
    markup = `<defs><marker id="time-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="var(--accent)"/></marker></defs>
      <ellipse class="time-boundary" cx="430" cy="310" rx="335" ry="245"/>
      <path class="time-ring" marker-end="url(#time-arrow)" d="M430 65 A335 245 0 0 0 95 310 A335 245 0 0 0 430 555 A335 245 0 0 0 765 310 A335 245 0 0 0 560 84"/>
      <text class="orbit-caption" x="430" y="30" text-anchor="middle">起点 · 逆时针沿外圈阅读 ↶</text>`;
    markup += plotted.filter(node => node.stage <= stage).map(node => {
      const anchor = anchors[node.stage];
      return `<path class="time-link ${node.id === selected ? 'active' : ''} ${activeStory && activeStory !== node.story ? 'dim' : ''}" d="M${anchor.x} ${anchor.y} Q${anchor.x} ${node.y} ${node.x} ${node.y}"/>`;
    }).join('');
    markup += stories.map(story => `<g style="--story-color:${story.color}" class="${activeStory && activeStory !== story.id ? 'dim' : ''}"><path class="story-path" d="${plotted.filter(node => node.story === story.id && node.stage <= stage).map((node, index) => `${index ? 'L' : 'M'}${node.x},${node.y}`).join(' ')}"/><text class="orbit-caption" text-anchor="middle" x="${plotted.find(node => node.story === story.id).x}" y="165">${story.title}</text></g>`).join('');
    if (showRelations && stage === 2) markup += '<path class="cross-path" d="M280 450 Q355 407 430 450 M280 450 Q430 515 580 450 M430 450 Q505 407 580 450"/>';
    markup += anchors.map((anchor, index) => `<g class="time-point ${index > stage ? 'dim' : ''}"><circle cx="${anchor.x}" cy="${anchor.y}" r="7"/><text x="${anchor.x}" y="${anchor.y - 20}" text-anchor="middle">${dates[index].slice(0, 5)}</text><text class="orbit-caption" x="${anchor.x}" y="${anchor.y + 28}" text-anchor="middle">${['首次提出', '持续补充', '形成归纳'][index]}</text></g>`).join('');
  }
  markup += plotted.filter(node => node.stage <= stage).map(node => {
    const story = stories.find(item => item.id === node.story);
    return `<g class="node ${node.id === selected ? 'selected' : ''} ${activeStory && activeStory !== node.story ? 'dim' : ''}" style="--story-color:${story.color}" transform="translate(${node.x} ${node.y})" tabindex="0" role="button" aria-label="${story.title}：${node.title}" aria-pressed="${node.id === selected}" data-node="${node.id}"><circle class="halo" r="22"/><circle class="core" r="${node.stage === 2 ? 10 : 7}"/><text text-anchor="middle" y="34">${node.label}</text></g>`;
  }).join('');
  graph.innerHTML = markup;
  showDetail();
}

function selectNode(id) {
  selected = id;
  render();
}
document.querySelector('#timeline-list').addEventListener('click', event => {
  const button = event.target.closest('[data-story]');
  if (!button) return;
  activeStory = activeStory === button.dataset.story ? null : button.dataset.story;
  if (activeStory) selected = nodes.find(node => node.story === activeStory && node.stage === stage).id;
  render();
});
graph.addEventListener('click', event => {
  const node = event.target.closest('[data-node]');
  if (node) selectNode(node.dataset.node);
});
graph.addEventListener('keydown', event => {
  const node = event.target.closest('[data-node]');
  if (node && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    const id = node.dataset.node;
    selectNode(id);
    graph.querySelector(`[data-node="${id}"]`).focus();
  }
});
detail.addEventListener('click', event => {
  const button = event.target.closest('[data-target]');
  if (!button) return;
  activeStory = null;
  selectNode(button.dataset.target);
});
document.querySelector('#relations').addEventListener('change', render);
document.querySelector('#view').addEventListener('change', render);
document.querySelector('#reset').addEventListener('click', () => { activeStory = null; render(); });
document.querySelector('#stage').addEventListener('input', event => {
  stage = Number(event.target.value);
  const story = activeStory || nodes.find(node => node.id === selected).story;
  selected = nodes.find(node => node.story === story && node.stage === stage).id;
  render();
});
document.querySelector('#theme').addEventListener('click', () => {
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
});
document.querySelector('#insight').addEventListener('click', () => {
  stage = 2;
  activeStory = null;
  document.querySelector('#stage').value = '2';
  document.querySelector('#relations').checked = true;
  render();
  detail.innerHTML = `<div class="detail-intro"><div class="detail-kicker">跨时间线聚合 / 示例</div><h2 class="detail-title">知识需要保留来路</h2><p class="detail-copy">三个故事指向同一个设计要求：不论是阶段总结、知识条目，还是分层记忆，归纳结果都需要连接原始依据。</p></div><div class="detail-block"><h3>来自 3 条时间线</h3>${['g2', 'k2', 'm2'].map(id => { const node = nodes.find(item => item.id === id); return `<button class="relation-link" data-target="${id}">${node.title} ↗<small>${stories.find(item => item.id === node.story).title} · 点击查看阶段与来源</small></button>`; }).join('')}</div><div class="detail-block"><h3>聚合说明</h3><p class="muted">以上为预置的聚合示例。实际功能需要结合来源生成关联依据，并允许用户核对。</p></div>`;
  document.querySelector('.inspector').scrollIntoView({ block: 'nearest' });
});
render();
