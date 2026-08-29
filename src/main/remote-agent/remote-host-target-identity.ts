import { createHash } from 'node:crypto'
import type { SshConnectionPoolTarget } from '../ssh/ssh-connection-pool'

/**
 * Stable Main-only key for one exact resolved SSH target. All Host mutation
 * coordinators use the same material so credential and Host Key edits cannot
 * be overlooked by one component.
 */
export function remoteHostTargetIdentityKey(
  target: SshConnectionPoolTarget
): string {
  const hostKey = target.host.hostKey
  return createHash('sha256')
    .update(JSON.stringify([
      'goodbuddy-remote-host-target-v1',
      target.host.id,
      target.host.name,
      target.host.hostname,
      target.host.port,
      target.host.username,
      target.host.authentication,
      target.host.password ?? null,
      target.hostRevision,
      target.hostKeyGeneration,
      hostKey?.algorithm ?? null,
      hostKey?.publicKeyBase64 ?? null,
      hostKey?.fingerprintSha256 ?? null,
      hostKey?.acceptedAt ?? null,
      hostKey?.generation ?? null
    ]))
    .digest('hex')
}

/**
 * Stable identity for recovering a remote operation after an ordinary Host
 * edit or revalidation. It binds the actual SSH account and Host Key, but not
 * display names, credentials, acceptance timestamps, or local revisions.
 */
export function remoteHostRecoveryIdentityKey(
  target: SshConnectionPoolTarget
): string {
  const hostKey = target.host.hostKey
  return createHash('sha256')
    .update(JSON.stringify([
      'goodbuddy-remote-host-recovery-v1',
      target.host.id,
      target.host.hostname,
      target.host.port,
      target.host.username,
      hostKey?.algorithm ?? null,
      hostKey?.publicKeyBase64 ?? null
    ]))
    .digest('hex')
}
