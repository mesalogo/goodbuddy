import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound } from 'lucide-react'
import { InlineHelp } from './InlineHelp'
import { defaultHttpOcrSettings } from '../../shared/document-parsing-contracts'

type HttpSettings = typeof defaultHttpOcrSettings
const booleanOptionKeys = [
  'useDocOrientationClassify', 'useDocUnwarping', 'useLayoutDetection', 'useChartRecognition',
  'useSealRecognition', 'useOcrForImageBlock', 'prettifyMarkdown', 'showFormulaNumber',
  'formatBlockContent', 'mergeLayoutBlocks', 'layoutNms'
] as const
const contentLabelKeys = [
  'header', 'header_image', 'footer', 'footer_image', 'number', 'footnote', 'aside_text'
] as const
const numericOptionKeys = [
  'layoutThreshold', 'layoutUnclipRatio', 'repetitionPenalty', 'temperature', 'topP',
  'minPixels', 'maxPixels', 'maxNewTokens'
] as const
const textOptionKeys = ['promptLabel', 'layoutMergeBboxesMode'] as const
const restructureOptionKeys = ['mergeTables', 'relevelTitles'] as const

function isContentLabel(key: string): key is (typeof contentLabelKeys)[number] {
  return (contentLabelKeys as readonly string[]).includes(key)
}

