import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeOwnerRegistry } from './runtime-owner-registry'

const paths: string[] = []
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('RuntimeOwnerRegistry', () => {
  it('durably tracks only active owners per installation', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-owner-registry-'))
    paths.push(root)
    if (process.platform !== 'win32') chmodSync(root, 0o700)
    const path = join(root, 'owners.sqlite')
    const registry = new RuntimeOwnerRegistry(path, { now: () => 10 })
    registry.reserve(fixture())
    registry.markRunning('owner-1', identity())
    registry.markStopping('owner-1')
    registry.remove('owner-1', 'stopping')
    expect(registry.listForInstallation('installation-1')).toEqual([])
    expect(registry.listForInstallation('installation-2')).toEqual([])
    expect(() => registry.markStopping('owner-1')).toThrow(/transition conflict/iu)
    registry.close()

    const reopened = new RuntimeOwnerRegistry(path)
    expect(reopened.get('owner-1')).toBeUndefined()
    reopened.close()
  })

  it('persists running owner identity across restarts', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodbuddy-owner-registry-'))
    paths.push(root)
    if (process.platform !== 'win32') chmodSync(root, 0o700)
    const registry = new RuntimeOwnerRegistry(join(root, 'owners.sqlite'))
    registry.reserve(fixture())
    registry.markRunning('owner-1', identity())
    registry.close()
    const reopened = new RuntimeOwnerRegistry(join(root, 'owners.sqlite'))
    expect(reopened.get('owner-1')).toMatchObject({
      state: 'running',
      processIdentity: identity()
    })
    reopened.close()
  })
})

function fixture() {
  return {
    ownerId: 'owner-1',
    launchId: 'launch-1',
    processId: 'process-1',
    installationId: 'installation-1',
    ownerToken: 'a'.repeat(32)
  }
}

function identity() {
  return {
    bootId: '11111111-1111-1111-1111-111111111111',
    pid: 42,
    startTimeTicks: 100n,
    processGroupId: 42,
    executablePath: '/usr/bin/bwrap'
  }
}
