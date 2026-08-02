import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('sandboxed preload', () => {
  it('does not import Node built-ins unavailable in Electron sandbox', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/\bfrom\s+['"]node:/u)
    expect(source).not.toMatch(/\brequire\(\s*['"]node:/u)
  })
})
