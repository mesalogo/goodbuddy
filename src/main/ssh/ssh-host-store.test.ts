import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SshHost,
  SshHostUpdateInput
} from '../../shared/ssh-host-contracts'
import type { SettingsCredentialCipher } from '../settings-credential-cipher'
import {
  SshHostStore,
  type ValidatedSshHostCommit
} from './ssh-host-store'

const roots: string[] = []
const fingerprintA = `SHA256:${'A'.repeat(43)}`
const fingerprintB = `SHA256:${'B'.repeat(43)}`
const keyA = {
  algorithm: 'ssh-ed25519',
  publicKeyBase64: Buffer.from('first-key').toString('base64'),
  fingerprintSha256: fingerprintA
}
const keyB = {
  algorithm: 'ssh-ed25519',
  publicKeyBase64: Buffer.from('second-key').toString('base64'),
  fingerprintSha256: fingerprintB
}

function createCipher(available = true): SettingsCredentialCipher {
  return {
    isAvailable: () => available,
    encrypt: (value) =>
      Buffer.from(
        `protected:${Buffer.from(value).toString('base64')}`
      ),
    decrypt: (value) =>
      Buffer.from(
        value.toString().replace(/^protected:/u, ''),
        'base64'
      ).toString()
  }
}

async function createHarness(
  cipher = createCipher()
): Promise<{
  filePath: string
  store: SshHostStore
}> {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-ssh-hosts-'))
  roots.push(root)
  const filePath = join(root, 'ssh-hosts.json')
  return {
    filePath,
    store: new SshHostStore(filePath, cipher)
  }
}

function passwordHostInput(
  overrides: Partial<SshHostUpdateInput> = {}
): SshHostUpdateInput {
  return {
    name: 'Build host',
    hostname: 'build.example.com',
    port: 22,
    username: 'builder',
    authentication: 'password',
    password: {
      action: 'replace',
      value: 'private password'
    },
    ...overrides
  }
}

