import {
  FlaskConical,
  FolderOpen,
  Save,
  Smartphone,
  Unplug
} from 'lucide-react'
import type { TFunction } from 'i18next'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import type {
  ChannelConnectionTestResult,
  ChannelSettingsApply,
  ChannelSettingsSnapshot,
  CredentialChannel,
  DingTalkChannelSettingsInput,
  WeComChannelSettingsInput
} from '../../shared/channel-settings-contracts'
import type { RuntimeSettings } from '../../shared/contracts'
import {
  normalizeInteractiveWorkMode,
  projectChannels,
  type AssistantProject,
  type InteractiveWorkMode,
  type ProjectChannel
} from '../../shared/assistant-contracts'
import {
  agentRuntimeSelectionKey,
  isChannelModelProfileUsable,
  repairChannelRuntimeSelection,
  type AgentRuntimeSelection
} from '../../shared/runtime-selection-contracts'
import type { WeixinBindingSnapshot } from '../../shared/weixin-channel-contracts'
import type { AppNotificationInput } from './notifications'
import { trapTabFocus } from './dialog-focus'
import { PageTabs, SegmentedControl } from './WorkspacePrimitives'
import {
  SettingsCategoryHeader,
  SettingsWarningList
} from './SettingsPrimitives'

type ChannelDraft = {
  enabled: boolean
  identifier: string
  secret: string
  clearSecret: boolean
  allowedSenderIdsText: string
  allowGroupMessages: boolean
}

type ChannelProjectDraft = {
  id: string
  name: string
  description: string
  rootPath: string
  defaultWorkMode: InteractiveWorkMode
  runtimeSelection: AgentRuntimeSelection
}

const channelOrder: readonly ProjectChannel[] = projectChannels

const emptyDraft: ChannelDraft = {
  enabled: false,
  identifier: '',
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

function draftFromSnapshot(
  channel: CredentialChannel,
  snapshot: ChannelSettingsSnapshot
): ChannelDraft {
  const settings = snapshot[channel]
  return {
    enabled: settings.enabled,
    identifier:
      channel === 'wecom'
        ? snapshot.wecom.botId
        : snapshot.dingtalk.clientId,
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
  channel: CredentialChannel,
  draft: ChannelDraft
): WeComChannelSettingsInput | DingTalkChannelSettingsInput {
  const common = {
    enabled: draft.enabled,
    secret: secretUpdate(draft),
    allowedSenderIds: allowedSenderIds(draft.allowedSenderIdsText),
    allowGroupMessages: draft.allowGroupMessages
  }
  return channel === 'wecom'
    ? { ...common, botId: draft.identifier.trim() }
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
  const currentIdentifier =
    channel === 'wecom'
      ? snapshot.wecom.botId
      : snapshot.dingtalk.clientId
  return (
    draft.enabled !== current.enabled ||
    draft.identifier.trim() !== currentIdentifier ||
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
          name: project.name,
          description: project.description,
          rootPath: project.rootPath,
          defaultWorkMode: normalizeInteractiveWorkMode(
            project.defaultWorkMode
          ),
          runtimeSelection: repairChannelRuntimeSelection(
            project.runtimeSelection ?? { provider: 'auto' },
            runtimeSettings
          )
        }
      ])
  )
}

function usableChannelModelProfiles(
  settings: RuntimeSettings
): RuntimeSettings['modelProfiles'] {
  return settings.modelProfiles.filter(
    isChannelModelProfileUsable
  )
}

function configuredRuntimeSelection(
  provider: 'opencode' | 'continue' | 'deepseek-harness'
): AgentRuntimeSelection {
  return { provider }
}

function runtimeSelectionDescription(
  selection: AgentRuntimeSelection,
  settings: RuntimeSettings,
  t: TFunction<'integrations'>
): string {
  if (selection.provider === 'model') {
    const profile = settings.modelProfiles.find(
      (candidate) => candidate.id === selection.profileId
    )
    if (!profile) {
      return t('channels.project.missingSelection')
    }
    if (profile.protocol === 'openai-images-generations') {
      return t('channels.project.imageOnlySelection')
    }
    if (
      profile.authentication === 'api-key' &&
      !profile.apiKeyConfigured
    ) {
      return t('channels.project.missingCredential')
    }
    return t('channels.project.directDescription', {
      name: profile.name,
      modelName: profile.modelName
    })
  }
  if (selection.provider === 'auto') {
    return t('channels.project.automaticDescription')
  }
  const runtimeLabel =
    selection.provider === 'opencode'
      ? 'OpenCode'
      : selection.provider === 'continue'
        ? 'Continue'
        : 'DeepSeek Harness'
  return t('channels.project.runtimeDescription', {
    runtime: runtimeLabel
  })
}

