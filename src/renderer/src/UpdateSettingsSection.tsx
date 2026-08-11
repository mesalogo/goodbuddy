import { ExternalLink, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ApplicationSettings,
  VersionCheckResult
} from '../../shared/application-settings-contracts'
import type { AppInfo } from '../../shared/contracts'
import { SettingsCategoryHeader } from './SettingsPrimitives'

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function updateErrorMessage(
  reason: unknown,
  fallback: string,
  networkMessage: string
): string {
  if (!(reason instanceof Error)) {
    return fallback
  }
  const message = reason.message
    .replace(
      /^Error invoking remote method '[^']+':\s*/,
      ''
    )
    .replace(/^(?:TypeError|Error):\s*/, '')
    .trim()
  if (/fetch failed/i.test(message)) {
    return networkMessage
  }
  return message || fallback
}

export function UpdateSettingsSection(): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const [settings, setSettings] = useState<ApplicationSettings>()
  const [appInfo, setAppInfo] = useState<AppInfo>()
  const [result, setResult] = useState<VersionCheckResult>()
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const updates = window.goodbuddy.updates
    let active = true
    void (async () => {
      if (!updates) {
        throw new Error(t('updates.errors.serviceUnavailable'))
      }
      return Promise.all([
        updates.getSettings(),
        window.goodbuddy.app.getInfo()
      ])
    })()
      .then(([nextSettings, info]) => {
        if (active) {
          setSettings(nextSettings)
          setAppInfo(info)
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          const fallback = t('updates.errors.readSettingsFailed')
          setError(
            updateErrorMessage(
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
        updateErrorMessage(
          reason,
          fallback,
          t('updates.errors.network', { fallback })
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
        updateErrorMessage(
          reason,
          fallback,
          t('updates.errors.network', { fallback })
        )
      )
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      <SettingsCategoryHeader
        category="about"
        error={error}
        headingId="update-settings-heading"
      />
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
            type="checkbox"
          />
          <span>{t('updates.checkOnStartup')}</span>
        </label>

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
            onClick={() =>
              void window.goodbuddy.updates?.openReleasePage()
            }
            type="button"
          >
            <ExternalLink aria-hidden="true" size={13} />
            {t('updates.actions.openDownloadPage')}
          </button>
        </div>
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
          </div>
          <ul>
            {result.target.files.map((file) => (
              <li key={file.name}>
                <code>{file.name}</code>
                <span>{formatBytes(file.size)}</span>
              </li>
            ))}
          </ul>
          <p>
            {t('updates.result.safety')}
          </p>
        </article>
      )}
      </section>
    </>
  )
}
