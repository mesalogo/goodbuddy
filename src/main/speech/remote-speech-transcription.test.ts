// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { speechSettingsSchema } from '../../shared/speech-settings-contracts'
import { encodeSpeechWav, transcribeRemoteSpeech } from './remote-speech-transcription'

const settings = speechSettingsSchema.parse({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:6080/v1/', model: 'test-asr' })
const options = () => ({ settings, samples: new Float32Array([0, -1, 1]), sampleRate: 16000, signal: new AbortController().signal })

describe('remote speech transcription', () => {
  it('encodes a mono PCM16 WAV and posts the configured multipart fields', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const form = init!.body as FormData
      expect(form.get('model')).toBe('test-asr')
      expect(form.get('language')).toBe('zh')
      expect(form.get('stream')).toBe('false')
      const file = form.get('file') as File
      expect(file.type).toBe('audio/wav')
      const buffer = await file.arrayBuffer()
      expect(new TextDecoder().decode(buffer.slice(0, 4))).toBe('RIFF')
      const view = new DataView(buffer)
      expect(view.getUint32(24, true)).toBe(16000)
      expect(view.getInt16(46, true)).toBe(-32768)
      expect(view.getInt16(48, true)).toBe(32767)
      expect(init!.headers).toEqual({ Authorization: 'Bearer test-secret' })
      return Response.json({ text: '你好' })
    })
    await expect(transcribeRemoteSpeech({ ...options(), apiKey: 'test-secret', fetch: fetcher })).resolves.toBe('你好')
    expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:6080/v1/audio/transcriptions')
  })

  it('decodes UTF-8 and CRLF split at every byte, accumulating provider deltas', async () => {
    const data = ': comment\r\n\r\ndata: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"世界"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n'
    const bytes = new TextEncoder().encode(data)
    let offset = 0
    const progress = vi.fn()
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) controller.close()
      else controller.enqueue(bytes.slice(offset, ++offset))
    } }), { headers: { 'Content-Type': 'text/event-stream' } }))
    await expect(transcribeRemoteSpeech({ ...options(), settings: { ...settings, stream: true }, fetch: fetcher, onProgress: progress })).resolves.toBe('你好世界')
    expect(progress.mock.calls).toEqual([['你好'], ['你好世界']])
  })

  it('supports OpenAI transcription events and rejects truncated streams', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('data: {"type":"transcript.text.delta","delta":"你"}\n\ndata: {"type":"transcript.text.done","text":"你好"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
    await expect(transcribeRemoteSpeech({ ...options(), fetch: fetcher })).resolves.toBe('你好')
    fetcher.mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
    await expect(transcribeRemoteSpeech({ ...options(), fetch: fetcher })).rejects.toThrow('意外中断')
  })

  it('retains HTTP failures but redacts credentials from provider errors', async () => {
    await expect(transcribeRemoteSpeech({ ...options(), apiKey: 'test-secret', fetch: vi.fn(async () => new Response('invalid test-secret', { status: 401 })) })).rejects.toThrow('HTTP 401）：invalid [redacted]')
  })

  it('does not send a request when cancelled during encoding', async () => {
    const controller = new AbortController()
    const work = encodeSpeechWav(new Float32Array(320000), 16000, controller.signal)
    controller.abort()
    await expect(work).rejects.toThrow()
  })
})
