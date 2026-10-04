import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Info, X } from 'lucide-react'
import { AnchoredMenu } from './AnchoredMenu'
import { useTranslation } from 'react-i18next'
import * as THREE from 'three'
import type { SupervisionAttentionSlot } from '../../shared/supervision-contracts'
import type { SupervisionExperience, SupervisionStory } from '../../shared/supervision-story-contracts'
import { buildStoryTree, clusterEvents, experienceLinks, findNode, radiusLevels, storyWindow, visibleLevel, type ExperienceLink, type StoryCluster, type StoryNode } from './story-graph-3d-model'

/*
 * 3D story view: one helix of time inside, story staves on the outer cylinder.
 * Geometry rebuilds only when what is shown changes; camera moves only re-render.
 * Loaded lazily so Three.js is not part of the workspace bundle.
 */
type Props = {
  stories: SupervisionStory[]
  attention: SupervisionAttentionSlot[]
  timeRange?: { from: string; to: string }
  selectedEventId?: string
  onSelectEvent: (id: string) => void
  onSelectStory: (id: string) => void
  /** Experiences (W) drawn outside the barrel, linking the staves they formed in and were applied to. */
  experiences?: SupervisionExperience[]
  selectedExperienceId?: string
  onSelectExperience?: (id: string) => void
}
const TAU = Math.PI * 2, HEIGHT = 430, STAVE_R = 188, DIST = 900, CLUSTER_PX = 9, W_R = 232
const noExperiences: SupervisionExperience[] = []
type EngineState = { focus: StoryNode; hovered?: string; selected?: string; experiences: SupervisionExperience[]; experience?: string }
const VIEWS = { oblique: { yaw: -0.4, tilt: 0.38 }, side: { yaw: -0.4, tilt: 0 }, top: { yaw: -0.4, tilt: Math.PI / 2 - 1e-3 } } as const
type ViewName = keyof typeof VIEWS | 'free'
// Existing graph tokens, so light and dark themes keep the same story colours as the flat view.
const toneVariables = ['--graph-node-1-border', '--graph-node-2-border', '--graph-node-3-border', '--graph-node-4-border', '--accent']

