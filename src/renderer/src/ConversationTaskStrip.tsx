import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  ListTodo,
  Plus
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AssistantSchedule,
  AssistantTask
} from '../../shared/assistant-contracts'
import {
  findTaskSchedule,
  TaskScheduleActions
} from './TaskScheduleActions'

type ConversationTaskStripProps = {
  locale: string
  onCreate: () => void
  onRemoveSchedule: (scheduleId: string) => Promise<void>
  onRunSchedule: (scheduleId: string) => Promise<void>
  onSelectTask: (taskId: string) => void
  onSetScheduleEnabled: (
    scheduleId: string,
    enabled: boolean
  ) => Promise<void>
  schedules: AssistantSchedule[]
  selectedTaskId?: string
  tasks: AssistantTask[]
}

export function ConversationTaskStrip({
  locale,
  onCreate,
  onRemoveSchedule,
  onRunSchedule,
  onSelectTask,
  onSetScheduleEnabled,
  schedules,
  selectedTaskId,
  tasks
}: ConversationTaskStripProps): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const [manuallyExpanded, setManuallyExpanded] = useState(false)
  const [collapsedTaskId, setCollapsedTaskId] = useState('')
  const [actionError, setActionError] = useState('')
  const selectedTask = useMemo(
    () =>
      tasks.find((task) => task.id === selectedTaskId) ?? tasks[0],
    [selectedTaskId, tasks]
  )
  const selectedSchedule = selectedTask
    ? findTaskSchedule(selectedTask, schedules)
    : undefined
  const expanded =
    manuallyExpanded ||
    (Boolean(selectedTaskId) && collapsedTaskId !== selectedTaskId)

  return (
    <section
      aria-label={t('taskStrip.ariaLabel')}
      className="conversation-task-strip"
    >
      <header className="conversation-task-strip__header">
        <button
          aria-expanded={expanded}
          className="conversation-task-strip__toggle"
          onClick={() => {
            if (expanded) {
              setManuallyExpanded(false)
              setCollapsedTaskId(selectedTaskId ?? '')
            } else {
              setManuallyExpanded(true)
              setCollapsedTaskId('')
            }
          }}
          type="button"
        >
          <ListTodo aria-hidden="true" size={15} />
          <strong>{t('taskStrip.title')}</strong>
          <span>
            {t('taskStrip.count', {
              count: tasks.length
            })}
          </span>
          {expanded ? (
            <ChevronUp aria-hidden="true" size={14} />
          ) : (
            <ChevronDown aria-hidden="true" size={14} />
          )}
        </button>
        <button
          className="secondary-button conversation-task-strip__create"
          onClick={onCreate}
          type="button"
        >
          <Plus aria-hidden="true" size={13} />
          {t('taskStrip.create')}
        </button>
      </header>
      {expanded && (
        <div className="conversation-task-strip__content">
          {tasks.length === 0 ? (
            <p className="conversation-task-strip__empty">
              {t('taskStrip.empty')}
            </p>
          ) : (
            <>
              <div
                aria-label={t('taskStrip.taskList')}
                className="conversation-task-strip__list"
              >
                {tasks.map((task) => (
                  <button
                    aria-pressed={selectedTask?.id === task.id}
                    className={
                      selectedTask?.id === task.id
                        ? 'conversation-task-strip__task conversation-task-strip__task--active'
                        : 'conversation-task-strip__task'
                    }
                    key={task.id}
                    onClick={() => onSelectTask(task.id)}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className={`task-status-dot task-status-dot--${task.status}`}
                    />
                    <span>{task.title}</span>
                  </button>
                ))}
              </div>
              {selectedTask && (
                <article className="conversation-task-details">
                  <header>
                    <span>
                      <strong>{selectedTask.title}</strong>
                      <small>
                        {t(`task.status.${selectedTask.status}`)}
                      </small>
                    </span>
                    {selectedTask.status === 'failed' && (
                      <CircleAlert aria-hidden="true" size={15} />
                    )}
                  </header>
                  <dl>
                    <div>
                      <dt>{t('task.fields.mode')}</dt>
                      <dd>
                        {selectedSchedule
                          ? t(`task.mode.${selectedSchedule.workMode}`)
                          : selectedTask.workMode
                            ? t(`task.mode.${selectedTask.workMode}`)
                            : t('task.mode.unavailable')}
                      </dd>
                    </div>
                    <div>
                      <dt>{t('task.fields.schedule')}</dt>
                      <dd>
                        {selectedSchedule
                          ? t(
                              `sidebar.tasks.schedule.recurrence.${selectedSchedule.recurrence}`
                            )
                          : t('task.schedule.none')}
                      </dd>
                    </div>
                    <div>
                      <dt>{t('task.fields.nextRun')}</dt>
                      <dd>
                        {selectedSchedule
                          ? new Date(
                              selectedSchedule.nextRunAt
                            ).toLocaleString(locale)
                          : t('task.notAvailable')}
                      </dd>
                    </div>
                    <div>
                      <dt>{t('task.fields.outcome')}</dt>
                      <dd>
                        {selectedTask.error ??
                          (selectedTask.completedAt
                            ? t('task.completedAt', {
                                time: new Date(
                                  selectedTask.completedAt
                                ).toLocaleString(locale)
                              })
                            : t('task.noOutcome'))}
                      </dd>
                    </div>
                  </dl>
                  {selectedSchedule && (
                    <div className="conversation-task-details__actions">
                      <TaskScheduleActions
                        onError={setActionError}
                        onRemoveSchedule={onRemoveSchedule}
                        onRunSchedule={onRunSchedule}
                        onSetScheduleEnabled={onSetScheduleEnabled}
                        schedule={selectedSchedule}
                        taskTitle={selectedTask.title}
                      />
                    </div>
                  )}
                </article>
              )}
            </>
          )}
          {actionError && (
            <p className="conversation-task-strip__error" role="alert">
              {actionError}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
