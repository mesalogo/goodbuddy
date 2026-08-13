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
  ChannelSettingsStore,
  type ChannelCredentialCipher
} from './channel-settings-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function settingsPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-channels-'))
  roots.push(root)
  return join(root, 'channel-settings.json')
}

function createCipher(available = true): ChannelCredentialCipher {
  return {
    isAvailable: () => available,
    encrypt: (value) =>
      Buffer.from(`protected:${Buffer.from(value).toString('base64')}`),
    decrypt: (value) => {
      const encoded = value.toString().replace(/^protected:/u, '')
      return Buffer.from(encoded, 'base64').toString()
    }
  }
}

describe('ChannelSettingsStore', () => {
  it('encrypts secrets and supports keep, replace, and clear', async () => {
    const filePath = await settingsPath()
    const store = new ChannelSettingsStore(filePath, createCipher(), {})

    let snapshot = await store.apply({
      wecom: {
        enabled: true,
        botId: 'bot-1',
        secret: { action: 'replace', value: 'first-secret' },
        allowedSenderIds: ['sender-1'],
        allowGroupMessages: true
      }
    })
    expect(snapshot.wecom).toMatchObject({
      enabled: true,
      botId: 'bot-1',
      secretConfigured: true,
      source: 'encrypted'
    })
    expect(await readFile(filePath, 'utf8')).not.toContain('first-secret')

    snapshot = await store.apply({
      wecom: {
        enabled: true,
        botId: 'bot-2',
        secret: { action: 'keep' },
        allowedSenderIds: ['sender-2'],
        allowGroupMessages: false
      }
    })
    expect((await store.resolve('wecom')).secret).toBe('first-secret')
    expect(snapshot.wecom.botId).toBe('bot-2')

    await store.apply({
      wecom: {
        enabled: true,
        botId: 'bot-2',
        secret: { action: 'replace', value: 'second-secret' },
        allowedSenderIds: ['sender-2'],
        allowGroupMessages: false
      }
    })
    expect((await store.resolve('wecom')).secret).toBe('second-secret')

    snapshot = await store.apply({
      wecom: {
        enabled: false,
        botId: 'bot-2',
        secret: { action: 'clear' },
        allowedSenderIds: ['sender-2'],
        allowGroupMessages: false
      }
    })
    expect(snapshot.wecom).toMatchObject({
      secretConfigured: false,
      source: 'none'
    })
  })

  it('requires safe storage and complete fields for enabled channels', async () => {
    const unavailable = new ChannelSettingsStore(
      await settingsPath(),
      createCipher(false),
      {}
    )
    await expect(
      unavailable.apply({
        dingtalk: {
          enabled: false,
          clientId: 'client',
          secret: { action: 'replace', value: 'secret' },
          allowedSenderIds: [],
          allowGroupMessages: false
        }
      })
    ).rejects.toThrow('安全存储不可用')

    const store = new ChannelSettingsStore(
      await settingsPath(),
      createCipher(),
      {}
    )
    await expect(
      store.apply({
        dingtalk: {
          enabled: true,
          clientId: 'client',
          secret: { action: 'replace', value: 'secret' },
          allowedSenderIds: [],
          allowGroupMessages: false
        }
      })
    ).rejects.toThrow('允许的发送者')
  })

  it('gives complete environment configuration read-only priority', async () => {
    const filePath = await settingsPath()
    const originalStore = new ChannelSettingsStore(
      filePath,
      createCipher(),
      {}
    )
    await originalStore.apply({
      wecom: {
        enabled: true,
        botId: 'stored-bot',
        secret: { action: 'replace', value: 'stored-secret' },
        allowedSenderIds: ['stored-sender'],
        allowGroupMessages: false
      }
    })

    const store = new ChannelSettingsStore(filePath, createCipher(), {
      GOODBUDDY_WECOM_BOT_ID: 'environment-bot',
      GOODBUDDY_WECOM_SECRET: 'environment-secret',
      GOODBUDDY_WECOM_ALLOWED_SENDERS: 'sender-a,sender-b',
      GOODBUDDY_WECOM_ALLOW_GROUPS: 'true'
    })
    expect(await store.resolve('wecom')).toEqual({
      channel: 'wecom',
      enabled: true,
      botId: 'environment-bot',
      secret: 'environment-secret',
      allowedSenderIds: ['sender-a', 'sender-b'],
      allowGroupMessages: true,
      source: 'environment',
      readOnly: true
    })
    await expect(
      store.apply({
        wecom: {
          enabled: false,
          botId: '',
          secret: { action: 'clear' },
          allowedSenderIds: [],
          allowGroupMessages: false
        }
      })
    ).rejects.toThrow('环境变量配置')
  })

  it('isolates corrupt files and recovers with an atomic persisted file', async () => {
    const filePath = await settingsPath()
    await writeFile(filePath, '{invalid-json', 'utf8')
    const store = new ChannelSettingsStore(
      filePath,
      createCipher(),
      {},
      () => 1234
    )

    const initial = await store.snapshot()
    expect(initial.warnings).toContainEqual({
      code: 'channel-settings-recovered'
    })
    expect(
      (await readdir(join(filePath, '..'))).some((name) =>
        name.startsWith('channel-settings.json.corrupt-1234-')
      )
    ).toBe(true)

    await store.apply({
      dingtalk: {
        enabled: false,
        clientId: 'client-id',
        secret: { action: 'replace', value: 'client-secret' },
        allowedSenderIds: [' Staff-A '],
        allowGroupMessages: false
      }
    })
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number
      dingtalk: { allowedSenderIds: string[] }
    }
    expect(persisted.version).toBe(3)
    expect(persisted.dingtalk.allowedSenderIds).toEqual(['staff-a'])
    expect((await readdir(join(filePath, '..'))).some(
      (name) => name.endsWith('.tmp')
    )).toBe(false)
    await expect(store.snapshot()).resolves.not.toHaveProperty(
      'warnings'
    )
  })

  it('encrypts Weixin binding credentials and removes them on disconnect', async () => {
    const filePath = await settingsPath()
    const store = new ChannelSettingsStore(filePath, createCipher(), {})

    const bound = await store.saveWeixinBinding({
      accountId: 'account-123456',
      userId: 'user-654321',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'weixin-private-token'
    })
    expect(bound.weixin).toMatchObject({
      enabled: true,
      bindingConfigured: true,
      source: 'encrypted',
      accountDisplay: '微信用户 ****4321'
    })
    const raw = await readFile(filePath, 'utf8')
    expect(raw).not.toContain('weixin-private-token')
    expect(raw).not.toContain('user-654321')
    expect(await store.resolve('weixin')).toMatchObject({
      enabled: true,
      accountId: 'account-123456',
      userId: 'user-654321',
      token: 'weixin-private-token'
    })

    const disconnected = await store.clearWeixinBinding()
    expect(disconnected.weixin).toMatchObject({
      enabled: false,
      bindingConfigured: false,
      source: 'none'
    })
    expect((await store.resolve('weixin')).token).toBeUndefined()
  })

  it('defers version 2 Weixin migration until safe storage recovers', async () => {
    const filePath = await settingsPath()
    let available = false
    const cipher = createCipher()
    const dynamicCipher: ChannelCredentialCipher = {
      ...cipher,
      isAvailable: () => available
    }
    const legacyCredential = {
      formatVersion: 1,
      scheme: 'electron-safe-storage',
      ciphertextBase64: cipher
        .encrypt(
          JSON.stringify({
            version: 1,
            channel: 'weixin',
            secret: 'legacy-weixin-token'
          })
        )
        .toString('base64')
    }
    const legacySettings = JSON.stringify({
      version: 2,
      weixin: {
        enabled: true,
        credential: legacyCredential,
        accountId: 'account-legacy',
        userId: 'user-legacy',
        baseUrl: 'https://ilinkai.weixin.qq.com'
      },
      wecom: {
        enabled: false,
        botId: '',
        allowedSenderIds: [],
        allowGroupMessages: false
      },
      dingtalk: {
        enabled: false,
        clientId: '',
        allowedSenderIds: [],
        allowGroupMessages: false
      }
    })
    await writeFile(filePath, legacySettings, 'utf8')
    const store = new ChannelSettingsStore(filePath, dynamicCipher, {})

    await expect(store.snapshot()).rejects.toThrow(
      '安全存储暂不可用'
    )
    expect(await readFile(filePath, 'utf8')).toBe(legacySettings)
    expect(
      (await readdir(join(filePath, '..'))).some((name) =>
        name.startsWith('channel-settings.json.corrupt-')
      )
    ).toBe(false)

    available = true
    await expect(store.snapshot()).resolves.toMatchObject({
      weixin: {
        enabled: true,
        bindingConfigured: true,
        source: 'encrypted'
      }
    })
    await expect(store.resolve('weixin')).resolves.toMatchObject({
      accountId: 'account-legacy',
      userId: 'user-legacy',
      token: 'legacy-weixin-token'
    })
    expect(
      JSON.parse(await readFile(filePath, 'utf8'))
    ).toMatchObject({
      version: 3,
      weixin: {
        enabled: true,
        credential: expect.any(Object)
      }
    })
  })

  it('preserves settings created by a newer unsupported version', async () => {
    const filePath = await settingsPath()
    const futureSettings = JSON.stringify({
      version: 99,
      futureField: 'keep-me'
    })
    await writeFile(filePath, futureSettings, 'utf8')
    const store = new ChannelSettingsStore(
      filePath,
      createCipher(),
      {}
    )

    await expect(store.snapshot()).rejects.toThrow(
      '不支持通道设置版本 99'
    )
    expect(await readFile(filePath, 'utf8')).toBe(futureSettings)
    expect(
      (await readdir(join(filePath, '..'))).some((name) =>
        name.startsWith('channel-settings.json.corrupt-')
      )
    ).toBe(false)
  })

  it('does not start Weixin with a temporarily unavailable credential', async () => {
    const filePath = await settingsPath()
    const availableStore = new ChannelSettingsStore(
      filePath,
      createCipher(),
      {}
    )
    await availableStore.saveWeixinBinding({
      accountId: 'account-123',
      userId: 'user-123',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      token: 'private-token'
    })

    const unavailableStore = new ChannelSettingsStore(
      filePath,
      createCipher(false),
      {}
    )
    await expect(unavailableStore.resolve('weixin')).resolves.toMatchObject({
      enabled: false,
      source: 'none'
    })
    await expect(unavailableStore.snapshot()).resolves.toMatchObject({
      weixin: {
        enabled: false,
        bindingConfigured: false
      },
      warnings: expect.arrayContaining([
        { code: 'channel-weixin-secure-storage-unavailable' }
      ])
    })
    expect(
      JSON.parse(await readFile(filePath, 'utf8'))
    ).toMatchObject({
      version: 3,
      weixin: {
        enabled: true,
        credential: expect.any(Object)
      }
    })

    await unavailableStore.apply({
      wecom: {
        enabled: false,
        botId: 'bot-id',
        secret: { action: 'keep' },
        allowedSenderIds: [],
        allowGroupMessages: false
      }
    })
    expect(
      JSON.parse(await readFile(filePath, 'utf8'))
    ).toMatchObject({
      weixin: {
        enabled: true,
        credential: expect.any(Object)
      }
    })
  })

  it('distinguishes unreadable channel credentials from missing secrets', async () => {
    const filePath = await settingsPath()
    const availableStore = new ChannelSettingsStore(
      filePath,
      createCipher(),
      {}
    )
    await availableStore.apply({
      wecom: {
        enabled: false,
        botId: 'bot-id',
        secret: { action: 'replace', value: 'private-secret' },
        allowedSenderIds: ['sender-a'],
        allowGroupMessages: false
      }
    })
    const unreadableStore = new ChannelSettingsStore(
      filePath,
      {
        ...createCipher(),
        decrypt: () => {
          throw new Error('cannot decrypt')
        }
      },
      {}
    )

    await expect(unreadableStore.snapshot()).resolves.toMatchObject({
      wecom: {
        secretConfigured: false,
        source: 'unreadable'
      },
      warnings: expect.arrayContaining([
        { code: 'channel-wecom-credential-unreadable' }
      ])
    })

    await unreadableStore.apply({
      wecom: {
        enabled: false,
        botId: 'replacement-bot',
        secret: { action: 'clear' },
        allowedSenderIds: ['sender-a'],
        allowGroupMessages: false
      }
    })
    await expect(unreadableStore.snapshot()).resolves.toMatchObject({
      wecom: {
        source: 'none'
      }
    })
    expect(
      (await unreadableStore.snapshot()).warnings ?? []
    ).not.toContainEqual({
      code: 'channel-wecom-credential-unreadable'
    })
  })
})

  it.each(['wecom', 'dingtalk'] as const)(
    'clears an unreadable %s credential warning after decryption recovers',
    async (channel) => {
      const filePath = await settingsPath()
      const availableCipher = createCipher()
      const availableStore = new ChannelSettingsStore(
        filePath,
        availableCipher,
        {}
      )
      await availableStore.apply(
        channel === 'wecom'
          ? {
              wecom: {
                enabled: false,
                botId: 'bot-id',
                secret: { action: 'replace', value: 'private-secret' },
                allowedSenderIds: ['sender-a'],
                allowGroupMessages: false
              }
            }
          : {
              dingtalk: {
                enabled: false,
                clientId: 'client-id',
                secret: { action: 'replace', value: 'private-secret' },
                allowedSenderIds: ['sender-a'],
                allowGroupMessages: false
              }
            }
      )
      let decryptAvailable = false
      const recoveringStore = new ChannelSettingsStore(
        filePath,
        {
          ...availableCipher,
          decrypt: (value) => {
            if (!decryptAvailable) {
              throw new Error('secure storage is temporarily unavailable')
            }
            return availableCipher.decrypt(value)
          }
        },
        {}
      )
      const warningCode =
        channel === 'wecom'
          ? 'channel-wecom-credential-unreadable'
          : 'channel-dingtalk-credential-unreadable'

      await expect(recoveringStore.snapshot()).resolves.toMatchObject({
        [channel]: { source: 'unreadable' },
        warnings: expect.arrayContaining([{ code: warningCode }])
      })

      decryptAvailable = true
      await expect(recoveringStore.resolve(channel)).resolves.toMatchObject({
        source: 'encrypted',
        secret: 'private-secret'
      })
      expect((await recoveringStore.snapshot()).warnings ?? []).not.toContainEqual(
        { code: warningCode }
      )
    }
  )
