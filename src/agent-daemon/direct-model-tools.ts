import { mkdtemp, open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ModelToolProvider } from '../main/agent/model-tool-provider'
import type { PagedOutputBackingStore, PagedOutputStoreOptions } from '../main/agent/paged-output-store'
import { remoteModelToolNames, remoteModelToolsRequestSchema, remoteModelToolsResultSchema } from '../shared/remote-model-tools-contracts'
import type { ProtocolMethodHandler } from './protocol-server'
import type { WorkspaceRegistry } from './workspace-registry'

// Output lives only for the call and its bounded transfer to Desktop's existing
// output owner. No model credentials or conversation history travel to the Host.
function outputBacking(directory: () => Promise<string>): PagedOutputBackingStore {
  const files = new Map<string, Awaited<ReturnType<typeof open>>>()
  const get = (handle: string) => {
    const file = files.get(handle)
    if (!file) throw new Error('Unknown remote tool output')
    return file
  }
  return {
    create: async (_owner, handle) => { files.set(handle, await open(join(await directory(), handle.replace(':', '-')), 'wx+')) },
    append: async (_owner, handle, bytes) => {
      let offset = 0
      while (offset < bytes.length) offset += (await get(handle).write(bytes, offset, bytes.length - offset)).bytesWritten
    },
    finish: async () => {},
    read: async (_owner, handle, cursor, length) => {
      const bytes = Buffer.alloc(length)
      const result = await get(handle).read(bytes, 0, length, cursor)
      return bytes.subarray(0, result.bytesRead)
    },
    release: async (_owner, handle) => {
      const file = files.get(handle)
      files.delete(handle)
      await file?.close()
      await rm(join(await directory(), handle.replace(':', '-')), { force: true })
    }
  }
}

export function createDirectModelTools(workspaces: WorkspaceRegistry, outputRoot: string, ripgrepExecutablePath = 'rg'): {
  handler: ProtocolMethodHandler; dispose(): Promise<void>
} {
  type Call = { controller: AbortController; provider: Promise<ModelToolProvider>; settled?: Promise<unknown>; cleanup(): Promise<void> }
  const calls = new Map<string, Call>()
  let disposed = false
  const createProvider = async (root: string, outputStore?: PagedOutputStoreOptions) => {
    const [{ ModelToolProvider }, { LocalDirectModelProcessService }] = await Promise.all([
      import('../main/agent/model-tool-provider'), import('../main/agent/direct-model-process-service')
    ])
    return new ModelToolProvider(root, [], undefined, undefined, false, {
      outputStore, processService: new LocalDirectModelProcessService({ outputStore, toolBinDirectory: dirname(process.execPath) }), ripgrepExecutablePath
    })
  }
  const handler: ProtocolMethodHandler = async (params, context) => {
    if (disposed) throw new Error('Remote model tools are shutting down')
    const request = remoteModelToolsRequestSchema.parse(params)
    const resolveWorkspace = async () => {
      const workspace = await workspaces.get(request.workspaceId, request.generation, context.controller, { signal: context.signal })
      await workspace.access.assertCurrent({ signal: context.signal })
      return workspace
    }
    const { action } = request
    const key = `${context.controller.connectionId}:${request.workspaceId}:${'callId' in action ? action.callId : ''}`
    if (action.kind === 'cancel' || action.kind === 'release') {
      const call = calls.get(key)
      call?.controller.abort(new Error('Remote model tool cancelled'))
      await call?.settled?.catch(() => undefined)
      if (action.kind === 'release') await call?.cleanup()
      return { kind: 'done' }
    }
    if (action.kind === 'read') {
      const call = calls.get(key)
      if (!call) throw new Error('Remote tool output has been released')
      const result = await (await call.provider).callTool('output_read', { handle: action.handle, cursor: action.cursor }, new AbortController().signal, { conversationId: action.callId, runtimeTarget: 'model' })
      const part = result.parts[0]
      if (part?.type !== 'text') throw new Error('Invalid remote output page')
      return remoteModelToolsResultSchema.parse({ kind: 'page', page: JSON.parse(part.text) })
    }
    if (action.kind === 'list') {
      const workspace = await resolveWorkspace()
      const provider = await createProvider(workspace.access.root.canonicalPath)
      try {
        const tools = await provider.listTools({ conversationId: 'catalog', runtimeTarget: 'model' }, context.signal ?? new AbortController().signal)
        return remoteModelToolsResultSchema.parse({ kind: 'tools', tools: tools.filter(tool => (remoteModelToolNames as readonly string[]).includes(tool.name)) })
      } finally { await provider.dispose() }
    }
    if (calls.has(key)) throw new Error('Remote tool call already exists')
    const controller = new AbortController()
    let directory: Promise<string> | undefined
    let cleanup: Promise<void> | undefined
    const provider = (async () => {
      const workspace = await resolveWorkspace()
      controller.signal.throwIfAborted()
      const outputStore = { backingStore: outputBacking(() => directory ??= mkdtemp(join(outputRoot, 'model-tools-'))) }
      return createProvider(workspace.access.root.canonicalPath, outputStore)
    })()
    const disconnected = () => { controller.abort(new Error('Remote connection closed')); void call.cleanup().catch(() => undefined) }
    const call: Call = { controller, provider, cleanup: () => cleanup ??= (async () => {
      controller.abort(new Error('Remote tool released'))
      await call.settled?.catch(() => undefined)
      await (await provider.catch(() => undefined))?.dispose()
      if (directory) await rm(await directory, { recursive: true, force: true })
      calls.delete(key)
      context.signal?.removeEventListener('abort', disconnected)
    })() }
    calls.set(key, call)
    context.signal?.addEventListener('abort', disconnected, { once: true })
    const signal = context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal
    call.settled = (async () => {
      try {
        signal.throwIfAborted()
        const result = await (await provider).callTool(action.name, action.arguments, signal, { conversationId: action.callId, runtimeTarget: 'model' })
        return remoteModelToolsResultSchema.parse({ kind: 'result', result })
      } catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.name === 'RecoverableModelToolError' && 'nextAction' in error && typeof error.nextAction === 'string' ? { nextAction: error.nextAction } : {}) }
      }
    })()
    return await call.settled
  }
  return { handler, dispose: async () => { disposed = true; await Promise.all([...calls.values()].map(call => call.cleanup())) } }
}
