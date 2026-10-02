/* 3D Story Graph prototype on a real export: one time helix, nested story staves (project > feature > sub-thread).
 * Geometry: height = time (uniform), helix radius = attention density, staves sit on a fixed outer cylinder at a
 * stable angle, and each event joins its stave by a horizontal connector at the same height. */
const data = window.STORY_DATA;
const canvas = document.querySelector('#scene');
const ctx = canvas.getContext('2d');
const tau = Math.PI * 2;
const palette = ['#367e70', '#bb8743', '#8675a6', '#b5604f', '#4f7fa8', '#7a8f3b', '#a35d86', '#3f8f97', '#9a7a55', '#5f6fb0', '#c07a3a', '#6b8d6f'];
const range = data.range.map(d => Date.parse(d + 'T00:00:00+08:00'));
const totalHours = (range[1] - range[0]) / 3600000;
const zoom = document.querySelector('#zoom');
const showWisdom = document.querySelector('#wisdom');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- model ---------------------------------------------------------------
// The two saved reviews overlap and re-extracted the same moments; show each (time, type) once.
const canonical = new Map();
data.projects.forEach(p => p.features.forEach(f => {
  const seen = new Map();
  f.events = f.events.filter(e => { const k = e.at + e.type; if (seen.has(k)) { canonical.set(e.id, seen.get(k)); return false; } seen.set(k, e.id); canonical.set(e.id, e.id); return true; });
}));
const canon = id => canonical.get(id) ?? id;
data.wisdom.forEach(w => { w.formedIn = [...new Set(w.formedIn.map(canon))]; w.appliedIn = [...new Set(w.appliedIn.map(canon))]; });
const root = { name: '全部工作', children: data.projects.map(p => ({
  name: p.name, detailed: p.detailed, scattered: p.scattered,
  children: p.features.map(f => ({ ...f, children: f.subThreads.map(s => ({ ...s,
    events: [...new Set(s.eventIds.map(canon))].map(id => f.events.find(e => e.id === id)).filter(Boolean) })) }))
})) };
const eventIndex = new Map();
function finish(node, parent, depth) {
  node.parent = parent; node.depth = depth;
  (node.children ?? []).forEach(c => finish(c, node, depth + 1));
  if (!node.events) node.events = [...new Map(node.children.flatMap(c => c.events).map(e => [e.id, e])).values()].sort((a, b) => a.t - b.t);
  node.start = node.events[0]?.t ?? 0; node.end = node.events.at(-1)?.t ?? 0;
  if (depth === 2) node.events.forEach(e => eventIndex.set(e.id, { event: e, feature: node }));
}
finish(root, undefined, 0);
root.children.forEach((p, i) => { p.color = palette[i % palette.length]; });
let focus = root, selectedEvent, selectedWisdom, hovered, hits = [];

// Stable angular layout: siblings keep the order of their first event, each takes a sector by sqrt(event count).
function layout(node, from, to) {
  node.a0 = from; node.a1 = to;
  const kids = (node.children ?? []).slice().sort((a, b) => a.start - b.start);
  const weight = kids.map(k => Math.max(1.2, Math.sqrt(k.events.length)));
  const total = weight.reduce((a, b) => a + b, 0);
  let at = from;
  kids.forEach((k, i) => { const w = (to - from) * weight[i] / total; layout(k, at, at + w); at += w; });
}
layout(root, 0, tau);

