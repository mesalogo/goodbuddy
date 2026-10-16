import {
  FlaskConical,
  Save,
  Settings,
  Smartphone,
  Unplug
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InlineHelp } from './InlineHelp'
import { createPortal } from 'react-dom'
import QRCode from 'qrcode'
import { telegramAllowedSenderIdsSchema } from '../../shared/channel-settings-contracts'
import type {
  ChannelConnectionTestResult,
  ChannelRuntimeStatus,
  ChannelSettingsApply,
  ChannelSettingsSnapshot,
  CredentialChannel,
  DingTalkChannelSettingsInput,
  FeiShuChannelSettingsInput,
  FeishuDomain,
  TelegramChannelSettingsInput,
  WeComChannelSettingsInput
} from '../../shared/channel-settings-contracts'
import type { RuntimeSettings } from '../../shared/contracts'
import {
  type AssistantProject,
  type ProjectCreateInput,
  type ProjectChannel
} from '../../shared/assistant-contracts'
import type { WeixinBindingSnapshot } from '../../shared/weixin-channel-contracts'
import type { AppNotificationInput } from './notifications'
import { createChannelStatusStore, type ChannelStatusStore } from './channel-status-store'
import { useChannelStatus } from './channel-status-selectors'
import { trapTabFocus } from './dialog-focus'
import { ChannelIcon } from './ChannelIcon'
import { SettingsWarningList } from './SettingsPrimitives'
import { PageTabs } from './WorkspacePrimitives'
import { WecomToolSettings } from './WecomToolSettings'
import { FeishuAppRegistration, FeishuToolSettings } from './FeishuToolSettings'
import {
  channelProjectDraft,
  ChannelProjectSettingsFields
} from './ChannelProjectSettingsFields'

type ChannelDraft = {
  enabled: boolean
  identifier: string
  /** Feishu only: feishu.cn or larksuite.com. */
  domain: FeishuDomain
  secret: string
  clearSecret: boolean
  allowedSenderIdsText: string
  allowGroupMessages: boolean
}

type ChannelSettingsTab = 'connection' | 'messages' | 'tools'

type ChannelProjectDraft = ProjectCreateInput & {
  id: string
}

type ChannelProjectOverride = {
  sourceKey: string
  value: ChannelProjectDraft
}

const emptyDraft: ChannelDraft = {
  enabled: false,
  identifier: '',
  domain: 'feishu',
  secret: '',
  clearSecret: false,
  allowedSenderIdsText: '',
  allowGroupMessages: false
}

function allowedSenderIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，\r\n]+/u)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ]
}

function secretUpdate(draft: ChannelDraft) {
  return draft.clearSecret
    ? ({ action: 'clear' } as const)
    : draft.secret.trim()
      ? ({ action: 'replace', value: draft.secret.trim() } as const)
      : ({ action: 'keep' } as const)
}

function currentIdentifier(channel: CredentialChannel, snapshot: ChannelSettingsSnapshot): string {
  return channel === 'wecom'
    ? snapshot.wecom.botId
    : channel === 'dingtalk' ? snapshot.dingtalk.clientId
      : channel === 'feishu' ? snapshot.feishu.appId : ''
}

function draftFromSnapshot(
  channel: CredentialChannel,
  snapshot: ChannelSettingsSnapshot
): ChannelDraft {
  const settings = snapshot[channel]
  return {
    enabled: settings.enabled,
    identifier: currentIdentifier(channel, snapshot),
    domain: snapshot.feishu.domain,
    secret: '',
    clearSecret: false,
    allowedSenderIdsText: settings.allowedSenderIds.join('\n'),
    allowGroupMessages: settings.allowGroupMessages
  }
}

function inputFor(
  channel: 'wecom',
  draft: ChannelDraft
): WeComChannelSettingsInput
function inputFor(
  channel: 'dingtalk',
  draft: ChannelDraft
): DingTalkChannelSettingsInput
function inputFor(
  channel: 'telegram',
  draft: ChannelDraft
): TelegramChannelSettingsInput
function inputFor(
  channel: 'feishu',
  draft: ChannelDraft
): FeiShuChannelSettingsInput
function inputFor(
  channel: CredentialChannel,
  draft: ChannelDraft
): WeComChannelSettingsInput | DingTalkChannelSettingsInput | TelegramChannelSettingsInput | FeiShuChannelSettingsInput {
  const common = {
    enabled: draft.enabled,
    secret: secretUpdate(draft),
    allowedSenderIds: allowedSenderIds(draft.allowedSenderIdsText),
    allowGroupMessages: draft.allowGroupMessages
  }
  return channel === 'telegram'
    ? { ...common, enabled: draft.enabled && !draft.clearSecret, allowGroupMessages: false }
    : channel === 'wecom'
    ? { ...common, botId: draft.identifier.trim() }
    : channel === 'feishu'
    ? { ...common, appId: draft.identifier.trim(), domain: draft.domain }
    : { ...common, clientId: draft.identifier.trim() }
}

