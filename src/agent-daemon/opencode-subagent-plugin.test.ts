import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { openCodeSubagentPluginSource } from './opencode-subagent-plugin'

describe('OpenCode ACP child event plugin', () => {
  it('emits valid newline-delimited ACP updates only for owned child sessions', async () => {
    const write = vi.fn()
    const factory = runInNewContext(
      `(${openCodeSubagentPluginSource().replace('export default ', '')})`,
      { process: { stdout: { write } } }
    )
    const hooks = await factory()
    const event = {
      type: 'message.part.updated',
      properties: {
        sessionID: 'parent',
        part: {
          type: 'tool', tool: 'task', callID: 'task',
          state: { metadata: { sessionId: 'child' } }
        }
      }
    }
    await hooks.event({ event })
    await hooks.event({ event: {
      type: 'message.part.delta', properties: { sessionID: 'child', delta: 'Inspecting' }
    } })
    await hooks.event({ event: {
      type: 'message.part.delta', properties: { sessionID: 'unrelated', delta: 'Private' }
    } })
    expect(write).toHaveBeenCalledTimes(2)
    for (const [line] of write.mock.calls) {
      expect(line.endsWith('\n')).toBe(true)
      expect(JSON.parse(line)).toMatchObject({
        method: 'session/update',
        params: { sessionId: 'parent', update: {
          sessionUpdate: 'tool_call_update', toolCallId: 'task',
          _meta: { goodbuddySubagentEvent: { properties: expect.any(Object) } }
        } }
      })
    }
  })
})
