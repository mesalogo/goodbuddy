// @vitest-environment node
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SpeechSettingsStore } from './speech-settings-store'
import { SpeechTranscriptionService } from './speech-transcription-service'

it('routes remote requests without a local model and aborts an active HTTP stream before retry', async () => {
  const directory = await mkdtemp(resolve('temp/speech-cancel-'))
  let first = true
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { void _chunk }
    if (first) {
      first = false
      response.setHeader('Content-Type', 'text/event-stream')
      response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    } else {
      response.setHeader('Content-Type', 'application/json')
      response.end('{"text":"retry succeeded"}')
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const store = new SpeechSettingsStore(join(directory, 'settings.json'), { isAvailable: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  const resolver = { getSelectedRuntimeModel: vi.fn(async () => undefined) }
  const service = new SpeechTranscriptionService(resolver, undefined, store)
  try {
    await store.update({ settings: { provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'asr', stream: true }, apiKey: { action: 'keep' } })
    const input = { requestId: '00000000-0000-4000-8000-000000000001', sampleRate: 16000, audio: new Float32Array([0, 0.1]).buffer }
    const progress = vi.fn(event => { expect(event.text).toBe('partial'); expect(service.cancel(input.requestId)).toBe(true) })
    await expect(service.transcribe(input, progress)).rejects.toMatchObject({ name: 'AbortError' })
    expect(progress).toHaveBeenCalledTimes(1)
    expect(service.cancel(input.requestId)).toBe(false)
    await expect(service.transcribe(input)).resolves.toEqual({ text: 'retry succeeded' })
    expect(resolver.getSelectedRuntimeModel).not.toHaveBeenCalled()
  } finally {
    service.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
