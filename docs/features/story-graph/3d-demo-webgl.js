/* 3D Story Graph prototype on a real export, rendered with WebGL (Three.js r160, vendor/three.min.js).
 * Same model as 3d-demo.js: height = time (uniform), helix radius = attention density, staves on a fixed outer
 * cylinder at stable angles, events joined to their stave at the same height. The GPU depth buffer handles
 * occlusion; names, counts and experience cards are drawn on a 2D overlay. Falls back to 3d-demo.js without WebGL. */
(() => {
const canvas = document.querySelector('#scene');
let renderer;
try {
  if (!window.THREE) throw new Error('three.js missing');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
} catch {
  const fallback = document.createElement('script'); fallback.src = '3d-demo.js'; document.body.append(fallback);
  document.querySelector('#renderer-note')?.replaceChildren('Canvas 渲染');
  return;
}
const data = window.STORY_DATA;
const overlay = document.querySelector('#overlay');
const ctx = overlay.getContext('2d');
const tau = Math.PI * 2;
const palette = ['#367e70', '#bb8743', '#8675a6', '#b5604f', '#4f7fa8', '#7a8f3b', '#a35d86', '#3f8f97', '#9a7a55', '#5f6fb0', '#c07a3a', '#6b8d6f'];
const range = data.range.map(d => Date.parse(d + 'T00:00:00+08:00'));
const totalHours = (range[1] - range[0]) / 3600000;
const zoom = document.querySelector('#zoom');
const showWisdom = document.querySelector('#wisdom');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const BG = 0xfcfcf8;

// ---- model ---------------------------------------------------------------
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
  if (depth === 2 && !node.ref) node.events.forEach(e => eventIndex.set(e.id, { event: e, feature: node }));
}
finish(root, undefined, 0);
const projects = root.children;
projects.forEach((p, i) => { p.color = palette[i % palette.length]; });
// Cross-project stories (off by default): grouped from real feature names across projects. Their events still
// belong to the original project features; a cross-project stave only associates them.
const CROSS = [
  ['果蝇神经仿真', [['goodbuddy', '果蝇脑仿真'], ['微信 ClawBot', '果蝇开源调研'], ['微信 ClawBot', '脉冲脑模型'], ['微信 ClawBot', '视觉模型'], ['微信 ClawBot', '运动仿真']]],
  ['Agent 运行环境', [['goodbuddy', '远程Agent运行时'], ['goodbuddy', '模型与运行时'], ['dgx', 'Ollama 配置'], ['dgx', 'OCR 显存预留'], ['dgx', 'GBAgent 清理'], ['dgx', 'Agent 运行错误']]],
  ['国内服务器部署', [['默认项目', '国内节点隐藏IP'], ['阿里云-国内', '阿里云-国内']]],
];
const crossStories = CROSS.map(([name, members], i) => {
  const children = members.map(([p, f]) => projects.find(x => x.name === p)?.children.find(x => x.name === f)).filter(Boolean)
    .map(ref => ({ name: `${ref.parent.name} · ${ref.name}`, ref, entities: ref.entities, events: ref.events, children: [] }));
  return { name, cross: true, color: palette[(projects.length + i * 2) % palette.length], children };
});
const crossToggle = document.querySelector('#cross');
const projectOfEvent = id => eventIndex.get(id)?.feature.parent;
const visibleWisdom = () => data.wisdom.filter(w => crossToggle.checked || projectOfEvent(w.formedIn[0]) === projectOfEvent(w.appliedIn.at(-1)));
function setCrossProject(on) {
  root.children = on ? [...projects, ...crossStories] : projects;
  root.events = undefined;
  finish(root, undefined, 0);
}
let focus = root, selectedEvent, selectedWisdom, selectedCluster, hovered;
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
const HEIGHT = 430, STAVE_R = 188, WISDOM_R = 262, FLOOR = -HEIGHT / 2 - 34;
const TURN_STEPS = [3, 6, 12, 24, 168, 720, 2160, 8760];
const TARGET_TURNS = 8, MAX_TURNS = 14;
const win = { t0: 0, t1: 1, turnHours: 24 };
let turns = 8, bins = [], binMax = 1, smoothR = [];
const hoursOf = t => t * totalHours;
const clamp01 = t => Math.max(0, Math.min(1, t));
const inWindow = t => t >= win.t0 - 1e-9 && t <= win.t1 + 1e-9;
const uOf = t => (t - win.t0) / (win.t1 - win.t0);
const tAt = u => win.t0 + u * (win.t1 - win.t0);
function autoTurnHours(spanHours) { return TURN_STEPS.find(h => spanHours / h <= TARGET_TURNS) ?? TURN_STEPS.at(-1); }
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
  // One radius per turn, from that turn's attention density, eased between turn centres with a cosine. Each
  // turn reads as a circle; the helix swells or narrows only from turn to turn.
  const n = Math.max(1, Math.ceil(turns - 1e-6)), perTurn = new Array(n).fill(0);
  bins.forEach((v, i) => { perTurn[Math.min(n - 1, Math.floor((i + .5) / bins.length * turns))] += v; });
  const top = Math.max(1e-6, ...perTurn), level = perTurn.map(v => Math.sqrt(v / top)); // sqrt keeps quiet turns visible
  // Neighbouring turns differ by at most MAX_STEP of the radius range, so the coil never jumps between turns.
  for (let pass = 0; pass < n; pass++) for (let d = 1; d < n; d++) {
    if (level[d] - level[d - 1] > MAX_STEP) level[d - 1] = level[d] - MAX_STEP;
    if (level[d - 1] - level[d] > MAX_STEP) level[d] = level[d - 1] - MAX_STEP;
  }
  // Each turn holds its radius (a circle) and changes only in a short eased zone around the turn boundary.
  smoothR = Array.from({ length: R_SAMPLES + 1 }, (_, i) => {
    const x = i / R_SAMPLES * turns, d = Math.min(n - 1, Math.floor(x)), f = x - d;
    const half = TRANSITION / 2;
    if (f < half && d > 0) { const k = (f + half) / TRANSITION; return level[d - 1] + (level[d] - level[d - 1]) * (1 - Math.cos(k * Math.PI)) / 2; }
    if (f > 1 - half && d < n - 1) { const k = (f - 1 + half) / TRANSITION; return level[d] + (level[d + 1] - level[d]) * (1 - Math.cos(k * Math.PI)) / 2; }
    return level[d];
  });
}
const MAX_STEP = .22, TRANSITION = .3;
const R_SAMPLES = 600;
function density(u) {
  const x = u * bins.length - .5, i = Math.floor(x), f = x - i, at = j => bins[Math.max(0, Math.min(bins.length - 1, j))] / binMax;
  return at(i) * (1 - f) + at(i + 1) * f;
}
// Interpolated, never stepped, so the tube stays a smooth curve.
const radius = t => { const x = clamp01(uOf(t)) * R_SAMPLES, i = Math.floor(x), f = x - i; return 78 + 74 * (smoothR[i] * (1 - f) + smoothR[Math.min(R_SAMPLES, i + 1)] * f); };
const yOf = t => (uOf(t) - .5) * HEIGHT;
const helixAngle = t => uOf(t) * turns * tau;
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const helixPoint = t => { const r = radius(t), a = helixAngle(t); return V(r * Math.cos(a), yOf(t), r * Math.sin(a)); };
const cylinder = (t, a, r = STAVE_R) => V(r * Math.cos(a), yOf(t), r * Math.sin(a));
const centerAngle = node => (node.a0 + node.a1) / 2;

