import { describe, expect, it } from 'vitest'
import {
  COMPUTER_CONTROL_LEASE_ABSOLUTE_MS,
  COMPUTER_CONTROL_LEASE_IDLE_MS,
  ComputerControlLeaseStore,
  type ComputerControlLeaseBinding
} from './lease-store'

const binding: ComputerControlLeaseBinding = {
  taskId: 'task-1',
  conversationId: 'conversation-1',
  pid: 42,
  processStartTime: 100,
  windowIdentity: 'window-1'
}

describe('ComputerControlLeaseStore', () => {
  it('enforces idle and absolute expiry', () => {
    let now = 1_000
    let sequence = 0
    const store = new ComputerControlLeaseStore(
      () => now,
      () => `lease_identifier_${++sequence}`
    )
    const idleLease = store.create(binding)
    now += COMPUTER_CONTROL_LEASE_IDLE_MS
    expect(() =>
      store.validate(idleLease.leaseId, binding)
    ).toThrow('expired')

    now = 1_000
    const absoluteLease = store.create(binding)
    for (let elapsed = 60_000; elapsed < COMPUTER_CONTROL_LEASE_ABSOLUTE_MS; elapsed += 60_000) {
      now = 1_000 + elapsed
      if (elapsed < COMPUTER_CONTROL_LEASE_ABSOLUTE_MS) {
        store.validate(absoluteLease.leaseId, binding)
      }
    }
    now = 1_000 + COMPUTER_CONTROL_LEASE_ABSOLUTE_MS
    expect(() =>
      store.validate(absoluteLease.leaseId, binding)
    ).toThrow('expired')
  })

  it('revokes and fails on task, conversation, PID, process, or window mismatch', () => {
    const variants: ComputerControlLeaseBinding[] = [
      { ...binding, taskId: 'task-2' },
      { ...binding, conversationId: 'conversation-2' },
      { ...binding, pid: 43 },
      { ...binding, processStartTime: 101 },
      { ...binding, windowIdentity: 'window-2' }
    ]
    let sequence = 0
    const store = new ComputerControlLeaseStore(
      () => 1_000,
      () => `lease_identifier_${++sequence}`
    )

    for (const mismatch of variants) {
      const lease = store.create(binding)
      expect(() =>
        store.validate(lease.leaseId, mismatch)
      ).toThrow('binding changed')
      expect(store.peek(lease.leaseId)).toBeUndefined()
    }
  })

  it('supports explicit lease and task revocation', () => {
    let sequence = 0
    const store = new ComputerControlLeaseStore(
      () => 1_000,
      () => `lease_identifier_${++sequence}`
    )
    const first = store.create(binding)
    const second = store.create({ ...binding, windowIdentity: 'window-2' })
    const other = store.create({ ...binding, taskId: 'task-2' })

    store.revoke(first.leaseId)
    expect(store.peek(first.leaseId)).toBeUndefined()
    store.revokeTask(binding.taskId)
    expect(store.peek(second.leaseId)).toBeUndefined()
    expect(store.peek(other.leaseId)).toBeDefined()
  })

  it('prunes all expired leases during create and validate', () => {
    let now = 1_000
    let sequence = 0
    const store = new ComputerControlLeaseStore(
      () => now,
      () => `lease_identifier_${++sequence}`
    )
    const expiredBeforeCreate = store.create(binding)
    now += COMPUTER_CONTROL_LEASE_IDLE_MS
    const current = store.create(binding)
    expect(store.peek(expiredBeforeCreate.leaseId)).toBeUndefined()

    const expiresBeforeValidate = store.create({
      ...binding,
      taskId: 'task-2'
    })
    now += COMPUTER_CONTROL_LEASE_IDLE_MS - 1
    store.validate(current.leaseId, binding)
    now += 1
    const newest = store.create({
      ...binding,
      taskId: 'task-3'
    })
    store.validate(newest.leaseId, {
      ...binding,
      taskId: 'task-3'
    })
    expect(store.peek(expiresBeforeValidate.leaseId)).toBeUndefined()
  })

  it('enforces a validated hard lease capacity by evicting oldest entries', () => {
    let sequence = 0
    const store = new ComputerControlLeaseStore(
      () => 1_000,
      () => `lease_identifier_${++sequence}`,
      { maximumLeases: 2 }
    )
    const first = store.create(binding)
    const second = store.create({
      ...binding,
      windowIdentity: 'window-2'
    })
    const third = store.create({
      ...binding,
      windowIdentity: 'window-3'
    })

    expect(store.peek(first.leaseId)).toBeUndefined()
    expect(store.peek(second.leaseId)).toBeDefined()
    expect(store.peek(third.leaseId)).toBeDefined()
    expect(
      () =>
        new ComputerControlLeaseStore(Date.now, undefined, {
          maximumLeases: 0
        })
    ).toThrow('capacity')
  })
})
