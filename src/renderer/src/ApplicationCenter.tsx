import {
  Fragment,
  lazy,
  Suspense,
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
  Network,
  HeartPulse,
  Library,
  Server,
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
import {
  projectChannels,
  type AssistantProject,
  type ProjectChannel,
  type ProjectCreateInput,
} from '../../shared/assistant-contracts'
import type { AppNotificationInput } from './notifications'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import { PageHeader, SegmentedControl } from './WorkspacePrimitives'
import { ChannelIcon } from './ChannelIcon'
import './application-center.css'

// Message channel settings pull in QR rendering, so load them on demand.
/** Platforms with work tools first, then message-only platforms. */
const platformApplicationOrder: readonly ProjectChannel[] = ['feishu', 'wecom', 'dingtalk', 'weixin', 'telegram']

const PlatformApplicationRows = lazy(() =>
  import('./ChannelApplicationSettings').then((module) => ({ default: module.PlatformApplicationRows })),
)
const ChannelApplicationSettings = lazy(() =>
  import('./ChannelApplicationSettings').then((module) => ({ default: module.ChannelApplicationSettings })),
)

export type PlatformApplicationsProps = {
  projects: AssistantProject[]
  initialChannel?: ProjectChannel
  onNotify?: (notification: AppNotificationInput) => void
  onOpenChannel: (channel: ProjectChannel) => void
  onUpdateProject: (projectId: string, input: ProjectCreateInput) => Promise<AssistantProject>
}

export const applicationDefinitions = {
  'device-sharing': { icon: Network, title: 'sharing.title', enabled: 'deviceSharingEnabled' },
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
    enabled: 'heartbeatEnabled',
  },
  'local-inference': {
    icon: Cpu,
    title: 'applications.localInference',
    enabled: 'localInferenceEnabled',
  },
  // Shares the remote projects switch: the backend gates hosts on it.
  'remote-hosts': {
    icon: Server,
    title: 'applications.remoteHosts',
    enabled: 'remoteProjectsEnabled',
  },
} as const

export function isApplicationEnabled(
  settings: ApplicationSettings | undefined,
  id: BuiltInApplicationId,
): boolean {
  if (id === 'knowledge') return true
  if (id === 'device-sharing') return settings?.deviceSharingEnabled === true
  if (id === 'remote-hosts') return settings?.remoteProjectsEnabled === true
  if (id === 'heartbeat') return settings?.heartbeatEnabled === true
  return (
    settings !== undefined &&
    settings[applicationDefinitions[id].enabled] !== false
  )
}

