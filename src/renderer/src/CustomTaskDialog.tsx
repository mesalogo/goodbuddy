import { CalendarClock, FolderKanban, ShieldCheck, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type {
  AssistantSchedule,
  ScheduleCreateInput
} from '../../shared/assistant-contracts'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import { SegmentedControl } from './WorkspacePrimitives'

export type CustomTaskDestination = 'current' | 'new'

type CustomTaskDialogProps = {
  currentConversationAvailable: boolean
  currentConversationId?: string
  defaultDestination: CustomTaskDestination
  projectId?: string
  projectName: string
  runtimeLabel: string
  workspaceLabel: string
  supportsToolExecution: boolean
  onClose: () => void
  onCreate: (input: ScheduleCreateInput) => Promise<AssistantSchedule>
}

function toLocalDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export function CustomTaskDialog({
  currentConversationAvailable,
  currentConversationId,
  defaultDestination,
  projectId,
  projectName,
  runtimeLabel,
  workspaceLabel,
  supportsToolExecution,
  onClose,
  onCreate
}: CustomTaskDialogProps): React.JSX.Element {
  const { t } = useTranslation('app')
  const dialogRef = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [destination, setDestination] = useState<CustomTaskDestination>(
    defaultDestination === 'current' && currentConversationAvailable
      ? 'current'
      : 'new'
  )
  const [workMode, setWorkMode] =
    useState<ScheduleCreateInput['workMode']>(
      supportsToolExecution ? 'execute' : 'ask'
    )
  const [recurrence, setRecurrence] =
    useState<ScheduleCreateInput['recurrence']>('once')
  const [nextRunAt, setNextRunAt] = useState(() =>
    toLocalDateTimeValue(new Date(Date.now() + 60 * 60 * 1_000))
  )
  const [errors, setErrors] = useState<
    Partial<Record<'title' | 'prompt' | 'destination' | 'nextRunAt' | 'form', string>>
  >({})
  const [submitting, setSubmitting] = useState(false)

  useEffect(
    () => activateModalFocus(() => titleRef.current),
    []
  )

  const destinationOptions = useMemo(
    () => [
      {
        value: 'current' as const,
        label: t('customTask.destination.current'),
        disabled: !currentConversationAvailable
      },
      {
        value: 'new' as const,
        label: t('customTask.destination.new')
      }
    ],
    [currentConversationAvailable, t]
  )

  const submit = async (): Promise<void> => {
    const nextErrors: typeof errors = {}
    if (!title.trim()) {
      nextErrors.title = t('customTask.errors.title')
    }
    if (!prompt.trim()) {
      nextErrors.prompt = t('customTask.errors.instructions')
    }
    if (
      destination === 'current' &&
      (!currentConversationAvailable || !currentConversationId)
    ) {
      nextErrors.destination = t('customTask.errors.destination')
    }
    const runAt = new Date(nextRunAt)
    if (!nextRunAt || Number.isNaN(runAt.getTime())) {
      nextErrors.nextRunAt = t('customTask.errors.time')
    } else if (runAt.getTime() <= Date.now()) {
      nextErrors.nextRunAt = t('customTask.errors.futureTime')
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      return
    }

    setSubmitting(true)
    try {
      await onCreate({
        ...(projectId ? { projectId } : {}),
        ...(destination === 'current' && currentConversationId
          ? { conversationId: currentConversationId }
          : {}),
        title: title.trim(),
        prompt: prompt.trim(),
        workMode,
        recurrence,
        nextRunAt: runAt.toISOString()
      })
      onClose()
    } catch (reason) {
      setErrors((current) => ({
        ...current,
        form:
          reason instanceof Error
            ? reason.message
            : t('customTask.errors.create')
      }))
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div
      className="custom-task-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) {
          onClose()
        }
      }}
    >
      <section
        aria-describedby="custom-task-description"
        aria-labelledby="custom-task-title"
        aria-modal="true"
        className="custom-task-dialog__surface"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !submitting) {
            event.preventDefault()
            onClose()
          } else {
            trapTabFocus(event, dialogRef.current)
          }
        }}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="custom-task-dialog__header">
          <div>
            <span className="custom-task-dialog__eyebrow">
              <CalendarClock aria-hidden="true" size={14} />
              {t('customTask.eyebrow')}
            </span>
            <h2 id="custom-task-title">{t('customTask.title')}</h2>
            <p id="custom-task-description">
              {t('customTask.description')}
            </p>
          </div>
          <button
            aria-label={t('customTask.close')}
            className="icon-button"
            disabled={submitting}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        <div className="custom-task-dialog__content">
          <label className="custom-task-dialog__field">
            <span>{t('customTask.fields.name')}</span>
            <input
              aria-describedby={errors.title ? 'custom-task-title-error' : undefined}
              aria-invalid={Boolean(errors.title)}
              maxLength={120}
              onChange={(event) => {
                setTitle(event.target.value)
                setErrors((current) => ({ ...current, title: undefined }))
              }}
              ref={titleRef}
              value={title}
            />
            {errors.title && (
              <small id="custom-task-title-error" role="alert">
                {errors.title}
              </small>
            )}
          </label>

          <label className="custom-task-dialog__field">
            <span>{t('customTask.fields.instructions')}</span>
            <textarea
              aria-describedby={errors.prompt ? 'custom-task-prompt-error' : undefined}
              aria-invalid={Boolean(errors.prompt)}
              maxLength={100_000}
              onChange={(event) => {
                setPrompt(event.target.value)
                setErrors((current) => ({ ...current, prompt: undefined }))
              }}
              rows={5}
              value={prompt}
            />
            {errors.prompt && (
              <small id="custom-task-prompt-error" role="alert">
                {errors.prompt}
              </small>
            )}
          </label>

          <div className="custom-task-dialog__choice">
            <span>{t('customTask.fields.destination')}</span>
            <SegmentedControl
              ariaLabel={t('customTask.fields.destination')}
              onChange={(value) => {
                setDestination(value)
                setErrors((current) => ({
                  ...current,
                  destination: undefined
                }))
              }}
              options={destinationOptions}
              value={destination}
            />
            <small>
              {destination === 'current'
                ? t('customTask.destination.currentHelp')
                : t('customTask.destination.newHelp')}
            </small>
            {!currentConversationAvailable && (
              <small>{t('customTask.destination.currentUnavailable')}</small>
            )}
            {errors.destination && (
              <small role="alert">{errors.destination}</small>
            )}
          </div>

          <div className="custom-task-dialog__two-columns">
            <div className="custom-task-dialog__choice">
              <span>{t('customTask.fields.mode')}</span>
              <SegmentedControl
                ariaLabel={t('customTask.fields.mode')}
                onChange={setWorkMode}
                options={[
                  {
                    value: 'execute',
                    label: t('customTask.mode.execute'),
                    disabled: !supportsToolExecution
                  },
                  { value: 'ask', label: t('customTask.mode.ask') }
                ]}
                value={workMode}
              />
              {!supportsToolExecution && (
                <small>{t('customTask.mode.executeUnavailable')}</small>
              )}
            </div>
            <label className="custom-task-dialog__field">
              <span>{t('customTask.fields.recurrence')}</span>
              <select
                onChange={(event) =>
                  setRecurrence(
                    event.target.value as ScheduleCreateInput['recurrence']
                  )
                }
                value={recurrence}
              >
                <option value="once">{t('customTask.recurrence.once')}</option>
                <option value="daily">{t('customTask.recurrence.daily')}</option>
                <option value="weekly">{t('customTask.recurrence.weekly')}</option>
              </select>
            </label>
          </div>

          <label className="custom-task-dialog__field">
            <span>{t('customTask.fields.time')}</span>
            <input
              aria-describedby={errors.nextRunAt ? 'custom-task-time-error' : undefined}
              aria-invalid={Boolean(errors.nextRunAt)}
              onChange={(event) => {
                setNextRunAt(event.target.value)
                setErrors((current) => ({
                  ...current,
                  nextRunAt: undefined
                }))
              }}
              type="datetime-local"
              value={nextRunAt}
            />
            {errors.nextRunAt && (
              <small id="custom-task-time-error" role="alert">
                {errors.nextRunAt}
              </small>
            )}
          </label>

          <section
            aria-label={t('customTask.scope.title')}
            className="custom-task-dialog__scope"
          >
            <header>
              <FolderKanban aria-hidden="true" size={16} />
              <strong>{t('customTask.scope.title')}</strong>
            </header>
            <dl>
              <div>
                <dt>{t('customTask.scope.project')}</dt>
                <dd>{projectName}</dd>
              </div>
              <div>
                <dt>{t('customTask.scope.runtime')}</dt>
                <dd>{runtimeLabel}</dd>
              </div>
              <div>
                <dt>{t('customTask.scope.workspace')}</dt>
                <dd>{workspaceLabel}</dd>
              </div>
              <div>
                <dt>{t('customTask.scope.tools')}</dt>
                <dd>
                  <ShieldCheck aria-hidden="true" size={13} />
                  {workMode === 'execute'
                    ? t('customTask.scope.executeApproval')
                    : t('customTask.scope.askReadOnly')}
                </dd>
              </div>
            </dl>
          </section>

          {errors.form && (
            <p className="custom-task-dialog__form-error" role="alert">
              {errors.form}
            </p>
          )}
        </div>

        <footer className="custom-task-dialog__actions">
          <button
            className="secondary-button"
            disabled={submitting}
            onClick={onClose}
            type="button"
          >
            {t('customTask.cancel')}
          </button>
          <button
            className="primary-button"
            disabled={submitting}
            onClick={() => void submit()}
            type="button"
          >
            {submitting
              ? t('customTask.creating')
              : t('customTask.create')}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  )
}
