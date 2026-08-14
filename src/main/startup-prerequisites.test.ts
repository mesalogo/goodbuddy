import { describe, expect, it, vi } from 'vitest'
import { runStartupPrerequisites } from './startup-prerequisites'

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('runStartupPrerequisites', () => {
  it('starts independent work before synchronous initialization and waits for every branch', async () => {
    const order: string[] = []
    const deepSeekHome = deferred()
    const knowledgeAndGateway = deferred()
    const configuredRuntime = deferred<{ id: string }>()

    const result = runStartupPrerequisites({
      prepareDeepSeekHome: () => {
        order.push('deepseek')
        return deepSeekHome.promise
      },
      initializeKnowledgeAndGateway: () => {
        order.push('knowledge')
        return knowledgeAndGateway.promise
      },
      hydrateConfiguredRuntime: () => {
        order.push('runtime')
        return configuredRuntime.promise
      },
      initializeAssistant: () => {
        order.push('assistant')
      }
    })
    const completed = vi.fn()
    void result.then(completed)

    expect(order).toEqual([
      'deepseek',
      'knowledge',
      'runtime',
      'assistant'
    ])

    configuredRuntime.resolve({ id: 'configured' })
    knowledgeAndGateway.resolve()
    await Promise.resolve()
    expect(completed).not.toHaveBeenCalled()

    deepSeekHome.resolve()
    await expect(result).resolves.toEqual({ id: 'configured' })
    expect(completed).toHaveBeenCalledOnce()
  })

  it('settles every started branch before propagating synchronous initialization failure', async () => {
    const assistantError = new Error('assistant failed')
    const deepSeekHome = deferred()
    const knowledgeAndGateway = deferred()
    const configuredRuntime = deferred<{ id: string }>()

    const result = runStartupPrerequisites({
      prepareDeepSeekHome: () => deepSeekHome.promise,
      initializeKnowledgeAndGateway: () =>
        knowledgeAndGateway.promise,
      hydrateConfiguredRuntime: () => configuredRuntime.promise,
      initializeAssistant: () => {
        throw assistantError
      }
    })
    const rejected = vi.fn()
    void result.catch(rejected)

    deepSeekHome.resolve()
    knowledgeAndGateway.resolve()
    await Promise.resolve()
    expect(rejected).not.toHaveBeenCalled()

    configuredRuntime.resolve({ id: 'unused' })
    await expect(result).rejects.toBe(assistantError)
    expect(rejected).toHaveBeenCalledOnce()
  })

  it('does not publish an async branch failure until the other branches settle', async () => {
    const runtimeError = new Error('runtime failed')
    const deepSeekHome = deferred()
    const knowledgeAndGateway = deferred()

    const result = runStartupPrerequisites({
      prepareDeepSeekHome: () => deepSeekHome.promise,
      initializeKnowledgeAndGateway: () =>
        knowledgeAndGateway.promise,
      hydrateConfiguredRuntime: () =>
        Promise.reject(runtimeError),
      initializeAssistant: () => undefined
    })
    const rejected = vi.fn()
    void result.catch(rejected)

    await Promise.resolve()
    expect(rejected).not.toHaveBeenCalled()

    deepSeekHome.resolve()
    knowledgeAndGateway.resolve()
    await expect(result).rejects.toBe(runtimeError)
    expect(rejected).toHaveBeenCalledOnce()
  })
})