// ---- scene -------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 700, 1250); // far geometry fades toward the paper colour instead of gaining outlines
scene.add(new THREE.HemisphereLight(0xffffff, 0xc9cfc4, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(-300, 500, 400); scene.add(sun);
const camera = new THREE.PerspectiveCamera(30, 1, 10, 4000);
let world = new THREE.Group(); scene.add(world);
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
const raycaster = new THREE.Raycaster();

// ---- camera ------------------------------------------------------------------
const VIEWS = { oblique: { yaw: -.4, tilt: .38 }, side: { tilt: 0 }, top: { tilt: Math.PI / 2 - 1e-3 } };
const cam = { yaw: -.4, tilt: .38, zoom: 1, pan: 0 };
let mode = 'oblique', tween, width = 0, height = 0;
const DIST = 900;
function placeCamera() {
  const { yaw, tilt } = cam, ct = Math.cos(tilt), st = Math.sin(tilt);
  const target = V(0, cam.pan, 0);
  camera.position.copy(target).add(V(-Math.sin(yaw) * ct, st, Math.cos(yaw) * ct).multiplyScalar(DIST));
  camera.up.set(Math.sin(yaw) * st, ct, -Math.cos(yaw) * st);
  camera.lookAt(target);
  // Same framing as the Canvas version: at zoom 1 the 500 × 560 box fits the viewport.
  const visibleHeight = height / Math.min(width / 500, height / 560);
  camera.fov = 2 * Math.atan(visibleHeight / 2 / DIST) * 180 / Math.PI;
  camera.aspect = width / height; camera.zoom = cam.zoom; camera.updateProjectionMatrix();
}
function project(p) {
  const v = p.clone().project(camera);
  return { x: (v.x + 1) / 2 * width, y: (1 - v.y) / 2 * height, z: -v.z, behind: v.z > 1 };
}
const viewDir = () => camera.position.clone().sub(V(0, cam.pan, 0)).normalize();
const shortest = (from, to) => from + ((((to - from) % tau) + tau * 1.5) % tau - Math.PI);
function animateTo(target, nextMode = mode) {
  mode = nextMode; syncViewButtons();
  const goal = { ...cam, ...target };
  goal.yaw = shortest(cam.yaw, goal.yaw);
  if (reducedMotion) { Object.assign(cam, goal); syncZoom(); draw(); return; }
  const from = { ...cam }, started = performance.now();
  tween = { started };
  const step = now => {
    if (tween?.started !== started) return;
    const k = Math.min(1, (now - started) / 480), e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    for (const key of ['yaw', 'tilt', 'zoom', 'pan']) cam[key] = from[key] + (goal[key] - from[key]) * e;
    syncZoom(); draw();
    if (k < 1) requestAnimationFrame(step); else tween = undefined;
  };
  requestAnimationFrame(step);
}
function face(node) { if (node && node.depth > 0) animateTo({ yaw: centerAngle(node) - Math.PI / 2, pan: (yOf(Math.max(win.t0, node.start)) + yOf(Math.min(win.t1, node.end))) / 2 * .35 }); }
function freeView() { tween = undefined; if (mode !== 'free') { mode = 'free'; syncViewButtons(); } }

// ---- colour ------------------------------------------------------------------
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
function connected() { return visibleStaves().filter(s => (focus !== level() && s === focus) || s === hovered); }

// ---- clustering --------------------------------------------------------------
const CLUSTER_PX = 9;
function scaleNow() { return Math.min(width / 500, height / 560) * cam.zoom; }
// Quantised to quarter-octaves so zooming re-clusters in steps rather than rebuilding geometry every frame.
function clusterSpan() { const raw = CLUSTER_PX / (HEIGHT * scaleNow()) * (win.t1 - win.t0); return 2 ** (Math.round(Math.log2(raw) * 4) / 4); }
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

// ---- building geometry -----------------------------------------------------------
// The scene is rebuilt only when what it shows changes; camera moves just re-render and redraw the overlay.
const mats = new Map();
function mat(key, make) { if (!mats.has(key)) mats.set(key, make()); return mats.get(key); }
const solid = (color, opacity = 1) => mat(`s${color}${opacity}`, () => new THREE.MeshStandardMaterial({ color, roughness: .65, metalness: 0, transparent: opacity < 1, opacity }));
const flat = (color, opacity) => mat(`f${color}${opacity}`, () => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
const lineMat = (color, opacity) => mat(`l${color}${opacity}`, () => new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
function tube(points, r, material, segments) {
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.Mesh(new THREE.TubeGeometry(curve, segments ?? Math.max(8, points.length * 2), r, 8, false), material);
}
function polyline(points, material) { return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material); }
let built = '', baseBuilt = '', staveMeshes = [], baseTicks = [], overlayItems = { labels: [], clusters: [], wisdom: [] };
let base = new THREE.Group(); scene.add(base);
let split; // in-place split / merge animation of staves between levels
function signature() {
  return JSON.stringify([focus.name, focus.depth, hovered?.name, selectedEvent?.id, selectedWisdom?.lesson, win.t0, win.t1, win.turnHours, showWisdom.checked, clusterSpan(), split ? split.k.toFixed(3) : '']);
}
const dispose = group => group.traverse(o => o.geometry?.dispose());
// Geometry that depends only on the time window: floor, the grey helix and its turn ticks.
function rebuildBase() {
  scene.remove(base); dispose(base); base = new THREE.Group(); scene.add(base); baseTicks = [];
  const ring = []; for (let i = 0; i <= 96; i++) { const a = i / 96 * tau; ring.push(V(STAVE_R * Math.cos(a), FLOOR, STAVE_R * Math.sin(a))); }
  base.add(polyline(ring, lineMat('#9aa69c', .35)));
  const shadow = []; for (let i = 0; i <= 900; i++) { const p = helixPoint(tAt(i / 900)); p.y = FLOOR; shadow.push(p); }
  base.add(tube(shadow, 1.4, flat('#8e9a90', .14), 900));
  const helix = []; for (let i = 0; i <= 1400; i++) helix.push(helixPoint(tAt(i / 1400)));
  base.add(tube(helix, 1.1, solid('#7d8a84'), 2800));
  const every = Math.max(1, Math.ceil(turns / 10));
  for (let d = 0; d <= Math.floor(turns + 1e-6); d++) {
    const t = tAt(d / turns), p = helixPoint(t);
    const tick = new THREE.Mesh(new THREE.SphereGeometry(2.2, 10, 8), solid('#3f514a')); tick.position.copy(p); base.add(tick);
    if (d % every === 0 && d / turns < .999) baseTicks.push({ at: p, text: fmtTick(t) });
  }
  baseBuilt = JSON.stringify([win.t0, win.t1, win.turnHours]);
}
function rebuild() {
  if (baseBuilt !== JSON.stringify([win.t0, win.t1, win.turnHours])) rebuildBase();
  scene.remove(world); dispose(world);
  world = new THREE.Group(); scene.add(world);
  staveMeshes = []; overlayItems = { labels: [], clusters: [], wisdom: [] };
  const staves = visibleStaves().filter(s => s.events.some(e => inWindow(e.t)) && s.a1 - s.a0 > 1e-3), links = split ? [] : connected();
  const cl = new Map(staves.map(s => [s, clusters(s.events)]));
  // Spans of the helix owned by visible stories are overlaid in the story colour.
  const owner = new Array(600).fill(undefined);
  staves.filter(s => emphasisOf(s) !== 'dim').forEach(s => cl.get(s).forEach(c => {
    const i0 = Math.round(uOf(c.t0) * 599), i1 = Math.round(uOf(c.t1) * 599);
    for (let i = i0 - 1; i <= i1 + 1; i++) if (i >= 0 && i < 600 && owner[i] === undefined) owner[i] = colorOf(s);
  }));
  for (let i = 0; i < 600;) {
    const c = owner[i]; let j = i; while (j + 1 < 600 && owner[j + 1] === c) j++;
    if (c) { const pts = []; const steps = Math.max(2, (j - i + 1) * 3); for (let k = 0; k <= steps; k++) pts.push(helixPoint(tAt((i + (j + 1 - i) * k / steps) / 600))); world.add(tube(pts, 2.2, solid(c), steps * 2)); }
    i = j + 1;
  }

  // Staves: curved strips of the outer cylinder, from the story's first to last event in the window.
  staves.forEach(s => {
    const em = emphasisOf(s), color = colorOf(s), gap = Math.min(.014, (s.a1 - s.a0) * .08);
    const inside = s.events.filter(e => inWindow(e.t)), pad = (win.t1 - win.t0) * .006;
    const a0 = s.a0 + gap, a1 = Math.max(s.a0 + gap + 1e-3, s.a1 - gap);
    const t0 = Math.max(win.t0, inside[0].t - pad), t1 = Math.min(win.t1, inside.at(-1).t + pad);
    const segs = Math.max(2, Math.ceil((a1 - a0) / .05));
    const geo = new THREE.BufferGeometry(), pos = [], idx = [];
    for (let j = 0; j <= segs; j++) { const a = a0 + (a1 - a0) * j / segs; const lo = cylinder(t0, a), hi = cylinder(t1, a); pos.push(lo.x, lo.y, lo.z, hi.x, hi.y, hi.z); }
    for (let j = 0; j < segs; j++) { const k = j * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
    const opacity = em === 'focus' ? .3 : em === 'dim' ? .05 : .15;
    const mesh = new THREE.Mesh(geo, flat(color, opacity)); mesh.userData.node = s; mesh.renderOrder = 1;
    world.add(mesh); staveMeshes.push(mesh);
    if (em !== 'dim') [a0, a1].forEach(a => world.add(polyline([cylinder(t0, a), cylinder(t1, a)], lineMat(color, .7))));
    // One band per cluster, thicker for more events; quiet periods stay as gaps.
    cl.get(s).forEach(c => {
      const arc = []; for (let i = 0; i <= 10; i++) arc.push(cylinder(c.t, a0 + (a1 - a0) * i / 10, STAVE_R + .6));
      const active = c.events.includes(selectedEvent);
      const r = (Math.min(6, 1.3 + Math.log2(c.n) * 1.1) + (active ? 2 : 0)) * .45;
      world.add(tube(arc, r, solid(color, em === 'dim' ? .3 : .9), 20));
    });
    overlayItems.labels.push({ node: s, at: cylinder(t1, centerAngle(s), STAVE_R + 2), angle: centerAngle(s) });
  });

  // Connectors: helix -> stave at the same height, one per cluster.
  links.filter(s => cl.has(s)).forEach(s => {
    const color = colorOf(s), a = centerAngle(s);
    cl.get(s).forEach(c => {
      const p = helixPoint(c.t), q = cylinder(c.t, a), active = c.events.includes(selectedEvent);
      world.add(tube([p, q], active ? .9 : .5, solid(color, active ? 1 : .6), 2));
      const r = c.n === 1 ? (active ? 5.5 : 3.6) : Math.min(10, 5.5 + Math.log2(c.n) * 1.3);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(r * .6, 16, 12), solid(color)); dot.position.copy(p); world.add(dot);
      if (active) { const halo = new THREE.Mesh(new THREE.TorusGeometry(r * .6 + 2, .5, 6, 32), solid('#273b36')); halo.position.copy(p); halo.lookAt(camera.position); world.add(halo); }
      overlayItems.clusters.push({ cluster: c, node: s, at: p, r, clickable: focus.depth >= 2 || s === focus });
    });
  });

  // Experience: a node on a ring outside the barrel. The forming stave reaches out to it, and an arrow
  // runs from it to the applying stave, so the arc never crosses the helix inside.
  if (showWisdom.checked && !split) visibleWisdom().forEach((w, i) => {
    const a = staveFor(w.formedIn[0]), b = staveFor(w.appliedIn.at(-1)); if (!a || !b) return;
    const sa = shown(a.node), sb = shown(b.node); if (!sa || !sb || sa === sb) return;
    if (!inWindow(a.event.t) || !inWindow(b.event.t)) return;
    const aa = centerAngle(sa), ab = centerAngle(sb), pa = cylinder(a.event.t, aa), pb = cylinder(b.event.t, ab);
    const mean = Math.atan2(Math.sin(aa) + Math.sin(ab), Math.cos(aa) + Math.cos(ab));
    const node = cylinder((a.event.t + b.event.t) / 2, mean, WISDOM_R), on = selectedWisdom === w;
    const leg = (from, to, k) => { const c = from.clone().add(to).multiplyScalar(.5); const out = V(c.x, 0, c.z); if (out.length() > 1) c.add(out.normalize().multiplyScalar(k)); return new THREE.QuadraticBezierCurve3(from, c, to); };
    const formed = leg(pa, node, 34), applied = leg(node, pb, 34);
    [formed, applied].forEach(curve => {
      const dashed = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)), mat('wd', () => new THREE.LineDashedMaterial({ color: 0xa47837, dashSize: 7, gapSize: 5 })));
      dashed.computeLineDistances(); world.add(dashed);
      if (on) world.add(tube(curve.getPoints(40), .8, solid('#a47837', .5), 40));
    });
    const tip = applied.getPoint(1), dir = tip.clone().sub(applied.getPoint(.94)).normalize();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(3.5, 10, 12), solid('#a47837')); cone.position.copy(tip).sub(dir.clone().multiplyScalar(5));
    cone.quaternion.setFromUnitVectors(V(0, 1, 0), dir); world.add(cone);
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(on ? 9 : 7), solid(on ? '#c08a3e' : '#d2a35e')); gem.position.copy(node); world.add(gem);
    overlayItems.wisdom.push({ w, i, at: node });
  });
  built = signature();
}
function staveFor(eventId) { const hit = eventIndex.get(eventId); if (!hit) return; const sub = hit.feature.children.find(s => s.events.some(e => e.id === eventId)); return { event: hit.event, node: sub ?? hit.feature }; }

