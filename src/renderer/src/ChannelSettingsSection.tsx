import {
  FlaskConical,
  FolderOpen,
  MessageSquare,
  Save,
  Smartphone,
  Unplug
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
const channelTabs = [
  { id: 'weixin', label: '微信 ClawBot' },
  { id: 'wecom', label: '企业微信' },
  { id: 'dingtalk', label: '钉钉' }
] as const

const emptyDraft: ChannelDraft = {
  enabled: false,
  identifier: '',
  secret: '',
  clearSecret: false,
  allowedSenderIdsText: '',
  allowGroupMessages: false
}

const statusLabels: Record<
  ChannelSettingsSnapshot['wecom']['status']['state'],
  string
> = {
  disabled: '未启用',
  stopped: '已停止',
  starting: '正在连接',
  running: '已连接',
  error: '连接失败'
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
  provider: 'opencode' | 'continue'
): AgentRuntimeSelection {
  return { provider }
}

function runtimeSelectionDescription(
  selection: AgentRuntimeSelection,
  settings: RuntimeSettings
): string {
  if (selection.provider === 'model') {
    const profile = settings.modelProfiles.find(
      (candidate) => candidate.id === selection.profileId
    )
    if (!profile) {
      return '所选直连模型已不存在，请重新选择。'
    }
    if (profile.protocol === 'openai-images-generations') {
      return '所选连接仅支持图片生成，请选择文本模型或 Agent Runtime。'
    }
    if (
      profile.authentication === 'api-key' &&
      !profile.apiKeyConfigured
    ) {
      return '所选直连模型尚未配置密钥，请先到模型连接中完成配置。'
    }
    return `直接使用 ${profile.name}（${profile.modelName}）处理消息。`
  }
  if (selection.provider === 'auto') {
    return '使用模型设置中的默认直连模型处理消息。'
  }
  const runtimeLabel =
    selection.provider === 'opencode' ? 'OpenCode' : 'Continue'
  return `通过 ${runtimeLabel} Agent Runtime 运行，并跟随“Agent Runtime”设置中的全局 ${runtimeLabel} 配置。`
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
  const openCodeSelection = configuredRuntimeSelection(
    'opencode'
  )
  const continueSelection = configuredRuntimeSelection(
    'continue'
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
    continueSelection
  ]
  const selectionByKey = new Map(
    selections.map((selection) => [
      agentRuntimeSelectionKey(selection),
      selection
    ])
  )
  return (
    <section
      aria-label={`${draft.name} 通道项目设置`}
      className="channel-project-settings"
    >
      <div className="channel-project-settings__identity">
        <span>通道项目</span>
        <strong>{draft.name}</strong>
      </div>
      <label className="field">
        <span>默认工作目录</span>
        <div className="channel-project-settings__root">
          <input
            aria-label={`${draft.name} 默认工作目录`}
            maxLength={4_096}
            onChange={(event) =>
              onChange({ ...draft, rootPath: event.target.value })
            }
            value={draft.rootPath}
          />
          <button
            aria-label={`选择 ${draft.name} 默认工作目录`}
            className="secondary-button"
            onClick={onSelectRoot}
            type="button"
          >
            <FolderOpen aria-hidden="true" size={14} />
            选择
          </button>
        </div>
        <small>远程 Execute 只能在此项目目录范围内运行。</small>
      </label>
      <label className="field">
        <span>消息处理后端</span>
        <select
          aria-label={`${draft.name} 消息处理后端`}
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
          <optgroup label="直连模型">
            {selectedDirectUnavailable && (
              <option
                disabled
                value={agentRuntimeSelectionKey(draft.runtimeSelection)}
              >
                {selectedDirectProfile
                  ? `${selectedDirectProfile.name} · ${selectedDirectProfile.modelName}（不可用）`
                  : '原直连模型已不存在'}
              </option>
            )}
            {directProfiles.length === 0 && (
              <option disabled value="model:unavailable">
                暂无可用文本模型
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
          </optgroup>
        </select>
        <small>
          {runtimeSelectionDescription(
            draft.runtimeSelection,
            runtimeSettings
          )}
        </small>
      </label>
      <fieldset className="channel-work-mode">
        <legend>默认模式</legend>
        <SegmentedControl
          ariaLabel={`${draft.name} 默认模式`}
          onChange={(defaultWorkMode) =>
            onChange({ ...draft, defaultWorkMode })
          }
          options={[
            { value: 'ask', label: '对话' },
            { value: 'execute', label: '执行' }
          ]}
          value={draft.defaultWorkMode}
        />
        <small>
          可在消息前加 /ask、/execute、对话：或执行：临时覆盖。
        </small>
      </fieldset>
      <p className="channel-project-settings__risk">
        {draft.defaultWorkMode === 'execute'
          ? '执行消息会立即交给所选后端，不再逐次弹窗确认。'
          : '默认对话时，白名单发送者仍可用 /execute 临时发起执行，且不会弹窗确认。'}
        请只连接可信账号，并将工作目录限制在必要范围。
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
  const title = channel === 'wecom' ? '企业微信' : '钉钉'
  const identifierLabel = channel === 'wecom' ? '机器人 ID' : 'Client ID'
  const secretLabel = channel === 'wecom' ? 'Secret' : 'Client Secret'
  const prefix = `channel-${channel}`

  return (
    <article className="capability-card channel-settings-card">
      <div className="capability-card__header">
        <div>
          <strong>{title}</strong>
          <small>
            {settings.source === 'environment'
              ? '由环境变量提供'
              : settings.secretConfigured
                ? 'Secret 已加密保存'
                : 'Secret 尚未配置'}
          </small>
        </div>
        <span>{statusLabels[settings.status.state]}</span>
      </div>

      {settings.readOnly && (
        <p className="settings-notice">
          当前通道由环境变量管理。请在启动环境中修改配置后重启应用。
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
          type="checkbox"
        />
        <span>启用{title}通道</span>
      </label>

      <label className="field">
        <span>{identifierLabel}</span>
        <input
          aria-label={`${title}${identifierLabel}`}
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
          aria-label={`${title}${secretLabel}`}
          autoComplete="off"
          disabled={settings.readOnly || draft.clearSecret}
          maxLength={4_096}
          onChange={(event) =>
            onChange({ ...draft, secret: event.target.value })
          }
          placeholder={
            settings.secretConfigured ? '留空以保留现有 Secret' : '请输入 Secret'
          }
          type="password"
          value={draft.secret}
        />
      </label>

      {settings.secretConfigured && !settings.readOnly && (
        <label className="toggle-row">
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
          <span>保存时清除现有 Secret</span>
        </label>
      )}

      <label className="field">
        <span>允许的发送者 ID</span>
        <textarea
          aria-label={`${title}允许的发送者 ID`}
          disabled={settings.readOnly}
          onChange={(event) =>
            onChange({
              ...draft,
              allowedSenderIdsText: event.target.value
            })
          }
          placeholder="每行一个 ID，最多 100 个"
          rows={4}
          value={draft.allowedSenderIdsText}
        />
        <small>
          只有白名单内的发送者可以向 GoodBuddy 发消息；留空时不会处理任何发送者。
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
          type="checkbox"
        />
        <span>允许群聊中被提及时响应</span>
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
        {testing ? '正在测试…' : `测试${title}连接`}
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
            <strong id="channel-qr-title">绑定微信 ClawBot</strong>
            <small>请使用个人微信扫码。二维码不会发送到第三方页面。</small>
          </div>
          <button
            aria-label="关闭微信绑定"
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
                alt="微信 ClawBot 绑定二维码"
                src={qrImage.image}
              />
            ) : (
              <div className="channel-qr-dialog__placeholder">
                正在生成二维码…
              </div>
            )}
            <strong>
              {binding.status === 'scanned'
                ? '已扫码，正在确认…'
                : binding.status === 'verification_required'
                  ? '需要输入微信验证码'
                  : '等待扫码'}
            </strong>
            {remaining !== undefined && (
              <small>二维码剩余 {remaining} 秒</small>
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
              <span>验证码</span>
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
              提交验证码
            </button>
          </form>
        )}

        {(binding.status === 'expired' ||
          binding.status === 'failed') && (
          <div className="channel-qr-dialog__failure" role="alert">
            <strong>
              {binding.status === 'expired'
                ? '二维码已过期'
                : '绑定失败'}
            </strong>
            <p>{binding.detail ?? '请重新生成二维码后再试。'}</p>
            <button
              className="primary-button"
              disabled={busy}
              onClick={onRestart}
              type="button"
            >
              重新生成二维码
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
  return (
    <>
      <article className="capability-card channel-settings-card">
        <div className="capability-card__header">
          <div>
            <strong>微信 ClawBot</strong>
            <small>
              {settings.bindingConfigured
                ? `${settings.accountDisplay ?? '微信账号'} · 凭据已加密保存`
                : '尚未绑定个人微信'}
            </small>
          </div>
          <span>{statusLabels[settings.status.state]}</span>
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
            type="checkbox"
          />
          <span>启用微信 ClawBot 通道</span>
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
            {settings.bindingConfigured ? '重新绑定' : '扫码绑定'}
          </button>
          {settings.bindingConfigured && (
            <button
              className="danger-button danger-button--quiet"
              disabled={busy}
              onClick={onDisconnect}
              type="button"
            >
              <Unplug aria-hidden="true" size={14} />
              断开本机绑定
            </button>
          )}
        </div>
        {settings.bindingConfigured && (
          <small>
            断开会删除本机保存的绑定，不保证解除微信服务端授权。
          </small>
        )}
        <small>
          处理已绑定账号发给 ClawBot 的私聊文字、图片和文件，不响应群聊；单条消息最多 4 个附件、合计 12MB。
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
  onNotify = () => undefined
}: {
  onNotify?: (notification: AppNotificationInput) => void
}): React.JSX.Element {
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
    useState<ProjectChannel>('weixin')
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
        throw new Error('当前版本未提供消息通道设置服务')
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
            reason instanceof Error ? reason.message : '读取消息通道设置失败'
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
      setError('通道项目尚未加载')
      return
    }
    const invalidRootIndex = channelProjects.findIndex(
      (project) => project!.rootPath.trim().length === 0
    )
    if (invalidRootIndex >= 0) {
      const invalidChannel = channelOrder[invalidRootIndex]!
      setActiveChannel(invalidChannel)
      setError(
        `${channelTabs[invalidRootIndex]!.label} 必须设置默认工作目录`
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
        message: '消息通道设置已保存并应用',
        dedupeKey: 'channel-settings-saved'
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存消息通道设置失败')
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
        reason instanceof Error ? reason.message : '选择工作目录失败'
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
        reason instanceof Error ? reason.message : '启动微信绑定失败'
      )
      setBinding({
        status: 'failed',
        detail:
          reason instanceof Error ? reason.message : '启动微信绑定失败'
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
        reason instanceof Error ? reason.message : '提交微信验证码失败'
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
        message: '已删除本机保存的微信绑定',
        dedupeKey: 'weixin-binding-disconnected'
      })
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : '断开微信绑定失败'
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
        message:
          channel === 'wecom'
            ? '企业微信连接成功'
            : '钉钉连接成功',
        dedupeKey: `channel-test-${channel}`
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '通道连接测试失败')
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
      <div className="settings-section">
        <p className={error ? 'settings-warning' : 'settings-empty'}>
          {error ?? '正在读取消息通道设置…'}
        </p>
      </div>
    )
  }

  return (
    <section
      aria-labelledby="channel-settings-heading"
      className="settings-section channel-settings"
    >
      <div className="settings-section__title settings-section__title--actions">
        <MessageSquare aria-hidden="true" size={17} />
        <div>
          <strong id="channel-settings-heading">消息通道</strong>
          <small>
            为每个通道配置连接、工作目录、消息处理后端与默认模式
          </small>
        </div>
        <button
          className="primary-button"
          disabled={busy}
          onClick={() => void save()}
          type="button"
        >
          <Save aria-hidden="true" size={13} />
          {busy ? '保存中…' : '保存通道设置'}
        </button>
      </div>

      {snapshot.warning && <p className="settings-warning">{snapshot.warning}</p>}
      {error && <p className="settings-warning" role="alert">{error}</p>}

      <div className="channel-settings__tabs">
        <PageTabs
          ariaLabel="消息通道配置"
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
  )
}
