import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelDriver } from './channel-driver'
import {
  ChannelManager,
  type ManagedChannelService
} from './channel-manager'
import {
  ChannelSettingsStore,
  type ChannelCredentialCipher,
  type ResolvedChannelSettings
} from './channel-settings-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

function cipher(): ChannelCredentialCipher {
  return {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(value),
    decrypt: (value) => value.toString()
  }
}

async function store(): Promise<ChannelSettingsStore> {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-manager-'))
  roots.push(root)
  return new ChannelSettingsStore(
    join(root, 'channel-settings.json'),
    cipher(),
    {}
  )
}

function inertDriver(channel: string): ChannelDriver {
  return {
    channel,
    start: async () => undefined,
    send: async () => undefined,
    stop: async () => undefined
  }
}

const executor = async () => ({
  status: 'completed',
  output: 'ok'
})

type ServiceRecord = {
  settings: ResolvedChannelSettings
  start: ReturnType<typeof vi.fn<() => Promise<void>>>
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>
}

function managerHarness(
  settingsStore: ChannelSettingsStore,
  failSecret?: string
): {
  manager: ChannelManager
  services: ServiceRecord[]
} {
  const drivers = new WeakMap<ChannelDriver, ResolvedChannelSettings>()
  const services: ServiceRecord[] = []
  const manager = new ChannelManager(settingsStore, executor, {
    createDriver: (settings) => {
      const driver = inertDriver(settings.channel)
      drivers.set(driver, settings)
      return driver
    },
    createService: (driver): ManagedChannelService => {
      const settings = drivers.get(driver)
      if (settings === undefined) {
        throw new Error('missing test settings')
      }
      const record: ServiceRecord = {
        settings,
        start: vi.fn(async () => {
          const secret =
            settings.channel === 'weixin'
              ? settings.token
              : settings.secret
          if (secret === failSecret) {
            throw new Error(
              `Authorization secret=${secret} connection failed`
            )
          }
        }),
        stop: vi.fn(async () => undefined)
      }
      services.push(record)
      return record
    }
  })
  return { manager, services }
}

describe('ChannelManager', () => {
  it('applies settings and dynamically starts, replaces, and disables services', async () => {
    const settingsStore = await store()
    const { manager, services } = managerHarness(settingsStore)

    let snapshot = await manager.apply({
      wecom: {
        enabled: true,
        botId: 'bot-1',
        secret: { action: 'replace', value: 'secret-1' },
        allowedSenderIds: ['sender-1'],
        allowGroupMessages: false
      }
    })
    expect(snapshot.wecom.status).toEqual({ state: 'running' })
    expect(services[0]?.start).toHaveBeenCalledOnce()

    snapshot = await manager.apply({
      wecom: {
        enabled: true,
        botId: 'bot-2',
        secret: { action: 'replace', value: 'secret-2' },
        allowedSenderIds: ['sender-2'],
        allowGroupMessages: true
      }
    })
    expect(snapshot.wecom.status.state).toBe('running')
    expect(services[0]?.stop).toHaveBeenCalledOnce()
    expect(services[1]?.settings).toMatchObject({
      botId: 'bot-2',
      secret: 'secret-2',
      allowGroupMessages: true
    })

    snapshot = await manager.apply({
      wecom: {
        enabled: false,
        botId: 'bot-2',
        secret: { action: 'keep' },
        allowedSenderIds: ['sender-2'],
        allowGroupMessages: true
      }
    })
    expect(snapshot.wecom.status.state).toBe('disabled')
    expect(services[1]?.stop).toHaveBeenCalledOnce()
  })

  it('retires the old service when a persisted replacement fails', async () => {
    const settingsStore = await store()
    const leakedSecret = 'new-super-secret'
    const { manager, services } = managerHarness(
      settingsStore,
      leakedSecret
    )
    await manager.apply({
      dingtalk: {
        enabled: true,
        clientId: 'client-1',
        secret: { action: 'replace', value: 'old-secret' },
        allowedSenderIds: ['staff-1'],
        allowGroupMessages: false
      }
    })

    await expect(
      manager.apply({
        dingtalk: {
          enabled: true,
          clientId: 'client-2',
          secret: { action: 'replace', value: leakedSecret },
          allowedSenderIds: ['staff-2'],
          allowGroupMessages: false
        }
      })
    ).rejects.not.toThrow(leakedSecret)
    expect(services[0]?.stop).toHaveBeenCalledOnce()
    expect(services[1]?.stop).toHaveBeenCalledOnce()
    const snapshot = await manager.snapshot()
    expect(snapshot.dingtalk.clientId).toBe('client-2')
    expect(snapshot.dingtalk.allowedSenderIds).toEqual(['staff-2'])
    expect(snapshot.dingtalk.status.state).toBe('error')
    expect(snapshot.dingtalk.status.lastError).not.toContain(leakedSecret)
    expect(snapshot.dingtalk.status.lastError).toContain('[已隐藏]')
  })

  it('tests temporary settings without persisting or installing the service', async () => {
    const settingsStore = await store()
    const { manager, services } = managerHarness(settingsStore)
    const result = await manager.test('wecom', {
      enabled: true,
      botId: 'temporary-bot',
      secret: { action: 'replace', value: 'temporary-secret' },
      allowedSenderIds: ['sender'],
      allowGroupMessages: false
    })

    expect(result).toEqual({ channel: 'wecom', ok: true })
    expect(services[0]?.start).toHaveBeenCalledOnce()
    expect(services[0]?.stop).toHaveBeenCalledOnce()
    expect((await settingsStore.snapshot()).wecom.botId).toBe('')
    expect((await manager.snapshot()).wecom.status.state).toBe('disabled')
  })

  it('starts stored channels and stops all active services', async () => {
    const settingsStore = await store()
    await settingsStore.apply({
      wecom: {
        enabled: true,
        botId: 'bot',
        secret: { action: 'replace', value: 'secret' },
        allowedSenderIds: ['sender'],
        allowGroupMessages: false
      },
      dingtalk: {
        enabled: true,
        clientId: 'client',
        secret: { action: 'replace', value: 'client-secret' },
        allowedSenderIds: ['staff'],
        allowGroupMessages: true
      }
    })
    const { manager, services } = managerHarness(settingsStore)

    const running = await manager.initialize()
    expect(running.wecom.status.state).toBe('running')
    expect(running.dingtalk.status.state).toBe('running')
    await manager.stopAll()
    expect(services).toHaveLength(2)
    expect(services.every((service) => service.stop.mock.calls.length === 1))
      .toBe(true)
    const stopped = await manager.snapshot()
    expect(stopped.wecom.status.state).toBe('stopped')
    expect(stopped.dingtalk.status.state).toBe('stopped')
  })
})
