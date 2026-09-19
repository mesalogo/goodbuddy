import {
  ClockFading,
  CornerDownRight,
  ListRestart,
  Paperclip,
  Undo2,
  LoaderCircle,
  Trash2
} from 'lucide-react'
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConversationQueueItem } from '../../shared/assistant-contracts'
import { QueuedAttachmentsDialog } from './QueuedAttachmentsDialog'

type ConversationInputQueueProps = {
  items: ConversationQueueItem[]
  running: boolean
  onError: (message: string) => void
  onInterruptAndRun: (itemId: string) => Promise<void>
  onRemove: (itemId: string) => Promise<void>
  onRestore?: (itemId: string) => Promise<void>
}

export const ConversationInputQueue = memo(
  function ConversationInputQueue({
    items,
    running,
    onError,
    onInterruptAndRun,
    onRemove,
    onRestore
  }: ConversationInputQueueProps): React.JSX.Element | null {
    const { t } = useTranslation('app')
    const [viewing, setViewing] = useState<string>()
    const [pendingAction, setPendingAction] = useState<{
      itemId: string
      action: 'run' | 'remove' | 'restore'
    }>()

    if (items.length === 0) {
      return null
    }

    const runAction = async (
      itemId: string,
      actionName: 'run' | 'remove' | 'restore',
      action: () => Promise<void>
    ): Promise<void> => {
      setPendingAction({ itemId, action: actionName })
      try {
        await action()
      } catch (reason) {
        onError(
          reason instanceof Error
            ? reason.message
            : t('composer.queue.actionFailed')
        )
      } finally {
        setPendingAction(undefined)
      }
    }

    return (
      <section
        aria-label={t('composer.queue.ariaLabel')}
        className="conversation-input-queue"
      >
        <ol>
          {items.map((item) => {
            const busy = pendingAction?.itemId === item.id
            const sourceLabel =
              item.source === 'schedule'
                ? t('composer.queue.scheduledTask')
                : t('composer.queue.message')
            return (
              <li key={item.id} className={item.error ? 'conversation-input-queue__item--error' : undefined}>
                <span
                  aria-label={sourceLabel}
                  className="conversation-input-queue__source"
                  role="img"
                >
                  {item.source === 'schedule' ? (
                    <ClockFading aria-hidden="true" size={16} />
                  ) : (
                    <CornerDownRight aria-hidden="true" size={16} />
                  )}
                </span>
                <span
                  className="conversation-input-queue__content"
                  title={item.label}
                >
                  {item.label}
                  {item.error && <small className="knowledge-inline-error" role="alert">{item.error}</small>}
                </span>
                <span className="conversation-input-queue__actions">
                  {item.source === 'user' && <button type="button" aria-label={`查看入队附件：${item.label}`} title="查看附件" onClick={() => setViewing(item.id)}><Paperclip aria-hidden="true" size={13} /><span>查看附件</span></button>}
                  {onRestore && item.source === 'user' && <button type="button" disabled={pendingAction !== undefined} aria-label={`恢复到草稿：${item.label}`} title="恢复到草稿" onClick={() => void runAction(item.id, 'restore', () => onRestore(item.id))}><Undo2 aria-hidden="true" size={13} /><span>恢复到草稿</span></button>}
                  <button
                    aria-label={t(
                      running
                        ? 'composer.queue.interruptAria'
                        : 'composer.queue.runNowAria',
                      { title: item.label }
                    )}
                    disabled={pendingAction !== undefined}
                    onClick={() =>
                      void runAction(item.id, 'run', () =>
                        onInterruptAndRun(item.id)
                      )
                    }
                    title={
                      running
                        ? t('composer.queue.interrupt')
                        : t('composer.queue.runNow')
                    }
                    type="button"
                  >
                    {busy && pendingAction.action === 'run' ? (
                      <LoaderCircle
                        aria-hidden="true"
                        className="context-chip__spinner"
                        size={13}
                      />
                    ) : (
                      <ListRestart aria-hidden="true" size={13} />
                    )}
                    <span>
                      {running
                        ? t('composer.queue.interrupt')
                        : t('composer.queue.runNow')}
                    </span>
                  </button>
                  <button
                    aria-label={t('composer.queue.removeAria', {
                      title: item.label
                    })}
                    className="conversation-input-queue__remove"
                    disabled={pendingAction !== undefined}
                    onClick={() =>
                      void runAction(item.id, 'remove', () =>
                        onRemove(item.id)
                      )
                    }
                    title={t('composer.queue.remove')}
                    type="button"
                  >
                    {busy && pendingAction.action === 'remove' ? (
                      <LoaderCircle
                        aria-hidden="true"
                        className="context-chip__spinner"
                        size={13}
                      />
                    ) : (
                      <Trash2 aria-hidden="true" size={13} />
                    )}
                  </button>
                </span>
              </li>
            )
          })}
        </ol>
        {viewing && items.some((item) => item.id === viewing) && <QueuedAttachmentsDialog itemId={viewing} onClose={() => setViewing(undefined)} />}
      </section>
    )
  }
)
