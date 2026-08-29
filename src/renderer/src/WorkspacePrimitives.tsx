import {
  FolderKanban,
  Globe2,
  Layers3,
  TriangleAlert
} from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { useTranslation } from 'react-i18next'

export type WorkspaceScope =
  | { kind: 'global' }
  | { kind: 'all-projects' }
  | { kind: 'project'; projectName: string }
  | { kind: 'projects'; projectCount: number }
  | { kind: 'mixed'; projectName?: string }
  | { kind: 'unavailable'; explanation: string }

export type PageTab<T extends string> = {
  id: T
  label: string
  count?: number
  icon?: ReactNode
}

export type SegmentedOption<T extends string> = {
  value: T
  label: string
  disabled?: boolean
}

function nextControlIndex(
  event: KeyboardEvent<HTMLButtonElement>,
  currentIndex: number,
  itemCount: number
): number | undefined {
  if (event.key === 'Home') {
    return 0
  }
  if (event.key === 'End') {
    return itemCount - 1
  }
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    return (currentIndex + 1) % itemCount
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    return (currentIndex - 1 + itemCount) % itemCount
  }
  return undefined
}

export function PageShell({
  children,
  variant
}: {
  children: ReactNode
  variant: 'reading' | 'standard' | 'dashboard' | 'master-detail'
}): React.JSX.Element {
  return (
    <div
      className={`workspace-panel-scroll page-shell page-shell--${variant}`}
    >
      {children}
    </div>
  )
}

export function ScopeBadge({
  scope
}: {
  scope: WorkspaceScope
}): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const explanationId = useId()
  const content =
    scope.kind === 'global'
      ? {
          icon: <Globe2 size={12} />,
          label: t('primitives.scope.global')
        }
      : scope.kind === 'all-projects'
        ? {
            icon: <Layers3 size={12} />,
            label: t('primitives.scope.allProjects')
          }
        : scope.kind === 'project'
          ? {
              icon: <FolderKanban size={12} />,
              label: t('primitives.scope.project', {
                projectName: scope.projectName
              })
            }
          : scope.kind === 'projects'
            ? {
                icon: <Layers3 size={12} />,
                label: t('primitives.scope.projects', {
                  count: scope.projectCount
                })
              }
            : scope.kind === 'mixed'
            ? {
                icon: <Layers3 size={12} />,
                label: scope.projectName
                  ? t('primitives.scope.mixedProject', {
                      projectName: scope.projectName
                    })
                  : t('primitives.scope.mixedCurrent')
              }
            : {
                icon: <TriangleAlert size={12} />,
                label: t('primitives.scope.unavailable')
              }

  return (
    <span
      aria-label={content.label}
      aria-describedby={
        scope.kind === 'unavailable' ? explanationId : undefined
      }
      className="scope-badge"
      title={scope.kind === 'unavailable' ? scope.explanation : undefined}
    >
      <span aria-hidden="true">{content.icon}</span>
      {content.label}
      {scope.kind === 'unavailable' && (
        <span className="sr-only" id={explanationId}>
          {scope.explanation}
        </span>
      )}
    </span>
  )
}

export function PageHeader({
  actions,
  compact = false,
  description,
  eyebrow,
  headingId,
  icon,
  scope,
  title
}: {
  actions?: ReactNode
  compact?: boolean
  description?: ReactNode
  eyebrow?: string
  headingId: string
  icon?: ReactNode
  scope?: WorkspaceScope
  title: string
}): React.JSX.Element {
  return (
    <header
      className={
        compact ? 'page-header page-header--compact' : 'page-header'
      }
    >
      <div className="page-header__content">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <div className="page-header__title-row">
          {icon && (
            <span aria-hidden="true" className="page-header__icon">
              {icon}
            </span>
          )}
          <h1 id={headingId}>{title}</h1>
          {scope && <ScopeBadge scope={scope} />}
        </div>
        {description && (
          <p className="page-header__description">{description}</p>
        )}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  )
}

export function PageTabs<T extends string>({
  ariaLabel,
  idPrefix,
  onChange,
  tabs,
  value,
  variant = 'default'
}: {
  ariaLabel: string
  idPrefix: string
  onChange: (value: T) => void
  tabs: readonly PageTab<T>[]
  value: T
  variant?: 'default' | 'segmented'
}): React.JSX.Element {
  return (
    <nav
      aria-label={ariaLabel}
      className={`page-tabs page-tabs--${variant}`}
      role="tablist"
    >
      {tabs.map((tab, index) => (
        <button
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          aria-selected={value === tab.id}
          className={
            value === tab.id
              ? 'page-tabs__tab page-tabs__tab--active'
              : 'page-tabs__tab'
          }
          id={`${idPrefix}-tab-${tab.id}`}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            const nextIndex = nextControlIndex(
              event,
              index,
              tabs.length
            )
            if (nextIndex === undefined) {
              return
            }
            event.preventDefault()
            onChange(tabs[nextIndex]!.id)
            const controls =
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]'
              )
            controls?.[nextIndex]?.focus()
          }}
          role="tab"
          tabIndex={value === tab.id ? 0 : -1}
          type="button"
        >
          {tab.icon && (
            <span aria-hidden="true" className="page-tabs__icon">
              {tab.icon}
            </span>
          )}
          {tab.label}
          {tab.count ? (
            <span className="page-tabs__count">{tab.count}</span>
          ) : null}
        </button>
      ))}
    </nav>
  )
}

