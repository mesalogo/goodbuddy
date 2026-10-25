import { randomUUID } from 'node:crypto'
import { remoteModelToolNames, remoteModelToolsActionSchema } from '../../shared/remote-model-tools-contracts'
import { RecoverableModelToolError, type ModelToolCallContext, type ModelToolDefinition, type ModelToolProviderProgrammingOptions, type ModelToolResult } from '../agent/model-tool-provider'
import { PagedOutputStore } from '../agent/paged-output-store'
import type { RemoteWorkspaceAccess } from '../workspace/remote-workspace-access'
import { AgentProtocolClientError } from './agent-protocol-client'
import { ProtocolRemoteWorkspaceTransportError } from './protocol-remote-workspace-transport'

export class RemoteModelTools {
  private readonly outputs: PagedOutputStore
  constructor(private readonly workspace: RemoteWorkspaceAccess, private readonly options: Pick<ModelToolProviderProgrammingOptions, 'outputStore' | 'outputAdopt'>) {
    this.outputs = new PagedOutputStore('remote', options.outputStore)
  }

  owns(name: string, args: Record<string, unknown>): boolean {
    return (remoteModelToolNames as readonly string[]).includes(name) || (name === 'output_read' && typeof args.handle === 'string' && args.handle.startsWith('remote:'))
  }

  async listTools(signal: AbortSignal): Promise<ModelToolDefinition[]> {
    const response = await this.workspace.modelTools({ kind: 'list' }, signal)
    if (response.kind !== 'tools') throw new Error('Invalid remote tool catalog')
    return response.tools
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, context: ModelToolCallContext): Promise<ModelToolResult> {
    if (name === 'output_read') {
      const page = await this.outputs.read(context.conversationId, String(args.handle), args.cursor as number | undefined, args.limitBytes as number | undefined)
      const text = JSON.stringify(page)
      return { parts: [{ type: 'text', text }], contextBytes: Buffer.byteLength(text) }
    }
    signal.throwIfAborted()
    const callId = randomUUID()
    const action = remoteModelToolsActionSchema.parse({ kind: 'call', callId, name, arguments: args })
    // Open before dispatch so cancellation cannot overtake connection setup.
    await this.workspace.getIdentity()
    signal.throwIfAborted()
    const operation = this.workspace.modelTools(action)
    let cancellation: Promise<unknown> | undefined
    const cancel = () => { cancellation ??= this.workspace.modelTools({ kind: 'cancel', callId }).catch(() => undefined) }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    let failed = false
    try {
      const response = await operation
      if (response.kind === 'error') {
        signal.throwIfAborted()
        if (response.nextAction) throw new RecoverableModelToolError(response.message, response.nextAction)
        throw new Error(response.message)
      }
      if (response.kind !== 'result') throw new Error('Invalid remote tool result')
      const result = response.result
      // Move long output into the same Desktop storage owner used by local
      // calls before releasing Host output; history and output_read share it.
      for (const reference of result.outputReferences ?? []) {
        const oldHandle = reference.handle
        const writer = await this.outputs.create(context.conversationId, 1)
        try {
          let cursor = 0
          while (cursor < reference.totalBytes) {
            signal.throwIfAborted()
            const response = await this.workspace.modelTools({ kind: 'read', callId, handle: oldHandle, cursor }, signal)
            signal.throwIfAborted()
            if (response.kind !== 'page' || response.page.cursor !== cursor || response.page.nextCursor <= cursor || response.page.totalBytes !== reference.totalBytes) throw new Error('Invalid remote output page')
            await writer.append(response.page.content)
            cursor = response.page.nextCursor
          }
          const retained = await writer.finish()
          if (!retained.reference) throw new Error('Remote output was not retained')
          reference.handle = retained.reference.handle
          for (const part of result.parts) part.text = part.text.replaceAll(oldHandle, reference.handle)
          if (context.outputHistory) {
            if (!this.options.outputAdopt) throw new Error('Output history storage owner is not configured')
            await this.options.outputAdopt(context.conversationId, reference.handle, context.outputHistory.conversationId, 'message', context.outputHistory.messageId)
          }
        } catch (error) { await writer.abort(); throw error }
      }
      result.contextBytes = result.parts.reduce((total, part) => total + Buffer.byteLength(part.text), 0)
      return result
    } catch (error) {
      failed = true
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
      await cancellation
      await this.workspace.modelTools({ kind: 'release', callId }).catch((error: unknown) => {
        // A disconnected transport often rejects both requests. Preserve the
        // actual execution/transfer failure rather than replacing it with cleanup.
        const disconnected = (error instanceof AgentProtocolClientError && error.code === 'closed') ||
          (error instanceof ProtocolRemoteWorkspaceTransportError &&
            (error.reason === 'closed' || error.reason === 'stale-generation'))
        // All output has already reached Desktop if the call succeeded. Losing
        // the release ACK cannot turn that known side effect into a failed tool.
        if (!failed && !disconnected) throw error
      })
    }
  }

  async releaseConversation(id: string): Promise<void> { await this.outputs.releaseOwner(id) }
  async dispose(): Promise<void> { await this.outputs.dispose() }
}
