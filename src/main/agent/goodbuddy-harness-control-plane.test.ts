import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createCanvas } from '@napi-rs/canvas'
import type { Stream } from '@agentclientprotocol/sdk'
import { resolve } from 'node:path'
import {
  GOODBUDDY_HANDSHAKE,
  GOODBUDDY_PREPARE,
  GoodBuddyCredentialProvider,
  GoodBuddyHarnessControlPlane,
  createBoundedAcpStream
} from './goodbuddy-harness-control-plane'
import { GoodBuddyHarnessAttachmentStore } from './goodbuddy-harness-attachment-store'

function controlPlane() {
  return new GoodBuddyHarnessControlPlane(
    {
      on: vi.fn(),
      get: vi.fn()
    } as unknown as Context,
    {
      provider: 'goodbuddy',
      model: 'deepseek-test',
      workspace: resolve('workspace'),
      harnessVersion: '0.1.0-rc.6',
      execution: { mode: 'host' },
      credentialRefs: ['GOODBUDDY_API_KEY'],
      skills: []
    }
  )
}

function stubAgentContext() {
  const listeners = new Map<
    string,
    (...args: unknown[]) => unknown
  >()
  const extNotification = vi.fn(async () => undefined)
  const genuineDefinitions = new Map(
    ['read', 'skill', 'web_search'].map((name) => [
      name,
      { name }
    ])
  )
  const resolvedDefinitions = new Map(genuineDefinitions)
  const handle = {
    agent: {
      session: {
        id: 'session-output',
        header: { id: 'session-output' },
        events: []
      },
      cancel: vi.fn(),
      ctx: {
        tools: {
          get: vi.fn((name: string) =>
            resolvedDefinitions.get(name)
          )
        }
      }
    }
  }
  const ctx = {
    on: vi.fn(
      (
        name: string,
        listener: (...args: unknown[]) => unknown
      ) => {
        listeners.set(name, listener)
        return vi.fn()
      }
    )
  } as unknown as Context
  const subject = new GoodBuddyHarnessControlPlane(ctx, {
    provider: 'goodbuddy',
    model: 'deepseek-test',
    workspace: resolve('workspace'),
    harnessVersion: '0.1.0-rc.6',
    execution: { mode: 'host' },
    credentialRefs: ['GOODBUDDY_API_KEY'],
    skills: [],
    maxEventCharacters: 10_000,
    maxRequestCharacters: 180
  })
  const internals = subject as unknown as {
    connection: {
      extNotification: typeof extNotification
    }
    sessions: Map<
      string,
      {
        handle: typeof handle
        askToolDefinitions: Map<string, unknown>
        inflight: {
          requestId: string
          messageId: string
          mode: 'ask' | 'execute'
          resolve: (reason: string) => void
          reject: (error: unknown) => void
          emittedCharacters: number
          eventTail: Promise<void>
          eventError?: unknown
        }
      }
    >
    observeSessions(): void
  }
  internals.connection = { extNotification }
  internals.sessions.set('session-output', {
    handle,
    askToolDefinitions: genuineDefinitions,
    inflight: {
      requestId: 'request-output',
      messageId: 'message-output',
      mode: 'ask',
      resolve: vi.fn(),
      reject: vi.fn(),
      emittedCharacters: 0,
      eventTail: Promise.resolve()
    }
  })
  internals.observeSessions()
  return {
    listeners,
    extNotification,
    handle,
    internals,
    genuineDefinitions,
    resolvedDefinitions
  }
}

