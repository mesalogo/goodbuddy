// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { openCodeDynamicToolsPlugin } from './opencode-dynamic-tools-plugin'

type Input = { tool: string; callID: string; sessionID: string }
type Hooks = {
  'tool.execute.before': (input: Input) => Promise<void>
  'tool.execute.after': (input: Input, result: { _meta?: Record<string, unknown> }) => Promise<void>
  event: (input: { event: { type: string; properties: Record<string, unknown> } }) => Promise<void>
}
const input = { tool: 'gbc-abcdef_1234_load', callID: 'call', sessionID: 'session' }
const changed = { _meta: { 'goodbuddy/toolsChanged': true } }
async function hooks(): Promise<Hooks> {
  const uri = `data:text/javascript;base64,${Buffer.from(openCodeDynamicToolsPlugin).toString('base64')}`
  const module = await import(/* @vite-ignore */ uri) as { default: () => Promise<Hooks> }
  return module.default()
}
async function refreshed(hook: Hooks, server = 'gbc-abcdef'): Promise<void> {
  await hook.event({ event: { type: 'mcp.tools.changed', properties: { server } } })
}
afterEach(() => vi.useRealTimers())

it('waits for the owning MCP cache update and preserves parallel call waiters', async () => {
  const hook = await hooks()
  await hook['tool.execute.before'](input)
  const other = { ...input, tool: 'gbc-fedcba_1234_load', callID: 'other' }
  await hook['tool.execute.before'](other)
  let completed = false
  const result = hook['tool.execute.after'](input, changed).then(() => { completed = true })
  await refreshed(hook, 'gbc-fedcba')
  await hook['tool.execute.after'](other, changed)
  expect(completed).toBe(false)
  await refreshed(hook)
  await result
  expect(completed).toBe(true)
})

it('accepts a cache update that arrived before the tool result and skips unchanged results', async () => {
  const hook = await hooks()
  await hook['tool.execute.before'](input)
  await refreshed(hook)
  await hook['tool.execute.after'](input, changed)
  await hook['tool.execute.before'](input)
  await hook['tool.execute.after'](input, {})
})

it('starts the refresh timeout after a long-running tool finishes', async () => {
  vi.useFakeTimers()
  const hook = await hooks()
  await hook['tool.execute.before'](input)
  await vi.advanceTimersByTimeAsync(60_000)
  const result = hook['tool.execute.after'](input, changed)
  const assertion = expect(result).rejects.toThrow('refresh timed out')
  await vi.advanceTimersByTimeAsync(30_000)
  await assertion
  expect(vi.getTimerCount()).toBe(0)
})

it('releases a waiting refresh when its session ends', async () => {
  const hook = await hooks()
  await hook['tool.execute.before'](input)
  const result = hook['tool.execute.after'](input, changed)
  const assertion = expect(result).rejects.toThrow('refresh timed out')
  await hook.event({ event: { type: 'session.status', properties: { sessionID: 'session', status: { type: 'idle' } } } })
  await assertion
})
