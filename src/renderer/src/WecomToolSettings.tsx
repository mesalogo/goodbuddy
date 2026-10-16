import { KeyRound, Unplug, Wrench } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  wecomToolCategories,
  type WecomSnapshot,
  type WecomToolCategory,
  type WecomToolSettingsUpdate
} from '../../shared/wecom-contracts'
import { useWecomSnapshot } from './wecom-snapshot'
import './wecom.css'

/** WeCom work tools: authorization of the personal smart bot and category switches. */
export function WecomToolSettings({
  channelBotConfigured
}: {
  /** The Connection tab already holds a bot ID and Secret. */
  channelBotConfigured: boolean
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const { snapshot, error: loadError, setSnapshot } = useWecomSnapshot()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const act = async (operation: () => Promise<WecomSnapshot>): Promise<boolean> => {
    setBusy(true)
    setError(undefined)
    try {
      setSnapshot(await operation())
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('wecom.actionError'))
      return false
    } finally {
      setBusy(false)
    }
  }
  const api = window.goodbuddy?.wecom
  const update = (input: WecomToolSettingsUpdate): void => {
    if (api) void act(() => api.updateSettings(input))
  }

  if (!snapshot || !api) {
    return (
      <article className="capability-card channel-settings-card wecom-tools" aria-label={t('wecom.title')}>
        {loadError
          ? <p className="settings-warning" role="alert">{loadError}</p>
          : <p className="settings-empty" role="status">{t('wecom.loading')}</p>}
      </article>
    )
  }

  const authorized = snapshot.authorization.state === 'authorized'
  return (
    <article className="capability-card channel-settings-card wecom-tools" aria-labelledby="wecom-tools-title">
      <div className="capability-card__header">
        <div>
          <strong id="wecom-tools-title"><Wrench aria-hidden="true" size={14} /> {t('wecom.title')}</strong>
          <small>{t('wecom.description')}</small>
        </div>
        <span>{authorized ? t('wecom.authorized') : t('wecom.unauthorized')}</span>
      </div>

      {!snapshot.platformSupported && <p className="settings-warning" role="alert">{t('wecom.unsupportedPlatform')}</p>}
      {error && <p className="settings-warning" role="alert">{error}</p>}

      {authorized ? (
        <>
          <p>{snapshot.authorization.state === 'authorized' && snapshot.authorization.botId
            ? t('wecom.authorizedAs', { botId: snapshot.authorization.botId })
            : t('wecom.authorizedHelp')}</p>
          <label className="toggle-row" htmlFor="wecom-tools-enabled">
            <input
              checked={snapshot.settings.enabled}
              disabled={busy}
              id="wecom-tools-enabled"
              onChange={(event) => update({ enabled: event.target.checked })}
              role="switch"
              type="checkbox"
            />
            <span>{t('wecom.enable')}</span>
          </label>
          <fieldset className="wecom-tools__categories" disabled={busy || !snapshot.settings.enabled}>
            <legend>{t('wecom.categoriesTitle')}</legend>
            {wecomToolCategories.map((category: WecomToolCategory) => (
              <label className="check-field" key={category}>
                <input
                  checked={snapshot.settings.categories[category]}
                  onChange={(event) => update({ categories: { [category]: event.target.checked } })}
                  type="checkbox"
                />
                <span>
                  {t(`wecom.categories.${category}.label`)}
                  <small>{t(`wecom.categories.${category}.description`)}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="settings-notice">{t('wecom.categoriesHelp')}</p>
          <label className="toggle-row" htmlFor="wecom-tools-message-sessions">
            <input
              checked={snapshot.settings.allowInMessageSessions}
              disabled={busy || !snapshot.settings.enabled}
              id="wecom-tools-message-sessions"
              onChange={(event) => update({ allowInMessageSessions: event.target.checked })}
              role="switch"
              type="checkbox"
            />
            <span>{t('wecom.allowInMessageSessions')}</span>
          </label>
          <small>{t('wecom.allowInMessageSessionsHelp')}</small>
          <div className="channel-binding-actions">
            <button
              className="danger-button danger-button--quiet"
              disabled={busy}
              onClick={() => void act(() => api.disconnect())}
              type="button"
            >
              <Unplug aria-hidden="true" size={14} />
              {t('wecom.disconnect')}
            </button>
          </div>
          <small>{t('wecom.disconnectHelp')}</small>
        </>
      ) : (
        <>
          <p>{t(channelBotConfigured ? 'wecom.connectFromChannel' : 'wecom.connectFirst')}</p>
          {channelBotConfigured && (
            <div className="channel-binding-actions">
              <button
                className="primary-button"
                disabled={busy || !snapshot.platformSupported}
                onClick={() => void act(() => api.authorizeWithChannelBot())}
                type="button"
              >
                <KeyRound aria-hidden="true" size={14} />
                {t('wecom.useChannelBot')}
              </button>
            </div>
          )}
        </>
      )}
    </article>
  )
}