function channelDraftChanged(
  channel: CredentialChannel,
  draft: ChannelDraft,
  snapshot: ChannelSettingsSnapshot
): boolean {
  const current = snapshot[channel]
  const nextAllowedSenders = allowedSenderIds(
    draft.allowedSenderIdsText
  )
  return (
    draft.enabled !== current.enabled ||
    draft.identifier.trim() !== currentIdentifier(channel, snapshot) ||
    (channel === 'feishu' && draft.domain !== snapshot.feishu.domain) ||
    draft.secret.trim().length > 0 ||
    draft.clearSecret ||
    draft.allowGroupMessages !== current.allowGroupMessages ||
    nextAllowedSenders.length !== current.allowedSenderIds.length ||
    nextAllowedSenders.some(
      (senderId) => !current.allowedSenderIds.includes(senderId)
    )
  )
}

function projectDraftsFrom(
  projects: AssistantProject[],
  runtimeSettings: RuntimeSettings
): Partial<Record<ProjectChannel, ChannelProjectDraft>> {
  return Object.fromEntries(
    projects
      .filter(
        (
          project
        ): project is AssistantProject & {
          channel: ProjectChannel
        } => project.kind === 'channel' && Boolean(project.channel)
      )
      .map((project) => [
        project.channel,
        {
          id: project.id,
          ...channelProjectDraft(
            {
              name: project.name,
              description: project.description,
              rootPath: project.rootPath,
              runtimeSelection: project.runtimeSelection
            },
            runtimeSettings
          )
        }
      ])
  )
}

function projectDraftKey(project: ChannelProjectDraft): string {
  return JSON.stringify({
    description: project.description,
    rootPath: project.rootPath,
    runtimeSelection: project.runtimeSelection
  })
}

