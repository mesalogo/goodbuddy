import {
  Package,
  RefreshCw,
  Search,
  Settings2,
  Trash2
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  legacyRuntimeExtensionStartupFailure,
  runtimeExtensionConfigurationSchema,
  runtimeExtensionStartupFailureCode,
  type RuntimeExtensionAction,
  type RuntimeExtensionCatalogEntry,
  type RuntimeExtensionConfiguration,
  type RuntimeExtensionMarketplaceInstalledState,
  type RuntimeExtensionMarketplaceSnapshot
} from '../../shared/runtime-extension-contracts'
import type { AppNotificationInput } from './notifications'
import { DestructiveConfirmActions } from './WorkspacePrimitives'

const maximumVisibleEntries = 40

type DshMarketplaceSectionProps = {
  onNotify: (notification: AppNotificationInput) => void
}

function packagesMatch(
  catalog: RuntimeExtensionCatalogEntry,
  installed: RuntimeExtensionMarketplaceInstalledState
): boolean {
  return (
    catalog.package.name === installed.package.name &&
    catalog.package.version === installed.package.version
  )
}

function packageLabel(entry: RuntimeExtensionCatalogEntry): string {
  return `${entry.package.name}@${entry.package.version}`
}

function installConfirmationIdentity(
  entry: RuntimeExtensionCatalogEntry
): string {
  return `${entry.id}:${packageLabel(entry)}`
}

function actionIdentity(action: RuntimeExtensionAction): string {
  return action.type === 'set-marketplace-enabled'
    ? 'marketplace'
    : action.extensionId
}

