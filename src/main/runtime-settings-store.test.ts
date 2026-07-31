import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runtimeSettingsInputSchema,
  type RuntimeSettingsInput
} from '../shared/contracts'
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
    provider: 'model',
    modelBaseUrl: 'https://bigtoken.ai',
    modelName: 'sonnet-5',
    opencodeBaseUrl: '',
    opencodeEmbedded: false,
    opencodeBinaryPath: '',
    opencodeConfigPath: '',
    continueBinaryPath: '',
    continueConfigPath: '',
    continueMode: 'chat',
    workspacePath: 'test-workspace',
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
      modelBaseUrl: 'https://bigtoken.ai'
    })

    await expect(
      store.update(
        settings({
          modelBaseUrl: 'https://other.example',
          apiKey: { action: 'keep' }
        })
      )
    ).rejects.toThrow('请重新输入或清除')
  })

  it('stores multiple encrypted model profiles and resolves runtime sources', async () => {
    const { filePath, store } = await createStore()
    const firstId = '00000000-0000-4000-8000-000000000011'
    const secondId = '00000000-0000-4000-8000-000000000012'
    await store.update(
      settings({
        modelProfiles: [
          {
            id: firstId,
            name: '工作模型',
            baseUrl: 'https://work.example',
            modelName: 'work-model',
            apiKey: { action: 'replace', value: 'work-secret' }
          },
          {
            id: secondId,
            name: '默认模型',
            baseUrl: 'https://default.example',
            modelName: 'default-model',
            apiKey: { action: 'replace', value: 'default-secret' }
          }
        ],
        defaultModelProfileId: secondId,
        opencodeModelSource: { kind: 'profile', profileId: firstId },
        continueModelSource: { kind: 'profile', profileId: secondId }
      })
    )

    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      modelBaseUrl: 'https://default.example',
      modelName: 'default-model',
      apiKey: 'default-secret',
      opencodeModelProfile: {
        id: firstId,
        apiKey: 'work-secret'
      },
      continueModelProfile: {
        id: secondId,
        apiKey: 'default-secret'
      }
    })
    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).not.toContain('work-secret')
    expect(persisted).not.toContain('default-secret')
    const publicSettings = await store.getPublicSettings()
    expect(publicSettings.modelProfiles).toHaveLength(2)
    expect(JSON.stringify(publicSettings)).not.toContain('work-secret')

    await store.update(
      settings({
        modelBaseUrl: 'https://default.example',
        modelName: 'updated-default-model'
      })
    )
    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      modelName: 'updated-default-model',
      opencodeModelProfile: {
        id: firstId,
        apiKey: 'work-secret'
      }
    })
    await expect(store.getPublicSettings()).resolves.toMatchObject({
      modelProfiles: [
        expect.objectContaining({ id: firstId }),
        expect.objectContaining({
          id: secondId,
          modelName: 'updated-default-model'
        })
      ]
    })
  })

  it('does not mix an environment key with a stored base URL', async () => {
    const { filePath, store } = await createStore()
    await store.update(
      settings({
        modelBaseUrl: 'https://custom.example',
        apiKey: { action: 'replace', value: 'stored-test-key' }
      })
    )

    const environmentStore = new RuntimeSettingsStore(filePath, cipher, {
      GOODBUDDY_BIGTOKEN_API_KEY: 'YOUR_API_KEY_HERE'
    })
    await expect(environmentStore.getResolvedSettings()).resolves.toMatchObject({
      apiKey: 'YOUR_API_KEY_HERE',
      modelBaseUrl: 'https://bigtoken.ai'
    })
  })

  it('prefers generic model environment variables over legacy fallbacks', async () => {
    const { filePath } = await createStore()
    const store = new RuntimeSettingsStore(filePath, cipher, {
      GOODBUDDY_MODEL_API_KEY: 'generic-key',
      GOODBUDDY_MODEL_BASE_URL: 'https://generic.example',
      GOODBUDDY_MODEL_NAME: 'generic-model',
      GOODBUDDY_BIGTOKEN_API_KEY: 'legacy-key',
      GOODBUDDY_BIGTOKEN_BASE_URL: 'https://legacy.example',
      GOODBUDDY_BIGTOKEN_MODEL: 'legacy-model'
    })

    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      apiKey: 'generic-key',
      modelBaseUrl: 'https://generic.example',
      modelName: 'generic-model'
    })
  })

  it('migrates version 1 settings without losing the encrypted API key', async () => {
    const { filePath, store } = await createStore()
    const encryptedCredential = cipher
      .encrypt(
        JSON.stringify({
          version: 1,
          apiKey: 'legacy-secret',
          origin: 'https://legacy.example'
        })
      )
      .toString('base64')
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        provider: 'bigtoken',
        bigtokenBaseUrl: 'https://legacy.example',
        bigtokenModel: 'legacy-model',
        opencodeBaseUrl: '',
        opencodeEmbedded: false,
        continueCommand: 'cn',
        workspacePath: 'legacy-workspace',
        credential: {
          formatVersion: 1,
          scheme: 'electron-safe-storage',
          ciphertextBase64: encryptedCredential
        },
        toolApproval: 'always'
      }),
      'utf8'
    )

    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      provider: 'model',
      modelBaseUrl: 'https://legacy.example',
      modelName: 'legacy-model',
      apiKey: 'legacy-secret'
    })

    await store.update(
      settings({
        modelBaseUrl: 'https://legacy.example',
        modelName: 'legacy-model'
      })
    )
    const saved = JSON.parse(await readFile(filePath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(saved).toMatchObject({
      version: 5,
      provider: 'model',
      continueBinaryPath: '',
      continueMode: 'chat',
      modelProfiles: [
        expect.objectContaining({
          baseUrl: 'https://legacy.example',
          modelName: 'legacy-model'
        })
      ]
    })
    expect(saved).not.toHaveProperty('bigtokenBaseUrl')
    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      apiKey: 'legacy-secret'
    })
  })

  it('migrates version 2 Continue commands to binary paths', async () => {
    const { filePath, store } = await createStore()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        provider: 'continue',
        modelBaseUrl: 'https://bigtoken.ai',
        modelName: 'sonnet-5',
        opencodeBaseUrl: '',
        opencodeEmbedded: false,
        continueCommand: 'C:\\Tools\\continue.exe',
        workspacePath: 'legacy-workspace',
        toolApproval: 'always'
      }),
      'utf8'
    )

    const publicSettings = await store.getPublicSettings()
    expect(publicSettings).toMatchObject({
      continueBinaryPath: 'C:\\Tools\\continue.exe',
      continueConfigPath: '',
      opencodeBinaryPath: '',
      opencodeConfigPath: ''
    })
    expect(publicSettings).not.toHaveProperty('continueCommand')
  })

  it('migrates version 3 settings to read-only Continue chat mode', async () => {
    const { filePath, store } = await createStore()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 3,
        provider: 'continue',
        modelBaseUrl: 'https://bigtoken.ai',
        modelName: 'sonnet-5',
        opencodeBaseUrl: '',
        opencodeEmbedded: false,
        opencodeBinaryPath: '',
        opencodeConfigPath: '',
        continueBinaryPath: '',
        continueConfigPath: '',
        workspacePath: 'legacy-workspace',
        toolApproval: 'always'
      }),
      'utf8'
    )

    await expect(store.getPublicSettings()).resolves.toMatchObject({
      provider: 'continue',
      continueMode: 'chat'
    })
  })

  it('treats the legacy default cn command as automatic detection', async () => {
    const { filePath, store } = await createStore()
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        provider: 'continue',
        modelBaseUrl: 'https://bigtoken.ai',
        modelName: 'sonnet-5',
        continueCommand: 'cn',
        workspacePath: 'legacy-workspace',
        toolApproval: 'always'
      }),
      'utf8'
    )

    await expect(store.getPublicSettings()).resolves.toMatchObject({
      continueBinaryPath: ''
    })
  })

  it('canonicalizes runtime paths and only accepts regular files', async () => {
    const { filePath, store } = await createStore()
    const directory = join(filePath, '..')
    const binaryPath = join(directory, 'continue-test-binary')
    const configPath = join(directory, 'continue-test-config.json')
    await Promise.all([
      writeFile(binaryPath, 'binary', 'utf8'),
      writeFile(configPath, '{}', 'utf8')
    ])

    await expect(
      store.update(
        settings({
          continueBinaryPath: binaryPath,
          continueConfigPath: configPath
        })
      )
    ).resolves.toMatchObject({
      continueBinaryPath: binaryPath,
      continueConfigPath: configPath
    })

    await expect(
      store.update(settings({ opencodeConfigPath: directory }))
    ).rejects.toThrow('不是普通文件')
  })

  it('rejects control characters in runtime paths', () => {
    expect(
      runtimeSettingsInputSchema.safeParse(
        settings({ continueBinaryPath: 'C:\\Tools\\continue.exe\n--evil' })
      ).success
    ).toBe(false)
    expect(
      runtimeSettingsInputSchema.safeParse(
        settings({ opencodeConfigPath: '' })
      ).success
    ).toBe(true)
  })

  it('resolves new runtime environment variables with legacy fallback', async () => {
    const { store } = await createStore({
      GOODBUDDY_OPENCODE_BINARY: 'C:\\Tools\\opencode.exe',
      GOODBUDDY_OPENCODE_CONFIG: 'C:\\Config\\opencode.json',
      GOODBUDDY_CONTINUE_BINARY: 'C:\\Tools\\cn.exe',
      GOODBUDDY_CONTINUE_CONFIG: 'C:\\Config\\continue.yaml',
      GOODBUDDY_CONTINUE_COMMAND: 'legacy-cn'
    })

    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      opencodeBinaryPath: 'C:\\Tools\\opencode.exe',
      opencodeConfigPath: 'C:\\Config\\opencode.json',
      continueBinaryPath: 'C:\\Tools\\cn.exe',
      continueConfigPath: 'C:\\Config\\continue.yaml'
    })

    const { store: legacyStore } = await createStore({
      GOODBUDDY_CONTINUE_COMMAND: 'legacy-cn'
    })
    await expect(legacyStore.getResolvedSettings()).resolves.toMatchObject({
      continueBinaryPath: 'legacy-cn'
    })

    const { store: defaultLegacyStore } = await createStore({
      GOODBUDDY_CONTINUE_COMMAND: 'cn'
    })
    await expect(defaultLegacyStore.getResolvedSettings()).resolves.toMatchObject({
      continueBinaryPath: ''
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

  it('isolates a corrupt settings file and reports recovery', async () => {
    const { filePath, store } = await createStore()
    await writeFile(filePath, '{not-valid-json', 'utf8')

    await expect(store.getPublicSettings()).resolves.toMatchObject({
      provider: 'auto',
      warning: expect.stringContaining('已损坏')
    })
    const files = await readdir(join(filePath, '..'))
    expect(
      files.some((name) => name.startsWith('runtime-settings.json.corrupt-'))
    ).toBe(true)
  })
})
