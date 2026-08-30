import { beforeEach, describe, expect, it } from 'vitest'
import type { SshHostRemoteEnvironment } from '../../shared/ssh-host-contracts'
import { SshHostRemoteEnvironmentCache } from './ssh-host-remote-environment-cache'

const hostId = '00000000-0000-4000-8000-000000000104'
const version = {
  version: '1.2.3',
  architecture: 'x64' as const
}
const remoteEnvironment: SshHostRemoteEnvironment = {
  hostId,
  checkedAt: '2026-08-31T00:00:00.000Z',
  architecture: 'x64',
  agent: {
    state: 'current',
    expected: version,
    installed: version
  },
  runtimes: [
    {
      runtimeId: 'opencode',
      provider: 'opencode',
      state: 'current',
      expected: version,
      installed: version
    }
  ],
  remoteDownload: {
    available: true,
    source: 'mirror',
    packageSize: 1024
  }
}

describe('SshHostRemoteEnvironmentCache', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('restores successful checks in a new cache instance', () => {
    const first = new SshHostRemoteEnvironmentCache(localStorage)
    first.set(remoteEnvironment)

    const restarted = new SshHostRemoteEnvironmentCache(localStorage)
    expect(restarted.getAll()).toEqual({
      [hostId]: remoteEnvironment
    })
  })

  it('persists Host invalidation across cache instances', () => {
    const first = new SshHostRemoteEnvironmentCache(localStorage)
    first.set(remoteEnvironment)
    first.remove(hostId)

    const restarted = new SshHostRemoteEnvironmentCache(localStorage)
    expect(restarted.getAll()).toEqual({})
  })

  it('ignores malformed persisted values', () => {
    localStorage.setItem(
      'goodbuddy.ssh-host-remote-environments.v1',
      JSON.stringify([
        remoteEnvironment,
        { ...remoteEnvironment, checkedAt: 'not-a-date' }
      ])
    )

    const restarted = new SshHostRemoteEnvironmentCache(localStorage)
    expect(restarted.getAll()).toEqual({
      [hostId]: remoteEnvironment
    })
  })
})
