import { memo, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { speechTranscriptionStore } from './speech-transcription-store'

export const SpeechTranscriptionPreview = memo(function SpeechTranscriptionPreview({ owner }: { owner: string }) {
  const snapshot = useSyncExternalStore(speechTranscriptionStore.subscribe, speechTranscriptionStore.getSnapshot)
  const { t } = useTranslation('settingsSections')
  if (!snapshot || snapshot.owner !== owner || !snapshot.text) return null
  return <div className="settings-section" role="status" aria-live="polite">
    <small>{t('speech.remote.preview')}</small>
    <p>{snapshot.text}</p>
  </div>
})
