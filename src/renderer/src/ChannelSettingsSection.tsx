import { FlaskConical, MessageSquare, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  ChannelConnectionTestResult,
  ChannelSettingsApply,
  ChannelSettingsSnapshot,
  DingTalkChannelSettingsInput,
  ManagedChannel,
  WeComChannelSettingsInput
} from '../../shared/channel-settings-contracts'

type ChannelDraft = {
  enabled: boolean
  identifier: string
  secret: string
  clearSecret: boolean
  allowedSenderIdsText: string
  allowGroupMessages: boolean
}

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
  channel: ManagedChannel,
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
  channel: ManagedChannel,
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

function ChannelEditor({
  channel,
  draft,
  onChange,
  onTest,
  settings,
  testing
}: {
  channel: ManagedChannel
  draft: ChannelDraft
  onChange: (next: ChannelDraft) => void
  onTest: () => void
  settings: ChannelSettingsSnapshot[ManagedChannel]
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
          只有白名单内的发送者可以向 GoodBuddy 发起只读请求。
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

export function ChannelSettingsSection(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ChannelSettingsSnapshot>()
  const [drafts, setDrafts] = useState<Record<ManagedChannel, ChannelDraft>>({
    wecom: { ...emptyDraft },
    dingtalk: { ...emptyDraft }
  })
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState<ManagedChannel>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  const applySnapshot = (next: ChannelSettingsSnapshot): void => {
    setSnapshot(next)
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
        throw new Error('当前版本未提供企业通信设置服务')
      }
      return api.getSnapshot()
    })()
      .then((next) => {
        if (active) {
          applySnapshot(next)
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error ? reason.message : '读取企业通信设置失败'
          )
        }
      })
    return () => {
      active = false
    }
  }, [])

  const save = async (): Promise<void> => {
    const api = window.goodbuddy.channels
    if (!api || !snapshot) {
      return
    }
    const input: ChannelSettingsApply = {
      ...(snapshot.wecom.readOnly
        ? {}
        : { wecom: inputFor('wecom', drafts.wecom) }),
      ...(snapshot.dingtalk.readOnly
        ? {}
        : { dingtalk: inputFor('dingtalk', drafts.dingtalk) })
    }
    if (!input.wecom && !input.dingtalk) {
      setError('所有通道均由环境变量管理，不能在设置中修改')
      return
    }
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      applySnapshot(await api.apply(input))
      setNotice('企业通信设置已保存并应用')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存企业通信设置失败')
    } finally {
      setBusy(false)
    }
  }

  const test = async (channel: ManagedChannel): Promise<void> => {
    const api = window.goodbuddy.channels
    if (!api || !snapshot) {
      return
    }
    setTesting(channel)
    setError(undefined)
    setNotice(undefined)
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
      setNotice(channel === 'wecom' ? '企业微信连接成功' : '钉钉连接成功')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '通道连接测试失败')
    } finally {
      setTesting(undefined)
    }
  }

  if (!snapshot) {
    return (
      <div className="settings-section">
        <p className={error ? 'settings-warning' : 'settings-empty'}>
          {error ?? '正在读取企业通信设置…'}
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
          <strong id="channel-settings-heading">企业通信</strong>
          <small>连接企业微信与钉钉，远程消息仅以只读模式执行</small>
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
      {notice && <p className="settings-success" role="status">{notice}</p>}

      <div className="channel-settings__grid">
        <ChannelEditor
          channel="wecom"
          draft={drafts.wecom}
          onChange={(next) =>
            setDrafts((current) => ({ ...current, wecom: next }))
          }
          onTest={() => void test('wecom')}
          settings={snapshot.wecom}
          testing={testing === 'wecom'}
        />
        <ChannelEditor
          channel="dingtalk"
          draft={drafts.dingtalk}
          onChange={(next) =>
            setDrafts((current) => ({ ...current, dingtalk: next }))
          }
          onTest={() => void test('dingtalk')}
          settings={snapshot.dingtalk}
          testing={testing === 'dingtalk'}
        />
      </div>
    </section>
  )
}
