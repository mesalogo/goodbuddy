import { describe, expect, it, vi } from 'vitest'
import { createAssistantStorageOnChanged, createAssistantStoragePort } from './assistant-storage-port'
import type { DesktopStorageClient } from './desktop-storage-client'
import { assistantStorageMethods } from './desktop-storage-contracts'
import { SqliteChannelDedupStore, SqliteChannelOutbox } from './channels/sqlite-channel-state'
import { DatabaseComputerControlAuditSink } from './computer-control/database-audit'

describe('Assistant storage facade', () => {
  it('binds only allowlisted operations and preserves arguments, completion and failures', async () => {
    let resolve!: (value: boolean) => void
    const call = vi.fn(() => new Promise<boolean>(done => { resolve = done }))
    const port = createAssistantStoragePort({ call } as unknown as Pick<DesktopStorageClient, 'call'>)
    expect(Object.keys(port)).toEqual([...assistantStorageMethods, 'supervisionContext'])
    expect(port).not.toHaveProperty('readSnapshot')
    expect(port).not.toHaveProperty('close')
    const claimed = new SqliteChannelDedupStore(port).claim('telegram', 'account', 'event')
    const settled = vi.fn()
    void Promise.resolve(claimed).then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledWith('assistant', 'claimChannelEvent', ['telegram', 'account', 'event'])
    resolve(true)
    await expect(claimed).resolves.toBe(true)

    call.mockImplementation(() => Promise.reject(new Error('Storage unavailable')))
    await expect(new SqliteChannelDedupStore(port).release('telegram', 'account', 'event')).rejects.toThrow('Storage unavailable')
    await expect(new SqliteChannelOutbox(port).markDelivered('result')).rejects.toThrow('Storage unavailable')
    await expect(new DatabaseComputerControlAuditSink(port).write({ timestamp: 1, taskId: 'task', conversationId: 'conversation',
      leaseId: 'lease', commandId: 'command', action: 'observe', risk: 'observe', outcome: 'completed' })).rejects.toThrow('Storage unavailable')
  })

  it('maps owner changes to the existing domain callbacks', () => {
    const callbacks = { onMagicNotesChanged: vi.fn(), onMagicTodosChanged: vi.fn(), onModelUsageChanged: vi.fn(), onExecutionStatsChanged: vi.fn() }
    const onChanged = createAssistantStorageOnChanged(callbacks)
    onChanged('magicNotes')
    expect(callbacks.onMagicNotesChanged).toHaveBeenCalledOnce()
    expect(callbacks.onMagicTodosChanged).not.toHaveBeenCalled()
    onChanged('magicTodos')
    onChanged('modelUsage')
    onChanged('executionStats')
    for (const callback of Object.values(callbacks)) expect(callback).toHaveBeenCalledOnce()
  })
})
