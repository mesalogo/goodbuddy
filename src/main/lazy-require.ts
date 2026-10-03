import { createRequire } from 'node:module'

/**
 * Synchronously loads a dependency on first use instead of at module
 * evaluation (P6). Main is ESM, but some test fixtures bundle the same code as
 * CommonJS, where `import.meta.url` is empty and `__filename` exists instead.
 */
export function createLazyRequire<T>(specifier: string): () => T {
  let loaded: T | undefined
  return () => {
    loaded ??= createRequire(import.meta.url || __filename)(specifier) as T
    return loaded
  }
}
