import { ClockFading, FolderKanban, ShieldCheck, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type {
  AssistantSchedule,
  ScheduleCreateInput
} from '../../shared/assistant-contracts'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import { SegmentedControl } from './WorkspacePrimitives'
import { InlineHelp } from './InlineHelp'
import './custom-task-dialog.css'

export type CustomTaskDestination = 'current' | 'new'
// App translates the UI execution choice into the schedule creation request.
export type CustomTaskCreateOptions = { runImmediately?: boolean }
export type CustomTaskConversation = {
  id: string
  title: string
  projectId?: string
}

const emptyConversations: readonly CustomTaskConversation[] = []

type CustomTaskDialogProps = {
  currentConversationAvailable: boolean
  currentConversationId?: string
  defaultDestination?: CustomTaskDestination
  conversations?: readonly CustomTaskConversation[]
  projectId?: string
  projectName: string
  workspaceLabel: string
  onClose: () => void
  onCreate: (
    input: ScheduleCreateInput,
    options?: CustomTaskCreateOptions
  ) => Promise<AssistantSchedule>
}

function toLocalDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export function CustomTaskDialog({
  currentConversationAvailable,
  currentConversationId,
  defaultDestination = 'current',
  conversations = emptyConversations,
  projectId,
  projectName,
  workspaceLabel,
  onClose,
  onCreate
}: CustomTaskDialogProps): React.JSX.Element {
  const { t } = useTranslation('app')
  const dialogRef = useRef<HTMLElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const submittingRef = useRef(false)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [destination, setDestination] = useState<string>(
    defaultDestination === 'current' &&
      currentConversationAvailable && currentConversationId
      ? 'current'
      : 'new'
  )
  const [timing, setTiming] = useState<'now' | 'scheduled'>('now')
  const [recurrence, setRecurrence] =
    useState<ScheduleCreateInput['recurrence']>('once')
  const [nextRunAt, setNextRunAt] = useState(() =>
    toLocalDateTimeValue(new Date(Date.now() + 60 * 60 * 1_000))
  )
  const [errors, setErrors] = useState<
    Partial<Record<'prompt' | 'destination' | 'nextRunAt' | 'form', string>>
  >({})
  const [submitting, setSubmitting] = useState(false)

  useEffect(
    () => activateModalFocus(() => promptRef.current),
    []
  )

  const otherConversations = useMemo(
    () => conversations.filter((conversation) =>
      conversation.projectId === projectId &&
      conversation.id !== currentConversationId
    ),
    [conversations, projectId, currentConversationId]
  )
  const generatedTitle = prompt.trim().replace(/\s+/gu, ' ').slice(0, 120)

  const submit = async (): Promise<void> => {
    if (submittingRef.current) return
    const nextErrors: typeof errors = {}
    if (!prompt.trim()) {
      nextErrors.prompt = t('customTask.errors.instructions')
    }
    if (
      (destination === 'current' &&
        (!currentConversationAvailable || !currentConversationId)) ||
      (destination !== 'current' && destination !== 'new' &&
        !otherConversations.some((conversation) => conversation.id === destination))
    ) {
      nextErrors.destination = t('customTask.errors.destination')
    }
    const runAt = timing === 'now' ? new Date() : new Date(nextRunAt)
    if (Number.isNaN(runAt.getTime())) {
      nextErrors.nextRunAt = t('customTask.errors.time')
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      return
    }

    submittingRef.current = true
    setSubmitting(true)
    try {
      await onCreate(
        {
          ...(projectId ? { projectId } : {}),
          ...(destination !== 'new'
            ? { conversationId: destination === 'current' ? currentConversationId : destination }
            : {}),
          title: title.trim() || generatedTitle,
          prompt: prompt.trim(),
          recurrence: timing === 'now' ? 'once' : recurrence,
          nextRunAt: runAt.toISOString()
        },
        { runImmediately: timing === 'now' }
      )
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
      submittingRef.current = false
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
              <ClockFading aria-hidden="true" size={14} />
              {t('customTask.eyebrow')}
            </span>
            <div className="inline-help-label">
              <h2 id="custom-task-title">{t('customTask.title')}</h2>
              <InlineHelp label={t('customTask.title')}>{t('customTask.description')}</InlineHelp>
            </div>
            <span className="sr-only" id="custom-task-description">
              {t('customTask.description')}
            </span>
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

        <fieldset
          className="custom-task-dialog__content custom-task-dialog__form"
          disabled={submitting}
        >
          <label className="custom-task-dialog__field">
            <span id="custom-task-prompt-label">{t('customTask.fields.instructions')}</span>
            <textarea
              aria-labelledby="custom-task-prompt-label"
              aria-describedby={errors.prompt ? 'custom-task-prompt-error' : undefined}
              aria-invalid={Boolean(errors.prompt)}
              aria-required="true"
              maxLength={100_000}
              onChange={(event) => {
                setPrompt(event.target.value)
                setErrors((current) => ({ ...current, prompt: undefined }))
              }}
              rows={5}
              ref={promptRef}
              value={prompt}
            />
            {errors.prompt && (
              <small id="custom-task-prompt-error" role="alert">
                {errors.prompt}
              </small>
            )}
          </label>

          <div className="custom-task-dialog__field">
            <div className="inline-help-label">
              <label htmlFor="custom-task-name" id="custom-task-name-label">{t('customTask.fields.name')}</label>
              <small>{t('applications.optional')}</small>
              <InlineHelp label={t('customTask.fields.name')}>{t('customTask.nameHelp')}</InlineHelp>
            </div>
            <input
              id="custom-task-name"
              aria-labelledby="custom-task-name-label"
              aria-describedby="custom-task-name-help"
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={generatedTitle}
              value={title}
            />
            <span className="sr-only" id="custom-task-name-help">{t('customTask.nameHelp')}</span>
          </div>

          <label className="custom-task-dialog__field">
            <span id="custom-task-destination-label">{t('customTask.fields.destination')}</span>
            <select
              aria-labelledby="custom-task-destination-label"
              aria-describedby={errors.destination ? 'custom-task-destination-error' : 'custom-task-destination-help'}
              aria-invalid={Boolean(errors.destination)}
              onChange={(event) => {
                setDestination(event.target.value)
                setErrors((current) => ({
                  ...current,
                  destination: undefined
                }))
              }}
              value={destination}
            >
              <option value="current" disabled={!currentConversationAvailable || !currentConversationId}>
                {t('customTask.destination.current')}
              </option>
              {otherConversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>{conversation.title}</option>
              ))}
              <option value="new">{t('customTask.destination.new')}</option>
            </select>
            <small id="custom-task-destination-help">
              {destination === 'new'
                ? t('customTask.destination.newHelp')
                : t('customTask.destination.currentHelp')}
            </small>
            {(!currentConversationAvailable || !currentConversationId) && (
              <small>{t('customTask.destination.currentUnavailable')}</small>
            )}
            {errors.destination && (
              <small id="custom-task-destination-error" role="alert">{errors.destination}</small>
            )}
          </label>

          <div className="custom-task-dialog__choice">
            <span>{t('customTask.fields.timing')}</span>
            <SegmentedControl
              ariaLabel={t('customTask.fields.timing')}
              onChange={(value) => {
                setTiming(value)
                setErrors((current) => ({ ...current, nextRunAt: undefined }))
              }}
              options={[
                { value: 'now', label: t('customTask.timing.now'), disabled: submitting },
                { value: 'scheduled', label: t('customTask.timing.scheduled'), disabled: submitting }
              ]}
              value={timing}
            />
          </div>

          {timing === 'scheduled' && (
            <>
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

              <label className="custom-task-dialog__field">
                <span id="custom-task-time-label">{t('customTask.fields.time')}</span>
                <input
                  aria-labelledby="custom-task-time-label"
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
            </>
          )}

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
                <dt>{t('customTask.scope.workspace')}</dt>
                <dd>{workspaceLabel}</dd>
              </div>
              <div>
                <dt>{t('customTask.scope.tools')}</dt>
                <dd>
                  <ShieldCheck aria-hidden="true" size={13} />
                  {t('customTask.scope.conversationSettings')}
                </dd>
              </div>
            </dl>
          </section>

          {errors.form && (
            <p className="custom-task-dialog__form-error" role="alert">
              {errors.form}
            </p>
          )}
        </fieldset>

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
