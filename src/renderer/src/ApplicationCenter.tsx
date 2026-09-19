import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Cpu,
  HeartPulse,
  Library,
  Settings,
  Sparkles,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { InlineHelp } from './InlineHelp'
import {
  defaultApplicationNavigation,
  type ApplicationSettings,
  type ApplicationSettingsUpdate,
  type BuiltInApplicationId,
  type EditableApplicationId,
} from '../../shared/application-settings-contracts'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import { PageHeader, SegmentedControl } from './WorkspacePrimitives'
import './application-center.css'

export const applicationDefinitions = {
  'magic-notes': {
    icon: Sparkles,
    title: 'navigation.magicNotes',
    enabled: 'magicNotesEnabled',
  },
  knowledge: {
    icon: Library,
    title: 'navigation.knowledge',
  },
  heartbeat: {
    icon: HeartPulse,
    title: 'navigation.heartbeat',
  },
  'local-inference': {
    icon: Cpu,
    title: 'applications.localInference',
    enabled: 'localInferenceEnabled',
  },
} as const

export function isApplicationEnabled(
  settings: ApplicationSettings | undefined,
  id: BuiltInApplicationId,
): boolean {
  if (id === 'knowledge' || id === 'heartbeat') return true
  return (
    settings !== undefined &&
    settings[applicationDefinitions[id].enabled] !== false
  )
}