async function updateValidated(
  store: SshHostStore,
  host: SshHost,
  input: SshHostUpdateInput,
  hostKey: ValidatedSshHostCommit['hostKey'] = keyA
): Promise<SshHost> {
  const identity = await store.getHostIdentity(host.id)
  return store.commitValidated({
    hostId: host.id,
    expectedRevision: identity.revision,
    input,
    hostKey
  })
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('SshHostStore', () => {
  it('atomically creates a validated host with an encrypted credential and pinned key', async () => {
    const { filePath, store } = await createHarness()

    const created = await store.commitValidated({
      input: passwordHostInput(),
      hostKey: keyA
    })

    expect(created).toMatchObject({
      credentialConfigured: true,
      credentialSource: 'encrypted',
      hostKey: {
        state: 'verified',
        fingerprintSha256: fingerprintA,
        generation: 1
      },
      lastValidatedAt: expect.any(String)
    })
    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).not.toContain('private password')
    expect(persisted).toContain(fingerprintA)
    expect(JSON.stringify(created)).not.toContain('ciphertextBase64')
    await expect(store.resolveHost(created.id)).resolves.toMatchObject({
      password: 'private password',
      hostKey: {
        fingerprintSha256: fingerprintA
      }
    })
  })

  it('resolves one atomic connection target snapshot with credentials and generations', async () => {
    const { store } = await createHarness()
    const created = await store.commitValidated({
      input: passwordHostInput(),
      hostKey: keyA
    })
    const identity = await store.getHostIdentity(created.id)

    const targetPromise = store.resolveConnectionTarget(created.id)
    const editPromise = store.commitValidated({
      hostId: created.id,
      expectedRevision: identity.revision,
      input: passwordHostInput({
        password: {
          action: 'replace',
          value: 'rotated password'
        }
      }),
      hostKey: keyB
    })

    await expect(targetPromise).resolves.toMatchObject({
      host: {
        id: created.id,
        password: 'private password',
        hostKey: {
          fingerprintSha256: fingerprintA,
          generation: 1
        }
      },
      hostRevision: 1,
      hostKeyGeneration: 1
    })
    await expect(editPromise).resolves.toMatchObject({
      hostKey: {
        fingerprintSha256: fingerprintB,
        generation: 2
      }
    })
    await expect(
      store.resolveConnectionTarget(created.id)
    ).resolves.toMatchObject({
      host: {
        password: 'rotated password',
        hostKey: {
          fingerprintSha256: fingerprintB,
          generation: 2
        }
      },
      hostRevision: 2,
      hostKeyGeneration: 2
    })
  })

  it('reuses credential validation across unchanged public snapshots', async () => {
    const baseCipher = createCipher()
    const decrypt = vi.fn(baseCipher.decrypt)
    const { store } = await createHarness({
      ...baseCipher,
      decrypt
    })
    await store.commitValidated({
      input: passwordHostInput(),
      hostKey: keyA
    })
    const decryptionsAfterCommit = decrypt.mock.calls.length

    await store.getSnapshot()
    await store.getSnapshot()

    expect(decrypt).toHaveBeenCalledTimes(decryptionsAfterCommit)
  })

  it('keeps or replaces credentials only through validated edits', async () => {
    const { store } = await createHarness()
    const created = await store.commitValidated({
      input: passwordHostInput(),
      hostKey: keyA
    })
    const renamed = await updateValidated(
      store,
      created,
      passwordHostInput({
        name: 'Renamed host',
        password: { action: 'keep' }
      })
    )

    expect(renamed).toMatchObject({
      name: 'Renamed host',
      hostKey: {
        fingerprintSha256: fingerprintA,
        generation: 1
      }
    })
    await expect(store.resolveHost(created.id)).resolves.toMatchObject({
      password: 'private password'
    })

    const identity = await store.getHostIdentity(created.id)
    await expect(
      store.commitValidated({
        hostId: created.id,
        expectedRevision: identity.revision,
        input: passwordHostInput({
          hostname: 'moved.example.com',
          password: { action: 'keep' }
        }),
        hostKey: keyB
      })
    ).rejects.toThrow('重新输入密码')

    const moved = await updateValidated(
      store,
      renamed,
      passwordHostInput({
        name: 'Moved host',
        hostname: 'moved.example.com',
        password: {
          action: 'replace',
          value: 'second password'
        }
      }),
      keyB
    )
    expect(moved).toMatchObject({
      hostname: 'moved.example.com',
      hostKey: {
        fingerprintSha256: fingerprintB,
        generation: 2
      }
    })
    await expect(store.resolveHost(created.id)).resolves.toMatchObject({
      password: 'second password'
    })
  })

  it('rejects stale validated edits with a monotonic revision', async () => {
    const { store } = await createHarness()
    const created = await store.commitValidated({
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
    const identity = await store.getHostIdentity(created.id)
    await store.commitValidated({
      hostId: created.id,
      expectedRevision: identity.revision,
      input: {
        name: 'First edit',
        hostname: created.hostname,
        port: created.port,
        username: created.username,
        authentication: 'system-agent',
        password: { action: 'clear' }
      },
      hostKey: keyA
    })

    await expect(
      store.commitValidated({
        hostId: created.id,
        expectedRevision: identity.revision,
        input: {
          name: 'Stale edit',
          hostname: created.hostname,
          port: created.port,
          username: created.username,
          authentication: 'system-agent',
          password: { action: 'clear' }
        },
        hostKey: keyA
      })
    ).rejects.toThrow('配置已变化')
  })

  it('binds encrypted credentials to the host id', async () => {
    const { filePath, store } = await createHarness()
    const first = await store.commitValidated({
      input: passwordHostInput({
        name: 'First',
        hostname: 'first.example.com',
        password: { action: 'replace', value: 'first secret' }
      }),
      hostKey: keyA
    })
    const second = await store.commitValidated({
      input: passwordHostInput({
        name: 'Second',
        hostname: 'second.example.com',
        password: { action: 'replace', value: 'second secret' }
      }),
      hostKey: keyA
    })
    const persisted = JSON.parse(
      await readFile(filePath, 'utf8')
    ) as {
      hosts: Array<{
        id: string
        credential?: unknown
      }>
    }
    persisted.hosts[1]!.credential = persisted.hosts[0]!.credential
    await writeFile(filePath, JSON.stringify(persisted), 'utf8')

    const reloaded = new SshHostStore(filePath, createCipher())
    const snapshot = await reloaded.getSnapshot()
    expect(
      snapshot.hosts.find((host) => host.id === first.id)
    ).toMatchObject({ credentialSource: 'encrypted' })
    expect(
      snapshot.hosts.find((host) => host.id === second.id)
    ).toMatchObject({
      credentialConfigured: false,
      credentialSource: 'unreadable'
    })
    await expect(reloaded.resolveHost(second.id)).rejects.toThrow(
      '不匹配'
    )
  })

  it('binds encrypted credentials to the target address and username', async () => {
    const { filePath, store } = await createHarness()
    const created = await store.commitValidated({
      input: passwordHostInput(),
      hostKey: keyA
    })
    const persisted = JSON.parse(
      await readFile(filePath, 'utf8')
    ) as {
      hosts: Array<{
        hostname: string
      }>
    }
    persisted.hosts[0]!.hostname = 'attacker.example.com'
    await writeFile(filePath, JSON.stringify(persisted), 'utf8')

    const reloaded = new SshHostStore(filePath, createCipher())
    await expect(reloaded.getSnapshot()).resolves.toMatchObject({
      hosts: [
        expect.objectContaining({
          id: created.id,
          credentialConfigured: false,
          credentialSource: 'unreadable'
        })
      ]
    })
    await expect(reloaded.resolveHost(created.id)).rejects.toThrow(
      '不匹配'
    )
  })

  it('increments host-key generations only for new key material or targets', async () => {
    const { store } = await createHarness()
    const created = await store.commitValidated({
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
    const same = await updateValidated(
      store,
      created,
      {
        name: 'Build host',
        hostname: 'build.example.com',
        port: 22,
        username: 'builder',
        authentication: 'system-agent',
        password: { action: 'clear' }
      },
      keyA
    )
    const changed = await updateValidated(
      store,
      same,
      {
        name: 'Build host',
        hostname: 'build.example.com',
        port: 22,
        username: 'builder',
        authentication: 'system-agent',
        password: { action: 'clear' }
      },
      keyB
    )
    const moved = await updateValidated(
      store,
      changed,
      {
        name: 'Build host',
        hostname: 'moved.example.com',
        port: 22,
        username: 'builder',
        authentication: 'system-agent',
        password: { action: 'clear' }
      },
      keyB
    )

    expect(created.hostKey.generation).toBe(1)
    expect(same.hostKey.generation).toBe(1)
    expect(changed.hostKey.generation).toBe(2)
    expect(moved.hostKey.generation).toBe(3)
  })

  it('loads legacy revision-zero hosts and requires guided revalidation', async () => {
    const { filePath } = await createHarness()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        hosts: [
          {
            id: '00000000-0000-4000-8000-000000000121',
            name: 'Legacy host',
            hostname: 'legacy.example.com',
            port: 22,
            username: 'builder',
            authentication: 'system-agent',
            hostKey: {
              ...keyA,
              acceptedAt: '2026-08-01T00:00:00.000Z',
              generation: 1
            },
            hostKeyGeneration: 1,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z'
          }
        ]
      }),
      'utf8'
    )
    const store = new SshHostStore(filePath, createCipher())

    const snapshot = await store.getSnapshot()
    expect(snapshot).toMatchObject({
      hosts: [{ name: 'Legacy host', hostKey: { state: 'verified' } }]
    })
    expect(snapshot.hosts[0]).not.toHaveProperty('lastValidatedAt')
    await expect(
      store.getHostIdentity('00000000-0000-4000-8000-000000000121')
    ).resolves.toMatchObject({ revision: 0 })
  })

  it('requires secure storage for passwords and isolates corrupt settings', async () => {
    const unavailable = await createHarness(createCipher(false))
    await expect(
      unavailable.store.commitValidated({
        input: passwordHostInput({
          password: { action: 'replace', value: 'secret' }
        }),
        hostKey: keyA
      })
    ).rejects.toThrow('安全存储不可用')

    const { filePath } = await createHarness()
    await writeFile(filePath, '{invalid-json', 'utf8')
    const recovered = new SshHostStore(filePath, createCipher())
    await expect(recovered.getSnapshot()).resolves.toMatchObject({
      hosts: []
    })
    expect(
      (await readdir(join(filePath, '..'))).some((name) =>
        name.startsWith('ssh-hosts.json.corrupt-')
      )
    ).toBe(true)
  })

  it('asserts a loaded current target synchronously without resolving credentials', async () => {
    const { store } = await createHarness()
    expect(() =>
      store.assertConnectionTargetCurrent({
        hostId: '00000000-0000-4000-8000-000000000001',
        hostRevision: 1,
        hostKeyGeneration: 1,
        username: 'builder'
      })
    ).toThrow('尚未加载')

    const created = await store.commitValidated({
      input: passwordHostInput(),
      hostKey: keyA
    })
    const target = await store.resolveConnectionTarget(created.id)
    const current = {
      hostId: created.id,
      hostRevision: target.hostRevision,
      hostKeyGeneration: target.hostKeyGeneration,
      username: target.host.username
    }
    expect(() =>
      store.assertConnectionTargetCurrent(current)
    ).not.toThrow()
    expect(() =>
      store.assertConnectionTargetCurrent({
        ...current,
        hostRevision: current.hostRevision + 1
      })
    ).toThrow('配置已变化')
    expect(() =>
      store.assertConnectionTargetCurrent({
        ...current,
        username: 'other-user'
      })
    ).toThrow('配置已变化')
  })
})
