import { randomUUID } from 'node:crypto'
import { ComputerControlFailure } from './errors'
import type { DriverWindowIdentity } from './driver'

export const COMPUTER_CONTROL_LEASE_IDLE_MS = 5 * 60 * 1_000
export const COMPUTER_CONTROL_LEASE_ABSOLUTE_MS = 10 * 60 * 1_000
export const COMPUTER_CONTROL_MAXIMUM_LEASES = 1_000

export type ComputerControlLeaseBinding = DriverWindowIdentity & {
  taskId: string
  conversationId: string
}

export type ComputerControlLease = ComputerControlLeaseBinding & {
  leaseId: string
  createdAt: number
  lastUsedAt: number
}

export type ComputerControlLeaseStoreOptions = {
  maximumLeases?: number
}

export class ComputerControlLeaseStore {
  private readonly leases = new Map<string, ComputerControlLease>()
  private readonly maximumLeases: number

  constructor(
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
    options: ComputerControlLeaseStoreOptions = {}
  ) {
    this.maximumLeases =
      options.maximumLeases ?? COMPUTER_CONTROL_MAXIMUM_LEASES
    if (
      !Number.isSafeInteger(this.maximumLeases) ||
      this.maximumLeases < 1 ||
      this.maximumLeases > 10_000
    ) {
      throw new Error('Invalid computer control lease capacity')
    }
  }

  create(binding: ComputerControlLeaseBinding): ComputerControlLease {
    const timestamp = this.now()
    this.pruneExpired(timestamp)
    while (this.leases.size >= this.maximumLeases) {
      const oldest = this.leases.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.leases.delete(oldest)
    }
    const lease: ComputerControlLease = {
      ...binding,
      leaseId: this.createId(),
      createdAt: timestamp,
      lastUsedAt: timestamp
    }
    this.leases.set(lease.leaseId, lease)
    return { ...lease }
  }

  peek(leaseId: string): ComputerControlLease | undefined {
    const lease = this.leases.get(leaseId)
    return lease ? { ...lease } : undefined
  }

  validate(
    leaseId: string,
    binding: ComputerControlLeaseBinding
  ): ComputerControlLease {
    const timestamp = this.now()
    const requestedLeaseExpired = this.isExpired(
      this.leases.get(leaseId),
      timestamp
    )
    this.pruneExpired(timestamp)
    const lease = this.leases.get(leaseId)
    if (!lease) {
      if (requestedLeaseExpired) {
        throw new ComputerControlFailure(
          'lease_expired',
          'Computer control lease expired'
        )
      }
      throw new ComputerControlFailure(
        'lease_not_found',
        'Computer control lease was not found'
      )
    }

    if (
      lease.taskId !== binding.taskId ||
      lease.conversationId !== binding.conversationId ||
      lease.pid !== binding.pid ||
      lease.processStartTime !== binding.processStartTime ||
      lease.windowIdentity !== binding.windowIdentity
    ) {
      this.leases.delete(leaseId)
      throw new ComputerControlFailure(
        'lease_mismatch',
        'Computer control lease binding changed'
      )
    }

    lease.lastUsedAt = timestamp
    return { ...lease }
  }

  revoke(leaseId: string): void {
    this.leases.delete(leaseId)
  }

  revokeTask(taskId: string): string[] {
    const revoked: string[] = []
    for (const [leaseId, lease] of this.leases) {
      if (lease.taskId === taskId) {
        this.leases.delete(leaseId)
        revoked.push(leaseId)
      }
    }
    return revoked
  }

  private pruneExpired(timestamp: number): void {
    for (const [leaseId, lease] of this.leases) {
      if (this.isExpired(lease, timestamp)) {
        this.leases.delete(leaseId)
      }
    }
  }

  private isExpired(
    lease: ComputerControlLease | undefined,
    timestamp: number
  ): boolean {
    return (
      lease !== undefined &&
      (timestamp - lease.lastUsedAt >= COMPUTER_CONTROL_LEASE_IDLE_MS ||
        timestamp - lease.createdAt >=
          COMPUTER_CONTROL_LEASE_ABSOLUTE_MS)
    )
  }
}
