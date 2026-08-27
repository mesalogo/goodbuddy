import { ImagePlus, RotateCcw, Save, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  brandingLogoMaximumBytes,
  brandingNameMaximumLength,
  brandingPreferencesEqual,
  brandingSubtitleMaximumLength,
  defaultBrandingPreferences,
  isValidBrandingLogoDataUrl,
  normalizeBrandingPreferences,
  type BrandingPreferences
} from './branding'
import { BrandLockup } from './BrandLockup'
import {
  loadImageDimensions,
  readFileAsDataUrl
} from './file-data-url'

type BrandingSettingsSectionProps = {
  preferences: BrandingPreferences
  fallbackLogo?: string
  onChange: (preferences: BrandingPreferences) => boolean
  onDirtyChange?: (dirty: boolean) => void
}

export function BrandingSettingsSection({
  preferences,
  fallbackLogo,
  onChange,
  onDirtyChange
}: BrandingSettingsSectionProps): React.JSX.Element {
  const { i18n, t } = useTranslation('settings')
  const [draft, setDraft] = useState(preferences)
  const [error, setError] = useState<string>()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const logoReadRef = useRef<AbortController>(null)
  const dirty = !brandingPreferencesEqual(draft, preferences)

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(
    () => () => {
      logoReadRef.current?.abort()
    },
    []
  )

  const save = (): void => {
    const normalized = normalizeBrandingPreferences(draft)
    if (!onChange(normalized)) {
      setError(t('appearance.branding.errors.saveFailed'))
      return
    }
    setDraft(normalized)
    setError(undefined)
  }

  const selectLogo = async (file: File | undefined): Promise<void> => {
    logoReadRef.current?.abort()
    if (!file) {
      return
    }
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)
    ) {
      setError(t('appearance.branding.errors.unsupportedLogo'))
      return
    }
    if (file.size === 0 || file.size > brandingLogoMaximumBytes) {
      setError(t('appearance.branding.errors.logoTooLarge'))
      return
    }
    const controller = new AbortController()
    logoReadRef.current = controller
    try {
      const dataUrl = await readFileAsDataUrl(
        file,
        file.type,
        controller.signal
      )
      if (!isValidBrandingLogoDataUrl(dataUrl)) {
        setError(t('appearance.branding.errors.invalidLogo'))
        return
      }
      const { width, height } = await loadImageDimensions(
        dataUrl,
        controller.signal
      )
      if (
        width <= 0 ||
        height <= 0 ||
        width > 4_096 ||
        height > 4_096 ||
        width * height > 16_000_000
      ) {
        setError(t('appearance.branding.errors.invalidLogo'))
        return
      }
      if (logoReadRef.current !== controller) {
        return
      }
      setDraft((current) => ({
        ...current,
        logoDataUrl: dataUrl
      }))
      setError(undefined)
    } catch {
      if (!controller.signal.aborted) {
        setError(t('appearance.branding.errors.readLogoFailed'))
      }
    } finally {
      if (logoReadRef.current === controller) {
        logoReadRef.current = null
      }
    }
  }

  const previewSubtitle =
    (i18n.resolvedLanguage === 'en-US'
      ? draft.subtitleEnUS
      : draft.subtitleZhCN) || undefined
  const previewLogo = draft.logoDataUrl ?? fallbackLogo

  return (
    <div className="settings-section appearance-settings branding-settings">
      <div className="settings-section__title">
        <ImagePlus aria-hidden="true" size={17} />
        <div>
          <strong>{t('appearance.branding.title')}</strong>
          <small>{t('appearance.branding.description')}</small>
        </div>
      </div>

      <BrandLockup
        ariaLabel={t('appearance.branding.previewLabel')}
        className="branding-settings__preview"
        copyClassName="branding-settings__preview-copy"
        logo={previewLogo}
        markClassName="branding-settings__preview-mark"
        name={draft.name || defaultBrandingPreferences.name}
        role="img"
        subtitle={previewSubtitle}
      />

      <div className="branding-settings__fields">
        <label className="field">
          <span>{t('appearance.branding.fields.name')}</span>
          <input
            maxLength={brandingNameMaximumLength}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                name: event.target.value
              }))
            }
            value={draft.name}
          />
        </label>
        <label className="field">
          <span>{t('appearance.branding.fields.subtitleZhCN')}</span>
          <input
            lang="zh-CN"
            maxLength={brandingSubtitleMaximumLength}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                subtitleZhCN: event.target.value
              }))
            }
            value={draft.subtitleZhCN}
          />
        </label>
        <label className="field">
          <span>{t('appearance.branding.fields.subtitleEnUS')}</span>
          <input
            lang="en-US"
            maxLength={brandingSubtitleMaximumLength}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                subtitleEnUS: event.target.value
              }))
            }
            value={draft.subtitleEnUS}
          />
        </label>
      </div>

      <div className="branding-settings__logo">
        <input
          accept="image/png,image/jpeg,image/webp"
          aria-label={t('appearance.branding.logo.select')}
          hidden
          onChange={(event) => {
            void selectLogo(event.target.files?.[0])
            event.target.value = ''
          }}
          ref={fileInputRef}
          type="file"
        />
        <button
          className="secondary-button"
          onClick={() => fileInputRef.current?.click()}
          type="button"
        >
          <ImagePlus aria-hidden="true" size={13} />
          {t('appearance.branding.logo.select')}
        </button>
        {draft.logoDataUrl && (
          <button
            className="secondary-button"
            onClick={() => {
              logoReadRef.current?.abort()
              setDraft((current) => ({
                name: current.name,
                subtitleZhCN: current.subtitleZhCN,
                subtitleEnUS: current.subtitleEnUS
              }))
              setError(undefined)
            }}
            type="button"
          >
            <Trash2 aria-hidden="true" size={13} />
            {t('appearance.branding.logo.useDefault')}
          </button>
        )}
        <small>{t('appearance.branding.logo.help')}</small>
      </div>

      {error && (
        <p className="settings-warning" role="alert">
          {error}
        </p>
      )}

      <div className="update-settings__actions">
        <button
          className="secondary-button"
          disabled={brandingPreferencesEqual(
            draft,
            defaultBrandingPreferences
          )}
          onClick={() => {
            logoReadRef.current?.abort()
            setDraft({ ...defaultBrandingPreferences })
            setError(undefined)
          }}
          type="button"
        >
          <RotateCcw aria-hidden="true" size={13} />
          {t('appearance.branding.actions.restore')}
        </button>
        <button
          className="primary-button"
          disabled={!dirty}
          onClick={save}
          type="button"
        >
          <Save aria-hidden="true" size={13} />
          {t('appearance.branding.actions.save')}
        </button>
      </div>
    </div>
  )
}
