import { Check, Pencil, Plus, Tags, Trash2, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  MAGIC_NOTE_MAX_TAGS,
  MAGIC_NOTE_TAG_MAX_LENGTH,
  magicNoteTagKey,
  magicNoteTagNameSchema,
  type MagicNoteTag,
  type MagicNoteTagRenameResult
} from '../../shared/magic-notes-contracts'
import { activateModalFocus, trapTabFocus } from './dialog-focus'

function tagNameError(value: string): string | undefined {
  const result = magicNoteTagNameSchema.safeParse(value)
  return result.success ? undefined : result.error.issues[0]?.message
}

/** Overview filter row: "All" plus one toggle per tag; selecting several narrows to notes with all of them. */
export function MagicNoteTagFilter({
  tags,
  selected,
  disabled,
  onChange
}: {
  tags: MagicNoteTag[]
  selected: string[]
  disabled?: boolean
  onChange: (next: string[]) => void
}): React.JSX.Element | null {
  const { t } = useTranslation('magicNotes')
  if (tags.length === 0) return null
  const selectedKeys = new Set(selected)
  return (
    <div className="magic-note-tag-filter" role="group" aria-label={t('tags.filterLabel')}>
      <button
        type="button"
        className="magic-note-tag-chip magic-note-tag-chip--toggle"
        aria-pressed={selected.length === 0}
        disabled={disabled}
        onClick={() => onChange([])}
      >
        {t('tags.all')}
      </button>
      {tags.map((tag) => {
        const key = magicNoteTagKey(tag.name)
        const active = selectedKeys.has(key)
        return (
          <button
            key={tag.id}
            type="button"
            className="magic-note-tag-chip magic-note-tag-chip--toggle"
            aria-pressed={active}
            aria-label={t('tags.tagWithCount', { name: tag.name, count: tag.noteCount })}
            disabled={disabled}
            onClick={() => onChange(active ? selected.filter((item) => item !== key) : [...selected, key])}
          >
            <span>{tag.name}</span>
            <small aria-hidden="true">{tag.noteCount}</small>
          </button>
        )
      })}
    </div>
  )
}

