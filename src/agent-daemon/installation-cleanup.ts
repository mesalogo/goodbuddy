import { readdirSync, rmSync, statSync } from 'node:fs'
import { readdir, readlink } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { installationRegistryIdSchema, parseInstallationRegistryState } from '../shared/remote-environment-registry-contracts'
import { DetachedAgentLifecycle, type DetachedAgentLifecycleOptions } from './detached-agent-lifecycle'
import { reconcileOrphanedDirectLinuxStdioProcesses } from './direct-linux-stdio-process-owner'
import type { VerifiedInstalledAgentBundle } from './installed-bundle-verifier'
import { assertPrivateRegularFile, ensurePrivateDirectory, readPrivateFile } from './managed-paths'
import { RuntimeOwnerRegistry } from './runtime-owner-registry'

export type InstallationCleanupResult = {
  complete: boolean
  removed: string[]
  deferred: Array<{ installationId: string; reason: string }>
}

export async function cleanupObsoleteInstallations(options: {
  currentInstallationId: string
  agentRoot: string
  paths: (installationId: string) => {
    executablePath: string
    stateDirectory: string
    socketPath: string
  }
  verify: (installationId: string) => Promise<VerifiedInstalledAgentBundle>
  createLifecycle?: (options: DetachedAgentLifecycleOptions) => DetachedAgentLifecycle
  reconcile?: typeof reconcileOrphanedDirectLinuxStdioProcesses
  payloadInUse?: (directory: string) => Promise<boolean>
}): Promise<InstallationCleanupResult> {
  const result: InstallationCleanupResult = { complete: true, removed: [], deferred: [] }
  const registryPath = join(options.agentRoot, 'registry.json')
  const snapshot = () => parseInstallationRegistryState(JSON.parse(readPrivateFile(registryPath, 1024 * 1024).toString('utf8')))
  const initial = snapshot()
  if (initial.current?.installationId !== options.currentInstallationId) {
    throw new Error('Cleanup must run through the current Agent installation')
  }
  const installations = join(options.agentRoot, 'installations')
  ensurePrivateDirectory(installations, { create: false })
  const deadlineAt = new Date(Date.now() + 15_000).toISOString()
  for (const entry of readdirSync(installations, { withFileTypes: true })) {
    const installationId = entry.name
    if (installationId === initial.current.installationId || installationId === initial.candidate?.installationId) continue
    const defer = (reason: string) => {
      result.complete = false
      result.deferred.push({ installationId, reason })
    }
    if (!installationRegistryIdSchema.safeParse(installationId).success || !entry.isDirectory()) {
      defer('unrecognized-installation')
      continue
    }
    let failureReason = 'installation-verification-failed'
    try {
      if (Date.now() >= Date.parse(deadlineAt)) { defer('cleanup-deadline'); continue }
      const paths = options.paths(installationId)
      const directory = join(installations, installationId)
      if (resolve(dirname(paths.executablePath)) !== resolve(directory)) throw new Error('Installation path mismatch')
      const verified = await options.verify(installationId)
      const lifecycle = (options.createLifecycle ?? (input => new DetachedAgentLifecycle(input)))({
        installationId, ...paths, verifyInstallation: async () => verified
      })
      const cleaned = await lifecycle.withStoppedInstallation(async () => {
        failureReason = 'registry-changed'
        if (JSON.stringify(snapshot()) !== JSON.stringify(initial)) throw new Error('Registry changed during cleanup')
        // Read the existing authority without constructors that recover or rewrite operations.
        failureReason = 'active-or-unproven-work'
        assertInactiveInstallation(paths.stateDirectory)
        failureReason = 'runtime-ownership-unproven'
        const ownersPath = join(paths.stateDirectory, 'runtime-owners.sqlite')
        assertPrivateRegularFile(ownersPath)
        const database = new DatabaseSync(ownersPath, { readOnly: true })
        try {
          const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('active_runtime_owners', 'runtime_process_owners')").all()
          if (table.length !== 1) throw new Error('Unknown Runtime owner schema')
          const name = table[0]!.name === 'active_runtime_owners' ? 'active_runtime_owners' : 'runtime_process_owners'
          if (database.prepare(`SELECT 1 FROM ${name} WHERE installation_id != ? OR state = 'reserved' OR (state IN ('running', 'stopping') AND process_identity_json IS NULL) LIMIT 1`).get(installationId)) {
            throw new Error('Uncertain Runtime ownership')
          }
        } finally {
          database.close()
        }
        const owners = new RuntimeOwnerRegistry(ownersPath)
        try {
          failureReason = 'runtime-cleanup-incomplete'
          const reconciliation = await (options.reconcile ?? reconcileOrphanedDirectLinuxStdioProcesses)({ installationId, registry: owners, deadlineAt })
          if (reconciliation.unknown || reconciliation.conflicts || owners.listForInstallation(installationId).length) {
            throw new Error('Runtime cleanup remains uncertain')
          }
        } finally {
          owners.close()
        }
        failureReason = 'payload-in-use-or-process-inspection-failed'
        if (await (options.payloadInUse ?? installationPayloadInUse)(directory)) throw new Error('Installation payload is still in use')
        failureReason = 'registry-changed'
        if (JSON.stringify(snapshot()) !== JSON.stringify(initial)) throw new Error('Registry changed during cleanup')
        // Verification requires an exact executable payload tree. State and history live elsewhere.
        failureReason = 'payload-removal-failed'
        rmSync(directory, { recursive: true })
        result.removed.push(installationId)
      })
      if (!cleaned) defer('live-or-unproven-daemon-inactivity')
    } catch {
      defer(failureReason)
    }
  }
  return result
}

function assertInactiveInstallation(stateDirectory: string): void {
  ensurePrivateDirectory(stateDirectory, { create: false })
  for (const [path, queries] of [
    [join(stateDirectory, 'semantic-prompts.sqlite'), [
      "SELECT 1 FROM semantic_prompt_operations WHERE state NOT IN ('completed', 'failed', 'cancelled') OR acknowledged_sequence != latest_sequence LIMIT 1"
    ]],
    [join(stateDirectory, 'journal', 'events.sqlite'), [
      'SELECT 1 FROM acp_channels LIMIT 1',
      'SELECT 1 FROM event_streams WHERE terminal_sequence = 0 OR ack_sequence < last_sequence LIMIT 1'
    ]]
  ] as const) {
    assertPrivateRegularFile(path)
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      for (const query of queries) if (database.prepare(query).get()) throw new Error('Active or unacknowledged work')
    } finally {
      database.close()
    }
  }
}

async function installationPayloadInUse(directory: string): Promise<boolean> {
  if (process.platform !== 'linux') return true
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/u.test(entry.name)) continue
    try {
      const root = `/proc/${entry.name}`
      if (statSync(root).uid !== process.getuid?.()) continue
      for (const name of ['exe', 'cwd']) {
        const path = await readlink(join(root, name))
        if (path === directory || path.startsWith(directory + sep)) return true
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  return false
}
