import type {
  KnowledgeWorkspaceProps,
  KnowledgeStorageMode,
  KnowledgeGraphStrategy,
  KnowledgeLibrary
} from './types'
import { useTranslation } from 'react-i18next'
import { useState, useId, useRef, useEffect } from 'react'
import { toErrorMessage, strategyLabelKeys } from './helpers'
import { InlineHelp } from '../InlineHelp'
import { LoaderCircle, Check, AlertCircle, Trash2 } from 'lucide-react'
import { activateModalFocus, trapTabFocus } from '../dialog-focus'
import { createPortal } from 'react-dom'

export function CreateLibraryWizard({
  onCancel,
  onCreate
}: {
  onCancel: () => void
  onCreate: KnowledgeWorkspaceProps['onCreateLibrary']
}): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [storageMode, setStorageMode] =
    useState<KnowledgeStorageMode>('reference')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const advancedId = useId()
  const [graphEnabled, setGraphEnabled] = useState(false)
  const [graphStrategy, setGraphStrategy] =
    useState<KnowledgeGraphStrategy>('rules')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault()
    if (!name.trim()) {
      setError(t('validation.libraryNameRequired'))
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim(),
        storageMode,
        graphEnabled,
        graphStrategy
      })
      onCancel()
    } catch (reason) {
      setError(toErrorMessage(reason, t))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      aria-label={t('create.ariaLabel')}
      className="knowledge-create"
      onSubmit={(event) => void submit(event)}
    >
      <div>
        <span className="knowledge-create__eyebrow">
          {t('create.eyebrow')}
        </span>
        <h2 className="knowledge-create__title">
          {t('create.title')}
        </h2>
        <p className="knowledge-section-description">
          {t('create.description')}
        </p>
      </div>
      <label className="knowledge-field">
        {t('fields.name')}
        <input
          autoFocus
          onChange={(event) => setName(event.currentTarget.value)}
          value={name}
        />
      </label>
      <label className="knowledge-field">
        {t('fields.description')}
        <textarea
          onChange={(event) =>
            setDescription(event.currentTarget.value)
          }
          rows={3}
          value={description}
        />
      </label>
      <div className="inline-help-label">
      <details className="knowledge-create__advanced" open={advancedOpen}>
        <summary aria-controls={advancedOpen ? advancedId : undefined} onClick={(event) => {
          event.preventDefault()
          setAdvancedOpen(!advancedOpen)
        }}>
          <span>
            <strong>{t('create.advanced')}</strong>
          </span>
        </summary>
      </details>
      <InlineHelp label={t('create.advanced')}>{t('create.advancedDescription')}</InlineHelp>
      </div>
      {advancedOpen && (
        <div className="knowledge-create__advanced-content" id={advancedId}>
      <fieldset className="knowledge-create__storage">
        <legend>
          {t('fields.storageMode')}
        </legend>
        {(
          [
            [
              'reference',
              t('storageModes.reference.label'),
              t('storageModes.reference.description')
            ],
            [
              'managed',
              t('storageModes.managed.label'),
              t('storageModes.managed.description')
            ]
          ] as const
        ).map(([value, title, detail]) => (
          <label
            className="knowledge-create__storage-option"
            key={value}
          >
            <input
              checked={storageMode === value}
              name="storage-mode"
              onChange={() => setStorageMode(value)}
              type="radio"
            />
            <span>
              <strong>{title}</strong>
              <span className="knowledge-muted">{detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label
        className="knowledge-create__graph-toggle toggle-row"
      >
        <input
          checked={graphEnabled}
          onChange={(event) => setGraphEnabled(event.currentTarget.checked)}
          role="switch"
          type="checkbox"
        />
        <span>
          <strong>
            {t('graph.enable')}
          </strong>
          <span className="knowledge-muted">{t('graph.enableDescription')}</span>
        </span>
      </label>
      {graphEnabled && (
        <label className="knowledge-field">
          {t('fields.graphGenerationStrategy')}
          <select
            onChange={(event) =>
              setGraphStrategy(
                event.currentTarget.value as KnowledgeGraphStrategy
              )
            }
            value={graphStrategy}
          >
            {Object.entries(strategyLabelKeys).map(([value, key]) => (
              <option key={value} value={value}>
                {t(key)}
              </option>
            ))}
          </select>
        </label>
      )}
        </div>
      )}
      {error && (
        <p
          aria-live="polite"
          className="knowledge-create__error"
          role="alert"
        >
          {error}
        </p>
      )}
      <div className="knowledge-create__actions">
        <button
          className="secondary-button"
          onClick={onCancel}
          type="button"
        >
          {t('actions.cancel')}
        </button>
        <button
          className="primary-button"
          disabled={saving}
          type="submit"
        >
          {saving ? (
            <LoaderCircle aria-hidden="true" size={16} />
          ) : (
            <Check aria-hidden="true" size={16} />
          )}
          {saving ? t('actions.creating') : t('actions.createLibrary')}
        </button>
      </div>
    </form>
  )
}

export function EditLibraryDialog({
  library,
  onCancel,
  onConfirm
}: {
  library: KnowledgeLibrary
  onCancel: () => void
  onConfirm: (update: {
    name: string
    description: string
  }) => void | Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const [name, setName] = useState(library.name)
  const [description, setDescription] = useState(library.description ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(
    () => activateModalFocus(() => nameRef.current),
    []
  )

  const submit = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault()
    const normalizedName = name.trim()
    if (!normalizedName) {
      setError(t('validation.libraryNameRequired'))
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      await onConfirm({
        name: normalizedName,
        description: description.trim()
      })
      onCancel()
    } catch (reason) {
      setError(toErrorMessage(reason, t))
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div
      aria-label={t('edit.ariaLabel')}
      aria-modal="true"
      className="knowledge-library-dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) {
          event.preventDefault()
          onCancel()
          return
        }
        trapTabFocus(event, dialogRef.current)
      }}
      ref={dialogRef}
      role="dialog"
    >
      <form
        aria-label={t('edit.formAriaLabel')}
        className="knowledge-library-dialog"
        onSubmit={(event) => void submit(event)}
      >
        <div>
          <h2>{t('edit.title')}</h2>
          <p className="knowledge-library-dialog__description">
            {t('edit.description')}
          </p>
        </div>
        <label className="knowledge-field">
          {t('fields.name')}
          <input
            onChange={(event) => setName(event.currentTarget.value)}
            ref={nameRef}
            value={name}
          />
        </label>
        <label className="knowledge-field">
          {t('fields.description')}
          <textarea
            onChange={(event) => setDescription(event.currentTarget.value)}
            rows={4}
            value={description}
          />
        </label>
        {error && (
          <p className="knowledge-inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="knowledge-library-dialog__actions">
          <button
            className="secondary-button"
            disabled={saving}
            onClick={onCancel}
            type="button"
          >
            {t('actions.cancel')}
          </button>
          <button
            className="primary-button"
            disabled={saving}
            type="submit"
          >
            {saving ? (
              <LoaderCircle aria-hidden="true" size={15} />
            ) : (
              <Check aria-hidden="true" size={15} />
            )}
            {saving ? t('actions.saving') : t('actions.saveChanges')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  )
}

export function DeleteLibraryDialog({
  library,
  onCancel,
  onConfirm
}: {
  library: KnowledgeLibrary
  onCancel: () => void
  onConfirm: () => void | Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string>()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(
    () => activateModalFocus(() => cancelRef.current),
    []
  )

  const confirm = async (): Promise<void> => {
    setDeleting(true)
    setError(undefined)
    try {
      await onConfirm()
      onCancel()
    } catch (reason) {
      setError(toErrorMessage(reason, t))
    } finally {
      setDeleting(false)
    }
  }

  return createPortal(
    <div
      aria-label={t('delete.ariaLabel')}
      aria-modal="true"
      className="knowledge-library-dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !deleting) {
          event.preventDefault()
          onCancel()
          return
        }
        trapTabFocus(event, dialogRef.current)
      }}
      ref={dialogRef}
      role="dialog"
    >
      <div
        className="knowledge-library-dialog knowledge-library-dialog--delete"
      >
        <AlertCircle color="var(--danger)" aria-hidden="true" size={26} />
        <h2>
          {t('delete.title', { name: library.name })}
        </h2>
        <p className="knowledge-library-dialog__description">
          {library.storageMode === 'managed'
            ? t('delete.managedDescription')
            : t('delete.referenceDescription')}
        </p>
        {error && (
          <p
            aria-live="polite"
            className="knowledge-inline-error"
            role="alert"
          >
            {error}
          </p>
        )}
        <div className="knowledge-library-dialog__actions">
          <button
            className="secondary-button"
            disabled={deleting}
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            {t('actions.cancel')}
          </button>
          <button
            className="danger-button"
            disabled={deleting}
            onClick={() => void confirm()}
            type="button"
          >
            <Trash2 aria-hidden="true" size={15} />
            {deleting ? t('actions.deleting') : t('actions.confirmDelete')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