// ---- frame -----------------------------------------------------------------------
let hits = [];
function draw() {
  if (!width) return;
  placeCamera();
  if (signature() !== built) rebuild();
  renderer.render(scene, camera);
  ctx.clearRect(0, 0, width, height); hits = [];
  const v = viewDir();
  ctx.font = '10px system-ui'; ctx.fillStyle = '#3f514a';
  baseTicks.forEach(t => { const p = project(t.at); if (!p.behind) ctx.fillText(t.text, p.x + 6, p.y + 3); });
  overlayItems.clusters.forEach(c => {
    const p = project(c.at); if (p.behind) return;
    if (c.cluster.n > 1) { ctx.fillStyle = '#fcfcf8'; ctx.font = '600 9px system-ui'; const label = String(c.cluster.n); ctx.fillText(label, p.x - ctx.measureText(label).width / 2, p.y + 3); }
    if (c.clickable) hits.push({ kind: 'cluster', cluster: c.cluster, node: c.node, x: p.x, y: p.y, r: Math.max(9, c.r + 2), z: p.z });
  });
  drawLabels(v);
  overlayItems.wisdom.forEach(w => drawWisdomCard(w));
}
// Labels: the focused or hovered stave always; otherwise only staves facing the viewer, without overlaps.
function drawLabels(v) {
  const placed = [];
  overlayItems.labels.map(l => ({ ...l, facing: Math.cos(l.angle) * v.x + Math.sin(l.angle) * v.z, em: emphasisOf(l.node) }))
    .sort((a, b) => (b.em === 'focus') - (a.em === 'focus') || b.facing - a.facing)
    .forEach(({ node: s, at, facing, em }) => {
      if (em === 'dim' || (em !== 'focus' && facing < -.05)) return;
      const p = project(at); if (p.behind) return;
      ctx.font = (em === 'focus' ? '600 ' : '') + '11px system-ui';
      const w = ctx.measureText(s.name).width, x = p.x - w / 2, y = p.y - 8, box = [x - 4, y - 12, w + 8, 16];
      if (placed.some(b => box[0] < b[0] + b[2] && b[0] < box[0] + box[2] && box[1] < b[1] + b[3] && b[1] < box[1] + box[3])) return;
      placed.push(box);
      ctx.fillStyle = 'rgba(252,252,248,.85)'; ctx.fillRect(...box);
      ctx.fillStyle = colorOf(s); ctx.globalAlpha = em === 'focus' ? 1 : .55 + .45 * Math.max(0, facing); ctx.fillText(s.name, x, y); ctx.globalAlpha = 1;
      hits.push({ kind: 'label', node: s, rect: box });
    });
}
function drawWisdomCard({ w, i, at }) {
  const anchor = project(at), on = selectedWisdom === w, cw = Math.min(176, width - 24), ch = 44;
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
const fmtTick = t => win.turnHours < 24 ? fmtTime(t) : win.turnHours >= 720 ? `${dateOf(t).getFullYear()}.${dateOf(t).getMonth() + 1}` : fmt(t);
const turnName = h => ({ 3: '3 小时', 6: '6 小时', 12: '12 小时', 24: '1 天', 168: '1 周', 720: '1 个月', 2160: '1 个季度', 8760: '1 年' })[h] ?? `${h} 小时`;
const typeName = { decision: '决定', change: '变更', milestone: '里程碑', discussion: '讨论' };
function el(tag, props = {}, ...kids) { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; }
// Staves split in place when opening a level and merge back when returning, instead of jumping to a new layout.
function planSplit(oldLevel, newLevel) {
  const kids = newLevel.children ?? [], to = new Map(kids.map(k => [k, [k.a0, k.a1]]));
  let from;
  if (newLevel.parent === oldLevel) { // opening: children start inside the opened stave's old sector
    const [c0, c1] = oldAngles.get(newLevel) ?? [0, tau], f = (c1 - c0) / tau;
    from = new Map(kids.map(k => [k, [c0 + k.a0 * f, c0 + k.a1 * f]]));
  } else if (oldLevel?.parent === newLevel) { // returning: the stave we came from starts as the whole circle
    const [x0, x1] = to.get(oldLevel);
    from = new Map(kids.map(k => [k, k === oldLevel ? [0, tau] : k.a0 < x0 ? [0, 0] : [tau, tau]]));
  }
  return from && { from, to };
}
let oldAngles = new Map();
function runSplit(plan) {
  if (!plan || reducedMotion) return;
  const started = performance.now(), apply = k => plan.to.forEach(([b0, b1], node) => { const [a0, a1] = plan.from.get(node); node.a0 = a0 + (b0 - a0) * k; node.a1 = a1 + (b1 - a1) * k; });
  split = { k: 0, started }; apply(0);
  const step = now => {
    if (split?.started !== started) return;
    const t = Math.min(1, (now - started) / 520), k = t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    split.k = k; apply(k);
    if (t < 1) { draw(); requestAnimationFrame(step); } else { split = undefined; draw(); }
  };
  requestAnimationFrame(step);
}
function setFocus(node) {
  const oldLevel = level();
  oldAngles = new Map((oldLevel.children ?? []).map(k => [k, [k.a0, k.a1]]));
  focus = node; hovered = undefined; layout(level(), 0, tau); selectedEvent = undefined; selectedWisdom = undefined; selectedCluster = undefined;
  const plan = level() !== oldLevel ? planSplit(oldLevel, level()) : undefined;
  runSplit(plan);
  render();
  if (focus !== level()) face(focus); else if (mode === 'free') draw(); else animateTo({ ...VIEWS[mode], pan: 0 });
}
function render() {
  const crumbs = document.querySelector('#crumbs'); crumbs.replaceChildren();
  const trail = []; for (let n = focus; n; n = n.parent) trail.unshift(n);
  trail.forEach((n, i) => { if (i) crumbs.append(' › '); crumbs.append(i === trail.length - 1 ? el('strong', { textContent: n.name }) : el('button', { textContent: n.name, onclick: () => setFocus(n), className: 'crumb' })); });
  const levelName = focus.cross ? '跨项目故事' : focus.ref ? '关联的项目功能' : ['全部项目', '项目木片', '功能木片', '子线索'][focus.depth];
  document.querySelector('#period').textContent = selectedWisdom ? '跨故事经验 · 模型归纳 · 待确认' : `${levelName} · ${fmt(focus.start)} – ${fmt(focus.end)}`;
  document.querySelector('#story-title').textContent = selectedWisdom ? selectedWisdom.lesson : focus.name;
  const desc = selectedWisdom ? '由真实图谱事件归纳，形成与应用都对应具体事件；需要用户确认后才作为经验使用。'
    : focus === root ? `${projects.length} 个项目，${root.events.length} 个事件${crossToggle.checked ? `，${crossStories.length} 条跨项目故事` : ''}。木片越宽，事件越多；选择项目后拆分为功能。`
    : focus.cross ? `关联 ${focus.children.length} 个项目功能、${focus.events.length} 个事件，跨越 ${new Set(focus.children.map(c => c.ref.parent.name)).size} 个项目。事件仍归属原项目，这里只做关联。`
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
    const detailed = (focus.ref?.parent ?? projectOf(focus)).detailed;
    const listed = (selectedCluster ? selectedCluster.events : focus.events.filter(e => inWindow(e.t))).slice().reverse();
    if (selectedCluster) events.append(el('div', { className: 'cluster-head' }, el('span', { textContent: `${fmtSpan(selectedCluster)} · ${selectedCluster.n} 个事件` }), el('button', { className: 'crumb', textContent: '显示全部', onclick: () => { selectedCluster = undefined; render(); } })));
    listed.slice(0, 60).forEach(e => events.append(el('button', { 'aria-pressed': String(e === selectedEvent), onclick: () => selectEvent(e) },
      el('span', { textContent: detailed ? e.title : `${typeName[e.type]}事件` }), el('small', { textContent: `${fmtTime(e.t)} · ${typeName[e.type]}` }))));
    if (listed.length > 60) events.append(el('small', { textContent: `另有 ${listed.length - 60} 个更早的事件` }));
    if (!listed.length) events.append(el('small', { textContent: '这段时间没有该故事的事件' }));
    if (selectedEvent) detail.append(el('strong', { textContent: detailed ? selectedEvent.title : '该项目只显示时间与类型' }), el('p', { textContent: detailed ? selectedEvent.text : '' }), el('small', { textContent: new Date(selectedEvent.at).toLocaleString('zh-CN') }));
  }
  document.querySelector('#wisdom-list').replaceChildren(...visibleWisdom().map((w, i) => el('button', { className: 'wisdom-card', 'aria-pressed': String(selectedWisdom === w), onclick: () => { selectedWisdom = w; showWisdom.checked = true; render(); } },
    el('span', { textContent: `W${i + 1} · 跨故事经验 · 待确认` }), el('strong', { textContent: w.lesson }))));
  draw();
}
function selectEvent(e) {
  if (!inWindow(e.t)) { selectedCluster = undefined; applyRange('all'); }
  selectedEvent = e; render(); if (mode !== 'free') animateTo({ pan: yOf(e.t) * .5 });
}
function openCluster(c) {
  if (c.n === 1) { selectedCluster = undefined; selectEvent(c.events[0]); return; }
  const span = c.t1 - c.t0, minSpan = 6 / totalHours;
  if (win.t1 - win.t0 > minSpan * 1.01 && span > 0) {
    const pad = Math.max(span * .6, minSpan / 2), mid = (c.t0 + c.t1) / 2, half = Math.max(span / 2 + pad, minSpan / 2);
    selectedCluster = undefined; zoomWindow(mid - half, mid + half);
  } else { selectedCluster = c; selectedEvent = undefined; render(); }
}

