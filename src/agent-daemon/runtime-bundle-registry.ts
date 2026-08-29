import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type {
  AgentArchitecture,
  AgentReleaseKeyRegistry
} from '../shared/agent-installation-contracts'
import type { DaemonCapabilities } from '../shared/agent-protocol'
import {
  agentIdentifierSchema,
  sha256DigestSchema
} from '../shared/agent-protocol/contracts'
import {
  runtimeRegistryEntrySchema,
  runtimeRegistryStateSchema,
  parseRuntimeRegistryState,
  type RuntimeRegistryEntry,
  type RuntimeRegistryState
} from '../shared/remote-environment-registry-contracts'
import type { RemoteRuntimeLock } from '../shared/remote-runtime-launch-contracts'
import {
  assertAbsoluteManagedPath,
  assertPrivateRegularFile,
  ensurePrivateDirectory,
  writePrivateFileAtomic
} from './managed-paths'
import type { InstalledBundleVerificationEnvironment } from './installed-bundle-verifier'
import {
  loadRegisteredRuntimeBundle,
  type VerifiedRuntimeBundle
} from './runtime-bundle-verifier'

export {
  runtimeRegistryEntrySchema,
  runtimeRegistryStateSchema
}
export type {
  RuntimeRegistryEntry,
  RuntimeRegistryState
}

export class RuntimeBundleRegistry {
  readonly #runtimeRoot: string
  readonly #storagePath: string
  #state: RuntimeRegistryState

