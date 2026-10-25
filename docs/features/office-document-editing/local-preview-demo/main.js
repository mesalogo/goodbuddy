import { samples, createSample } from './samples.js'

const $ = (id) => document.getElementById(id)
const docs = []
let active, generation = 0, cleanup = () => {}
const engines = { docx: 'docx-preview · 段落、表格与分页；复杂版式可能有差异', xlsx: 'SheetJS · 单元格阅读；显示缓存公式结果，不重算公式或渲染图表', pptx: 'pptx-preview · 实验性版式预览；不播放动画', pdf: 'PDF.js · 单页渲染与缩放；本 Demo 未接入文字搜索' }
const button = (text, action) => { const node = document.createElement('button'); node.textContent = text; node.onclick = action; return node }
function status(text) { $('status').textContent = text }
function renderTabs() {
  $('tabs').replaceChildren()
  for (const doc of docs) {
    const group = document.createElement('div'); group.className = `tab-group${doc === active ? ' active' : ''}`
    const tab = button(doc.name, () => activate(doc)); tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(doc === active)); tab.tabIndex = doc === active ? 0 : -1
    tab.id = `tab-${doc.id}`; tab.setAttribute('aria-controls', 'viewer')
    tab.onkeydown = (e) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); const index = e.key === 'Home' ? 0 : e.key === 'End' ? docs.length - 1 : (docs.indexOf(doc) + (e.key === 'ArrowRight' ? 1 : -1) + docs.length) % docs.length; activate(docs[index]); $(`tab-${docs[index].id}`).focus() }
    const close = button('×', () => { const i = docs.indexOf(doc); docs.splice(i, 1); if (active === doc) activate(docs[Math.min(i, docs.length - 1)]); else renderTabs() }); close.className = 'close'; close.setAttribute('aria-label', `关闭 ${doc.name}`)
    group.append(tab, close); $('tabs').append(group)
  }
}
async function openFile(file) {
  const type = file.name.split('.').pop().toLowerCase()
  if (!engines[type]) { status(`不支持 ${file.name}。请选择 DOCX、XLSX、PPTX 或 PDF。`); return }
  const doc = { id: crypto.randomUUID(), name: file.name, type, blob: file }
  docs.push(doc); await activate(doc)
}
async function activate(doc) {
  const token = ++generation; cleanup(); cleanup = () => {}; active = doc; renderTabs()
  $('viewer').replaceChildren(); $('download').disabled = !doc
  $('viewer').removeAttribute('aria-labelledby')
  $('filename').textContent = doc?.name || '打开文件，开始阅读'; $('engine').textContent = doc ? engines[doc.type] : ''
  if (!doc) { status('选择示例文件，或拖入本地文件。'); $('metrics').textContent = '浏览器本地解析'; return }
  $('viewer').setAttribute('aria-labelledby', `tab-${doc.id}`)
  status('正在本地解析…'); const started = performance.now()
  const host = document.createElement('div'); $('viewer').append(host)
  const current = () => generation === token
  try {
    const buffer = await doc.blob.arrayBuffer(); if (!current()) return
    if (doc.type === 'docx') {
      const { renderAsync } = await import('docx-preview'); if (!current()) return
      await renderAsync(buffer, host, undefined, { inWrapper: true, breakPages: true, ignoreWidth: false, renderAltChunks: false })
    } else if (doc.type === 'xlsx') {
      const XLSX = await import('xlsx'); if (!current()) return
      const book = XLSX.read(buffer, { type: 'array', cellFormula: true }); renderWorkbook(book, XLSX, host)
    } else if (doc.type === 'pptx') {
      const { init } = await import('pptx-preview'); if (!current()) return
      host.className = 'ppt-host'; const width = Math.max(480, Math.min(960, $('viewer').clientWidth - 48))
      const preview = init(host, { width, height: width * 9 / 16, mode: 'list' }); cleanup = () => preview.destroy?.()
      await preview.preview(buffer)
      if (!preview.slideCount) throw new Error('组件未解析到幻灯片')
    } else {
      const pdfjs = await import('pdfjs-dist'); const { default: worker } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url'); if (!current()) return
      pdfjs.GlobalWorkerOptions.workerSrc = worker
      const task = pdfjs.getDocument({ data: buffer, isEvalSupported: false })
      cleanup = () => { void task.destroy() }
      const pdf = await task.promise; if (!current()) return
      await renderPdf(pdf, host, current)
    }
    if (!current()) return
    status(`已打开 · ${doc.type === 'pptx' ? '实验预览，请对照原文件检查版式' : '只读预览，可以选择其他文件继续比较'}`)
    $('metrics').textContent = `${(doc.blob.size / 1024).toFixed(1)} KB · ${(performance.now() - started).toFixed(0)} ms（含首次组件加载）`
  } catch (error) {
    if (!current()) return
    host.replaceChildren(); const message = document.createElement('div'); message.className = 'empty'; message.textContent = `预览失败：${error.message || error}。加密、损坏或不兼容文件可能无法打开。`
    message.append(document.createElement('br'), button('重新尝试', () => activate(doc))); host.append(message); status('文件未能打开，可重试或选择其他文件。'); $('metrics').textContent = '解析失败'
  }
}
function renderWorkbook(book, XLSX, host) {
  let page = 0
  const controls = document.createElement('div'); controls.className = 'sheet-controls'
  const select = document.createElement('select'); select.setAttribute('aria-label', '工作表')
  for (const name of book.SheetNames) { const option = document.createElement('option'); option.textContent = name; select.append(option) }
  const formula = document.createElement('span'); formula.className = 'formula'; formula.textContent = '点击单元格查看值或公式'
  const label = document.createElement('span'); const previous = button('上一段', () => { page--; draw() }); const next = button('下一段', () => { page++; draw() })
  controls.append(select, previous, label, next, formula)
  const scroll = document.createElement('div'); scroll.className = 'sheet-scroll'; host.append(controls, scroll)
  select.onchange = () => { page = 0; formula.textContent = '点击单元格查看值或公式'; draw() }
  function draw() {
    scroll.replaceChildren(); const sheet = book.Sheets[select.value]
    if (!sheet['!ref']) { scroll.textContent = '空工作表'; previous.disabled = next.disabled = true; label.textContent = '0 行'; return }
    const range = XLSX.utils.decode_range(sheet['!ref']); const start = range.s.r + page * 100; const end = Math.min(range.e.r, start + 99)
    previous.disabled = page === 0; next.disabled = end === range.e.r; label.textContent = `${start + 1}–${end + 1} / ${range.e.r + 1} 行`
    const table = document.createElement('table'); table.className = 'sheet'
    const head = table.createTHead().insertRow(); head.append(document.createElement('th'))
    for (let col = range.s.c; col <= range.e.c; col++) { const th = document.createElement('th'); th.textContent = XLSX.utils.encode_col(col); head.append(th) }
    const body = table.createTBody()
    for (let row = start; row <= end; row++) {
      const tr = body.insertRow(); const th = document.createElement('th'); th.textContent = row + 1; tr.append(th)
      for (let col = range.s.c; col <= range.e.c; col++) {
        const address = XLSX.utils.encode_cell({ r: row, c: col }); const cell = sheet[address]; const td = tr.insertCell()
        td.textContent = cell ? XLSX.utils.format_cell(cell) : ''; td.tabIndex = 0; td.setAttribute('aria-label', `${address} ${td.textContent}`)
        td.onfocus = td.onclick = () => { table.querySelector('.selected')?.classList.remove('selected'); td.classList.add('selected'); formula.textContent = `${address}  ${cell?.f ? `=${cell.f}（缓存结果：${td.textContent || '无'}）` : td.textContent || '空单元格'}` }
      }
    }
    scroll.append(table)
  }
  draw()
}
async function renderPdf(pdf, host, current) {
  let page = 1, scale = 1.25, rendering = false
  const controls = document.createElement('div'); controls.className = 'pdf-controls'; const label = document.createElement('span')
  const canvas = document.createElement('canvas'); canvas.className = 'pdf-page'
  const prev = button('上一页', () => { page--; void draw() }); const next = button('下一页', () => { page++; void draw() })
  const zoom = document.createElement('select'); zoom.setAttribute('aria-label', 'PDF 缩放')
  for (const value of [75, 100, 125, 150, 200]) { const option = document.createElement('option'); option.value = value / 100; option.textContent = `${value}%`; option.selected = value === 125; zoom.append(option) }
  zoom.onchange = () => { scale = Number(zoom.value); void draw() }
  controls.append(prev, label, next, zoom); host.append(controls, canvas)
  async function draw() {
    if (rendering || !current()) return
    rendering = true; prev.disabled = next.disabled = zoom.disabled = true
    try {
      const sheet = await pdf.getPage(page); if (!current()) return
      const viewport = sheet.getViewport({ scale }); canvas.width = viewport.width; canvas.height = viewport.height; canvas.style.maxWidth = 'none'
      await sheet.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
      label.textContent = `${page} / ${pdf.numPages}`
    } catch (error) { if (current()) status(`PDF 渲染失败：${error.message}`) }
    finally { rendering = false; prev.disabled = page === 1; next.disabled = page === pdf.numPages; zoom.disabled = false }
  }
  await draw()
}
for (const sample of samples) {
  const node = button('', async () => {
    node.disabled = true; status('正在生成真实示例文件…')
    try { const existing = docs.find(doc => doc.sample === sample.type); if (existing) await activate(existing); else { const blob = await createSample(sample.type); const doc = { ...sample, id: crypto.randomUUID(), blob, sample: sample.type }; docs.push(doc); await activate(doc) } }
    catch (error) { status(`示例生成失败：${error.message}`) } finally { node.disabled = false }
  })
  node.className = 'sample'; const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = sample.icon
  const text = document.createElement('span'); text.textContent = sample.name; const detail = document.createElement('small'); detail.textContent = sample.detail; text.append(detail); node.append(icon, text); $('samples').append(node)
}
$('open').onclick = () => $('file').click()
$('file').onchange = async (e) => { for (const file of e.target.files) await openFile(file); e.target.value = '' }
document.addEventListener('dragover', (e) => { e.preventDefault(); $('viewer').classList.add('dragging') })
document.addEventListener('drop', async (e) => { e.preventDefault(); $('viewer').classList.remove('dragging'); for (const file of e.dataTransfer.files) await openFile(file) })
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('viewer').classList.remove('dragging') })
$('theme').onclick = () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }
$('expand').onclick = () => { const expanded = document.body.classList.toggle('expanded'); $('expand').setAttribute('aria-pressed', String(expanded)); $('expand').textContent = expanded ? '收起阅读' : '展开阅读' }
$('download').onclick = () => { if (!active) return; const url = URL.createObjectURL(active.blob); const link = document.createElement('a'); link.href = url; link.download = active.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
$('samples').firstElementChild.click()