function ChannelProjectCard({
  onChange,
  onSelectRoot,
  project,
  runtimeSettings
}: {
  onChange: (next: ChannelProjectDraft) => void
  onSelectRoot: () => void
  project: ChannelProjectDraft
  runtimeSettings: RuntimeSettings
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  return (
    <article className="capability-card channel-settings-card">
      <div className="capability-card__header">
        <div>
          <strong>{t('channels.project.cardTitle')}</strong>
          <small>{t('channels.project.cardDescription')}</small>
        </div>
      </div>
      <ChannelProjectSettingsFields
        onChange={(next) => onChange({ ...next, id: project.id })}
        onSelectRoot={onSelectRoot}
        runtimeSettings={runtimeSettings}
        value={project}
      />
    </article>
  )
}

const ChannelStatus = memo(function ChannelStatus({
  channel,
  fallback,
  store,
  unconfigured = false,
  errorOnly = false
}: {
  channel: ProjectChannel
  fallback: ChannelRuntimeStatus
  store: ChannelStatusStore
  unconfigured?: boolean
  errorOnly?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation('integrations')
  const status = useChannelStatus(store, channel, fallback)
  if (errorOnly) {
    return status.lastError
      ? <p className="settings-warning" role="alert">{status.lastError}</p>
      : null
  }
  return <span>{unconfigured && (status.state === 'disabled' || status.state === 'stopped')
    ? t('channels.telegram.unconfigured')
    : t(`channels.status.${status.state}`)}</span>
})

function ChannelEditor({
  busy,
  channel,
  draft,
  onChange,
  onProjectChange,
  onSelectRoot,
  onTest,
  project,
  runtimeSettings,
  settings,
  statusStore,
  testing,
  botUsername,
  onReload,
  section
}: {
  section: 'connection' | 'messages'
  busy: boolean
  channel: CredentialChannel
  draft: ChannelDraft
  onChange: (next: ChannelDraft) => void
  onProjectChange: (next: ChannelProjectDraft) => void
  onSelectRoot: () => void
  onTest: () => void
  project: ChannelProjectDraft
  runtimeSettings: RuntimeSettings
  settings: ChannelSettingsSnapshot[CredentialChannel]
  statusStore: ChannelStatusStore
  testing: boolean
  botUsername?: string
  /** Reloads saved settings after credentials were written outside this form. */
  onReload?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const title = t(`channels.tabs.${channel}`)
  const identifierLabel = channel === 'telegram' ? '' : t(`channels.credential.identifiers.${channel}`)
  const secretLabel = t(`channels.credential.secrets.${channel}`)
  const prefix = `channel-${channel}`
  const invalidSenders = channel === 'telegram' && !telegramAllowedSenderIdsSchema.safeParse(allowedSenderIds(draft.allowedSenderIdsText)).success

  if (section === 'messages') {
    return (
      <>
        <article className="capability-card channel-settings-card">
          <div className="capability-card__header">
            <div>
              <strong>{t('channels.sections.messages')}</strong>
              <small>{t('channels.sections.messagesHelp')}</small>
            </div>
          </div>
          {channel === 'telegram' && allowedSenderIds(draft.allowedSenderIdsText).length === 0 && (
            <p className="settings-notice">{t('channels.telegram.noUsers')}</p>
          )}
          <label className="field">
            <span>{t('channels.credential.allowedSenders')}</span>
            <textarea
              aria-invalid={invalidSenders || undefined}
              aria-describedby={invalidSenders ? `${prefix}-senders-error` : undefined}
              aria-label={t('channels.credential.allowedSendersAriaLabel', { channel: title })}
              disabled={settings.readOnly || busy}
              onChange={(event) => onChange({ ...draft, allowedSenderIdsText: event.target.value })}
              placeholder={t('channels.credential.allowedSendersPlaceholder')}
              rows={4}
              value={draft.allowedSenderIdsText}
            />
            <small>
              {t(channel === 'telegram' ? 'channels.telegram.sendersHelp' : 'channels.credential.allowedSendersHelp')}
            </small>
            {invalidSenders && <small className="field-error" id={`${prefix}-senders-error`} role="alert">{t('channels.telegram.invalidSenders')}</small>}
          </label>
          {channel !== 'telegram' && <label className="toggle-row">
            <input
              checked={draft.allowGroupMessages}
              disabled={settings.readOnly || busy}
              onChange={(event) => onChange({ ...draft, allowGroupMessages: event.target.checked })}
              role="switch"
              type="checkbox"
            />
            <span>{t('channels.credential.groupMessages')}</span>
          </label>}
        </article>
        <ChannelProjectCard
          onChange={onProjectChange}
          onSelectRoot={onSelectRoot}
          project={project}
          runtimeSettings={runtimeSettings}
        />
      </>
    )
  }

  return (
    <>
    <article className="capability-card channel-settings-card">
      <div className="capability-card__header">
        <div>
          <strong>{title}</strong>
          <small>
            {settings.source === 'environment'
              ? t('channels.credential.environmentSource')
              : settings.source === 'unreadable'
                ? t('channels.credential.secretUnreadable')
              : settings.secretConfigured
                ? t('channels.credential.secretSaved')
                : t('channels.credential.secretMissing')}
          </small>
        </div>
        <ChannelStatus channel={channel} fallback={settings.status} store={statusStore}
          unconfigured={channel === 'telegram' && !settings.secretConfigured} />
      </div>

      {settings.readOnly && (
        <p className="settings-notice">
          {t('channels.credential.readOnly')}
        </p>
      )}
      <ChannelStatus channel={channel} fallback={settings.status} store={statusStore} errorOnly />

      <label className="toggle-row" htmlFor={`${prefix}-enabled`}>
        <input
          checked={draft.enabled}
          disabled={settings.readOnly || busy}
          id={`${prefix}-enabled`}
          onChange={(event) =>
            onChange({ ...draft, enabled: event.target.checked })
          }
          role="switch"
          type="checkbox"
        />
        <span>{t('channels.credential.enable', { channel: title })}</span>
      </label>

      {channel === 'telegram' && (
        <>
          <p><a href="https://t.me/BotFather" target="_blank" rel="noreferrer">{t('channels.telegram.botFather')}</a></p>
          <p>{t('channels.telegram.setup')}</p>
          <p className="settings-notice">{t('channels.telegram.access')}</p>
          <span className="inline-help-label">
            {t('channels.telegram.connectionHelp')}
            <InlineHelp label={t('channels.telegram.connectionHelp')}>
              {t('channels.telegram.network')} {t('channels.telegram.offline')}
            </InlineHelp>
          </span>
          {botUsername && <p>{t('channels.telegram.bot')} <a href={`https://t.me/${botUsername}`} target="_blank" rel="noreferrer">@{botUsername}</a></p>}
        </>
      )}

      {channel !== 'telegram' && <label className="field">
        <span>{identifierLabel}</span>
        <input
          aria-label={t('channels.credential.fieldAriaLabel', {
            channel: title,
            field: identifierLabel
          })}
          disabled={settings.readOnly || busy}
          maxLength={256}
          onChange={(event) =>
            onChange({ ...draft, identifier: event.target.value })
          }
          value={draft.identifier}
        />
      </label>}

      {channel === 'feishu' && <label className="field">
        <span>{t('channels.feishu.domain')}</span>
        <select
          disabled={settings.readOnly || busy}
          onChange={(event) => onChange({ ...draft, domain: event.target.value === 'lark' ? 'lark' : 'feishu' })}
          value={draft.domain}
        >
          <option value="feishu">{t('channels.feishu.domains.feishu')}</option>
          <option value="lark">{t('channels.feishu.domains.lark')}</option>
        </select>
      </label>}
      {channel === 'feishu' && <p className="settings-notice">{t('channels.feishu.setup')}</p>}
      {channel === 'feishu' && !settings.readOnly && onReload && (
        <FeishuAppRegistration domain={draft.domain} onCreated={onReload} />
      )}

      <label className="field">
        <span>{secretLabel}</span>
        <input
          aria-label={t('channels.credential.fieldAriaLabel', {
            channel: title,
            field: secretLabel
          })}
          autoComplete="off"
          disabled={settings.readOnly || busy || draft.clearSecret}
          maxLength={4_096}
          onChange={(event) =>
            onChange({ ...draft, secret: event.target.value })
          }
          placeholder={
            settings.secretConfigured
              ? t(channel === 'telegram' ? 'channels.telegram.keepToken' : 'channels.credential.keepSecret')
              : t(channel === 'telegram' ? 'channels.telegram.enterToken' : 'channels.credential.enterSecret')
          }
          type="password"
          value={draft.secret}
        />
      </label>

      {settings.secretConfigured && !settings.readOnly && (
        <label className="check-field">
          <input
            checked={draft.clearSecret}
            disabled={busy}
            onChange={(event) =>
              onChange({
                ...draft,
                clearSecret: event.target.checked,
                secret: event.target.checked ? '' : draft.secret
              })
            }
            type="checkbox"
          />
          <span>{t(channel === 'telegram' ? 'channels.telegram.clearToken' : 'channels.credential.clearSecret')}</span>
        </label>
      )}

      <button
        className="secondary-button"
        disabled={busy || draft.clearSecret || invalidSenders}
        onClick={onTest}
        type="button"
      >
        <FlaskConical aria-hidden="true" size={13} />
        {testing
          ? t('channels.credential.testing')
          : t('channels.credential.testConnection', {
              channel: title
            })}
      </button>
    </article>
    </>
  )
}

function WeixinQrDialog({
  binding,
  busy,
  error,
  onClose,
  onRestart,
  onVerify
}: {
  binding: WeixinBindingSnapshot
  busy: boolean
  error?: string
  onClose: () => void
  onRestart: () => void
  onVerify: (code: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const [qrImage, setQrImage] = useState<{
    payload: string
    image: string
  }>()
  const [verificationCode, setVerificationCode] = useState('')
  const [now, setNow] = useState(0)
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const verificationInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (busy) {
        dialogRef.current?.focus()
      } else if (binding.status === 'verification_required') {
        verificationInputRef.current?.focus()
      } else {
        closeButtonRef.current?.focus()
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [binding.status, busy, error])

  useEffect(() => {
    if (!binding.qrPayload) {
      return
    }
    let active = true
    void QRCode.toDataURL(binding.qrPayload, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 280
    }).then((value) => {
      if (active) {
        setQrImage({
          payload: binding.qrPayload!,
          image: value
        })
      }
    })
    return () => {
      active = false
    }
  }, [binding.qrPayload])

  useEffect(() => {
    const initial = window.setTimeout(() => setNow(Date.now()), 0)
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        onClose()
        return
      }
      trapTabFocus(event, dialogRef.current)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const remaining = binding.qrExpiresAt && now > 0
    ? Math.max(
        0,
        Math.ceil(
          (new Date(binding.qrExpiresAt).getTime() - now) / 1_000
        )
      )
    : undefined

  return createPortal(
    <div className="channel-qr-backdrop">
      <section
        aria-labelledby="channel-qr-title"
        aria-modal="true"
        className="channel-qr-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <strong id="channel-qr-title">
              {t('channels.qr.title')}
            </strong>
            <small>
              {t('channels.qr.instructions')}
            </small>
          </div>
          <button
            aria-label={t('channels.qr.close')}
            className="icon-button"
            disabled={busy}
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            ×
          </button>
        </header>

        {(binding.status === 'starting' ||
          binding.status === 'pending' ||
          binding.status === 'scanned' ||
          binding.status === 'verification_required') && (
          <div className="channel-qr-dialog__content">
            {qrImage && qrImage.payload === binding.qrPayload ? (
              <img
                alt={t('channels.qr.imageAlt')}
                src={qrImage.image}
              />
            ) : (
              <div className="channel-qr-dialog__placeholder">
                {t('channels.qr.generating')}
              </div>
            )}
            <strong>
              {binding.status === 'scanned'
                ? t('channels.qr.scanned')
                : binding.status === 'verification_required'
                  ? t('channels.qr.verificationRequired')
                  : t('channels.qr.waiting')}
            </strong>
            {remaining !== undefined && (
              <small>
                {t('channels.qr.remaining', { seconds: remaining })}
              </small>
            )}
          </div>
        )}

        {binding.status === 'verification_required' && (
          <form
            className="channel-verification-form"
            onSubmit={(event) => {
              event.preventDefault()
              onVerify(verificationCode)
            }}
          >
            <label className="field">
              <span>{t('channels.qr.verificationCode')}</span>
              <input
                aria-describedby={
                  error ? 'channel-verification-error' : undefined
                }
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={32}
                onChange={(event) =>
                  setVerificationCode(
                    event.target.value.replace(/\D/gu, '')
                  )
                }
                ref={verificationInputRef}
                required
                value={verificationCode}
              />
              {error && (
                <small
                  className="field-error"
                  id="channel-verification-error"
                  role="alert"
                >
                  {error}
                </small>
              )}
            </label>
            <button
              className="primary-button"
              disabled={busy || !verificationCode}
              type="submit"
            >
              {t('channels.qr.submitVerification')}
            </button>
          </form>
        )}

        {(binding.status === 'expired' ||
          binding.status === 'failed') && (
          <div className="channel-qr-dialog__failure" role="alert">
            <strong>
              {binding.status === 'expired'
                ? t('channels.qr.expired')
                : t('channels.qr.failed')}
            </strong>
            <p>{binding.detail ?? t('channels.qr.retryFallback')}</p>
            <button
              className="primary-button"
              disabled={busy}
              onClick={onRestart}
              type="button"
            >
              {t('channels.qr.regenerate')}
            </button>
          </div>
        )}
      </section>
    </div>,
    document.body
  )
}

function WeixinChannelEditor({
  binding,
  bindingButtonRef,
  bindingOpen,
  bindingError,
  busy,
  enabled,
  onBindingClose,
  onDisconnect,
  onEnabledChange,
  onStartBinding,
  onVerify,
  settings,
  statusStore
}: {
  binding: WeixinBindingSnapshot
  bindingButtonRef: React.RefObject<HTMLButtonElement | null>
  bindingOpen: boolean
  bindingError?: string
  busy: boolean
  enabled: boolean
  onBindingClose: () => void
  onDisconnect: () => void
  onEnabledChange: (enabled: boolean) => void
  onStartBinding: () => void
  onVerify: (code: string) => void
  settings: ChannelSettingsSnapshot['weixin']
  statusStore: ChannelStatusStore
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  return (
    <>
      <article className="capability-card channel-settings-card">
        <div className="capability-card__header">
          <div>
            <span className="inline-help-label">
              <strong>{t('channels.tabs.weixin')}</strong>
              <InlineHelp label={t('channels.tabs.weixin')} id="channel-weixin-behavior-help">{t('channels.weixin.behaviorHelp')}</InlineHelp>
            </span>
            <small>
              {settings.bindingConfigured
                ? t('channels.weixin.bindingSaved', {
                    account:
                      settings.accountDisplay ??
                      t('channels.weixin.accountFallback')
                  })
                : t('channels.weixin.unbound')}
            </small>
          </div>
          <ChannelStatus channel="weixin" fallback={settings.status} store={statusStore} />
        </div>

        <ChannelStatus channel="weixin" fallback={settings.status} store={statusStore} errorOnly />

        <label className="toggle-row" htmlFor="channel-weixin-enabled">
          <input
            checked={enabled}
            disabled={!settings.bindingConfigured}
            id="channel-weixin-enabled"
            aria-describedby="channel-weixin-behavior-help"
            onChange={(event) =>
              onEnabledChange(event.target.checked)
            }
            role="switch"
            type="checkbox"
          />
          <span>{t('channels.weixin.enable')}</span>
        </label>

        <div className="channel-binding-actions">
          <button
            className={
              settings.bindingConfigured
                ? 'secondary-button'
                : 'primary-button'
            }
            disabled={busy}
            onClick={onStartBinding}
            ref={bindingButtonRef}
            type="button"
          >
            <Smartphone aria-hidden="true" size={14} />
            {settings.bindingConfigured
              ? t('channels.weixin.rebind')
              : t('channels.weixin.bind')}
          </button>
          {settings.bindingConfigured && (
            <button
              className="danger-button danger-button--quiet"
              disabled={busy}
              onClick={onDisconnect}
              type="button"
            >
              <Unplug aria-hidden="true" size={14} />
              {t('channels.weixin.disconnect')}
            </button>
          )}
        </div>
        {settings.bindingConfigured && (
          <small>
            {t('channels.weixin.disconnectHelp')}
          </small>
        )}

      </article>
      {bindingOpen && (
        <WeixinQrDialog
          binding={binding}
          busy={busy}
          error={bindingError}
          onClose={onBindingClose}
          onRestart={onStartBinding}
          onVerify={onVerify}
        />
      )}
    </>
  )
}


function useChannelSettingsData(
  onError: (message: string) => void,
  /** Runs in the same update as the first snapshot, so drafts never render stale. */
  onLoaded?: (snapshot: ChannelSettingsSnapshot) => void
) {
  const { t } = useTranslation('integrations')
  const tRef = useRef(t)
  const onErrorRef = useRef(onError)
  const onLoadedRef = useRef(onLoaded)
  useEffect(() => {
    tRef.current = t
    onErrorRef.current = onError
    onLoadedRef.current = onLoaded
  }, [onError, onLoaded, t])
  const [snapshot, setSnapshot] = useState<ChannelSettingsSnapshot>()
  const [statusStore] = useState(createChannelStatusStore)
  const applySnapshot = useCallback((next: ChannelSettingsSnapshot): void => {
    statusStore.seed(next)
    setSnapshot(next)
  }, [statusStore])
  useEffect(() => {
    const api = window.goodbuddy?.channels
    const disconnect = statusStore.connect(api)
    let active = true
    if (!api) {
      onErrorRef.current(tRef.current('channels.unavailableService'))
    } else {
      void api.getSnapshot().then((next) => {
        if (!active) return
        applySnapshot(next)
        onLoadedRef.current?.(next)
      }, (reason: unknown) => {
        if (active) {
          onErrorRef.current(reason instanceof Error ? reason.message : tRef.current('channels.loadError'))
        }
      })
    }
    return () => {
      active = false
      disconnect()
    }
  }, [applySnapshot, statusStore])
  return { snapshot, statusStore, applySnapshot }
}

export function isChannelConfigured(
  channel: ProjectChannel,
  snapshot: ChannelSettingsSnapshot
): boolean {
  return channel === 'weixin'
    ? snapshot.weixin.bindingConfigured
    : snapshot[channel].secretConfigured
}

const PlatformApplicationStatus = memo(function PlatformApplicationStatus({
  channel,
  snapshot,
  store
}: {
  channel: ProjectChannel
  snapshot: ChannelSettingsSnapshot
  store: ChannelStatusStore
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const status = useChannelStatus(store, channel, snapshot[channel].status)
  return (
    <>
      {isChannelConfigured(channel, snapshot)
        ? t(`channels.status.${status.state}`)
        : t('channels.telegram.unconfigured')}
    </>
  )
})

/** Platform application rows shown in the application center. */
export function PlatformApplicationRows({
  channels,
  canOpen,
  onOpen,
  onSettings
}: {
  channels: readonly ProjectChannel[]
  canOpen: (channel: ProjectChannel) => boolean
  onOpen: (channel: ProjectChannel) => void
  onSettings: (channel: ProjectChannel) => void
}): React.JSX.Element {
  const { t } = useTranslation(['integrations', 'app'])
  const [error, setError] = useState<string>()
  const { snapshot, statusStore } = useChannelSettingsData(setError)
  return (
    <>
      {error && <p className="settings-warning" role="alert">{error}</p>}
      {channels.map((channel) => {
        const title = t(`channels.tabs.${channel}`)
        return (
          <article className="application-center__item" key={channel}>
            <div className="application-center__summary">
              <ChannelIcon channel={channel} size={22} />
              <div>
                <div className="application-center__title">
                  <strong>{title}</strong>
                  <small>
                    {t('applications.platform', { ns: 'app' })}
                    {snapshot && <>
                      {' · '}
                      <PlatformApplicationStatus channel={channel} snapshot={snapshot} store={statusStore} />
                    </>}
                  </small>
                </div>
                <p>{t(`applications.descriptions.${channel}`, { ns: 'app' })}</p>
              </div>
            </div>
            <div className="application-center__actions">
              <button
                className="secondary-button"
                type="button"
                disabled={!canOpen(channel)}
                title={t('applications.openChannelHelp', { ns: 'app' })}
                onClick={() => onOpen(channel)}
              >
                {t('applications.open', { ns: 'app' })}
              </button>
              <button
                className="secondary-button"
                type="button"
                title={t('applications.settings', { ns: 'app' })}
                aria-label={`${title} ${t('applications.settings', { ns: 'app' })}`}
                onClick={() => onSettings(channel)}
              >
                <Settings size={16} aria-hidden="true" />
                {t('applications.settings', { ns: 'app' })}
              </button>
            </div>
          </article>
        )
      })}
    </>
  )
}

/** Settings for one message channel, shown as that platform application's settings. */
export function ChannelApplicationSettings({
  channel,
  onNotify = () => undefined,
  onUpdateProject,
  projectList
}: {
  channel: ProjectChannel
  onNotify?: (notification: AppNotificationInput) => void
  onUpdateProject: (
    projectId: string,
    input: ProjectCreateInput
  ) => Promise<AssistantProject>
  projectList: AssistantProject[]
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const [error, setError] = useState<string>()
  const [weixinEnabled, setWeixinEnabled] = useState(false)
  const [draft, setDraft] = useState<ChannelDraft>({ ...emptyDraft })
  const seedDrafts = useCallback((next: ChannelSettingsSnapshot): void => {
    setWeixinEnabled(next.weixin.enabled)
    if (channel !== 'weixin') setDraft(draftFromSnapshot(channel, next))
  }, [channel])
  const { snapshot, statusStore, applySnapshot: seedSnapshot } =
    useChannelSettingsData(setError, seedDrafts)
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings>()
  const [projectOverride, setProjectOverride] = useState<ChannelProjectOverride>()
  const [binding, setBinding] = useState<WeixinBindingSnapshot>({
    status: 'stopped'
  })
  const [bindingOpen, setBindingOpen] = useState(false)
  const [bindingError, setBindingError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [telegramBotUsername, setTelegramBotUsername] = useState<string>()
  const [tab_, setTab] = useState<ChannelSettingsTab>('connection')
  const bindingButtonRef = useRef<HTMLButtonElement>(null)
  const title = t(`channels.tabs.${channel}`)

  // Drafts follow the first snapshot and every later save.
  const applySnapshot = useCallback((next: ChannelSettingsSnapshot): void => {
    seedSnapshot(next)
    seedDrafts(next)
  }, [seedDrafts, seedSnapshot])

  const closeBinding = useCallback((): void => {
    bindingButtonRef.current?.focus()
    setBindingOpen(false)
  }, [])

  useEffect(() => {
    const api = window.goodbuddy?.channels
    let active = true
    void window.goodbuddy.settings.getRuntime().then((next) => {
      if (active) setRuntimeSettings(next)
    }, (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : t('channels.loadError'))
    })
    if (channel !== 'weixin' || !api) {
      return () => { active = false }
    }
    void api.getWeixinBinding().then((next) => {
      if (active) setBinding(next)
    }, () => undefined)
    const removeBindingListener = api.onWeixinBindingChanged((next) => {
      if (!active) return
      setBinding(next)
      if (next.status === 'connected') {
        closeBinding()
        void api.getSnapshot().then(applySnapshot)
      }
    })
    return () => {
      active = false
      removeBindingListener?.()
    }
  }, [applySnapshot, channel, closeBinding, t])

  const persistedProject = useMemo(() => runtimeSettings
    ? projectDraftsFrom(projectList, runtimeSettings)[channel]
    : undefined, [channel, projectList, runtimeSettings])
  const project = persistedProject && projectOverride?.sourceKey === projectDraftKey(persistedProject)
    ? projectOverride.value
    : persistedProject

  const updateProject = (next: ChannelProjectDraft): void => {
    if (!persistedProject) return
    setProjectOverride({ sourceKey: projectDraftKey(persistedProject), value: next })
  }

  const selectRoot = async (): Promise<void> => {
    if (!project) return
    try {
      const rootPath = await window.goodbuddy.settings.selectWorkspace()
      if (rootPath) updateProject({ ...project, rootPath })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('channels.selectRootError'))
    }
  }

  const channelInput = (): ChannelSettingsApply => {
    if (!snapshot) return {}
    if (channel === 'weixin') {
      return weixinEnabled === snapshot.weixin.enabled ? {} : { weixin: { enabled: weixinEnabled } }
    }
    if (snapshot[channel].readOnly) return {}
    if (channel === 'telegram') {
      const state = (statusStore.getState().telegram ?? snapshot.telegram.status).state
      const restart = draft.enabled && (state === 'error' || state === 'stopped')
      return channelDraftChanged('telegram', draft, snapshot) || restart
        ? { telegram: inputFor('telegram', draft) }
        : {}
    }
    if (!channelDraftChanged(channel, draft, snapshot)) return {}
    return channel === 'wecom'
      ? { wecom: inputFor('wecom', draft) }
      : channel === 'feishu'
        ? { feishu: inputFor('feishu', draft) }
        : { dingtalk: inputFor('dingtalk', draft) }
  }

  const save = async (): Promise<void> => {
    const api = window.goodbuddy?.channels
    if (!api || !snapshot || !runtimeSettings) return
    if (channel === 'telegram' && !snapshot.telegram.readOnly &&
      !telegramAllowedSenderIdsSchema.safeParse(allowedSenderIds(draft.allowedSenderIdsText)).success) {
      return
    }
    if (!project) {
      setError(t('channels.projectsLoadingError'))
      return
    }
    if (project.rootPath.trim().length === 0) {
      setError(t('channels.rootRequired', { channel: title }))
      return
    }
    const input = channelInput()
    setBusy(true)
    setError(undefined)
    setBindingError(undefined)
    try {
      await onUpdateProject(project.id, {
        name: project.name,
        description: project.description,
        rootPath: project.rootPath,
        runtimeSelection: project.runtimeSelection
      })
      if (Object.keys(input).length > 0) {
        applySnapshot(await api.apply(input))
      }
      onNotify({
        tone: 'success',
        message: t('channels.saved'),
        dedupeKey: 'channel-settings-saved'
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('channels.saveError'))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Scan registration stores the new app's credentials and the scanner as the
   * only sender. Enable the channel right away, like OpenClaw, instead of
   * leaving a disabled channel that still needs a separate save.
   */
  const completeFeishuRegistration = async (): Promise<void> => {
    const api = window.goodbuddy?.channels
    if (!api) return
    setBusy(true)
    setError(undefined)
    try {
      let next = await api.getSnapshot()
      const saved = next.feishu
      if (!saved.readOnly && !saved.enabled && saved.secretConfigured && saved.appId && saved.allowedSenderIds.length > 0) {
        next = await api.apply({ feishu: {
          enabled: true,
          appId: saved.appId,
          domain: saved.domain,
          secret: { action: 'keep' },
          allowedSenderIds: [...saved.allowedSenderIds],
          allowGroupMessages: saved.allowGroupMessages
        } })
      }
      applySnapshot(next)
      onNotify({ tone: 'success', message: t('channels.feishu.createdEnabled'), dedupeKey: 'feishu-app-created' })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('channels.saveError'))
    } finally {
      setBusy(false)
    }
  }

  const startBinding = async (): Promise<void> => {
    const api = window.goodbuddy?.channels
    if (!api) return
    setBusy(true)
    setError(undefined)
    setBindingError(undefined)
    setBindingOpen(true)
    try {
      setBinding(await api.startWeixinBinding())
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t('channels.startBindingError')
      setError(message)
      setBinding({ status: 'failed', detail: message })
    } finally {
      setBusy(false)
    }
  }

  const verifyBinding = async (code: string): Promise<void> => {
    const api = window.goodbuddy?.channels
    if (!api) return
    setBusy(true)
    setError(undefined)
    setBindingError(undefined)
    try {
      setBinding(await api.submitWeixinVerification(code))
    } catch (reason) {
      setBindingError(reason instanceof Error ? reason.message : t('channels.verifyBindingError'))
    } finally {
      setBusy(false)
    }
  }

  const disconnectWeixin = async (): Promise<void> => {
    const api = window.goodbuddy?.channels
    if (!api) return
    setBusy(true)
    setError(undefined)
    try {
      setBinding(await api.disconnectWeixin())
      applySnapshot(await api.getSnapshot())
      onNotify({
        tone: 'success',
        message: t('channels.disconnected'),
        dedupeKey: 'weixin-binding-disconnected'
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('channels.disconnectError'))
    } finally {
      setBusy(false)
    }
  }

  const test = async (): Promise<void> => {
    const api = window.goodbuddy?.channels
    if (!api || !snapshot || channel === 'weixin') return
    setTesting(true)
    if (channel === 'telegram') setTelegramBotUsername(undefined)
    setError(undefined)
    try {
      const settings = snapshot[channel].readOnly
        ? undefined
        : channel === 'wecom'
          ? inputFor('wecom', draft)
          : channel === 'dingtalk'
            ? inputFor('dingtalk', draft)
            : channel === 'feishu'
              ? inputFor('feishu', draft)
              : inputFor('telegram', draft)
      const result: ChannelConnectionTestResult = await api.testConnection(channel, settings)
      if (!result.ok) throw new Error(result.error)
      if (channel === 'telegram') setTelegramBotUsername(result.botUsername)
      onNotify({
        tone: 'success',
        message: t(channel === 'telegram' ? 'channels.telegram.verified' : 'channels.connectionSuccess', {
          channel: title
        }),
        dedupeKey: `channel-test-${channel}`
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('channels.testError'))
    } finally {
      setTesting(false)
    }
  }

  if (!snapshot || !runtimeSettings || !project) {
    return (
      <section aria-label={title} className="channel-settings">
        {error
          ? <p className="settings-warning" role="alert">{error}</p>
          : <p className="settings-empty" role="status">{t('channels.loading')}</p>}
      </section>
    )
  }
  const hasTools = channel === 'wecom' || channel === 'feishu'
  const tabs: { id: ChannelSettingsTab; label: string }[] = [
    { id: 'connection', label: t('channels.sections.connection') },
    { id: 'messages', label: t('channels.sections.messages') },
    ...(hasTools ? [{ id: 'tools' as const, label: t('channels.sections.tools') }] : [])
  ]
  const activeTab = tabs.some((tab) => tab.id === tab_) ? tab_ : 'connection'
  return (
    <section aria-label={title} className="channel-settings channel-application-settings">
      <PageTabs
        ariaLabel={t('channels.sections.ariaLabel', { channel: title })}
        idPrefix={`channel-${channel}`}
        onChange={setTab}
        tabs={tabs}
        value={activeTab}
      />
      <div
        aria-labelledby={`channel-${channel}-tab-${activeTab}`}
        className="channel-application-settings__panel"
        id={`channel-${channel}-panel-${activeTab}`}
        role="tabpanel"
      >
        {error && <p className="settings-warning" role="alert">{error}</p>}
        <SettingsWarningList warnings={snapshot.warnings} />
        {activeTab === 'tools' ? (
          channel === 'wecom' ? (
            <WecomToolSettings
              channelBotConfigured={Boolean(snapshot.wecom.botId) && snapshot.wecom.secretConfigured}
              onChannelBotSaved={() => {
                const api = window.goodbuddy?.channels
                if (!api) return
                void api.getSnapshot().then(applySnapshot, () => undefined)
                onNotify({ tone: 'success', message: t('channels.wecom.scanSaved'), dedupeKey: 'wecom-bot-created' })
              }}
            />
          ) : <FeishuToolSettings />
        ) : (
          <>
            <div className="channel-settings__panel">
              {channel === 'weixin' ? (
                activeTab === 'connection' ? (
                  <WeixinChannelEditor
                    binding={binding}
                    bindingButtonRef={bindingButtonRef}
                    bindingError={bindingError}
                    bindingOpen={bindingOpen}
                    busy={busy}
                    enabled={weixinEnabled}
                    onBindingClose={closeBinding}
                    onDisconnect={() => void disconnectWeixin()}
                    onEnabledChange={setWeixinEnabled}
                    onStartBinding={() => void startBinding()}
                    onVerify={(code) => void verifyBinding(code)}
                    settings={snapshot.weixin}
                    statusStore={statusStore}
                  />
                ) : (
                  <>
                    <p className="settings-notice">{t('channels.weixin.messagesHelp')}</p>
                    <ChannelProjectCard
                      onChange={updateProject}
                      onSelectRoot={() => void selectRoot()}
                      project={project}
                      runtimeSettings={runtimeSettings}
                    />
                  </>
                )
              ) : (
                <ChannelEditor
                  busy={busy || testing}
                  channel={channel}
                  draft={draft}
                  section={activeTab}
                  botUsername={channel === 'telegram' ? telegramBotUsername : undefined}
                  onReload={channel === 'feishu' ? () => void completeFeishuRegistration() : undefined}
                  onChange={(next) => {
                    if (next.secret !== draft.secret || next.clearSecret !== draft.clearSecret) setTelegramBotUsername(undefined)
                    setDraft(next)
                  }}
                  onProjectChange={updateProject}
                  onSelectRoot={() => void selectRoot()}
                  onTest={() => void test()}
                  project={project}
                  runtimeSettings={runtimeSettings}
                  settings={snapshot[channel]}
                  statusStore={statusStore}
                  testing={testing}
                />
              )}
            </div>
            <div className="channel-application-settings__actions">
              <small>{t('channels.sections.saveHelp')}</small>
              <button
                className="primary-button"
                disabled={busy || testing}
                onClick={() => void save()}
                type="button"
              >
                <Save aria-hidden="true" size={13} />
                {busy ? t('channels.saving') : t('channels.save')}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