export function DshMarketplaceSection({
  onNotify
}: DshMarketplaceSectionProps): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [snapshot, setSnapshot] =
    useState<RuntimeExtensionMarketplaceSnapshot>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [query, setQuery] = useState('')
  const [confirmingInstall, setConfirmingInstall] = useState<string>()
  const [installConfirmed, setInstallConfirmed] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState<string>()
  const [configuring, setConfiguring] = useState<string>()
  const [configurationDraft, setConfigurationDraft] = useState('')
  const [configurationError, setConfigurationError] = useState<string>()
  const mountedRef = useRef(true)
  const installConfirmationRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const readSnapshot = useCallback((): Promise<RuntimeExtensionMarketplaceSnapshot> => {
    const api = window.goodbuddy.runtimeExtensions
    return api
      ? api.getSnapshot()
      : Promise.reject(
          new Error(
            t(
              'runtime.deepseekHarness.marketplace.errors.unavailable'
            )
          )
        )
  }, [t])

  const load = useCallback(async (): Promise<void> => {
    setConfirmingInstall(undefined)
    setInstallConfirmed(false)
    setLoading(true)
    setLoadError(undefined)
    try {
      const next = await readSnapshot()
      if (mountedRef.current) {
        setSnapshot(next)
      }
    } catch (reason) {
      if (mountedRef.current) {
        setLoadError(
          reason instanceof Error
            ? reason.message
            : t('runtime.deepseekHarness.marketplace.errors.readFailed')
        )
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [readSnapshot, t])

  useEffect(() => {
    let active = true
    void readSnapshot()
      .then((next) => {
        if (active) {
          setSnapshot(next)
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setLoadError(
            reason instanceof Error
              ? reason.message
              : t(
                  'runtime.deepseekHarness.marketplace.errors.readFailed'
                )
          )
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [readSnapshot, t])

  useEffect(() => {
    if (confirmingInstall) {
      installConfirmationRef.current?.focus()
    }
  }, [confirmingInstall])

  const apply = async (
    key: string,
    action: RuntimeExtensionAction,
    successMessage: string
  ): Promise<boolean> => {
    const api = window.goodbuddy.runtimeExtensions
    if (!api) {
      onNotify({
        tone: 'error',
        message: t(
          'runtime.deepseekHarness.marketplace.errors.unavailable'
        ),
        dedupeKey: 'dsh-marketplace-unavailable'
      })
      return false
    }

    setBusy(key)
    try {
      const next = await api.apply(action)
      if (mountedRef.current) {
        setSnapshot(next)
        onNotify({
          tone: 'success',
          message: successMessage,
          dedupeKey: `dsh-marketplace-${action.type}-${actionIdentity(action)}`
        })
      }
      return true
    } catch (reason) {
      if (mountedRef.current) {
        onNotify({
          tone: 'error',
          message:
            reason instanceof Error
              ? reason.message
              : t(
                  'runtime.deepseekHarness.marketplace.errors.operationFailed'
                ),
          dedupeKey: `dsh-marketplace-error-${action.type}-${actionIdentity(action)}`
        })
      }
      return false
    } finally {
      if (mountedRef.current) {
        setBusy(undefined)
      }
    }
  }

  const setMarketplaceEnabled = async (
    enabled: boolean
  ): Promise<void> => {
    if (!enabled) {
      setConfirmingInstall(undefined)
      setInstallConfirmed(false)
    }
    const changed = await apply(
      'marketplace',
      {
        type: 'set-marketplace-enabled',
        enabled
      },
      t(
        enabled
          ? 'runtime.deepseekHarness.marketplace.notifications.marketplaceEnabled'
          : 'runtime.deepseekHarness.marketplace.notifications.marketplaceDisabled'
      )
    )
    if (changed && enabled && mountedRef.current) {
      await load()
    }
  }

  const installedById = useMemo(
    () =>
      new Map(
        (snapshot?.installed ?? []).map((extension) => [
          extension.id,
          extension
        ])
      ),
    [snapshot]
  )

  const entries = useMemo(() => {
    if (!snapshot) {
      return []
    }
    const knownIds = new Set(snapshot.catalog.map((entry) => entry.id))
    const installedWithoutCatalog = snapshot.installed
      .filter((extension) => !knownIds.has(extension.id))
      .map<RuntimeExtensionCatalogEntry>((extension) => ({
        id: extension.id,
        package: extension.package,
        displayName: extension.package.name,
        description: t(
          'runtime.deepseekHarness.marketplace.notInCatalog'
        )
      }))
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return [...snapshot.catalog, ...installedWithoutCatalog]
      .filter((entry) => {
        if (!normalizedQuery) {
          return true
        }
        return [
          entry.displayName,
          entry.description,
          entry.package.name,
          entry.license ?? ''
        ].some((value) =>
          value.toLocaleLowerCase().includes(normalizedQuery)
        )
      })
      .sort((left, right) => {
        const leftInstalled = installedById.has(left.id) ? 0 : 1
        const rightInstalled = installedById.has(right.id) ? 0 : 1
        return (
          leftInstalled - rightInstalled ||
          left.displayName.localeCompare(right.displayName)
        )
      })
  }, [installedById, query, snapshot, t])

  const visibleEntries = entries.slice(0, maximumVisibleEntries)

  const beginConfiguration = (
    extension: RuntimeExtensionMarketplaceInstalledState
  ): void => {
    setConfiguring(extension.id)
    setConfigurationDraft(
      JSON.stringify(extension.configuration, null, 2)
    )
    setConfigurationError(undefined)
  }

  const saveConfiguration = async (
    extension: RuntimeExtensionMarketplaceInstalledState
  ): Promise<void> => {
    let configuration: RuntimeExtensionConfiguration
    try {
      const parsed = runtimeExtensionConfigurationSchema.safeParse(
        JSON.parse(configurationDraft) as unknown
      )
      if (!parsed.success) {
        throw new Error('not-an-object')
      }
      configuration = parsed.data
    } catch {
      setConfigurationError(
        t(
          'runtime.deepseekHarness.marketplace.configuration.invalid'
        )
      )
      return
    }

    setConfigurationError(undefined)
    const saved = await apply(
      `configure:${extension.id}`,
      {
        type: 'configure',
        extensionId: extension.id,
        configuration
      },
      t('runtime.deepseekHarness.marketplace.notifications.configured', {
        name: extension.package.name
      })
    )
    if (saved && mountedRef.current) {
      setConfiguring(undefined)
    }
  }

  return (
    <section
      aria-labelledby="dsh-marketplace-heading"
      className="settings-section runtime-extension-marketplace"
    >
      <div className="settings-section__title settings-section__title--actions">
        <Package aria-hidden="true" size={17} />
        <div>
          <strong
            aria-level={3}
            id="dsh-marketplace-heading"
            role="heading"
          >
            {t('runtime.deepseekHarness.marketplace.title')}
          </strong>
          <small>
            {t('runtime.deepseekHarness.marketplace.previewDescription')}
          </small>
        </div>
        <span className="runtime-extension-marketplace__header-actions">
          <label className="toggle-row runtime-extension-marketplace__master-toggle">
            <span>
              {t(
                snapshot?.marketplaceEnabled
                  ? 'runtime.deepseekHarness.marketplace.switch.enabled'
                  : 'runtime.deepseekHarness.marketplace.switch.disabled'
              )}
            </span>
            <input
              aria-label={t(
                'runtime.deepseekHarness.marketplace.switch.aria'
              )}
              checked={snapshot?.marketplaceEnabled ?? false}
              disabled={!snapshot || loading || Boolean(busy)}
              onChange={(event) =>
                void setMarketplaceEnabled(event.target.checked)
              }
              role="switch"
              type="checkbox"
            />
          </label>
          {snapshot?.marketplaceEnabled && (
            <button
              aria-label={t(
                'runtime.deepseekHarness.marketplace.refreshAria'
              )}
              className="secondary-button"
              disabled={loading || Boolean(busy)}
              onClick={() => void load()}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={13} />
              {t('runtime.deepseekHarness.marketplace.refresh')}
            </button>
          )}
        </span>
      </div>

      {loadError && (
        <div className="runtime-extension-marketplace__load-error">
          <p className="settings-warning" role="alert">
            {loadError}
          </p>
          <button
            className="secondary-button"
            disabled={loading}
            onClick={() => void load()}
            type="button"
          >
            {t('runtime.deepseekHarness.marketplace.retry')}
          </button>
        </div>
      )}

      {snapshot && !snapshot.marketplaceEnabled && (
        <p className="settings-notice">
          {t('runtime.deepseekHarness.marketplace.disabledDescription')}
        </p>
      )}

      {snapshot?.marketplaceEnabled && (
        <>
          <p className="settings-warning">
            {t(
              'runtime.deepseekHarness.marketplace.permissionNotice'
            )}
          </p>

          <label className="field runtime-extension-marketplace__search">
            <span>
              {t(
                'runtime.deepseekHarness.marketplace.searchLabel'
              )}
            </span>
            <span className="runtime-extension-marketplace__search-input">
              <Search aria-hidden="true" size={14} />
              <input
                onChange={(event) =>
                  setQuery(event.currentTarget.value)
                }
                placeholder={t(
                  'runtime.deepseekHarness.marketplace.searchPlaceholder'
                )}
                type="search"
                value={query}
              />
            </span>
          </label>

          {snapshot.catalogError && (
            <div className="runtime-extension-marketplace__load-error">
              <p className="settings-warning" role="alert">
                {t(
                  'runtime.deepseekHarness.marketplace.catalogUnavailable',
                  { detail: snapshot.catalogError }
                )}
              </p>
              <button
                className="secondary-button"
                disabled={loading || Boolean(busy)}
                onClick={() => void load()}
                type="button"
              >
                {t('runtime.deepseekHarness.marketplace.retry')}
              </button>
            </div>
          )}

          <p className="settings-notice" role="status">
            {t('runtime.deepseekHarness.marketplace.results', {
              shown: visibleEntries.length,
              total: entries.length
            })}
          </p>

          {entries.length === 0 ? (
            <p className="settings-empty">
              {query.trim()
                ? t('runtime.deepseekHarness.marketplace.noResults')
                : t('runtime.deepseekHarness.marketplace.empty')}
            </p>
          ) : (
            <div className="runtime-extension-marketplace__list">
              {visibleEntries.map((entry) => {
                const installed = installedById.get(entry.id)
                const updateAvailable =
                  Boolean(installed) &&
                  !packagesMatch(entry, installed!)
                const installPanelOpen =
                  confirmingInstall ===
                  installConfirmationIdentity(entry)
                const configurationOpen = configuring === entry.id
                const installBusy = busy === `install:${entry.id}`
                return (
                  <article
                    className="runtime-extension-card"
                    key={entry.id}
                  >
                    <header className="runtime-extension-card__header">
                      <div>
                        <strong>{entry.displayName}</strong>
                        <code>{packageLabel(entry)}</code>
                      </div>
                      <div className="runtime-extension-card__tags">
                        {installed && (
                          <span>
                            {t(
                              'runtime.deepseekHarness.marketplace.installed'
                            )}
                          </span>
                        )}
                        {entry.license && <span>{entry.license}</span>}
                      </div>
                    </header>

                    <p>{entry.description}</p>

                    {installed?.lastError && (
                      <p className="settings-warning" role="alert">
                        {installed.lastError ===
                          runtimeExtensionStartupFailureCode ||
                        installed.lastError ===
                          legacyRuntimeExtensionStartupFailure
                          ? t(
                              'runtime.deepseekHarness.marketplace.startupFailure'
                            )
                          : installed.lastError}
                      </p>
                    )}

                    <div className="runtime-extension-card__actions">
                      {installed && (
                        <>
                          <label className="toggle-row runtime-extension-card__toggle">
                            <span>
                              {installed.enabled
                                ? t(
                                    'runtime.deepseekHarness.marketplace.enabled'
                                  )
                                : t(
                                    'runtime.deepseekHarness.marketplace.disabled'
                                  )}
                            </span>
                            <input
                              aria-label={t(
                                'runtime.deepseekHarness.marketplace.enableAria',
                                { name: entry.displayName }
                              )}
                              checked={installed.enabled}
                              disabled={Boolean(busy)}
                              onChange={(event) => {
                                const enabled = event.target.checked
                                void apply(
                                  `toggle:${entry.id}`,
                                  {
                                    type: 'set-enabled',
                                    extensionId: entry.id,
                                    enabled
                                  },
                                  t(
                                    enabled
                                      ? 'runtime.deepseekHarness.marketplace.notifications.enabled'
                                      : 'runtime.deepseekHarness.marketplace.notifications.disabled',
                                    { name: entry.displayName }
                                  )
                                )
                              }}
                              role="switch"
                              type="checkbox"
                            />
                          </label>
                          <button
                            className="secondary-button"
                            disabled={Boolean(busy)}
                            onClick={() =>
                              configurationOpen
                                ? setConfiguring(undefined)
                                : beginConfiguration(installed)
                            }
                            type="button"
                          >
                            <Settings2 aria-hidden="true" size={13} />
                            {configurationOpen
                              ? t(
                                  'runtime.deepseekHarness.marketplace.configuration.close'
                                )
                              : t(
                                  'runtime.deepseekHarness.marketplace.configuration.open'
                                )}
                          </button>
                          <DestructiveConfirmActions
                            confirmAriaLabel={t(
                              'runtime.deepseekHarness.marketplace.removeAria',
                              { name: entry.displayName }
                            )}
                            confirmLabel={t(
                              'runtime.deepseekHarness.marketplace.confirmRemove'
                            )}
                            confirming={
                              confirmingRemove === entry.id
                            }
                            disabled={Boolean(busy)}
                            icon={<Trash2 size={13} />}
                            message={t(
                              'runtime.deepseekHarness.marketplace.removeMessage',
                              { name: entry.displayName }
                            )}
                            onCancel={() =>
                              setConfirmingRemove(undefined)
                            }
                            onConfirm={() => {
                              void apply(
                                `remove:${entry.id}`,
                                {
                                  type: 'remove',
                                  extensionId: entry.id
                                },
                                t(
                                  'runtime.deepseekHarness.marketplace.notifications.removed',
                                  { name: entry.displayName }
                                )
                              ).then((removed) => {
                                if (removed && mountedRef.current) {
                                  setConfirmingRemove(undefined)
                                  setConfiguring((current) =>
                                    current === entry.id
                                      ? undefined
                                      : current
                                  )
                                }
                              })
                            }}
                            onRequestConfirm={() =>
                              setConfirmingRemove(entry.id)
                            }
                            triggerAriaLabel={t(
                              'runtime.deepseekHarness.marketplace.removeAria',
                              { name: entry.displayName }
                            )}
                            triggerLabel={t(
                              'runtime.deepseekHarness.marketplace.remove'
                            )}
                          />
                        </>
                      )}

                      {(!installed || updateAvailable) && (
                        <button
                          className="primary-button"
                          disabled={Boolean(busy)}
                          onClick={() => {
                            setConfirmingInstall(
                              installConfirmationIdentity(entry)
                            )
                            setInstallConfirmed(false)
                          }}
                          type="button"
                        >
                          {updateAvailable
                            ? t(
                                'runtime.deepseekHarness.marketplace.update',
                                { version: entry.package.version }
                              )
                            : t(
                                'runtime.deepseekHarness.marketplace.install'
                              )}
                        </button>
                      )}
                    </div>

                    {installPanelOpen && (
                      <fieldset className="runtime-extension-install-confirmation">
                        <legend>
                          {t(
                            'runtime.deepseekHarness.marketplace.installConfirmationTitle',
                            { name: entry.displayName }
                          )}
                        </legend>
                        <p>
                          {t(
                            'runtime.deepseekHarness.marketplace.installConfirmation'
                          )}
                        </p>
                        <label>
                          <input
                            checked={installConfirmed}
                            disabled={installBusy}
                            onChange={(event) =>
                              setInstallConfirmed(event.target.checked)
                            }
                            ref={installConfirmationRef}
                            type="checkbox"
                          />
                          <span>
                            {t(
                              'runtime.deepseekHarness.marketplace.trustConfirmation',
                              { package: packageLabel(entry) }
                            )}
                          </span>
                        </label>
                        <div>
                          <button
                            className="secondary-button"
                            disabled={installBusy}
                            onClick={() => {
                              setConfirmingInstall(undefined)
                              setInstallConfirmed(false)
                            }}
                            type="button"
                          >
                            {t(
                              'runtime.deepseekHarness.marketplace.cancel'
                            )}
                          </button>
                          <button
                            className="primary-button"
                            disabled={!installConfirmed || installBusy}
                            onClick={() => {
                              void apply(
                                `install:${entry.id}`,
                                {
                                  type: 'install',
                                  extensionId: entry.id,
                                  package: entry.package
                                },
                                t(
                                  updateAvailable
                                    ? 'runtime.deepseekHarness.marketplace.notifications.updated'
                                    : 'runtime.deepseekHarness.marketplace.notifications.installed',
                                  { name: entry.displayName }
                                )
                              ).then((installedSuccessfully) => {
                                if (
                                  installedSuccessfully &&
                                  mountedRef.current
                                ) {
                                  setConfirmingInstall(undefined)
                                  setInstallConfirmed(false)
                                }
                              })
                            }}
                            type="button"
                          >
                            {installBusy
                              ? t(
                                  'runtime.deepseekHarness.marketplace.installing'
                                )
                              : t(
                                  'runtime.deepseekHarness.marketplace.confirmInstall'
                                )}
                          </button>
                        </div>
                      </fieldset>
                    )}

                    {configurationOpen && installed && (
                      <div className="runtime-extension-configuration">
                        <label className="field">
                          <span>
                            {t(
                              'runtime.deepseekHarness.marketplace.configuration.label',
                              { name: entry.displayName }
                            )}
                          </span>
                          <textarea
                            aria-label={t(
                              'runtime.deepseekHarness.marketplace.configuration.label',
                              { name: entry.displayName }
                            )}
                            aria-invalid={Boolean(configurationError)}
                            disabled={Boolean(busy)}
                            onChange={(event) => {
                              setConfigurationDraft(
                                event.currentTarget.value
                              )
                              setConfigurationError(undefined)
                            }}
                            spellCheck={false}
                            value={configurationDraft}
                          />
                          <small>
                            {t(
                              'runtime.deepseekHarness.marketplace.configuration.help'
                            )}
                          </small>
                          {configurationError && (
                            <small className="field-error" role="alert">
                              {configurationError}
                            </small>
                          )}
                        </label>
                        <button
                          className="primary-button"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void saveConfiguration(installed)
                          }
                          type="button"
                        >
                          {t(
                            'runtime.deepseekHarness.marketplace.configuration.save'
                          )}
                        </button>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          )}

          {entries.length > maximumVisibleEntries && (
            <p className="settings-notice">
              {t(
                'runtime.deepseekHarness.marketplace.refineSearch',
                { count: maximumVisibleEntries }
              )}
            </p>
          )}
        </>
      )}

      {loading && !snapshot && (
        <p className="settings-empty" role="status">
          {t('runtime.deepseekHarness.marketplace.loading')}
        </p>
      )}
    </section>
  )
}
