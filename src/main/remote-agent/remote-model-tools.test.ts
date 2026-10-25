// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { RemoteModelTools } from './remote-model-tools'
import { RecoverableModelToolError } from '../agent/model-tool-provider'
import type { RemoteWorkspaceAccess } from '../workspace/remote-workspace-access'
import type { RemoteModelToolsAction, RemoteModelToolsResult } from '../../shared/remote-model-tools-contracts'
import type { PagedOutputBackingStore } from '../agent/paged-output-store'
import { AgentProtocolClientError } from './agent-protocol-client'
import { ProtocolRemoteWorkspaceTransportError } from './protocol-remote-workspace-transport'

const context = { conversationId: 'conversation', runtimeTarget: 'model' as const }
function fixture(invoke: (action: RemoteModelToolsAction) => Promise<RemoteModelToolsResult>) {
  const modelTools = vi.fn(invoke)
  const workspace = { getIdentity: vi.fn(async () => ({})), modelTools } as unknown as RemoteWorkspaceAccess
  return { modelTools, workspace }
}

describe('RemoteModelTools', () => {
  it.each([
    new AgentProtocolClientError('connection closed', 'closed'),
    new ProtocolRemoteWorkspaceTransportError('connection generation lost', 'stale-generation')
  ])('keeps a known tool result when the connection closes during release: %s', async error => {
    const result = { parts: [{ type: 'text' as const, text: 'write completed' }], contextBytes: 15 }
    const test = fixture(async action => {
      if (action.kind === 'call') return { kind: 'result', result }
      throw error
    })
    const tools = new RemoteModelTools(test.workspace, {})
    try {
      await expect(tools.callTool('process_execute', { command: 'write once' }, new AbortController().signal, context)).resolves.toEqual(result)
      expect(test.modelTools.mock.calls.map(([action]) => action.kind)).toEqual(['call', 'release'])
    } finally { await tools.dispose() }
  })

  it('preserves the original execution error when release also fails after disconnect', async () => {
    const original = new Error('transport closed during tool execution')
    const test = fixture(async action => {
      if (action.kind === 'call') throw original
      throw new Error('release failed on closed transport')
    })
    const tools = new RemoteModelTools(test.workspace, {})
    try {
      await expect(tools.callTool('process_execute', { command: 'work' }, new AbortController().signal, context)).rejects.toBe(original)
      expect(test.modelTools.mock.calls.map(([action]) => action.kind)).toEqual(['call', 'release'])
    } finally { await tools.dispose() }
  })

  it('stops copying long output when cancelled and releases partial Desktop output', async () => {
    const controller = new AbortController()
    const cancellation = new Error('cancel output transfer')
    let reads = 0
    const stored = new Map<string, Buffer>()
    const backingStore: PagedOutputBackingStore = {
      create: async (_owner, handle) => { stored.set(handle, Buffer.alloc(0)) },
      append: async (_owner, handle, bytes) => { stored.set(handle, Buffer.concat([stored.get(handle)!, bytes])) },
      finish: async () => {}, read: async () => Buffer.alloc(0),
      release: async (_owner, handle) => { stored.delete(handle) }
    }
    const test = fixture(async action => {
      if (action.kind === 'call') return { kind: 'result', result: { parts: [{ type: 'text', text: 'long output' }], contextBytes: 11, outputReferences: [{ handle: 'process:host', nextCursor: 1, totalBytes: 2 }] } }
      if (action.kind === 'read') {
        reads++
        controller.abort(cancellation)
        return { kind: 'page', page: { handle: 'process:host', content: 'x', cursor: action.cursor, nextCursor: action.cursor + 1, totalBytes: 2, eof: action.cursor === 1 } }
      }
      return { kind: 'done' }
    })
    const tools = new RemoteModelTools(test.workspace, { outputStore: { backingStore } })
    try {
      await expect(tools.callTool('process_execute', { command: 'work' }, controller.signal, context)).rejects.toBe(cancellation)
      expect(reads).toBe(1)
      expect(stored.size).toBe(0)
      expect(test.modelTools.mock.calls.at(-1)?.[0].kind).toBe('release')
    } finally { await tools.dispose() }
  })

  it('waits for remote cancellation settlement before releasing the call', async () => {
    let finish!: (value: RemoteModelToolsResult) => void
    let start!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    const test = fixture(async action => {
      if (action.kind === 'call') {
        start()
        return new Promise(resolve => { finish = resolve })
      }
      if (action.kind === 'cancel') finish({ kind: 'result', result: { parts: [{ type: 'text', text: 'cancelled' }], contextBytes: 9 } })
      return { kind: 'done' }
    })
    const tools = new RemoteModelTools(test.workspace, {})
    const controller = new AbortController()
    const pending = tools.callTool('process_execute', { command: 'long-running' }, controller.signal, context)
    await started
    controller.abort()
    await pending
    expect(test.modelTools.mock.calls.map(([action]) => action.kind)).toEqual(['call', 'cancel', 'release'])
    await tools.dispose()
  })

  it('never dispatches an already cancelled command and preserves recoverable read failures', async () => {
    const test = fixture(async action => action.kind === 'call'
      ? { kind: 'error', message: 'File missing', nextAction: 'Search the workspace' }
      : { kind: 'done' })
    const tools = new RemoteModelTools(test.workspace, {})
    await expect(tools.callTool('process_execute', { command: 'echo' }, AbortSignal.abort(), context)).rejects.toThrow()
    expect(test.modelTools).not.toHaveBeenCalled()
    await expect(tools.callTool('workspace_read_text', { path: 'missing' }, new AbortController().signal, context)).rejects.toBeInstanceOf(RecoverableModelToolError)
    expect(test.modelTools.mock.calls.at(-1)?.[0].kind).toBe('release')
    await tools.dispose()
  })

  it('adopts complete output before releasing the Host and pages it without another remote call', async () => {
    const data = 'prefix-中文-tail'
    const bytes = Buffer.from(data)
    const stored = new Map<string, Buffer>()
    const backingStore: PagedOutputBackingStore = {
      create: async (_owner, handle) => { stored.set(handle, Buffer.alloc(0)) },
      append: async (_owner, handle, value) => { stored.set(handle, Buffer.concat([stored.get(handle)!, value])) },
      finish: async () => {}, read: async (_owner, handle, cursor, length) => stored.get(handle)!.subarray(cursor, cursor + length),
      release: async (_owner, handle) => { stored.delete(handle) }
    }
    let adopted = false
    const test = fixture(async action => {
      if (action.kind === 'call') return { kind: 'result', result: { parts: [{ type: 'text', text: JSON.stringify({ stdoutReference: { handle: 'process:host', nextCursor: 7, totalBytes: bytes.length } }) }], contextBytes: 100,
        outputReferences: [{ handle: 'process:host', nextCursor: 7, totalBytes: bytes.length }] } }
      if (action.kind === 'read') return { kind: 'page', page: { handle: 'process:host', content: data, cursor: 0, nextCursor: bytes.length, totalBytes: bytes.length, eof: true } }
      expect(adopted).toBe(true)
      return { kind: 'done' }
    })
    const outputAdopt = vi.fn(async (_owner: string, handle: string) => {
      expect(stored.get(handle)?.toString()).toBe(data)
      adopted = true
      return 'artifact'
    })
    const tools = new RemoteModelTools(test.workspace, { outputStore: { backingStore }, outputAdopt })
    const result = await tools.callTool('process_execute', { command: 'output' }, new AbortController().signal, { ...context, outputHistory: { conversationId: 'history', messageId: 'message' } })
    const reference = result.outputReferences![0]!
    expect(reference.handle).toMatch(/^remote:/u)
    expect(result.parts[0]).toMatchObject({ text: expect.stringContaining(reference.handle) })
    expect(outputAdopt).toHaveBeenCalledWith('conversation', reference.handle, 'history', 'message', 'message')
    const remoteCalls = test.modelTools.mock.calls.length
    const page = await tools.callTool('output_read', { handle: reference.handle, cursor: 7 }, new AbortController().signal, context)
    expect(page.parts[0]).toMatchObject({ text: expect.stringContaining('中文-tail') })
    expect(test.modelTools).toHaveBeenCalledTimes(remoteCalls)
    await expect(tools.callTool('output_read', { handle: reference.handle }, new AbortController().signal, { conversationId: 'other' })).rejects.toThrow()
    await tools.releaseConversation(context.conversationId)
    expect(stored.size).toBe(0)
    await tools.dispose()
  })
})