export function HttpOcrSettings({ value, onChange, dirty, credentialConfigured, apiKey, onApiKey,
  clearApiKey, onClearApiKey }: {
  value: HttpSettings; onChange: (value: HttpSettings) => void; dirty: boolean
  credentialConfigured: boolean; apiKey: string; onApiKey: (value: string) => void
  clearApiKey: boolean; onClearApiKey: (value: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState('')
  const [error, setError] = useState('')
  const title = t('documentParsing.httpOcr.title')
  return <section className="settings-section http-ocr-settings">
    <div className="settings-section__title">
      <KeyRound aria-hidden="true" size={17} />
      <span className="inline-help-label">
        <strong>{title}</strong>
        <InlineHelp label={title}>{t('documentParsing.httpOcr.help')}</InlineHelp>
      </span>
    </div>
    <div className="runtime-note model-service-form">
    <label className="field"><span>{t('documentParsing.httpOcr.serviceUrl')}</span><input type="url" value={value.baseUrl}
      onChange={(event) => onChange({ ...value, baseUrl: event.target.value })} /></label>
    <label className="field"><span>{t('documentParsing.httpOcr.authentication')}</span><select value={value.authentication}
      onChange={(event) => onChange({ ...value, authentication: event.target.value as HttpSettings['authentication'] })}>
      <option value="none">{t('documentParsing.httpOcr.authNone')}</option><option value="bearer">{t('documentParsing.httpOcr.authBearer')}</option>
    </select></label>
    {value.authentication === 'bearer' && <label className="field"><span>API Key</span>
      <input type="password" autoComplete="off" value={apiKey} onChange={(event) => onApiKey(event.target.value)} />
      <small>{credentialConfigured ? t('documentParsing.httpOcr.credentialSaved') : t('documentParsing.httpOcr.credentialMissing')}</small>
    </label>}
    {credentialConfigured && <label className="inline-help-label"><input type="checkbox" checked={clearApiKey}
      onChange={(event) => onClearApiKey(event.target.checked)} />{t('documentParsing.httpOcr.clearOnSave')}</label>}
    <div className="update-settings__actions">
    <button type="button" className="secondary-button" disabled={dirty || checking}
      aria-describedby={dirty ? 'document-parsing-unsaved-notice' : undefined}
      onClick={() => {
        setChecking(true); setError(''); setCheck('')
        void window.goodbuddy.documentParsing!.checkHttp().then((result) => {
          setCheck(t('documentParsing.httpOcr.checkOk', { time: new Date(result.checkedAt).toLocaleString() }))
        }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : t('documentParsing.httpOcr.checkFailed')) })
          .finally(() => setChecking(false))
      }}>{checking ? t('documentParsing.httpOcr.checking') : t('documentParsing.httpOcr.check')}</button>
    </div>
    {check && <p className="settings-notice" role="status">{check}</p>}{error && <p className="settings-warning" role="alert">{error}</p>}
    <details className="document-parsing-subsection"><summary>{t('documentParsing.httpOcr.advancedTitle')}</summary>
      <p>{t('documentParsing.httpOcr.advancedNote')}</p>
      <div className="document-parsing-control-header">
        <strong>{t('documentParsing.httpOcr.contentFilter')}</strong>
        <button type="button" className="secondary-button" onClick={() => onChange({
          ...value, filterMode: defaultHttpOcrSettings.filterMode, ignoredLabels: []
        })}>{t('documentParsing.httpOcr.restoreDefaults')}</button>
      </div>
      <small>{t('documentParsing.httpOcr.filterHelp')}</small>
      <div className="document-parsing-filter-list">
        {[...new Set([...contentLabelKeys, ...value.ignoredLabels])].map((key) => <label className="toggle-row" key={key}>
          <span>{t('documentParsing.httpOcr.keepLabel', { label: isContentLabel(key) ? t(`documentParsing.httpOcr.contentLabels.${key}`) : key })}</span><input type="checkbox" role="switch" checked={!value.ignoredLabels.includes(key)}
            onChange={(event) => onChange({ ...value, filterMode: 'custom', ignoredLabels: event.target.checked
              ? value.ignoredLabels.filter((label) => label !== key) : [...value.ignoredLabels, key] })} />
        </label>)}
      </div>
      <div className="document-parsing-grid">
        {booleanOptionKeys.map((key) => <label className="field" key={key}><span>{t(`documentParsing.httpOcr.booleanOptions.${key}`)}</span>
          <select value={String(value.options[key] ?? 'default')}
            onChange={(event) => {
              const options = { ...value.options }
              if (event.target.value === 'default') delete options[key]
              else options[key] = event.target.value === 'true'
              onChange({ ...value, options })
            }}><option value="default">{t('documentParsing.httpOcr.optionDefault')}</option><option value="true">{t('documentParsing.httpOcr.optionOn')}</option><option value="false">{t('documentParsing.httpOcr.optionOff')}</option></select>
        </label>)}
        <label className="field"><span>{t('documentParsing.httpOcr.timeout')}</span><input type="number" min={10} max={300} value={value.timeoutSeconds}
          onChange={(event) => onChange({ ...value, timeoutSeconds: Number(event.target.value) })} /></label>
      </div>
      <details className="document-parsing-subsection"><summary>{t('documentParsing.httpOcr.generationTitle')}</summary><p>{t('documentParsing.httpOcr.generationNote')}</p>
        <div className="document-parsing-grid">
          {numericOptionKeys.map((key) => <label className="field" key={key}><span>{t(`documentParsing.httpOcr.numericOptions.${key}`)}</span>
            <input type="number" step="any" value={value.options[key] ?? ''} onChange={(event) => {
              const options = { ...value.options }
              if (event.target.value === '') delete options[key]
              else options[key] = Number(event.target.value)
              onChange({ ...value, options })
            }} />
          </label>)}
          {textOptionKeys.map((key) => <label className="field" key={key}><span>{t(`documentParsing.httpOcr.textOptions.${key}`)}</span>
            <input value={value.options[key] ?? ''} onChange={(event) => {
              const options = { ...value.options }
              if (event.target.value) options[key] = event.target.value
              else delete options[key]
              onChange({ ...value, options })
            }} /></label>)}
          <label className="field"><span>{t('documentParsing.httpOcr.layoutShape')}</span><select value={value.options.layoutShapeMode ?? ''} onChange={(event) => {
            const options = { ...value.options }
            if (event.target.value) options.layoutShapeMode = event.target.value as NonNullable<typeof options.layoutShapeMode>
            else delete options.layoutShapeMode
            onChange({ ...value, options })
          }}><option value="">{t('documentParsing.httpOcr.optionDefault')}</option>{['rect', 'quad', 'poly', 'auto'].map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label>
        </div>
      </details>
      {restructureOptionKeys.map((key) => <label className="toggle-row" key={key}>
        <span>{t(`documentParsing.httpOcr.restructureOptions.${key}`)}</span>
        <input type="checkbox" role="switch" checked={value[key]} onChange={(event) => onChange({ ...value, [key]: event.target.checked })} />
      </label>)}
      <small>{t('documentParsing.httpOcr.restructureNote')}</small>
    </details>
    </div>
  </section>
}
