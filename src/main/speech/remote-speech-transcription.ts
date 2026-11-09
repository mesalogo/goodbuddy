import { z } from 'zod'
import type { SpeechSettings } from '../../shared/speech-settings-contracts'
import { speechTranscriptionResultSchema } from '../../shared/speech-model-contracts'

// At the existing 20-second/16 kHz recording limit this encodes at most 320,000
// samples. Yield between blocks so encoding cannot monopolize Main's event loop.
export async function encodeSpeechWav(samples: Float32Array, sampleRate: number, signal: AbortSignal): Promise<ArrayBuffer> {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const tag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  tag(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); tag(8, 'WAVE')
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  tag(36, 'data'); view.setUint32(40, samples.length * 2, true)
  for (let start = 0; start < samples.length; start += 8192) {
    signal.throwIfAborted()
    for (let i = start; i < Math.min(start + 8192, samples.length); i++) {
      const sample = samples[i]!
      view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
    }
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  return buffer
}

export async function transcribeRemoteSpeech(options: {
  settings: SpeechSettings
  apiKey?: string
  samples: Float32Array
  sampleRate: number
  signal: AbortSignal
  onProgress?: (text: string) => void
  fetch?: typeof fetch
}): Promise<string> {
  const { settings, signal } = options
  const form = new FormData()
  form.set('model', settings.model)
  if (settings.language) form.set('language', settings.language)
  form.set('stream', String(settings.stream))
  form.set('file', new Blob([await encodeSpeechWav(options.samples, options.sampleRate, signal)], { type: 'audio/wav' }), 'recording.wav')
  const response = await (options.fetch ?? globalThis.fetch)(`${settings.baseUrl.replace(/\/+$/u, '')}/audio/transcriptions`, {
    method: 'POST', body: form, signal,
    headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}
  })
  if (!response.ok) {
    const detail = (await response.text()).replaceAll(options.apiKey || '\u0000', '[redacted]').slice(0, 1500)
    throw new Error(`远程语音识别失败（HTTP ${response.status}）：${detail}`)
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return z.object({ text: z.string() }).parse(await response.json()).text
  }
  if (!response.body) throw new Error('语音识别服务返回了空响应')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let complete = false
  const consume = (block: string): void => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data) return
    if (data === '[DONE]') { complete = true; return }
    const event = JSON.parse(data) as { error?: unknown; type?: string; delta?: string; text?: string; choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> }
    if (event.error || event.type === 'error') throw new Error('远程语音识别流返回错误')
    const delta = event.choices?.[0]?.delta?.content ?? (event.type === 'transcript.text.delta' ? event.delta : undefined)
    if (typeof delta === 'string' && delta) {
      text += delta
      speechTranscriptionResultSchema.parse({ text })
      options.onProgress?.(text)
    }
    if (event.type === 'transcript.text.done') {
      if (typeof event.text === 'string') {
        text = event.text
        speechTranscriptionResultSchema.parse({ text })
        options.onProgress?.(text)
      }
      complete = true
    }
  }
  try {
    while (!complete) {
      signal.throwIfAborted()
      const part = await reader.read()
      buffer += decoder.decode(part.value, { stream: !part.done })
      // Normalize CRLF after decoding, including a CR/LF split across reads.
      buffer = buffer.replace(/\r\n/gu, '\n')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        consume(block)
        if (complete) break
      }
      if (part.done) {
        if (buffer.trim()) consume(buffer)
        if (!complete) throw new Error('语音识别流意外中断，请重试')
        break
      }
    }
    return text
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
