import { ArrowLeft, ExternalLink, Pin, Plus } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { magicNoteRichContentSchema, type MagicNoteCommentFormat, type MagicNoteDetail, type MagicNoteRichContent, type MagicNoteSummary } from '../../shared/magic-notes-contracts'
import type { MagicNoteCommentMode } from '../../shared/application-settings-contracts'
import { MagicNoteSource, type OpenMagicNoteSource } from './MagicNoteSource'
import type { useMagicNoteDraft } from './use-magic-note-draft'
import type { AppNotificationInput } from './notifications'
import { SegmentedControl } from './WorkspacePrimitives'
import { InlineHelp } from './InlineHelp'
import './magic-notes-panel.css'

const MagicCanvasThumbnail = lazy(async () => ({ default: (await import('./MagicCanvasThumbnail')).MagicCanvasThumbnail }))

// Split operations at the existing rich-text operation limit, without truncating text.
export function capturedNoteContent(text: string): MagicNoteRichContent {
  const value = text.endsWith('\n') ? text : `${text}\n`
  const ops: MagicNoteRichContent['ops'] = []
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + 200_000, value.length)
    if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--
    ops.push({ insert: value.slice(start, end) })
    start = end
  }
  return { version: 1, ops }
}

export type MagicNotesPanelProps = {
  state: ReturnType<typeof useMagicNoteDraft>
  active: boolean
  commentMode?: MagicNoteCommentMode
  commentFormat?: MagicNoteCommentFormat
  onNotify: (notification: AppNotificationInput) => void
  onOpenWorkspace: (noteId: string, entryId?: string) => void
  onOpenSource: OpenMagicNoteSource
  onCancelCapture: () => void
}