  constructor(options: {
    runtimeRoot: string
    storagePath?: string
  }) {
    this.#runtimeRoot = assertAbsoluteManagedPath(
      resolve(options.runtimeRoot)
    )
    this.#storagePath = assertAbsoluteManagedPath(
      resolve(
        options.storagePath ??
          join(this.#runtimeRoot, 'registry.json')
      )
    )
    ensurePrivateDirectory(this.#runtimeRoot)
    ensurePrivateDirectory(dirname(this.#storagePath))
    this.#state = this.#load()
  }

  snapshot(): RuntimeRegistryState {
    return structuredClone(this.#state)
  }

  register(verified: VerifiedRuntimeBundle): RuntimeRegistryEntry {
    const entry = entryFromVerified(verified)
    const expectedDirectory = this.bundleDirectory(
      entry.runtimeId,
      entry.bundleDigest
    )
    if (resolve(verified.bundleDirectory) !== expectedDirectory) {
      throw new Error(
        'Verified Runtime bundle is outside its digest directory'
      )
    }
    this.#state = this.#load({ createIfMissing: false })
    const existing = this.#state.current.find(
      (candidate) =>
        candidate.runtimeId === entry.runtimeId &&
        candidate.architecture === entry.architecture
    )
    if (existing !== undefined && entryEquals(existing, entry)) {
      return existing
    }
    this.#commit({
      formatVersion: 1,
      current: [
        ...this.#state.current.filter(
          (candidate) =>
            candidate.runtimeId !== entry.runtimeId ||
            candidate.architecture !== entry.architecture
        ),
        entry
      ].sort((left, right) =>
        `${left.runtimeId}:${left.architecture}`.localeCompare(
          `${right.runtimeId}:${right.architecture}`
        )
      )
    })
    return entry
  }

  current(
    architecture: AgentArchitecture
  ): RuntimeRegistryEntry[] {
    this.#state = this.#load({ createIfMissing: false })
    return this.#state.current
      .filter((entry) => entry.architecture === architecture)
      .map((entry) => ({ ...entry }))
  }

  resolve(
    runtimeIdInput: string,
    bundleDigestInput: string,
    architecture: AgentArchitecture
  ): {
    entry: RuntimeRegistryEntry
    bundleDirectory: string
  } {
    const resolved = this.find(
      runtimeIdInput,
      bundleDigestInput,
      architecture
    )
    if (resolved === undefined) {
      throw new Error(
        'Runtime bundle is not the verified current bundle'
      )
    }
    return resolved
  }

  find(
    runtimeIdInput: string,
    bundleDigestInput: string,
    architecture: AgentArchitecture
  ): {
    entry: RuntimeRegistryEntry
    bundleDirectory: string
  } | undefined {
    const runtimeId = agentIdentifierSchema.parse(runtimeIdInput)
    const bundleDigest = sha256DigestSchema.parse(bundleDigestInput)
    this.#state = this.#load({ createIfMissing: false })
    const entry = this.#state.current.find(
      (candidate) =>
        candidate.runtimeId === runtimeId &&
        candidate.bundleDigest === bundleDigest &&
        candidate.architecture === architecture
    )
    if (entry === undefined) {
      return undefined
    }
    return {
      entry: { ...entry },
      bundleDirectory: this.bundleDirectory(
        runtimeId,
        bundleDigest
      )
    }
  }

  bundleDirectory(
    runtimeIdInput: string,
    bundleDigestInput: string
  ): string {
    const runtimeId = agentIdentifierSchema.parse(runtimeIdInput)
    const bundleDigest = sha256DigestSchema.parse(bundleDigestInput)
    return resolve(
      this.#runtimeRoot,
      runtimeId,
      bundleDigest.slice('sha256:'.length)
    )
  }

  #load(
    options: { createIfMissing?: boolean } = {}
  ): RuntimeRegistryState {
    let value: unknown
    try {
      assertPrivateRegularFile(this.#storagePath)
      value = JSON.parse(readFileSync(this.#storagePath, 'utf8'))
    } catch (error) {
      if (
        options.createIfMissing !== false &&
        isNodeError(error) &&
        error.code === 'ENOENT'
      ) {
        const initial: RuntimeRegistryState = {
          formatVersion: 1,
          current: []
        }
        writePrivateFileAtomic(
          this.#storagePath,
          `${JSON.stringify(initial, null, 2)}\n`
        )
        return initial
      }
      throw new Error('Runtime bundle registry is corrupt', {
        cause: error
      })
    }
    let parsed: RuntimeRegistryState
    try {
      parsed = parseRuntimeRegistryState(value)
    } catch (error) {
      throw new Error(
        'Runtime bundle registry is corrupt',
        { cause: error }
      )
    }
    if (JSON.stringify(parsed) !== JSON.stringify(value)) {
      writePrivateFileAtomic(
        this.#storagePath,
        `${JSON.stringify(parsed, null, 2)}\n`
      )
    }
    return parsed
  }

  #commit(stateInput: RuntimeRegistryState): void {
    const state = runtimeRegistryStateSchema.parse(stateInput)
    let persisted: unknown
    try {
      assertPrivateRegularFile(this.#storagePath)
      persisted = JSON.parse(readFileSync(this.#storagePath, 'utf8'))
    } catch (error) {
      throw new Error(
        'Runtime bundle registry changed or became corrupt before commit',
        { cause: error }
      )
    }
    const parsedPersisted =
      runtimeRegistryStateSchema.safeParse(persisted)
    if (
      !parsedPersisted.success ||
      JSON.stringify(parsedPersisted.data) !== JSON.stringify(this.#state)
    ) {
      throw new Error(
        'Runtime bundle registry changed concurrently; refusing to overwrite it'
      )
    }
    writePrivateFileAtomic(
      this.#storagePath,
      `${JSON.stringify(state, null, 2)}\n`
    )
    this.#state = state
  }
}

type VerifiedRuntimeCapabilitySourceOptions = {
  registry: RuntimeBundleRegistry
  architecture: AgentArchitecture
  releaseKeyRegistry: AgentReleaseKeyRegistry
  runtimeLock: RemoteRuntimeLock
  verificationEnvironment?: InstalledBundleVerificationEnvironment
  enforceFilesystemMode?: boolean
  filesystemPlatform?: NodeJS.Platform
  uid?: number
  reportError?: (message: string, error: unknown) => void
  loadRegistered?: (
    entry: RuntimeRegistryEntry,
    bundleDirectory: string
  ) => Promise<VerifiedRuntimeBundle>
}

export function createVerifiedRuntimeCapabilitySource(
  options: VerifiedRuntimeCapabilitySourceOptions
): () => Promise<DaemonCapabilities['runtimes']> {
  return async () => await loadVerifiedRuntimeCapabilities(options)
}

async function loadVerifiedRuntimeCapabilities(
  options: VerifiedRuntimeCapabilitySourceOptions
): Promise<DaemonCapabilities['runtimes']> {
  const capabilities: DaemonCapabilities['runtimes'] = []
  for (const entry of options.registry.current(options.architecture)) {
    try {
      const bundleDirectory =
        options.registry.bundleDirectory(
          entry.runtimeId,
          entry.bundleDigest
        )
      await (options.loadRegistered === undefined
        ? loadRegisteredRuntimeBundle(
            bundleDirectory,
            {
              registered: entry,
              architecture: options.architecture,
              releaseKeyRegistry:
                options.releaseKeyRegistry,
              runtimeLock: options.runtimeLock,
              ...(options.verificationEnvironment === undefined
                ? {}
                : {
                    verificationEnvironment:
                      options.verificationEnvironment
                  }),
              ...(options.enforceFilesystemMode === undefined
                ? {}
                : {
                    enforceFilesystemMode:
                      options.enforceFilesystemMode
                  }),
              ...(options.filesystemPlatform === undefined
                ? {}
                : {
                    filesystemPlatform:
                      options.filesystemPlatform
                  }),
              ...(options.uid === undefined
                ? {}
                : { uid: options.uid })
            }
          )
        : options.loadRegistered(
            entry,
            bundleDirectory
          ))
      capabilities.push({
        runtimeId: entry.runtimeId,
        version: entry.runtimeVersion,
        bundleDigest: entry.bundleDigest,
        acpCapabilitiesDigest: entry.acpCapabilitiesDigest,
        sessionLoad: true,
        sessionResume: true
      })
    } catch (error) {
      options.reportError?.(
        `Verified Runtime unavailable: ${entry.runtimeId}`,
        error
      )
    }
  }
  return capabilities
}

function entryFromVerified(
  verified: VerifiedRuntimeBundle
): RuntimeRegistryEntry {
  return runtimeRegistryEntrySchema.parse({
    runtimeId: verified.manifest.runtimeId,
    runtimeVersion: verified.manifest.runtimeVersion,
    architecture: verified.manifest.architecture,
    bundleDigest: verified.manifest.bundleDigest,
    manifestDigest: verified.manifestDigest,
    runtimeAdapterDigest: verified.manifest.adapterDigest,
    acpCapabilitiesDigest:
      verified.manifest.acpCapabilitiesDigest
  })
}

function entryEquals(
  left: RuntimeRegistryEntry,
  right: RuntimeRegistryEntry
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
