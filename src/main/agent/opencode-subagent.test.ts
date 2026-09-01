import { describe, expect, it } from 'vitest'
import { toOpenCodeSubagentEvent } from './opencode-subagent'

const requestId = '3f496642-f47d-4e0a-8944-a32c77b0d6ef'

describe('OpenCode native subagent events', () => {
  it('maps Task tool updates to stable bounded subagent identities', () => {
    const running = toOpenCodeSubagentEvent({
      requestId,
      callId: 'call-task-1',
      state: 'running',
      input: {
        subagent_type: 'explorer',
        description: 'Review application architecture',
        prompt: 'Inspect the complete source tree.'
      }
    })
    const completed = toOpenCodeSubagentEvent({
      requestId,
      callId: 'call-task-1',
      state: 'completed',
      input: {
        subagent_type: 'explorer',
        description: 'Review application architecture',
        prompt: 'Inspect the complete source tree.'
      },
      output: 'Architecture review complete.'
    })

    expect(running).toMatchObject({
      type: 'subagent',
      expertName: 'explorer',
      routingMode: 'native',
      runtimeCallId: 'call-task-1',
      state: 'running',
      reason: 'Review application architecture'
    })
    expect(completed).toMatchObject({
      childTaskId: running?.childTaskId,
      expertId:
        running && 'expertId' in running
          ? running.expertId
          : undefined,
      state: 'completed',
      output: 'Architecture review complete.'
    })
  })

  it('does not classify unrelated tools as subagents', () => {
    expect(
      toOpenCodeSubagentEvent({
        requestId,
        callId: 'call-read-1',
        state: 'completed',
        input: { filePath: 'README.md' },
        output: 'contents'
      })
    ).toBeUndefined()
  })
})
