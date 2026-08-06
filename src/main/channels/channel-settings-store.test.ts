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
    expect(initial.warning).toContain('已损坏')
    expect(
      await readdir(join(filePath, '..'))
    ).toContain('channel-settings.json.corrupt-1234')

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
    expect(persisted.version).toBe(1)
    expect(persisted.dingtalk.allowedSenderIds).toEqual(['staff-a'])
    expect((await readdir(join(filePath, '..'))).some(
      (name) => name.endsWith('.tmp')
    )).toBe(false)
  })
})
