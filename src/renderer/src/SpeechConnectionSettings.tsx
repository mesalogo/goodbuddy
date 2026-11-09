import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { speechSettingsSchema, type SpeechSettings, type SpeechSettingsSnapshot } from '../../shared/speech-settings-contracts'
import { startPcmRecording, type PcmRecording } from './speech-recognition'
import { transcribeSpeechWithProgress, speechTranscriptionStore } from './speech-transcription-store'
import { SpeechTranscriptionPreview } from './SpeechTranscriptionPreview'
import type { AppNotificationInput } from './notifications'

export type SpeechConnectionSettingsHandle = { save: () => Promise<boolean>; discard: () => void }
export const SpeechConnectionSettings = forwardRef<SpeechConnectionSettingsHandle, {
  children: ReactNode
  onDirtyChange: (dirty: boolean) => void
  onNotify: (notification: AppNotificationInput) => void
}>(function SpeechConnectionSettings({ children, onDirtyChange, onNotify }, ref) {
  const { t } = useTranslation('settingsSections')
  const [snapshot, setSnapshot] = useState<SpeechSettingsSnapshot>()
  const [draft, setDraft] = useState<SpeechSettings>(speechSettingsSchema.parse({}))
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [result, setResult] = useState('')
  const recordingRef = useRef<PcmRecording | undefined>(undefined)
  const requestRef = useRef<string | undefined>(undefined)
  const mounted = useRef(true)
  const dirty = Boolean(snapshot && (JSON.stringify(draft) !== JSON.stringify(snapshot.settings) || apiKey || clearKey))
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  useEffect(() => {
    mounted.current = true
    void window.goodbuddy.speech?.getSettings?.().then(value => {
      if (mounted.current) { setSnapshot(value); setDraft(value.settings) }
    }).catch(reason => { if (mounted.current) setError(String(reason)) })
    return () => {
      mounted.current = false
      recordingRef.current?.cancel()
      if (requestRef.current) {
        speechTranscriptionStore.clear(requestRef.current)
        void window.goodbuddy.speech?.cancel(requestRef.current)
      }
    }
  }, [])
  const save = async (): Promise<boolean> => {
    if (!dirty) return true
    const api = window.goodbuddy.speech
    if (!api?.updateSettings) return false
    setError('')
    try {
      const checked = speechSettingsSchema.safeParse(draft)
      if (!checked.success) { setError(checked.error.issues[0]?.message ?? t('speech.remote.invalid')); return false }
      const value = await api.updateSettings({ settings: checked.data, apiKey: clearKey ? { action: 'clear' } : apiKey.trim() ? { action: 'replace', value: apiKey.trim() } : { action: 'keep' } })
      if (mounted.current) { setSnapshot(value); setDraft(value.settings); setApiKey(''); setClearKey(false); onDirtyChange(false) }
      return true
    } catch (reason) {
      onNotify({ tone: 'error', message: reason instanceof Error ? reason.message : String(reason) })
      return false
    }
  }
  const discard = (): void => {
    if (snapshot) setDraft(snapshot.settings)
    setApiKey(''); setClearKey(false); setError(''); onDirtyChange(false)
  }
  useImperativeHandle(ref, () => ({ save, discard }))
  const test = async (): Promise<void> => {
    if (recordingRef.current) { recordingRef.current.stop(); return }
    if (busy) return
    setBusy(true); setResult('')
    try {
      if (!await save() || !mounted.current) return
      const capture = await startPcmRecording(navigator.mediaDevices, window.AudioContext)
      if (!mounted.current) { void capture.result.catch(() => undefined); capture.cancel(); return }
      recordingRef.current = capture; setRecording(true)
      const audio = await capture.result
      recordingRef.current = undefined; setRecording(false)
      if (!mounted.current) return
      const requestId = crypto.randomUUID()
      requestRef.current = requestId
      const started = performance.now()
      const response = await transcribeSpeechWithProgress({ requestId, ...audio }, 'speech-settings')
      if (mounted.current && requestRef.current === requestId) setResult(`${response.text || t('speech.remote.noSpeech')} (${((performance.now() - started) / 1000).toFixed(2)} s)`)
    } catch (reason) {
      if (mounted.current) onNotify({ tone: 'error', message: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      recordingRef.current = undefined; requestRef.current = undefined
      if (mounted.current) { setBusy(false); setRecording(false) }
    }
  }
  if (!window.goodbuddy.speech?.getSettings) return <>{children}</>
  if (!snapshot) return <p role="status">{error || t('speech.loading')}</p>
  return <>
    <section className="settings-section">
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <label className="field"><span>{t('speech.remote.provider')}</span>
          <select value={draft.provider} onChange={event => setDraft({ ...draft, provider: event.target.value as SpeechSettings['provider'] })}>
            <option value="local">{t('speech.remote.local')}</option>
            <option value="openai-compatible">{t('speech.remote.service')}</option>
          </select>
        </label>
        {draft.provider === 'openai-compatible' && <>
          <label className="field"><span>{t('speech.remote.baseUrl')}</span><input value={draft.baseUrl} placeholder="https://example.com/v1" onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
          <label className="field"><span>{t('speech.remote.model')}</span><input value={draft.model} placeholder="qwen3-asr-1.7b" onChange={event => setDraft({ ...draft, model: event.target.value })} /></label>
          <label className="field"><span>API Key</span><input type="password" autoComplete="off" value={apiKey} disabled={!snapshot.secureStorageAvailable} placeholder={snapshot.apiKeyConfigured ? t('speech.remote.keyConfigured') : t('speech.remote.keyOptional')} onChange={event => { setApiKey(event.target.value); setClearKey(false) }} /></label>
          {!snapshot.secureStorageAvailable && <p>{t('speech.remote.storageUnavailable')}</p>}
          {snapshot.apiKeyConfigured && <button type="button" className="secondary-button" onClick={() => { setClearKey(!clearKey); setApiKey('') }}>{t(clearKey ? 'speech.remote.undoClear' : 'speech.remote.clearKey')}</button>}
          <label className="field"><span>{t('speech.remote.language')}</span><input value={draft.language} placeholder={t('speech.remote.autoLanguage')} onChange={event => setDraft({ ...draft, language: event.target.value })} /></label>
          <label className="toggle-row"><span>{t('speech.remote.stream')}</span><input type="checkbox" role="switch" checked={draft.stream} onChange={event => setDraft({ ...draft, stream: event.target.checked })} /></label>
          <p className="settings-help">{t('speech.remote.streamHelp')}</p>
        </>}
      </fieldset>
      {error && <p role="alert" className="settings-warning">{error}</p>}
      <div className="settings-actions">
        <button type="button" className="secondary-button" disabled={!dirty || busy} onClick={() => { setBusy(true); void save().then(ok => { if (ok) onNotify({ tone: 'success', message: t('speech.remote.saved') }) }).finally(() => { if (mounted.current) setBusy(false) }) }}>{t('speech.remote.save')}</button>
        {draft.provider === 'openai-compatible' && <button type="button" className="secondary-button" disabled={busy && !recording} onClick={() => void test()}>{t(recording ? 'speech.remote.stopRecording' : busy ? 'speech.remote.recognizing' : 'speech.remote.test')}</button>}
        {busy && requestRef.current && <button type="button" className="secondary-button" onClick={() => { const id = requestRef.current; if (id) { requestRef.current = undefined; speechTranscriptionStore.clear(id); void window.goodbuddy.speech?.cancel(id) } }}>{t('speech.remote.cancel')}</button>}
      </div>
      <SpeechTranscriptionPreview owner="speech-settings" />
      {result && <p role="status">{result}</p>}
    </section>
    {draft.provider === 'local' && children}
  </>
})
