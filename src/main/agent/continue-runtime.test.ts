import { describe, expect, it } from 'vitest'
import { ContinueAgentRuntime } from './continue-runtime'

describe('ContinueAgentRuntime', () => {
  it('does not launch the CLI for an already-cancelled request', async () => {
    const runtime = new ContinueAgentRuntime({
      command: 'command-that-must-not-run',
      defaultWorkspace: process.cwd()
    })
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const stream = runtime.run(
      {
        requestId: '3f496642-f47d-4e0a-8944-a32c77b0d6ef',
        conversationId: 'conversation-1',
        prompt: 'test'
      },
      controller.signal
    )

    await expect(stream.next()).rejects.toThrow('cancelled')
  })
})
