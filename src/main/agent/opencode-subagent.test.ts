import { describe, expect, it } from 'vitest'
import { OpenCodeSubagentProgress, toOpenCodeSubagentEvent } from './opencode-subagent'

const requestId = '3f496642-f47d-4e0a-8944-a32c77b0d6ef'

describe('OpenCode native subagent events', () => {
  it('extracts ACP output objects without displaying protocol metadata', () => {
    const event = toOpenCodeSubagentEvent({
      requestId, callId: 'task', state: 'completed',
      input: { subagent_type: 'general', prompt: 'Inspect seed' },
      output: {
        output: '<task id="child" state="completed">\n<task_result>\n**Done**\n</task_result>\n</task>',
        metadata: { sessionId: 'child' }
      }
    })
    expect(event?.output).toBe('**Done**')
  })

  it('keeps ordered child text, reasoning and tools separate from the final result', () => {
    const tracker = new OpenCodeSubagentProgress(requestId, 'parent')
    const task = (status: string) => ({
      type: 'message.part.updated',
      properties: {
        sessionID: 'parent',
        part: {
          id: 'task-part', callID: 'task', type: 'tool', tool: 'task',
          state: {
            status, input: { subagent_type: 'general', prompt: 'Inspect seed' },
            metadata: { sessionId: 'child' },
            ...(status === 'completed' ? { output: 'Final result' } : {})
          }
        }
      }
    })
    tracker.update(task('running'))
    tracker.update({
      type: 'message.updated',
      properties: { sessionID: 'child', info: { id: 'user', role: 'user' } }
    })
    expect(tracker.update({
      type: 'message.part.updated',
      properties: { sessionID: 'child', part: {
        id: 'prompt', messageID: 'user', type: 'text', text: 'Do not display prompt'
      } }
    })).toBeUndefined()
    const delta = (sessionID: string, partID: string, text: string) => ({
      type: 'message.part.delta',
      properties: { sessionID, partID, field: 'text', delta: text }
    })
    expect(tracker.update(delta('unrelated', 'text', 'Not ours'))).toBeUndefined()
    tracker.update(delta('child', 'text', 'Inspecting '))
    const first = tracker.update(delta('child', 'text', 'seed'))
    expect(first?.progress?.[0]).toMatchObject({ type: 'text', content: 'Inspecting seed' })
    tracker.update({
      type: 'message.part.updated', properties: { sessionID: 'child', part: {
        id: 'thought', type: 'reasoning', text: ''
      } }
    })
    tracker.update(delta('child', 'thought', 'Check contents'))
    for (const status of ['running', 'completed']) {
      tracker.update({
        type: 'message.part.updated', properties: { sessionID: 'child', part: {
          id: 'read', callID: 'read', type: 'tool', tool: 'read',
          state: { status, input: { path: 'seed.txt' }, output: 'seed contents' }
        } }
      })
    }
    const done = tracker.update(task('completed'))
    expect(done?.output).toBe('Final result')
    expect(done?.progress?.map(b => b.type)).toEqual(['text', 'reasoning', 'tool'])
    expect(done?.progress?.[2]).toMatchObject({ tool: { state: 'completed', output: 'seed contents' } })
    expect(first?.progress).toHaveLength(1)
  })
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

  it('routes recovered live child events by the ACP owning Task without new metadata', () => {
    const tracker = new OpenCodeSubagentProgress(requestId, 'parent')
    tracker.retain({
      ...toOpenCodeSubagentEvent({
        requestId, callId: 'task', state: 'running',
        input: { subagent_type: 'general', prompt: 'Read seed' }
      })!,
      progress: []
    })
    const event = {
      type: 'message.part.delta',
      properties: { sessionID: 'child', partID: 'text', field: 'text', delta: 'Resumed progress' }
    }
    expect(tracker.update(event)).toBeUndefined()
    expect(tracker.update(event, 'task')).toMatchObject({
      state: 'running', progress: [{ type: 'text', content: 'Resumed progress' }]
    })
  })
})
