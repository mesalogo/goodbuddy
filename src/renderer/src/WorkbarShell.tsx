import {
  ClipboardCheck,
  FileOutput,
  FolderTree,
  Globe2,
  SquareTerminal,
  X,
  type LucideIcon
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  WORKBAR_APP_DEFINITIONS,
  WORKBAR_LIMITS,
  type WorkbarAppDefinition,
  type WorkbarAppId,
  type WorkbarTabInstance,
  type WorkbarTargetRef
} from '../../shared/workbar-contracts'

const WORKBAR_APP_ICONS: Record<WorkbarAppId, LucideIcon> = {
  tasks: ClipboardCheck,
  workspace: FolderTree,
  browser: Globe2,
  results: FileOutput,
  terminal: SquareTerminal
}

const DEFAULT_INSTANCE_IDS = {
  tasks: '10000000-0000-4000-8000-000000000001',
  workspace: '10000000-0000-4000-8000-000000000002',
  browser: '10000000-0000-4000-8000-000000000003',
  results: '10000000-0000-4000-8000-000000000004'
} as const

export const DEFAULT_WORKBAR_INSTANCES: readonly WorkbarTabInstance[] =
  WORKBAR_APP_DEFINITIONS.filter(
    (definition) => definition.defaultOpen
  ).map((definition) => ({
    id: DEFAULT_INSTANCE_IDS[definition.id],
    appId: definition.id,
    title: definition.label
  }))

export type WorkbarInstanceCreateRequest = {
  appId: WorkbarAppId
  insertAfterInstanceId: string | null
  targetRef?: WorkbarTargetRef
}

export type WorkbarShellProps = {
  instances: readonly WorkbarTabInstance[]
  activeInstanceId: string | null
  renderPanel: (instance: WorkbarTabInstance) => ReactNode
  renderTabAdornment?: (instance: WorkbarTabInstance) => ReactNode
  onActiveInstanceChange: (instanceId: string) => void
  onCreateInstance: (request: WorkbarInstanceCreateRequest) => void
  onCloseInstance: (
    instance: WorkbarTabInstance
  ) => boolean | void | Promise<boolean | void>
  onResolveTerminalTarget: () =>
    | WorkbarTargetRef
    | Promise<WorkbarTargetRef>
  appDefinitions?: readonly WorkbarAppDefinition[]
  onResolveUnavailableApp?: (definition: WorkbarAppDefinition) => void
  className?: string
}

function joinClassNames(...values: (string | false | undefined)[]): string {
  return values.filter(Boolean).join(' ')
}

function adjacentIndex(
  key: string,
  currentIndex: number,
  itemCount: number
): number | undefined {
  if (key === 'Home') {
    return 0
  }
  if (key === 'End') {
    return itemCount - 1
  }
  if (key === 'ArrowRight') {
    return (currentIndex + 1) % itemCount
  }
  if (key === 'ArrowLeft') {
    return (currentIndex - 1 + itemCount) % itemCount
  }
  return undefined
}

