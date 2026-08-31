import { describe, expect, it } from 'vitest'
import {
  SSH_DIRECTORY_BROWSE_LIMITS,
  agentBootstrapProbeResultSchema,
  sshDirectoryBrowseRequestSchema,
  sshDirectoryBrowseResultSchema,
  sshHostCreateInputSchema,
  sshHostAgentConnectionStatusSchema,
  sshHostDraftInspectionRequestSchema,
  remoteEnvironmentUpdateProgressSchema,
  remoteEnvironmentUpdateRequestSchema,
  sshHostRemoteEnvironmentSchema,
  sshHostValidationRequestSchema
} from './ssh-host-contracts'

describe('SSH host contracts', () => {
  it('accepts only bounded Host Agent connection states', () => {
    const status = {
      hostId: '00000000-0000-4000-8000-000000000101',
      state: 'ready'
    } as const
    expect(
      sshHostAgentConnectionStatusSchema.parse(status)
    ).toEqual(status)
    expect(() =>
      sshHostAgentConnectionStatusSchema.parse({
        ...status,
        state: 'unknown'
      })
    ).toThrow()
  })

  it('normalizes bounded display fields and preserves password bytes', () => {
    expect(
      sshHostCreateInputSchema.parse({
        name: '  Build host  ',
        hostname: 'build.example.com',
        port: 22,
        username: 'builder',
        authentication: 'password',
        password: {
          action: 'replace',
          value: '  exact password  '
        }
      })
    ).toEqual({
      name: 'Build host',
      hostname: 'build.example.com',
      port: 22,
      username: 'builder',
      authentication: 'password',
      password: {
        action: 'replace',
        value: '  exact password  '
      }
    })
  })

  it('requires a password for new password hosts and rejects one for system-agent auth', () => {
    expect(() =>
      sshHostCreateInputSchema.parse({
        name: 'Build host',
        hostname: 'build.example.com',
        port: 22,
        username: 'builder',
        authentication: 'password',
        password: { action: 'keep' }
      })
    ).toThrow()
    expect(() =>
      sshHostCreateInputSchema.parse({
        name: 'Build host',
        hostname: 'build.example.com',
        port: 22,
        username: 'builder',
        authentication: 'system-agent',
        password: { action: 'replace', value: 'not-allowed' }
      })
    ).toThrow()
  })

  it('rejects whitespace, control characters, unknown fields, and invalid ports', () => {
    for (const input of [
      {
        name: 'Build host',
        hostname: 'build host',
        port: 22,
        username: 'builder',
        authentication: 'system-agent',
        password: { action: 'clear' }
      },
      {
        name: 'Build\u0000host',
        hostname: 'build.example.com',
        port: 22,
        username: 'builder',
        authentication: 'system-agent',
        password: { action: 'clear' }
      },
      {
        name: 'Build host',
        hostname: 'build.example.com',
        port: 65_536,
        username: 'builder',
        authentication: 'system-agent',
        password: { action: 'clear' }
      },
      {
        name: 'Build host',
        hostname: 'build.example.com',
        port: 22,
        username: 'build user',
        authentication: 'system-agent',
        password: { action: 'clear' },
        command: 'rm -rf /'
      }
    ]) {
      expect(() => sshHostCreateInputSchema.parse(input)).toThrow()
    }
  })

  it('strictly validates inspection and validation envelopes', () => {
    const hostId = '00000000-0000-4000-8000-000000000101'
    const candidateId = '00000000-0000-4000-8000-000000000102'
    const fingerprint = `SHA256:${'A'.repeat(43)}`
    expect(
      sshHostDraftInspectionRequestSchema.parse({
        hostId,
        hostname: 'build.example.com',
        port: 22,
        username: 'builder'
      })
    ).toEqual({
      hostId,
      hostname: 'build.example.com',
      port: 22,
      username: 'builder'
    })
    expect(() =>
      sshHostValidationRequestSchema.parse({
        candidateId,
        fingerprintSha256: 'SHA256:short',
        input: {
          name: 'Build host',
          hostname: 'build.example.com',
          port: 22,
          username: 'builder',
          authentication: 'system-agent',
          password: { action: 'clear' }
        }
      })
    ).toThrow()
    expect(() =>
      sshHostValidationRequestSchema.parse({
        candidateId,
        fingerprintSha256: fingerprint,
        input: {
          name: 'Build host',
          hostname: 'build.example.com',
          port: 22,
          username: 'builder',
          authentication: 'system-agent',
          password: { action: 'clear' },
          privateKey: 'not-allowed'
        }
      })
    ).toThrow()
  })

  it('strictly validates Agent bootstrap readiness results', () => {
    expect(
      agentBootstrapProbeResultSchema.parse({
        ready: true,
        platform: 'linux',
        architecture: 'arm64',
        canonicalHomeDirectory: '/home/builder',
        uid: 1_001,
        shell: '/bin/bash',
        procfs: 'ready'
      })
    ).toMatchObject({
      ready: true,
      architecture: 'arm64'
    })
    expect(
      agentBootstrapProbeResultSchema.parse({
        ready: false,
        reason: 'procfs-unavailable'
      })
    ).toEqual({
      ready: false,
      reason: 'procfs-unavailable'
    })

    for (const result of [
      {
        ready: true,
        platform: 'linux',
        architecture: 'x64',
        canonicalHomeDirectory: '/home/builder/../root',
        uid: 1_001,
        shell: '/bin/bash',
        procfs: 'ready'
      },
      {
        ready: true,
        platform: 'linux',
        architecture: 'x64',
        canonicalHomeDirectory: '/home/builder\u0000',
        uid: 1_001,
        shell: '/bin/bash',
        procfs: 'ready'
      },
      {
        ready: false,
        reason: 'procfs-unavailable',
        diagnostic: 'environment dump'
      }
    ]) {
      expect(() =>
        agentBootstrapProbeResultSchema.parse(result)
      ).toThrow()
    }
  })

  it('exposes only bounded remote environment version metadata', () => {
    const status = {
      hostId: '00000000-0000-4000-8000-000000000101',
      checkedAt: '2030-01-01T00:00:00.000Z',
      architecture: 'x64',
      agent: {
        state: 'update-available',
        expected: {
          version: '0.11.1',
          architecture: 'x64'
        },
        installed: {
          version: '0.10.4',
          architecture: 'x64'
        }
      },
      runtimes: [{
        runtimeId: 'opencode',
        provider: 'opencode',
        state: 'current',
        expected: {
          version: '1.18.9',
          architecture: 'x64'
        },
        installed: {
          version: '1.18.9',
          architecture: 'x64'
        }
      }],
      remoteDownload: {
        available: true,
        source: 'mirror',
        packageSize: 1024
      }
    }
    expect(sshHostRemoteEnvironmentSchema.parse(status)).toEqual(status)
    expect(() =>
      sshHostRemoteEnvironmentSchema.parse({
        ...status,
        credential: 'secret'
      })
    ).toThrow()
    expect(() =>
      sshHostRemoteEnvironmentSchema.parse({
        ...status,
        remoteDownload: {
          available: false,
          source: 'mirror',
          packageSize: 1024,
          reason: 'arbitrary-reason'
        }
      })
    ).toThrow()
  })

  it('strictly validates manual remote environment preparation', () => {
    const hostId = '00000000-0000-4000-8000-000000000101'
    for (const method of [
      'auto',
      'remote-download',
      'goodbuddy-transfer'
    ]) {
      expect(
        remoteEnvironmentUpdateRequestSchema.parse({
          hostId,
          method
        })
      ).toEqual({ hostId, method })
    }
    for (const phase of [
      'probing',
      'downloading',
      'verifying',
      'installing-agent',
      'installing-runtime',
      'checking-health',
      'finalizing',
      'complete'
    ]) {
      expect(
        remoteEnvironmentUpdateProgressSchema.parse({
          hostId,
          method: 'remote-download',
          phase
        })
      ).toEqual({
        hostId,
        method: 'remote-download',
        phase
      })
    }
    for (const progress of [
      {
        hostId: 'not-a-uuid',
        method: 'remote-download',
        phase: 'probing'
      },
      { hostId, method: 'automatic', phase: 'probing' },
      {
        hostId,
        method: 'remote-download',
        phase: 'uploading'
      },
      {
        hostId,
        method: 'goodbuddy-transfer',
        phase: 'verifying',
        path: '/home/user'
      },
      {
        hostId,
        method: 'remote-download',
        phase: 'downloading',
        command: 'whoami'
      },
      {
        hostId,
        method: 'remote-download',
        phase: 'downloading',
        completedBytes: 2,
        totalBytes: 1
      }
    ]) {
      expect(() =>
        remoteEnvironmentUpdateProgressSchema.parse(progress)
      ).toThrow()
    }
  })

  it('validates strict directory browse requests and treats an omitted path as valid', () => {
    const hostId = '00000000-0000-4000-8000-000000000101'
    expect(
      sshDirectoryBrowseRequestSchema.parse({ hostId })
    ).toEqual({ hostId })
    expect(
      sshDirectoryBrowseRequestSchema.parse({
        hostId,
        path: '/home/builder'
      })
    ).toEqual({
      hostId,
      path: '/home/builder'
    })

    for (const input of [
      { hostId, path: '/home/builder/' },
      { hostId, path: '/home//builder' },
      { hostId, path: '/home/./builder' },
      { hostId, path: '/home/../builder' },
      { hostId, path: '/home/\u0000builder' },
      { hostId, path: `/${'界'.repeat(1_366)}` },
      { hostId, path: '/', command: 'pwd' }
    ]) {
      expect(() =>
        sshDirectoryBrowseRequestSchema.parse(input)
      ).toThrow()
    }
  })

  it('validates deterministic bounded directory browse results', () => {
    const result = {
      path: '/home/builder',
      homeDirectory: '/home/builder',
      parentPath: '/home',
      entries: [
        {
          name: 'alpha',
          path: '/home/builder/alpha'
        },
        {
          name: '资料',
          path: '/home/builder/资料'
        }
      ],
      truncated: false
    }
    expect(
      sshDirectoryBrowseResultSchema.parse(result)
    ).toEqual(result)
    expect(
      sshDirectoryBrowseResultSchema.parse({
        ...result,
        path: '/',
        parentPath: null,
        entries: []
      })
    ).toMatchObject({
      path: '/',
      parentPath: null
    })

    for (const invalid of [
      {
        ...result,
        parentPath: '/'
      },
      {
        ...result,
        entries: [...result.entries].reverse()
      },
      {
        ...result,
        entries: [result.entries[0], result.entries[0]]
      },
      {
        ...result,
        entries: [
          {
            name: 'elsewhere',
            path: '/tmp/elsewhere'
          }
        ]
      },
      {
        ...result,
        entries: [
          {
            name: '..',
            path: '/home'
          }
        ]
      },
      {
        ...result,
        entries: [],
        credential: 'secret'
      }
    ]) {
      expect(() =>
        sshDirectoryBrowseResultSchema.parse(invalid)
      ).toThrow()
    }
  })

  it('caps directory browse output at 500 entries', () => {
    const entries = Array.from(
      { length: SSH_DIRECTORY_BROWSE_LIMITS.maximumEntries + 1 },
      (_, index) => {
        const name = index.toString().padStart(3, '0')
        return {
          name,
          path: `/home/builder/${name}`
        }
      }
    )
    expect(() =>
      sshDirectoryBrowseResultSchema.parse({
        path: '/home/builder',
        homeDirectory: '/home/builder',
        parentPath: '/home',
        entries,
        truncated: true
      })
    ).toThrow()
  })
})
