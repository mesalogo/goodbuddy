import { HeartPulse } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AssistantHeartbeatConfig,
  HeartbeatCreateInput
} from '../../shared/assistant-contracts'
import { DestructiveConfirmActions } from './WorkspacePrimitives'

type HeartbeatSettingsProps = {
  heartbeats: AssistantHeartbeatConfig[]
  variant?: 'settings' | 'sidebar'
  onCreate: (input: HeartbeatCreateInput) => Promise<void>
  onSetPaused: (heartbeatId: string, paused: boolean) => Promise<void>
  onRemove: (heartbeatId: string) => Promise<void>
  onRunNow: (heartbeatId: string) => Promise<void>
}

export function HeartbeatSettings({
  heartbeats,
  variant = 'settings',
  onCreate,
  onSetPaused,
  onRemove,
  onRunNow
}: HeartbeatSettingsProps): React.JSX.Element {
  const { t, i18n } = useTranslation('heartbeat')
  const [time, setTime] = useState('09:00')
  const [recurrence, setRecurrence] = useState<'daily' | 'weekly'>(
    'daily'
  )
  const [weekday, setWeekday] = useState(1)
  const [pendingAction, setPendingAction] = useState<string>()
  const [error, setError] = useState<string>()
  const [confirmingRemoveId, setConfirmingRemoveId] =
    useState<string>()
  const locale = i18n.resolvedLanguage || 'zh-CN'
  const heartbeatStatusLabels: Record<
    NonNullable<AssistantHeartbeatConfig['lastStatus']>,
    string
  > = {
    claimed: t('statuses.run.claimed'),
    completed: t('statuses.run.completed'),
    failed: t('statuses.run.failed'),
    skipped: t('statuses.run.skipped')
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

  return (
    <div className={`heartbeat-settings heartbeat-settings--${variant}`}>
      <div className="heartbeat-settings__intro">
        <h3>
          <HeartPulse size={15} />
          {t('settings.title')}
        </h3>
        <p>{t('settings.description')}</p>
      </div>
      <div
        className={`heartbeat-settings__form${
          recurrence === 'weekly'
            ? ' heartbeat-settings__form--weekly'
            : ''
        }`}
      >
        <select
          aria-label={t('settings.recurrenceAriaLabel')}
          onChange={(event) =>
            setRecurrence(event.target.value as 'daily' | 'weekly')
          }
          value={recurrence}
        >
          <option value="daily">{t('settings.daily')}</option>
          <option value="weekly">{t('settings.weekly')}</option>
        </select>
        {recurrence === 'weekly' && (
          <select
            aria-label={t('settings.weekdayAriaLabel')}
            onChange={(event) => setWeekday(Number(event.target.value))}
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
        )}
        <input
          aria-label={t('settings.timeAriaLabel')}
          onChange={(event) => setTime(event.target.value)}
          type="time"
          value={time}
        />
        <button
          aria-label={t('settings.enableAriaLabel')}
          className="primary-button"
          disabled={!time || pendingAction !== undefined}
          onClick={() =>
            void runAction('create', () =>
              onCreate({
                name: t('settings.defaultName'),
                timezone:
                  Intl.DateTimeFormat().resolvedOptions().timeZone ||
                  'UTC',
                recurrence:
                  recurrence === 'daily'
                    ? {
                        type: 'daily',
                        localTime: time
                      }
                    : {
                        type: 'weekly',
                        localTime: time,
                        weekday
                      },
                enabled: true,
                lookbackHours:
                  recurrence === 'daily' ? 48 : 24 * 14,
                retentionDays: 90
              })
            )
          }
          type="button"
        >
          {pendingAction === 'create'
            ? t('settings.enabling')
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
