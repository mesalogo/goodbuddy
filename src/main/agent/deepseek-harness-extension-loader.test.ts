import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  loadControlledHarnessExtensions,
  type ControlledHarnessExtensionPackage
} from './deepseek-harness-extension-loader'

function extension(
  id: string
): ControlledHarnessExtensionPackage {
  return {
    id,
    entrypoint: `C:\\extensions\\${id}\\index.js`,
    configuration: {}
  }
}

describe('DeepSeek Harness extension loader', () => {
  it('loads named Cordis plugin exports and keeps working extensions active', async () => {
    const ctx = new Context()
    const apply = vi.fn()
    const result = await loadControlledHarnessExtensions(
      ctx,
      [extension('greet')],
      {
        importModule: vi.fn(async () => ({
          name: 'greet',
          apply
        }))
      }
    )

    expect(result).toEqual({
      loadedIds: ['greet'],
      failedIds: [],
      failures: []
    })
    expect(apply).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('continues after one extension fails to import', async () => {
    const ctx = new Context()
    const importModule = vi.fn(async (url: string) => {
      if (url.includes('broken')) {
        throw new Error('broken extension')
      }
      return {
        default: {
          apply() {
            return undefined
          }
        }
      }
    })

    await expect(
      loadControlledHarnessExtensions(
        ctx,
        [extension('broken'), extension('working')],
        { importModule }
      )
    ).resolves.toEqual({
      loadedIds: ['working'],
      failedIds: ['broken'],
      failures: [
        {
          id: 'broken',
          message: 'broken extension'
        }
      ]
    })
    await ctx.fiber.dispose()
  })

  it('disposes an extension whose activation fails', async () => {
    const ctx = new Context()
    const dispose = vi.spyOn(ctx.fiber, 'dispose')

    const result = await loadControlledHarnessExtensions(
      ctx,
      [extension('broken')],
      {
        importModule: async () => ({
          apply() {
            throw new Error('activation failed')
          }
        })
      }
    )

    expect(result).toEqual({
      loadedIds: [],
      failedIds: ['broken'],
      failures: [
        {
          id: 'broken',
          message: 'activation failed'
        }
      ]
    })
    expect(dispose).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('bounds the complete extension startup sequence', async () => {
    const ctx = new Context()
    const importModule = vi.fn(
      () => new Promise<never>(() => undefined)
    )

    const result = await loadControlledHarnessExtensions(
      ctx,
      [extension('slow'), extension('later')],
      {
        activationTimeoutMs: 1_000,
        totalActivationTimeoutMs: 20,
        importModule
      }
    )

    expect(importModule).toHaveBeenCalledOnce()
    expect(result.loadedIds).toEqual([])
    expect(result.failedIds).toEqual(['slow', 'later'])
    expect(result.failures[0]?.message).toContain('timed out')
    expect(result.failures[1]?.message).toContain(
      'startup deadline exceeded'
    )
    await ctx.fiber.dispose()
  })

  it('does not activate an import that resolves after its timeout', async () => {
    const ctx = new Context()
    const apply = vi.fn()
    let resolveImport!: (module: {
      apply: typeof apply
    }) => void
    const imported = new Promise<{ apply: typeof apply }>(
      (resolve) => {
        resolveImport = resolve
      }
    )

    await loadControlledHarnessExtensions(
      ctx,
      [extension('late')],
      {
        activationTimeoutMs: 10,
        totalActivationTimeoutMs: 100,
        importModule: () => imported
      }
    )
    resolveImport({ apply })
    await Promise.resolve()
    await Promise.resolve()

    expect(apply).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
