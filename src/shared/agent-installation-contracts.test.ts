import { describe, expect, it } from 'vitest'
import {
  agentBundleManifestSchema,
  agentReleaseKeyRegistrySchema,
  agentRuntimeLockSchema
} from './agent-installation-contracts'

const digest = 'a'.repeat(64)

function manifest() {
  return {
    formatVersion: 1,
    product: 'GoodBuddy',
    agentVersion: '0.11.0',
    platform: 'linux',
    arch: 'x64',
    protocol: { major: 1, minor: 0 },
    signingKeyId: 'test-key',
    entrypoint: {
      path: 'goodbuddy-agent',
      runtimePath: 'node',
      scriptPath: 'lib/agent.cjs'
    },
    files: [
      {
        path: 'goodbuddy-agent',
        size: 1,
        sha256: digest,
        mode: '0755'
      },
      {
        path: 'node',
        size: 1,
        sha256: digest,
        mode: '0755'
      },
      {
        path: 'lib/agent.cjs',
        size: 1,
        sha256: digest,
        mode: '0644'
      },
      {
        path: 'licenses/license.txt',
        size: 1,
        sha256: digest,
        mode: '0644'
      }
    ],
    licenses: [
      {
        package: 'fixture',
        version: '1.0.0',
        spdx: 'MIT',
        path: 'licenses/license.txt'
      }
    ]
  } as const
}

describe('Agent installation contracts', () => {
  it('accepts a complete strict manifest', () => {
    expect(agentBundleManifestSchema.parse(manifest())).toMatchObject({
      arch: 'x64'
    })
    expect(() =>
      agentBundleManifestSchema.parse({
        ...manifest(),
        agentVersion: 'release_10'
      })
    ).toThrow()
  })

  it('rejects unsafe, duplicate, undeclared, and incorrectly-modeled files', () => {
    expect(() =>
      agentBundleManifestSchema.parse({
        ...manifest(),
        files: [
          ...manifest().files,
          {
            path: '../outside',
            size: 1,
            sha256: digest,
            mode: '0644'
          }
        ]
      })
    ).toThrow()
    expect(() =>
      agentBundleManifestSchema.parse({
        ...manifest(),
        files: [...manifest().files, manifest().files[0]]
      })
    ).toThrow()
    expect(() =>
      agentBundleManifestSchema.parse({
        ...manifest(),
        licenses: [
          {
            package: 'fixture',
            version: '1.0.0',
            spdx: 'MIT',
            path: 'licenses/missing.txt'
          }
        ]
      })
    ).toThrow()
    expect(() =>
      agentBundleManifestSchema.parse({
        ...manifest(),
        files: manifest().files.map((file) =>
          file.path === 'goodbuddy-agent'
            ? { ...file, mode: '0644' }
            : file
        )
      })
    ).toThrow()
  })

  it('rejects duplicate keys and extra registry fields', () => {
    const key = {
      keyId: 'test-key',
      publicKeySpkiBase64: 'AAAA',
      environment: 'test'
    }
    expect(() =>
      agentReleaseKeyRegistrySchema.parse({
        formatVersion: 1,
        keys: [key, key],
        revocations: [],
        unknown: true
      })
    ).toThrow()
  })

  it('rejects Base64 encodings with non-zero padding bits', () => {
    expect(() =>
      agentReleaseKeyRegistrySchema.parse({
        formatVersion: 1,
        keys: [{
          keyId: 'test-key',
          publicKeySpkiBase64: 'ZE==',
          environment: 'test'
        }],
        revocations: []
      })
    ).toThrow('canonical Base64')
  })

  it.each([
    ['24.19.0', '3.1.4'],
    ['24.18.0', '3.1.3']
  ])('accepts package Node %s and koffi %s versions while requiring valid targets and source', (nodeVersion, koffiVersion) => {
    const target = {
      archive: 'node.tar.gz',
      sha256: digest,
      binaryPath: 'node/bin/node',
      licensePath: 'node/LICENSE'
    }
    expect(
      agentRuntimeLockSchema.parse({
        formatVersion: 1,
        agentVersion: '0.11.0',
        protocol: { major: 1, minor: 0 },
        node: {
          version: nodeVersion,
          source: `https://nodejs.org/dist/v${nodeVersion}/`,
          targets: {
            'linux-x64': target,
            'linux-arm64': target
          }
        },
        koffi: { version: koffiVersion }
      }).koffi.version
    ).toBe(koffiVersion)
    expect(() =>
      agentRuntimeLockSchema.parse({
        formatVersion: 1,
        agentVersion: '0.11.0',
        protocol: { major: 1, minor: 0 },
        node: {
          version: '24.18.0',
          source: 'http://nodejs.org/',
          targets: { 'linux-x64': target }
        },
        koffi: { version: '3.1.3' }
      })
    ).toThrow()
  })

})