export function MagicNotesPanel({ state, active, commentMode, commentFormat = 'combined', onNotify, onOpenWorkspace, onOpenSource, onCancelCapture }: MagicNotesPanelProps): React.JSX.Element {
  const { t, i18n } = useTranslation('magicNotes')
  const { draft, setDraft, saving, setSaving, selectedNoteId, setSelectedNoteId, guard } = state
  const [query, setQuery] = useState('')
  const [notes, setNotes] = useState<MagicNoteSummary[]>([])
  const [detail, setDetail] = useState<MagicNoteDetail>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [previousSource, setPreviousSource] = useState(draft?.source)
  if (previousSource !== draft?.source) {
    setPreviousSource(draft?.source)
    setSaveError('')
  }
  const [refresh, setRefresh] = useState(0)
  const [highlight, setHighlight] = useState<string>()
  const submitting = useRef(false)
  const preview = useRef<HTMLTextAreaElement>(null)
  const title = useRef<HTMLInputElement>(null)
  const currentDetail = detail?.id === selectedNoteId ? detail : undefined
  const quickDraft = Boolean(draft && !draft.source && !draft.newNote && draft.targetId === selectedNoteId)
  const content = useMemo(() => draft ? capturedNoteContent(draft.text) : undefined, [draft])
  const tooLong = useMemo(() => Boolean(content && !magicNoteRichContentSchema.safeParse(content).success), [content])
  const valid = Boolean(draft && !tooLong && (draft.newNote ? draft.title.trim().length > 0 && draft.title.trim().length <= 100 : draft.targetId) && (draft.text.trim() || (draft.newNote && !draft.source)))

  useEffect(() => window.goodbuddy.magicNotes.onChanged(() => setRefresh(value => value + 1)), [])
  useEffect(() => {
    if (!active) return
    let current = true
    const timer = setTimeout(() => {
      setLoading(true)
      setError('')
      void Promise.all([
        window.goodbuddy.magicNotes.search({ query, limit: 100 }),
        selectedNoteId ? window.goodbuddy.magicNotes.get(selectedNoteId).catch(reason => {
          if (reason instanceof Error && reason.message.includes('笔记不存在')) {
            if (current) {
              setSelectedNoteId(''); setDetail(undefined); setSaveError(t('capture.deletedTarget'))
              setDraft(value => value?.targetId === selectedNoteId ? { ...value, targetId: '' } : value)
            }
            return undefined
          }
          throw reason
        }) : undefined
      ]).then(([items, note]) => { if (current) { setNotes(items); setDetail(note) } })
        .catch(reason => { if (current) setError(reason instanceof Error ? reason.message : t('errors.operationFailed')) })
        .finally(() => { if (current) setLoading(false) })
    }, query ? 180 : 0)
    return () => { current = false; clearTimeout(timer) }
  // Drafts are independent of external refreshes and search responses.
  }, [active, query, selectedNoteId, refresh, setSelectedNoteId, setDraft, t])

  const captureSource = draft?.source
  const newNote = draft?.newNote
  useEffect(() => { if (active && captureSource) preview.current?.focus() }, [active, captureSource])
  useEffect(() => { if (active && newNote) title.current?.focus() }, [active, newNote])
  useEffect(() => {
    if (!highlight || !active) return
    const article = document.getElementById(`compact-note-entry-${highlight}`)
    article?.scrollIntoView?.({ block: 'nearest' })
    article?.focus({ preventScroll: true })
    const timer = setTimeout(() => setHighlight(undefined), 2400)
    return () => clearTimeout(timer)
  }, [highlight, active])

  const startNew = (): void => {
    if (draft) { setDraft({ ...draft, newNote: true }); return }
    setDraft({ text: '', initialText: '', title: '', initialTitle: '', targetId: '', newNote: true })
  }
  const select = async (noteId: string): Promise<void> => {
    if (draft) { setDraft({ ...draft, targetId: noteId, newNote: false }); setSelectedNoteId(noteId); setSaveError(''); return }
    setSelectedNoteId(noteId)
  }
  const cancel = async (): Promise<void> => {
    if (!await guard(true)) return
    setDraft(undefined)
    setSaveError('')
    if (draft?.source) onCancelCapture()
    else requestAnimationFrame(() => (document.getElementById('compact-note-append') ?? document.getElementById('compact-note-search'))?.focus())
  }
  const save = async (): Promise<void> => {
    if (!draft || !content || !valid || submitting.current) return
    submitting.current = true
    setSaving(true)
    setSaveError('')
    try {
      const saved = draft.newNote
        ? await window.goodbuddy.magicNotes.create({ title: draft.title.trim(), ...(draft.text.trim() ? { content } : {}), source: draft.source })
        : await window.goodbuddy.magicNotes.createEntry({ noteId: draft.targetId, content, source: draft.source })
      setSelectedNoteId(saved.id)
      setDetail(saved)
      setDraft(undefined)
      setHighlight(saved.createdEntryId)
      setRefresh(value => value + 1)
      onNotify({ tone: 'success', message: t(saved.createdEntryId ? 'notifications.entrySaved' : 'notifications.noteCreated') })
      if (commentMode === 'after-save-auto' && saved.createdEntryId) {
        void window.goodbuddy.magicNotes.analyze(saved.createdEntryId, { requestId: crypto.randomUUID(), direction: 'general', format: commentFormat })
          .catch(reason => onNotify({ tone: 'error', message: t('canvas.savedAnalysisFailed', { error: reason instanceof Error ? reason.message : t('errors.operationFailed') }) }))
      }
    } catch (reason) {
      setSaveError(reason instanceof Error && reason.message.includes('笔记不存在') ? t('capture.deletedTarget') : reason instanceof Error ? reason.message : t('errors.operationFailed'))
    } finally { submitting.current = false; setSaving(false) }
  }
  const openWorkspace = async (entryId?: string): Promise<void> => {
    if (!currentDetail || !await guard()) return
    setDraft(undefined)
    onOpenWorkspace(currentDetail.id, entryId)
  }
  const backToList = async (): Promise<void> => {
    if (!await guard()) return
    setDraft(undefined)
    setSelectedNoteId('')
    requestAnimationFrame(() => document.getElementById('compact-note-search')?.focus())
  }
  const validationId = tooLong ? 'compact-note-validation' : undefined
  const titleTooLong = Boolean(draft?.newNote && draft.title.trim().length > 100)
  const list = (
    <>
      <label htmlFor="compact-note-search">{t('capture.search')}</label>
      <input id="compact-note-search" type="search" value={query} maxLength={1000}
        onChange={event => setQuery(event.target.value)} disabled={saving} />
      {loading ? <p role="status">{t('status.loadingNotes')}</p> : notes.length === 0 ? (
        !error && <p>{t(query ? 'capture.noResults' : 'capture.empty')}</p>
      ) : (
        <div className="magic-note-panel__list">
          {notes.map(note => (
            <button type="button" className="magic-note-panel__note" key={note.id}
              aria-pressed={draft?.targetId === note.id && !draft.newNote}
              disabled={saving} onClick={() => void select(note.id)}>
              <strong>{note.pinned && <Pin size={13} aria-label={t('status.pinned')} />}{note.title}</strong>
              <span>{note.preview}</span>
              <time dateTime={note.updatedAt}>{new Date(note.updatedAt).toLocaleString(i18n.language)}</time>
            </button>
          ))}
        </div>
      )}
    </>
  )
  return (
    <section className="magic-note-panel" aria-label={t('capture.quick')} aria-busy={saving}
      onKeyDown={event => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        if (draft) void cancel()
        else if (currentDetail) void backToList()
      }}>
      <header className="magic-note-panel__header">
        <strong>{draft?.source ? t('capture.add') : currentDetail?.title ?? t('page.title')}</strong>
        {(!draft || quickDraft) && currentDetail && (
          <div className="magic-note-panel__actions">
            <button className="icon-button" type="button" title={t('capture.back')}
              aria-label={t('capture.back')} disabled={saving} onClick={() => void backToList()}>
              <ArrowLeft size={16} />
            </button>
            <button className="icon-button" type="button" title={t('capture.openWorkspace')}
              aria-label={t('capture.openWorkspace')} disabled={saving} onClick={() => void openWorkspace()}>
              <ExternalLink size={16} />
            </button>
          </div>
        )}
      </header>
      {error && <p role="alert">{error} <button className="secondary-button" type="button"
        onClick={() => setRefresh(value => value + 1)}>{t('actions.retry')}</button></p>}
      <div className="magic-note-panel__scroll">
        {draft && !quickDraft ? (
          <>
            {draft.source && <div className="magic-note-source">
              <div className="magic-note-panel__source-heading">
                <span>{draft.source.projectName && `${draft.source.projectName} / `}{draft.source.conversationTitle}</span>
                <InlineHelp label={t('capture.scopeHelp')}>
                  {t(draft.source.kind === 'message' ? 'capture.messageScope' : 'capture.conversationScope')}
                </InlineHelp>
              </div>
              {draft.incomplete && <p>{t('capture.incomplete')}</p>}
            </div>}
            <textarea ref={preview} id="compact-note-text" aria-label={t('capture.content')} value={draft.text} disabled={saving}
              aria-describedby={validationId} aria-invalid={tooLong || undefined}
              onChange={event => setDraft({ ...draft, text: event.target.value })} />
            {tooLong && <p id="compact-note-validation">{t('capture.tooLong')}</p>}
            <h3>{t('capture.target')}</h3>
            <SegmentedControl ariaLabel={t('capture.target')} disabled={saving}
              value={draft.newNote ? 'new' : 'existing'}
              options={[{ value: 'existing', label: t('capture.choose') }, { value: 'new', label: t('actions.newNote') }]}
              onChange={value => setDraft({ ...draft, newNote: value === 'new' })} />
            {draft.newNote ? (
              <>
                <label htmlFor="compact-note-title">{t('capture.title')}</label>
                <input ref={title} id="compact-note-title" value={draft.title} disabled={saving}
                  aria-describedby={titleTooLong ? 'compact-note-title-error' : undefined} aria-invalid={titleTooLong || undefined}
                  onChange={event => setDraft({ ...draft, title: event.target.value })} />
                {titleTooLong && <p id="compact-note-title-error">{t('capture.titleTooLong')}</p>}
              </>
            ) : (
              <>
                {draft.targetId && <p>{notes.find(note => note.id === draft.targetId)?.title ??
                  (currentDetail?.id === draft.targetId ? currentDetail.title : t('capture.choose'))}</p>}
                {list}
              </>
            )}
          </>
        ) : currentDetail ? (
          <>
            {currentDetail.entries.length === 0 && <p>{t('notes.emptyEntries')}</p>}
            {currentDetail.entries.map(entry => (
              <article key={entry.id} id={`compact-note-entry-${entry.id}`} tabIndex={-1}
                className={`magic-note-panel__entry${highlight === entry.id ? ' magic-note-panel__entry--highlight' : ''}`}>
                <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString(i18n.language)}</time>
                {entry.source && <MagicNoteSource source={entry.source} onOpen={onOpenSource} />}
                {entry.content.version === 2 && <>
                  <Suspense fallback={<span>{t('status.loading')}</span>}>
                    <MagicCanvasThumbnail content={entry.content} />
                  </Suspense>
                  <span>{t('records.pages', { count: entry.content.pages.length })}</span>
                </>}
                <p className="magic-note-panel__preview">{entry.plainText.slice(0, 600)}{entry.plainText.length > 600 ? '…' : ''}</p>
                <button className="secondary-button" type="button" disabled={saving}
                  onClick={() => void openWorkspace(entry.id)}>{t('capture.openWorkspace')}</button>
              </article>
            ))}
          </>
        ) : (
          <>{list}<button className="secondary-button" type="button" onClick={startNew}>
            <Plus size={14} />{t('actions.newNote')}
          </button></>
        )}
      </div>
      {(draft || currentDetail) && (
        <footer className="magic-note-panel__footer">
          {(!draft || quickDraft) && currentDetail && <>
            <textarea id="compact-note-append" aria-label={t('capture.content')} value={draft?.text ?? ''} disabled={saving}
              aria-describedby={validationId} aria-invalid={tooLong || undefined}
              onChange={event => setDraft(draft ? { ...draft, text: event.target.value } : {
                text: event.target.value, initialText: '', title: '', initialTitle: '', targetId: currentDetail.id, newNote: false
              })} />
          </>}
          {quickDraft && tooLong && <p id="compact-note-validation">{t('capture.tooLong')}</p>}
          <div className="magic-note-panel__submit">
            {saveError && <p role="alert" id="compact-note-save-error">{saveError}</p>}
            <div className="magic-note-panel__actions">
              {draft && <button className="secondary-button" type="button" disabled={saving}
                onClick={() => void cancel()}>{t('actions.cancel')}</button>}
              <button className="primary-button" type="button" disabled={saving || !valid} onClick={() => void save()}>
                {t(saving ? 'capture.saving' : draft?.newNote && !draft.text.trim() && !draft.source ? 'actions.createNote' : 'capture.add')}
              </button>
            </div>
          </div>
        </footer>
      )}
    </section>
  )
}
