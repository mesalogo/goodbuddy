import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Architecture = 'x64' | 'arm64'

interface PortableBuilderModule {
  assertPortableOutput: (
    directory: string,
    architectures?: Architecture[]
  ) => void
  discoverLocalAgentResources: (
    projectRoot: string
  ) => Architecture[]
  embedPortableAgentResources: (
    directory: string,
    options: {
      projectRoot: string
      requiredArchitectures?: Architecture[]
      verifyLockedBundle?: (
        directory: string,
        architecture: Architecture,
        options: { projectRoot: string }
      ) => void
    }
  ) => Architecture[]
  parseRequiredAgentArchitectures: (
    value: string | undefined
  ) => Architecture[]
  portableRequiredPaths: (
    directory: string,
    architectures?: Architecture[]
  ) => string[]
}

const require = createRequire(import.meta.url)
const portableBuilder = require(
  '../build/build-portable.cjs'
) as PortableBuilderModule

let directory: string
let projectRoot: string
let unpackedDirectory: string

function createAgentResource(
  architecture: Architecture,
  contents: string = architecture
): string {
  const resource = join(
    projectRoot,
    '.agent-resources',
    `linux-${architecture}`
  )
  mkdirSync(join(resource, 'lib'), { recursive: true })
  writeFileSync(join(resource, 'manifest.json'), contents)
  writeFileSync(join(resource, 'manifest.sig'), 'signature')
  writeFileSync(join(resource, 'goodbuddy-agent'), 'launcher')
  writeFileSync(join(resource, 'node'), 'runtime')
  writeFileSync(join(resource, 'lib', 'agent.cjs'), 'agent')
  return resource
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'goodbuddy-portable-test-'))
  projectRoot = join(directory, 'project')
  unpackedDirectory = join(directory, 'win-unpacked')
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(unpackedDirectory, { recursive: true })
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('Portable Agent resources', () => {
  it('parses and deduplicates required architectures', () => {
    expect(
      portableBuilder.parseRequiredAgentArchitectures(undefined)
    ).toEqual([])
    expect(
      portableBuilder.parseRequiredAgentArchitectures(
        ' x64,arm64,x64 '
      )
    ).toEqual(['x64', 'arm64'])
    expect(() =>
      portableBuilder.parseRequiredAgentArchitectures('')
    ).toThrow('仅支持逗号分隔的 x64 和 arm64')
    expect(() =>
      portableBuilder.parseRequiredAgentArchitectures('x64,ia32')
    ).toThrow('仅支持逗号分隔的 x64 和 arm64')
  })

  it('discovers only local Agent resource directories', () => {
    createAgentResource('arm64')
    const nonDirectory = join(
      projectRoot,
      '.agent-resources',
      'linux-x64'
    )
    writeFileSync(nonDirectory, 'not a directory')

    expect(
      portableBuilder.discoverLocalAgentResources(projectRoot)
    ).toEqual(['arm64'])
  })

  it('verifies every discovered bundle before copying it', () => {
    const x64Resource = createAgentResource('x64', 'x64 manifest')
    const arm64Resource = createAgentResource(
      'arm64',
      'arm64 manifest'
    )
    const verifyLockedBundle = vi.fn()

    expect(
      portableBuilder.embedPortableAgentResources(
        unpackedDirectory,
        {
          projectRoot,
          requiredArchitectures: ['x64', 'arm64'],
          verifyLockedBundle
        }
      )
    ).toEqual(['x64', 'arm64'])
    expect(verifyLockedBundle.mock.calls).toEqual([
      [x64Resource, 'x64', { projectRoot }],
      [arm64Resource, 'arm64', { projectRoot }]
    ])
    expect(
      readFileSync(
        join(
          unpackedDirectory,
          'resources',
          'agents',
          'linux-x64',
          'manifest.json'
        ),
        'utf8'
      )
    ).toBe('x64 manifest')
    expect(
      readFileSync(
        join(
          unpackedDirectory,
          'resources',
          'agents',
          'linux-arm64',
          'manifest.json'
        ),
        'utf8'
      )
    ).toBe('arm64 manifest')
  })

  it('copies no Agent bytes when strict verification fails', () => {
    createAgentResource('x64')
    createAgentResource('arm64')
    const verifyLockedBundle = vi.fn(
      (_resource: string, architecture: Architecture) => {
        if (architecture === 'arm64') {
          throw new Error('verification failed')
        }
      }
    )

    expect(() =>
      portableBuilder.embedPortableAgentResources(
        unpackedDirectory,
        {
          projectRoot,
          verifyLockedBundle
        }
      )
    ).toThrow('verification failed')
    expect(
      existsSync(
        join(unpackedDirectory, 'resources', 'agents')
      )
    ).toBe(false)
  })

  it('fails when a required architecture is absent', () => {
    createAgentResource('x64')
    const verifyLockedBundle = vi.fn()

    expect(() =>
      portableBuilder.embedPortableAgentResources(
        unpackedDirectory,
        {
          projectRoot,
          requiredArchitectures: ['x64', 'arm64'],
          verifyLockedBundle
        }
      )
    ).toThrow('linux-arm64')
    expect(verifyLockedBundle).not.toHaveBeenCalled()
  })

  it('preserves metadata-only packaging when no resource exists', () => {
    const verifyLockedBundle = vi.fn()

    expect(
      portableBuilder.embedPortableAgentResources(
        unpackedDirectory,
        { projectRoot, verifyLockedBundle }
      )
    ).toEqual([])
    expect(verifyLockedBundle).not.toHaveBeenCalled()
    expect(
      existsSync(
        join(unpackedDirectory, 'resources', 'agents')
      )
    ).toBe(false)
    expect(
      portableBuilder.portableRequiredPaths(unpackedDirectory)
    ).toContain(
      join(
        unpackedDirectory,
        'resources',
        'agent-runtime-lock.json'
      )
    )
  })

  it('includes embedded Agent payloads in output assertions', () => {
    const requiredPaths = portableBuilder.portableRequiredPaths(
      unpackedDirectory,
      ['arm64']
    )
    const missingPath = join(
      unpackedDirectory,
      'resources',
      'agents',
      'linux-arm64',
      'lib',
      'agent.cjs'
    )
    for (const requiredPath of requiredPaths) {
      if (requiredPath === missingPath) {
        continue
      }
      mkdirSync(dirname(requiredPath), { recursive: true })
      writeFileSync(requiredPath, 'required')
    }

    expect(requiredPaths).toContain(
      join(
        unpackedDirectory,
        'resources',
        'agents',
        'linux-arm64',
        'manifest.json'
      )
    )
    expect(() =>
      portableBuilder.assertPortableOutput(
        unpackedDirectory,
        ['arm64']
      )
    ).toThrow(missingPath)
    mkdirSync(dirname(missingPath), { recursive: true })
    writeFileSync(missingPath, 'agent')
    expect(() =>
      portableBuilder.assertPortableOutput(
        unpackedDirectory,
        ['arm64']
      )
    ).not.toThrow()
  })
})
