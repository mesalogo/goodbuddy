import type {
  CurrentSshConnectionTarget,
  SshConnectionTarget
} from './ssh-host-store'

export function toCurrentSshConnectionTarget(
  target: SshConnectionTarget
): CurrentSshConnectionTarget {
  return {
    hostId: target.host.id,
    hostRevision: target.hostRevision,
    hostKeyGeneration: target.hostKeyGeneration,
    username: target.host.username
  }
}

export function assertValidSshConnectionTarget(
  requestedHostId: string,
  target: SshConnectionTarget,
  message = 'SSH 主机连接目标无效'
): void {
  if (
    target.host.id !== requestedHostId ||
    target.hostRevision < 1 ||
    target.hostKeyGeneration < 1 ||
    !target.host.hostKey ||
    target.host.hostKey.generation !== target.hostKeyGeneration
  ) {
    throw new Error(message)
  }
}

export function assertSshLeaseMatchesTarget(
  lease: {
    identity: {
      hostId: string
      hostRevision: number
      hostKeyGeneration: number
    }
  },
  target: SshConnectionTarget,
  message: string
): void {
  if (
    lease.identity.hostId !== target.host.id ||
    lease.identity.hostRevision !== target.hostRevision ||
    lease.identity.hostKeyGeneration !== target.hostKeyGeneration
  ) {
    throw new Error(message)
  }
}
