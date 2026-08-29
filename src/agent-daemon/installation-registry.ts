import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  installationRegistryEntrySchema,
  installationRegistryIdSchema,
  installationRegistryStateSchema,
  parseInstallationRegistryState,
  type InstallationRegistryEntry,
  type InstallationRegistryState
} from '../shared/remote-environment-registry-contracts'
import {
  ensurePrivateDirectory,
  assertPrivateRegularFile,
  writePrivateFileAtomic
} from './managed-paths'
import type { VerifiedInstalledAgentBundle } from './installed-bundle-verifier'

export {
  installationRegistryEntrySchema,
  installationRegistryIdSchema,
  installationRegistryStateSchema
}
export type {
  InstallationRegistryEntry,
  InstallationRegistryState
}

export class InstallationRegistry {
  readonly #storagePath: string
  #state: InstallationRegistryState
  #needsCanonicalization = false

  constructor(options: { storagePath: string }) {
    this.#storagePath = resolve(options.storagePath)
    ensurePrivateDirectory(dirname(this.#storagePath))
    this.#state = this.#load()
  }

  snapshot(): InstallationRegistryState {
    return structuredClone(this.#state)
  }

  stageCandidate(
    verified: VerifiedInstalledAgentBundle
  ): InstallationRegistryEntry {
    const entry = entryFromVerified(verified)
    if (
      this.#state.current !== undefined &&
      entryEquals(this.#state.current, entry)
    ) {
      this.#canonicalizeIfNeeded()
      return this.#state.current
    }
    if (
      this.#state.candidate !== undefined &&
      entryEquals(this.#state.candidate, entry)
    ) {
      this.#canonicalizeIfNeeded()
      return this.#state.candidate
    }
    try {
      this.#commit({ ...this.#state, candidate: entry })
    } catch (error) {
      if (!isConcurrentRegistryError(error)) {
        throw error
      }
      this.#state = this.#load()
      const converged = [
        this.#state.current,
        this.#state.candidate
      ].find(
        (candidate) =>
          candidate !== undefined && entryEquals(candidate, entry)
      )
      if (converged === undefined) {
        throw error
      }
      return converged
    }
    return entry
  }

  promoteCandidate(
    installationIdInput: string
  ): InstallationRegistryState {
    const installationId = installationRegistryIdSchema.parse(
      installationIdInput
    )
    const candidate = this.#state.candidate
    if (
      candidate === undefined ||
      candidate.installationId !== installationId
    ) {
      throw new Error('Agent candidate is not staged for promotion')
    }
    this.#commit({
      formatVersion: 1,
      current: candidate
    })
    return this.snapshot()
  }

  assertVerifiedRole(
    verified: VerifiedInstalledAgentBundle,
    roles: readonly ('current' | 'candidate')[]
  ): InstallationRegistryEntry {
    const entry = entryFromVerified(verified)
    const registered = this.assertRegisteredRole(
      entry.installationId,
      roles
    )
    if (!entryEquals(registered, entry)) {
      throw new Error(
        'Verified Agent installation does not match its authorized registry role'
      )
    }
    return registered
  }

  assertRegisteredRole(
    installationIdInput: string,
    roles: readonly ('current' | 'candidate')[]
  ): InstallationRegistryEntry {
    const installationId = installationRegistryIdSchema.parse(
      installationIdInput
    )
    const registered = roles
      .map((role) => this.#state[role])
      .find(
        (candidate) =>
          candidate?.installationId === installationId
      )
    if (registered === undefined) {
      throw new Error(
        'Agent installation does not have an authorized registry role'
      )
    }
    return registered
  }

  #load(): InstallationRegistryState {
    let value: unknown
    try {
      assertPrivateRegularFile(this.#storagePath)
      value = JSON.parse(readFileSync(this.#storagePath, 'utf8'))
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        const initial: InstallationRegistryState = {
          formatVersion: 1
        }
        writePrivateFileAtomic(
          this.#storagePath,
          `${JSON.stringify(initial, null, 2)}\n`
        )
        return initial
      }
      throw new Error('Agent installation registry is corrupt', {
        cause: error
      })
    }
    let parsed: InstallationRegistryState
    try {
      parsed = parseInstallationRegistryState(value)
    } catch (error) {
      throw new Error(
        'Agent installation registry is corrupt',
        { cause: error }
      )
    }
    this.#needsCanonicalization =
      JSON.stringify(parsed) !== JSON.stringify(value)
    return parsed
  }

  #commit(stateInput: InstallationRegistryState): void {
    const state = installationRegistryStateSchema.parse(stateInput)
    let persisted: unknown
    try {
      assertPrivateRegularFile(this.#storagePath)
      persisted = JSON.parse(readFileSync(this.#storagePath, 'utf8'))
    } catch (error) {
      throw new Error(
        'Agent installation registry changed or became corrupt before commit',
        { cause: error }
      )
    }
    let parsedPersisted: InstallationRegistryState
    try {
      parsedPersisted = parseInstallationRegistryState(persisted)
    } catch {
      throw new Error(
        'Agent installation registry changed or became corrupt before commit'
      )
    }
    if (
      JSON.stringify(parsedPersisted) !== JSON.stringify(this.#state)
    ) {
      throw new Error(
        'Agent installation registry changed concurrently; refusing to overwrite it'
      )
    }
    writePrivateFileAtomic(
      this.#storagePath,
      `${JSON.stringify(state, null, 2)}\n`
    )
    this.#state = state
    this.#needsCanonicalization = false
  }

  #canonicalizeIfNeeded(): void {
    if (this.#needsCanonicalization) {
      this.#commit(this.#state)
    }
  }
}

function entryFromVerified(
  verified: VerifiedInstalledAgentBundle
): InstallationRegistryEntry {
  return installationRegistryEntrySchema.parse({
    installationId: verified.installationId,
    agentVersion: verified.manifest.agentVersion,
    manifestSha256: verified.manifestSha256,
    arch: verified.manifest.arch,
    protocol: verified.manifest.protocol
  })
}

function entryEquals(
  left: InstallationRegistryEntry,
  right: InstallationRegistryEntry
): boolean {
  return (
    left.installationId === right.installationId &&
    left.agentVersion === right.agentVersion &&
    left.manifestSha256 === right.manifestSha256 &&
    left.arch === right.arch
  )
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function isConcurrentRegistryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('changed concurrently')
  )
}
