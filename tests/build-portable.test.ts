import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

interface PortableBuilderModule {
  assertPortableOutput(directory: string): void
  portableRequiredPaths(directory: string): string[]
}

const require = createRequire(import.meta.url)
const portableBuilder = require(
  '../build/build-portable.cjs'
) as PortableBuilderModule

let directory: string

beforeEach(() => {
  directory = mkdtempSync(
    join(tmpdir(), 'goodbuddy-portable-test-')
  )
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('Portable package resources', () => {
  it('requires metadata and local desktop Runtimes without remote payloads', () => {
    const requiredPaths =
      portableBuilder.portableRequiredPaths(directory)
    expect(requiredPaths).toContain(
      join(
        directory,
        'resources',
        'agent-runtime-lock.json'
      )
    )
    expect(requiredPaths).toContain(
      join(
        directory,
        'resources',
        'remote-runtime-lock.json'
      )
    )
    expect(
      requiredPaths.some((path) =>
        path.includes(
          `${join('resources', 'agents')}`
        )
      )
    ).toBe(false)
    expect(
      requiredPaths.some((path) =>
        path.includes(
          `${join('resources', 'remote-runtimes')}`
        )
      )
    ).toBe(false)
  })

  it('validates the metadata-only portable output', () => {
    const requiredPaths =
      portableBuilder.portableRequiredPaths(directory)
    const missingPath = requiredPaths.at(-1)
    expect(missingPath).toBeDefined()
    for (const requiredPath of requiredPaths.slice(0, -1)) {
      mkdirSync(dirname(requiredPath), { recursive: true })
      writeFileSync(requiredPath, 'required')
    }
    expect(() =>
      portableBuilder.assertPortableOutput(directory)
    ).toThrow(missingPath)
    mkdirSync(dirname(missingPath!), { recursive: true })
    writeFileSync(missingPath!, 'required')
    expect(() =>
      portableBuilder.assertPortableOutput(directory)
    ).not.toThrow()
  })
})