// ---- geometry ----------------------------------------------------------------
// Event times `t` are normalised over the whole export. The viewed window [win.t0, win.t1] maps to the full height,
// and one turn covers `turnHours`, chosen so the helix keeps a readable number of turns at any range.
const HEIGHT = 430, STAVE_R = 188, FLOOR = -HEIGHT / 2 - 34;
const TURN_STEPS = [3, 6, 12, 24, 168, 720, 2160, 8760]; // hours: 3h … 1 year
const TARGET_TURNS = 8, MAX_TURNS = 14;
const win = { t0: 0, t1: 1, turnHours: 24, auto: true };
let turns = 8, bins = [], binMax = 1;
const hoursOf = t => t * totalHours;
const clamp01 = t => Math.max(0, Math.min(1, t));
const inWindow = t => t >= win.t0 - 1e-9 && t <= win.t1 + 1e-9;
const uOf = t => (t - win.t0) / (win.t1 - win.t0);
function autoTurnHours(spanHours) { return TURN_STEPS.find(h => spanHours / h <= TARGET_TURNS) ?? TURN_STEPS.at(-1); }
// Attention density is re-counted at the current grain: one bin is an eighth of a turn.
const slotTimes = data.density.map((n, i) => ({ t: (i + .5) / data.density.length, n }));
function setWindow(t0, t1, turnHours) {
  win.t0 = clamp01(t0); win.t1 = clamp01(t1);
  const span = hoursOf(win.t1 - win.t0);
  win.turnHours = turnHours ?? autoTurnHours(span);
  turns = Math.max(.5, span / win.turnHours);
  if (turns > MAX_TURNS) { win.turnHours = TURN_STEPS.find(h => span / h <= MAX_TURNS) ?? TURN_STEPS.at(-1); turns = span / win.turnHours; }
  const count = Math.max(4, Math.round(turns * 8));
  bins = new Array(count).fill(0);
  slotTimes.forEach(s => { if (inWindow(s.t)) bins[Math.min(count - 1, Math.floor(uOf(s.t) * count))] += s.n; });
  binMax = Math.max(1, ...bins);
  smoothR = Array.from({ length: 401 }, (_, i) => { let s = 0; for (let k = -3; k <= 3; k++) s += density(clamp01((i + k) / 400)); return s / 7; });
}
function density(u) {
  const x = u * bins.length - .5, i = Math.floor(x), f = x - i, at = j => bins[Math.max(0, Math.min(bins.length - 1, j))] / binMax;
  return at(i) * (1 - f) + at(i + 1) * f;
}
let smoothR = [];
const radius = t => 52 + 100 * smoothR[Math.round(clamp01(uOf(t)) * 400)];
const yOf = t => (uOf(t) - .5) * HEIGHT;
const helixAngle = t => uOf(t) * turns * tau;
const helixPoint = t => { const r = radius(t), a = helixAngle(t); return [r * Math.cos(a), yOf(t), r * Math.sin(a)]; };
const cylinder = (t, a, r = STAVE_R) => [r * Math.cos(a), yOf(t), r * Math.sin(a)];
const centerAngle = node => (node.a0 + node.a1) / 2;

// ---- camera ------------------------------------------------------------------
const VIEWS = { oblique: { yaw: -.4, tilt: .38 }, side: { tilt: 0 }, top: { tilt: Math.PI / 2 } };
const cam = { yaw: -.4, tilt: .38, zoom: 1, pan: 0 };
let mode = 'oblique', tween;
let width = 0, height = 0;
function project(p) {
  const y0 = p[1] - cam.pan;
  const x = p[0] * Math.cos(cam.yaw) + p[2] * Math.sin(cam.yaw);
  const z = -p[0] * Math.sin(cam.yaw) + p[2] * Math.cos(cam.yaw);
  const y = y0 * Math.cos(cam.tilt) - z * Math.sin(cam.tilt);
  const depth = y0 * Math.sin(cam.tilt) + z * Math.cos(cam.tilt);
  const scale = Math.min(width / 500, height / 560) * cam.zoom * 900 / (900 - depth);
  return { x: width / 2 + x * scale, y: height / 2 - y * scale, z: depth };
}
const shortest = (from, to) => from + ((((to - from) % tau) + tau * 1.5) % tau - Math.PI);
function animateTo(target, nextMode = mode) {
  mode = nextMode; syncViewButtons();
  const goal = { ...cam, ...target };
  goal.yaw = shortest(cam.yaw, goal.yaw);
  if (reducedMotion) { Object.assign(cam, goal); syncZoom(); draw(); return; }
  const from = { ...cam }, started = performance.now();
  tween = { from, goal, started };
  const step = now => {
    if (tween?.started !== started) return;
    const k = Math.min(1, (now - started) / 480), e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    for (const key of ['yaw', 'tilt', 'zoom', 'pan']) cam[key] = from[key] + (goal[key] - from[key]) * e;
    syncZoom(); draw();
    if (k < 1) requestAnimationFrame(step); else tween = undefined;
  };
  requestAnimationFrame(step);
}
// Turn the camera so a stave faces the viewer.
function face(node) { if (node && node.depth > 0) animateTo({ yaw: centerAngle(node) - Math.PI / 2, pan: (yOf(Math.max(win.t0, node.start)) + yOf(Math.min(win.t1, node.end))) / 2 * .35 }); }
function freeView() { tween = undefined; if (mode !== 'free') { mode = 'free'; syncViewButtons(); } }

