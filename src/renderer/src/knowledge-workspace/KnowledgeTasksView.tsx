import type { KnowledgeTaskItem, KnowledgeWorkspaceProps } from './types'
import type { TFunction } from 'i18next'
import { getLocaleFormatters, resolvedLocale, formatNumber, formatPercent } from './formatting'
import { useTranslation } from 'react-i18next'
import { useState, useMemo } from 'react'
import { toErrorMessage, taskStageLabelKeys, clampProgress } from './helpers'
import { ChevronDown, ChevronRight, LoaderCircle, X, RotateCcw, ListChecks } from 'lucide-react'
import { EmptyState, SegmentedControl } from '../WorkspacePrimitives'

const taskKindLabelKeys = {
  'source-sync': 'taskKinds.sourceSync',
  'document-process': 'taskKinds.documentProcess',
  'document-rebuild': 'taskKinds.documentRebuild',
  'library-rebuild': 'taskKinds.libraryRebuild',
  'embedding-rebuild': 'taskKinds.embeddingRebuild',
  'graph-rebuild': 'taskKinds.graphRebuild',
  parsing: 'taskKinds.parsing',
  embedding: 'taskKinds.embedding',
  graph: 'taskKinds.graph'
} as const satisfies Record<KnowledgeTaskItem['kind'], string>

const taskStatusLabelKeys = {
  queued: 'taskStatuses.queued',
  running: 'taskStatuses.running',
  succeeded: 'taskStatuses.succeeded',
  failed: 'taskStatuses.failed',
  cancelled: 'taskStatuses.cancelled',
  skipped: 'taskStatuses.skipped',
  interrupted: 'taskStatuses.interrupted'
} as const satisfies Record<KnowledgeTaskItem['status'], string>

const taskScopeLabelKeys = {
  library: 'taskScopes.library',
  source: 'taskScopes.source',
  document: 'taskScopes.document'
} as const satisfies Record<KnowledgeTaskItem['scope'], string>

function formatDateTime(
  value: string,
  locale: string,
  t: TFunction<'knowledge'>
): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? t('format.unknownTime')
    : getLocaleFormatters(locale).dateTime.format(date)
}

type KnowledgeTaskFilter = 'all' | 'active' | 'failed' | 'history'

export type KnowledgeTaskContext = {
  documentId?: string
  sourceId?: string
}

type KnowledgeTaskAction = 'cancel' | 'retry'

type KnowledgeTaskActionError = {
  action: KnowledgeTaskAction
  message: string
}

