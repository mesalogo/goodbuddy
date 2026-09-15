import type { ImageToolBinding } from '../agent/image-tool-binding'
import type { RuntimeProtocolBinaryChannel } from './protocol-remote-runtime-channel'
import {
  decodeRemoteImageToolMessage, encodeRemoteImageToolMessage,
  remoteImageToolCallSchema, remoteImageToolReplySchema
} from '../../shared/remote-image-tool-contracts'

export class MainImageToolSession {
  private readonly wait = new AbortController()
  private readonly unsubscribe: () => void
  private readonly removeAbort: () => void

  constructor(
    private readonly channel: RuntimeProtocolBinaryChannel,
    private readonly binding: ImageToolBinding,
    signal?: AbortSignal
  ) {
    this.unsubscribe = channel.onClose(() => this.close())
    const abort = (): void => this.close()
    signal?.addEventListener('abort', abort, { once: true })
    this.removeAbort = () => signal?.removeEventListener('abort', abort)
    if (signal?.aborted) this.close()
    void this.receive().catch(() => this.close())
  }

  close(): void {
    if (this.wait.signal.aborted) return
    // This aborts binding.call's wait, never the Main-owned image operation.
    this.wait.abort()
    this.removeAbort()
    this.unsubscribe()
    this.channel.close()
  }

  private async receive(): Promise<void> {
    while (!this.wait.signal.aborted) {
      const frame = await this.channel.receive(this.wait.signal)
      const call = remoteImageToolCallSchema.parse(decodeRemoteImageToolMessage(frame.payload))
      await frame.consume()
      void this.dispatch(call).catch(() => this.close())
    }
  }

  private async dispatch(call: ReturnType<typeof remoteImageToolCallSchema.parse>): Promise<void> {
    let reply: ReturnType<typeof remoteImageToolReplySchema.parse>
    try {
      this.wait.signal.throwIfAborted()
      if (this.binding.context.workMode !== 'execute') throw new Error('Image tools are unavailable in Ask mode')
      const result = await this.binding.call(call.input, call.callId, this.wait.signal)
      reply = remoteImageToolReplySchema.parse({ callId: call.callId, result })
    } catch (error) {
      reply = { callId: call.callId, error: (error instanceof Error ? error.message : 'Image tool failed').slice(0, 4_000) }
    }
    if (!this.wait.signal.aborted) await this.channel.send(encodeRemoteImageToolMessage(reply), this.wait.signal)
  }
}
