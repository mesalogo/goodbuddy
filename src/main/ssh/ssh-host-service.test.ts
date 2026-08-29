import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsCredentialCipher } from '../settings-credential-cipher'
import {
  SshHostService,
  type SshHostLifecycleHooks
} from './ssh-host-service'
import { SshHostStore } from './ssh-host-store'
import type {
  SshHostKeyCandidate,
  SshTransport
} from './ssh-transport'

const roots: string[] = []
const keyA: SshHostKeyCandidate = {
  algorithm: 'ssh-ed25519',
  publicKeyBase64: Buffer.from('key-a').toString('base64'),
  fingerprintSha256: `SHA256:${'A'.repeat(43)}`
}
const keyB: SshHostKeyCandidate = {
  algorithm: 'ssh-ed25519',
  publicKeyBase64: Buffer.from('key-b').toString('base64'),
  fingerprintSha256: `SHA256:${'B'.repeat(43)}`
}
const decrypt = vi.fn((value: Buffer) => value.toString())
const cipher: SettingsCredentialCipher = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(value),
  decrypt
}
const newPasswordHost = {
  name: 'Build host',
  hostname: 'build.example.com',
  port: 22,
  username: 'builder',
  authentication: 'password' as const,
  password: {
    action: 'replace' as const,
    value: 'private password'
  }
}

