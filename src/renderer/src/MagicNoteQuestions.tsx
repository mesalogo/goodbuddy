import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Crop, Trash2, X } from 'lucide-react'
import { magicNoteDataBytes, magicNoteQuestionLimits, magicNoteQuestionSchema, type MagicNoteDetail, type MagicNoteQuestionInput, type MagicNoteQuestionScope } from '../../shared/magic-notes-contracts'
import type { MagicCanvasContentHandle } from './MagicCanvasContent'
import { MarkdownRenderer } from './MarkdownRenderer'

type Region = { entryId: string; revision: number; page: number; pageId: string; dataUrl: string }
type Rectangle = { x: number; y: number; width: number; height: number }

export async function cropNoteImage(dataUrl: string, rectangle: Rectangle): Promise<string> {
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  const { x, y, width, height } = rectangle
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 100 || y + height > 100) throw new Error('Invalid crop rectangle')
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * width / 100))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * height / 100))
  canvas.getContext('2d')!.drawImage(image, image.naturalWidth * x / 100, image.naturalHeight * y / 100,
    image.naturalWidth * width / 100, image.naturalHeight * height / 100, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

// The parent keys this component by note ID. Pending work can never update another note.
export function MagicNoteQuestions({ note, selectedEntryId, editingEntryId, getCanvas, onError }: {
  note: MagicNoteDetail
  selectedEntryId: string
  editingEntryId?: string
  getCanvas(entryId: string): MagicCanvasContentHandle | undefined
  onError(error: unknown): void
}): React.JSX.Element {
  const { t } = useTranslation('magicNotes')
  const [scope, setScope] = useState<MagicNoteQuestionScope>('page')
  const [start, setStart] = useState(1)
  const [end, setEnd] = useState(1)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<MagicNoteQuestionInput['history']>([])
  const [textOnly, setTextOnly] = useState(false)
  const [region, setRegion] = useState<Region>()
  const [selecting, setSelecting] = useState(false)
  const mounted = useRef(true)
  const pending = useRef(false)
  const selectingCanvas = useRef<MagicCanvasContentHandle | undefined>(undefined)
  const regionButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    mounted.current = true
    // Switching notes unmounts this panel; never leave a selection overlay on the page.
    return () => { mounted.current = false; selectingCanvas.current?.cancelRegion() }
  }, [])
  const selected = note.entries.find(entry => entry.id === selectedEntryId) ?? note.entries.at(-1)
  const recordLabel = t('questions.record', { number: selected ? note.entries.indexOf(selected) + 1 : 0 })
  const error = (value: unknown): void => { if (mounted.current) onError(value) }

  const captureRegion = async (): Promise<void> => {
    if (selectingCanvas.current) { selectingCanvas.current.cancelRegion(); return }
    if (!selected || pending.current) return
    pending.current = true
    try {
      if (editingEntryId === selected.id) throw new Error(t('questions.saveFirst'))
      const canvas = getCanvas(selected.id)
      if (selected.content.version !== 2 || !canvas) throw new Error(t('questions.canvasRequired'))
      const page = await canvas.activePage()
      selectingCanvas.current = canvas
      setSelecting(true)
      let rectangle: Rectangle | null
      try { rectangle = await canvas.selectRegion(t('questions.cropHelp')) }
      finally { selectingCanvas.current = undefined; if (mounted.current) setSelecting(false) }
      if (!mounted.current) return
      if (!rectangle) { regionButton.current?.focus(); return }
      setBusy(true)
      // The page controls stay usable while selecting; the region belongs to the page it was drawn on.
      if (await canvas.activePage() !== page) throw new Error(t('questions.recapture'))
      const [capture] = await canvas.capturePages(1, true, page)
      if (!capture) throw new Error(t('questions.invalidRange'))
      const dataUrl = await cropNoteImage(capture.dataUrl, rectangle)
      if (!mounted.current) return
      setRegion({ entryId: selected.id, revision: selected.revision, page, pageId: capture.pageId, dataUrl })
      setScope('region')
    } catch (value) { error(value) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }

  const ask = async (): Promise<void> => {
    if (!selected || !draft.trim() || pending.current) return
    pending.current = true
    setBusy(true)
    try {
      const entries = scope === 'document' ? note.entries : [selected]
      if (entries.some(entry => entry.id === editingEntryId)) throw new Error(t('questions.saveFirst'))
      const runtime = await window.goodbuddy.settings.getRuntime()
      if (!mounted.current) return
      const profile = runtime.modelProfiles.find(item => item.id === runtime.defaultModelProfileId)
      const images = (profile ? profile.supportsImageInput : runtime.supportsImageInput) === true
      setTextOnly(!images)
      const input: MagicNoteQuestionInput = { noteId: note.id, question: draft.trim(), scope, contexts: [], history }
      if (scope !== 'document') input.entryId = selected.id
      if (scope === 'region') {
        if (!images) throw new Error(t('questions.regionNeedsImages'))
        if (!region || region.entryId !== selected.id || region.revision !== selected.revision) throw new Error(t('questions.recapture'))
        input.pageStart = input.pageEnd = region.page
        input.contexts.push({ entryId: region.entryId, revision: region.revision, pages: [{ pageId: region.pageId, text: '', dataUrl: region.dataUrl }] })
      } else {
        let imageCount = 0
        let imageBytes = 0
        for (const entry of entries) {
          const canvas = entry.content.version === 2 ? getCanvas(entry.id) : undefined
          if (entry.content.version === 2 && !canvas) throw new Error(t('canvas.notReady'))
          const pageCount = entry.content.version === 2 ? entry.content.pages.length : 1
          const first = scope === 'document' ? 1 : scope === 'page' ? (canvas ? await canvas.activePage() : 1) : start
          const last = scope === 'document' ? pageCount : scope === 'page' ? first : end
          if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > pageCount) throw new Error(t('questions.invalidRange'))
          if (scope !== 'document') { input.pageStart = first; input.pageEnd = last }
          const snapshot: MagicNoteQuestionInput['contexts'][number] = { entryId: entry.id, revision: entry.revision, pages: [] }
          if (canvas) {
            imageCount += images ? last - first + 1 : 0
            if (imageCount > magicNoteQuestionLimits.images) throw new Error(t('questions.requestLimit'))
            // Capture one page at a time so the request budget is checked before retaining more images.
            for (let page = first; page <= last; page++) {
              const [capture] = await canvas.capturePages(1, images, page)
              if (!mounted.current) return
              if (!capture || entry.content.version !== 2 || capture.pageId !== entry.content.pages[page - 1]?.id) throw new Error(t('questions.recapture'))
              imageBytes += images ? magicNoteDataBytes(capture.dataUrl) : 0
              if (imageBytes > magicNoteQuestionLimits.imageBytes) throw new Error(t('questions.requestLimit'))
              snapshot.pages.push({ pageId: capture.pageId, text: capture.text ?? '', ...(images ? { dataUrl: capture.dataUrl } : {}) })
            }
          }
          input.contexts.push(snapshot)
        }
      }
      const context = scope === 'document' ? t('questions.document') : `${recordLabel} / ${input.pageStart}-${input.pageEnd}${scope === 'region' ? ` / ${t('questions.region')}` : ''}`
      const result = await window.goodbuddy.magicNotes.ask(magicNoteQuestionSchema.parse(input))
      if (!mounted.current) return
      setTextOnly(result.inputMode === 'text' || !images)
      setHistory(current => [...current, { question: input.question, answer: result.answer, context }])
      setDraft('')
    } catch (value) { error(value) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }

  return <div className="magic-notes-question">
    {history.length > 0 && <div className="magic-notes-question__history-wrap">
      <div className="magic-notes-question__history" aria-live="polite">
        {history.map((item, index) => <section key={index}><strong>{item.question}</strong><small>{item.context}</small><div className="markdown-content"><MarkdownRenderer>{item.answer}</MarkdownRenderer></div></section>)}
      </div>
      <button type="button" className="icon-button magic-notes-question__history-clear" aria-label={t('questions.clearHistory')} title={t('questions.clearHistory')}
        disabled={busy} onClick={() => setHistory([])}><Trash2 aria-hidden="true" size={14} /></button>
    </div>}
    <div className="magic-notes-question__scope">
      <label htmlFor="magic-note-question-scope">{t('questions.contextLabel')}</label>
      <select className="field-control" id="magic-note-question-scope" value={scope} disabled={busy || selecting} onChange={event => setScope(event.target.value as MagicNoteQuestionScope)}>
        <option value="page">{t('questions.currentPage')}</option><option value="pages">{t('questions.pageRange')}</option><option value="document">{t('questions.document')}</option>
        {region && <option value="region">{t('questions.region')}</option>}
      </select>
    </div>
    {scope !== 'document' && selected && <small>{recordLabel}</small>}
    {scope === 'pages' && <div className="magic-notes-question__pages">
      <input className="field-control" aria-label={t('questions.pageStart')} type="number" min={1} value={start} disabled={busy} onChange={event => setStart(Number(event.target.value))} />
      <span>-</span><input className="field-control" aria-label={t('questions.pageEnd')} type="number" min={1} value={end} disabled={busy} onChange={event => setEnd(Number(event.target.value))} />
    </div>}
    {selected?.content.version === 1 && scope !== 'document' && <small>{t('questions.textPage')}</small>}
    {region && <div className="magic-notes-question__region">
      <img src={region.dataUrl} alt={t('questions.region')} />
      <button type="button" className="icon-button magic-notes-question__region-remove" aria-label={t('questions.removeRegion')} title={t('questions.removeRegion')} disabled={busy}
        onClick={() => { setRegion(undefined); if (scope === 'region') setScope('page') }}><X aria-hidden="true" size={14} /></button>
    </div>}
    {textOnly && <p role="status">{t('questions.textOnly')}</p>}
    <form onSubmit={event => { event.preventDefault(); void ask() }}>
      <textarea className="field-control" aria-label={t('questions.inputLabel')} maxLength={4000} disabled={busy} placeholder={t('questions.placeholder')} value={draft} onChange={event => setDraft(event.target.value)} />
      <div className="magic-notes-question__actions">
        <button ref={regionButton} type="button" className={`icon-button${selecting ? ' icon-button--active' : ''}`}
          aria-label={t(selecting ? 'questions.cancelRegion' : 'questions.captureRegion')} title={t(selecting ? 'questions.cancelRegion' : 'questions.captureRegion')} aria-pressed={selecting}
          disabled={busy || selected?.content.version !== 2} onClick={() => void captureRegion()}><Crop aria-hidden="true" size={16} /></button>
        {selecting && <small className="magic-notes-question__selecting" role="status">{t('questions.cropHelp')}</small>}
        <button className="primary-button" disabled={busy || selecting || !selected || !draft.trim()} type="submit">{t(busy ? 'questions.asking' : 'questions.ask')}</button>
      </div>
    </form>
  </div>
}