describe('GoodBuddy Harness internal control plane', () => {
  it('advertises and stores only model-enabled inline image prompts', async () => {
    const textOnly = controlPlane() as unknown as {
      createAgentApi(): {
        initialize(): Promise<{
          agentCapabilities: {
            promptCapabilities: { image: boolean }
          }
        }>
      }
      storePromptImages(
        prompt: Array<Record<string, unknown>>
      ): Promise<unknown[]>
    }
    await expect(textOnly.createAgentApi().initialize()).resolves.toMatchObject({
      agentCapabilities: {
        promptCapabilities: { image: false }
      }
    })
    await expect(
      textOnly.storePromptImages([
        {
          type: 'image',
          mimeType: 'image/png',
          data: 'aW1hZ2U='
        }
      ])
    ).rejects.toThrow('does not accept image input')

    const storeContext = new Context()
    const store = new GoodBuddyHarnessAttachmentStore(storeContext)
    const ctx = {
      on: vi.fn(),
      get: vi.fn((name: string) =>
        name === 'attachments' ? store : undefined
      )
    } as unknown as Context
    const subject = new GoodBuddyHarnessControlPlane(ctx, {
      provider: 'goodbuddy',
      model: 'vision-test',
      supportsImageInput: true,
      workspace: resolve('workspace'),
      harnessVersion: '0.1.0-rc.6',
      execution: { mode: 'host' },
      credentialRefs: ['GOODBUDDY_API_KEY'],
      skills: []
    }) as unknown as {
      createAgentApi(): {
        initialize(): Promise<{
          agentCapabilities: {
            promptCapabilities: { image: boolean }
          }
        }>
      }
      storePromptImages(
        prompt: Array<Record<string, unknown>>
      ): Promise<
        Array<
          Parameters<GoodBuddyHarnessAttachmentStore['readImage']>[0]
        >
      >
      releaseAttachments(
        refs: Array<
          Parameters<GoodBuddyHarnessAttachmentStore['readImage']>[0]
        >
      ): void
    }
    const png = createCanvas(1, 1).toBuffer('image/png')

    await expect(subject.createAgentApi().initialize()).resolves.toMatchObject({
      agentCapabilities: {
        promptCapabilities: { image: true }
      }
    })
    const refs = await subject.storePromptImages([
      { type: 'text', text: 'describe this image' },
      {
        type: 'image',
        mimeType: 'image/png',
        data: png.toString('base64')
      }
    ])
    expect(refs).toHaveLength(1)
    await expect(store.readImage(refs[0]!)).resolves.toMatchObject({
      ref: expect.objectContaining({
        mediaType: 'image/png',
        width: 1,
        height: 1
      })
    })

    subject.releaseAttachments(refs)
    await expect(store.readImage(refs[0]!)).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
    await expect(
      subject.storePromptImages([
        {
          type: 'image',
          mimeType: 'image/png',
          data: png.toString('base64'),
          uri: 'https://example.com/reference.png'
        }
      ])
    ).rejects.toThrow('invalid inline image')
    const saveImages = vi.spyOn(store, 'saveImages')
    const largeInlineData = Buffer.alloc(800 * 1024).toString(
      'base64'
    )
    await expect(
      subject.storePromptImages(
        Array.from({ length: 3 }, () => ({
          type: 'image' as const,
          mimeType: 'image/png',
          data: largeInlineData
        }))
      )
    ).rejects.toThrow('invalid inline image')
    expect(saveImages).not.toHaveBeenCalled()
    await storeContext.fiber.dispose()
  })

  it('requires a versioned handshake before privileged extensions', async () => {
    const subject = controlPlane()

    await expect(
      subject.extensionMethod(GOODBUDDY_PREPARE, {
        sessionId: 'session',
        requestId: 'request',
        mode: 'execute'
      })
    ).rejects.toThrow('GoodBuddy handshake is required')
    await expect(
      subject.extensionMethod(GOODBUDDY_HANDSHAKE, {
        controlProtocolVersion: 9
      })
    ).rejects.toThrow(
      'incompatible GoodBuddy Harness control protocol'
    )
    await expect(
      subject.extensionMethod(GOODBUDDY_HANDSHAKE, {
        controlProtocolVersion: 1
      })
    ).resolves.toMatchObject({
      controlProtocolVersion: 1,
      supports: {
        cancellation: true,
        sessionRelease: true,
        credentialResolution: true
      },
      execution: { mode: 'host' }
    })
  })

  it('keeps credentials memory-only, allowlisted, and read-only', async () => {
    const provider = new GoodBuddyCredentialProvider(
      new Context(),
      new Set(['GOODBUDDY_API_KEY'])
    )
    const resolver = vi
      .fn()
      .mockResolvedValue('secret-from-main')
    provider.bind(resolver)

    await expect(
      provider.resolve('GOODBUDDY_API_KEY' as never)
    ).resolves.toEqual({
      value: 'secret-from-main',
      source: 'goodbuddy-main'
    })
    await expect(
      provider.resolve('OTHER_KEY' as never)
    ).resolves.toBeUndefined()
    expect(resolver).toHaveBeenCalledTimes(1)
    await expect(
      provider.set('GOODBUDDY_API_KEY' as never, 'x')
    ).rejects.toThrow('read-only')
  })

  it('fails closed on oversized inbound and outbound ACP frames', async () => {
    const inbound = new TransformStream<
      Record<string, unknown>,
      Record<string, unknown>
    >()
    const outbound = new TransformStream<
      Record<string, unknown>,
      Record<string, unknown>
    >()
    const stream = createBoundedAcpStream(
      ({
        readable: inbound.readable,
        writable: outbound.writable
      } as unknown as Stream),
      16
    )
    const inputWriter = inbound.writable.getWriter()
    const reader = stream.readable.getReader()
    const read = reader.read()
    await inputWriter.write({ value: 'too-long-for-frame' })
    await expect(read).rejects.toThrow('input frame exceeds')

    const writer = stream.writable.getWriter()
    await expect(
      writer.write({ value: 'too-long-for-frame' } as never)
    ).rejects.toThrow('output frame exceeds')
  })

  it('counts the complete emitted envelope against the request limit', async () => {
    const { listeners, extNotification, handle, internals } =
      stubAgentContext()
    const sessionEvent = listeners.get('session/event')!
    sessionEvent(
      handle.agent.session,
      {
        type: 'assistant/chunk',
        data: {
          chunk: {
            type: 'text-delta',
            text: 'x'.repeat(80)
          }
        }
      }
    )
    sessionEvent(
      handle.agent.session,
      {
        type: 'assistant/chunk',
        data: {
          chunk: {
            type: 'usage',
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0
            }
          }
        }
      }
    )
    await internals.sessions.get('session-output')!.inflight.eventTail

    expect(extNotification).toHaveBeenCalledTimes(1)
    expect(handle.agent.cancel).toHaveBeenCalledWith({
      kind: 'user'
    })
    expect(
      internals.sessions.get('session-output')!.inflight.eventError
    ).toEqual(
      new Error(
        'GoodBuddy Harness control request output exceeds safety limit'
      )
    )
    expect(
      internals.sessions.get('session-output')!.inflight.emittedCharacters
    ).toBeGreaterThan(180)
  })

  it('allows genuine read, skill, and web definitions but rejects plugin name spoofs in Ask', async () => {
    const {
      listeners,
      handle,
      genuineDefinitions,
      resolvedDefinitions
    } = stubAgentContext()
    const executeTool = listeners.get('tools/execute')!
    const next = vi.fn(async () => ({
      isError: false,
      value: {},
      content: []
    }))
    const request = (name: string) => ({
      name,
      agent: handle.agent
    })

    for (const name of [
      'write',
      'edit',
      'bash',
      'pwsh',
      'third_party_deploy'
    ]) {
      await expect(
        Promise.resolve(executeTool(request(name), next))
      ).rejects.toThrow('Ask 模式不允许')
    }
    for (const name of ['read', 'skill', 'web_search']) {
      await expect(
        Promise.resolve(executeTool(request(name), next))
      ).resolves.toMatchObject({ isError: false })
    }

    for (const name of ['read', 'skill', 'web_search']) {
      resolvedDefinitions.set(name, { name })
      await expect(
        Promise.resolve(executeTool(request(name), next))
      ).rejects.toThrow('Ask 模式不允许')
      resolvedDefinitions.set(
        name,
        genuineDefinitions.get(name)!
      )
    }
  })

  it('allows every registered tool in Execute', async () => {
    const { listeners, handle, internals } = stubAgentContext()
    internals.sessions.get('session-output')!.inflight.mode =
      'execute'
    const executeTool = listeners.get('tools/execute')!
    const next = vi.fn(async () => ({
      isError: false,
      value: {},
      content: []
    }))

    await expect(
      Promise.resolve(
        executeTool(
          {
            name: 'third_party_deploy',
            agent: handle.agent
          },
          next
        )
      )
    ).resolves.toMatchObject({ isError: false })
    expect(next).toHaveBeenCalledOnce()
  })
})