// ---- time window and grain ---------------------------------------------------------
const rangeSelect = document.querySelector('#range'), turnSelect = document.querySelector('#turn'), rangeReset = document.querySelector('#range-reset');
function applyWindow(t0, t1) {
  const fixed = turnSelect.value === 'auto' ? undefined : Number(turnSelect.value);
  setWindow(t0, t1, fixed);
  if (fixed && win.turnHours !== fixed) turnSelect.value = 'auto';
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
crossToggle.addEventListener('change', () => { setCrossProject(crossToggle.checked); focus = root; hovered = undefined; layout(root, 0, tau); selectedEvent = selectedWisdom = selectedCluster = undefined; render(); });
document.querySelector('#reset').onclick = () => animateTo({ ...VIEWS.oblique, zoom: 1, pan: 0 }, 'oblique');
const clampTilt = t => Math.max(-Math.PI / 2 + 1e-3, Math.min(Math.PI / 2 - 1e-3, t));
const clampPan = p => Math.max(-HEIGHT / 2, Math.min(HEIGHT / 2, p));
const clampZoom = z => Math.max(.5, Math.min(2.5, z));
const inRect = (x, y, r) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
function staveAt(x, y) {
  raycaster.setFromCamera(new THREE.Vector2(x / width * 2 - 1, 1 - y / height * 2), camera);
  const hit = raycaster.intersectObjects(staveMeshes, false)[0];
  return hit && { kind: 'stave', node: hit.object.userData.node };
}
function hitAt(x, y) {
  return hits.find(h => h.kind === 'wisdom' && inRect(x, y, h.rect))
    ?? hits.filter(h => h.kind === 'cluster' && Math.hypot(h.x - x, h.y - y) < h.r).sort((a, b) => b.z - a.z)[0]
    ?? hits.find(h => h.kind === 'label' && inRect(x, y, h.rect))
    ?? staveAt(x, y);
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
    if (drag.pan) cam.pan = clampPan(cam.pan + dy / scaleNow());
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
new ResizeObserver(() => {
  const r = canvas.getBoundingClientRect(); width = r.width; height = r.height;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  const dpr = Math.min(devicePixelRatio || 1, 2); overlay.width = Math.round(width * dpr); overlay.height = Math.round(height * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}).observe(canvas);
// Read-only hook for layout checks.
window.storyDemo = { renderer: 'webgl', cam, win, get turns() { return turns; }, get mode() { return mode; }, get focus() { return focus.name; },
  get splitting() { return !!split; },
  // Worst ratio of largest to smallest radius within any single turn: 1 means perfectly round.
  roundness: () => { let worst = 1; for (let d = 0; d < Math.floor(turns); d++) { const r = Array.from({ length: 64 }, (_, i) => radius(tAt((d + i / 64) / turns))); worst = Math.max(worst, Math.max(...r) / Math.min(...r)); } return +worst.toFixed(3); },
  maxStep: () => { let m = 0, prev = radius(tAt(0)); for (let i = 1; i <= 4000; i++) { const r = radius(tAt(i / 4000)); m = Math.max(m, Math.abs(r - prev)); prev = r; } return +m.toFixed(3); },
  wisdomNodes: () => overlayItems.wisdom.map(w => +Math.hypot(w.at.x, w.at.z).toFixed(1)),
  angles: () => visibleStaves().map(s => [+s.a0.toFixed(3), +s.a1.toFixed(3)]),
  get meshes() { let n = 0; world.traverse(o => { if (o.isMesh || o.isLine) n++; }); return n; },
  clustersOf: name => { const find = n => n.name === name ? n : (n.children ?? []).map(find).find(Boolean); const n = find(root); return n ? clusters(n.events).map(c => c.n) : []; },
  clusterHits: () => hits.filter(h => h.kind === 'cluster').map(h => ({ n: h.cluster.n, x: Math.round(h.x), y: Math.round(h.y) })),
  staveAt: (x, y) => staveAt(x, y)?.node.name, labels: () => hits.filter(h => h.kind === 'label').map(h => h.node.name),
  setWindow: (t0, t1) => zoomWindow(t0, t1), setFocusByName: name => { const find = n => n.name === name ? n : (n.children ?? []).map(find).find(Boolean); const n = find(root); if (n) setFocus(n); return !!n; } };
syncViewButtons(); syncZoom();
render();
})();
