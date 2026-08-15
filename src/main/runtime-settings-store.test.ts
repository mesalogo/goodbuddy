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
    deepseekHarnessModelSource: { kind: 'platform' },
    knowledgeEmbeddingEnabled: false,
    knowledgeEmbeddingBaseUrl:
      'http://127.0.0.1:11434/v1/embeddings',
    knowledgeEmbeddingModel: 'nomic-embed-text',
    knowledgeRerankEnabled: false,
    knowledgeRerankEndpoint: 'https://api.cohere.com/v1/rerank',
    knowledgeRerankModel: 'rerank-v3.5',
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
  it('migrates version 16 to disabled default context compression', async () => {
    const { filePath, store } = await createStore()
    await store.update(settings())
    const previous = JSON.parse(
      await readFile(filePath, 'utf8')
    ) as Record<string, unknown>
    previous.version = 16
    delete previous.contextCompression
    await writeFile(filePath, JSON.stringify(previous), 'utf8')

    const migrated = new RuntimeSettingsStore(filePath, cipher, {})
    await expect(migrated.getPublicSettings()).resolves.toMatchObject({
      contextCompression: {
        enabled: false,
        triggerTokens: 200_000,
        recentRawTokens: 32_000,
        modelSource: { kind: 'current' }
      }
    })
  })

  it('persists context compression and optional model context windows', async () => {
    const { store } = await createStore()
    const profileId = '00000000-0000-4000-8000-000000000061'
    const updated = await store.update(
      settings({
        modelProfiles: [
          {
            id: profileId,
            name: 'Long context',
            baseUrl: 'https://model.example/v1',
            modelName: 'long-model',
            protocol: 'openai-chat-completions',
            authentication: 'none',
            supportsImageInput: false,
            contextWindowTokens: 256_000,
            imageGenerationQuality: 'auto',
            apiKey: { action: 'keep' }
          }
        ],
        defaultModelProfileId: profileId,
        contextCompression: {
          enabled: true,
          triggerTokens: 200_000,
          recentRawTokens: 32_000,
          modelSource: { kind: 'profile', profileId },
          summaryPrompt: 'Keep exact decisions and unresolved work.'
        }
      })
    )

    expect(updated).toMatchObject({
      modelProfiles: [
        {
          id: profileId,
          contextWindowTokens: 256_000
        }
      ],
      contextCompression: {
        enabled: true,
        triggerTokens: 200_000,
        recentRawTokens: 32_000,
        modelSource: { kind: 'profile', profileId }
      }
    })
    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      modelProfiles: [
        {
          id: profileId,
          contextWindowTokens: 256_000
        }
      ],
      contextCompression: {
        enabled: true
      }
    })
  })

  it('rejects undersized model context windows and repairs legacy values', async () => {
    const { filePath, store } = await createStore()
    const profileId = '00000000-0000-4000-8000-000000000062'
    const profile = {
      id: profileId,
      name: 'Small context',
      baseUrl: 'https://model.example/v1',
      modelName: 'small-model',
      protocol: 'openai-responses' as const,
      authentication: 'api-key' as const,
      supportsImageInput: false,
      contextWindowTokens: 10_000,
      imageGenerationQuality: 'auto' as const,
      apiKey: { action: 'keep' as const }
    }

    expect(() =>
      runtimeSettingsInputSchema.parse(
        settings({
          modelProfiles: [profile],
          defaultModelProfileId: profileId
        })
      )
    ).toThrow()

    await store.update(
      settings({
        modelProfiles: [
          {
            ...profile,
            contextWindowTokens: 32_000
          }
        ],
        defaultModelProfileId: profileId
      })
    )
    const persisted = JSON.parse(
      await readFile(filePath, 'utf8')
    ) as {
      modelProfiles: Array<{ contextWindowTokens?: number }>
    }
    persisted.modelProfiles[0]!.contextWindowTokens = 10_000
    await writeFile(filePath, JSON.stringify(persisted), 'utf8')

    const migrated = new RuntimeSettingsStore(filePath, cipher, {})
    await expect(migrated.getPublicSettings()).resolves.toMatchObject({
      modelProfiles: [
        expect.objectContaining({
          id: profileId,
          contextWindowTokens: undefined
        })
      ]
    })
  })

  it('configures bundled runtimes from the default model profile', async () => {
    const { store } = await createStore()

    await expect(store.getPublicSettings()).resolves.toMatchObject({
      opencodeEmbedded: true,
      opencodeModelSource: {
        kind: 'profile',
        profileId: '00000000-0000-4000-8000-000000000001'
      },
      continueModelSource: {
        kind: 'profile',
        profileId: '00000000-0000-4000-8000-000000000001'
      }
    })
    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      opencodeEmbedded: true,
      opencodeModelProfile: {
        id: '00000000-0000-4000-8000-000000000001'
      },
      continueModelProfile: {
        id: '00000000-0000-4000-8000-000000000001'
      }
    })
  })

  it('migrates DeepSeek Harness to controlled platform mode and stores a compatible profile', async () => {
    const { filePath, store } = await createStore()
    await store.update(settings())
    const versionFourteen = JSON.parse(
      await readFile(filePath, 'utf8')
    ) as Record<string, unknown>
    versionFourteen.version = 14
    delete versionFourteen.deepseekHarnessModelSource
    delete versionFourteen.deepseekHarnessBinaryPath
    await writeFile(filePath, JSON.stringify(versionFourteen), 'utf8')

    const migrated = new RuntimeSettingsStore(filePath, cipher, {})
    await expect(migrated.getResolvedSettings()).resolves.toMatchObject({
      deepseekHarnessModelProfile: undefined
    })

    const profileId = '00000000-0000-4000-8000-000000000044'
    await migrated.update(
      settings({
        provider: 'deepseek-harness',
        modelProfiles: [
          {
            id: profileId,
            name: 'OpenAI-compatible gateway',
            baseUrl: 'https://gateway.example/openai/v1',
            modelName: 'qwen-plus',
            protocol: 'openai-chat-completions',
            authentication: 'api-key',
            imageGenerationQuality: 'auto',
            apiKey: { action: 'replace', value: 'deepseek-secret' }
          }
        ],
        defaultModelProfileId: profileId,
        deepseekHarnessModelSource: { kind: 'profile', profileId }
      })
    )
    await expect(migrated.getResolvedSettings()).resolves.toMatchObject({
      provider: 'deepseek-harness',
      deepseekHarnessModelProfile: {
        id: profileId,
        apiKey: 'deepseek-secret'
      }
    })
  })

  it('resolves a controlled platform Harness profile without exposing its credential', async () => {
    const apiKey = 'platform-harness-secret'
    const { store } = await createStore({
      GOODBUDDY_MODEL_API_KEY: apiKey,
      GOODBUDDY_MODEL_BASE_URL:
        'https://gateway.example/openai/v1',
      GOODBUDDY_MODEL_NAME: 'qwen-plus'
    })

    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      modelProtocol: 'anthropic-messages',
      deepseekHarnessModelProfile: {
        id: 'goodbuddy-platform-harness',
        name: '管理员预置模型',
        baseUrl: 'https://gateway.example/openai/v1',
        modelName: 'qwen-plus',
        protocol: 'openai-chat-completions',
        authentication: 'api-key',
        supportsImageInput: false,
        imageGenerationQuality: 'auto',
        apiKey
      }
    })

    const publicSettings = await store.getPublicSettings()
    expect(JSON.stringify(publicSettings)).not.toContain(apiKey)
    expect(publicSettings.modelProtocol).toBe('anthropic-messages')
  })

  it.each([
    [
      'an insecure public endpoint',
      {
        GOODBUDDY_MODEL_API_KEY: 'platform-key',
        GOODBUDDY_MODEL_BASE_URL: 'http://gateway.example/v1',
        GOODBUDDY_MODEL_NAME: 'qwen-plus'
      }
    ],
    [
      'an endpoint with embedded credentials',
      {
        GOODBUDDY_MODEL_API_KEY: 'platform-key',
        GOODBUDDY_MODEL_BASE_URL:
          'https://user:secret@gateway.example/v1',
        GOODBUDDY_MODEL_NAME: 'qwen-plus'
      }
    ],
    [
      'an endpoint with a query string',
      {
        GOODBUDDY_MODEL_API_KEY: 'platform-key',
        GOODBUDDY_MODEL_BASE_URL:
          'https://gateway.example/v1?api-version=1',
        GOODBUDDY_MODEL_NAME: 'qwen-plus'
      }
    ],
    [
      'a missing API key',
      {
        GOODBUDDY_MODEL_BASE_URL: 'https://gateway.example/v1',
        GOODBUDDY_MODEL_NAME: 'qwen-plus'
      }
    ]
  ])('does not resolve platform Harness from %s', async (_, environment) => {
    const { store } = await createStore(environment)

    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      deepseekHarnessModelProfile: undefined
    })
  })

  it('drops the legacy custom Harness Host path and ignores its environment override', async () => {
    const { filePath, store } = await createStore()
    await store.update(settings())
    const versionFifteen = JSON.parse(
      await readFile(filePath, 'utf8')
    ) as Record<string, unknown>
    versionFifteen.version = 15
    versionFifteen.deepseekHarnessBinaryPath =
      'C:\\untrusted\\custom-harness.js'
    versionFifteen.runtimeSandboxMode = 'strict'
    await writeFile(filePath, JSON.stringify(versionFifteen), 'utf8')

    const migrated = new RuntimeSettingsStore(filePath, cipher, {
      GOODBUDDY_DEEPSEEK_HARNESS_BINARY:
        'C:\\environment\\custom-harness.js'
    })
    const publicSettings = await migrated.getPublicSettings()
    const resolvedSettings = await migrated.getResolvedSettings()
    expect(publicSettings).not.toHaveProperty(
      'deepseekHarnessBinaryPath'
    )
    expect(publicSettings.configured).not.toHaveProperty(
      'deepseekHarnessBinaryPath'
    )
    expect(resolvedSettings).not.toHaveProperty(
      'deepseekHarnessBinaryPath'
    )
    expect(publicSettings).not.toHaveProperty('runtimeSandboxMode')
    expect(publicSettings.configured).not.toHaveProperty(
      'runtimeSandboxMode'
    )
    expect(resolvedSettings).not.toHaveProperty(
      'runtimeSandboxMode'
    )
    await migrated.update(settings())
    const persisted = JSON.parse(
      await readFile(filePath, 'utf8')
    ) as Record<string, unknown>
    expect(persisted.version).toBe(17)
    expect(persisted).not.toHaveProperty(
      'deepseekHarnessBinaryPath'
    )
    expect(persisted).not.toHaveProperty('runtimeSandboxMode')
  })

  it('accepts compatible gateways and rejects incompatible Harness profiles', () => {
    const profileId = '00000000-0000-4000-8000-000000000045'
    expect(
      runtimeSettingsInputSchema.safeParse(
        settings({
          modelProfiles: [
            {
              id: profileId,
              name: 'Compatible API',
              baseUrl: 'https://other.example/v1',
              modelName: 'qwen-plus',
              protocol: 'openai-chat-completions',
              authentication: 'api-key',
              imageGenerationQuality: 'auto',
              apiKey: { action: 'keep' }
            }
          ],
          defaultModelProfileId: profileId,
          deepseekHarnessModelSource: { kind: 'profile', profileId }
        })
      ).success
    ).toBe(true)
    expect(
      runtimeSettingsInputSchema.safeParse(
        settings({
          modelProfiles: [
            {
              id: profileId,
              name: 'Gateway without API key',
              baseUrl: 'https://other.example/v1',
              modelName: 'qwen-plus',
              protocol: 'openai-chat-completions',
              authentication: 'none',
              imageGenerationQuality: 'auto',
              apiKey: { action: 'clear' }
            }
          ],
          defaultModelProfileId: profileId,
          deepseekHarnessModelSource: { kind: 'profile', profileId }
        })
      ).success
    ).toBe(false)
  })

  it('always enables bundled OpenCode when the Server address is blank', async () => {
    const { filePath, store } = await createStore({
      GOODBUDDY_OPENCODE_EMBEDDED: 'false'
    })

    await expect(
      store.update(
        settings({
          opencodeBaseUrl: '',
          opencodeEmbedded: false
        })
      )
    ).resolves.toMatchObject({
      opencodeBaseUrl: '',
      opencodeEmbedded: true
    })
    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      opencodeBaseUrl: '',
      opencodeEmbedded: true
    })
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      opencodeEmbedded: boolean
    }
    expect(persisted.opencodeEmbedded).toBe(true)
  })

  it('repairs version 11 embedded state and normalizes an external Server to platform mode', async () => {
    const { filePath, store } = await createStore()
    await store.update(settings())
    const versionEleven = JSON.parse(
      await readFile(filePath, 'utf8')
    ) as {
      opencodeEmbedded: boolean
    }
    versionEleven.opencodeEmbedded = false
    await writeFile(filePath, JSON.stringify(versionEleven), 'utf8')

    const repaired = new RuntimeSettingsStore(filePath, cipher, {})
    await expect(repaired.getPublicSettings()).resolves.toMatchObject({
      opencodeEmbedded: true
    })
    await expect(
      repaired.update(
        settings({
          opencodeBaseUrl: 'https://opencode.example',
          opencodeEmbedded: true,
          opencodeModelSource: {
            kind: 'profile',
            profileId: '00000000-0000-4000-8000-000000000001'
          }
        })
      )
    ).resolves.toMatchObject({
      opencodeBaseUrl: 'https://opencode.example',
      opencodeEmbedded: false,
      opencodeModelSource: { kind: 'platform' }
    })
  })

  it('rejects an explicit Runtime source that is missing after input merge', async () => {
    const { store } = await createStore()

    await expect(
      store.update(
        settings({
          opencodeModelSource: {
            kind: 'profile',
            profileId: '00000000-0000-4000-8000-000000000099'
          }
        })
      )
    ).rejects.toThrow('OpenCode 引用的模型连接不存在')
  })

  it('migrates untouched version 10 platform sources to the first compatible text profile', async () => {
    const { filePath, store } = await createStore()
    const imageId = '00000000-0000-4000-8000-000000000031'
    const textId = '00000000-0000-4000-8000-000000000032'
    await store.update(
      settings({
        provider: 'auto',
        modelProfiles: [
          {
            id: imageId,
            name: '默认图像模型',
            baseUrl: 'https://images.example/v1',
            modelName: 'image-model',
            protocol: 'openai-images-generations',
            authentication: 'api-key',
            imageGenerationQuality: 'high',
            apiKey: { action: 'clear' }
          },
          {
            id: textId,
            name: '文本模型',
            baseUrl: 'https://text.example/v1',
            modelName: 'text-model',
            protocol: 'openai-chat-completions',
            authentication: 'none',
            imageGenerationQuality: 'auto',
            apiKey: { action: 'clear' }
          }
        ],
        defaultModelProfileId: imageId,
        opencodeModelSource: { kind: 'platform' },
        continueModelSource: { kind: 'platform' },
        opencodeEmbedded: false
      })
    )
    const versionTen = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      intranetCompatibilityEnabled?: boolean
    }
    versionTen.version = 10
    versionTen.intranetCompatibilityEnabled = false
    await writeFile(filePath, JSON.stringify(versionTen), 'utf8')

    const migrated = new RuntimeSettingsStore(filePath, cipher, {})
    await expect(migrated.getPublicSettings()).resolves.toMatchObject({
      provider: 'model',
      opencodeEmbedded: true,
      opencodeModelSource: { kind: 'profile', profileId: textId },
      continueModelSource: { kind: 'profile', profileId: textId }
    })
    await expect(migrated.getResolvedSettings()).resolves.toMatchObject({
      opencodeModelProfile: { id: textId },
      continueModelProfile: { id: textId }
    })
  })

  it('preserves explicit and intentionally native version 10 Runtime sources', async () => {
    const { filePath, store } = await createStore()
    const profileId = '00000000-0000-4000-8000-000000000033'
    await store.update(
      settings({
        modelProfiles: [
          {
            id: profileId,
            name: '文本模型',
            baseUrl: 'https://text.example/v1',
            modelName: 'text-model',
            protocol: 'openai-responses',
            authentication: 'none',
            imageGenerationQuality: 'auto',
            apiKey: { action: 'clear' }
          }
        ],
        defaultModelProfileId: profileId,
        opencodeModelSource: { kind: 'profile', profileId },
        continueModelSource: { kind: 'platform' },
        continueConfigPath: ''
      })
    )
    const versionTen = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      continueConfigPath: string
      intranetCompatibilityEnabled?: boolean
    }
    versionTen.version = 10
    versionTen.continueConfigPath = 'C:\\Users\\test\\.continue\\config.yaml'
    versionTen.intranetCompatibilityEnabled = false
    await writeFile(filePath, JSON.stringify(versionTen), 'utf8')

    const migrated = new RuntimeSettingsStore(filePath, cipher, {})
    await expect(migrated.getPublicSettings()).resolves.toMatchObject({
      opencodeModelSource: { kind: 'profile', profileId },
      continueModelSource: { kind: 'platform' }
    })
  })

  it('retains version 10 platform sources when no text profile exists', async () => {
    const { filePath, store } = await createStore()
    const imageId = '00000000-0000-4000-8000-000000000034'
    await store.update(
      settings({
        modelProfiles: [
          {
            id: imageId,
            name: '图像模型',
            baseUrl: 'https://images.example/v1',
            modelName: 'image-model',
            protocol: 'openai-images-generations',
            authentication: 'api-key',
            imageGenerationQuality: 'medium',
            apiKey: { action: 'clear' }
          }
        ],
        defaultModelProfileId: imageId,
        opencodeModelSource: { kind: 'platform' },
        continueModelSource: { kind: 'platform' },
        opencodeEmbedded: false
      })
    )
    const versionTen = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      intranetCompatibilityEnabled?: boolean
    }
    versionTen.version = 10
    versionTen.intranetCompatibilityEnabled = false
    await writeFile(filePath, JSON.stringify(versionTen), 'utf8')

    const migrated = new RuntimeSettingsStore(filePath, cipher, {})
    await expect(migrated.getPublicSettings()).resolves.toMatchObject({
      opencodeEmbedded: true,
      opencodeModelSource: { kind: 'platform' },
      continueModelSource: { kind: 'platform' }
    })
  })

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
    expect(persisted.version).toBe(17)
  })

  it('migrates version 11 and removes the obsolete intranet toggle', async () => {
    const { filePath, store } = await createStore()
    await store.update(settings())
    const versionEleven = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      intranetCompatibilityEnabled?: boolean
    }
    versionEleven.version = 11
    versionEleven.intranetCompatibilityEnabled = false
    await writeFile(filePath, JSON.stringify(versionEleven), 'utf8')

    const migrated = new RuntimeSettingsStore(filePath, cipher, {})
    await migrated.update(settings())
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      intranetCompatibilityEnabled?: boolean
    }
    expect(persisted.version).toBe(17)
    expect(persisted).not.toHaveProperty('intranetCompatibilityEnabled')
  })

  it('keeps image input disabled when migrating version 12 profiles', async () => {
    const { filePath, store } = await createStore()
    await store.update(settings())
    const versionTwelve = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      modelProfiles: Array<Record<string, unknown>>
    }
    versionTwelve.version = 12
    for (const profile of versionTwelve.modelProfiles) {
      delete profile.supportsImageInput
    }
    await writeFile(filePath, JSON.stringify(versionTwelve), 'utf8')

    const migrated = new RuntimeSettingsStore(filePath, cipher, {})
    await expect(migrated.getPublicSettings()).resolves.toMatchObject({
      supportsImageInput: false,
      modelProfiles: [
        expect.objectContaining({ supportsImageInput: false })
      ]
    })
  })

  it('persists enabled image input for a model profile', async () => {
    const { filePath, store } = await createStore()
    const profileId = '00000000-0000-4000-8000-000000000035'
    await store.update(
      settings({
        modelProfiles: [
          {
            id: profileId,
            name: '视觉模型',
            baseUrl: 'https://model.example/v1',
            modelName: 'vision-model',
            protocol: 'openai-responses',
            authentication: 'none',
            supportsImageInput: true,
            imageGenerationQuality: 'auto',
            apiKey: { action: 'clear' }
          }
        ],
        defaultModelProfileId: profileId
      })
    )

    await expect(store.getPublicSettings()).resolves.toMatchObject({
      supportsImageInput: true,
      modelProfiles: [
        expect.objectContaining({ supportsImageInput: true })
      ]
    })
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      modelProfiles: Array<Record<string, unknown>>
    }
    expect(persisted.modelProfiles[0]).toMatchObject({
      supportsImageInput: true
    })
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

  it('allows HTTP embedding endpoints on any host', () => {
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
    ).toBe(true)
  })

  it('rejects non-HTTP model profile URLs during legacy migration', async () => {
    const { filePath, store } = await createStore()
    await store.update(settings())
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      modelProfiles: Array<{ baseUrl: string }>
    }
    persisted.version = 6
    persisted.modelProfiles[0]!.baseUrl = 'file:///tmp/model'
    await writeFile(filePath, JSON.stringify(persisted), 'utf8')

    const migratedStore = new RuntimeSettingsStore(filePath, cipher, {})
    await expect(migratedStore.getPublicSettings()).resolves.toMatchObject({
      provider: 'model',
      warnings: [{ code: 'runtime-settings-recovered' }]
    })
    expect(
      (await readdir(join(filePath, '..'))).some((name) =>
        name.startsWith('runtime-settings.json.corrupt-')
      )
    ).toBe(true)
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

  it('migrates version 13 with reranking disabled by default', async () => {
    const { filePath, store } = await createStore()
    await store.update(settings())
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as Record<
      string,
      unknown
    >
    persisted.version = 13
    delete persisted.knowledgeRerankEnabled
    delete persisted.knowledgeRerankEndpoint
    delete persisted.knowledgeRerankModel
    delete persisted.knowledgeRerankCredential
    await writeFile(filePath, JSON.stringify(persisted), 'utf8')

    const migrated = new RuntimeSettingsStore(filePath, cipher, {})
    await expect(migrated.getPublicSettings()).resolves.toMatchObject({
      knowledgeRerankEnabled: false,
      knowledgeRerankEndpoint: 'https://api.cohere.com/v1/rerank',
      knowledgeRerankModel: 'rerank-v3.5',
      knowledgeRerankApiKeyConfigured: false,
      knowledgeRerankCredentialSource: 'none'
    })
  })

  it('encrypts and endpoint-binds the rerank API key', async () => {
    const { filePath, store } = await createStore()
    await store.update(
      settings({
        knowledgeRerankEnabled: true,
        knowledgeRerankEndpoint: 'https://rerank.example/v1/rerank',
        knowledgeRerankModel: 'vendor/rerank-large',
        knowledgeRerankApiKey: {
          action: 'replace',
          value: 'rerank-secret-value'
        }
      })
    )

    expect(await readFile(filePath, 'utf8')).not.toContain(
      'rerank-secret-value'
    )
    await expect(store.getResolvedSettings()).resolves.toMatchObject({
      knowledgeRerankEnabled: true,
      knowledgeRerankEndpoint: 'https://rerank.example/v1/rerank',
      knowledgeRerankModel: 'vendor/rerank-large',
      knowledgeRerankApiKey: 'rerank-secret-value'
    })
    await expect(store.getPublicSettings()).resolves.toMatchObject({
      knowledgeRerankApiKeyConfigured: true,
      knowledgeRerankCredentialSource: 'encrypted'
    })
    await expect(
      store.update(
        settings({
          knowledgeRerankEndpoint: 'https://other.example/v1/rerank',
          knowledgeRerankApiKey: { action: 'keep' }
        })
      )
    ).rejects.toThrow('重排接口 URL 已更改')
  })

  it('prefers the rerank environment API key without exposing it', async () => {
    const { filePath, store } = await createStore()
    await store.update(
      settings({
        knowledgeRerankApiKey: {
          action: 'replace',
          value: 'stored-rerank-secret'
        }
      })
    )
    const environmentStore = new RuntimeSettingsStore(filePath, cipher, {
      GOODBUDDY_RERANK_API_KEY: 'environment-rerank-secret'
    })

    await expect(environmentStore.getResolvedSettings()).resolves.toMatchObject({
      knowledgeRerankApiKey: 'environment-rerank-secret'
    })
    const publicSettings = await environmentStore.getPublicSettings()
    expect(publicSettings).toMatchObject({
      knowledgeRerankApiKeyConfigured: true,
      knowledgeRerankCredentialSource: 'environment'
    })
    expect(JSON.stringify(publicSettings)).not.toContain(
      'environment-rerank-secret'
    )
  })

  it('does not warn about unreadable stored credentials shadowed by environment keys', async () => {
    const { filePath, store } = await createStore()
    await store.update(
      settings({
        apiKey: { action: 'replace', value: 'stored-model-secret' },
        knowledgeEmbeddingApiKey: {
          action: 'replace',
          value: 'stored-embedding-secret'
        },
        knowledgeRerankApiKey: {
          action: 'replace',
          value: 'stored-rerank-secret'
        }
      })
    )
    const environmentStore = new RuntimeSettingsStore(
      filePath,
      {
        ...cipher,
        decrypt: () => {
          throw new Error('stored credential is unreadable')
        }
      },
      {
        GOODBUDDY_MODEL_API_KEY: 'environment-model-secret',
        GOODBUDDY_EMBEDDING_API_KEY: 'environment-embedding-secret',
        GOODBUDDY_RERANK_API_KEY: 'environment-rerank-secret'
      }
    )

    const publicSettings = await environmentStore.getPublicSettings()
    expect(publicSettings).toMatchObject({
      credentialSource: 'environment',
      knowledgeEmbeddingCredentialSource: 'environment',
      knowledgeRerankCredentialSource: 'environment'
    })
    expect(publicSettings.warnings ?? []).toEqual([])
    await expect(environmentStore.getResolvedSettings()).resolves.toMatchObject({
      apiKey: 'environment-model-secret',
      knowledgeEmbeddingApiKey: 'environment-embedding-secret',
      knowledgeRerankApiKey: 'environment-rerank-secret'
    })
  })

  it('reads Runtime policy without decrypting stored credentials', async () => {
    const { filePath, store } = await createStore()
    await store.update(
      settings({
        subagentSmartRoutingEnabled: true,
        toolApproval: 'policy',
        apiKey: { action: 'replace', value: 'stored-model-secret' },
        knowledgeEmbeddingApiKey: {
          action: 'replace',
          value: 'stored-embedding-secret'
        },
        knowledgeRerankApiKey: {
          action: 'replace',
          value: 'stored-rerank-secret'
        }
      })
    )
    const decrypt = vi.fn(cipher.decrypt)
    const policyStore = new RuntimeSettingsStore(
      filePath,
      { ...cipher, decrypt },
      {}
    )

    await expect(policyStore.getPolicySettings()).resolves.toEqual({
      subagentSmartRoutingEnabled: true,
      toolApproval: 'policy'
    })
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('clears rerank credentials and rejects replacement without secure storage', async () => {
    const { filePath, store } = await createStore()
    await store.update(
      settings({
        knowledgeRerankApiKey: {
          action: 'replace',
          value: 'rerank-secret-to-clear'
        }
      })
    )
    await store.update(
      settings({
        knowledgeRerankApiKey: { action: 'clear' }
      })
    )
    expect(await readFile(filePath, 'utf8')).not.toContain(
      'rerank-secret-to-clear'
    )
    await expect(store.getPublicSettings()).resolves.toMatchObject({
      knowledgeRerankApiKeyConfigured: false,
      knowledgeRerankCredentialSource: 'none'
    })

    const unavailable = new RuntimeSettingsStore(filePath, {
      ...cipher,
      isAvailable: () => false
    })
    await expect(
      unavailable.update(
        settings({
          knowledgeRerankApiKey: {
            action: 'replace',
            value: 'must-not-be-persisted'
          }
        })
      )
    ).rejects.toThrow('安全存储不可用')
    expect(await readFile(filePath, 'utf8')).not.toContain(
      'must-not-be-persisted'
    )
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

  it('keeps an already complete version 6 embedding endpoint unchanged', async () => {
    const { filePath, store } = await createStore()
    await store.update(settings())
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as Record<
      string,
      unknown
    >
    persisted.version = 6
    persisted.knowledgeEmbeddingBaseUrl =
      'https://vectors.example/custom/v1/embeddings'
    delete persisted.knowledgeEmbeddingCredential
    await writeFile(filePath, JSON.stringify(persisted), 'utf8')

    const migratedStore = new RuntimeSettingsStore(filePath, cipher, {})
    await expect(migratedStore.getPublicSettings()).resolves.toMatchObject({
      knowledgeEmbeddingBaseUrl:
        'https://vectors.example/custom/v1/embeddings'
    })
  })

  it('repairs only an invalid version 6 embedding endpoint', async () => {
    const { filePath, store } = await createStore()
    await store.update(
      settings({
        provider: 'continue',
        workspacePath: 'preserve-this-workspace'
      })
    )
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as Record<
      string,
      unknown
    >
    persisted.version = 6
    persisted.knowledgeEmbeddingBaseUrl = 'not a URL'
    delete persisted.knowledgeEmbeddingCredential
    await writeFile(filePath, JSON.stringify(persisted), 'utf8')

    const migratedStore = new RuntimeSettingsStore(filePath, cipher, {})
    await expect(migratedStore.getPublicSettings()).resolves.toMatchObject({
      provider: 'continue',
      workspacePath: 'preserve-this-workspace',
      knowledgeEmbeddingBaseUrl:
        'http://127.0.0.1:11434/v1/embeddings'
    })
    expect(
      (await readdir(join(filePath, '..'))).some((name) =>
        name.startsWith('runtime-settings.json.corrupt-')
      )
    ).toBe(false)
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
    expect(persisted.version).toBe(17)
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
            protocol: 'openai-responses',
            authentication: 'api-key',
            imageGenerationQuality: 'auto',
            apiKey: { action: 'replace', value: 'work-secret' }
          },
          {
            id: secondId,
            name: '默认模型',
            baseUrl: 'https://default.example',
            modelName: 'default-model',
            protocol: 'openai-chat-completions',
            authentication: 'none',
            imageGenerationQuality: 'auto',
            apiKey: { action: 'keep' }
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
      modelAuthentication: 'none',
      opencodeModelProfile: {
        id: firstId,
        protocol: 'openai-responses',
        apiKey: 'work-secret'
      },
      continueModelProfile: {
        id: secondId,
        protocol: 'openai-chat-completions',
        authentication: 'none'
      }
    })
    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).not.toContain('work-secret')
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

  it('keeps configured model values when environment values are effective', async () => {
    const { filePath, store } = await createStore()
    await store.update(
      settings({
        modelBaseUrl: 'https://stored.example/v1',
        modelName: 'stored-model',
        apiKey: { action: 'replace', value: 'stored-key' }
      })
    )
    const environmentStore = new RuntimeSettingsStore(filePath, cipher, {
      GOODBUDDY_MODEL_API_KEY: 'environment-key',
      GOODBUDDY_MODEL_BASE_URL: 'https://environment.example/v1',
      GOODBUDDY_MODEL_NAME: 'environment-model'
    })

    const publicSettings = await environmentStore.getPublicSettings()
    expect(publicSettings).toMatchObject({
      modelBaseUrl: 'https://environment.example/v1',
      modelName: 'environment-model',
      credentialSource: 'environment',
      modelProfiles: [
        expect.objectContaining({
          baseUrl: 'https://environment.example/v1',
          modelName: 'environment-model',
          credentialSource: 'environment'
        })
      ],
      configured: {
        modelProfiles: [
          expect.objectContaining({
            baseUrl: 'https://stored.example/v1',
            modelName: 'stored-model',
            credentialSource: 'environment'
          })
        ]
      }
    })

    const defaultProfile = publicSettings.configured!.modelProfiles[0]!
    await environmentStore.update(
      settings({
        modelBaseUrl: defaultProfile.baseUrl,
        modelName: defaultProfile.modelName,
        modelProtocol: defaultProfile.protocol,
        modelAuthentication: defaultProfile.authentication,
        imageGenerationQuality: defaultProfile.imageGenerationQuality,
        modelProfiles: publicSettings.configured!.modelProfiles.map(
          (profile) => ({
          id: profile.id,
          name: profile.name,
          baseUrl: profile.baseUrl,
          modelName: profile.modelName,
          protocol: profile.protocol,
          authentication: profile.authentication,
          supportsImageInput: profile.supportsImageInput,
          imageGenerationQuality: profile.imageGenerationQuality,
          apiKey: { action: 'keep' }
          })
        ),
        defaultModelProfileId: publicSettings.defaultModelProfileId
      })
    )

    await expect(
      new RuntimeSettingsStore(filePath, cipher, {}).getResolvedSettings()
    ).resolves.toMatchObject({
      modelBaseUrl: 'https://stored.example/v1',
      modelName: 'stored-model',
      apiKey: 'stored-key'
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
      version: 17,
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

  it('allows HTTP, IP literals, credentials, paths and queries', () => {
    expect(
      runtimeSettingsInputSchema.safeParse(
        settings({
          modelBaseUrl:
            'http://user@10.0.0.25:8000/models/v1?api-version=2024-02-01',
          knowledgeEmbeddingEnabled: true,
          knowledgeEmbeddingBaseUrl:
            'http://vectors.example.com/v1/embeddings?format=float'
        })
      ).success
    ).toBe(true)

    expect(
      runtimeSettingsInputSchema.safeParse(
        settings({
          modelProfiles: [
            {
              id: crypto.randomUUID(),
              name: '内网模型',
              baseUrl: 'http://[fd00::25]:8000/api',
              modelName: 'corp-model',
              protocol: 'openai-chat-completions',
              authentication: 'none',
              imageGenerationQuality: 'auto',
              apiKey: { action: 'clear' }
            }
          ]
        })
      ).success
    ).toBe(true)
  })

  it('still rejects endpoint protocols the clients cannot transport', () => {
    expect(
      runtimeSettingsInputSchema.safeParse(
        settings({
          modelBaseUrl: 'ftp://models.example.com/v1'
        })
      ).success
    ).toBe(false)
    expect(
      runtimeSettingsInputSchema.safeParse(
        settings({
          knowledgeEmbeddingEnabled: true,
          knowledgeEmbeddingBaseUrl:
            'file:///tmp/embeddings'
        })
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
    expect(persisted.version).toBe(17)
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

  it('preserves settings created by a newer unsupported version', async () => {
    const { filePath, store } = await createStore()
    const futureSettings = JSON.stringify({
      version: 99,
      futureField: 'keep-me'
    })
    await writeFile(filePath, futureSettings, 'utf8')

    await expect(store.getPublicSettings()).rejects.toThrow(
      '不支持 Runtime 设置版本 99'
    )
    expect(await readFile(filePath, 'utf8')).toBe(futureSettings)
    const files = await readdir(join(filePath, '..'))
    expect(
      files.some((name) => name.startsWith('runtime-settings.json.corrupt-'))
    ).toBe(false)
  })

  it('isolates a corrupt settings file and reports recovery', async () => {
    const { filePath, store } = await createStore()
    await writeFile(filePath, '{not-valid-json', 'utf8')

    await expect(store.getPublicSettings()).resolves.toMatchObject({
      provider: 'model',
      warnings: [{ code: 'runtime-settings-recovered' }]
    })
    const files = await readdir(join(filePath, '..'))
    expect(
      files.some((name) => name.startsWith('runtime-settings.json.corrupt-'))
    ).toBe(true)
  })

  it('distinguishes an unreadable saved credential from a missing credential', async () => {
    const { filePath, store } = await createStore()
    await store.update(
      settings({
        apiKey: {
          action: 'replace',
          value: 'credential-that-will-become-unreadable'
        }
      })
    )
    const unreadable = new RuntimeSettingsStore(
      filePath,
      {
        ...cipher,
        decrypt: () => {
          throw new Error('cannot decrypt')
        }
      },
      {}
    )

    await expect(unreadable.getPublicSettings()).resolves.toMatchObject({
      apiKeyConfigured: false,
      credentialSource: 'unreadable',
      modelProfiles: [
        expect.objectContaining({
          credentialSource: 'unreadable'
        })
      ],
      warnings: [
        expect.objectContaining({
          code: 'runtime-model-credential-unreadable',
          subject: '默认模型'
        })
      ]
    })
  })

  it('clears credential warnings after secure storage recovers', async () => {
    const { filePath, store } = await createStore()
    await store.update(
      settings({
        apiKey: {
          action: 'replace',
          value: 'recoverable-model-credential'
        },
        knowledgeEmbeddingApiKey: {
          action: 'replace',
          value: 'recoverable-embedding-credential'
        },
        knowledgeRerankApiKey: {
          action: 'replace',
          value: 'recoverable-rerank-credential'
        }
      })
    )
    let decryptAvailable = false
    const recoveringStore = new RuntimeSettingsStore(
      filePath,
      {
        ...cipher,
        decrypt: (value) => {
          if (!decryptAvailable) {
            throw new Error('secure storage is temporarily unavailable')
          }
          return cipher.decrypt(value)
        }
      },
      {}
    )

    await expect(recoveringStore.getPublicSettings()).resolves.toMatchObject({
      warnings: expect.arrayContaining([
        expect.objectContaining({
          code: 'runtime-model-credential-unreadable'
        }),
        { code: 'runtime-embedding-credential-unreadable' },
        { code: 'runtime-rerank-credential-unreadable' }
      ])
    })

    decryptAvailable = true
    await expect(recoveringStore.getPublicSettings()).resolves.toMatchObject({
      apiKeyConfigured: true,
      knowledgeEmbeddingApiKeyConfigured: true,
      knowledgeRerankApiKeyConfigured: true
    })
    expect((await recoveringStore.getPublicSettings()).warnings ?? []).toEqual(
      []
    )
  })
})
