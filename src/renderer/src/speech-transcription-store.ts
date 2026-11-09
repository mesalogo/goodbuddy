import type { SpeechTranscriptionInput } from '../../shared/speech-model-contracts'
import { speechTranscriptionProgressSchema } from '../../shared/speech-settings-contracts'

type Snapshot = { requestId: string; owner: string; text: string } | null
let snapshot: Snapshot = null
const listeners = new Set<() => void>()
function publish(value: Snapshot): void {
  snapshot = value
  for (const listener of listeners) listener()
}
export const speechTranscriptionStore = {
  getSnapshot: (): Snapshot => snapshot,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  clear: (requestId: string): void => {
    if (snapshot?.requestId === requestId) publish(null)
  }
}

export async function transcribeSpeechWithProgress(input: SpeechTranscriptionInput, owner: string) {
  const api = window.goodbuddy.speech
  if (!api) throw new Error('语音识别服务不可用')
  if (snapshot) throw new Error('已有语音识别正在运行，请稍后重试')
  publish({ requestId: input.requestId, owner, text: '' })
  let frame: number | undefined
  let pending: string | undefined
  const unsubscribe = api.onProgress?.(event => {
    const parsed = speechTranscriptionProgressSchema.safeParse(event)
    if (parsed.success && parsed.data.requestId === input.requestId && snapshot?.requestId === input.requestId) {
      if (!snapshot.text) {
        publish({ requestId: input.requestId, owner, text: parsed.data.text })
      } else {
        pending = parsed.data.text
        frame ??= requestAnimationFrame(() => {
          frame = undefined
          if (snapshot?.requestId === input.requestId && pending !== undefined) publish({ requestId: input.requestId, owner, text: pending })
        })
      }
    }
  })
  try {
    return await api.transcribe(input)
  } finally {
    if (frame !== undefined) cancelAnimationFrame(frame)
    unsubscribe?.()
    speechTranscriptionStore.clear(input.requestId)
  }
}
