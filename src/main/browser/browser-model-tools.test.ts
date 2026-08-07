import { describe, expect, it, vi } from 'vitest'
import {
  BrowserModelTools,
  browserBackInputSchema,
  browserClickInputSchema,
  browserNavigateInputSchema,
  browserScreenshotInputSchema,
  browserSelectInputSchema,
  browserSnapshotInputSchema,
  browserTypeInputSchema,
  type BrowserToolService
} from './browser-model-tools'

function createService(): BrowserToolService {
  return {
    getOrigin: vi.fn(() => 'https://example.com'),
    navigate: vi.fn(async (_conversationId, url) => ({
      url,
      origin: 'https://example.com'
    })),
    snapshot: vi.fn(async () => ({
      url: 'https://example.com/',
      title: 'Example',
      nodes: [],
      truncated: false
    })),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    back: vi.fn(async () => ({
      url: 'https://previous.example/',
      origin: 'https://previous.example'
    })),
    screenshot: vi.fn(async () => ({
      type: 'image' as const,
      mimeType: 'image/jpeg' as const,
      data: '/9j/2Q=='
    })),
    releaseConversation: vi.fn(async () => undefined)
  }
}

const signal = new AbortController().signal
const ref = 'b_abcdefghijklmnop'

describe('BrowserModelTools', () => {
  it('publishes seven strict, bounded builtin tool definitions', () => {
    const tools = new BrowserModelTools({
      service: createService(),
      conversationId: 'conversation'
    })
    const definitions = tools.listTools()
    expect(definitions.map((definition) => definition.name)).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_select',
      'browser_back',
      'browser_screenshot'
    ])
    expect(
      definitions.every(
        (definition) =>
          definition.source === 'builtin' &&
          definition.inputSchema.additionalProperties === false
      )
    ).toBe(true)
    expect(tools.ownsTool('browser_upload')).toBe(false)
    expect(tools.ownsTool('browser_download')).toBe(false)
  })

  it('uses strict Zod parsing for every operation', () => {
    const cases: Array<[typeof browserSnapshotInputSchema, unknown]> = [
      [browserNavigateInputSchema, { url: 'https://example.com', extra: true }],
      [browserSnapshotInputSchema, { extra: true }],
      [browserClickInputSchema, { ref: 'not-a-ref' }],
      [browserTypeInputSchema, { ref, text: '', extra: true }],
      [browserSelectInputSchema, { ref, value: '', extra: true }],
      [browserBackInputSchema, { extra: true }],
      [browserScreenshotInputSchema, { extra: true }]
    ]
    for (const [schema, value] of cases) {
      expect(() => schema.parse(value)).toThrow()
    }
    expect(() =>
      browserNavigateInputSchema.parse({ url: 'file:///etc/passwd' })
    ).not.toThrow()
    // Zod limits shape and size; the URL policy is deliberately applied by
    // approval/call handling so non-HTTP schemes still fail before execution.
  })

  it('creates dynamic origin-scoped navigation approvals without exposing query values', () => {
    const tools = new BrowserModelTools({
      service: createService(),
      conversationId: 'conversation'
    })
    const approval = tools.getApproval('browser_navigate', {
      url: 'https://example.com/path?token=top-secret'
    })
    expect(approval).toMatchObject({
      scopeKey: 'model:browser:navigate:https://example.com',
      allowPermanent: false
    })
    expect(JSON.stringify(approval)).not.toContain('top-secret')
    expect(approval.argumentSummary).toContain('[查询参数已隐藏]')
    expect(() =>
      tools.getApproval('browser_navigate', {
        url: 'file:///etc/passwd'
      })
    ).toThrow('HTTP(S)')
  })

  it('redacts typed and selected values and prevents session-grant reuse', async () => {
    const service = createService()
    const tools = new BrowserModelTools({
      service,
      conversationId: 'conversation'
    })
    const first = tools.getApproval('browser_type', {
      ref,
      text: 'top-secret'
    })
    const second = tools.getApproval('browser_type', {
      ref,
      text: 'top-secret'
    })
    expect(first.scopeKey).not.toBe(second.scopeKey)
    expect(first.allowPermanent).toBe(false)
    expect(first.description).toContain('包括密码字段')
    expect(JSON.stringify(first)).not.toContain('top-secret')

    const result = await tools.callTool(
      'browser_type',
      { ref, text: 'top-secret' },
      signal
    )
    expect(service.type).toHaveBeenCalledWith(
      'conversation',
      ref,
      'top-secret',
      signal
    )
    expect(JSON.stringify(result)).not.toContain('top-secret')
    expect(result.parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('[已隐藏]')
    })

    const selectApproval = tools.getApproval('browser_select', {
      ref,
      value: 'private-value'
    })
    expect(JSON.stringify(selectApproval)).not.toContain('private-value')
  })

  it('dispatches safe operations and returns correctly counted results', async () => {
    const service = createService()
    const tools = new BrowserModelTools({
      service,
      conversationId: 'conversation'
    })
    const navigate = await tools.callTool(
      'browser_navigate',
      { url: 'https://example.com/' },
      signal
    )
    const snapshot = await tools.callTool('browser_snapshot', {}, signal)
    const click = await tools.callTool('browser_click', { ref }, signal)
    const back = await tools.callTool('browser_back', {}, signal)
    for (const result of [navigate, snapshot, click, back]) {
      const part = result.parts[0]
      if (!part || part.type !== 'text') {
        throw new Error('expected text result')
      }
      expect(result.contextBytes).toBe(Buffer.byteLength(part.text))
    }

    const screenshot = await tools.callTool('browser_screenshot', {}, signal)
    expect(screenshot).toEqual({
      parts: [
        {
          type: 'image',
          mimeType: 'image/jpeg',
          data: '/9j/2Q=='
        }
      ],
      contextBytes: Buffer.byteLength('/9j/2Q==')
    })
    await tools.release()
    expect(service.releaseConversation).toHaveBeenCalledWith('conversation')
  })

  it('rejects unknown tools, extra fields, malformed refs, and cancellation', async () => {
    const tools = new BrowserModelTools({
      service: createService(),
      conversationId: 'conversation'
    })
    expect(() =>
      tools.getApproval('browser_click', { ref, extra: true })
    ).toThrow()
    await expect(
      tools.callTool('browser_upload', { path: 'secret.txt' }, signal)
    ).rejects.toThrow('未知浏览器工具')
    const controller = new AbortController()
    controller.abort()
    await expect(
      tools.callTool('browser_snapshot', {}, controller.signal)
    ).rejects.toHaveProperty('name', 'AbortError')
  })
})
