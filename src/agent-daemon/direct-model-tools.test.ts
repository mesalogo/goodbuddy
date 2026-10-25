// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ControllerRegistry } from './controller-registry'
import type { WorkspaceRegistry } from './workspace-registry'
import { createDirectModelTools } from './direct-model-tools'
import type { RemoteModelToolsAction, RemoteModelToolsResult } from '../shared/remote-model-tools-contracts'
const firstCall = '00000000-0000-4000-8000-000000000001'
const secondCall = '00000000-0000-4000-8000-000000000002'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-direct-lifecycle-'))
  const controllers = new ControllerRegistry()
  const controller = controllers.attach('direct-tools-test')
  // Only translate the POSIX Host workspace to a local path for Windows tests;
  // the provider, output backing and tool implementations remain real.
  const workspaces = { get: async () => ({ access: { root: { canonicalPath: root }, assertCurrent: async ({ signal }: { signal?: AbortSignal }) => signal?.throwIfAborted() } }) } as unknown as WorkspaceRegistry
  const disconnected = new AbortController()
  const tools = createDirectModelTools(workspaces, root)
  const context = { controller, channelId: 'test', signal: disconnected.signal }
  const invoke = (action: RemoteModelToolsAction, signal = context.signal) => tools.handler({ workspaceId: 'workspace-1', generation: 1, action }, { ...context, signal }) as Promise<RemoteModelToolsResult>
  return { root, tools, invoke, disconnected, close: async () => { await tools.dispose(); await rm(root, { recursive: true, force: true }) } }
}

describe('direct model tool lifecycle', () => {
  it('keeps completed calls until release and rejects new calls while draining', async () => {
    const test = await fixture()
    try {
      await writeFile(join(test.root, 'file.txt'), 'retained result')
      expect((await test.invoke({ kind: 'call', callId: firstCall, name: 'workspace_read_text', arguments: { path: 'file.txt' } })).kind).toBe('result')
      expect(test.tools.drain()).toBe(false)
      await expect(test.invoke({ kind: 'call', callId: secondCall, name: 'workspace_apply_patch', arguments: { patch: '*** Begin Patch\n*** Add File: forbidden.txt\n+new\n*** End Patch' } })).rejects.toThrow('draining')
      await test.invoke({ kind: 'release', callId: firstCall })
      expect(test.tools.drain()).toBe(true)
    } finally { await test.close() }
  })

  it('cleans retained calls on disconnect and makes repeated cleanup harmless', async () => {
    const test = await fixture()
    try {
      await writeFile(join(test.root, 'file.txt'), 'retained result')
      await test.invoke({ kind: 'call', callId: firstCall, name: 'workspace_read_text', arguments: { path: 'file.txt' } })
      test.disconnected.abort()
      await test.tools.dispose()
      expect(test.tools.drain()).toBe(true)
      await test.tools.dispose()
    } finally { await test.close() }
  })

  it('does not leave an already disconnected call registered', async () => {
    const test = await fixture()
    try {
      test.disconnected.abort()
      const result = await test.invoke({ kind: 'call', callId: firstCall, name: 'workspace_read_text', arguments: { path: 'file.txt' } })
      expect(result.kind).toBe('error')
      // Let the asynchronously scheduled disconnect cleanup settle.
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(test.tools.drain()).toBe(true)
    } finally { await test.close() }
  })
})
