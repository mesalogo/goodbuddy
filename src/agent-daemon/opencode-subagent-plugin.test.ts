import { runInNewContext } from 'node:vm'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { openCodeSubagentPluginSource } from './opencode-subagent-plugin'

describe('OpenCode ACP child event plugin', () => {
  it('hides foreign image tools and removes the current image tool in Ask on a reused Session', async () => {
    let mode = 'execute'
    const imageToolName = `goodbuddy_image_${'a'.repeat(24)}`
    const patch = vi.fn()
    const factory = runInNewContext(
      `(${openCodeSubagentPluginSource('http://127.0.0.1:12345/fixture').replace(/^import .*\n/gmu, '').replace('export default ', '')})`,
      { process: { stdout: { write: vi.fn() } }, createServer, randomBytes,
        fetch: async () => ({ ok: true, json: async () => ({ operationId: mode, workMode: mode, imageToolName }) }) }
    )
    const hooks = await factory({ client: {
      _client: { get: vi.fn(), post: vi.fn(), patch },
      session: { get: async () => ({ data: { id: 'root' } }) }
    } })
    try {
      for (mode of ['execute', 'ask', 'execute']) {
        await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'root', status: { type: 'idle' } } } })
        await hooks['chat.message']({ sessionID: 'root' }, { message: { id: mode } })
        const rules = patch.mock.calls.at(-1)![0].body.permission
        expect(rules).toContainEqual({ permission: 'goodbuddy_image_*', pattern: '*', action: 'deny' })
        expect(rules.some((rule: { permission: string; action: string }) => rule.permission === `${imageToolName}_*` && rule.action === 'allow')).toBe(mode === 'execute')
      }
    } finally { await hooks.dispose() }
  })
  it('attributes child and compaction model rounds to the frozen root operation', async () => {
    const operations = new Map([['one', 'operation-1'], ['two', 'operation-2']])
    const fetchRoute = vi.fn(async (url: string) => {
      const session = new URL(url).searchParams.get('sessionId')!
      return { ok: operations.has(session), json: async () => ({ operationId: operations.get(session), workMode: 'execute' }) }
    })
    const factory = runInNewContext(
      `(${openCodeSubagentPluginSource('http://127.0.0.1:12345/fixture').replace(/^import .*\n/gmu, '').replace('export default ', '')})`,
      { process: { stdout: { write: vi.fn() } }, createServer, randomBytes, fetch: fetchRoute }
    )
    const patch = vi.fn()
    const hooks = await factory({ client: {
      _client: { get: vi.fn(), post: vi.fn(), patch },
      session: { get: async ({ path }: { path: { id: string } }) => ({
        data: {
          id: path.id, parentID: path.id === 'child' ? 'one' : undefined,
          permission: path.id === 'child' ? [{ permission: 'task', pattern: '*', action: 'deny' }] : undefined
        }
      }) }
    } })
    const headers = async (sessionID: string, id: string) => {
      const output = { headers: {} }
      await hooks['chat.headers']({ sessionID, message: { id } }, output)
      return output.headers
    }
    try {
      await hooks['chat.message']({ sessionID: 'one' }, { message: { id: 'first' } })
      expect(patch).toHaveBeenCalledWith({
        url: '/session/one', body: { permission: [
          { permission: '*', pattern: '*', action: 'allow' },
          { permission: 'goodbuddy_image_*', pattern: '*', action: 'deny' }
        ] }, throwOnError: true
      })
      expect(await headers('child', 'child-message')).toEqual({
        'x-goodbuddy-session': 'one', 'x-goodbuddy-operation': 'operation-1'
      })
      await hooks['chat.message']({ sessionID: 'child' }, { message: { id: 'child-message' } })
      expect(patch).toHaveBeenLastCalledWith({
        url: '/session/child', body: { permission: [
          { permission: '*', pattern: '*', action: 'allow' },
          { permission: 'task', pattern: '*', action: 'deny' },
          { permission: 'goodbuddy_image_*', pattern: '*', action: 'deny' }
        ] }, throwOnError: true
      })
      expect(await headers('two', 'compact')).toEqual({
        'x-goodbuddy-session': 'two', 'x-goodbuddy-operation': 'operation-2'
      })
      operations.set('one', 'next-operation')
      expect(await headers('one', 'first')).toEqual({
        'x-goodbuddy-session': 'one', 'x-goodbuddy-operation': 'operation-1'
      })
      await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'one', status: { type: 'idle' } } } })
      expect(await headers('one', 'next-message')).toEqual({
        'x-goodbuddy-session': 'one', 'x-goodbuddy-operation': 'next-operation'
      })
      operations.delete('two')
      await expect(headers('two', 'stale-new-message')).rejects.toThrow('no longer active')
      expect(await headers('two', 'compact')).toEqual({
        'x-goodbuddy-session': 'two', 'x-goodbuddy-operation': 'operation-2'
      })
    } finally { await hooks.dispose() }
  })

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
