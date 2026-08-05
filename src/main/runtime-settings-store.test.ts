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
    modelProtocol: 'anthropic-messages',
    modelAuthentication: 'api-key',
    imageGenerationQuality: 'auto',
    opencodeBaseUrl: '',
    opencodeEmbedded: false,
    opencodeBinaryPath: '',
    opencodeConfigPath: '',
    continueBinaryPath: '',
    continueConfigPath: '',
    continueMode: 'chat',
    runtimeSandboxMode: 'auto',
    knowledgeEmbeddingEnabled: false,
    knowledgeEmbeddingBaseUrl:
      'http://127.0.0.1:11434/v1/embeddings',
    knowledgeEmbeddingModel: 'nomic-embed-text',
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
  it('migrates version 8 settings with smart routing disabled', async () => {
    const { filePath, store } = await createStore()
    await store.update(settings({ subagentSmartRoutingEnabled: true }))
    const versionEight = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      subagentSmartRoutingEnabled?: boolean
    }
    versionEight.version = 8
    delete versionEight.subagentSmartRoutingEnabled
    await writeFile(filePath, JSON.stringify(versionEight), 'utf8')

    const migrated = new RuntimeSettingsStore(filePath, cipher, {})
    await expect(migrated.getPublicSettings()).resolves.toMatchObject({
      subagentSmartRoutingEnabled: false
    })
    await migrated.update(settings())
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
    }
    expect(persisted.version).toBe(9)
  })

  it('accepts only supported image quality values', () => {
    for (const imageGenerationQuality of [
      'auto',
      'low',
      'medium',
      'high'
    ] as const) {
      expect(
        runtimeSettingsInputSchema.safeParse(
          settings({ imageGenerationQuality })
        ).success
      ).toBe(true)
    }
    expect(
      runtimeSettingsInputSchema.safeParse({
        ...settings(),
        imageGenerationQuality: 'ultra'
      }).success
    ).toBe(false)
  })

  it('allows private HTTP embedding endpoints but rejects public HTTP', () => {
    expect(
      runtimeSettingsInputSchema.safeParse(
        settings({
          knowledgeEmbeddingEnabled: true,
          knowledgeEmbeddingBaseUrl:
            'http://10.7.0.23:11434/v1/embeddings',
          knowledgeEmbeddingModel: 'bge-m3'
        })
      ).success
    ).toBe(true)
    expect(
      runtimeSettingsInputSchema.safeParse(
        settings({
          knowledgeEmbeddingEnabled: true,
          knowledgeEmbeddingBaseUrl:
            'http://example.com:11434/v1/embeddings'
        })
      ).success
    ).toBe(false)
  })

  it('encrypts an OpenAI-compatible embedding API key and binds it to the full endpoint', async () => {
    const { filePath, store } = await createStore()
    await store.update(
      settings({
        knowledgeEmbeddingEnabled: true,
        knowledgeEmbeddingBaseUrl:
          'https://vectors.example/custom/embeddings',
        knowledgeEmbeddingModel: 'vendor/embed-large',
        knowledgeEmbeddingApiKey: {
          action: 'replace',
          value: 'vector-secret-value'
        }
      })
    )

    const contents = await readFile(filePath, 'utf8')
    expect(contents).not.toContain('vector-secret-value')
    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      knowledgeEmbeddingBaseUrl:
        'https://vectors.example/custom/embeddings',
      knowledgeEmbeddingModel: 'vendor/embed-large',
      knowledgeEmbeddingApiKey: 'vector-secret-value'
    })
    await expect(store.getPublicSettings()).resolves.toMatchObject({
      knowledgeEmbeddingApiKeyConfigured: true,
      knowledgeEmbeddingCredentialSource: 'encrypted'
    })
    await expect(
      store.update(
        settings({
          knowledgeEmbeddingBaseUrl:
            'https://vectors.example/v1/embeddings',
          knowledgeEmbeddingApiKey: { action: 'keep' }
        })
      )
    ).rejects.toThrow('重新输入或清除 API Key')
  })

  it('migrates version 6 Ollama origins to OpenAI-compatible embedding endpoints', async () => {
    const { filePath, store } = await createStore()
    await store.update(settings())
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as Record<
      string,
      unknown
    >
    persisted.version = 6
    persisted.knowledgeEmbeddingBaseUrl = 'http://127.0.0.1:11434'
    delete persisted.knowledgeEmbeddingCredential
    await writeFile(filePath, JSON.stringify(persisted), 'utf8')

    const migratedStore = new RuntimeSettingsStore(filePath, cipher, {})
    await expect(migratedStore.getPublicSettings()).resolves.toMatchObject({
      knowledgeEmbeddingBaseUrl:
        'http://127.0.0.1:11434/v1/embeddings',
      knowledgeEmbeddingApiKeyConfigured: false,
      imageGenerationQuality: 'auto',
      modelProfiles: [
        expect.objectContaining({ imageGenerationQuality: 'auto' })
      ]
    })
  })

  it('defaults image quality when migrating version 7 settings', async () => {
    const { filePath, store } = await createStore()
    await store.update(
      settings({ imageGenerationQuality: 'high' })
    )
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      modelProfiles: Array<Record<string, unknown>>
    }
    persisted.version = 7
    for (const profile of persisted.modelProfiles) {
      delete profile.imageGenerationQuality
    }
    await writeFile(filePath, JSON.stringify(persisted), 'utf8')

    const migratedStore = new RuntimeSettingsStore(filePath, cipher, {})
    await expect(migratedStore.getResolvedSettings()).resolves.toMatchObject({
      imageGenerationQuality: 'auto'
    })
    await expect(migratedStore.getPublicSettings()).resolves.toMatchObject({
      imageGenerationQuality: 'auto',
      modelProfiles: [
        expect.objectContaining({ imageGenerationQuality: 'auto' })
      ]
    })
  })

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

  it('does not infer image capability from the model name', async () => {
    const { store } = await createStore()
    await store.update(
      settings({
        modelBaseUrl: 'https://bigtoken.ai',
        modelName: 'gpt-image-2',
        modelProtocol: 'anthropic-messages',
        apiKey: { action: 'replace', value: 'image-secret' }
      })
    )

    await expect(store.getPublicSettings()).resolves.toMatchObject({
      modelBaseUrl: 'https://bigtoken.ai',
      modelName: 'gpt-image-2',
      modelProtocol: 'anthropic-messages',
      apiKeyConfigured: true,
      credentialSource: 'encrypted',
      modelProfiles: [
        expect.objectContaining({
          baseUrl: 'https://bigtoken.ai',
          modelName: 'gpt-image-2',
          protocol: 'anthropic-messages'
        })
      ]
    })
    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      modelBaseUrl: 'https://bigtoken.ai',
      modelName: 'gpt-image-2',
      modelProtocol: 'anthropic-messages',
      apiKey: 'image-secret'
    })
  })

  it('uses the explicit protocol as the image-generation capability marker', async () => {
    const { filePath, store } = await createStore()
    const chatId = crypto.randomUUID()
    const imageId = crypto.randomUUID()
    await store.update(
      settings({
        modelProfiles: [
          {
            id: chatId,
            name: 'Chat',
            baseUrl: 'https://chat.example/v1',
            modelName: 'chat-model',
            protocol: 'openai-chat-completions',
            authentication: 'api-key',
            imageGenerationQuality: 'auto',
            apiKey: { action: 'replace', value: 'chat-secret' }
          },
          {
            id: imageId,
            name: 'Custom Image',
            baseUrl: 'https://images.example/custom/v2',
            modelName: 'vendor/custom-renderer',
            protocol: 'openai-images-generations',
            authentication: 'api-key',
            imageGenerationQuality: 'high',
            apiKey: { action: 'replace', value: 'image-secret' }
          }
        ],
        defaultModelProfileId: imageId
      })
    )

    await expect(store.getPublicSettings()).resolves.toMatchObject({
      modelBaseUrl: 'https://images.example/custom/v2',
      modelName: 'vendor/custom-renderer',
      modelProtocol: 'openai-images-generations',
      modelProfiles: [
        expect.objectContaining({ id: chatId }),
        expect.objectContaining({
          id: imageId,
          baseUrl: 'https://images.example/custom/v2',
          modelName: 'vendor/custom-renderer',
          protocol: 'openai-images-generations',
          imageGenerationQuality: 'high'
        })
      ]
    })
    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      modelBaseUrl: 'https://images.example/custom/v2',
      modelName: 'vendor/custom-renderer',
      modelProtocol: 'openai-images-generations',
      imageGenerationQuality: 'high',
      apiKey: 'image-secret'
    })
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      modelProfiles: Array<Record<string, unknown>>
    }
    expect(persisted.version).toBe(9)
    expect(persisted.modelProfiles).toContainEqual(
      expect.objectContaining({
        id: imageId,
        imageGenerationQuality: 'high'
      })
    )
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
            protocol: 'anthropic-messages',
            authentication: 'api-key',
            imageGenerationQuality: 'auto',
            apiKey: { action: 'replace', value: 'work-secret' }
          },
          {
            id: secondId,
            name: '默认模型',
            baseUrl: 'https://default.example',
            modelName: 'default-model',
            protocol: 'anthropic-messages',
            authentication: 'api-key',
            imageGenerationQuality: 'auto',
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
      version: 9,
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

  it('accepts pathful HTTPS roots and loopback HTTP but rejects remote HTTP', () => {
    expect(
      runtimeSettingsInputSchema.safeParse(
        settings({
          modelBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
        })
      ).success
    ).toBe(true)
    expect(
      runtimeSettingsInputSchema.safeParse(
        settings({
          modelBaseUrl: 'http://127.0.0.1:11434/v1',
          modelProtocol: 'openai-chat-completions',
          modelAuthentication: 'none'
        })
      ).success
    ).toBe(true)
    expect(
      runtimeSettingsInputSchema.safeParse(
        settings({ modelBaseUrl: 'http://models.example/v1' })
      ).success
    ).toBe(false)
  })

  it('migrates version 5 profiles to Anthropic API-key profiles', async () => {
    const { filePath, store } = await createStore()
    const profileId = '00000000-0000-4000-8000-000000000021'
    const encryptedCredential = cipher
      .encrypt(
        JSON.stringify({
          version: 1,
          apiKey: 'version-five-secret',
          origin: 'https://legacy-v5.example'
        })
      )
      .toString('base64')
    await writeFile(
      filePath,
      JSON.stringify({
        version: 5,
        provider: 'model',
        modelProfiles: [
          {
            id: profileId,
            name: 'V5 模型',
            baseUrl: 'https://legacy-v5.example',
            modelName: 'legacy-v5-model',
            credential: {
              formatVersion: 1,
              scheme: 'electron-safe-storage',
              ciphertextBase64: encryptedCredential
            }
          }
        ],
        defaultModelProfileId: profileId,
        opencodeModelSource: { kind: 'profile', profileId },
        continueModelSource: { kind: 'profile', profileId },
        opencodeBaseUrl: '',
        opencodeEmbedded: false,
        opencodeBinaryPath: '',
        opencodeConfigPath: '',
        continueBinaryPath: '',
        continueConfigPath: '',
        continueMode: 'chat',
        workspacePath: 'legacy-workspace',
        toolApproval: 'always'
      }),
      'utf8'
    )

    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      modelProtocol: 'anthropic-messages',
      modelAuthentication: 'api-key',
      apiKey: 'version-five-secret',
      opencodeModelProfile: {
        id: profileId,
        protocol: 'anthropic-messages',
        authentication: 'api-key'
      },
      continueModelProfile: { id: profileId }
    })
  })

  it('persists an unauthenticated Ollama profile without a credential', async () => {
    const { filePath, store } = await createStore()
    const profileId = '00000000-0000-4000-8000-000000000022'
    await store.update(
      settings({
        modelBaseUrl: 'http://127.0.0.1:11434/v1',
        modelName: 'qwen3',
        modelProtocol: 'openai-chat-completions',
        modelAuthentication: 'none',
        modelProfiles: [
          {
            id: profileId,
            name: 'Ollama',
            baseUrl: 'http://127.0.0.1:11434/v1',
            modelName: 'qwen3',
            protocol: 'openai-chat-completions',
            authentication: 'none',
            imageGenerationQuality: 'auto',
            apiKey: { action: 'clear' }
          }
        ],
        defaultModelProfileId: profileId
      })
    )

    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      modelBaseUrl: 'http://127.0.0.1:11434/v1',
      modelProtocol: 'openai-chat-completions',
      modelAuthentication: 'none',
      apiKey: undefined
    })
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      modelProfiles: Array<Record<string, unknown>>
    }
    expect(persisted.version).toBe(9)
    expect(persisted.modelProfiles[0]).not.toHaveProperty('credential')
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
