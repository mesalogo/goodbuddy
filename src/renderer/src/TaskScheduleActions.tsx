import {
  ClockFading,
  Pause,
  Play,
  Trash2
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AssistantSchedule,
  AssistantTask
} from '../../shared/assistant-contracts'
import { DestructiveConfirmActions } from './WorkspacePrimitives'

export function findTaskSchedule(
  task: AssistantTask,
  schedules: readonly AssistantSchedule[]
): AssistantSchedule | undefined {
  return schedules.find(
    (schedule) =>
      schedule.id === task.scheduleId || schedule.taskId === task.id
  )
}

type TaskScheduleActionsProps = {
  onError: (message: string) => void
  onRemoveSchedule: (scheduleId: string) => Promise<void>
  onRunSchedule: (scheduleId: string) => Promise<void>
  onSetScheduleEnabled: (
    scheduleId: string,
    enabled: boolean
  ) => Promise<void>
  schedule: AssistantSchedule
  taskTitle: string
}

export function TaskScheduleActions({
  onError,
  onRemoveSchedule,
  onRunSchedule,
  onSetScheduleEnabled,
  schedule,
  taskTitle
}: TaskScheduleActionsProps): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const [busy, setBusy] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const runAction = async (
    action: () => Promise<void>,
    fallback: string
  ): Promise<void> => {
    setBusy(true)
    onError('')
    try {
      await action()
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : fallback)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        disabled={busy}
        onClick={() =>
          void runAction(
            () => onRunSchedule(schedule.id),
            t('sidebar.errors.runSchedule')
          )
        }
        type="button"
      >
        <Play aria-hidden="true" size={12} />
        {t('sidebar.tasks.schedule.runNow')}
      </button>
      {(schedule.recurrence !== 'once' || !schedule.lastRunAt) && (
        <button
          disabled={busy}
          onClick={() =>
            void runAction(
              () =>
                onSetScheduleEnabled(schedule.id, !schedule.enabled),
              t('sidebar.errors.updateSchedule')
            )
          }
          type="button"
        >
          {schedule.enabled ? (
            <Pause aria-hidden="true" size={12} />
          ) : (
            <ClockFading aria-hidden="true" size={12} />
          )}
          {schedule.enabled
            ? t('task.actions.pause')
            : t('task.actions.resume')}
        </button>
      )}
      <DestructiveConfirmActions
        cancelAriaLabel={t('sidebar.tasks.schedule.cancelDelete')}
        confirmAriaLabel={t(
          'sidebar.tasks.schedule.confirmDelete',
          { title: taskTitle }
        )}
        confirmLabel={t(
          'sidebar.tasks.schedule.confirmDeleteAction'
        )}
        confirming={confirmingDelete}
        disabled={busy}
        icon={<Trash2 aria-hidden="true" size={12} />}
        message={t('sidebar.tasks.schedule.deleteMessage')}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => {
          setConfirmingDelete(false)
          void runAction(
            () => onRemoveSchedule(schedule.id),
            t('sidebar.errors.deleteSchedule')
          )
        }}
        onRequestConfirm={() => setConfirmingDelete(true)}
        triggerLabel={t('sidebar.tasks.schedule.delete')}
      />
    </>
  )
}