function ChannelProjectControls({
  draft,
  onChange,
  onSelectRoot,
  runtimeSettings
}: {
  draft: ChannelProjectDraft
  onChange: (draft: ChannelProjectDraft) => void
  onSelectRoot: () => void
  runtimeSettings: RuntimeSettings
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const openCodeSelection = configuredRuntimeSelection(
    'opencode'
  )
  const continueSelection = configuredRuntimeSelection(
    'continue'
  )
  const deepseekHarnessSelection = configuredRuntimeSelection(
    'deepseek-harness'
  )
  const directProfiles = usableChannelModelProfiles(runtimeSettings)
  const selectedDirectProfileId =
    draft.runtimeSelection.provider === 'model'
      ? draft.runtimeSelection.profileId
      : undefined
  const selectedDirectProfile = runtimeSettings.modelProfiles.find(
    (profile) => profile.id === selectedDirectProfileId
  )
  const selectedDirectUnavailable =
    selectedDirectProfileId !== undefined &&
    !directProfiles.some(
      (profile) => profile.id === selectedDirectProfileId
    )
  const selections = [
    ...directProfiles.map((profile) => ({
        provider: 'model' as const,
        profileId: profile.id
      })),
    openCodeSelection,
    continueSelection,
    deepseekHarnessSelection
  ]
  const selectionByKey = new Map(
    selections.map((selection) => [
      agentRuntimeSelectionKey(selection),
      selection
    ])
  )
  return (
    <section
      aria-label={t('channels.project.sectionAriaLabel', {
        name: draft.name
      })}
      className="channel-project-settings"
    >
      <div className="channel-project-settings__identity">
        <span>{t('channels.project.identity')}</span>
        <strong>{draft.name}</strong>
      </div>
      <label className="field">
        <span>{t('channels.project.rootLabel')}</span>
        <div className="channel-project-settings__root">
          <input
            aria-label={t('channels.project.rootAriaLabel', {
              name: draft.name
            })}
            maxLength={4_096}
            onChange={(event) =>
              onChange({ ...draft, rootPath: event.target.value })
            }
            value={draft.rootPath}
          />
          <button
            aria-label={t('channels.project.selectRootAriaLabel', {
              name: draft.name
            })}
            className="secondary-button"
            onClick={onSelectRoot}
            type="button"
          >
            <FolderOpen aria-hidden="true" size={14} />
            {t('channels.project.select')}
          </button>
        </div>
        <small>{t('channels.project.rootHelp')}</small>
      </label>
      <label className="field">
        <span>{t('channels.project.backendLabel')}</span>
        <select
          aria-label={t('channels.project.backendAriaLabel', {
            name: draft.name
          })}
          onChange={(event) => {
            const runtimeSelection = selectionByKey.get(
              event.target.value
            )
            if (runtimeSelection) {
              onChange({ ...draft, runtimeSelection })
            }
          }}
          value={agentRuntimeSelectionKey(draft.runtimeSelection)}
        >
          <optgroup label={t('channels.project.directModels')}>
            {selectedDirectUnavailable && (
              <option
                disabled
                value={agentRuntimeSelectionKey(draft.runtimeSelection)}
              >
                {selectedDirectProfile
                  ? t('channels.project.unavailableProfile', {
                      name: selectedDirectProfile.name,
                      modelName: selectedDirectProfile.modelName
                    })
                  : t('channels.project.missingProfile')}
              </option>
            )}
            {directProfiles.length === 0 && (
              <option disabled value="model:unavailable">
                {t('channels.project.noTextModels')}
              </option>
            )}
            {directProfiles.map((profile) => {
                const selection = {
                  provider: 'model' as const,
                  profileId: profile.id
                }
                return (
                  <option
                    key={profile.id}
                    value={agentRuntimeSelectionKey(selection)}
                  >
                    {profile.name} · {profile.modelName}
                  </option>
                )
              })}
          </optgroup>
          <optgroup label="Agent Runtime">
            <option value={agentRuntimeSelectionKey(openCodeSelection)}>
              OpenCode
            </option>
            <option value={agentRuntimeSelectionKey(continueSelection)}>
              Continue
            </option>
            <option
              value={agentRuntimeSelectionKey(deepseekHarnessSelection)}
            >
              {t('channels.project.deepseekHarnessOption')}
            </option>
          </optgroup>
        </select>
        <small>
          {runtimeSelectionDescription(
            draft.runtimeSelection,
            runtimeSettings,
            t
          )}
        </small>
      </label>
      <fieldset className="channel-work-mode">
        <legend>{t('channels.project.defaultMode')}</legend>
        <SegmentedControl
          ariaLabel={t('channels.project.defaultModeAriaLabel', {
            name: draft.name
          })}
          onChange={(defaultWorkMode) =>
            onChange({ ...draft, defaultWorkMode })
          }
          options={[
            { value: 'ask', label: t('channels.project.modes.ask') },
            {
              value: 'execute',
              label: t('channels.project.modes.execute')
            }
          ]}
          value={draft.defaultWorkMode}
        />
        <small>
          {t('channels.project.overrideHelp')}
        </small>
      </fieldset>
      <p className="channel-project-settings__risk">
        {draft.defaultWorkMode === 'execute'
          ? t('channels.project.executeRisk')
          : t('channels.project.askRisk')}{' '}
        {t('channels.project.riskSuffix')}
      </p>
    </section>
  )
}

function ChannelEditor({
  channel,
  draft,
  onChange,
  onProjectChange,
  onSelectRoot,
  onTest,
  project,
  runtimeSettings,
  settings,
  testing
}: {
  channel: CredentialChannel
  draft: ChannelDraft
  onChange: (next: ChannelDraft) => void
  onProjectChange: (next: ChannelProjectDraft) => void
  onSelectRoot: () => void
  onTest: () => void
  project: ChannelProjectDraft
  runtimeSettings: RuntimeSettings
  settings: ChannelSettingsSnapshot[CredentialChannel]
  testing: boolean
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const title = t(`channels.tabs.${channel}`)
  const identifierLabel = t(
    `channels.credential.identifiers.${channel}`
  )
  const secretLabel = t(`channels.credential.secrets.${channel}`)
  const prefix = `channel-${channel}`

  return (
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
        <span>{t(`channels.status.${settings.status.state}`)}</span>
      </div>

      {settings.readOnly && (
        <p className="settings-notice">
          {t('channels.credential.readOnly')}
        </p>
      )}
      {settings.status.lastError && (
        <p className="settings-warning" role="alert">
          {settings.status.lastError}
        </p>
      )}

      <label className="toggle-row" htmlFor={`${prefix}-enabled`}>
        <input
          checked={draft.enabled}
          disabled={settings.readOnly}
          id={`${prefix}-enabled`}
          onChange={(event) =>
            onChange({ ...draft, enabled: event.target.checked })
          }
          role="switch"
          type="checkbox"
        />
        <span>{t('channels.credential.enable', { channel: title })}</span>
      </label>

      <label className="field">
        <span>{identifierLabel}</span>
        <input
          aria-label={t('channels.credential.fieldAriaLabel', {
            channel: title,
            field: identifierLabel
          })}
          disabled={settings.readOnly}
          maxLength={256}
          onChange={(event) =>
            onChange({ ...draft, identifier: event.target.value })
          }
          value={draft.identifier}
        />
      </label>

      <label className="field">
        <span>{secretLabel}</span>
        <input
          aria-label={t('channels.credential.fieldAriaLabel', {
            channel: title,
            field: secretLabel
          })}
          autoComplete="off"
          disabled={settings.readOnly || draft.clearSecret}
          maxLength={4_096}
          onChange={(event) =>
            onChange({ ...draft, secret: event.target.value })
          }
          placeholder={
            settings.secretConfigured
              ? t('channels.credential.keepSecret')
              : t('channels.credential.enterSecret')
          }
          type="password"
          value={draft.secret}
        />
      </label>

      {settings.secretConfigured && !settings.readOnly && (
        <label className="check-field">
          <input
            checked={draft.clearSecret}
            onChange={(event) =>
              onChange({
                ...draft,
                clearSecret: event.target.checked,
                secret: event.target.checked ? '' : draft.secret
              })
            }
            type="checkbox"
          />
          <span>{t('channels.credential.clearSecret')}</span>
        </label>
      )}

      <label className="field">
        <span>{t('channels.credential.allowedSenders')}</span>
        <textarea
          aria-label={t(
            'channels.credential.allowedSendersAriaLabel',
            { channel: title }
          )}
          disabled={settings.readOnly}
          onChange={(event) =>
            onChange({
              ...draft,
              allowedSenderIdsText: event.target.value
            })
          }
          placeholder={t(
            'channels.credential.allowedSendersPlaceholder'
          )}
          rows={4}
          value={draft.allowedSenderIdsText}
        />
        <small>
          {t('channels.credential.allowedSendersHelp')}
        </small>
      </label>

      <label className="toggle-row">
        <input
          checked={draft.allowGroupMessages}
          disabled={settings.readOnly}
          onChange={(event) =>
            onChange({
              ...draft,
              allowGroupMessages: event.target.checked
            })
          }
          role="switch"
          type="checkbox"
        />
        <span>{t('channels.credential.groupMessages')}</span>
      </label>

      <ChannelProjectControls
        draft={project}
        onChange={onProjectChange}
        onSelectRoot={onSelectRoot}
        runtimeSettings={runtimeSettings}
      />

      <button
        className="secondary-button"
        disabled={testing}
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

  return (
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
    </div>
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
  onProjectChange,
  onSelectRoot,
  onStartBinding,
  onVerify,
  project,
  runtimeSettings,
  settings
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
  onProjectChange: (next: ChannelProjectDraft) => void
  onSelectRoot: () => void
  onStartBinding: () => void
  onVerify: (code: string) => void
  project: ChannelProjectDraft
  runtimeSettings: RuntimeSettings
  settings: ChannelSettingsSnapshot['weixin']
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  return (
    <>
      <article className="capability-card channel-settings-card">
        <div className="capability-card__header">
          <div>
            <strong>{t('channels.tabs.weixin')}</strong>
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
          <span>{t(`channels.status.${settings.status.state}`)}</span>
        </div>

        {settings.status.lastError && (
          <p className="settings-warning" role="alert">
            {settings.status.lastError}
          </p>
        )}

        <label className="toggle-row" htmlFor="channel-weixin-enabled">
          <input
            checked={enabled}
            disabled={!settings.bindingConfigured}
            id="channel-weixin-enabled"
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
        <small>
          {t('channels.weixin.behaviorHelp')}
        </small>

        <ChannelProjectControls
          draft={project}
          onChange={onProjectChange}
          onSelectRoot={onSelectRoot}
          runtimeSettings={runtimeSettings}
        />
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

export function ChannelSettingsSection({
  initialChannel = 'weixin',
  onNotify = () => undefined
}: {
  initialChannel?: ProjectChannel
  onNotify?: (notification: AppNotificationInput) => void
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const channelTabs = [
    { id: 'weixin', label: t('channels.tabs.weixin') },
    { id: 'wecom', label: t('channels.tabs.wecom') },
    { id: 'dingtalk', label: t('channels.tabs.dingtalk') }
  ] as const
  const [snapshot, setSnapshot] = useState<ChannelSettingsSnapshot>()
  const [runtimeSettings, setRuntimeSettings] =
    useState<RuntimeSettings>()
  const [projects, setProjects] = useState<
    Partial<Record<ProjectChannel, ChannelProjectDraft>>
  >({})
  const [weixinEnabled, setWeixinEnabled] = useState(false)
  const [binding, setBinding] = useState<WeixinBindingSnapshot>({
    status: 'stopped'
  })
  const [bindingOpen, setBindingOpen] = useState(false)
  const [bindingError, setBindingError] = useState<string>()
  const [activeChannel, setActiveChannel] =
    useState<ProjectChannel>(initialChannel)
  const [drafts, setDrafts] = useState<
    Record<CredentialChannel, ChannelDraft>
  >({
    wecom: { ...emptyDraft },
    dingtalk: { ...emptyDraft }
  })
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState<CredentialChannel>()
  const [error, setError] = useState<string>()
  const bindingButtonRef = useRef<HTMLButtonElement>(null)

  const closeBinding = useCallback((): void => {
    bindingButtonRef.current?.focus()
    setBindingOpen(false)
  }, [])

  const applySnapshot = (next: ChannelSettingsSnapshot): void => {
    setSnapshot(next)
    setWeixinEnabled(next.weixin.enabled)
    setDrafts({
      wecom: draftFromSnapshot('wecom', next),
      dingtalk: draftFromSnapshot('dingtalk', next)
    })
  }

  useEffect(() => {
    const api = window.goodbuddy.channels
    let active = true
    void (async () => {
      if (!api) {
        throw new Error(tRef.current('channels.unavailableService'))
      }
      return Promise.all([
        api.getSnapshot(),
        window.goodbuddy.projects.list(false),
        api.getWeixinBinding(),
        window.goodbuddy.settings.getRuntime()
      ])
    })()
      .then(([next, projectList, bindingSnapshot, nextRuntimeSettings]) => {
        if (active) {
          applySnapshot(next)
          setRuntimeSettings(nextRuntimeSettings)
          setProjects(
            projectDraftsFrom(projectList, nextRuntimeSettings)
          )
          setBinding(bindingSnapshot)
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : tRef.current('channels.loadError')
          )
        }
      })
    const removeBindingListener = api?.onWeixinBindingChanged(
      (next) => {
        if (active) {
          setBinding(next)
          if (next.status === 'connected') {
            closeBinding()
            void api.getSnapshot().then(applySnapshot)
          }
        }
      }
    )
    return () => {
      active = false
      removeBindingListener?.()
    }
  }, [closeBinding])

  const save = async (): Promise<void> => {
    const api = window.goodbuddy.channels
    if (!api || !snapshot || !runtimeSettings) {
      return
    }
    const channelProjects = channelOrder.map(
      (channel) => projects[channel]
    )
    if (channelProjects.some((project) => !project)) {
      setError(t('channels.projectsLoadingError'))
      return
    }
    const invalidRootIndex = channelProjects.findIndex(
      (project) => project!.rootPath.trim().length === 0
    )
    if (invalidRootIndex >= 0) {
      const invalidChannel = channelOrder[invalidRootIndex]!
      setActiveChannel(invalidChannel)
      setError(
        t('channels.rootRequired', {
          channel: channelTabs[invalidRootIndex]!.label
        })
      )
      return
    }
    const input: ChannelSettingsApply = {
      ...(weixinEnabled === snapshot.weixin.enabled
        ? {}
        : { weixin: { enabled: weixinEnabled } }),
      ...(!snapshot.wecom.readOnly &&
      channelDraftChanged('wecom', drafts.wecom, snapshot)
        ? { wecom: inputFor('wecom', drafts.wecom) }
        : {}),
      ...(!snapshot.dingtalk.readOnly &&
      channelDraftChanged('dingtalk', drafts.dingtalk, snapshot)
        ? { dingtalk: inputFor('dingtalk', drafts.dingtalk) }
        : {})
    }
    setBusy(true)
    setError(undefined)
    setBindingError(undefined)
    try {
      const updatedProjects = await Promise.all(
        channelProjects.map((project) =>
          window.goodbuddy.projects.update(project!.id, {
            name: project!.name,
            description: project!.description,
            rootPath: project!.rootPath,
            defaultWorkMode: project!.defaultWorkMode,
            runtimeSelection: project!.runtimeSelection
          })
        )
      )
      setProjects(projectDraftsFrom(updatedProjects, runtimeSettings))
      if (Object.keys(input).length > 0) {
        applySnapshot(await api.apply(input))
      }
      onNotify({
        tone: 'success',
        message: t('channels.saved'),
        dedupeKey: 'channel-settings-saved'
      })
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t('channels.saveError')
      )
    } finally {
      setBusy(false)
    }
  }

  const updateProject = (
    channel: ProjectChannel,
    next: ChannelProjectDraft
  ): void => {
    setProjects((current) => ({ ...current, [channel]: next }))
  }

  const selectRoot = async (
    channel: ProjectChannel
  ): Promise<void> => {
    const project = projects[channel]
    if (!project) {
      return
    }
    try {
      const rootPath = await window.goodbuddy.settings.selectWorkspace()
      if (rootPath) {
        updateProject(channel, { ...project, rootPath })
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('channels.selectRootError')
      )
    }
  }

  const startBinding = async (): Promise<void> => {
    const api = window.goodbuddy.channels
    if (!api) {
      return
    }
    setBusy(true)
    setError(undefined)
    setBindingError(undefined)
    setBindingOpen(true)
    try {
      setBinding(await api.startWeixinBinding())
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('channels.startBindingError')
      )
      setBinding({
        status: 'failed',
        detail:
          reason instanceof Error
            ? reason.message
            : t('channels.startBindingError')
      })
    } finally {
      setBusy(false)
    }
  }

  const verifyBinding = async (code: string): Promise<void> => {
    const api = window.goodbuddy.channels
    if (!api) {
      return
    }
    setBusy(true)
    setError(undefined)
    setBindingError(undefined)
    try {
      setBinding(await api.submitWeixinVerification(code))
    } catch (reason) {
      setBindingError(
        reason instanceof Error
          ? reason.message
          : t('channels.verifyBindingError')
      )
    } finally {
      setBusy(false)
    }
  }

  const disconnectWeixin = async (): Promise<void> => {
    const api = window.goodbuddy.channels
    if (!api) {
      return
    }
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
      setError(
        reason instanceof Error
          ? reason.message
          : t('channels.disconnectError')
      )
    } finally {
      setBusy(false)
    }
  }

  const test = async (channel: CredentialChannel): Promise<void> => {
    const api = window.goodbuddy.channels
    if (!api || !snapshot) {
      return
    }
    setTesting(channel)
    setError(undefined)
    try {
      const settings = snapshot[channel].readOnly
        ? undefined
        : channel === 'wecom'
          ? inputFor('wecom', drafts.wecom)
          : inputFor('dingtalk', drafts.dingtalk)
      const result: ChannelConnectionTestResult =
        await api.testConnection(channel, settings)
      if (!result.ok) {
        throw new Error(result.error)
      }
      onNotify({
        tone: 'success',
        message: t('channels.connectionSuccess', {
          channel: t(`channels.tabs.${channel}`)
        }),
        dedupeKey: `channel-test-${channel}`
      })
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t('channels.testError')
      )
    } finally {
      setTesting(undefined)
    }
  }

  const weixinProject = projects.weixin
  const wecomProject = projects.wecom
  const dingtalkProject = projects.dingtalk
  if (
    !snapshot ||
    !runtimeSettings ||
    !weixinProject ||
    !wecomProject ||
    !dingtalkProject
  ) {
    return (
      <>
        <SettingsCategoryHeader
          category="channels"
          error={error}
          headingId="channel-settings-heading"
        />
        {!error && (
          <div className="settings-section">
            <p className="settings-empty">{t('channels.loading')}</p>
          </div>
        )}
      </>
    )
  }

  return (
    <>
      <SettingsCategoryHeader
        actions={
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void save()}
            type="button"
          >
            <Save aria-hidden="true" size={13} />
            {busy ? t('channels.saving') : t('channels.save')}
          </button>
        }
        category="channels"
        error={error}
        headingId="channel-settings-heading"
      />
      <section
        aria-label={t('channels.sectionAriaLabel')}
        className="settings-section channel-settings"
      >
      <SettingsWarningList warnings={snapshot.warnings} />

      <div className="channel-settings__tabs">
        <PageTabs
          ariaLabel={t('channels.sectionAriaLabel')}
          idPrefix="channel-settings"
          onChange={setActiveChannel}
          tabs={channelTabs}
          value={activeChannel}
          variant="segmented"
        />
      </div>

      <div
        aria-labelledby={`channel-settings-tab-${activeChannel}`}
        className="channel-settings__panel"
        id={`channel-settings-panel-${activeChannel}`}
        role="tabpanel"
      >
        {activeChannel === 'weixin' ? (
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
            onProjectChange={(next) =>
              updateProject('weixin', next)
            }
            onSelectRoot={() => void selectRoot('weixin')}
            onStartBinding={() => void startBinding()}
            onVerify={(code) => void verifyBinding(code)}
            project={weixinProject}
            runtimeSettings={runtimeSettings}
            settings={snapshot.weixin}
          />
        ) : activeChannel === 'wecom' ? (
          <ChannelEditor
            channel="wecom"
            draft={drafts.wecom}
            onChange={(next) =>
              setDrafts((current) => ({ ...current, wecom: next }))
            }
            onProjectChange={(next) => updateProject('wecom', next)}
            onSelectRoot={() => void selectRoot('wecom')}
            onTest={() => void test('wecom')}
            project={wecomProject}
            runtimeSettings={runtimeSettings}
            settings={snapshot.wecom}
            testing={testing === 'wecom'}
          />
        ) : (
          <ChannelEditor
            channel="dingtalk"
            draft={drafts.dingtalk}
            onChange={(next) =>
              setDrafts((current) => ({ ...current, dingtalk: next }))
            }
            onProjectChange={(next) =>
              updateProject('dingtalk', next)
            }
            onSelectRoot={() => void selectRoot('dingtalk')}
            onTest={() => void test('dingtalk')}
            project={dingtalkProject}
            runtimeSettings={runtimeSettings}
            settings={snapshot.dingtalk}
            testing={testing === 'dingtalk'}
          />
        )}
      </div>
      </section>
    </>
  )
}
