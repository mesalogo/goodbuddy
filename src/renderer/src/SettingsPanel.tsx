import { Check, KeyRound, LockKeyhole, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  RuntimeSettings,
  RuntimeSettingsInput
} from '../../shared/contracts'
import { defaultRuntimeSettings } from '../../shared/contracts'

type SettingsPanelProps = {
  open: boolean
  onClose: () => void
  onSaved: (settings: RuntimeSettings) => void
}

const credentialLabels: Record<
  RuntimeSettings['credentialSource'],
  string
> = {
  none: '尚未配置',
  encrypted: '已由系统安全存储加密',
  environment: '由环境变量提供'
}

export function SettingsPanel({
  open,
  onClose,
  onSaved
}: SettingsPanelProps): React.JSX.Element | null {
  const [settings, setSettings] = useState<RuntimeSettings>()
  const [provider, setProvider] =
    useState<RuntimeSettingsInput['provider']>(
      defaultRuntimeSettings.provider
    )
  const [baseUrl, setBaseUrl] = useState<string>(
    defaultRuntimeSettings.bigtokenBaseUrl
  )
  const [model, setModel] = useState<string>(
    defaultRuntimeSettings.bigtokenModel
  )
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [toolApproval, setToolApproval] =
    useState<RuntimeSettingsInput['toolApproval']>(
      defaultRuntimeSettings.toolApproval
    )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }
    void window.goodbuddy.settings
      .getRuntime()
      .then((value) => {
        setError(undefined)
        setSaved(false)
        setApiKey('')
        setClearApiKey(false)
        setSettings(value)
        setProvider(value.provider)
        setBaseUrl(value.bigtokenBaseUrl)
        setModel(value.bigtokenModel)
        setToolApproval(value.toolApproval)
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : '读取设置失败')
      })
  }, [open])

  if (!open) {
    return null
  }

  const environmentManaged = settings?.credentialSource === 'environment'

  const close = (): void => {
    setApiKey('')
    setClearApiKey(false)
    setError(undefined)
    onClose()
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    setSaved(false)
    try {
      const apiKeyUpdate: RuntimeSettingsInput['apiKey'] = clearApiKey
        ? { action: 'clear' }
        : apiKey.trim()
          ? { action: 'replace', value: apiKey.trim() }
          : { action: 'keep' }
      const value = await window.goodbuddy.settings.updateRuntime({
        provider,
        bigtokenBaseUrl: baseUrl,
        bigtokenModel: model,
        apiKey: apiKeyUpdate,
        toolApproval
      })
      setSettings(value)
      setApiKey('')
      setClearApiKey(false)
      setSaved(true)
      onSaved(value)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存设置失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-backdrop" role="presentation">
      <section
        aria-labelledby="settings-title"
        aria-modal="true"
        className="settings-panel"
        role="dialog"
      >
        <header className="settings-panel__header">
          <div>
            <p className="eyebrow">RUNTIME CONTROL</p>
            <h2 id="settings-title">模型与 Agent Runtime</h2>
          </div>
          <button
            aria-label="关闭设置"
            className="icon-button"
            onClick={close}
            type="button"
          >
            <X size={19} />
          </button>
        </header>

        <div className="settings-panel__body">
          <label className="field">
            <span>默认 Runtime</span>
            <select
              value={provider}
              onChange={(event) =>
                setProvider(
                  event.target.value as RuntimeSettingsInput['provider']
                )
              }
            >
              <option value="auto">自动选择</option>
              <option value="bigtoken">Bigtoken 直连模型</option>
              <option value="opencode">OpenCode Agent</option>
              <option value="continue">Continue CLI Agent</option>
            </select>
            <small>
              自动模式优先使用已配置的 OpenCode，其次使用 Bigtoken。
            </small>
          </label>

          <div className="settings-section">
            <div className="settings-section__title">
              <KeyRound size={17} />
              <div>
                <strong>Bigtoken</strong>
                <small>Anthropic Messages API</small>
              </div>
            </div>

            <label className="field">
              <span>服务地址</span>
              <input
                disabled={environmentManaged}
                inputMode="url"
                onChange={(event) => setBaseUrl(event.target.value)}
                value={baseUrl}
              />
            </label>
            <label className="field">
              <span>模型</span>
              <input
                disabled={environmentManaged}
                onChange={(event) => setModel(event.target.value)}
                value={model}
              />
            </label>
            <label className="field">
              <span>API Key</span>
              <input
                autoComplete="off"
                disabled={
                  environmentManaged || !settings?.secureStorageAvailable
                }
                onChange={(event) => {
                  setApiKey(event.target.value)
                  setClearApiKey(false)
                }}
                placeholder={
                  settings?.apiKeyConfigured
                    ? '已配置，留空保持不变'
                    : '输入 API Key'
                }
                type="password"
                value={apiKey}
              />
            </label>

            <div className="credential-state">
              <LockKeyhole size={15} />
              <span>
                {settings
                  ? credentialLabels[settings.credentialSource]
                  : '正在读取凭据状态'}
              </span>
              {settings?.credentialSource === 'encrypted' && (
                <button
                  onClick={() => {
                    setApiKey('')
                    setClearApiKey(true)
                  }}
                  type="button"
                >
                  {clearApiKey ? '保存后清除' : '清除凭据'}
                </button>
              )}
            </div>

            {settings && !settings.secureStorageAvailable && (
              <p className="settings-warning">
                当前系统密钥服务不可用。为了避免明文落盘，请使用环境变量提供
                API Key。
              </p>
            )}
          </div>

          <label className="field">
            <span>高风险工具默认授权</span>
            <select
              value={toolApproval}
              onChange={(event) =>
                setToolApproval(
                  event.target.value as RuntimeSettingsInput['toolApproval']
                )
              }
            >
              <option value="always">每次执行都确认</option>
              <option value="session">当前会话授权</option>
              <option value="workspace">当前工作区授权</option>
              <option value="policy">由企业策略决定</option>
            </select>
          </label>
        </div>

        <footer className="settings-panel__footer">
          <div className="settings-feedback">
            {error && <span className="settings-error">{error}</span>}
            {saved && (
              <span className="settings-success">
                <Check size={14} />
                已保存并切换 Runtime
              </span>
            )}
          </div>
          <button className="secondary-button" onClick={close} type="button">
            取消
          </button>
          <button
            className="primary-button"
            disabled={saving}
            onClick={() => void save()}
            type="button"
          >
            {saving ? '保存中…' : '保存设置'}
          </button>
        </footer>
      </section>
    </div>
  )
}