async function createHarness(
  now = 1_000,
  lifecycleHooks: SshHostLifecycleHooks = {}
): Promise<{
  service: SshHostService
  store: SshHostStore
  inspectHostKey: ReturnType<typeof vi.fn>
  testConnection: ReturnType<typeof vi.fn>
  setNow: (value: number) => void
}> {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-ssh-service-'))
  roots.push(root)
  const store = new SshHostStore(join(root, 'ssh-hosts.json'), cipher)
  const inspectHostKey = vi.fn(async () => keyA)
  const testConnection = vi.fn(async () => ({
    connected: true as const,
    latencyMs: 12,
    platform: 'linux' as const,
    architecture: 'x64' as const,
    shell: '/bin/bash',
    homeDirectory: '/home/builder',
    detail: 'SSH 已连接，远端系统为 linux/x64'
  }))
  const transport: SshTransport = {
    inspectHostKey,
    testConnection
  }
  return {
    service: new SshHostService(
      store,
      transport,
      () => now,
      lifecycleHooks
    ),
    store,
    inspectHostKey,
    testConnection,
    setNow: (value) => {
      now = value
    }
  }
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('SshHostService', () => {
  it('inspects a new draft before authentication without persisting it', async () => {
    const harness = await createHarness()

    const inspection = await harness.service.inspectDraftHostKey({
      hostname: newPasswordHost.hostname,
      port: newPasswordHost.port,
      username: newPasswordHost.username
    })

    expect(inspection).toMatchObject({
      state: 'unverified',
      algorithm: keyA.algorithm,
      fingerprintSha256: keyA.fingerprintSha256
    })
    expect(inspection.candidateId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    )
    expect(harness.inspectHostKey).toHaveBeenCalledWith({
      hostname: 'build.example.com',
      port: 22,
      username: 'builder'
    })
    expect(harness.testConnection).not.toHaveBeenCalled()
    await expect(harness.service.getSnapshot()).resolves.toMatchObject({
      hosts: []
    })

    await expect(
      harness.service.validateAndSave({
        candidateId: inspection.candidateId,
        fingerprintSha256: keyB.fingerprintSha256,
        input: newPasswordHost
      })
    ).rejects.toThrow('指纹不匹配')
    await expect(harness.service.getSnapshot()).resolves.toMatchObject({
      hosts: []
    })

    harness.setNow(301_000)
    await expect(
      harness.service.validateAndSave({
        candidateId: inspection.candidateId,
        fingerprintSha256: keyA.fingerprintSha256,
        input: newPasswordHost
      })
    ).rejects.toThrow('已过期')
  })

  it('persists a host only after authentication and the probe succeed', async () => {
    const harness = await createHarness()
    const inspection = await harness.service.inspectDraftHostKey({
      hostname: newPasswordHost.hostname,
      port: newPasswordHost.port,
      username: newPasswordHost.username
    })
    harness.testConnection
      .mockRejectedValueOnce(new Error('SSH 认证失败'))
      .mockResolvedValueOnce({
        connected: true,
        latencyMs: 12,
        platform: 'linux',
        architecture: 'x64',
        shell: '/bin/bash',
        homeDirectory: '/home/builder',
        detail: 'SSH 已连接，远端系统为 linux/x64'
      })

    await expect(
      harness.service.validateAndSave({
        candidateId: inspection.candidateId,
        fingerprintSha256: keyA.fingerprintSha256,
        input: newPasswordHost
      })
    ).rejects.toThrow('SSH 认证失败')
    await expect(harness.service.getSnapshot()).resolves.toMatchObject({
      hosts: []
    })

    const result = await harness.service.validateAndSave({
      candidateId: inspection.candidateId,
      fingerprintSha256: keyA.fingerprintSha256,
      input: {
        ...newPasswordHost,
        password: {
          action: 'replace',
          value: 'corrected password'
        }
      }
    })

    expect(result).toMatchObject({
      host: {
        name: 'Build host',
        hostKey: {
          state: 'verified',
          fingerprintSha256: keyA.fingerprintSha256,
          generation: 1
        }
      },
      connection: {
        connected: true,
        platform: 'linux'
      }
    })
    expect(result.connection.hostId).toBe(result.host.id)
    expect(harness.testConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        password: 'corrected password',
        hostKey: keyA
      })
    )
    expect(JSON.stringify(await harness.service.getSnapshot())).not.toContain(
      'corrected password'
    )
  })

  it('binds candidates to the inspected target and discards them on request', async () => {
    const harness = await createHarness()
    const inspection = await harness.service.inspectDraftHostKey({
      hostname: newPasswordHost.hostname,
      port: newPasswordHost.port,
      username: newPasswordHost.username
    })

    await expect(
      harness.service.validateAndSave({
        candidateId: inspection.candidateId,
        fingerprintSha256: keyA.fingerprintSha256,
        input: {
          ...newPasswordHost,
          hostname: 'other.example.com'
        }
      })
    ).rejects.toThrow('配置已变化')
    expect(harness.testConnection).not.toHaveBeenCalled()

    harness.service.discardCandidate(inspection.candidateId)
    await expect(
      harness.service.validateAndSave({
        candidateId: inspection.candidateId,
        fingerprintSha256: keyA.fingerprintSha256,
        input: newPasswordHost
      })
    ).rejects.toThrow('重新检查')
  })

  it('supersedes older candidates for the same draft target', async () => {
    const harness = await createHarness()
    const first = await harness.service.inspectDraftHostKey({
      hostname: newPasswordHost.hostname,
      port: newPasswordHost.port,
      username: newPasswordHost.username
    })
    const second = await harness.service.inspectDraftHostKey({
      hostname: newPasswordHost.hostname,
      port: newPasswordHost.port,
      username: newPasswordHost.username
    })

    await expect(
      harness.service.validateAndSave({
        candidateId: first.candidateId,
        fingerprintSha256: keyA.fingerprintSha256,
        input: newPasswordHost
      })
    ).rejects.toThrow('重新检查')
    await expect(
      harness.service.validateAndSave({
        candidateId: second.candidateId,
        fingerprintSha256: keyA.fingerprintSha256,
        input: newPasswordHost
      })
    ).resolves.toMatchObject({
      host: { name: 'Build host' }
    })
    expect(harness.testConnection).toHaveBeenCalledOnce()
  })

  it('rejects duplicate in-flight inspections for the same target', async () => {
    const harness = await createHarness()
    let finishInspection:
      | ((candidate: SshHostKeyCandidate) => void)
      | undefined
    harness.inspectHostKey.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishInspection = resolve
        })
    )
    const request = {
      hostname: newPasswordHost.hostname,
      port: newPasswordHost.port,
      username: newPasswordHost.username
    }
    const first = harness.service.inspectDraftHostKey(request)
    await vi.waitFor(() =>
      expect(harness.inspectHostKey).toHaveBeenCalledOnce()
    )

    await expect(
      harness.service.inspectDraftHostKey(request)
    ).rejects.toThrow('正在检查')
    finishInspection?.(keyA)
    await expect(first).resolves.toMatchObject({
      fingerprintSha256: keyA.fingerprintSha256
    })
  })

  it('classifies changed keys and atomically replaces a validated edit', async () => {
    const harness = await createHarness()
    const host = await harness.store.commitValidated({
      input: {
        name: 'Build host',
        hostname: 'build.example.com',
        port: 22,
        username: 'builder',
        authentication: 'password',
        password: {
          action: 'replace',
          value: 'private password'
        }
      },
      hostKey: keyA
    })
    const decryptionsBeforeInspection = decrypt.mock.calls.length
    harness.inspectHostKey.mockResolvedValueOnce(keyB)

    const inspection = await harness.service.inspectDraftHostKey({
      hostId: host.id,
      hostname: 'build.example.com',
      port: 22,
      username: 'builder'
    })

    expect(inspection).toMatchObject({
      hostId: host.id,
      state: 'changed',
      fingerprintSha256: keyB.fingerprintSha256,
      previousHostKey: {
        algorithm: keyA.algorithm,
        fingerprintSha256: keyA.fingerprintSha256
      }
    })
    expect(decrypt).toHaveBeenCalledTimes(decryptionsBeforeInspection)
    const resolveConnectionTarget = vi.spyOn(
      harness.store,
      'resolveConnectionTarget'
    )
    const result = await harness.service.validateAndSave({
      candidateId: inspection.candidateId,
      fingerprintSha256: keyB.fingerprintSha256,
      input: {
        ...newPasswordHost,
        name: 'Renamed host',
        password: { action: 'keep' }
      }
    })

    expect(result.host).toMatchObject({
      id: host.id,
      name: 'Renamed host',
      hostKey: {
        state: 'verified',
        fingerprintSha256: keyB.fingerprintSha256,
        generation: 2
      }
    })
    expect(harness.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: host.id,
        password: 'private password',
        hostKey: keyB
      })
    )
    expect(resolveConnectionTarget).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'hostname',
      {
        hostname: 'moved.example.com'
      }
    ],
    [
      'port',
      {
        port: 2222
      }
    ],
    [
      'username',
      {
        username: 'deployer'
      }
    ],
    [
      'authentication',
      {
        authentication: 'system-agent' as const
      }
    ]
  ])(
    'rejects credential keep before resolution when %s changes',
    async (_field, change) => {
      const harness = await createHarness()
      const host = await harness.store.commitValidated({
        input: newPasswordHost,
        hostKey: keyA
      })
      const draft = {
        hostname: newPasswordHost.hostname,
        port: newPasswordHost.port,
        username: newPasswordHost.username,
        ...change
      }
      const inspection =
        await harness.service.inspectDraftHostKey({
          hostId: host.id,
          hostname: draft.hostname,
          port: draft.port,
          username: draft.username
        })
      const resolveConnectionTarget = vi.spyOn(
        harness.store,
        'resolveConnectionTarget'
      )

      await expect(
        harness.service.validateAndSave({
          candidateId: inspection.candidateId,
          fingerprintSha256: keyA.fingerprintSha256,
          input: {
            ...newPasswordHost,
            ...change,
            password: { action: 'keep' }
          }
        })
      ).rejects.toThrow(
        '地址、端口、用户名或认证方式已变化'
      )
      expect(resolveConnectionTarget).toHaveBeenCalledOnce()
      expect(harness.testConnection).not.toHaveBeenCalled()
    }
  )

  it('allows credential keep when target and authentication are unchanged', async () => {
    const harness = await createHarness()
    const host = await harness.store.commitValidated({
      input: newPasswordHost,
      hostKey: keyA
    })
    const inspection = await harness.service.inspectDraftHostKey({
      hostId: host.id,
      hostname: host.hostname,
      port: host.port,
      username: host.username
    })
    const resolveConnectionTarget = vi.spyOn(
      harness.store,
      'resolveConnectionTarget'
    )

    await expect(
      harness.service.validateAndSave({
        candidateId: inspection.candidateId,
        fingerprintSha256: keyA.fingerprintSha256,
        input: {
          ...newPasswordHost,
          name: 'Renamed host',
          password: { action: 'keep' }
        }
      })
    ).resolves.toMatchObject({
      host: {
        id: host.id,
        name: 'Renamed host'
      }
    })
    expect(resolveConnectionTarget).toHaveBeenCalledOnce()
    expect(harness.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        authentication: 'password',
        password: 'private password'
      })
    )
  })

  it('rejects an edit when the durable host changes after inspection', async () => {
    const harness = await createHarness()
    const host = await harness.store.commitValidated({
      input: {
        name: 'Build host',
        hostname: 'build.example.com',
        port: 22,
        username: 'builder',
        authentication: 'system-agent',
        password: { action: 'clear' }
      },
      hostKey: keyA
    })
    const inspection = await harness.service.inspectDraftHostKey({
      hostId: host.id,
      hostname: host.hostname,
      port: host.port,
      username: host.username
    })
    const identity = await harness.store.getHostIdentity(host.id)
    await harness.store.commitValidated({
      hostId: host.id,
      expectedRevision: identity.revision,
      input: {
        name: 'Changed elsewhere',
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        authentication: 'system-agent',
        password: { action: 'clear' }
      },
      hostKey: keyA
    })

    await expect(
      harness.service.validateAndSave({
        candidateId: inspection.candidateId,
        fingerprintSha256: keyA.fingerprintSha256,
        input: {
          name: 'Stale edit',
          hostname: host.hostname,
          port: host.port,
          username: host.username,
          authentication: 'system-agent',
          password: { action: 'clear' }
        }
      })
    ).rejects.toThrow('配置已变化')
    expect(harness.testConnection).not.toHaveBeenCalled()
  })

  it('validates target edits against the draft before replacing the durable host', async () => {
    const harness = await createHarness()
    const host = await harness.store.commitValidated({
      input: {
        name: 'Build host',
        hostname: 'build.example.com',
        port: 22,
        username: 'builder',
        authentication: 'password',
        password: {
          action: 'replace',
          value: 'old password'
        }
      },
      hostKey: keyA
    })
    harness.inspectHostKey.mockResolvedValueOnce(keyB)
    const inspection = await harness.service.inspectDraftHostKey({
      hostId: host.id,
      hostname: 'moved.example.com',
      port: 2222,
      username: 'deployer'
    })

    expect(inspection).toMatchObject({
      state: 'unverified',
      fingerprintSha256: keyB.fingerprintSha256
    })
    const result = await harness.service.validateAndSave({
      candidateId: inspection.candidateId,
      fingerprintSha256: keyB.fingerprintSha256,
      input: {
        name: 'Moved host',
        hostname: 'moved.example.com',
        port: 2222,
        username: 'deployer',
        authentication: 'password',
        password: {
          action: 'replace',
          value: 'new password'
        }
      }
    })

    expect(result.host).toMatchObject({
      id: host.id,
      hostname: 'moved.example.com',
      port: 2222,
      username: 'deployer',
      hostKey: {
        fingerprintSha256: keyB.fingerprintSha256,
        generation: 2
      }
    })
    expect(harness.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'moved.example.com',
        port: 2222,
        username: 'deployer',
        password: 'new password'
      })
    )
  })

  it('fires credential-free lifecycle hooks only after successful edit and removal commits', async () => {
    const onHostEdited = vi.fn()
    const onHostRemoved = vi.fn()
    const harness = await createHarness(1_000, {
      onHostEdited,
      onHostRemoved
    })
    const host = await harness.store.commitValidated({
      input: newPasswordHost,
      hostKey: keyA
    })
    const inspection = await harness.service.inspectDraftHostKey({
      hostId: host.id,
      hostname: host.hostname,
      port: host.port,
      username: host.username
    })
    harness.testConnection.mockRejectedValueOnce(
      new Error('SSH 认证失败')
    )

    await expect(
      harness.service.validateAndSave({
        candidateId: inspection.candidateId,
        fingerprintSha256: keyA.fingerprintSha256,
        input: {
          ...newPasswordHost,
          name: 'Renamed host',
          password: { action: 'keep' }
        }
      })
    ).rejects.toThrow('SSH 认证失败')
    expect(onHostEdited).not.toHaveBeenCalled()
    expect(onHostRemoved).not.toHaveBeenCalled()

    await harness.service.validateAndSave({
      candidateId: inspection.candidateId,
      fingerprintSha256: keyA.fingerprintSha256,
      input: {
        ...newPasswordHost,
        name: 'Renamed host',
        password: { action: 'keep' }
      }
    })

    expect(onHostEdited).toHaveBeenCalledWith(host.id)
    expect(onHostEdited.mock.calls[0]).toEqual([host.id])
    expect(onHostRemoved).not.toHaveBeenCalled()

    await expect(
      harness.service.remove(host.id, async () => {
        throw new Error('project cleanup failed')
      })
    ).rejects.toThrow('project cleanup failed')
    await expect(harness.service.getSnapshot()).resolves.toMatchObject({
      hosts: [expect.objectContaining({ id: host.id })]
    })
    expect(onHostRemoved).not.toHaveBeenCalled()

    await harness.service.remove(host.id)

    expect(onHostRemoved).toHaveBeenCalledWith(host.id)
    expect(onHostRemoved.mock.calls[0]).toEqual([host.id])
    await expect(
      harness.service.remove(host.id)
    ).rejects.toThrow('不存在')
    expect(onHostRemoved).toHaveBeenCalledOnce()
  })

  it('bounds the number of pending host-key candidates', async () => {
    const harness = await createHarness()
    for (let index = 0; index < 100; index += 1) {
      await harness.service.inspectDraftHostKey({
        hostname: `build-${index}.example.com`,
        port: 22,
        username: 'builder'
      })
    }

    await expect(
      harness.service.inspectDraftHostKey({
        hostname: 'one-too-many.example.com',
        port: 22,
        username: 'builder'
      })
    ).rejects.toThrow('检查过多')
    expect(harness.inspectHostKey).toHaveBeenCalledTimes(100)
  })

  it('allows only one validation to consume a candidate', async () => {
    const harness = await createHarness()
    const inspection = await harness.service.inspectDraftHostKey({
      hostname: newPasswordHost.hostname,
      port: newPasswordHost.port,
      username: newPasswordHost.username
    })
    let finishConnection:
      | ((result: {
          connected: true
          latencyMs: number
          platform: 'linux'
          architecture: 'x64'
          shell: string
          homeDirectory: string
          detail: string
        }) => void)
      | undefined
    harness.testConnection.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishConnection = resolve
        })
    )
    const request = {
      candidateId: inspection.candidateId,
      fingerprintSha256: keyA.fingerprintSha256,
      input: newPasswordHost
    }
    const first = harness.service.validateAndSave(request)
    await vi.waitFor(() =>
      expect(harness.testConnection).toHaveBeenCalledOnce()
    )

    await expect(
      harness.service.validateAndSave(request)
    ).rejects.toThrow('正在验证')
    finishConnection?.({
      connected: true,
      latencyMs: 12,
      platform: 'linux',
      architecture: 'x64',
      shell: '/bin/bash',
      homeDirectory: '/home/builder',
      detail: 'SSH 已连接，远端系统为 linux/x64'
    })
    await expect(first).resolves.toMatchObject({
      host: { name: 'Build host' }
    })
    await expect(harness.service.getSnapshot()).resolves.toMatchObject({
      hosts: [{ name: 'Build host' }]
    })
  })
})
