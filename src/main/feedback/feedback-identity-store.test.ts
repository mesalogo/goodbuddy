import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FeedbackIdentityStore } from './feedback-identity-store'

const firstUuid = '00000000-0000-4000-8000-000000000201'
const secondUuid = '00000000-0000-4000-8000-000000000202'
const temporaryDirectories: string[] = []

async function identityPath(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), 'goodbuddy-feedback-identity-')
  )
  temporaryDirectories.push(directory)
  return join(directory, 'feedback-identity.json')
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('FeedbackIdentityStore', () => {
  it('coalesces first use and persists one private installation UUID', async () => {
    const filePath = await identityPath()
    const createUuid = vi.fn(() => firstUuid)
    const store = new FeedbackIdentityStore(filePath, createUuid)

    await expect(
      Promise.all([
        store.getInstallationId(),
        store.getInstallationId()
      ])
    ).resolves.toEqual([firstUuid, firstUuid])
    expect(createUuid).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      installationId: firstUuid
    })

    const loaded = new FeedbackIdentityStore(filePath, () => secondUuid)
    await expect(loaded.getInstallationId()).resolves.toBe(firstUuid)
  })

  it('isolates corrupt state, creates a new identity, and clears it', async () => {
    const filePath = await identityPath()
    await writeFile(filePath, '{"version":1,"installationId":"broken"}')
    const store = new FeedbackIdentityStore(filePath, () => secondUuid)

    await expect(store.getInstallationId()).resolves.toBe(secondUuid)
    expect(
      (await readdir(join(filePath, '..'))).some((name) =>
        name.startsWith('feedback-identity.json.corrupt-')
      )
    ).toBe(true)

    await store.clear()
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(
      (await readdir(join(filePath, '..'))).some((name) =>
        name.startsWith('feedback-identity.json.corrupt-')
      )
    ).toBe(false)
  })
})
