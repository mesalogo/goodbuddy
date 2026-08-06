import { ExternalLink, Info, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  ApplicationSettings,
  VersionCheckResult
} from '../../shared/application-settings-contracts'
import type { AppInfo } from '../../shared/contracts'

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function updateErrorMessage(
  reason: unknown,
  fallback: string
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
    return `${fallback}：无法连接 GoodBuddy 官方 GitHub Release，请检查网络或代理后重试`
  }
  return message || fallback
}

export function UpdateSettingsSection(): React.JSX.Element {
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
        throw new Error('当前版本未提供版本检查服务')
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
          setError(updateErrorMessage(reason, '读取应用设置失败'))
        }
      })
    return () => {
      active = false
    }
  }, [])

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
      setError(updateErrorMessage(reason, '保存更新设置失败'))
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
      setError(updateErrorMessage(reason, '版本检查失败'))
    } finally {
      setChecking(false)
    }
  }

  return (
    <section
      aria-labelledby="update-settings-heading"
      className="settings-section update-settings"
    >
      <div className="settings-section__title">
        <Info aria-hidden="true" size={17} />
        <div>
          <strong id="update-settings-heading">关于与更新</strong>
          <small>只检查 GoodBuddy 官方 GitHub Release，不自动下载安装</small>
        </div>
      </div>

      <article className="capability-card">
        <div className="capability-card__header">
          <div>
            <strong>GoodBuddy {appInfo?.version ?? '—'}</strong>
            <small>
              {appInfo
                ? `${appInfo.platform} · ${appInfo.arch}`
                : '正在读取应用信息…'}
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
          <span>启动时检查新版本</span>
        </label>

        <div className="update-settings__actions">
          <button
            className="secondary-button"
            disabled={checking}
            onClick={() => void check()}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={13} />
            {checking ? '正在检查…' : '立即检查更新'}
          </button>
          <button
            className="secondary-button"
            onClick={() =>
              void window.goodbuddy.updates?.openReleasePage()
            }
            type="button"
          >
            <ExternalLink aria-hidden="true" size={13} />
            打开官方下载页
          </button>
        </div>
      </article>

      {error && (
        <p className="settings-warning" role="alert">
          {error}
        </p>
      )}
      {result && (
        <article
          aria-live="polite"
          className="capability-card update-settings__result"
        >
          <div className="capability-card__header">
            <div>
              <strong>
                {result.updateAvailable
                  ? `发现新版本 ${result.latestVersion}`
                  : '当前已是最新版本'}
              </strong>
              <small>
                当前 {result.currentVersion} · {result.target.platform}/
                {result.target.arch}
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
            下载前请在发布页核对文件名和 SHA-256。GoodBuddy
            不会自动下载或执行安装包。
          </p>
        </article>
      )}
    </section>
  )
}
