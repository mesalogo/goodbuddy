import { runInNewContext } from 'node:vm'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { openCodeSubagentPluginSource } from './opencode-subagent-plugin'

describe('OpenCode ACP child event plugin', () => {
  it('authenticates native replies, checks live ownership, rejects stale events and closes its endpoint', async () => {
    const write = vi.fn()
    const question = { id: 'q', sessionID: 'grandchild', questions: [
      { header: 'Input', question: 'Choose', options: [] }
    ] }
    let listed: unknown[] = [question]
    const get = vi.fn(async () => ({ data: listed }))
    const post = vi.fn(async () => ({}))
    const factory = runInNewContext(
      `(${openCodeSubagentPluginSource().replace(/^import .*\n/gmu, '').replace('export default ', '')})`,
      { process: { stdout: { write } }, createServer, randomBytes }
    )
    const hooks = await factory({ client: {
      _client: { get, post }, session: { get: async ({ path }: { path: { id: string } }) => ({
        data: { id: path.id, parentID: path.id === 'grandchild' ? 'child' : path.id === 'child' ? 'parent' : undefined }
      }) }
    } })
    try {
      for (const [sessionID, child, callID] of [['parent', 'child', 'task'], ['child', 'grandchild', 'nested']]) {
        await hooks.event({ event: { type: 'message.part.updated', properties: { part: {
          type: 'tool', tool: 'task', sessionID, callID, state: { metadata: { sessionId: child } }
        } } } })
      }
      write.mockClear()
      await Promise.all([
        hooks.event({ event: { type: 'question.asked', properties: question } }),
        hooks.event({ event: { type: 'question.asked', properties: question } })
      ])
      expect(write).toHaveBeenCalledOnce()
      const notification = JSON.parse(write.mock.calls[0]![0]).params
      expect(notification.sessionId).toBe('parent')
      const extension = notification.update._meta.goodbuddyQuestion
      expect(extension.childCallId).toBe('task')
      const send = (url: string, sessionId: string, answers: string[][]) => fetch(url, {
        method: 'POST', body: JSON.stringify({ questionId: 'q', sessionId, answers })
      })
      expect((await send(extension.endpoint.replace(/.$/u, '!'), 'parent', [['A']])).status).toBe(404)
      expect((await send(extension.endpoint, 'other', [['A']])).status).toBe(409)
      expect(post).not.toHaveBeenCalled()
      expect((await send(extension.endpoint, 'parent', [['A']])).status).toBe(200)
      expect(post).toHaveBeenLastCalledWith({ url: '/question/q/reply', body: { answers: [['A']] }, throwOnError: true })
      expect((await send(extension.endpoint, 'parent', [['A']])).status).toBe(409)
      listed = []
      await hooks.event({ event: { type: 'question.asked', properties: question } })
      expect(write).toHaveBeenCalledOnce()
      listed = [question]
      await hooks.event({ event: { type: 'question.asked', properties: question } })
      expect((await send(extension.endpoint, 'parent', [])).status).toBe(200)
      expect(post).toHaveBeenLastCalledWith({ url: '/question/q/reject', throwOnError: true })
      await hooks.dispose()
      await expect(send(extension.endpoint, 'parent', [])).rejects.toThrow()
      write.mockClear()
      await hooks.event({ event: { type: 'question.asked', properties: question } })
      expect(write).not.toHaveBeenCalled()
    } finally {
      await hooks.dispose()
    }
  })

  it('emits valid newline-delimited ACP updates only for owned child sessions', async () => {
    const write = vi.fn()
    const factory = runInNewContext(
      `(${openCodeSubagentPluginSource().replace(/^import .*\n/gmu, '').replace('export default ', '')})`,
      { process: { stdout: { write } }, createServer: undefined, randomBytes: undefined }
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
