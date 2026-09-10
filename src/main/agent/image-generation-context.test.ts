import { describe, expect, it, vi } from 'vitest'
import type { AssistantArtifact } from '../../shared/assistant-contracts'
import { agentRequestSchema } from '../../shared/contracts'
import { withImageConversationContext } from './image-conversation-context'
import { ModelAgentRuntime } from './model-runtime'
import type { AgentExecutionRequest, RuntimeEvent } from './runtime'

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: () => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from('converted-png')
    })
  }
}))

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
const artifactId = '00000000-0000-4000-8000-000000000301'
const artifact: AssistantArtifact = {
  id: artifactId, kind: 'image', title: 'First image', mimeType: 'image/png',
  content: `data:image/png;base64,${png}`, byteSize: 8,
  createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z'
}
const request = (): AgentExecutionRequest => ({
  requestId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
  prompt: 'Change only the circle to blue.',
  history: [{ role: 'user', content: 'Red circle on the left, green square on the right.' }],
  imageContextArtifactIds: [artifactId]
})
const imageResponse = () => Response.json({ data: [{ b64_json: png }] })
const runtime = (fetcher: typeof fetch) => new ModelAgentRuntime({
  apiKey: 'test-key', baseUrl: 'https://example.test/v1',
  model: 'sub-gpt-image-2', protocol: 'openai-images-generations',
  authentication: 'api-key', imageGenerationQuality: 'low', fetcher
})
async function collect(
  model: ModelAgentRuntime,
  input: AgentExecutionRequest,
  signal = new AbortController().signal
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []
  for await (const event of model.run(input, signal)) events.push(event)
  return events
}

describe('image conversation context', () => {
  it('accepts bounded artifact references without expanding text history contracts', () => {
    expect(agentRequestSchema.parse(request()).imageContextArtifactIds).toEqual([artifactId])
    expect(() => agentRequestSchema.parse({
      ...request(), imageContextArtifactIds: ['not-an-id']
    })).toThrow()
    expect(() => agentRequestSchema.parse({
      ...request(), imageContextArtifactIds: Array(9).fill(artifactId)
    })).toThrow()
  })

  it('loads persisted images without runtime memory and sends both image and text context', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => imageResponse())
    const input = withImageConversationContext(request(), () => artifact)
    const events = await collect(runtime(fetcher), input)
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toBe('https://example.test/v1/images/edits')
    const form = init!.body as FormData
    expect(form.get('model')).toBe('sub-gpt-image-2')
    expect(form.get('prompt')).toContain(input.history![0]!.content)
    expect(String(form.get('prompt'))).toMatch(/Current image request:\nChange only the circle to blue\.$/u)
    expect(Buffer.from(await (form.get('image') as Blob).arrayBuffer()).toString('base64')).toBe(png)
    expect(events.find((event) => event.type === 'generated-image')).not.toHaveProperty('imageContextNotice')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('prefers explicit attachments without loading unrelated old images', () => {
    const get = vi.fn(() => artifact)
    const input = { ...request(), images: [{ name: 'new.png', mediaType: 'image/png' as const, data: png }] }
    expect(withImageConversationContext(input, get)).toBe(input)
    expect(get).not.toHaveBeenCalled()
  })

  it('continues generation with a footer notice when the referenced image is missing', async () => {
    const input = withImageConversationContext(request(), () => { throw new Error('成果不存在') })
    const fetcher = vi.fn<typeof fetch>(async () => imageResponse())
    const events = await collect(runtime(fetcher), input)
    expect(String(fetcher.mock.calls[0]![0])).toMatch(/\/images\/generations$/u)
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).prompt).toContain(input.history![0]!.content)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'generated-image', imageContextNotice: 'reference-unavailable'
    }))
    expect(events.at(-1)?.type).toBe('done')
  })

  it('does not hide database failures as missing context', () => {
    expect(() => withImageConversationContext(request(), () => {
      throw new Error('database unavailable')
    })).toThrow('database unavailable')
  })

  it('converts stored WebP references to the existing PNG input format', () => {
    const input = withImageConversationContext(request(), () => ({
      ...artifact, mimeType: 'image/webp', content: 'data:image/webp;base64,d2VicA=='
    }))
    expect(input.images?.[0]).toMatchObject({
      mediaType: 'image/png', data: Buffer.from('converted-png').toString('base64')
    })
  })

  it('does not borrow an image from an earlier request in a different conversation', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => imageResponse())
    const model = runtime(fetcher)
    await collect(model, withImageConversationContext(request(), () => artifact))
    await collect(model, { ...request(), history: undefined, imageContextArtifactIds: undefined, prompt: 'A new image' })
    expect(String(fetcher.mock.calls[1]![0])).toMatch(/\/images\/generations$/u)
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body)).prompt).toBe('A new image')
  })

  it('preserves the current instruction after long history rather than truncating it', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => imageResponse())
    const input = { ...request(), history: [{ role: 'user' as const, content: 'x'.repeat(100_000) }] }
    await collect(runtime(fetcher), input)
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).prompt.endsWith(input.prompt)).toBe(true)
  })

  it.each([405, 501, 400])('continues once without images when editing is explicitly unsupported (%i)', async (status) => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { message: 'Image editing is not supported' } }, { status }))
      .mockResolvedValueOnce(imageResponse())
    const events = await collect(runtime(fetcher), withImageConversationContext(request(), () => artifact))
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[1]![0])).toMatch(/\/images\/generations$/u)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'generated-image', imageContextNotice: 'editing-unavailable'
    }))
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1)
  })

  it.each([
    [400, 'Invalid image input'],
    [400, 'Model not found'],
    [401, 'Invalid API key'],
    [403, 'Access denied'],
    [404, 'Model not found'],
    [429, 'Rate limit exceeded'],
    [503, 'Image editing temporarily unavailable']
  ])('does not disguise a real provider failure (%i)', async (status, message) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: message }, { status }))
    await expect(collect(runtime(fetcher), withImageConversationContext(request(), () => artifact)))
      .rejects.toThrow(`HTTP ${status}`)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not retry generation indefinitely when both endpoints are unsupported', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: 'Not implemented' }, { status: 501 }))
    await expect(collect(runtime(fetcher), withImageConversationContext(request(), () => artifact)))
      .rejects.toThrow('HTTP 501')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('honors cancellation before falling back to generation', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>(async () => {
      controller.abort(new Error('cancelled'))
      return Response.json({ error: 'Image editing is not supported' }, { status: 400 })
    })
    await expect(collect(runtime(fetcher), withImageConversationContext(request(), () => artifact), controller.signal))
      .rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