// Hosts stays openable while remote capability is off: Agent packages can be
// prepared ahead of time, and the page offers the switch itself.
export function isApplicationOpenable(
  settings: ApplicationSettings | undefined,
  id: BuiltInApplicationId,
): boolean {
  return id === 'remote-hosts'
    ? settings !== undefined
    : isApplicationEnabled(settings, id)
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
          <span>{t(id === 'remote-hosts' ? 'applications.remoteHostsEnable' : 'applications.enable')}</span>
        </label>
        {id !== 'device-sharing' && <div className="inline-help-label">
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
        </div>}
        <p className="settings-notice">{t(id === 'device-sharing' ? 'applications.deviceSharingHelp' : id === 'remote-hosts' ? 'applications.remoteHostsHelp' : 'applications.disableHelp')}</p>
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
  platform,
}: {
  settings?: ApplicationSettings
  pending: boolean
  locked?: boolean
  error?: string
  onClose: () => void
  onOpen: (id: BuiltInApplicationId) => void
  onUpdate: (patch: ApplicationSettingsUpdate) => Promise<boolean>
  onRetry: () => void
  platform?: PlatformApplicationsProps
}): React.JSX.Element {
  const { t } = useTranslation(['app', 'integrations'])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<EditableApplicationId | ProjectChannel | undefined>(
    platform?.initialChannel,
  )
  const selectedChannel = selected && (projectChannels as readonly string[]).includes(selected)
    ? selected as ProjectChannel
    : undefined
  const selectedApplication = selectedChannel ? undefined : selected as EditableApplicationId | undefined
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
  const inDetail = selected !== undefined
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0
  }, [selected])
  useLayoutEffect(() => {
    ;(inDetail ? close.current : search.current)?.focus()
  }, [inDetail])
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
  const platformResults = useMemo(
    () =>
      platform
        ? platformApplicationOrder.filter((channel) =>
            `${t(`channels.tabs.${channel}`, { ns: 'integrations' })} ${t(`applications.descriptions.${channel}`)}`
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase()),
          )
        : [],
    [platform, query, t],
  )
  const channelProjectIds = useMemo(
    () => new Set(platform?.projects.flatMap((project) =>
      project.kind === 'channel' && project.channel ? [project.channel] : []) ?? []),
    [platform?.projects],
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
  // Settings detail mirrors the system settings dialog: every configurable
  // app in a vertical tab list, the selected app's settings on the right.
  const detailTabs: { id: EditableApplicationId | ProjectChannel; label: string; group: 'work' | 'platform' }[] = [
    ...navigation.order
      .filter((id): id is EditableApplicationId => id !== 'knowledge')
      .map((id) => ({ id, label: t(applicationDefinitions[id].title), group: 'work' as const })),
    ...(platform
      ? platformApplicationOrder.map((channel) => ({
          id: channel,
          label: t(`channels.tabs.${channel}`, { ns: 'integrations' }),
          group: 'platform' as const,
        }))
      : []),
  ]
  const selectedTitle = selectedChannel
    ? t(`channels.tabs.${selectedChannel}`, { ns: 'integrations' })
    : selectedApplication
      ? t(applicationDefinitions[selectedApplication].title)
      : ''
  return createPortal(
    <div className="settings-backdrop" role="presentation">
      <section
        className={`settings-panel application-center${selected ? ' application-center--detail' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={selected ? 'application-settings-title' : 'application-center-title'}
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
            title={t(selected ? 'applications.settingsTitle' : 'applications.title')}
            description={selected ? undefined : t('applications.description')}
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
        {selected ? (
          <div className="settings-panel__body application-center__detail" aria-busy={pending}>
            <nav
              aria-label={t('applications.settingsTabs')}
              aria-orientation="vertical"
              className="settings-tabs"
              role="tablist"
            >
              {detailTabs.map((tab, index) => {
                const Icon = tab.group === 'work'
                  ? applicationDefinitions[tab.id as EditableApplicationId].icon
                  : undefined
                return (
                  <Fragment key={tab.id}>
                    {detailTabs[index - 1]?.group !== tab.group && (
                      <span className="settings-tabs__group-label" aria-hidden="true">
                        {t(tab.group === 'work' ? 'applications.workGroup' : 'applications.platformGroup')}
                      </span>
                    )}
                    <button
                      aria-controls="application-settings-panel"
                      aria-selected={selected === tab.id}
                      id={`application-settings-tab-${tab.id}`}
                      onClick={() => setSelected(tab.id)}
                      onKeyDown={(event) => {
                        const next = event.key === 'ArrowDown' ? index + 1
                          : event.key === 'ArrowUp' ? index - 1
                          : event.key === 'Home' ? 0
                          : event.key === 'End' ? detailTabs.length - 1 : undefined
                        if (next === undefined) return
                        event.preventDefault()
                        const target = detailTabs[(next + detailTabs.length) % detailTabs.length]!
                        setSelected(target.id)
                        document.getElementById(`application-settings-tab-${target.id}`)?.focus()
                      }}
                      role="tab"
                      tabIndex={selected === tab.id ? 0 : -1}
                      type="button"
                    >
                      {Icon
                        ? <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
                        : <ChannelIcon channel={tab.id as ProjectChannel} size={16} />}
                      <strong>{tab.label}</strong>
                    </button>
                  </Fragment>
                )
              })}
            </nav>
            <div
              ref={body}
              aria-labelledby={`application-settings-tab-${selected}`}
              className="settings-panel__content application-center__detail-content"
              id="application-settings-panel"
              role="tabpanel"
            >
              <header className="settings-category-header">
                <div className="settings-category-header__content">
                  <h2 id="application-settings-title">{selectedTitle}</h2>
                  <p>{t(`applications.descriptions.${selected}`)}</p>
                </div>
              </header>
              {error && (
                <div role="alert" className="settings-warning">
                  {error}{' '}
                  <button type="button" className="secondary-button" disabled={pending} onClick={onRetry}>
                    {t('applications.retry')}
                  </button>
                </div>
              )}
              {selectedChannel && platform ? (
                <Suspense fallback={<p role="status">{t('route.loading')}</p>}>
                  <ChannelApplicationSettings
                    key={selectedChannel}
                    channel={selectedChannel}
                    onNotify={platform.onNotify}
                    onUpdateProject={platform.onUpdateProject}
                    projectList={platform.projects}
                  />
                </Suspense>
              ) : !settings ? (
                <p role="status">{t('route.loading')}</p>
              ) : selectedApplication ? (
                <ApplicationSettingsView
                  id={selectedApplication}
                  settings={settings}
                  pending={editingDisabled}
                  onUpdate={onUpdate}
                />
              ) : null}
            </div>
          </div>
        ) : (
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
              {results.length === 0 && platformResults.length === 0 && (
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
                const alwaysShown = id === 'knowledge'
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
                        disabled={!isApplicationOpenable(settings, id)}
                        onClick={() => onOpen(id)}
                      >
                        {t('applications.open')}
                      </button>
                      {id !== 'knowledge' && (
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
              {platform && platformResults.length > 0 && (
                <section
                  className="application-center__group"
                  aria-labelledby="application-center-platform-heading"
                >
                  <h2 id="application-center-platform-heading">{t('applications.platformGroup')}</h2>
                  <div className="application-center__grid">
                    <Suspense fallback={<p role="status">{t('route.loading')}</p>}>
                      <PlatformApplicationRows
                        channels={platformResults}
                        canOpen={(channel) => channelProjectIds.has(channel)}
                        onOpen={platform.onOpenChannel}
                        onSettings={setSelected}
                      />
                    </Suspense>
                  </div>
                </section>
              )}
            </>
          )}
          <span className="sr-only" role="status">{announcement}</span>
        </div>
        )}
      </section>
    </div>,
    document.body,
  )
}
