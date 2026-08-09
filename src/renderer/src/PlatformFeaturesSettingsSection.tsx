import { Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ApplicationSettings } from '../../shared/application-settings-contracts'

type PlatformFeaturesSettingsSectionProps = {
  onMagicNotesEnabledChange: (enabled: boolean) => void
}

export function PlatformFeaturesSettingsSection({
  onMagicNotesEnabledChange
}: PlatformFeaturesSettingsSectionProps): React.JSX.Element {
  const [settings, setSettings] = useState<ApplicationSettings>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(() =>
    window.goodbuddy.updates
      ? undefined
      : '当前版本未提供应用设置服务'
  )

  useEffect(() => {
    const updates = window.goodbuddy.updates
    let active = true
    if (!updates) {
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
      .catch(() => {
        if (active) {
          setError('读取平台功能设置失败')
        }
      })
    return () => {
      active = false
    }
  }, [])

  const changeMagicNotes = async (enabled: boolean): Promise<void> => {
    const updates = window.goodbuddy.updates
    if (!updates || !settings) {
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      const nextSettings = await updates.updateSettings({
        magicNotesEnabled: enabled
      })
      setSettings(nextSettings)
      onMagicNotesEnabledChange(nextSettings.magicNotesEnabled)
    } catch {
      setError('保存魔法笔记设置失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      aria-labelledby="platform-features-heading"
      className="settings-section"
    >
      <div className="settings-section__title">
        <Sparkles aria-hidden="true" size={17} />
        <div>
          <strong id="platform-features-heading">平台功能</strong>
          <small>控制 GoodBuddy 工作区中显示的功能入口</small>
        </div>
      </div>
      <article className="capability-card">
        <div className="capability-card__header">
          <div>
            <strong>魔法笔记</strong>
            <small>
              默认关闭；开启后可记录笔记与待办，并使用 AI 分析内容
            </small>
          </div>
        </div>
        <label className="toggle-row">
          <input
            checked={settings?.magicNotesEnabled ?? false}
            disabled={!settings || saving}
            onChange={(event) =>
              void changeMagicNotes(event.target.checked)
            }
            role="switch"
            type="checkbox"
          />
          <span>显示魔法笔记入口</span>
        </label>
      </article>
      {error && (
        <p className="settings-warning" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
