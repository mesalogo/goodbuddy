import { describe, expect, it, vi } from 'vitest'
import { LocalRuntimeRegistry } from './local-runtime-registry'
import type { AgentExecutionRequest, AgentRuntime, RuntimeEvent } from './runtime'

function fixture() {
  const requests: AgentExecutionRequest[] = []
  const sessions = new Set<string>()
  const runtime: AgentRuntime & { readonly hasRetainedSessions: boolean } = {
    runtimeId: 'opencode',
    requiresToolApproval: false,
    supportsToolExecution: true,
    get hasRetainedSessions() { return sessions.size > 0 },
    getStatus: vi.fn(async () => ({
      id: 'opencode' as const, label: 'OpenCode', available: true,
      supportsToolExecution: true, detail: 'ready'
    })),
    async *run(request) {
      requests.push(request)
      sessions.add(request.conversationId)
      yield { requestId: request.requestId, type: 'done' }
    },
    releaseConversation: vi.fn(async (id) => { sessions.delete(id) }),
    dispose: vi.fn(async () => { sessions.clear() })
  }
  return { runtime, requests, sessions }
}

async function run(runtime: AgentRuntime, id: string) {
  const events: RuntimeEvent[] = []
  for await (const event of runtime.run({
    requestId: id, conversationId: id, prompt: 'continue', workMode: 'execute'
  }, new AbortController().signal)) events.push(event)
  return events
}

describe('LocalRuntimeRegistry', () => {
  it('shares the Runtime but fixes each request to its resolved workspace', async () => {
    const registry = new LocalRuntimeRegistry()
    const host = fixture()
    const create = vi.fn(() => host.runtime)
    const first = registry.acquire('opencode:profile', { model: 'one' }, '/first', create)
    const second = registry.acquire('opencode:profile', { model: 'one' }, '/second', create)
    await Promise.all([run(first, 'a'), run(second, 'b')])
    expect(create).toHaveBeenCalledOnce()
    expect(host.requests.map((request) => request.executionWorkspace).sort()).toEqual(['/first', '/second'])
    await first.dispose()
    expect(host.runtime.dispose).not.toHaveBeenCalled()
    await run(second, 'b')
    await registry.releaseConversation('a')
    expect(host.sessions).toEqual(new Set(['b']))
    await registry.dispose()
    expect(host.runtime.dispose).toHaveBeenCalledOnce()
  })

  it('closes a no-session idle host and recreates it through an existing facade', async () => {
    vi.useFakeTimers()
    const registry = new LocalRuntimeRegistry(100)
    const first = fixture()
    const second = fixture()
    const create = vi.fn().mockReturnValueOnce(first.runtime).mockReturnValueOnce(second.runtime)
    try {
      const facade = registry.acquire('opencode:profile', {}, '/first', create)
      await facade.getStatus()
      await vi.advanceTimersByTimeAsync(100)
      expect(first.runtime.dispose).toHaveBeenCalledOnce()
      await run(facade, 'a')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(second.runtime.dispose).not.toHaveBeenCalled()
      await registry.releaseConversation('a')
      await vi.advanceTimersByTimeAsync(100)
      expect(second.runtime.dispose).toHaveBeenCalledOnce()
    } finally {
      await registry.dispose()
      vi.useRealTimers()
    }
  })

  it('drains an old configuration without closing a parallel replacement', async () => {
    const registry = new LocalRuntimeRegistry()
    const old = fixture()
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    old.runtime.run = async function* (request) {
      await pending
      yield { requestId: request.requestId, type: 'done' }
    }
    old.runtime.respondToQuestion = vi.fn(async () => undefined)
    const original = registry.acquire('opencode:profile', { model: 'old' }, '/one', () => old.runtime)
    const active = run(original, 'a')
    await Promise.resolve()
    const next = fixture()
    const replacement = registry.acquire('opencode:profile', { model: 'new' }, '/two', () => next.runtime)
    expect(old.runtime.dispose).not.toHaveBeenCalled()
    await original.respondToQuestion?.('active-question', [])
    expect(old.runtime.respondToQuestion).toHaveBeenCalledWith('active-question', [])
    await run(replacement, 'b')
    release()
    await active
    await vi.waitFor(() => expect(old.runtime.dispose).toHaveBeenCalledOnce())
    expect(next.runtime.dispose).not.toHaveBeenCalled()
    await registry.dispose()
  })

  it('does not renew or reacquire an idle owner during passive status polling', async () => {
    vi.useFakeTimers()
    const registry = new LocalRuntimeRegistry(100)
    const host = fixture()
    const inspection = fixture()
    const restarted = fixture()
    const create = vi.fn()
      .mockReturnValueOnce(host.runtime)
      .mockReturnValueOnce(inspection.runtime)
      .mockReturnValueOnce(restarted.runtime)
    try {
      const facade = registry.acquire('opencode:profile', {}, '/first', create)
      for (let poll = 0; poll < 3; poll++) {
        await vi.advanceTimersByTimeAsync(30)
        expect(await facade.getStatus()).toMatchObject({ available: true })
      }
      expect(host.runtime.dispose).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10)
      expect(host.runtime.dispose).toHaveBeenCalledOnce()
      expect(create).toHaveBeenCalledOnce()

      await facade.getStatus()
      expect(inspection.runtime.dispose).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(200)
      expect(create).toHaveBeenCalledTimes(2)
      expect(restarted.runtime.dispose).not.toHaveBeenCalled()

      await run(facade, 'a')
      expect(create).toHaveBeenCalledTimes(3)
      expect(restarted.sessions).toEqual(new Set(['a']))
    } finally {
      await registry.dispose()
      vi.useRealTimers()
    }
  })
})