// ---- colour and depth cue -------------------------------------------------------
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const GREY = [150, 158, 154];
// k: 0 = farthest, 1 = nearest. Far geometry loses saturation and opacity instead of gaining an outline.
function shade(hex, alpha, k) {
  const [r, g, b] = hexRgb(hex), d = (1 - k) * .65;
  const mix = (c, i) => Math.round(c * (1 - d) + GREY[i] * d);
  return `rgba(${mix(r, 0)},${mix(g, 1)},${mix(b, 2)},${(alpha * (.22 + .78 * k)).toFixed(3)})`;
}
const projectOf = n => { while (n.depth > 1) n = n.parent; return n; };
function colorOf(node) {
  if (node.depth <= 1) return node.color ?? '#6f807b';
  const p = projectOf(node);
  return palette[(node.parent.children.indexOf(node) + root.children.indexOf(p) * 3) % palette.length];
}
function shown(node) { const set = visibleStaves(); for (let n = node; n; n = n.parent) if (set.includes(n)) return n; }
function level() { return focus.children?.length ? focus : focus.parent; }
function visibleStaves() { return level().children; }
function emphasisOf(s) { return focus === level() ? (s === hovered ? 'focus' : 'normal') : s === focus ? 'focus' : 'dim'; }
// Staves whose events are joined to the helix: the focused leaf, or the stave under the pointer.
function connected() { return visibleStaves().filter(s => (focus !== level() && s === focus) || s === hovered); }

