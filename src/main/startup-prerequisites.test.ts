import { describe, expect, it, vi } from 'vitest'
import {
  createStartupFailureDiagnostic,
  formatStartupFailureMessage,
  runStartupPrerequisites,
  StartupPrerequisiteError
} from './startup-prerequisites'

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
    await expect(result).rejects.toMatchObject({
      name: 'StartupPrerequisiteError',
      stage: 'assistant-database',
      cause: assistantError
    })
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
    await expect(result).rejects.toMatchObject({
      name: 'StartupPrerequisiteError',
      stage: 'runtime',
      cause: runtimeError
    })
    expect(rejected).toHaveBeenCalledOnce()
  })

  it('collects simultaneous async failures in deterministic stage order', async () => {
    const runtimeHomeError = new TypeError('runtime home failed')
    const knowledgeError = new RangeError('knowledge failed')
    const runtimeError = new SyntaxError('runtime failed')
    const deepSeekHome = deferred()
    const knowledgeAndGateway = deferred()
    const configuredRuntime = deferred<{ id: string }>()

    const result = runStartupPrerequisites({
      prepareDeepSeekHome: () => deepSeekHome.promise,
      initializeKnowledgeAndGateway: () =>
        knowledgeAndGateway.promise,
      hydrateConfiguredRuntime: () => configuredRuntime.promise,
      initializeAssistant: () => undefined
    })

    configuredRuntime.reject(runtimeError)
    knowledgeAndGateway.reject(knowledgeError)
    deepSeekHome.reject(runtimeHomeError)

    await expect(result).rejects.toMatchObject({
      name: 'StartupPrerequisiteError',
      stage: 'runtime-home',
      stages: ['runtime-home', 'knowledge', 'runtime'],
      cause: runtimeHomeError
    })
  })

  it('preserves assistant initialization as the primary failure', async () => {
    const assistantError = new Error('assistant failed')
    const runtimeHomeError = new Error('runtime home failed')

    await expect(
      runStartupPrerequisites({
        prepareDeepSeekHome: () => Promise.reject(runtimeHomeError),
        initializeKnowledgeAndGateway: () =>
          Promise.reject(new Error('knowledge failed')),
        hydrateConfiguredRuntime: () =>
          Promise.reject(new Error('runtime failed')),
        initializeAssistant: () => {
          throw assistantError
        }
      })
    ).rejects.toMatchObject({
      stage: 'assistant-database',
      stages: [
        'assistant-database',
        'runtime-home',
        'knowledge',
        'runtime'
      ],
      cause: assistantError
    })
  })

  it.each([
    ['runtime-home', 'prepareDeepSeekHome'],
    ['knowledge', 'initializeKnowledgeAndGateway'],
    ['runtime', 'hydrateConfiguredRuntime']
  ] as const)(
    'identifies a failed %s startup branch',
    async (stage, operation) => {
      const failure = new Error(`${stage} failed`)
      const dependencies = {
        prepareDeepSeekHome: () => Promise.resolve(),
        initializeKnowledgeAndGateway: () => Promise.resolve(),
        hydrateConfiguredRuntime: () => Promise.resolve({ id: 'configured' }),
        initializeAssistant: () => undefined
      }
      dependencies[operation] = () => Promise.reject(failure) as never

      const result = runStartupPrerequisites(dependencies)

      await expect(result).rejects.toEqual(
        expect.objectContaining<Partial<StartupPrerequisiteError>>({
          name: 'StartupPrerequisiteError',
          stage,
          cause: failure
        })
      )
    }
  )

  it.each([
    ['runtime-home', 'prepareDeepSeekHome'],
    ['knowledge', 'initializeKnowledgeAndGateway'],
    ['runtime', 'hydrateConfiguredRuntime']
  ] as const)(
    'observes a synchronous throw from the %s promise dependency',
    async (stage, operation) => {
      const failure = new Error(`${stage} synchronous failure`)
      const dependencies = {
        prepareDeepSeekHome: () => Promise.resolve(),
        initializeKnowledgeAndGateway: () => Promise.resolve(),
        hydrateConfiguredRuntime: () =>
          Promise.resolve({ id: 'configured' }),
        initializeAssistant: () => undefined
      }
      dependencies[operation] = (() => {
        throw failure
      }) as never

      await expect(
        runStartupPrerequisites(dependencies)
      ).rejects.toMatchObject({
        name: 'StartupPrerequisiteError',
        stage,
        stages: [stage],
        cause: failure
      })
    }
  )
})

describe('startup failure reporting', () => {
  it('keeps secret-bearing causes out of user-facing formatting', () => {
    const secret = 'provider-key=sk-secret-value'
    const failure = new Error(secret)
    const error = new StartupPrerequisiteError(
      'runtime',
      failure,
      ['runtime']
    )

    const message = formatStartupFailureMessage(error)

    expect(message).toContain('阶段：runtime')
    expect(message).not.toContain(secret)
    expect(Object.isFrozen(error.stages)).toBe(true)
  })

  it('formats all prerequisite stages and logs only bounded metadata', async () => {
    const secret = 'provider-key=sk-secret-value'
    let startupError: unknown
    try {
      await runStartupPrerequisites({
        prepareDeepSeekHome: () =>
          Promise.reject(new TypeError(secret)),
        initializeKnowledgeAndGateway: () =>
          Promise.reject(new Error('another secret')),
        hydrateConfiguredRuntime: () =>
          Promise.resolve({ id: 'configured' }),
        initializeAssistant: () => undefined
      })
    } catch (error) {
      startupError = error
    }

    const message = formatStartupFailureMessage(startupError)
    const diagnostic = createStartupFailureDiagnostic(startupError)

    expect(message).toContain('阶段：runtime-home, knowledge')
    expect(message).not.toContain(secret)
    expect(diagnostic).toEqual({
      stages: ['runtime-home', 'knowledge'],
      errorName: 'StartupPrerequisiteError',
      causeName: 'TypeError'
    })
    expect(JSON.stringify(diagnostic)).not.toContain(secret)
    expect(Object.isFrozen(diagnostic)).toBe(true)
    expect(Object.isFrozen(diagnostic.stages)).toBe(true)
  })

  it('maps generic startup errors to the closed application stage', () => {
    const secret = 'provider-key=sk-secret-value'
    const error = new Error(secret)

    expect(formatStartupFailureMessage(error)).toContain(
      '阶段：application'
    )
    expect(createStartupFailureDiagnostic(error)).toEqual({
      stages: ['application'],
      errorName: 'Error'
    })
    expect(formatStartupFailureMessage(error)).not.toContain(secret)
  })
})
