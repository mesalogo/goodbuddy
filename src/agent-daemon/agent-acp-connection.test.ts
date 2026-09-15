import { describe, expect, it, vi } from 'vitest'
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client } from '@agentclientprotocol/sdk'
import { AgentAcpConnection } from './agent-acp-connection'
import type { RuntimeAcpProcessOutput, RuntimeAcpProcessOwner } from './runtime-acp-backend'

describe('AgentAcpConnection', () => {
  it('uses one decoder and handshake and routes interleaved Sessions without closing peers', async () => {
    let output!: (value: RuntimeAcpProcessOutput) => void | Promise<void>
    let input!: ReadableStreamDefaultController<Uint8Array>
    const unsubscribe = vi.fn()
    const process: RuntimeAcpProcessOwner = {
      identity: { launchId: 'launch', processId: 'process', supervisorIdentityDigest: `sha256:${'a'.repeat(64)}` },
      beginPrompt: vi.fn(), completePrompt: vi.fn(), stop: vi.fn(),
      reconcile: vi.fn(),
      subscribeOutput: vi.fn(listener => { output = listener; return unsubscribe }),
      subscribeExit: vi.fn(() => unsubscribe),
      writeStdin: async data => input.enqueue(data)
    }
    const initialize = vi.fn(async () => ({ protocolVersion: PROTOCOL_VERSION }))
    const server = new AgentSideConnection(() => ({
      initialize, newSession: async () => ({ sessionId: 'session' }),
      prompt: async () => ({ stopReason: 'end_turn' as const }),
      cancel: async () => undefined
    }), ndJsonStream(new WritableStream({
      write: async data => { await output({ stream: 'stdout', data }) }
    }), new ReadableStream({ start: controller => { input = controller } })))
    const transport = new AgentAcpConnection(process)
    const one: Client = { sessionUpdate: vi.fn(), requestPermission: vi.fn(async () => ({
      outcome: { outcome: 'selected', optionId: 'allow' }
    })) }
    const two: Client = { sessionUpdate: vi.fn(), requestPermission: vi.fn(async () => ({
      outcome: { outcome: 'cancelled' }
    })) }
    const release = transport.register('one', one)
    transport.register('two', two)
    try {
      await Promise.all([1, 2].map(() => transport.initialize({ protocolVersion: PROTOCOL_VERSION })))
      expect(initialize).toHaveBeenCalledOnce()
      for (const sessionId of ['one', 'two', 'one', 'two']) {
        await server.sessionUpdate({
          sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: sessionId } }
        })
      }
      await vi.waitFor(() => expect(two.sessionUpdate).toHaveBeenCalledTimes(2))
      expect(one.sessionUpdate).toHaveBeenCalledTimes(2)
      const permission = (sessionId: string) => server.requestPermission({
        sessionId, options: [{ kind: 'allow_once', optionId: 'allow', name: 'Allow' }],
        toolCall: { toolCallId: 'tool', title: 'write', kind: 'edit' }
      })
      expect(await permission('one')).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
      expect(await permission('two')).toEqual({ outcome: { outcome: 'cancelled' } })
      release()
      expect(await permission('one')).toEqual({ outcome: { outcome: 'cancelled' } })
      expect(await permission('two')).toEqual({ outcome: { outcome: 'cancelled' } })
      expect(process.subscribeOutput).toHaveBeenCalledOnce()
      expect(unsubscribe).not.toHaveBeenCalled()
    } finally {
      transport.dispose()
      input.close()
    }
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })
})
