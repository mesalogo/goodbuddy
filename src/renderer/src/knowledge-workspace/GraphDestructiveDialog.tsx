import type { KnowledgeGraphNode, KnowledgeGraphRelation } from './types'
import { useTranslation } from 'react-i18next'
import { useState, useRef, useId, useEffect } from 'react'
import { activateModalFocus, trapTabFocus } from '../dialog-focus'
import { toErrorMessage } from './helpers'
import { createPortal } from 'react-dom'
import { AlertCircle, Trash2 } from 'lucide-react'

export type GraphDestructiveAction =
  | {
      kind: 'delete-entity'
      node: KnowledgeGraphNode
      relationCount: number
    }
  | {
      kind: 'delete-relation'
      relation: KnowledgeGraphRelation
      sourceLabel: string
      targetLabel: string
      typeLabel: string
    }
  | {
      kind: 'merge-entities'
      source: KnowledgeGraphNode
      target: KnowledgeGraphNode
    }

export function GraphDestructiveDialog({
  action,
  onCancel,
  onConfirm
}: {
  action: GraphDestructiveAction
  onCancel: () => void
  onConfirm: () => void | Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('knowledge')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const title =
    action.kind === 'delete-entity'
      ? t('graph.confirm.deleteEntity.title', {
          name: action.node.label
        })
      : action.kind === 'delete-relation'
        ? t('graph.confirm.deleteRelation.title', {
            type: action.typeLabel
          })
        : t('graph.confirm.merge.title', {
            source: action.source.label,
            target: action.target.label
          })
  const description =
    action.kind === 'delete-entity'
      ? t('graph.confirm.deleteEntity.description', {
          name: action.node.label,
          count: action.relationCount
        })
      : action.kind === 'delete-relation'
        ? t('graph.confirm.deleteRelation.description', {
            source: action.sourceLabel,
            target: action.targetLabel,
            type: action.typeLabel
          })
        : t('graph.confirm.merge.description', {
            source: action.source.label,
            target: action.target.label
          })
  const confirmLabel =
    action.kind === 'delete-entity'
      ? t('graph.confirm.deleteEntity.action')
      : action.kind === 'delete-relation'
        ? t('graph.confirm.deleteRelation.action')
        : t('graph.confirm.merge.action')

  useEffect(
    () => activateModalFocus(() => cancelRef.current),
    []
  )

  const confirm = async (): Promise<void> => {
    setPending(true)
    setError(undefined)
    try {
      await onConfirm()
      onCancel()
    } catch (reason) {
      setError(toErrorMessage(reason, t))
    } finally {
      setPending(false)
    }
  }

  return createPortal(
    <div
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className="knowledge-confirm-dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !pending) {
          event.preventDefault()
          onCancel()
          return
        }
        trapTabFocus(event, dialogRef.current)
      }}
      ref={dialogRef}
      role="alertdialog"
      tabIndex={-1}
    >
      <section className="knowledge-confirm-dialog">
        <AlertCircle aria-hidden="true" size={26} />
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        {error && (
          <p className="knowledge-inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="knowledge-confirm-dialog__actions">
          <button
            className="secondary-button"
            disabled={pending}
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            {t('actions.cancel')}
          </button>
          <button
            className="danger-button"
            disabled={pending}
            onClick={() => void confirm()}
            type="button"
          >
            <Trash2 aria-hidden="true" size={15} />
            {pending ? t('graph.confirm.processing') : confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body
  )
}
