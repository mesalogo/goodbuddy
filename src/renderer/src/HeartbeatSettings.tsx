import { HeartPulse, Pencil } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  heartbeatCreateSchema,
  type AssistantHeartbeatConfig,
  type AssistantProject,
  type HeartbeatCreateInput,
  type HeartbeatUpdateInput
} from '../../shared/assistant-contracts'
import {
  DestructiveConfirmActions,
  SegmentedControl
} from './WorkspacePrimitives'
import { getProjectDisplayText } from './project-display'

type HeartbeatSettingsProps = {
  heartbeats: AssistantHeartbeatConfig[]
  projects: AssistantProject[]
  onCreate: (input: HeartbeatCreateInput) => Promise<void>
  onUpdate: (
    heartbeatId: string,
    input: HeartbeatUpdateInput
  ) => Promise<void>
  onSetPaused: (heartbeatId: string, paused: boolean) => Promise<void>
  onRemove: (heartbeatId: string) => Promise<void>
  onRunNow: (heartbeatId: string) => Promise<void>
}

type ScopeKind = HeartbeatCreateInput['scope']['kind']

export function HeartbeatSettings({
  heartbeats,
  projects,
  onCreate,
  onUpdate,
  onSetPaused,
  onRemove,
  onRunNow
}: HeartbeatSettingsProps): React.JSX.Element {
  const { t, i18n } = useTranslation('heartbeat')
  const { t: tWorkspace } = useTranslation('workspace')
  const [editingId, setEditingId] = useState<string>()
  const [name, setName] = useState(t('settings.defaultName'))
  const [time, setTime] = useState('09:00')
  const [recurrence, setRecurrence] = useState<'daily' | 'weekly'>(
    'daily'
  )
  const [weekday, setWeekday] = useState(1)
  const [scopeKind, setScopeKind] = useState<ScopeKind>('global')
  const [selectedProjectIds, setSelectedProjectIds] = useState<
    string[]
  >([])
  const [lookbackHours, setLookbackHours] = useState(48)
  const [retentionDays, setRetentionDays] = useState(90)
  const [pendingAction, setPendingAction] = useState<string>()
  const [error, setError] = useState<string>()
  const [confirmingRemoveId, setConfirmingRemoveId] =
    useState<string>()
  const locale = i18n.resolvedLanguage || 'zh-CN'
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects]
  )
  const selectableProjects = projects.filter(
    (project) =>
      project.kind === 'user' &&
      (project.status === 'active' ||
        selectedProjectIds.includes(project.id))
  )
  const heartbeatStatusLabels: Record<
    NonNullable<AssistantHeartbeatConfig['lastStatus']>,
    string
  > = {
    claimed: t('statuses.run.claimed'),
    completed: t('statuses.run.completed'),
    failed: t('statuses.run.failed'),
    skipped: t('statuses.run.skipped')
  }

  const resetForm = (): void => {
    setEditingId(undefined)
    setName(t('settings.defaultName'))
    setTime('09:00')
    setRecurrence('daily')
    setWeekday(1)
    setScopeKind('global')
    setSelectedProjectIds([])
    setLookbackHours(48)
    setRetentionDays(90)
  }

  const editHeartbeat = (heartbeat: AssistantHeartbeatConfig): void => {
    setEditingId(heartbeat.id)
    setName(heartbeat.name)
    setTime(heartbeat.recurrence.localTime)
    setRecurrence(heartbeat.recurrence.type)
    setWeekday(
      heartbeat.recurrence.type === 'weekly'
        ? heartbeat.recurrence.weekday
        : 1
    )
    setScopeKind(heartbeat.scope.kind)
    setSelectedProjectIds(
      heartbeat.scope.kind === 'projects'
        ? heartbeat.scope.projectIds
        : []
    )
    setLookbackHours(heartbeat.lookbackHours)
    setRetentionDays(heartbeat.retentionDays)
  }

  const runAction = async (
    actionId: string,
    action: () => Promise<void>
  ): Promise<void> => {
    if (pendingAction) {
      return
    }
    setPendingAction(actionId)
    setError(undefined)
    try {
      await action()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('common.operationFailed')
      )
    } finally {
      setPendingAction(undefined)
    }
  }

  const input = (): HeartbeatCreateInput => ({
    scope:
      scopeKind === 'global'
        ? { kind: 'global' }
        : { kind: 'projects', projectIds: selectedProjectIds },
    name: name.trim(),
    timezone:
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    recurrence:
      recurrence === 'daily'
        ? { type: 'daily', localTime: time }
        : { type: 'weekly', localTime: time, weekday },
    enabled:
      editingId === undefined
        ? true
        : heartbeats.find((heartbeat) => heartbeat.id === editingId)
            ?.enabled ?? true,
    lookbackHours,
    retentionDays
  })

  const hasUnavailableProject = selectedProjectIds.some(
    (projectId) => projectById.get(projectId)?.status !== 'active'
  )
  const formInvalid =
    hasUnavailableProject ||
    !heartbeatCreateSchema.safeParse(input()).success

  const scopeLabel = (heartbeat: AssistantHeartbeatConfig): string => {
    if (heartbeat.scope.kind === 'global') {
      return t('settings.scope.global')
    }
    const names = heartbeat.scope.projectIds.map((projectId) => {
      const project = projectById.get(projectId)
      return project
        ? getProjectDisplayText(project, tWorkspace).name
        : t('settings.scope.unavailableProject')
    })
    return t('settings.scope.selectedProjectsSummary', {
      count: names.length,
      names: names.join(t('settings.scope.nameSeparator'))
    })
  }

  return (
    <div className="heartbeat-settings">
      <div className="heartbeat-settings__intro">
        <h2>
          <HeartPulse size={15} />
          {t('settings.title')}
        </h2>
        <p>{t('settings.description')}</p>
      </div>
      <div className="heartbeat-settings__editor">
        <div className="heartbeat-settings__editor-heading">
          <strong>
            {editingId
              ? t('settings.editTitle')
              : t('settings.createTitle')}
          </strong>
          {editingId && (
            <button
              className="secondary-button"
              disabled={pendingAction !== undefined}
              onClick={resetForm}
              type="button"
            >
              {t('settings.cancelEdit')}
            </button>
          )}
        </div>
        <label className="heartbeat-settings__field">
          <span>{t('settings.nameLabel')}</span>
          <input
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        <fieldset className="heartbeat-settings__scope">
          <legend>{t('settings.scope.legend')}</legend>
          <SegmentedControl
            ariaLabel={t('settings.scope.ariaLabel')}
            disabled={pendingAction !== undefined}
            onChange={setScopeKind}
            options={[
              {
                label: t('settings.scope.global'),
                value: 'global'
              },
              {
                label: t('settings.scope.projects'),
                value: 'projects'
              }
            ]}
            value={scopeKind}
          />
          <p>
            {scopeKind === 'global'
              ? t('settings.scope.globalHelp')
              : t('settings.scope.projectsHelp')}
          </p>
          {scopeKind === 'projects' && (
            <div className="heartbeat-settings__project-list">
              {selectableProjects.length === 0 ? (
                <small>{t('settings.scope.noProjects')}</small>
              ) : (
                selectableProjects.map((project) => (
                  <label key={project.id}>
                    <input
                      checked={selectedProjectIds.includes(project.id)}
                      disabled={pendingAction !== undefined}
                      onChange={(event) =>
                        setSelectedProjectIds((current) =>
                          event.target.checked
                            ? [...current, project.id]
                            : current.filter((id) => id !== project.id)
                        )
                      }
                      type="checkbox"
                    />
                    <span>
                      {getProjectDisplayText(project, tWorkspace).name}
                    </span>
                    {project.status !== 'active' && (
                      <small>{t('settings.scope.archived')}</small>
                    )}
                  </label>
                ))
              )}
            </div>
          )}
          {scopeKind === 'projects' && hasUnavailableProject && (
            <small className="heartbeat-settings__field-error">
              {t('settings.scope.removeArchived')}
            </small>
          )}
        </fieldset>
        <div
          className={`heartbeat-settings__form${
            recurrence === 'weekly'
              ? ' heartbeat-settings__form--weekly'
              : ''
          }`}
        >
          <label className="heartbeat-settings__field">
            <span>{t('settings.recurrenceLabel')}</span>
            <select
              aria-label={t('settings.recurrenceAriaLabel')}
              onChange={(event) =>
                setRecurrence(
                  event.target.value as 'daily' | 'weekly'
                )
              }
              value={recurrence}
            >
              <option value="daily">{t('settings.daily')}</option>
              <option value="weekly">{t('settings.weekly')}</option>
            </select>
          </label>
          {recurrence === 'weekly' && (
            <label className="heartbeat-settings__field">
              <span>{t('settings.weekdayLabel')}</span>
              <select
                aria-label={t('settings.weekdayAriaLabel')}
                onChange={(event) =>
                  setWeekday(Number(event.target.value))
                }
                value={weekday}
              >
                <option value={1}>{t('center.weekdays.monday')}</option>
                <option value={2}>{t('center.weekdays.tuesday')}</option>
                <option value={3}>{t('center.weekdays.wednesday')}</option>
                <option value={4}>{t('center.weekdays.thursday')}</option>
                <option value={5}>{t('center.weekdays.friday')}</option>
                <option value={6}>{t('center.weekdays.saturday')}</option>
                <option value={0}>{t('center.weekdays.sunday')}</option>
              </select>
            </label>
          )}
          <label className="heartbeat-settings__field">
            <span>{t('settings.timeLabel')}</span>
            <input
              aria-label={t('settings.timeAriaLabel')}
              onChange={(event) => setTime(event.target.value)}
              type="time"
              value={time}
            />
          </label>
          <label className="heartbeat-settings__field">
            <span>{t('settings.lookbackLabel')}</span>
            <input
              aria-label={t('settings.lookbackAriaLabel')}
              max={720}
              min={1}
              onChange={(event) =>
                setLookbackHours(Number(event.target.value))
              }
              type="number"
              value={lookbackHours}
            />
          </label>
          <label className="heartbeat-settings__field">
            <span>{t('settings.retentionLabel')}</span>
            <input
              aria-label={t('settings.retentionAriaLabel')}
              max={365}
              min={1}
              onChange={(event) =>
                setRetentionDays(Number(event.target.value))
              }
              type="number"
              value={retentionDays}
            />
          </label>
        </div>
        <button
          aria-label={
            editingId
              ? t('settings.saveAriaLabel')
              : t('settings.enableAriaLabel')
          }
          className="primary-button heartbeat-settings__submit"
          disabled={formInvalid || pendingAction !== undefined}
          onClick={() =>
            void runAction(editingId ? `edit:${editingId}` : 'create', async () => {
              if (editingId) {
                await onUpdate(editingId, input())
              } else {
                await onCreate(input())
              }
              resetForm()
            })
          }
          type="button"
        >
          {pendingAction === 'create'
            ? t('settings.enabling')
            : editingId
              ? t('settings.save')
              : t('settings.enable')}
        </button>
      </div>
      {error && (
        <p className="heartbeat-settings__error" role="alert">
          {error}
        </p>
      )}
      {heartbeats.length === 0 ? (
        <p className="heartbeat-settings__empty">
          {t('settings.empty')}
        </p>
      ) : (
        <div className="heartbeat-settings__list">
          {heartbeats.map((heartbeat) => (
            <article
              className="heartbeat-settings__item"
              key={heartbeat.id}
            >
              <span>
                <strong>{heartbeat.name}</strong>
                <small>{scopeLabel(heartbeat)}</small>
                <small>
                  {heartbeat.enabled
                    ? t('settings.running')
                    : t('settings.paused')}{' '}
                  ·{' '}
                  {t('settings.next', {
                    date: new Date(
                      heartbeat.nextRunAt
                    ).toLocaleString(locale)
                  })}
                  {heartbeat.lastStatus
                    ? ` · ${t('settings.last', {
                        status:
                          heartbeatStatusLabels[heartbeat.lastStatus]
                      })}`
                    : ''}
                </small>
              </span>
              <div className="heartbeat-settings__actions">
                <button
                  aria-label={t('settings.editAriaLabel', {
                    name: heartbeat.name
                  })}
                  disabled={pendingAction !== undefined}
                  onClick={() => editHeartbeat(heartbeat)}
                  type="button"
                >
                  <Pencil aria-hidden="true" size={12} />
                  {t('settings.edit')}
                </button>
                <button
                  aria-label={t(
                    heartbeat.enabled
                      ? 'settings.pauseAriaLabel'
                      : 'settings.resumeAriaLabel',
                    { name: heartbeat.name }
                  )}
                  disabled={pendingAction !== undefined}
                  onClick={() =>
                    void runAction(
                      `pause:${heartbeat.id}`,
                      () =>
                        onSetPaused(
                          heartbeat.id,
                          heartbeat.enabled
                        )
                    )
                  }
                  type="button"
                >
                  {heartbeat.enabled
                    ? t('settings.pause')
                    : t('settings.resume')}
                </button>
                <button
                  aria-label={t('settings.runNowAriaLabel', {
                    name: heartbeat.name
                  })}
                  disabled={pendingAction !== undefined}
                  onClick={() =>
                    void runAction(`run:${heartbeat.id}`, () =>
                      onRunNow(heartbeat.id)
                    )
                  }
                  type="button"
                >
                  {t('settings.runNow')}
                </button>
                <DestructiveConfirmActions
                  cancelAriaLabel={t(
                    'settings.cancelDeleteAriaLabel',
                    { name: heartbeat.name }
                  )}
                  confirmAriaLabel={t(
                    'settings.confirmDeleteAriaLabel',
                    { name: heartbeat.name }
                  )}
                  confirmLabel={t('settings.confirmDelete')}
                  confirming={confirmingRemoveId === heartbeat.id}
                  disabled={pendingAction !== undefined}
                  message={t('settings.deleteMessage')}
                  onCancel={() => setConfirmingRemoveId(undefined)}
                  onConfirm={() =>
                    void runAction(
                      `remove:${heartbeat.id}`,
                      async () => {
                        await onRemove(heartbeat.id)
                        if (editingId === heartbeat.id) {
                          resetForm()
                        }
                        setConfirmingRemoveId(undefined)
                      }
                    )
                  }
                  onRequestConfirm={() =>
                    setConfirmingRemoveId(heartbeat.id)
                  }
                  triggerAriaLabel={t('settings.deleteAriaLabel', {
                    name: heartbeat.name
                  })}
                  triggerLabel={t('settings.delete')}
                />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
