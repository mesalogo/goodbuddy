import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  DEEPSEEK_HARNESS_EXTENSION_ACTIVATION_TIMEOUT_MS,
  DEEPSEEK_HARNESS_EXTENSION_DISPOSAL_TIMEOUT_MS,
  DEEPSEEK_HARNESS_TOTAL_EXTENSION_ACTIVATION_TIMEOUT_MS
} from './deepseek-harness-control-protocol'

const ACTIVATION_TIMEOUT_MESSAGE =
  'DeepSeek Harness extension activation timed out'

export type ControlledHarnessExtensionPackage = {
  id: string
  entrypoint: string
  configuration: Record<string, unknown>
}

export type ControlledHarnessExtensionLoadResult = {
  loadedIds: string[]
  failedIds: string[]
  failures: Array<{ id: string; message: string }>
}

type ExtensionModule = {
  default?: unknown
  apply?: unknown
}

// Keep the import native so Vite does not try to resolve userData file URLs
// while bundling or running Vitest.
const nativeImportModule = new Function(
  'specifier',
  'return import(specifier)'
) as (specifier: string) => Promise<ExtensionModule>
const requireExtension = createRequire(import.meta.url)

async function defaultImportModule(
  specifier: string
): Promise<ExtensionModule> {
  try {
    return requireExtension(
      fileURLToPath(specifier)
    ) as ExtensionModule
  } catch (error) {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : undefined
    if (
      code !== 'ERR_REQUIRE_ASYNC_MODULE' &&
      code !== 'ERR_REQUIRE_ESM'
    ) {
      throw error
    }
    return nativeImportModule(specifier)
  }
}

function isPlugin(value: unknown): value is Plugin {
  return (
    typeof value === 'function' ||
    (value !== null &&
      typeof value === 'object' &&
      typeof (value as { apply?: unknown }).apply === 'function')
  )
}

function resolvePlugin(module: ExtensionModule): Plugin {
  if (isPlugin(module)) {
    return module
  }
  if (isPlugin(module.default)) {
    return module.default
  }
  throw new Error(
    'DeepSeek Harness extension must export a Cordis plugin'
  )
}

async function withTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            onTimeout?.()
            reject(new Error(message))
          },
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export async function loadControlledHarnessExtensions(
  ctx: Context,
  extensions: readonly ControlledHarnessExtensionPackage[],
  options: {
    activationTimeoutMs?: number
    totalActivationTimeoutMs?: number
    importModule?: (url: string) => Promise<ExtensionModule>
  } = {}
): Promise<ControlledHarnessExtensionLoadResult> {
  const loadedIds: string[] = []
  const failedIds: string[] = []
  const failures: Array<{ id: string; message: string }> = []
  const activationTimeoutMs =
    options.activationTimeoutMs ??
    DEEPSEEK_HARNESS_EXTENSION_ACTIVATION_TIMEOUT_MS
  const deadline =
    Date.now() +
    (options.totalActivationTimeoutMs ??
      DEEPSEEK_HARNESS_TOTAL_EXTENSION_ACTIVATION_TIMEOUT_MS)
  const importModule = options.importModule ?? defaultImportModule

  for (const extension of extensions) {
    let fiber: (Fiber & PromiseLike<Fiber>) | undefined
    let acceptActivation = true
    let activationDeadline: number | undefined
    try {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        throw new Error(
          'DeepSeek Harness extension startup deadline exceeded'
        )
      }
      const extensionBudgetMs = Math.max(
        1,
        Math.min(activationTimeoutMs, remainingMs)
      )
      activationDeadline = Date.now() + extensionBudgetMs
      const rejectLateSynchronousWork = (): void => {
        if (Date.now() > activationDeadline!) {
          acceptActivation = false
          throw new Error(ACTIVATION_TIMEOUT_MESSAGE)
        }
      }
      const activation = (async () => {
        const module = await importModule(
          pathToFileURL(extension.entrypoint).href
        )
        rejectLateSynchronousWork()
        if (!acceptActivation) {
          throw new Error(ACTIVATION_TIMEOUT_MESSAGE)
        }
        const plugin = resolvePlugin(module)
        fiber = ctx.plugin(plugin, extension.configuration)
        // A timer cannot run while CommonJS evaluation or a plugin's
        // synchronous apply body owns this event loop. Re-check elapsed
        // wall time immediately after those calls return so finite
        // over-budget work is never reported as successfully activated.
        rejectLateSynchronousWork()
        await Promise.resolve(fiber)
        rejectLateSynchronousWork()
      })()
      await withTimeout(
        activation,
        Math.max(1, activationDeadline - Date.now()),
        ACTIVATION_TIMEOUT_MESSAGE,
        () => {
          acceptActivation = false
        }
      )
      loadedIds.push(extension.id)
    } catch (error) {
      const failure =
        activationDeadline !== undefined &&
        Date.now() > activationDeadline
          ? new Error(ACTIVATION_TIMEOUT_MESSAGE)
          : error
      if (fiber) {
        await withTimeout(
          fiber.dispose(),
          DEEPSEEK_HARNESS_EXTENSION_DISPOSAL_TIMEOUT_MS,
          'DeepSeek Harness extension disposal timed out'
        ).catch(() => undefined)
      }
      failedIds.push(extension.id)
      failures.push({
        id: extension.id,
        message:
          failure instanceof Error && failure.message.trim()
            ? failure.message.slice(0, 1_000)
            : 'DeepSeek Harness extension failed to start'
      })
    }
  }

  return { loadedIds, failedIds, failures }
}
