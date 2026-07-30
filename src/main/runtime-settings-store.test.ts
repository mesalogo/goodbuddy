import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeSettingsInput } from '../shared/contracts'
import {
  RuntimeSettingsStore,
  type CredentialCipher
} from './runtime-settings-store'

const temporaryDirectories: string[] = []

const cipher: CredentialCipher = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(`encrypted:${value}`),
  decrypt: (value) => value.toString().replace(/^encrypted:/, '')
}

function settings(
  overrides: Partial<RuntimeSettingsInput> = {}
): RuntimeSettingsInput {
  return {
    provider: 'bigtoken',
    bigtokenBaseUrl: 'https://bigtoken.ai',
    bigtokenModel: 'sonnet-5',
    apiKey: { action: 'keep' },
    toolApproval: 'always',
    ...overrides
  }
}

async function createStore(
  environment: NodeJS.ProcessEnv = {}
): Promise<{ filePath: string; store: RuntimeSettingsStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'goodbuddy-settings-'))
  temporaryDirectories.push(directory)
  const filePath = join(directory, 'runtime-settings.json')
  return {
    filePath,
    store: new RuntimeSettingsStore(filePath, cipher, environment)
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('RuntimeSettingsStore', () => {
  it('encrypts the API key and binds it to the configured origin', async () => {
    const { filePath, store } = await createStore()
    await store.update(
      settings({
        apiKey: { action: 'replace', value: 'test-secret-value' }
      })
    )

    const contents = await readFile(filePath, 'utf8')
    expect(contents).not.toContain('test-secret-value')
    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      apiKey: 'test-secret-value',
      bigtokenBaseUrl: 'https://bigtoken.ai'
    })

    await expect(
      store.update(
        settings({
          bigtokenBaseUrl: 'https://other.example',
          apiKey: { action: 'keep' }
        })
      )
    ).rejects.toThrow('请重新输入或清除')
  })

  it('does not mix an environment key with a stored base URL', async () => {
    const { filePath, store } = await createStore()
    await store.update(
      settings({
        bigtokenBaseUrl: 'https://custom.example',
        apiKey: { action: 'replace', value: 'stored-test-key' }
      })
    )

    const environmentStore = new RuntimeSettingsStore(filePath, cipher, {
      GOODBUDDY_BIGTOKEN_API_KEY: 'YOUR_API_KEY_HERE'
    })
    await expect(environmentStore.getResolvedSettings()).resolves.toMatchObject({
      apiKey: 'YOUR_API_KEY_HERE',
      bigtokenBaseUrl: 'https://bigtoken.ai'
    })
  })

  it('refuses to persist credentials when secure storage is unavailable', async () => {
    const { filePath } = await createStore()
    const store = new RuntimeSettingsStore(filePath, {
      ...cipher,
      isAvailable: () => false
    })

    await expect(
      store.update(
        settings({
          apiKey: { action: 'replace', value: 'test-secret-value' }
        })
      )
    ).rejects.toThrow('安全存储不可用')
  })
})