/** Compact notice shown above the side list while a tag filter is active. */
export function MagicNoteActiveTagFilter({
  names,
  onClear
}: {
  names: string[]
  onClear: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation('magicNotes')
  if (names.length === 0) return null
  return (
    <div className="magic-note-active-tag-filter">
      <span>{t('tags.activeFilter')}</span>
      <span className="magic-note-active-tag-filter__names">{names.join(' · ')}</span>
      <button
        type="button"
        className="icon-button"
        aria-label={t('tags.clearFilter')}
        title={t('tags.clearFilter')}
        onClick={onClear}
      >
        <X aria-hidden="true" size={13} />
      </button>
    </div>
  )
}

/** Read-only tag chips for note cards. */
export function MagicNoteTagChips({
  tags,
  limit = 3
}: {
  tags: string[]
  limit?: number
}): React.JSX.Element | null {
  if (tags.length === 0) return null
  const shown = tags.slice(0, limit)
  return (
    <span className="magic-note-tag-chips">
      {shown.map((tag) => (
        <span className="magic-note-tag-chip" key={tag}>{tag}</span>
      ))}
      {tags.length > shown.length && (
        <span className="magic-note-tag-chip magic-note-tag-chip--more">+{tags.length - shown.length}</span>
      )}
    </span>
  )
}

/** Tag row under the note title: remove with ×, add through a suggestion combobox. */
export function MagicNoteTagEditor({
  tags,
  allTags,
  disabled,
  onChange
}: {
  tags: string[]
  allTags: MagicNoteTag[]
  disabled?: boolean
  onChange: (next: string[]) => Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation('magicNotes')
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()
  const errorId = useId()
  const currentKeys = useMemo(() => new Set(tags.map(magicNoteTagKey)), [tags])
  const trimmed = query.trim()
  const queryKey = magicNoteTagKey(query)
  const options = useMemo(() => {
    const matches = allTags
      .filter((tag) => !currentKeys.has(magicNoteTagKey(tag.name)))
      .filter((tag) => !queryKey || magicNoteTagKey(tag.name).includes(queryKey))
      .slice(0, 8)
      .map((tag) => ({ name: tag.name, create: false }))
    const exact = allTags.some((tag) => magicNoteTagKey(tag.name) === queryKey)
    if (trimmed && !exact && !currentKeys.has(queryKey)) {
      matches.push({ name: trimmed, create: true })
    }
    return matches
  }, [allTags, currentKeys, queryKey, trimmed])
  const atLimit = tags.length >= MAGIC_NOTE_MAX_TAGS

  useEffect(() => {
    if (adding) inputRef.current?.focus()
  }, [adding])

  const close = (restoreFocus: boolean): void => {
    setAdding(false)
    setQuery('')
    setError('')
    setActiveIndex(0)
    if (restoreFocus) requestAnimationFrame(() => addButtonRef.current?.focus())
  }

  const add = async (name: string): Promise<void> => {
    const problem = tagNameError(name)
    if (problem) {
      setError(problem)
      return
    }
    if (currentKeys.has(magicNoteTagKey(name))) {
      setQuery('')
      return
    }
    if (atLimit) {
      setError(t('tags.limitReached', { count: MAGIC_NOTE_MAX_TAGS }))
      return
    }
    if (await onChange([...tags, name.trim()])) {
      setQuery('')
      setError('')
      setActiveIndex(0)
      if (tags.length + 1 >= MAGIC_NOTE_MAX_TAGS) close(true)
      else inputRef.current?.focus()
    }
  }

  return (
    <div className="magic-note-tag-editor">
      <ul className="magic-note-tag-chips" aria-label={t('tags.listLabel')}>
        {tags.map((tag) => (
          <li className="magic-note-tag-chip magic-note-tag-chip--removable" key={tag}>
            <span>{tag}</span>
            <button
              type="button"
              aria-label={t('tags.remove', { name: tag })}
              title={t('tags.remove', { name: tag })}
              disabled={disabled}
              onClick={() => void onChange(tags.filter((item) => item !== tag))}
            >
              <X aria-hidden="true" size={11} />
            </button>
          </li>
        ))}
      </ul>
      {adding ? (
        <div className="magic-note-tag-combobox">
          <input
            ref={inputRef}
            role="combobox"
            aria-label={t('tags.inputLabel')}
            aria-expanded={options.length > 0}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={options[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            placeholder={t('tags.inputPlaceholder')}
            maxLength={MAGIC_NOTE_TAG_MAX_LENGTH}
            disabled={disabled}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
              setError('')
            }}
            onBlur={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.parentElement?.contains(event.relatedTarget)) return
              if (!query.trim()) close(false)
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                if (options.length === 0) return
                const step = event.key === 'ArrowDown' ? 1 : -1
                setActiveIndex((index) => (index + step + options.length) % options.length)
              } else if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
                event.preventDefault()
                const option = options[activeIndex]
                const name = option && (event.key === 'Enter' || option.create) ? option.name : trimmed
                if (name) void add(name)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                close(true)
              }
            }}
          />
          {options.length > 0 && (
            <ul className="magic-note-tag-suggestions" id={listboxId} role="listbox" aria-label={t('tags.suggestionsLabel')}>
              {options.map((option, index) => (
                <li
                  key={`${option.create ? 'new' : 'tag'}-${option.name}`}
                  id={`${listboxId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => void add(option.name)}
                >
                  {option.create ? <Plus aria-hidden="true" size={12} /> : null}
                  {option.create ? t('tags.create', { name: option.name }) : option.name}
                </li>
              ))}
            </ul>
          )}
          {error && <small className="magic-notes-field-error" id={errorId} role="alert">{error}</small>}
        </div>
      ) : (
        <button
          ref={addButtonRef}
          type="button"
          className="magic-note-tag-add"
          aria-label={t('tags.addLabel')}
          title={atLimit ? t('tags.limitReached', { count: MAGIC_NOTE_MAX_TAGS }) : t('tags.addLabel')}
          disabled={disabled || atLimit}
          onClick={() => setAdding(true)}
        >
          <Plus aria-hidden="true" size={12} />
          {t('tags.add')}
        </button>
      )}
    </div>
  )
}

export function MagicNoteTagManagerButton({
  disabled,
  compact,
  onClick
}: {
  disabled?: boolean
  compact?: boolean
  onClick: () => void
}): React.JSX.Element {
  const { t } = useTranslation('magicNotes')
  return (
    <button
      id="magic-note-tag-manager"
      type="button"
      className={compact ? 'icon-button' : 'secondary-button magic-note-tag-manager-button'}
      aria-label={t('tags.manage')}
      title={t('tags.manage')}
      disabled={disabled}
      onClick={onClick}
    >
      <Tags aria-hidden="true" size={15} />
      {!compact && <span>{t('tags.manage')}</span>}
    </button>
  )
}

/** Dialog to rename (merging on name clash) or delete tags across all notes. */
export function MagicNoteTagManager({
  tags,
  onClose,
  onCreate,
  onRename,
  onDelete
}: {
  tags: MagicNoteTag[]
  onClose: () => void
  onCreate: (name: string) => Promise<MagicNoteTag | undefined>
  onRename: (tag: MagicNoteTag, name: string) => Promise<MagicNoteTagRenameResult | undefined>
  onDelete: (tag: MagicNoteTag) => Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation('magicNotes')
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const [editingId, setEditingId] = useState('')
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState('')
  const [deletingId, setDeletingId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => activateModalFocus(() => closeRef.current), [])

  const editing = tags.find((tag) => tag.id === editingId)
  const draftKey = magicNoteTagKey(draft)
  const mergeTarget = editing
    ? tags.find((tag) => tag.id !== editing.id && magicNoteTagKey(tag.name) === draftKey)
    : undefined

  const startRename = (tag: MagicNoteTag): void => {
    setEditingId(tag.id)
    setDeletingId('')
    setDraft(tag.name)
    setError('')
  }

  const submitRename = async (): Promise<void> => {
    if (!editing || busy) return
    const problem = tagNameError(draft)
    if (problem) {
      setError(problem)
      return
    }
    if (draft.trim() === editing.name) {
      setEditingId('')
      return
    }
    setBusy(true)
    const result = await onRename(editing, draft.trim())
    setBusy(false)
    if (result) {
      setEditingId('')
      setError('')
      requestAnimationFrame(() => document.getElementById(`magic-note-tag-rename-${result.tag.id}`)?.focus())
    }
  }

  const confirmDelete = async (tag: MagicNoteTag): Promise<void> => {
    if (busy) return
    setBusy(true)
    const deleted = await onDelete(tag)
    setBusy(false)
    if (deleted) {
      setDeletingId('')
      requestAnimationFrame(() => closeRef.current?.focus())
    }
  }

  const submitCreate = async (): Promise<void> => {
    if (busy) return
    const problem = tagNameError(createDraft)
    if (problem) { setError(problem); return }
    setBusy(true)
    const created = await onCreate(createDraft.trim())
    setBusy(false)
    if (created) {
      setCreateDraft('')
      setCreating(false)
      setError('')
      requestAnimationFrame(() => document.getElementById(`magic-note-tag-rename-${created.id}`)?.focus())
    }
  }

  return createPortal(
    <div className="custom-task-dialog">
      <section
        ref={dialogRef}
        className="custom-task-dialog__surface magic-note-tag-manager"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          trapTabFocus(event, dialogRef.current)
          if (event.key !== 'Escape' || event.defaultPrevented) return
          event.preventDefault()
          if (editingId) setEditingId('')
          else if (deletingId) setDeletingId('')
          else if (!busy) onClose()
        }}
      >
        <header className="custom-task-dialog__header">
          <div>
            <h2 id={titleId}>{t('tags.managerTitle')}</h2>
            <p id={descriptionId}>{t('tags.managerDescription')}</p>
          </div>
          <button ref={closeRef} type="button" className="icon-button" aria-label={t('tags.close')} title={t('tags.close')} disabled={busy} onClick={onClose}>
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <div className="magic-note-tag-manager__body" aria-busy={busy}>
          {creating ? (
            <form className="magic-note-tag-manager__create" onSubmit={(event) => { event.preventDefault(); void submitCreate() }}>
              <input
                autoFocus
                aria-label={t('tags.inputLabel')}
                aria-invalid={Boolean(error)}
                maxLength={MAGIC_NOTE_TAG_MAX_LENGTH}
                placeholder={t('tags.inputPlaceholder')}
                value={createDraft}
                disabled={busy}
                onChange={(event) => { setCreateDraft(event.target.value); setError('') }}
              />
              <button type="submit" className="primary-button" disabled={busy}>{t('tags.createButton')}</button>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => { setCreating(false); setCreateDraft(''); setError('') }}>{t('tags.cancel')}</button>
              {error && <small className="magic-notes-field-error" role="alert">{error}</small>}
            </form>
          ) : (
            <button type="button" className="secondary-button magic-note-tag-manager__create-button" disabled={busy} onClick={() => { setCreating(true); setError('') }}>
              <Plus aria-hidden="true" size={14} />{t('tags.createButton')}
            </button>
          )}
          {tags.length === 0 ? (
            <p className="magic-notes-muted">{t('tags.managerEmpty')}</p>
          ) : (
            <ul className="magic-note-tag-manager__list">
              {tags.map((tag) => (
                <li key={tag.id} className="magic-note-tag-manager__row">
                  {editingId === tag.id ? (
                    <form
                      className="magic-note-tag-manager__rename"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void submitRename()
                      }}
                    >
                      <input
                        autoFocus
                        aria-label={t('tags.renameLabel', { name: tag.name })}
                        aria-invalid={Boolean(error)}
                        aria-describedby={error ? 'magic-note-tag-rename-error' : mergeTarget ? 'magic-note-tag-merge-hint' : undefined}
                        maxLength={MAGIC_NOTE_TAG_MAX_LENGTH}
                        value={draft}
                        disabled={busy}
                        onChange={(event) => {
                          setDraft(event.target.value)
                          setError('')
                        }}
                      />
                      <button type="submit" className="icon-button" aria-label={t('tags.save')} title={t('tags.save')} disabled={busy}>
                        <Check aria-hidden="true" size={14} />
                      </button>
                      <button type="button" className="icon-button" aria-label={t('tags.cancel')} title={t('tags.cancel')} disabled={busy} onClick={() => setEditingId('')}>
                        <X aria-hidden="true" size={14} />
                      </button>
                      {error ? (
                        <small className="magic-notes-field-error" id="magic-note-tag-rename-error" role="alert">{error}</small>
                      ) : mergeTarget ? (
                        <small className="magic-note-tag-manager__hint" id="magic-note-tag-merge-hint">{t('tags.mergeHint', { name: mergeTarget.name })}</small>
                      ) : null}
                    </form>
                  ) : deletingId === tag.id ? (
                    <div className="magic-note-tag-manager__confirm" role="group" aria-label={t('tags.deleteLabel', { name: tag.name })}>
                      <span>{t('tags.deleteConfirm', { name: tag.name, count: tag.noteCount })}</span>
                      <button type="button" className="secondary-button" disabled={busy} onClick={() => setDeletingId('')}>{t('tags.cancel')}</button>
                      <button type="button" className="danger-button" autoFocus disabled={busy} onClick={() => void confirmDelete(tag)}>{t('tags.delete')}</button>
                    </div>
                  ) : (
                    <>
                      <span className="magic-note-tag-chip">{tag.name}</span>
                      <span className="magic-note-tag-manager__count">{t(tag.noteCount === 1 ? 'tags.noteCountOne' : 'tags.noteCountOther', { count: tag.noteCount })}</span>
                      <button id={`magic-note-tag-rename-${tag.id}`} type="button" className="icon-button" aria-label={t('tags.renameLabel', { name: tag.name })} title={t('tags.rename')} disabled={busy} onClick={() => startRename(tag)}>
                        <Pencil aria-hidden="true" size={14} />
                      </button>
                      <button type="button" className="icon-button magic-note-tag-manager__delete" aria-label={t('tags.deleteLabel', { name: tag.name })} title={t('tags.delete')} disabled={busy} onClick={() => { setDeletingId(tag.id); setEditingId('') }}>
                        <Trash2 aria-hidden="true" size={14} />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>,
    document.body
  )
}