function cssColor(element: Element, variable: string, fallback: string): string {
  return getComputedStyle(element).getPropertyValue(variable).trim() || fallback
}
type PickerItem = { id: string; title: string; detail: string; current: boolean; onPick: () => void }
/** Toolbar picker in the shared anchored-menu style: a title and a secondary line per item. */
function PickerMenu({ label, button, items }: { label: string; button: string; items: PickerItem[] }) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  return <>
    <button ref={anchorRef} type="button" className="secondary-button story-graph-3d__picker" aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? id : undefined} aria-label={`${label}：${button}`} onClick={() => setOpen(value => !value)}>
      <span>{button}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <AnchoredMenu anchorRef={anchorRef} id={id} label={label} width={320} className="story-graph-3d__menu" onClose={() => setOpen(false)}>
      {items.map(item => <button key={item.id} type="button" role="menuitem" aria-current={item.current || undefined}
        onClick={() => { setOpen(false); anchorRef.current?.focus(); item.onPick() }}>
        <span><strong>{item.title}</strong><small>{item.detail}</small></span>
        {item.current && <Check size={14} aria-hidden="true" />}
      </button>)}
    </AnchoredMenu>}
  </>
}
function webglAvailable(): boolean {
  try { const canvas = document.createElement('canvas'); return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl')) }
  catch { return false }
}

export default function StoryGraph3D({ stories, attention: attentionProp, timeRange, selectedEventId, onSelectEvent, onSelectStory, experiences = noExperiences, selectedExperienceId, onSelectExperience }: Props) {
  const { t, i18n } = useTranslation('heartbeat')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [supported] = useState(webglAvailable)
  // Refreshes deliver equal data in new arrays; keep the previous array so the scene is not recreated.
  const attentionKey = JSON.stringify(attentionProp)
  const attention = useMemo(() => attentionProp, [attentionKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // Context creation failed or the GPU dropped the context; `attempt` recreates the scene on retry.
  const [failure, setFailure] = useState<'create' | 'lost'>()
  const [attempt, setAttempt] = useState(0)
  const tree = useMemo(() => buildStoryTree(stories, new Map()), [stories])
  const [focusId, setFocusId] = useState('root')
  const focus = findNode(tree, focusId) ?? tree
  const [view, setView] = useState<ViewName>('oblique')
  const [hovered, setHovered] = useState<string>()
  const [legendOpen, setLegendOpen] = useState(false)
  const legendId = useId()
  const camera = useRef<{ yaw: number; tilt: number; zoom: number; pan: number }>({ yaw: VIEWS.oblique.yaw, tilt: VIEWS.oblique.tilt, zoom: 1, pan: 0 })
  const engine = useRef<{ draw: () => void; update: (next: EngineState) => void; dispose: () => void; hit: (x: number, y: number) => { node?: StoryNode; cluster?: StoryCluster; link?: ExperienceLink } | undefined }>(undefined)
  const range = useMemo(() => {
    if (timeRange) return storyWindow(Date.parse(timeRange.from), Date.parse(timeRange.to))
    const times = tree.events.map(event => event.t)
    return times.length ? storyWindow(Math.min(...times) - 1_800_000, Math.max(...times) + 1_800_000) : undefined
  }, [tree, timeRange])
  const level = visibleLevel(focus)
  const shownLinks = useMemo(() => experienceLinks(experiences, level.children), [experiences, level])
  const trail: StoryNode[] = []
  for (let node: StoryNode | undefined = focus; node; node = node.parent) trail.unshift(node)
  const dateText = (value: number) => new Date(value).toLocaleString(i18n.resolvedLanguage, range && range.turnHours >= 24
    ? { month: '2-digit', day: '2-digit' } : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

  useEffect(() => {
    const canvas = canvasRef.current, overlay = overlayRef.current
    if (!supported || !canvas || !overlay || !range) return
    // Each scene draws on a fresh canvas: a canvas whose context was released on dispose cannot give a working context again.
    // `canvas` stays as the focus and pointer surface.
    const glCanvas = document.createElement('canvas')
    glCanvas.className = 'story-graph-3d__gl'
    glCanvas.setAttribute('aria-hidden', 'true')
    canvas.before(glCanvas)
    // Under load the browser can refuse a new WebGL context; show a local error instead of failing the page.
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: true }) }
    catch (error) { glCanvas.remove(); console.error('GoodBuddy 3D view failed', error); queueMicrotask(() => setFailure('create')); return }
    const lost = (event: Event) => { event.preventDefault(); setFailure('lost') }
    glCanvas.addEventListener('webglcontextlost', lost)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    const scene = new THREE.Scene()
    const host = canvas.parentElement!
    const background = cssColor(host, '--surface-raised', '#fff')
    scene.fog = new THREE.Fog(background, 700, 1250)
    scene.add(new THREE.HemisphereLight(0xffffff, 0xc9cfc4, 2.2))
    const sun = new THREE.DirectionalLight(0xffffff, 1.2); sun.position.set(-300, 500, 400); scene.add(sun)
    const view3d = new THREE.PerspectiveCamera(30, 1, 10, 4000)
    const raycaster = new THREE.Raycaster()
    const ctx = overlay.getContext('2d')!
    const muted = cssColor(host, '--text-muted', '#7d8a84')
    const tones = toneVariables.map((variable, index) => cssColor(host, variable, ['#2563eb', '#0f766e', '#7c3aed', '#b45309', '#086fc7'][index]!))
    const colorOf = (node: StoryNode) => tones[Math.abs([...node.id].reduce((hash, char) => hash * 31 + char.charCodeAt(0) | 0, 7)) % tones.length]!
    const levelAt = radiusLevels(range, attention)
    const u = (time: number) => (time - range.from) / (range.to - range.from)
    const y = (time: number) => (u(time) - 0.5) * HEIGHT
    const helix = (time: number) => { const r = 78 + 74 * levelAt(u(time)), a = u(time) * range.turns * TAU; return new THREE.Vector3(r * Math.cos(a), y(time), r * Math.sin(a)) }
    const on = (time: number, angle: number, r = STAVE_R) => new THREE.Vector3(r * Math.cos(angle), y(time), r * Math.sin(angle))
    const center = (node: StoryNode) => (node.a0 + node.a1) / 2
    let width = 0, height = 0
    const disposables: Array<{ dispose: () => void }> = []
    const own = <T extends { dispose: () => void }>(item: T) => { disposables.push(item); return item }
    const solid = (color: string, opacity = 1) => own(new THREE.MeshStandardMaterial({ color, roughness: 0.65, transparent: opacity < 1, opacity }))
    const flat = (color: string, opacity: number) => own(new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }))
    const tube = (points: THREE.Vector3[], r: number, material: THREE.Material, segments = Math.max(8, points.length * 2)) =>
      new THREE.Mesh(own(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), segments, r, 8, false)), material)
    // Static base: the grey time helix and turn ticks.
    const base = new THREE.Group()
    base.add(tube(Array.from({ length: 1401 }, (_, i) => helix(range.from + (range.to - range.from) * i / 1400)), 1.1, solid(muted), 2800))
    const ticks = Array.from({ length: Math.floor(range.turns + 1e-6) + 1 }, (_, d) => range.from + d * range.turnHours * 3_600_000).filter(time => time < range.to)
    scene.add(base)
    // What is shown; the renderer and scene persist while focus, hover and selection change.
    const state: EngineState = { focus, experiences }
    let staves = visibleLevel(focus).children
    const meshes: THREE.Mesh[] = []
    const groups = new Map<string, StoryCluster[]>()
    const wisdom = cssColor(host, '--graph-node-4-border', '#b45309')
    const world = new THREE.Group(); scene.add(world)
    const clusterSpan = () => CLUSTER_PX / (HEIGHT * Math.min(width / 500, height / 560) * camera.current.zoom) * (range.to - range.from)
    let builtSpan = -1
    const rebuild = () => {
      world.clear()
      meshes.length = 0
      groups.clear()
      const span = clusterSpan()
      builtSpan = span
      for (const stave of staves) {
        const emphasis = state.focus === visibleLevel(state.focus) ? (stave.id === state.hovered ? 'focus' : 'normal') : stave.id === state.focus.id ? 'focus' : 'dim'
        const color = colorOf(stave), gap = Math.min(0.014, (stave.a1 - stave.a0) * 0.08)
        const a0 = stave.a0 + gap, a1 = Math.max(a0 + 1e-3, stave.a1 - gap)
        const t0 = stave.start - (range.to - range.from) * 0.006, t1 = stave.end + (range.to - range.from) * 0.006
        const segments = Math.max(2, Math.ceil((a1 - a0) / 0.05))
        const geometry = own(new THREE.BufferGeometry()), positions: number[] = [], index: number[] = []
        for (let j = 0; j <= segments; j++) { const a = a0 + (a1 - a0) * j / segments, lo = on(t0, a), hi = on(t1, a); positions.push(lo.x, lo.y, lo.z, hi.x, hi.y, hi.z) }
        for (let j = 0; j < segments; j++) { const k = j * 2; index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3) }
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(index)
        const mesh = new THREE.Mesh(geometry, flat(color, emphasis === 'focus' ? 0.3 : emphasis === 'dim' ? 0.05 : 0.15))
        mesh.userData.node = stave
        world.add(mesh); meshes.push(mesh)
        const clusters = clusterEvents(stave.events, span)
        groups.set(stave.id, clusters)
        for (const cluster of clusters) {
          const arc = Array.from({ length: 11 }, (_, i) => on(cluster.t, a0 + (a1 - a0) * i / 10, STAVE_R + 0.6))
          const active = cluster.events.some(event => event.id === state.selected)
          world.add(tube(arc, (Math.min(6, 1.3 + Math.log2(cluster.events.length) * 1.1) + (active ? 2 : 0)) * 0.45, solid(color, emphasis === 'dim' ? 0.3 : 0.9), 20))
        }
        // Connectors and the story's own colour on the helix only for the focused or hovered stave.
        if (emphasis !== 'focus') continue
        for (const cluster of clusters) {
          const p = helix(cluster.t), active = cluster.events.some(event => event.id === state.selected)
          world.add(tube([p, on(cluster.t, center(stave))], active ? 0.9 : 0.5, solid(color, active ? 1 : 0.6), 2))
          const dot = new THREE.Mesh(own(new THREE.SphereGeometry(Math.min(6, 2.2 + Math.log2(cluster.events.length)) + (active ? 1.5 : 0), 16, 12)), solid(color))
          dot.position.copy(p); dot.userData.cluster = cluster; dot.userData.node = stave
          world.add(dot); meshes.push(dot)
        }
      }
      // Experiences: a diamond outside the barrel, arcs from the forming stave to it and on to the applying stave.
      for (const link of experienceLinks(state.experiences, staves)) {
        const active = link.id === state.experience
        const node = on(link.t, link.angle, W_R)
        const arc = (end: { stave: StoryNode; t: number }) => {
          const start = on(end.t, center(end.stave), STAVE_R + 1)
          const mid = start.clone().add(node).multiplyScalar(0.5)
          mid.setLength(mid.length() + 26)
          return new THREE.QuadraticBezierCurve3(start, mid, node).getPoints(24)
        }
        const material = solid(wisdom, active ? 1 : 0.55)
        world.add(tube(arc(link.from), active ? 0.9 : 0.55, material, 24))
        world.add(tube(arc(link.to).reverse(), active ? 0.9 : 0.55, material, 24))
        const diamond = new THREE.Mesh(own(new THREE.OctahedronGeometry(active ? 7 : 5.5)), solid(wisdom))
        diamond.position.copy(node); diamond.userData.link = link
        world.add(diamond); meshes.push(diamond)
      }
    }
    const project = (point: THREE.Vector3) => { const v = point.clone().project(view3d); return { x: (v.x + 1) / 2 * width, y: (1 - v.y) / 2 * height, behind: v.z > 1 } }
    const place = () => {
      const { yaw, tilt, zoom, pan } = camera.current, ct = Math.cos(tilt), st = Math.sin(tilt), target = new THREE.Vector3(0, pan, 0)
      view3d.position.copy(target).add(new THREE.Vector3(-Math.sin(yaw) * ct, st, Math.cos(yaw) * ct).multiplyScalar(DIST))
      view3d.up.set(Math.sin(yaw) * st, ct, -Math.cos(yaw) * st)
      view3d.lookAt(target)
      view3d.fov = 2 * Math.atan(height / Math.min(width / 500, height / 560) / 2 / DIST) * 180 / Math.PI
      view3d.aspect = width / height; view3d.zoom = zoom; view3d.updateProjectionMatrix()
    }
    const draw = () => {
      if (!width || !height) return
      place()
      if (Math.abs(clusterSpan() - builtSpan) > builtSpan * 0.5) rebuild()
      renderer.render(scene, view3d)
      ctx.clearRect(0, 0, width, height)
      ctx.font = '10px system-ui'; ctx.fillStyle = muted
      for (const time of ticks) { const p = project(helix(time)); if (!p.behind) ctx.fillText(dateText(time), p.x + 6, p.y + 3) }
      // Names only for staves facing the viewer, without overlaps; the focused stave always.
      const direction = view3d.position.clone().normalize(), placed: number[][] = []
      const labels = staves.map(stave => ({ stave, facing: Math.cos(center(stave)) * direction.x + Math.sin(center(stave)) * direction.z,
        focused: stave.id === state.focus.id || stave.id === state.hovered })).sort((a, b) => Number(b.focused) - Number(a.focused) || b.facing - a.facing)
      for (const { stave, facing, focused } of labels) {
        if (!focused && facing < -0.05) continue
        const p = project(on(stave.end, center(stave), STAVE_R + 2)); if (p.behind) continue
        ctx.font = `${focused ? '600 ' : ''}11px system-ui`
        const w = ctx.measureText(stave.name).width, box = [p.x - w / 2 - 4, p.y - 20, w + 8, 16]
        if (placed.some(b => box[0]! < b[0]! + b[2]! && b[0]! < box[0]! + box[2]! && box[1]! < b[1]! + b[3]! && b[1]! < box[1]! + box[3]!)) continue
        placed.push(box)
        ctx.globalAlpha = focused ? 1 : 0.55 + 0.45 * Math.max(0, facing)
        ctx.fillStyle = colorOf(stave); ctx.fillText(stave.name, p.x - w / 2, p.y - 8)
        ctx.globalAlpha = 1
      }
      ctx.font = '600 9px system-ui'; ctx.fillStyle = cssColor(host, '--surface-raised', '#fff')
      for (const mesh of meshes) {
        const cluster = mesh.userData.cluster as StoryCluster | undefined
        if (!cluster || cluster.events.length < 2) continue
        const p = project(mesh.position); if (p.behind) continue
        const label = String(cluster.events.length); ctx.fillText(label, p.x - ctx.measureText(label).width / 2, p.y + 3)
      }
      // Only the selected experience is named on the canvas; the list below names all of them.
      ctx.font = '600 11px system-ui'; ctx.fillStyle = wisdom
      for (const mesh of meshes) {
        const link = mesh.userData.link as ExperienceLink | undefined
        if (!link || link.id !== state.experience) continue
        const p = project(mesh.position); if (p.behind) continue
        const text = link.statement.length > 28 ? `${link.statement.slice(0, 27)}…` : link.statement
        ctx.fillText(text, Math.max(4, Math.min(width - ctx.measureText(text).width - 4, p.x + 10)), p.y + 4)
      }
    }
    const resize = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect(); width = rect.width; height = rect.height
      if (!width || !height) return
      renderer.setSize(width, height, false)
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      overlay.width = Math.round(width * dpr); overlay.height = Math.round(height * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      rebuild(); draw()
    })
    resize.observe(canvas)
    const zoom = (event: WheelEvent) => {
      event.preventDefault()
      setView('free')
      camera.current.zoom = Math.max(0.5, Math.min(2.5, camera.current.zoom * Math.exp(-event.deltaY * 0.0012)))
      draw()
    }
    canvas.addEventListener('wheel', zoom, { passive: false })
    engine.current = {
      draw,
      update: next => { Object.assign(state, next); staves = visibleLevel(state.focus).children; rebuild(); draw() },
      hit: (x, yPos) => {
        raycaster.setFromCamera(new THREE.Vector2(x / width * 2 - 1, 1 - yPos / height * 2), view3d)
        const hit = raycaster.intersectObjects(meshes, false)[0]
        return hit && { node: hit.object.userData.node as StoryNode | undefined, cluster: hit.object.userData.cluster as StoryCluster | undefined,
          link: hit.object.userData.link as ExperienceLink | undefined }
      },
      // Release the GPU context too: browsers keep only a few, and reopening the view must not use them up.
      dispose: () => { canvas.removeEventListener('wheel', zoom); glCanvas.removeEventListener('webglcontextlost', lost); resize.disconnect()
        disposables.forEach(item => item.dispose()); renderer.dispose(); renderer.forceContextLoss(); glCanvas.remove() }
    }
    return () => { engine.current?.dispose(); engine.current = undefined }
    // Focus, hover and selection are pushed through update() below; only data, locale and a retry recreate the scene.
  }, [supported, range, attention, i18n.resolvedLanguage, attempt]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { engine.current?.update({ focus, hovered, selected: selectedEventId, experiences, experience: selectedExperienceId }) },
    [focus, hovered, selectedEventId, range, attention, experiences, selectedExperienceId])

  const animate = (goal: Partial<typeof camera.current>) => {
    const from = { ...camera.current }
    let started: number | undefined
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const step = (now: number) => {
      started ??= now
      const k = reduce ? 1 : Math.min(1, (now - started) / 480), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
      for (const key of ['yaw', 'tilt', 'zoom', 'pan'] as const) if (goal[key] !== undefined) camera.current[key] = from[key] + (goal[key]! - from[key]) * e
      engine.current?.draw()
      if (k < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }
  const choose = (name: ViewName) => { setView(name); if (name !== 'free') animate({ ...VIEWS[name], zoom: 1, pan: 0 }) }
  const open = (node: StoryNode) => {
    if (node.level !== 'project') onSelectStory(node.id)
    setFocusId(node.id)
    setHovered(undefined)
  }
  const drag = useRef<{ x: number; y: number; sx: number; sy: number; pan: boolean }>(undefined)
  const pointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return [event.clientX - rect.left, event.clientY - rect.top] as const
  }
  if (!supported) return <p className="supervisor-workspace__muted" role="status">{t('supervisor.graph3d.unsupported')}</p>
  if (failure) return <div className="supervisor-workspace__inline-error" role="alert">
    <strong>{t(failure === 'lost' ? 'supervisor.graph3d.lost' : 'supervisor.graph3d.failed')}</strong>
    <button type="button" className="secondary-button" onClick={() => { setFailure(undefined); setAttempt(value => value + 1) }}>{t('supervisor.graph3d.retry')}</button>
  </div>
  if (!range) return <p className="supervisor-workspace__muted">{t('supervisor.stories.empty')}</p>
  const childKinds = new Set(level.children.map(node => node.level))
  const childLevelName = t(`supervisor.graph3d.childLevels.${childKinds.size === 1 ? [...childKinds][0] : 'mixed'}`)
  const scale = t('supervisor.graph3d.scale', { turn: t(`supervisor.graph3d.turns.${range.turnHours}`), count: Math.round(range.turns * 10) / 10 })
  return <div className="story-graph-3d">
    <div className="story-graph-3d__toolbar">
      <nav aria-label={t('supervisor.graph3d.levels')}>
        {trail.map((node, index) => <span key={node.id}>
          {index > 0 && ' › '}
          {index === trail.length - 1 ? <strong>{node.level === 'root' ? t('supervisor.graph3d.all') : node.name}</strong>
            : <button type="button" className="link-button" onClick={() => setFocusId(node.id)}>{node.level === 'root' ? t('supervisor.graph3d.all') : node.name}</button>}
        </span>)}
      </nav>
      <div role="group" aria-label={t('supervisor.graph3d.views')}>
        {(['oblique', 'side', 'top', 'free'] as const).map(name => <button key={name} type="button" className="secondary-button"
          aria-pressed={view === name} onClick={() => choose(name)}>{t(`supervisor.graph3d.view.${name}`)}</button>)}
        <button type="button" className="secondary-button" aria-expanded={legendOpen} aria-controls={legendId}
          onClick={() => setLegendOpen(value => !value)}><Info size={14} aria-hidden="true" />{t('supervisor.graph3d.legendTitle')}</button>
      </div>
      {/* Keyboard and screen-reader access to the same staves and experiences shown on the canvas. */}
      <div className="story-graph-3d__pickers">
        <PickerMenu label={t('supervisor.graph3d.staves')} button={t('supervisor.graph3d.pickChildren', { level: childLevelName, count: level.children.length })}
          items={level.children.map(node => ({ id: node.id, title: node.name, detail: `${t('supervisor.stories.count', { count: node.events.length })} · ${dateText(node.start)} – ${dateText(node.end)}`,
            current: node.id === focus.id, onPick: () => open(node) }))} />
        {shownLinks.length > 0 && <PickerMenu label={t('supervisor.graph3d.experiences')} button={t('supervisor.graph3d.pickExperience', { count: shownLinks.length })}
          items={shownLinks.map(link => ({ id: link.id, title: link.statement, detail: `${link.from.stave.name} → ${link.to.stave.name}`,
            current: link.id === selectedExperienceId, onPick: () => onSelectExperience?.(link.id) }))} />}
      </div>
    </div>
    <div className="story-graph-3d__viewport">
      <canvas ref={canvasRef} tabIndex={0} aria-label={t('supervisor.graph3d.canvas')}
        onPointerDown={event => { const [x, y] = pointer(event); drag.current = { x, y, sx: x, sy: y, pan: event.button === 2 || event.shiftKey }; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={event => {
          const [x, y] = pointer(event)
          if (!drag.current) {
            const hit = engine.current?.hit(x, y)
            const id = hit?.node && level.children.includes(hit.node) ? hit.node.id : undefined
            if (id !== hovered) setHovered(id)
            event.currentTarget.style.cursor = hit ? 'pointer' : ''
            return
          }
          const dx = x - drag.current.x, dy = y - drag.current.y
          if (Math.hypot(x - drag.current.sx, y - drag.current.sy) >= 5 && view !== 'free') setView('free')
          if (drag.current.pan) camera.current.pan = Math.max(-HEIGHT / 2, Math.min(HEIGHT / 2, camera.current.pan + dy))
          else { camera.current.yaw += dx * 0.008; camera.current.tilt = Math.max(-Math.PI / 2 + 1e-3, Math.min(Math.PI / 2 - 1e-3, camera.current.tilt + dy * 0.006)) }
          drag.current.x = x; drag.current.y = y
          engine.current?.draw()
        }}
        onPointerUp={event => {
          const [x, y] = pointer(event), start = drag.current
          drag.current = undefined
          if (!start || Math.hypot(x - start.sx, y - start.sy) >= 5) return
          const hit = engine.current?.hit(x, y)
          if (hit?.link) onSelectExperience?.(hit.link.id)
          else if (hit?.cluster) { if (hit.cluster.events.length === 1) onSelectEvent(hit.cluster.events[0]!.id); else open(hit.node!) }
          else if (hit?.node) open(hit.node)
        }}
        onPointerLeave={() => { if (!drag.current) setHovered(undefined) }}
        onContextMenu={event => event.preventDefault()}
        onKeyDown={event => {
          if (event.key === 'Escape' && focus.parent) { setFocusId(focus.parent.id); return }
          const preset = ({ 1: 'oblique', 2: 'side', 3: 'top' } as const)[event.key as '1' | '2' | '3']
          if (preset) { choose(preset); return }
          const move: Record<string, () => void> = { ArrowLeft: () => { camera.current.yaw -= 0.12 }, ArrowRight: () => { camera.current.yaw += 0.12 },
            ArrowUp: () => { camera.current.tilt = Math.min(Math.PI / 2 - 1e-3, camera.current.tilt + 0.06) }, ArrowDown: () => { camera.current.tilt = Math.max(-Math.PI / 2 + 1e-3, camera.current.tilt - 0.06) } }
          if (!move[event.key]) return
          event.preventDefault(); setView('free'); move[event.key]!(); engine.current?.draw()
        }} />
      <canvas ref={overlayRef} className="story-graph-3d__overlay" aria-hidden="true" />
      {/* Scale stays visible on the canvas; the full explanation opens on demand. */}
      <span className="story-graph-3d__scale" aria-hidden="true">{scale}</span>
      {legendOpen && <div className="story-graph-3d__legend" id={legendId} role="note">
        <div className="story-graph-3d__legend-head">
          <strong>{t('supervisor.graph3d.legendTitle')}</strong>
          <button type="button" className="icon-button" aria-label={t('supervisor.graph3d.legendClose')} title={t('supervisor.graph3d.legendClose')}
            onClick={() => setLegendOpen(false)}><X size={14} aria-hidden="true" /></button>
        </div>
        <ul>
          <li>{t('supervisor.graph3d.legendItems.time', { scale })}</li>
          <li>{t('supervisor.graph3d.legendItems.radius')}</li>
          <li>{t('supervisor.graph3d.legendItems.stave')}</li>
          <li>{t('supervisor.graph3d.legendItems.experience')}</li>
        </ul>
      </div>}
    </div>
  </div>
}
