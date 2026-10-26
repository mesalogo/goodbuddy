import {
  ExternalLink,
  MessageSquarePlus,
  RefreshCw
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InlineHelp } from './InlineHelp'
import type {
  ApplicationSettings,
  UpdateSource,
  VersionCheckResult
} from '../../shared/application-settings-contracts'
import type { AppInfo } from '../../shared/contracts'
import type { AppNotificationInput } from './notifications'
import {
  SettingsCategoryHeader,
  SettingsWarningList
} from './SettingsPrimitives'
import {
  displayErrorMessage,
  displayNetworkAwareErrorMessage
} from './error-message'
import { FeedbackDialog } from './FeedbackDialog'
import { formatModelPackageBytes } from './model-download-presentation'
import { useDesktopUpdates } from './use-desktop-updates'
import { DesktopUpdateDownload } from './DesktopUpdateDownload'

export function UpdateSettingsSection({
  onNotify
}: {
  onNotify?: (notification: AppNotificationInput) => void
}): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const [settings, setSettings] = useState<ApplicationSettings>()
  const [appInfo, setAppInfo] = useState<AppInfo>()
  const [checkedResult, setResult] = useState<VersionCheckResult>()
  const downloads = useDesktopUpdates()
  const result = downloads.snapshot?.result ?? checkedResult
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [feedbackOpen, setFeedbackOpen] = useState(false)

  useEffect(() => {
    const updates = window.goodbuddy.updates
    let active = true
    void window.goodbuddy.app
      .getInfo()
      .then((info) => {
        if (active) {
          setAppInfo(info)
        }
      })
      .catch(() => undefined)
    if (!updates) {
      queueMicrotask(() => {
        if (active) {
          setError(t('updates.errors.serviceUnavailable'))
        }
      })
      return () => {
        active = false
      }
    }
    void updates
      .getSettings()
      .then((nextSettings) => {
        if (active) {
          setSettings(nextSettings)
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          const fallback = t('updates.errors.readSettingsFailed')
          setError(
            displayNetworkAwareErrorMessage(
              reason,
              fallback,
              t('updates.errors.network', { fallback })
            )
          )
        }
      })
    return () => {
      active = false
    }
  }, [t])

  const changeStartupCheck = async (enabled: boolean): Promise<void> => {
    const updates = window.goodbuddy.updates
    if (!updates || !settings) {
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      setSettings(
        await updates.updateSettings({
          checkUpdatesOnStartup: enabled
        })
      )
    } catch (reason) {
      const fallback = t('updates.errors.saveSettingsFailed')
      setError(
        displayNetworkAwareErrorMessage(
          reason,
          fallback,
          t('updates.errors.network', { fallback })
        )
      )
    } finally {
      setSaving(false)
    }
  }

  const changeUpdateSource = async (
    updateSource: UpdateSource
  ): Promise<void> => {
    const updates = window.goodbuddy.updates
    if (!updates || !settings) {
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      setSettings(await updates.updateSettings({ updateSource }))
      setResult(undefined)
    } catch (reason) {
      const fallback = t('updates.errors.saveSourceFailed')
      setError(
        displayNetworkAwareErrorMessage(
          reason,
          fallback,
          t('updates.errors.network', {
            fallback
          })
        )
      )
    } finally {
      setSaving(false)
    }
  }

  const check = async (): Promise<void> => {
    const updates = window.goodbuddy.updates
    if (!updates) {
      return
    }
    setChecking(true)
    setError(undefined)
    try {
      setResult(await updates.check())
    } catch (reason) {
      const fallback = t('updates.errors.checkFailed')
      setError(
        displayNetworkAwareErrorMessage(
          reason,
          fallback,
          t('updates.errors.sourceNetwork', {
            fallback,
            source: t(
              `updates.source.names.${settings?.updateSource ?? 'github'}`
            )
          })
        )
      )
    } finally {
      setChecking(false)
    }
  }

  const openReleasePage = async (): Promise<void> => {
    const updates = window.goodbuddy.updates
    if (!updates) {
      onNotify?.({
        dedupeKey: 'open-update-download-page-failed',
        message: t('updates.errors.serviceUnavailable'),
        tone: 'error'
      })
      return
    }
    try {
      await updates.openReleasePage()
    } catch (reason) {
      onNotify?.({
        dedupeKey: 'open-update-download-page-failed',
        message: displayErrorMessage(
          reason,
          t('updates.errors.openReleasePageFailed')
        ),
        tone: 'error'
      })
    }
  }

  return (
    <>
      <SettingsCategoryHeader
        category="about"
        error={error}
        headingId="update-settings-heading"
      />
      <SettingsWarningList warnings={settings?.warnings} />
      <section
        aria-label={t('updates.label')}
        className="settings-section update-settings"
      >

      <article className="capability-card">
        <div className="capability-card__header">
          <div>
            <strong>GoodBuddy {appInfo?.version ?? '—'}</strong>
            <small>
              {appInfo
                ? `${appInfo.platform} · ${appInfo.arch}`
                : t('updates.loadingAppInfo')}
            </small>
          </div>
        </div>

        <label className="toggle-row">
          <input
            checked={settings?.checkUpdatesOnStartup ?? false}
            disabled={!settings || saving}
            onChange={(event) =>
              void changeStartupCheck(event.target.checked)
            }
            role="switch"
            type="checkbox"
          />
          <span>{t('updates.checkOnStartup')}</span>
        </label>

        <div className="field update-settings__source">
          <span className="inline-help-label">
            <label htmlFor="update-source">{t('updates.source.label')}</label>
            <InlineHelp label={t('updates.source.label')} id="update-source-help">{t('updates.source.description')}</InlineHelp>
          </span>
          <select
            id="update-source"
            aria-describedby="update-source-help"
            aria-label={t('updates.source.label')}
            disabled={
              !settings ||
              saving ||
              checking
            }
            onChange={(event) =>
              void changeUpdateSource(
                event.target.value as UpdateSource
              )
            }
            value={settings?.updateSource ?? 'github'}
          >
            <option value="github">
              {t('updates.source.options.github')}
            </option>
            <option value="mirror">
              {t('updates.source.options.mirror')}
            </option>
          </select>
        </div>

        <div className="update-settings__actions">
          <button
            className="secondary-button"
            disabled={checking}
            onClick={() => void check()}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={13} />
            {checking
              ? t('updates.actions.checking')
              : t('updates.actions.checkNow')}
          </button>
          <button
            className="secondary-button"
            onClick={() => void openReleasePage()}
            type="button"
          >
            <ExternalLink aria-hidden="true" size={13} />
            {t('updates.actions.openDownloadPage')}
          </button>
          {downloads.supported && <button
            className="secondary-button"
            type="button"
            disabled={downloads.snapshot?.cacheCleaning || downloads.snapshot?.packageHandedOff || ['downloading', 'verifying', 'cancelling', 'restarting'].includes(downloads.snapshot?.status ?? '')}
            onClick={() => void downloads.actions.clearCache().then(cleared => {
              if (cleared) onNotify?.({ tone: 'success', message: t('updates.download.cacheCleared'), dedupeKey: 'update-cache-cleared' })
            })}
          >{t(downloads.snapshot?.cacheCleaning ? 'updates.download.clearingCache' : 'updates.download.clearCache')}</button>}
        </div>
        {downloads.snapshot?.cleanupWarning && <p role="alert">{downloads.snapshot.cleanupWarning}</p>}
      </article>

      {result && (
        <article
          aria-live="polite"
          className="capability-card update-settings__result"
        >
          <div className="capability-card__header">
            <div>
              <strong>
                {result.updateAvailable
                  ? t('updates.result.available', {
                      version: result.latestVersion
                    })
                  : t('updates.result.current')}
              </strong>
              <small>
                {t('updates.result.target', {
                  version: result.currentVersion,
                  platform: result.target.platform,
                  arch: result.target.arch
                })}
              </small>
            </div>
            {downloads.snapshot?.result?.updateAvailable && <DesktopUpdateDownload
              key={downloads.snapshot.result.latestVersion}
              snapshot={downloads.snapshot}
              error={downloads.error}
              actions={downloads.actions}
            />}
          </div>
          <ul>
            {result.target.files.map((file) => (
              <li key={file.name}>
                <code>{file.name}</code>
                <span>{formatModelPackageBytes(file.size)}</span>
              </li>
            ))}
          </ul>
          {!downloads.supported && <p>{t('updates.result.safety')}</p>}
        </article>
      )}
      <article className="capability-card feedback-entry-card">
        <div className="capability-card__header">
          <div>
            <strong>{t('feedback.entry.title')}</strong>
            <small>{t('feedback.entry.description')}</small>
          </div>
        </div>
        <div className="feedback-entry-card__actions">
          <button
            className="primary-button"
            disabled={!appInfo}
            onClick={() => setFeedbackOpen(true)}
            type="button"
          >
            <MessageSquarePlus aria-hidden="true" size={14} />
            {t('feedback.entry.action')}
          </button>
        </div>
      </article>
      </section>
      {feedbackOpen && appInfo && (
        <FeedbackDialog
          appInfo={appInfo}
          onClose={() => setFeedbackOpen(false)}
        />
      )}
    </>
  )
}