export function WorkbarShell({
  activeInstanceId,
  appDefinitions = WORKBAR_APP_DEFINITIONS,
  className,
  instances,
  onActiveInstanceChange,
  onCloseInstance,
  onCreateInstance,
  onResolveUnavailableApp,
  onResolveTerminalTarget,
  renderPanel,
  renderTabAdornment
}: WorkbarShellProps): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const idPrefix = useId()
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const catalogRef = useRef<HTMLDivElement>(null)
  const returnInstanceIdRef = useRef<string | null>(null)
  const pendingTabFocusRef = useRef<string | null | undefined>(undefined)
  const focusCreatedInstanceRef = useRef(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [creatingAppId, setCreatingAppId] =
    useState<WorkbarAppId | null>(null)
  const [targetError, setTargetError] = useState<string | null>(null)

  const activeInstance =
    instances.find((instance) => instance.id === activeInstanceId) ??
    null

  const tabId = useCallback(
    (instanceId: string): string =>
      `${idPrefix}-tab-${instanceId}`,
    [idPrefix]
  )
  const panelId = (instanceId: string): string =>
    `${idPrefix}-panel-${instanceId}`

  useEffect(() => {
    if (!catalogOpen) {
      return
    }
    const firstAvailable =
      catalogRef.current?.querySelector<HTMLButtonElement>(
        '[data-workbar-app-choice]:not(:disabled)'
      )
    firstAvailable?.focus()
  }, [catalogOpen])

  useEffect(() => {
    if (
      focusCreatedInstanceRef.current &&
      !catalogOpen &&
      activeInstanceId
    ) {
      const activeTab = document.getElementById(tabId(activeInstanceId))
      if (activeTab instanceof HTMLButtonElement) {
        activeTab.focus()
        focusCreatedInstanceRef.current = false
      }
    }

    const pendingId = pendingTabFocusRef.current
    if (pendingId === undefined) {
      return
    }
    if (pendingId === null) {
      addButtonRef.current?.focus()
      pendingTabFocusRef.current = undefined
      return
    }
    const tab = document.getElementById(tabId(pendingId))
    if (tab instanceof HTMLButtonElement) {
      tab.focus()
      pendingTabFocusRef.current = undefined
    }
  }, [activeInstanceId, catalogOpen, instances, tabId])

  const focusAndActivate = (instanceId: string): void => {
    onActiveInstanceChange(instanceId)
    const tab = document.getElementById(tabId(instanceId))
    if (tab instanceof HTMLButtonElement) {
      tab.focus()
    }
  }

  const closeCatalog = (restoreToAddButton: boolean): void => {
    setCatalogOpen(false)
    setCreatingAppId(null)
    setTargetError(null)
    const returnInstanceId = returnInstanceIdRef.current
    if (
      returnInstanceId &&
      instances.some((instance) => instance.id === returnInstanceId)
    ) {
      onActiveInstanceChange(returnInstanceId)
    }
    if (restoreToAddButton) {
      queueMicrotask(() => addButtonRef.current?.focus())
    }
  }

  const openCatalog = (): void => {
    returnInstanceIdRef.current = activeInstanceId
    setTargetError(null)
    setCatalogOpen(true)
  }

  const chooseApp = async (
    definition: WorkbarAppDefinition
  ): Promise<void> => {
    if (definition.availability.state === 'unavailable') {
      return
    }

    if (definition.instancePolicy === 'single') {
      const existing = instances.find(
        (instance) => instance.appId === definition.id
      )
      if (existing) {
        setCatalogOpen(false)
        setTargetError(null)
        pendingTabFocusRef.current = existing.id
        onActiveInstanceChange(existing.id)
        return
      }
    }

    if (instances.length >= WORKBAR_LIMITS.maximumOpenInstances) {
      return
    }

    const insertAfterInstanceId = activeInstanceId
    if (definition.id !== 'terminal') {
      focusCreatedInstanceRef.current = true
      setCatalogOpen(false)
      onCreateInstance({
        appId: definition.id,
        insertAfterInstanceId
      })
      return
    }

    setCreatingAppId('terminal')
    setTargetError(null)
    try {
      const targetRef = await onResolveTerminalTarget()
      focusCreatedInstanceRef.current = true
      setCatalogOpen(false)
      onCreateInstance({
        appId: 'terminal',
        insertAfterInstanceId,
        targetRef
      })
    } catch (error) {
      setTargetError(
        error instanceof Error
          ? error.message
          : t('sidebar.workbar.targetError')
      )
    } finally {
      setCreatingAppId(null)
    }
  }

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number
  ): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (catalogOpen) {
        closeCatalog(false)
      }
      focusAndActivate(activeInstance?.id ?? instances[index]!.id)
      return
    }
    const nextIndex = adjacentIndex(
      event.key,
      index,
      instances.length
    )
    if (nextIndex === undefined) {
      return
    }
    event.preventDefault()
    focusAndActivate(instances[nextIndex]!.id)
  }

  const handleClose = async (
    instance: WorkbarTabInstance
  ): Promise<void> => {
    const closingIndex = instances.findIndex(
      (candidate) => candidate.id === instance.id
    )
    const isActive = instance.id === activeInstanceId
    const nextActive = isActive
      ? (instances[closingIndex + 1] ??
        instances[closingIndex - 1] ??
        null)
      : activeInstance

    const closeResult = onCloseInstance(instance)
    const closeAccepted =
      closeResult &&
      typeof (closeResult as PromiseLike<boolean | void>).then ===
        'function'
        ? await closeResult
        : closeResult
    if (closeAccepted === false) {
      return
    }
    pendingTabFocusRef.current = nextActive?.id ?? null
    if (nextActive && nextActive.id !== activeInstanceId) {
      onActiveInstanceChange(nextActive.id)
    }
  }

  return (
    <section
      aria-label={t('sidebar.workbar.ariaLabel')}
      className={joinClassNames('workbar-shell', className)}
    >
      <div className="workbar-shell__tab-row">
        <div className="workbar-shell__tab-scroll">
          <div
            aria-label={t('sidebar.workbar.tablist')}
            className="workbar-shell__tablist"
            role="tablist"
          >
            {instances.map((instance, index) => {
              const selected =
                !catalogOpen && instance.id === activeInstanceId
              const AppIcon = WORKBAR_APP_ICONS[instance.appId]
              return (
                <div
                  className={joinClassNames(
                    'workbar-shell__tab-item',
                    selected && 'workbar-shell__tab-item--active'
                  )}
                  key={instance.id}
                >
                  <button
                    aria-controls={panelId(instance.id)}
                    aria-selected={selected}
                    className={joinClassNames(
                      'workbar-shell__tab',
                      selected && 'workbar-shell__tab--active'
                    )}
                    id={tabId(instance.id)}
                    onClick={() => {
                      setCatalogOpen(false)
                      setTargetError(null)
                      onActiveInstanceChange(instance.id)
                    }}
                    onKeyDown={(event) =>
                      handleTabKeyDown(event, index)
                    }
                    role="tab"
                    tabIndex={selected ? 0 : -1}
                    title={
                      appDefinitions.find(
                        (application) =>
                          application.id === instance.appId
                      )?.description ?? instance.title
                    }
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="workbar-shell__tab-icon"
                    >
                      <AppIcon />
                    </span>
                    <span className="workbar-shell__tab-label">
                      {instance.title}
                    </span>
                    {renderTabAdornment?.(instance)}
                  </button>
                  <button
                    aria-label={t('sidebar.workbar.close', {
                      title: instance.title
                    })}
                    className="workbar-shell__tab-close"
                    onClick={() => void handleClose(instance)}
                    title={t('sidebar.workbar.close', {
                      title: instance.title
                    })}
                    type="button"
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
        <button
          aria-expanded={catalogOpen}
          aria-label={t('sidebar.workbar.add')}
          className={joinClassNames(
            'workbar-shell__add',
            catalogOpen && 'workbar-shell__add--active'
          )}
          onClick={() =>
            catalogOpen ? closeCatalog(true) : openCatalog()
          }
          ref={addButtonRef}
          title={t('sidebar.workbar.add')}
          type="button"
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>

      <div className="workbar-shell__content">
        {instances.map((instance) => (
          <div
            aria-labelledby={tabId(instance.id)}
            className="workbar-shell__tabpanel"
            hidden={catalogOpen || instance.id !== activeInstanceId}
            id={panelId(instance.id)}
            key={instance.id}
            role="tabpanel"
            tabIndex={0}
          >
            {renderPanel(instance)}
          </div>
        ))}

        {catalogOpen ? (
          <div
            className="workbar-shell__catalog"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeCatalog(true)
              }
            }}
            ref={catalogRef}
          >
            <div className="workbar-shell__catalog-header">
              <div>
                <h2>{t('sidebar.workbar.catalogTitle')}</h2>
                <p>{t('sidebar.workbar.catalogDescription')}</p>
              </div>
              <button
                className="secondary-button"
                onClick={() => closeCatalog(true)}
                type="button"
              >
                {t('sidebar.workbar.cancel')}
              </button>
            </div>
            {targetError ? (
              <p className="workbar-shell__catalog-error" role="alert">
                {targetError}
              </p>
            ) : null}
            <ul
              aria-label={t('sidebar.workbar.catalog')}
              className="workbar-shell__catalog-list"
            >
              {appDefinitions.map((definition) => {
                const AppIcon = WORKBAR_APP_ICONS[definition.id]
                const existing =
                  definition.instancePolicy === 'single' &&
                  instances.some(
                    (instance) => instance.appId === definition.id
                  )
                const availability = definition.availability
                const unavailable =
                  availability.state === 'unavailable'
                const atLimit =
                  !existing &&
                  instances.length >=
                    WORKBAR_LIMITS.maximumOpenInstances
                const disabled =
                  unavailable ||
                  atLimit ||
                  creatingAppId !== null
                return (
                  <li
                    className="workbar-shell__catalog-item"
                    key={definition.id}
                  >
                    <button
                      className="workbar-shell__catalog-choice"
                      data-workbar-app-choice
                      disabled={disabled}
                      onClick={() => void chooseApp(definition)}
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className={`workbar-shell__app-icon workbar-shell__app-icon--${definition.icon}`}
                      >
                        <AppIcon />
                      </span>
                      <span className="workbar-shell__catalog-copy">
                        <strong>{definition.label}</strong>
                        <span>{definition.description}</span>
                        <small>
                          {existing
                            ? t('sidebar.workbar.existing')
                            : definition.instancePolicy === 'multiple'
                              ? t('sidebar.workbar.multiple')
                              : t('sidebar.workbar.single')}
                        </small>
                      </span>
                    </button>
                    {availability.state === 'unavailable' ? (
                      <div className="workbar-shell__unavailable">
                        <span>{availability.reason}</span>
                        {onResolveUnavailableApp ? (
                          <button
                            className="secondary-button"
                            onClick={() =>
                              onResolveUnavailableApp(definition)
                            }
                            type="button"
                          >
                            {t('sidebar.workbar.resolve')}
                          </button>
                        ) : null}
                      </div>
                    ) : atLimit ? (
                      <small className="workbar-shell__limit">
                        {t('sidebar.workbar.limit', {
                          count: WORKBAR_LIMITS.maximumOpenInstances
                        })}
                      </small>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </div>
        ) : instances.length === 0 ? (
          <div className="workbar-shell__empty">
            <strong>{t('sidebar.workbar.emptyTitle')}</strong>
            <p>{t('sidebar.workbar.emptyDescription')}</p>
            <button
              className="primary-button"
              onClick={openCatalog}
              type="button"
            >
              {t('sidebar.workbar.open')}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
