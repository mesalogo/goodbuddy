import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupObsoleteInstallations } from './installation-cleanup'
import { DetachedAgentLifecycle } from './detached-agent-lifecycle'
import { LinuxProcessInspector } from './linux-process-identity'
import { SemanticPromptStore } from './semantic-prompt-store'
import { EventJournal } from './event-journal'
import { RuntimeOwnerRegistry } from './runtime-owner-registry'
import { writePrivateFileAtomic } from './managed-paths'
import type { VerifiedInstalledAgentBundle } from './installed-bundle-verifier'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodbuddy-upgrade-cleanup-'))
  roots.push(root)
  const agentRoot = join(root, 'agent')
  const paths = (id: string) => ({
    executablePath: join(agentRoot, 'installations', id, 'goodbuddy-agent'),
    stateDirectory: join(root, 'state', id),
    socketPath: join(root, `${id}.sock`)
  })
  const verified = (id: string) => ({
    installationId: id,
    installationDirectory: join(agentRoot, 'installations', id),
    executablePath: paths(id).executablePath,
    binaryDigest: `sha256:${'a'.repeat(64)}`,
    manifest: { protocol: { major: 2, minor: 0 }, entrypoint: { runtimePath: 'node' } }
  }) as VerifiedInstalledAgentBundle
  for (const id of ['current', 'candidate', 'old', 'older']) {
    mkdirSync(join(agentRoot, 'installations', id), { recursive: true, mode: 0o700 })
    const state = paths(id).stateDirectory
    mkdirSync(join(state, 'journal'), { recursive: true, mode: 0o700 })
    writePrivateFileAtomic(paths(id).executablePath, 'payload')
    new SemanticPromptStore(join(state, 'semantic-prompts.sqlite')).close()
    new EventJournal(join(state, 'journal', 'events.sqlite')).close()
    new RuntimeOwnerRegistry(join(state, 'runtime-owners.sqlite')).close()
    writePrivateFileAtomic(join(state, 'detached-lifecycle.json'), JSON.stringify({
      formatVersion: 1, installationId: id, binaryDigest: verified(id).binaryDigest,
      protocol: { major: 2, minor: 0 }, daemonBootId: 'old-boot', createdAt: 1,
      process: { pid: 123, starttime: '1', executablePath: join(agentRoot, 'installations', id, 'node') }
    }))
  }
  const entry = (installationId: string) => ({ installationId, agentVersion: '0.11.0', manifestSha256: 'a'.repeat(64), arch: 'x64' })
  const registryPath = join(agentRoot, 'registry.json')
  writePrivateFileAtomic(registryPath, JSON.stringify({ formatVersion: 1, current: entry('current'), candidate: entry('candidate') }))
  const inspector = new LinuxProcessInspector()
  vi.spyOn(inspector, 'matches').mockReturnValue(false)
  vi.spyOn(inspector, 'inspect').mockReturnValue({ pid: process.pid, starttime: '2', executablePath: process.execPath })
  const reconcile = vi.fn(async () => ({ inspected: 0, stopped: 0, conflicts: 0, unknown: 0 }))
  const options = {
    agentRoot, currentInstallationId: 'current', paths,
    verify: vi.fn(async (id: string) => verified(id)),
    createLifecycle: (input: ConstructorParameters<typeof DetachedAgentLifecycle>[0]) => new DetachedAgentLifecycle({ ...input, processInspector: inspector }),
    reconcile,
    payloadInUse: vi.fn(async () => false)
  }
  return { options, paths, root, registryPath, inspector, reconcile }
}

