import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Stream } from '@agentclientprotocol/sdk'
import { resolve } from 'node:path'
import {
  GOODBUDDY_HANDSHAKE,
  GOODBUDDY_PREPARE,
  GoodBuddyCredentialProvider,
  GoodBuddyHarnessControlPlane,
  createBoundedAcpStream
} from './goodbuddy-harness-control-plane'

function controlPlane() {
  return new GoodBuddyHarnessControlPlane({} as Context, {
    provider: 'goodbuddy',
    model: 'deepseek-test',
    workspace: resolve('workspace'),
    harnessVersion: '0.1.0-rc.6',
    execution: { mode: 'host' },
    credentialRefs: ['GOODBUDDY_API_KEY'],
    skills: []
  })
}

function stubAgentContext() {
  const listeners = new Map<
    string,
    (...args: unknown[]) => unknown
  >()
  const extNotification = vi.fn(async () => undefined)
  const handle = {
    agent: {
      session: {
        id: 'session-output',
        header: { id: 'session-output' },
        events: []
      },
      cancel: vi.fn()
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
  return { listeners, extNotification, handle, internals }
}

describe('GoodBuddy Harness internal control plane', () => {
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

  it('allows only the known read-only tools in Ask', async () => {
    const { listeners, handle } = stubAgentContext()
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
    for (const name of ['read', 'skill']) {
      await expect(
        Promise.resolve(executeTool(request(name), next))
      ).resolves.toMatchObject({ isError: false })
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
