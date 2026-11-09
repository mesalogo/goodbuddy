import { afterEach, expect, it, vi } from 'vitest'
import type { SpeechTranscriptionProgress } from '../../shared/speech-settings-contracts'
import { speechTranscriptionStore, transcribeSpeechWithProgress } from './speech-transcription-store'

const id = '00000000-0000-4000-8000-000000000001'
const previous = window.goodbuddy
afterEach(() => { Object.defineProperty(window, 'goodbuddy', { configurable: true, value: previous }); speechTranscriptionStore.clear(id) })

it('scopes previews to their request and owner, discards cancelled deltas and unsubscribes', async () => {
  let listener!: (progress: SpeechTranscriptionProgress) => void
  let finish!: (value: { text: string }) => void
  const unsubscribe = vi.fn()
  Object.defineProperty(window, 'goodbuddy', { configurable: true, value: { speech: {
    transcribe: () => new Promise<{ text: string }>(resolve => { finish = resolve }),
    cancel: async () => true,
    onProgress: (callback: (progress: SpeechTranscriptionProgress) => void) => { listener = callback; return unsubscribe }
  } } })
  const work = transcribeSpeechWithProgress({ requestId: id, sampleRate: 16000, audio: new Float32Array([0]).buffer }, 'original-conversation')
  listener({ requestId: '00000000-0000-4000-8000-000000000002', text: 'wrong' })
  expect(speechTranscriptionStore.getSnapshot()?.text).toBe('')
  listener({ requestId: id, text: '你好' })
  expect(speechTranscriptionStore.getSnapshot()).toEqual({ requestId: id, owner: 'original-conversation', text: '你好' })
  speechTranscriptionStore.clear(id)
  listener({ requestId: id, text: 'late' })
  expect(speechTranscriptionStore.getSnapshot()).toBeNull()
  finish({ text: '你好' })
  await work
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})
