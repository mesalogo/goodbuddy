import { describe, expect, it } from 'vitest'
import {
  agentPackageArchiveName,
  agentPackageCatalogEntrySchema,
  agentPackageInventoryRequestSchema,
  agentPackageInventorySchema,
  isSafeAgentPackagePath
} from './agent-package-contracts'

const digest = 'a'.repeat(64)

function catalogEntry() {
  const version = '0.11.2'
  const archive = agentPackageArchiveName(version, 'x64')
  return {
    format: 'goodbuddy-agent-package',
    formatVersion: 1,
    product: 'GoodBuddy',
    component: 'agent',
    version,
    minimumDesktopVersion: '0.11.0',
    platform: 'linux',
    architecture: 'x64',
    agentProtocol: { major: 2, minor: 0 },
    remoteRuntime: {
      runtimeId: 'opencode',
      provider: 'opencode',
      version: '1.18.9',
      bundleDigest: `sha256:${digest}`,
      protocol: { major: 1, minor: 0 }
    },
    archive,
    size: 1,
    sha256: digest,
    downloads: {
      github: {
        url:
          'https://github.com/mesalogo/goodbuddy/releases/download/' +
          `agent-v${version}/${archive}`
      },
      mirror: {
        url:
          'https://goodbuddy.oss-cn-beijing.aliyuncs.com/' +
          `agent-releases/v${version}/${archive}`
      }
    }
  } as const
}

describe('Agent package contracts', () => {
  it('binds each catalog archive name to its signed identity', () => {
    expect(agentPackageCatalogEntrySchema.parse(catalogEntry()))
      .toMatchObject({
        version: '0.11.2',
        architecture: 'x64'
      })
    expect(() =>
      agentPackageCatalogEntrySchema.parse({
        ...catalogEntry(),
        archive: 'goodbuddy-agent-9.9.9-linux-x64.gbagent'
      })
    ).toThrow()
  })

  it('rejects unknown catalog entry metadata', () => {
    expect(() =>
      agentPackageCatalogEntrySchema.parse({
        ...catalogEntry(),
        bootstrapCapability: {
          version: 1
        }
      })
    ).toThrow()
  })

  it('requires one local inventory entry per architecture', () => {
    const entry = {
      platform: 'linux',
      state: 'not-downloaded',
      version: null,
      latestVersion: null,
      updateAvailable: false,
      remoteRuntimeVersion: null,
      agentProtocol: null
    } as const
    expect(
      agentPackageInventorySchema.parse({
        checkedAt: '2026-08-25T00:00:00.000Z',
        catalog: {
          state: 'not-checked',
          checkedAt: null,
          error: null
        },
        entries: [
          { ...entry, architecture: 'x64' },
          { ...entry, architecture: 'arm64' }
        ]
      }).entries
    ).toHaveLength(2)
    expect(() =>
      agentPackageInventorySchema.parse({
        checkedAt: '2026-08-25T00:00:00.000Z',
        catalog: {
          state: 'not-checked',
          checkedAt: null,
          error: null
        },
        entries: [
          { ...entry, architecture: 'x64' },
          { ...entry, architecture: 'x64' }
        ]
      })
    ).toThrow()
  })

  it('accepts only a bounded refresh flag for inventory reads', () => {
    expect(agentPackageInventoryRequestSchema.parse({})).toEqual({
      refresh: false
    })
    expect(() =>
      agentPackageInventoryRequestSchema.parse({
        refresh: true,
        path: '/private/package'
      })
    ).toThrow()
  })

  it('rejects cross-platform device and drive-style archive paths', () => {
    expect(isSafeAgentPackagePath('agent/manifest.json')).toBe(true)
    expect(isSafeAgentPackagePath('C:/escape')).toBe(false)
    expect(isSafeAgentPackagePath('runtime/NUL')).toBe(false)
    expect(isSafeAgentPackagePath('agent/file.')).toBe(false)
  })
})
