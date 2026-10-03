// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createLazyRequire } from './lazy-require'
import { loadHtmlToText } from './document-extracted-text'
import { loadSsh2 } from './ssh/ssh2-module'

describe('createLazyRequire', () => {
  it('loads a module on first call and returns the cached instance afterwards', () => {
    const load = createLazyRequire<typeof import('node:path')>('node:path')
    const first = load()
    expect(typeof first.join).toBe('function')
    expect(load()).toBe(first)
  })

  it('surfaces a missing module at first use, not at import time', () => {
    const load = createLazyRequire('goodbuddy-module-that-does-not-exist')
    expect(load).toThrow()
  })

  it('resolves the deferred Main dependencies', () => {
    expect(typeof loadHtmlToText().convert).toBe('function')
    expect(typeof loadSsh2().Client).toBe('function')
  })
})