// ---- rendering ---------------------------------------------------------------
const tAt = u => win.t0 + u * (win.t1 - win.t0);
function drawFloor() {
  // A faint footprint on the floor helps read front and back.
  const ring = [];
  for (let i = 0; i <= 96; i++) ring.push(project(cylinder(win.t0, i / 96 * tau, STAVE_R).map((v, j) => j === 1 ? FLOOR : v)));
  line(ring, 'rgba(120,132,124,.16)', 1);
  const shadow = [];
  for (let i = 0; i <= 900; i++) { const p = helixPoint(tAt(i / 900)); p[1] = FLOOR; shadow.push(project(p)); }
  line(shadow, 'rgba(110,122,114,.10)', 4);
}
function line(points, color, size = 1, dash = []) {
  ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.setLineDash(dash); ctx.lineWidth = size; ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.stroke(); ctx.setLineDash([]);
}
function polygon(points, color) { ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.fillStyle = color; ctx.fill(); }
// Events closer than this on screen are merged into one cluster (≈ 9 px of height).
const CLUSTER_PX = 9;
function scaleNow() { return Math.min(width / 500, height / 560) * cam.zoom; }
function clusterSpan() { return CLUSTER_PX / (HEIGHT * scaleNow()) * (win.t1 - win.t0); }
// Groups a story's in-window events into clusters on the time axis, at the current grain and zoom.
function clusters(events) {
  const span = clusterSpan(), out = [];
  events.filter(e => inWindow(e.t)).forEach(e => {
    const last = out.at(-1);
    if (last && e.t - last.t0 <= span) { last.events.push(e); last.t1 = e.t; } else out.push({ t0: e.t, t1: e.t, events: [e] });
  });
  out.forEach(c => { c.t = (c.t0 + c.t1) / 2; c.n = c.events.length; });
  return out;
}
const fmtSpan = c => c.n === 1 ? fmtTime(c.t) : `${fmtTime(c.t0)} – ${fmtTime(c.t1)}`;
function draw() {
  if (!width) return;
  ctx.clearRect(0, 0, width, height); hits = [];
  drawFloor();
  const prims = [], staves = visibleStaves().filter(s => s.events.some(e => inWindow(e.t))), links = connected();
  const cl = new Map(staves.map(s => [s, clusters(s.events)]));
  // Helix: one continuous line split into short segments so it can interleave with staves by depth.
  const owner = new Array(600).fill(undefined);
  staves.filter(s => emphasisOf(s) !== 'dim').forEach(s => cl.get(s).forEach(c => {
    const i0 = Math.round(uOf(c.t0) * 599), i1 = Math.round(uOf(c.t1) * 599);
    for (let i = i0 - 1; i <= i1 + 1; i++) if (i >= 0 && i < 600 && owner[i] === undefined) owner[i] = colorOf(s);
  }));
  const N = 1800;
  let previous = project(helixPoint(tAt(0)));
  for (let i = 1; i <= N; i++) {
    const u = i / N, next = project(helixPoint(tAt(u))), c = owner[Math.round(u * 599)];
    const a = previous, b = next;
    prims.push({ z: (a.z + b.z) / 2, draw: k => line([a, b], shade(c ?? '#6d7c76', c ? 1 : .8, k), c ? 2.4 : 1.25) });
    previous = next;
  }
  // Staves: vertical strips of a fixed outer cylinder, spanning the story's first to last event in the window.
  staves.forEach(s => {
    const em = emphasisOf(s), color = colorOf(s), gap = Math.min(.014, (s.a1 - s.a0) * .08);
    const inside = s.events.filter(e => inWindow(e.t)), pad = (win.t1 - win.t0) * .006;
    const a0 = s.a0 + gap, a1 = s.a1 - gap;
    const t0 = Math.max(win.t0, inside[0].t - pad), t1 = Math.min(win.t1, inside.at(-1).t + pad);
    const fill = em === 'focus' ? .26 : em === 'dim' ? .05 : .13, edge = em === 'dim' ? .28 : .75;
    const strips = Math.max(2, Math.ceil((a1 - a0) / .07));
    for (let j = 0; j < strips; j++) {
      const b0 = a0 + (a1 - a0) * j / strips, b1 = a0 + (a1 - a0) * (j + 1) / strips;
      const quad = [cylinder(t0, b0), cylinder(t0, b1), cylinder(t1, b1), cylinder(t1, b0)].map(project);
      const z = quad.reduce((n, p) => n + p.z, 0) / 4;
      prims.push({ z, draw: k => polygon(quad, shade(color, fill, k)) });
      if (em !== 'dim' && (j === 0 || j === strips - 1)) {
        const edgeAngle = j === 0 ? b0 : b1;
        prims.push({ z: z + .1, draw: k => line([project(cylinder(t0, edgeAngle)), project(cylinder(t1, edgeAngle))], shade(color, edge, k), 1) });
      }
      hits.push({ kind: 'stave', node: s, poly: quad, z });
    }
    // One band per cluster: thickness grows with the number of events; quiet periods stay as gaps.
    cl.get(s).forEach(c => {
      const band = []; for (let i = 0; i <= 8; i++) band.push(project(cylinder(c.t, a0 + (a1 - a0) * i / 8, STAVE_R + .5)));
      const z = band[4].z + .2, active = c.events.includes(selectedEvent);
      const size = Math.min(6, 1.3 + Math.log2(c.n) * 1.1) + (active ? 2 : 0);
      prims.push({ z, draw: k => line(band, shade(color, em === 'dim' ? .3 : .85, k), size) });
    });
    s.labelAt = project(cylinder(t1, centerAngle(s), STAVE_R + 2));
    s.labelZ = s.labelAt.z;
  });
  // Connectors: helix -> stave at the same height, one per cluster; clusters show their size and open on click.
  links.filter(s => cl.has(s)).forEach(s => {
    const color = colorOf(s), a = centerAngle(s);
    cl.get(s).forEach(c => {
      const p = project(helixPoint(c.t)), q = project(cylinder(c.t, a)), active = c.events.includes(selectedEvent);
      const r = c.n === 1 ? (active ? 6 : 3.4) : Math.min(11, 6 + Math.log2(c.n) * 1.4);
      prims.push({ z: (p.z + q.z) / 2, draw: k => line([p, q], shade(color, active ? .95 : .45, k), active ? 2 : 1) });
      prims.push({ z: p.z + .3, draw: k => {
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, tau); ctx.fillStyle = shade(color, 1, k); ctx.fill();
        ctx.strokeStyle = active ? '#273b36' : 'rgba(252,252,248,.9)'; ctx.lineWidth = 1.4; ctx.stroke();
        if (c.n > 1) { ctx.fillStyle = '#fcfcf8'; ctx.font = '600 9px system-ui'; const label = String(c.n); ctx.fillText(label, p.x - ctx.measureText(label).width / 2, p.y + 3); }
      } });
      if (focus.depth >= 2 || s === focus) hits.push({ kind: 'cluster', cluster: c, node: s, x: p.x, y: p.y, r: Math.max(9, r + 2), z: p.z });
    });
  });
  // Turn ticks on the helix: equal time per turn, labelled at the current grain.
  const every = Math.max(1, Math.ceil(turns / 10));
  for (let d = 0; d <= Math.floor(turns + 1e-6); d++) {
    const t = tAt(d / turns), p = project(helixPoint(t));
    prims.push({ z: p.z + .4, draw: k => {
      ctx.fillStyle = shade('#3f514a', 1, k); ctx.beginPath(); ctx.arc(p.x, p.y, 2.3, 0, tau); ctx.fill();
      if (d % every === 0 && d / turns < .999) { ctx.font = '10px system-ui'; ctx.fillText(fmtTick(t), p.x + 6, p.y + 3); }
    } });
  }
  let zmin = Infinity, zmax = -Infinity;
  prims.forEach(p => { zmin = Math.min(zmin, p.z); zmax = Math.max(zmax, p.z); });
  const norm = z => zmax > zmin ? (z - zmin) / (zmax - zmin) : 1;
  prims.sort((a, b) => a.z - b.z).forEach(p => p.draw(norm(p.z)));
  drawLabels(staves, norm);
  if (showWisdom.checked) data.wisdom.forEach((w, i) => drawWisdom(w, i));
}
// Labels: the focused or hovered stave always; otherwise only staves facing the viewer, without overlaps.
function drawLabels(staves, norm) {
  const placed = [];
  staves.map(s => ({ s, k: norm(s.labelZ), em: emphasisOf(s) }))
    .sort((a, b) => (b.em === 'focus') - (a.em === 'focus') || b.k - a.k)
    .forEach(({ s, k, em }) => {
      if (em === 'dim' || (em !== 'focus' && k < .45)) return;
      ctx.font = (em === 'focus' ? '600 ' : '') + '11px system-ui';
      const w = ctx.measureText(s.name).width, x = s.labelAt.x - w / 2, y = s.labelAt.y - 8;
      const box = [x - 4, y - 12, w + 8, 16];
      if (placed.some(b => box[0] < b[0] + b[2] && b[0] < box[0] + box[2] && box[1] < b[1] + b[3] && b[1] < box[1] + box[3])) return;
      placed.push(box);
      ctx.fillStyle = 'rgba(252,252,248,.82)'; ctx.fillRect(...box);
      ctx.fillStyle = shade(colorOf(s), 1, Math.max(k, em === 'focus' ? 1 : 0)); ctx.fillText(s.name, x, y);
      hits.push({ kind: 'label', node: s, rect: box });
    });
}
function staveFor(eventId) { const hit = eventIndex.get(eventId); if (!hit) return; const sub = hit.feature.children.find(s => s.events.some(e => e.id === eventId)); return { event: hit.event, node: sub ?? hit.feature }; }
function drawWisdom(w, i) {
  const a = staveFor(w.formedIn[0]), b = staveFor(w.appliedIn.at(-1)); if (!a || !b) return;
  const sa = shown(a.node), sb = shown(b.node); if (!sa || !sb || sa === sb) return;
  if (!inWindow(a.event.t) || !inWindow(b.event.t)) return; // either end lies outside the viewed time window
  const pa = cylinder(a.event.t, centerAngle(sa)), pb = cylinder(b.event.t, centerAngle(sb));
  const mid = [(pa[0] + pb[0]) * .9, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) * .9 + 120];
  const curve = []; for (let k = 0; k <= 50; k++) { const t = k / 50; curve.push(project(pa.map((v, j) => (1 - t) ** 2 * v + 2 * (1 - t) * t * mid[j] + t * t * pb[j]))); }
  const on = selectedWisdom === w;
  line(curve, '#a47837', on ? 2.6 : 1.3, [5, 5]);
  const end = curve[50], prev = curve[47], ang = Math.atan2(end.y - prev.y, end.x - prev.x);
  line([{ x: end.x - 8 * Math.cos(ang - .45), y: end.y - 8 * Math.sin(ang - .45) }, end, { x: end.x - 8 * Math.cos(ang + .45), y: end.y - 8 * Math.sin(ang + .45) }], '#a47837', 1.8);
  const anchor = curve[25], cw = Math.min(176, width - 24), ch = 44;
  const x = Math.max(12, Math.min(width - cw - 12, anchor.x - cw / 2)), y = Math.max(12, Math.min(height - ch - 30, anchor.y - ch / 2 + i * 50));
  ctx.fillStyle = on ? '#e9d7b6' : '#f8efdfe8'; ctx.strokeStyle = '#ad854b'; ctx.lineWidth = on ? 2 : 1;
  ctx.beginPath(); ctx.roundRect(x, y, cw, ch, 8); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#936825'; ctx.font = '10px system-ui'; ctx.fillText(`W${i + 1} · 跨故事经验 · 待确认`, x + 10, y + 16);
  ctx.fillStyle = '#574522'; ctx.font = '12px system-ui'; ctx.fillText(w.lesson, x + 10, y + 33);
  hits.push({ kind: 'wisdom', w, rect: [x, y, cw, ch] });
}