describe('obsolete installation cleanup', () => {
  it('reclaims all proven stopped obsolete payloads, preserves history/current/candidate, and repeats safely', async () => {
    const value = fixture()
    const history = join(value.paths('old').stateDirectory, 'semantic-prompts.sqlite')
    const before = readFileSync(history)
    const result = await cleanupObsoleteInstallations(value.options)
    expect(result.complete).toBe(true)
    expect(result.removed.sort()).toEqual(['old', 'older'])
    expect(readFileSync(history)).toEqual(before)
    expect(existsSync(value.paths('current').executablePath)).toBe(true)
    expect(existsSync(value.paths('candidate').executablePath)).toBe(true)
    expect(value.options.verify.mock.calls.flat().sort()).toEqual(['old', 'older'])
    await expect(cleanupObsoleteInstallations(value.options)).resolves.toEqual({ complete: true, removed: [], deferred: [] })
  })

  it('defers live legacy daemons even with no persisted operations or clients', async () => {
    const value = fixture()
    vi.mocked(value.inspector.matches).mockReturnValue(true)
    const result = await cleanupObsoleteInstallations(value.options)
    expect(result.removed).toEqual([])
    expect(result.deferred).toHaveLength(2)
    expect(result.deferred.every(item => item.reason === 'live-or-unproven-daemon-inactivity')).toBe(true)
    expect(value.reconcile).not.toHaveBeenCalled()
  })

  it.each(['starting', 'running', 'outcome-unknown', 'unacknowledged', 'missing', 'raw-channel'])(
    'preserves %s work without modifying its authority', async state => {
      const value = fixture()
      const directory = value.paths('old').stateDirectory
      const path = join(directory, 'semantic-prompts.sqlite')
      if (state === 'missing') rmSync(path)
      else if (state === 'raw-channel') {
        const db = new DatabaseSync(join(directory, 'journal', 'events.sqlite'))
        db.exec("INSERT INTO acp_channels (binding_id, channel_epoch, direction, controller_id) VALUES ('b', 1, 'main-to-runtime', 'c')")
        db.close()
      } else {
        const store = new SemanticPromptStore(path)
        store.prepare({ bindingId: 'b', operationId: 'o', requestId: 'r', controllerId: 'c', preparationDigest: 'd', promptSequence: 0 })
        store.close()
        const db = new DatabaseSync(path)
        db.prepare('UPDATE semantic_prompt_operations SET state = ?, latest_sequence = 1').run(state === 'unacknowledged' ? 'completed' : state)
        db.close()
      }
      const result = await cleanupObsoleteInstallations(value.options)
      expect(result.deferred).toContainEqual({ installationId: 'old', reason: 'active-or-unproven-work' })
      expect(existsSync(value.paths('old').executablePath)).toBe(true)
      if (state !== 'missing' && state !== 'raw-channel') {
        const db = new DatabaseSync(path, { readOnly: true })
        expect(db.prepare('SELECT state FROM semantic_prompt_operations').get()?.state).toBe(state === 'unacknowledged' ? 'completed' : state)
        db.close()
      }
    }
  )

  it('retains payloads after uncertain orphan reconciliation and retries later', async () => {
    const value = fixture()
    value.reconcile.mockResolvedValue({ inspected: 1, stopped: 0, conflicts: 0, unknown: 1 })
    const result = await cleanupObsoleteInstallations(value.options)
    expect(result.complete).toBe(false)
    expect(result.removed).toEqual([])
    value.reconcile.mockResolvedValue({ inspected: 0, stopped: 0, conflicts: 0, unknown: 0 })
    expect((await cleanupObsoleteInstallations(value.options)).removed).toHaveLength(2)
  })

  it('does not reinterpret an owner reservation as an empty process tree', async () => {
    const value = fixture()
    const owners = new RuntimeOwnerRegistry(join(value.paths('old').stateDirectory, 'runtime-owners.sqlite'))
    owners.reserve({ ownerId: 'pending', launchId: 'pending', processId: 'pending', installationId: 'old', ownerToken: 'a'.repeat(32) })
    owners.close()
    const result = await cleanupObsoleteInstallations(value.options)
    expect(result.deferred).toContainEqual({ installationId: 'old', reason: 'runtime-ownership-unproven' })
    expect(existsSync(value.paths('old').executablePath)).toBe(true)
    expect(value.reconcile).toHaveBeenCalledOnce()
  })

  it('rechecks registry promotion before deleting a payload', async () => {
    const value = fixture()
    value.options.payloadInUse.mockImplementation(async () => {
      const registry = JSON.parse(readFileSync(value.registryPath, 'utf8'))
      registry.candidate.installationId = 'old'
      writePrivateFileAtomic(value.registryPath, JSON.stringify(registry))
      return false
    })
    const result = await cleanupObsoleteInstallations(value.options)
    expect(result.removed).toEqual([])
    expect(result.deferred.every(item => item.reason === 'registry-changed')).toBe(true)
    expect(existsSync(value.paths('old').executablePath)).toBe(true)
  })

  it('does not prune when verification, lifecycle evidence, process inspection, or registry identity is uncertain', async () => {
    const value = fixture()
    value.options.payloadInUse.mockResolvedValue(true)
    expect((await cleanupObsoleteInstallations(value.options)).removed).toEqual([])
    value.options.payloadInUse.mockResolvedValue(false)
    rmSync(join(value.paths('old').stateDirectory, 'detached-lifecycle.json'))
    value.options.verify.mockImplementation(async () => { throw new Error('invalid-signature') })
    expect((await cleanupObsoleteInstallations(value.options)).removed).toEqual([])
    await expect(cleanupObsoleteInstallations({ ...value.options, currentInstallationId: 'older' })).rejects.toThrow('current Agent')
  })
})