export function KnowledgeTasksView({
  context,
  onCancelTask,
  onClearContext,
  onRetryTask,
  tasks
}: {
  context?: KnowledgeTaskContext
  onCancelTask: KnowledgeWorkspaceProps['onCancelTask']
  onClearContext: () => void
  onRetryTask: KnowledgeWorkspaceProps['onRetryTask']
  tasks: readonly KnowledgeTaskItem[]
}): React.JSX.Element {
  const { i18n, t } = useTranslation('knowledge')
  const locale = resolvedLocale(i18n.resolvedLanguage ?? i18n.language)
  const [filter, setFilter] = useState<KnowledgeTaskFilter>('all')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        tasks
          .filter(
            (task) =>
              task.status === 'queued' || task.status === 'running'
          )
          .map((task) => task.parentTaskId)
          .filter((id): id is string => Boolean(id))
      )
  )
  const [pendingActions, setPendingActions] = useState<
    ReadonlyMap<string, KnowledgeTaskAction>
  >(() => new Map())
  const [actionErrors, setActionErrors] = useState<
    ReadonlyMap<string, KnowledgeTaskActionError>
  >(() => new Map())
  const activeCount = tasks.filter(
    (task) => task.status === 'queued' || task.status === 'running'
  ).length
  const failedCount = tasks.filter(
    (task) =>
      task.status === 'failed' || task.status === 'interrupted'
  ).length
  const historyCount = tasks.length - activeCount - failedCount
  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks]
  )
  const childrenByParent = useMemo(() => {
    const result = new Map<string, KnowledgeTaskItem[]>()
    for (const task of tasks) {
      if (!task.parentTaskId || !taskById.has(task.parentTaskId)) {
        continue
      }
      const children = result.get(task.parentTaskId) ?? []
      children.push(task)
      result.set(task.parentTaskId, children)
    }
    return result
  }, [taskById, tasks])
  const contextTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          (!context?.documentId && !context?.sourceId) ||
          (Boolean(context?.documentId) && task.documentId === context?.documentId) ||
          (Boolean(context?.sourceId) && task.sourceId === context?.sourceId)
      ),
    [context, tasks]
  )
  const directMatches = useMemo(
    () =>
      contextTasks.filter((task) => {
        if (filter === 'active') {
          return task.status === 'queued' || task.status === 'running'
        }
        if (filter === 'failed') {
          return (
            task.status === 'failed' ||
            task.status === 'interrupted'
          )
        }
        if (filter === 'history') {
          return ![
            'queued',
            'running',
            'failed',
            'interrupted'
          ].includes(task.status)
        }
        return true
      }),
    [contextTasks, filter]
  )
  const visibleIds = useMemo(() => {
    const result = new Set(directMatches.map((task) => task.id))
    for (const task of directMatches) {
      let parentId = task.parentTaskId
      while (parentId && taskById.has(parentId)) {
        result.add(parentId)
        parentId = taskById.get(parentId)?.parentTaskId
      }
    }
    return result
  }, [directMatches, taskById])
  const topLevelTasks = tasks.filter(
    (task) =>
      visibleIds.has(task.id) &&
      (!task.parentTaskId || !taskById.has(task.parentTaskId))
  )
  const filterOptions = [
    { value: 'all', label: t('tasks.filters.all') },
    { value: 'active', label: t('tasks.filters.active') },
    { value: 'failed', label: t('tasks.filters.failed') },
    { value: 'history', label: t('tasks.filters.history') }
  ] as const
  const runTaskAction = async (
    taskId: string,
    action: KnowledgeTaskAction,
    invoke: (taskId: string) => void | Promise<void>
  ): Promise<void> => {
    setPendingActions((current) => {
      const next = new Map(current)
      next.set(taskId, action)
      return next
    })
    setActionErrors((current) => {
      if (!current.has(taskId)) {
        return current
      }
      const next = new Map(current)
      next.delete(taskId)
      return next
    })
    try {
      await invoke(taskId)
    } catch (reason) {
      setActionErrors((current) => {
        const next = new Map(current)
        next.set(taskId, {
          action,
          message: toErrorMessage(reason, t)
        })
        return next
      })
    } finally {
      setPendingActions((current) => {
        const next = new Map(current)
        next.delete(taskId)
        return next
      })
    }
  }

  const renderTask = (
    task: KnowledgeTaskItem,
    nested = false
  ): React.JSX.Element => {
    const children = (childrenByParent.get(task.id) ?? []).filter(
      (child) => visibleIds.has(child.id)
    )
    const hasChildren = children.length > 0
    const isExpanded = expanded.has(task.id)
    const detailsId = `knowledge-task-${task.id}-details`
    const actionErrorId = `knowledge-task-${task.id}-action-error`
    const pendingAction = pendingActions.get(task.id)
    const actionError = actionErrors.get(task.id)
    const time =
      task.completedAt ??
      task.updatedAt ??
      task.startedAt ??
      task.createdAt
    return (
      <li
        className={`knowledge-task${
          nested ? ' knowledge-task--child' : ''
        }`}
        data-status={task.status}
        key={task.id}
      >
        <div className="knowledge-task__heading">
          <div className="knowledge-task__identity">
            {hasChildren ? (
              <button
                aria-controls={detailsId}
                aria-expanded={isExpanded}
                aria-label={t(
                  isExpanded
                    ? 'tasks.actions.collapse'
                    : 'tasks.actions.expand',
                  { name: task.documentName }
                )}
                className="knowledge-task__disclosure"
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(task.id)) {
                      next.delete(task.id)
                    } else {
                      next.add(task.id)
                    }
                    return next
                  })
                }
                type="button"
              >
                {isExpanded ? (
                  <ChevronDown aria-hidden="true" size={16} />
                ) : (
                  <ChevronRight aria-hidden="true" size={16} />
                )}
              </button>
            ) : (
              <span
                aria-hidden="true"
                className="knowledge-task__disclosure-placeholder"
              />
            )}
            <div>
              <strong>{task.documentName}</strong>
              <span>
                <span>{t(taskKindLabelKeys[task.kind])}</span>
                {' · '}
                <span>{t(taskScopeLabelKeys[task.scope])}</span>
              </span>
            </div>
          </div>
          <span
            className={`knowledge-task__status knowledge-task__status--${task.status}`}
          >
            {t(taskStatusLabelKeys[task.status])}
          </span>
        </div>
        <div className="knowledge-task__stage">
          <strong>{t('tasks.currentStage')}</strong>
          <span>{t(taskStageLabelKeys[task.stage])}</span>
          {task.completedItems !== undefined &&
            task.totalItems !== undefined && (
              <span>
                {t('tasks.itemProgress', {
                  completed: formatNumber(task.completedItems, locale),
                  total: formatNumber(task.totalItems, locale)
                })}
              </span>
            )}
        </div>
        <div className="knowledge-task__progress">
          <progress
            aria-label={t('tasks.progressAriaLabel', {
              name: task.documentName,
              kind: t(taskKindLabelKeys[task.kind])
            })}
            max={100}
            value={clampProgress(task.progress)}
          />
          <span>
            {formatPercent(clampProgress(task.progress) / 100, locale)}
          </span>
        </div>
        <div className="knowledge-task__meta">
          <span>{task.message || t('tasks.waiting')}</span>
          <time dateTime={time}>
            {formatDateTime(time, locale, t)}
          </time>
        </div>
        {task.error && (
          <div className="knowledge-task__error">
            <strong>{t('tasks.errorTitle')}</strong>
            <span>{task.error.message}</span>
            <span>
              {task.error.remedy ?? t('tasks.defaultRemedy')}
            </span>
          </div>
        )}
        {(task.canCancel || task.canRetry) && (
          <div
            aria-describedby={actionError ? actionErrorId : undefined}
            className="knowledge-task__actions"
          >
            {task.canCancel && (
              <button
                className="secondary-button"
                disabled={pendingAction !== undefined}
                onClick={() =>
                  void runTaskAction(
                    task.id,
                    'cancel',
                    onCancelTask
                  )
                }
                type="button"
              >
                {pendingAction === 'cancel' ? (
                  <LoaderCircle aria-hidden="true" size={14} />
                ) : (
                  <X aria-hidden="true" size={14} />
                )}
                {pendingAction === 'cancel'
                  ? t('tasks.actions.cancelling')
                  : t('tasks.actions.cancel')}
              </button>
            )}
            {task.canRetry && (
              <button
                className="secondary-button"
                disabled={pendingAction !== undefined}
                onClick={() =>
                  void runTaskAction(task.id, 'retry', onRetryTask)
                }
                type="button"
              >
                {pendingAction === 'retry' ? (
                  <LoaderCircle aria-hidden="true" size={14} />
                ) : (
                  <RotateCcw aria-hidden="true" size={14} />
                )}
                {pendingAction === 'retry'
                  ? t('tasks.actions.retrying')
                  : t('tasks.actions.retry')}
              </button>
            )}
          </div>
        )}
        {actionError && (
          <div
            className="knowledge-task__action-error"
            id={actionErrorId}
            role="alert"
          >
            <strong>
              {t(
                actionError.action === 'cancel'
                  ? 'tasks.actionErrors.cancelTitle'
                  : 'tasks.actionErrors.retryTitle'
              )}
            </strong>
            <span>{actionError.message}</span>
            <span>{t('tasks.actionErrors.recovery')}</span>
          </div>
        )}
        {hasChildren && isExpanded && (
          <ol className="knowledge-task__children" id={detailsId}>
            {children.map((child) => renderTask(child, true))}
          </ol>
        )}
      </li>
    )
  }

  if (tasks.length === 0) {
    return (
      <EmptyState
        description={t('tasks.emptyDescription')}
        icon={<ListChecks size={30} />}
        level="section"
        title={t('tasks.emptyTitle')}
      />
    )
  }

  return (
    <section
      aria-labelledby="knowledge-tasks-title"
      className="knowledge-tasks"
    >
      <div className="knowledge-tasks__summary">
        <div>
          <h3 id="knowledge-tasks-title">
            {t('tasks.title')}
          </h3>
          <p className="knowledge-section-description">
            {t('tasks.totalCount', {
              count: formatNumber(tasks.length, locale)
            })}
          </p>
        </div>
        <div className="knowledge-tasks__metrics">
          <span>
            {t('tasks.activeCount', {
              count: formatNumber(activeCount, locale)
            })}
          </span>
          <span>
            {t('tasks.failedCount', {
              count: formatNumber(failedCount, locale)
            })}
          </span>
          <span>
            {t('tasks.historyCount', {
              count: formatNumber(historyCount, locale)
            })}
          </span>
        </div>
      </div>
      <div className="knowledge-tasks__toolbar">
        <SegmentedControl
          ariaLabel={t('tasks.filters.ariaLabel')}
          onChange={setFilter}
          options={filterOptions}
          value={filter}
        />
        {context && (
          <div className="knowledge-tasks__context">
            <span>{t('tasks.context.active')}</span>
            <button
              className="secondary-button"
              onClick={onClearContext}
              type="button"
            >
              {t('tasks.context.clear')}
            </button>
          </div>
        )}
      </div>
      {topLevelTasks.length === 0 ? (
        <EmptyState
          description={t('tasks.noResultsDescription')}
          icon={<ListChecks size={28} />}
          level="section"
          title={t('tasks.noResultsTitle')}
        />
      ) : (
      <ol className="knowledge-task-list">
        {topLevelTasks.map((task) => renderTask(task))}
      </ol>
      )}
    </section>
  )
}