// ---- side panel ------------------------------------------------------------
const dateOf = t => new Date(range[0] + t * (range[1] - range[0]));
const pad2 = n => String(n).padStart(2, '0');
const fmt = t => { const d = dateOf(t); return `${d.getMonth() + 1}.${pad2(d.getDate())}`; };
const fmtTime = t => { const d = dateOf(t); return `${fmt(t)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
// Tick labels follow the grain: hours for sub-day turns, dates for daily turns, months beyond.
const fmtTick = t => win.turnHours < 24 ? fmtTime(t) : win.turnHours >= 720 ? `${dateOf(t).getFullYear()}.${dateOf(t).getMonth() + 1}` : fmt(t);
const turnName = h => ({ 3: '3 小时', 6: '6 小时', 12: '12 小时', 24: '1 天', 168: '1 周', 720: '1 个月', 2160: '1 个季度', 8760: '1 年' })[h] ?? `${h} 小时`;
const typeName = { decision: '决定', change: '变更', milestone: '里程碑', discussion: '讨论' };
function el(tag, props = {}, ...kids) { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; }
function setFocus(node) {
  focus = node; hovered = undefined; layout(level(), 0, tau); selectedEvent = undefined; selectedWisdom = undefined; selectedCluster = undefined; render();
  if (focus !== level()) face(focus); else if (mode === 'free') draw(); else animateTo({ ...VIEWS[mode], pan: 0 });
}
function render() {
  const crumbs = document.querySelector('#crumbs'); crumbs.replaceChildren();
  const trail = []; for (let n = focus; n; n = n.parent) trail.unshift(n);
  trail.forEach((n, i) => { if (i) crumbs.append(' › '); crumbs.append(i === trail.length - 1 ? el('strong', { textContent: n.name }) : el('button', { textContent: n.name, onclick: () => setFocus(n), className: 'crumb' })); });
  const levelName = ['全部项目', '项目木片', '功能木片', '子线索'][focus.depth];
  document.querySelector('#period').textContent = selectedWisdom ? '跨故事经验 · 模型归纳 · 待确认' : `${levelName} · ${fmt(focus.start)} – ${fmt(focus.end)}`;
  document.querySelector('#story-title').textContent = selectedWisdom ? selectedWisdom.lesson : focus.name;
  const desc = selectedWisdom ? '由真实图谱事件归纳，形成与应用都对应具体事件；需要用户确认后才作为经验使用。'
    : focus === root ? `${root.children.length} 个项目，${root.events.length} 个事件。木片越宽，事件越多；选择项目后拆分为功能。`
    : `${focus.events.length} 个事件 · ${focus.entities ?? focus.children.reduce((n, c) => n + (c.entities ?? 0), 0)} 个知识实体${focus.scattered ? ` · ${focus.scattered} 个零散实体未归入功能` : ''}${focus.unthreaded ? ` · ${focus.unthreaded} 个实体留在功能层` : ''}`;
  document.querySelector('#story-description').textContent = desc;
  const list = document.querySelector('#stories'); list.replaceChildren();
  if (!selectedWisdom) (focus.children ?? []).forEach(c => {
    const b = el('button', { onclick: () => setFocus(c), onmouseenter: () => { hovered = c; draw(); }, onmouseleave: () => { hovered = undefined; draw(); } },
      el('i'), el('span', { textContent: c.name }), el('small', { textContent: `${c.events.length} 事件 · ${fmt(c.start)}–${fmt(c.end)}${c.children?.length ? ` · ${c.children.length} 片` : ''}` }));
    b.style.setProperty('--story-color', colorOf(c)); list.append(b);
  });
  const events = document.querySelector('#events'); events.replaceChildren();
  const detail = document.querySelector('#detail'); detail.replaceChildren();
  if (selectedWisdom) {
    [['适用条件', selectedWisdom.conditions], ['边界', selectedWisdom.boundary], ['形成与应用依据', selectedWisdom.why]].forEach(([h, p]) => detail.append(el('section', {}, el('strong', { textContent: h }), el('p', { textContent: p }))));
    [['形成', selectedWisdom.formedIn], ['应用', selectedWisdom.appliedIn]].forEach(([label, ids]) => ids.forEach(id => {
      const s = staveFor(id); if (!s) return;
      detail.append(el('button', { className: 'jump', textContent: `${label} · ${fmt(s.event.t)} · ${s.node.name}`, onclick: () => { setFocus(s.node); selectEvent(s.event); } }));
    }));
  } else if (focus.depth >= 2) {
    const detailed = projectOf(focus).detailed;
    // The list follows the viewed window; an opened cluster narrows it to that cluster's events.
    const listed = (selectedCluster ? selectedCluster.events : focus.events.filter(e => inWindow(e.t))).slice().reverse();
    if (selectedCluster) events.append(el('div', { className: 'cluster-head' }, el('span', { textContent: `${fmtSpan(selectedCluster)} · ${selectedCluster.n} 个事件` }), el('button', { className: 'crumb', textContent: '显示全部', onclick: () => { selectedCluster = undefined; render(); } })));
    listed.slice(0, 60).forEach(e => events.append(el('button', { 'aria-pressed': String(e === selectedEvent), onclick: () => selectEvent(e) },
      el('span', { textContent: detailed ? e.title : `${typeName[e.type]}事件` }), el('small', { textContent: `${fmtTime(e.t)} · ${typeName[e.type]}` }))));
    if (listed.length > 60) events.append(el('small', { textContent: `另有 ${listed.length - 60} 个更早的事件` }));
    if (!listed.length) events.append(el('small', { textContent: '这段时间没有该故事的事件' }));
    if (selectedEvent) detail.append(el('strong', { textContent: detailed ? selectedEvent.title : '该项目只显示时间与类型' }), el('p', { textContent: detailed ? selectedEvent.text : '' }), el('small', { textContent: new Date(selectedEvent.at).toLocaleString('zh-CN') }));
  }
  document.querySelector('#wisdom-list').replaceChildren(...data.wisdom.map((w, i) => el('button', { className: 'wisdom-card', 'aria-pressed': String(selectedWisdom === w), onclick: () => { selectedWisdom = w; showWisdom.checked = true; render(); } },
    el('span', { textContent: `W${i + 1} · 跨故事经验 · 待确认` }), el('strong', { textContent: w.lesson }))));
  draw();
}
function selectEvent(e) {
  if (!inWindow(e.t)) { selectedCluster = undefined; applyRange('all'); }
  selectedEvent = e; render(); if (mode !== 'free') animateTo({ pan: yOf(e.t) * .5 });
}
// A single event opens directly. A cluster zooms the window into its time span so it splits apart;
// when it cannot split further (same moment) the list narrows to its events instead.
function openCluster(c) {
  if (c.n === 1) { selectedCluster = undefined; selectEvent(c.events[0]); return; }
  const span = c.t1 - c.t0, minSpan = 6 / totalHours; // never zoom below ~6 hours
  if (win.t1 - win.t0 > minSpan * 1.01 && span > 0) {
    const pad = Math.max(span * .6, minSpan / 2), mid = (c.t0 + c.t1) / 2, half = Math.max(span / 2 + pad, minSpan / 2);
    selectedCluster = undefined; zoomWindow(mid - half, mid + half);
  } else { selectedCluster = c; selectedEvent = undefined; render(); }
}

// ---- time window and grain ---------------------------------------------------------
const rangeSelect = document.querySelector('#range'), turnSelect = document.querySelector('#turn'), rangeReset = document.querySelector('#range-reset');
let selectedCluster;
function applyWindow(t0, t1) {
  const fixed = turnSelect.value === 'auto' ? undefined : Number(turnSelect.value);
  setWindow(t0, t1, fixed);
  if (fixed && win.turnHours !== fixed) turnSelect.value = 'auto'; // the chosen turn would make the helix unreadable
  document.querySelector('#scale-note').textContent = `高度为时间，一圈 ${turnName(win.turnHours)}（共 ${Math.round(turns * 10) / 10} 圈）· 半径为当时的对话密度`;
  document.querySelector('#axis-start').textContent = win.turnHours < 24 ? fmtTime(win.t0) : fmt(win.t0);
  document.querySelector('#axis-end').textContent = win.turnHours < 24 ? fmtTime(win.t1) : fmt(win.t1);
  rangeReset.hidden = win.t0 <= 0 && win.t1 >= 1;
}
function zoomWindow(t0, t1) {
  const len = t1 - t0;
  if (t0 < 0) { t0 = 0; t1 = Math.min(1, len); } if (t1 > 1) { t1 = 1; t0 = Math.max(0, 1 - len); }
  rangeSelect.value = 'custom';
  applyWindow(t0, t1); render(); if (mode !== 'free') animateTo({ pan: 0 });
}
function applyRange(value) {
  rangeSelect.value = value;
  if (value === 'all') applyWindow(0, 1); else if (value !== 'custom') { const h = Number(value); applyWindow(Math.max(0, 1 - h / totalHours), 1); }
}
rangeSelect.addEventListener('change', () => { selectedCluster = undefined; applyRange(rangeSelect.value); render(); });
turnSelect.addEventListener('change', () => { applyWindow(win.t0, win.t1); render(); });
rangeReset.addEventListener('click', () => { selectedCluster = undefined; applyRange('all'); render(); });
applyRange('all');

// ---- input -----------------------------------------------------------------
const viewButtons = [...document.querySelectorAll('[data-view]')];
function syncViewButtons() { viewButtons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === mode))); }
function syncZoom() { zoom.value = String(Math.round(cam.zoom * 100)); }
viewButtons.forEach(b => b.addEventListener('click', () => {
  if (b.dataset.view === 'free') { freeView(); return; }
  animateTo({ ...VIEWS[b.dataset.view], zoom: 1, pan: 0 }, b.dataset.view);
}));
zoom.addEventListener('input', () => { tween = undefined; cam.zoom = Number(zoom.value) / 100; draw(); });
showWisdom.addEventListener('input', draw);
document.querySelector('#reset').onclick = () => animateTo({ ...VIEWS.oblique, zoom: 1, pan: 0 }, 'oblique');
const clampTilt = t => Math.max(-Math.PI / 2, Math.min(Math.PI / 2, t));
const clampPan = p => Math.max(-HEIGHT / 2, Math.min(HEIGHT / 2, p));
const clampZoom = z => Math.max(.5, Math.min(2.5, z));
function inPoly(x, y, poly) { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside; } return inside; }
const inRect = (x, y, r) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
function hitAt(x, y) {
  return hits.find(h => h.kind === 'wisdom' && inRect(x, y, h.rect))
    ?? hits.filter(h => h.kind === 'cluster' && Math.hypot(h.x - x, h.y - y) < h.r).sort((a, b) => b.z - a.z)[0]
    ?? hits.find(h => h.kind === 'label' && inRect(x, y, h.rect))
    ?? hits.filter(h => h.kind === 'stave' && inPoly(x, y, h.poly)).sort((a, b) => b.z - a.z)[0];
}
let drag;
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, pan: e.button === 2 || e.shiftKey };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  const r = canvas.getBoundingClientRect();
  if (!drag) {
    const h = hitAt(e.clientX - r.left, e.clientY - r.top), node = h && (h.kind === 'stave' || h.kind === 'label') ? h.node : undefined;
    if (node !== hovered) { hovered = node; draw(); }
    canvas.style.cursor = h ? 'pointer' : '';
    return;
  }
  if (drag.id !== e.pointerId) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) >= 5) freeView();
  if (mode === 'free') {
    if (drag.pan) cam.pan = clampPan(cam.pan + dy / (Math.min(width / 500, height / 560) * cam.zoom));
    else { cam.yaw += dx * .008; cam.tilt = clampTilt(cam.tilt + dy * .006); }
    draw();
  }
  drag.x = e.clientX; drag.y = e.clientY;
});
canvas.addEventListener('pointerup', e => {
  if (drag && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) {
    const r = canvas.getBoundingClientRect(), h = hitAt(e.clientX - r.left, e.clientY - r.top);
    if (h?.kind === 'wisdom') { selectedWisdom = h.w; render(); }
    else if (h?.kind === 'cluster') openCluster(h.cluster);
    else if (h) setFocus(h.node);
  }
  drag = undefined;
});
canvas.addEventListener('pointercancel', () => { drag = undefined; });
canvas.addEventListener('pointerleave', () => { if (!drag && hovered) { hovered = undefined; draw(); } });
canvas.addEventListener('wheel', e => {
  e.preventDefault(); freeView();
  if (e.shiftKey) cam.pan = clampPan(cam.pan - e.deltaY * .3);
  else cam.zoom = clampZoom(cam.zoom * Math.exp(-e.deltaY * .0012));
  syncZoom(); draw();
}, { passive: false });
canvas.addEventListener('keydown', e => {
  if (e.key === 'Escape' && focus.parent) { setFocus(focus.parent); return; }
  const preset = { 1: 'oblique', 2: 'side', 3: 'top' }[e.key];
  if (preset) { animateTo({ ...VIEWS[preset], zoom: 1, pan: 0 }, preset); return; }
  const moves = { ArrowLeft: () => { cam.yaw -= .12; }, ArrowRight: () => { cam.yaw += .12; }, ArrowUp: () => { cam.tilt = clampTilt(cam.tilt + .06); }, ArrowDown: () => { cam.tilt = clampTilt(cam.tilt - .06); },
    PageUp: () => { cam.pan = clampPan(cam.pan + 20); }, PageDown: () => { cam.pan = clampPan(cam.pan - 20); }, '+': () => { cam.zoom = clampZoom(cam.zoom * 1.1); }, '=': () => { cam.zoom = clampZoom(cam.zoom * 1.1); }, '-': () => { cam.zoom = clampZoom(cam.zoom / 1.1); } };
  if (!moves[e.key]) return;
  e.preventDefault(); freeView(); moves[e.key](); syncZoom(); draw();
});
new ResizeObserver(() => { const r = canvas.getBoundingClientRect(); width = r.width; height = r.height; const dpr = Math.min(devicePixelRatio || 1, 2); canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); draw(); }).observe(canvas);
// Read-only hook for layout checks.
window.storyDemo = { cam, win, get turns() { return turns; }, get mode() { return mode; }, get focus() { return focus.name; },
  clustersOf: name => { const find = n => n.name === name ? n : (n.children ?? []).map(find).find(Boolean); const n = find(root); return n ? clusters(n.events).map(c => c.n) : []; },
  clusterHits: () => hits.filter(h => h.kind === 'cluster').map(h => ({ n: h.cluster.n, x: Math.round(h.x), y: Math.round(h.y) })),
  setWindow: (t0, t1) => zoomWindow(t0, t1), simulateSpan: hours => { const t = totalHours; return { hours, turnHours: autoTurnHours(hours), turns: hours / autoTurnHours(hours), total: t }; }, setFocusByName: name => { const find = n => n.name === name ? n : (n.children ?? []).map(find).find(Boolean); const n = find(root); if (n) setFocus(n); return !!n; } };
syncViewButtons(); syncZoom();
render();