export function SegmentedControl<T extends string>({
  ariaLabel,
  disabled = false,
  onChange,
  options,
  value
}: {
  ariaLabel: string
  disabled?: boolean
  onChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  value: T
}): React.JSX.Element {
  return (
    <div
      aria-label={ariaLabel}
      className="segmented-control"
      role="group"
    >
      {options.map((option, index) => (
        <button
          aria-pressed={value === option.value}
          className={
            value === option.value
              ? 'segmented-control__option segmented-control__option--active'
              : 'segmented-control__option'
          }
          disabled={disabled || option.disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            let nextIndex = nextControlIndex(
              event,
              index,
              options.length
            )
            if (nextIndex === undefined) {
              return
            }
            const direction =
              event.key === 'ArrowLeft' ||
              event.key === 'ArrowUp' ||
              event.key === 'End'
                ? -1
                : 1
            for (
              let attempts = 0;
              attempts < options.length &&
              options[nextIndex]?.disabled;
              attempts += 1
            ) {
              nextIndex =
                (nextIndex + direction + options.length) %
                options.length
            }
            if (options[nextIndex]?.disabled) {
              return
            }
            event.preventDefault()
            onChange(options[nextIndex]!.value)
            const controls =
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                'button'
              )
            controls?.[nextIndex]?.focus()
          }}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function EmptyState({
  action,
  description,
  icon,
  level = 'section',
  title
}: {
  action?: ReactNode
  description: ReactNode
  icon?: ReactNode
  level?: 'page' | 'section' | 'table'
  title?: string
}): React.JSX.Element {
  return (
    <div className={`empty-state empty-state--${level}`}>
      {icon && (
        <span aria-hidden="true" className="empty-state__icon">
          {icon}
        </span>
      )}
      {title && <strong>{title}</strong>}
      <p>{description}</p>
      {action && <div className="empty-state__action">{action}</div>}
    </div>
  )
}

export function DestructiveConfirmActions({
  cancelAriaLabel,
  confirmAriaLabel,
  confirmLabel,
  confirming,
  disabled = false,
  icon,
  message,
  onCancel,
  onConfirm,
  onRequestConfirm,
  triggerAriaLabel,
  triggerLabel
}: {
  cancelAriaLabel?: string
  confirmAriaLabel?: string
  confirmLabel: string
  confirming: boolean
  disabled?: boolean
  icon?: ReactNode
  message?: ReactNode
  onCancel: () => void
  onConfirm: () => void
  onRequestConfirm: () => void
  triggerAriaLabel?: string
  triggerLabel: string
}): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(confirming)
  const shouldRestoreTrigger = useRef(false)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    if (confirming && !wasConfirming.current) {
      if (disabled) {
        dialogRef.current?.focus()
      } else {
        cancelRef.current?.focus()
      }
    } else if (confirming && disabled) {
      dialogRef.current?.focus()
    } else if (
      confirming &&
      !disabled &&
      document.activeElement === dialogRef.current
    ) {
      cancelRef.current?.focus()
    } else if (!confirming && wasConfirming.current) {
      shouldRestoreTrigger.current = true
    }

    if (
      !confirming &&
      shouldRestoreTrigger.current &&
      !triggerRef.current?.disabled
    ) {
      triggerRef.current?.focus()
      shouldRestoreTrigger.current = false
    }
    wasConfirming.current = confirming
  }, [confirming, disabled])

  return confirming ? (
    <div
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-live="assertive"
      className="danger-confirm"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !disabled) {
          event.preventDefault()
          onCancel()
        }
      }}
      ref={dialogRef}
      role="alertdialog"
      tabIndex={-1}
    >
      <span className="sr-only" id={titleId}>
        {confirmAriaLabel ?? confirmLabel}
      </span>
      <span className={message ? undefined : 'sr-only'} id={descriptionId}>
        {message ??
          t('primitives.destructive.defaultMessage', {
            triggerLabel
          })}
      </span>
      <button
        aria-label={cancelAriaLabel}
        className="secondary-button"
        disabled={disabled}
        onClick={onCancel}
        ref={cancelRef}
        type="button"
      >
        {t('primitives.destructive.cancel')}
      </button>
      <button
        aria-label={confirmAriaLabel}
        className="danger-button"
        disabled={disabled}
        onClick={onConfirm}
        type="button"
      >
        {confirmLabel}
      </button>
    </div>
  ) : (
    <button
      aria-label={triggerAriaLabel}
      className="danger-button danger-button--quiet"
      disabled={disabled}
      onClick={onRequestConfirm}
      ref={triggerRef}
      type="button"
    >
      {icon && <span aria-hidden="true">{icon}</span>}
      {triggerLabel}
    </button>
  )
}
