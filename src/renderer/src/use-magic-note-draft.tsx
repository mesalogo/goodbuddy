import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { MagicNoteSource } from '../../shared/magic-notes-contracts'
import { activateModalFocus, trapTabFocus } from './dialog-focus'

export type MagicNoteDraft = {
  text: string
  title: string
  targetId: string
  newNote: boolean
  source?: MagicNoteSource
  incomplete?: boolean
  initialText: string
  initialTitle: string
}

export function useMagicNoteDraft() {
  const [draft, setDraft] = useState<MagicNoteDraft>()
  const [saving, setSaving] = useState(false)
  const [selectedNoteId, setSelectedNoteId] = useState('')
  const [confirmation, setConfirmation] = useState<{ resolve: (discard: boolean) => void }>()
  const pendingGuard = useRef<Promise<boolean> | undefined>(undefined)
  const current = useRef({ draft, saving })
  useLayoutEffect(() => { current.current = { draft, saving } }, [draft, saving])
  const guard = useCallback(async (onlyModified = false): Promise<boolean> => {
    const { draft: value, saving: busy } = current.current
    if (busy) return false
    if (!value || (onlyModified && value.text === value.initialText && value.title === value.initialTitle)) return true
    if (!value.source && !value.text && !value.title) return true
    if (!pendingGuard.current) pendingGuard.current = new Promise<boolean>(resolve => setConfirmation({ resolve }))
    return pendingGuard.current
  }, [])
  // The result keeps its identity while nothing in it changes, so views that
  // receive it (the notes panel) can skip re-rendering with their parent.
  return useMemo(() => {
    const finishGuard = (discard: boolean): void => {
      if (discard) { current.current = { ...current.current, draft: undefined }; setDraft(undefined) }
      confirmation?.resolve(discard)
      setConfirmation(undefined)
      pendingGuard.current = undefined
    }
    return { draft, setDraft, saving, setSaving, selectedNoteId, setSelectedNoteId, guard,
      confirmation: confirmation ? <MagicNoteDraftConfirmation onResolve={finishGuard} /> : null }
  }, [confirmation, draft, guard, saving, selectedNoteId])
}

function MagicNoteDraftConfirmation({ onResolve }: { onResolve: (discard: boolean) => void }): React.JSX.Element {
  const { t } = useTranslation('magicNotes')
  const dialog = useRef<HTMLElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => activateModalFocus(() => cancel.current), [])
  return createPortal(<div className="custom-task-dialog" onMouseDown={event => { if (event.target === event.currentTarget) onResolve(false) }}>
    <section className="custom-task-dialog__surface" role="dialog" aria-modal="true" aria-labelledby="note-draft-title" aria-describedby="note-draft-description" ref={dialog} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onResolve(false) }
      else trapTabFocus(event, dialog.current)
    }}>
      <header className="custom-task-dialog__header"><h2 id="note-draft-title">{t('confirmations.discardDraftTitle')}</h2><button type="button" className="icon-button" aria-label={t('actions.cancel')} onClick={() => onResolve(false)}><X size={16} /></button></header>
      <div className="custom-task-dialog__content" id="note-draft-description">{t('confirmations.discardDraftDescription')}</div>
      <footer className="custom-task-dialog__actions"><button className="secondary-button" type="button" ref={cancel} onClick={() => onResolve(false)}>{t('actions.continueEditing')}</button><button className="danger-solid" type="button" onClick={() => onResolve(true)}>{t('actions.discardAndSwitch')}</button></footer>
    </section>
  </div>, document.body)
}
