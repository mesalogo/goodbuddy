import { realpath } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  detectAgentRuntimes,
  detectRuntimeBinary
} from './runtime-discovery'

const originalPath = process.env.PATH
const originalPathCase = process.env.Path

afterEach(() => {
  if (originalPath === undefined) {
    delete process.env.PATH
  } else {
    process.env.PATH = originalPath
  }
  if (originalPathCase === undefined) {
    delete process.env.Path
  } else {
    process.env.Path = originalPathCase
  }
})

describe('runtime discovery', () => {
  it('canonicalizes and validates a configured ordinary file first', async () => {
    process.env.PATH = ''
    process.env.Path = ''

    const detection = await detectRuntimeBinary({
      binaryPath: process.execPath,
      binaryNames: ['binary-that-does-not-exist'],
      label: 'Test CLI'
    })

    expect(detection).toMatchObject({
      available: true,
      path: await realpath(process.execPath)
    })
    expect(detection.version).toMatch(/^\d+\.\d+\.\d+/u)
  })

  it('rejects relative configured paths without resolving them from cwd', async () => {
    process.env.PATH = ''
    process.env.Path = ''

    await expect(
      detectRuntimeBinary({
        binaryPath: 'relative/runtime',
        binaryNames: ['goodbuddy-runtime-that-does-not-exist'],
        label: 'Test CLI'
      })
    ).resolves.toEqual({
      available: false,
      detail: expect.stringContaining('必须为绝对路径')
    })
  })

  it('finds executable names from absolute PATH directories', async () => {
    process.env.PATH = dirname(process.execPath)
    process.env.Path = dirname(process.execPath)

    const detection = await detectRuntimeBinary({
      binaryPath: '',
      binaryNames: [basename(process.execPath)],
      label: 'Test CLI'
    })

    expect(detection).toMatchObject({
      available: true,
      path: await realpath(process.execPath)
    })
  })

  it('prefers a configured binary over the bundled runtime', async () => {
    const detection = await detectRuntimeBinary({
      binaryPath: process.execPath,
      bundledPath: process.execPath,
      binaryNames: ['goodbuddy-runtime-that-does-not-exist'],
      label: 'Test CLI'
    })

    expect(detection).toMatchObject({
      available: true,
      path: await realpath(process.execPath)
    })
    expect(detection.detail).not.toContain('内置')
  })

  it('prefers a bundled runtime over PATH discovery', async () => {
    process.env.PATH = dirname(process.execPath)
    process.env.Path = dirname(process.execPath)

    const detection = await detectRuntimeBinary({
      binaryPath: '',
      bundledPath: process.execPath,
      binaryNames: [basename(process.execPath)],
      label: 'Test CLI'
    })

    expect(detection).toMatchObject({
      available: true,
      path: await realpath(process.execPath)
    })
    expect(detection.detail).toContain('内置')
  })

  it('returns both runtime detections without exposing PATH contents', async () => {
    const privatePathValue = `${dirname(process.execPath)}-private-path-value`
    process.env.PATH = privatePathValue
    process.env.Path = privatePathValue

    const result = await detectAgentRuntimes({
      opencodeBinaryPath: process.execPath,
      continueBinaryPath: process.execPath
    })

    expect(result.opencode).toMatchObject({
      available: true,
      path: await realpath(process.execPath)
    })
    expect(result.continue).toMatchObject({
      available: true,
      path: await realpath(process.execPath)
    })
    expect(JSON.stringify(result)).not.toContain(privatePathValue)
  })
})
