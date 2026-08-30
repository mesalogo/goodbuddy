import {
  SSH_HOST_LIMITS,
  sshHostRemoteEnvironmentSchema,
  type SshHostRemoteEnvironment
} from '../../shared/ssh-host-contracts'

type CacheStorage = Pick<
  Storage,
  'getItem' | 'removeItem' | 'setItem'
>

const storageKey = 'goodbuddy.ssh-host-remote-environments.v1'
const maximumPersistedPayloadLength = 1_000_000

function getLocalStorage(): CacheStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export class SshHostRemoteEnvironmentCache {
  private readonly remoteEnvironments = new Map<
    string,
    SshHostRemoteEnvironment
  >()

  constructor(
    private readonly storage: CacheStorage | undefined = getLocalStorage()
  ) {
    this.load()
  }

  getAll(): Readonly<Record<string, SshHostRemoteEnvironment>> {
    return Object.fromEntries(this.remoteEnvironments)
  }

  set(environment: SshHostRemoteEnvironment): void {
    this.remoteEnvironments.set(environment.hostId, environment)
    this.persist()
  }

  remove(hostId: string): void {
    if (this.remoteEnvironments.delete(hostId)) {
      this.persist()
    }
  }

  clear(): void {
    this.remoteEnvironments.clear()
    try {
      this.storage?.removeItem(storageKey)
    } catch {
      // The in-memory cache remains usable when persistence is unavailable.
    }
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(storageKey)
      if (!raw || raw.length > maximumPersistedPayloadLength) {
        return
      }
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        return
      }
      for (const candidate of parsed.slice(
        0,
        SSH_HOST_LIMITS.maximumHosts
      )) {
        const environment =
          sshHostRemoteEnvironmentSchema.safeParse(candidate)
        if (environment.success) {
          this.remoteEnvironments.set(
            environment.data.hostId,
            environment.data
          )
        }
      }
    } catch {
      // Corrupt or inaccessible storage behaves like an empty cache.
    }
  }

  private persist(): void {
    try {
      this.storage?.setItem(
        storageKey,
        JSON.stringify([...this.remoteEnvironments.values()])
      )
    } catch {
      // Version checks still remain cached for the current process.
    }
  }
}

const cache = new SshHostRemoteEnvironmentCache()

export function getCachedSshHostRemoteEnvironments(): Readonly<
  Record<string, SshHostRemoteEnvironment>
> {
  return cache.getAll()
}

export function setCachedSshHostRemoteEnvironment(
  environment: SshHostRemoteEnvironment
): void {
  cache.set(environment)
}

export function removeCachedSshHostRemoteEnvironment(hostId: string): void {
  cache.remove(hostId)
}

export function clearSshHostRemoteEnvironmentCache(): void {
  cache.clear()
}