export function ApplicationAvailability({
  enabled,
  children,
}: {
  enabled: boolean
  children: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('app')
  return (
    <div className="application-page">
      {!enabled && <div className="application-page-controls">
        <strong>{t('applications.disabledPage')}</strong>
      </div>}
      <div
        className="application-page-content"
        hidden={!enabled}
        inert={!enabled}
      >
        {children}
      </div>
    </div>
  )
}

export function ApplicationSettingsView({
  id,
  settings,
  pending,
  onUpdate,
}: {
  id: EditableApplicationId
  settings: ApplicationSettings
  pending: boolean
  onUpdate: (patch: ApplicationSettingsUpdate) => Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation(['app', 'settingsSections'])
  const navigation =
    settings.applicationNavigation ?? defaultApplicationNavigation
  return (
    <div className="application-settings">
      <div className="application-settings__group">
        <label className="toggle-row">
          <input
            role="switch"
            type="checkbox"
            checked={isApplicationEnabled(settings, id)}
            disabled={pending}
            onChange={(event) =>
              void onUpdate({
                [applicationDefinitions[id].enabled]: event.target.checked,
              })
            }
          />
          <span>{t('applications.enable')}</span>
        </label>
        <div className="inline-help-label">
          <label className="toggle-row">
            <input
              role="switch"
              type="checkbox"
              checked={navigation.pinned[id]}
              aria-describedby="application-pin-help"
              disabled={pending}
              onChange={(event) =>
                void onUpdate({
                  applicationNavigation: {
                    ...navigation,
                    pinned: { ...navigation.pinned, [id]: event.target.checked },
                  },
                })
              }
            />
            <span>{t('applications.pin')}</span>
          </label>
          <InlineHelp label={t('applications.pin')} id="application-pin-help">{t('applications.pinHelp')}</InlineHelp>
        </div>
        <p className="settings-notice">{t('applications.disableHelp')}</p>
        {id === 'magic-notes' && (
          <label className="toggle-row">
            <input
              role="switch"
              type="checkbox"
              checked={settings.magicNotesShowIncompleteTodoCount}
              disabled={pending}
              onChange={(event) =>
                void onUpdate({
                  magicNotesShowIncompleteTodoCount: event.target.checked,
                })
              }
            />
            <span>
              {t('platformFeatures.magicNotes.showIncompleteTodoCount', {
                ns: 'settingsSections',
              })}
            </span>
          </label>
        )}
      </div>
      {id === 'magic-notes' && (
        <div className="application-settings__group">
          <div className="platform-feature-option application-settings__compact-option">
            <div className="application-settings__label-with-help">
              <label htmlFor="magic-note-canvas-page-count">{t('platformFeatures.magicNotes.canvasPageCount', { ns: 'settingsSections' })}</label>
              <InlineHelp label={t('platformFeatures.magicNotes.canvasPageCount', { ns: 'settingsSections' })}
                id="magic-note-canvas-page-count-help">
                {t('platformFeatures.magicNotes.canvasPageCountHelp', { ns: 'settingsSections' })}
              </InlineHelp>
            </div>
            <div className="field">
              <select id="magic-note-canvas-page-count" disabled={pending} value={settings.magicNoteCanvasPageCount ?? 1}
                aria-describedby="magic-note-canvas-page-count-help"
                onChange={event => void onUpdate({ magicNoteCanvasPageCount: Number(event.target.value) })}>
                {[1, 2, 3, 4, 5, 6, 7, 8].map(count => <option key={count} value={count}>{count}</option>)}
              </select>
            </div>
          </div>
          <div className="platform-feature-option">
            <span>
              {t('platformFeatures.magicNotes.commentMode', {
                ns: 'settingsSections',
              })}
            </span>
            <SegmentedControl
              ariaLabel={t('platformFeatures.magicNotes.commentModeAria', {
                ns: 'settingsSections',
              })}
              disabled={pending}
              value={settings.magicNoteCommentMode}
              onChange={(magicNoteCommentMode) =>
                void onUpdate({ magicNoteCommentMode })
              }
              options={[
                {
                  value: 'immediate',
                  label: t('platformFeatures.magicNotes.modes.immediate', {
                    ns: 'settingsSections',
                  }),
                },
                {
                  value: 'after-save-auto',
                  label: t('platformFeatures.magicNotes.modes.afterSaveAuto', {
                    ns: 'settingsSections',
                  }),
                },
                {
                  value: 'after-save-manual',
                  label: t(
                    'platformFeatures.magicNotes.modes.afterSaveManual',
                    { ns: 'settingsSections' },
                  ),
                },
              ]}
            />
          </div>
          <div className="platform-feature-option">
            <span>
              {t('platformFeatures.magicNotes.commentFormat', {
                ns: 'settingsSections',
              })}
            </span>
            <SegmentedControl
              ariaLabel={t('platformFeatures.magicNotes.commentFormatAria', {
                ns: 'settingsSections',
              })}
              disabled={pending}
              value={settings.magicNoteCommentFormat}
              onChange={(magicNoteCommentFormat) =>
                void onUpdate({ magicNoteCommentFormat })
              }
              options={[
                {
                  value: 'combined',
                  label: t('platformFeatures.magicNotes.formats.combined', {
                    ns: 'settingsSections',
                  }),
                },
                {
                  value: 'narrative',
                  label: t('platformFeatures.magicNotes.formats.narrative', {
                    ns: 'settingsSections',
                  }),
                },
                {
                  value: 'structured',
                  label: t('platformFeatures.magicNotes.formats.structured', {
                    ns: 'settingsSections',
                  }),
                },
              ]}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export function ApplicationCenter({
  settings,
  pending,
  locked = false,
  error,
  onClose,
  onOpen,
  onUpdate,
  onRetry,
}: {
  settings?: ApplicationSettings
  pending: boolean
  locked?: boolean
  error?: string
  onClose: () => void
  onOpen: (id: BuiltInApplicationId) => void
  onUpdate: (patch: ApplicationSettingsUpdate) => Promise<boolean>
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<EditableApplicationId>()
  const [dragged, setDragged] = useState<BuiltInApplicationId>()
  const [announcement, setAnnouncement] = useState('')
  const dialog = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  useLayoutEffect(
    () => activateModalFocus(() => search.current ?? close.current),
    [],
  )
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0
    ;(selected ? close.current : search.current)?.focus()
  }, [selected])
  const navigation =
    settings?.applicationNavigation ?? defaultApplicationNavigation
  const editingDisabled = pending || locked
  const results = useMemo(
    () =>
      navigation.order.filter((id) =>
        `${t(applicationDefinitions[id].title)} ${t(`applications.descriptions.${id}`)}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
      ),
    [navigation.order, query, t],
  )
  const move = async (
    from: BuiltInApplicationId,
    to: BuiltInApplicationId,
  ): Promise<void> => {
    if (editingDisabled || from === to) return
    const order = [...navigation.order]
    order.splice(order.indexOf(from), 1)
    order.splice(navigation.order.indexOf(to), 0, from)
    if (await onUpdate({ applicationNavigation: { ...navigation, order } }))
      setAnnouncement(t('applications.orderUpdated'))
  }
  return createPortal(
    <div className="settings-backdrop" role="presentation">
      <section
        className={`settings-panel application-center${selected ? ' application-center--detail' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="application-center-title"
        id="application-center"
        ref={dialog}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
          trapTabFocus(event, dialog.current)
        }}
      >
        <div className="settings-panel__header">
          {selected && (
            <button
              type="button"
              className="icon-button"
              aria-label={t('applications.back')}
              title={t('applications.back')}
              onClick={() => setSelected(undefined)}
            >
              <ArrowLeft size={19} aria-hidden="true" />
            </button>
          )}
          <PageHeader
            headingId="application-center-title"
            title={
              selected
                ? t(applicationDefinitions[selected].title)
                : t('applications.title')
            }
            description={t(
              selected
                ? `applications.descriptions.${selected}`
                : 'applications.description',
            )}
            actions={
              <button
                ref={close}
                type="button"
                className="icon-button"
                aria-label={t('applications.close')}
                title={t('applications.close')}
                onClick={onClose}
              >
                <X size={19} />
              </button>
            }
          />
        </div>
        <div ref={body} className="application-center__body" aria-busy={pending}>
          {error && (
            <div role="alert" className="settings-warning">
              {error}{' '}
              <button
                type="button"
                className="secondary-button"
                disabled={pending}
                onClick={onRetry}
              >
                {t('applications.retry')}
              </button>
            </div>
          )}
          {!settings ? (
            <p role="status">{t('route.loading')}</p>
          ) : selected ? (
            <ApplicationSettingsView
              id={selected}
              settings={settings}
              pending={editingDisabled}
              onUpdate={onUpdate}
            />
          ) : (
            <>
              <label className="application-center__search">
                <span>{t('applications.search')}</span>
                <input
                  ref={search}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              {results.length === 0 && (
                <div>
                  <p>{t('applications.noResults')}</p>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setQuery('')}
                  >
                    {t('applications.clear')}
                  </button>
                </div>
              )}
              <div className="application-center__grid">{results.map((id) => {
                const definition = applicationDefinitions[id]
                const Icon = definition.icon
                const enabled = isApplicationEnabled(settings, id)
                const alwaysShown = id === 'knowledge' || id === 'heartbeat'
                return (
                  <article
                    className="application-center__item"
                    key={id}
                    draggable={!editingDisabled && !query}
                    onDragStart={() => { if (!editingDisabled && !query) setDragged(id) }}
                    onDragEnd={() => setDragged(undefined)}
                    onDragOver={(event) => {
                      if (dragged && !editingDisabled && !query) event.preventDefault()
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      if (dragged && !query) void move(dragged, id)
                      setDragged(undefined)
                    }}
                  >
                    <div className="application-center__summary">
                      <Icon size={22} aria-hidden="true" />
                      <div>
                        <div className="application-center__title">
                          <strong>{t(definition.title)}</strong>
                          <small>
                            {alwaysShown
                              ? t('applications.alwaysShown')
                              : `${t('applications.optional')} · ${t(enabled ? 'applications.enabled' : 'applications.disabled')}`}
                          </small>
                        </div>
                        <p>{t(`applications.descriptions.${id}`)}</p>
                      </div>
                    </div>
                    <div className="application-center__actions">
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={!enabled}
                        onClick={() => onOpen(id)}
                      >
                        {t('applications.open')}
                      </button>
                      {!alwaysShown && (
                        <button
                          className="secondary-button"
                          type="button"
                          title={t('applications.settings')}
                          aria-label={`${t(definition.title)} ${t('applications.settings')}`}
                          onClick={() => setSelected(id)}
                        >
                          <Settings size={16} aria-hidden="true" />
                          {t('applications.settings')}
                        </button>
                      )}
                      <div className="application-center__order">
                        {([-1, 1] as const).map((offset) => {
                          const target = navigation.order[navigation.order.indexOf(id) + offset]
                          const MoveIcon = offset === -1 ? ArrowUp : ArrowDown
                          const label = t(offset === -1 ? 'applications.moveUp' : 'applications.moveDown', {
                            name: t(definition.title),
                          })
                          return (
                            <button
                              key={offset}
                              className="icon-button"
                              type="button"
                              aria-label={label}
                              title={label}
                              disabled={editingDisabled || !target}
                              onClick={() => { if (target) void move(id, target) }}
                            >
                              <MoveIcon size={16} aria-hidden="true" />
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </article>
                )
              })}</div>
            </>
          )}
          <span className="sr-only" role="status">{announcement}</span>
        </div>
      </section>
    </div>,
    document.body,
  )
}
