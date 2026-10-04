import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelDriver, ChannelExecutor, ChannelInboundHandler } from './channel-driver'
import type { ChannelRuntimeStatus, ChannelRuntimeStatusChange } from '../../shared/channel-settings-contracts'
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

const electronFetch = vi.hoisted(() => vi.fn<typeof globalThis.fetch>())
vi.mock('electron', () => ({ net: { fetch: electronFetch } }))

afterEach(async () => {
  electronFetch.mockReset()
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
  it('emits deduplicated status deltas for async transitions and ignores late callbacks', async () => {
    const settingsStore = await store()
    const input = { enabled: true, allowedSenderIds: [], allowGroupMessages: false as const }
    await settingsStore.apply({ telegram: {
      ...input, secret: { action: 'replace', value: 'status-event-test-secret' }
    } })
    const changes: ChannelRuntimeStatusChange[] = []
    const callbacks: Array<(status: ChannelRuntimeStatus) => void> = []
    const manager = new ChannelManager(settingsStore, executor, {
      onStatusChanged: (change) => { changes.push(change) },
      createDriver: (settings, onStatus) => {
        if (onStatus) callbacks.push(onStatus)
        return {
          ...inertDriver(settings.channel),
          testConnection: async () => ({ botId: '123' })
        }
      },
      createService: () => {
        const onStatus = callbacks.at(-1)!
        return {
          start: async () => { onStatus({ state: 'starting' }) },
          stop: async () => { onStatus({ state: 'stopped' }) }
        }
      }
    })
    await manager.initialize()
    expect(changes).toEqual([
      { channel: 'weixin', status: { state: 'disabled' } },
      { channel: 'wecom', status: { state: 'disabled' } },
      { channel: 'dingtalk', status: { state: 'disabled' } },
      { channel: 'telegram', status: { state: 'starting' } }
    ])
    changes.length = 0
    callbacks[0]!({ state: 'running' })
    callbacks[0]!({ state: 'running' })
    callbacks[0]!({ state: 'error', lastError: 'status-event-test-secret disconnected' })
    callbacks[0]!({ state: 'error', lastError: 'status-event-test-secret disconnected' })
    callbacks[0]!({ state: 'error', lastError: 'polling conflict' })
    callbacks[0]!({ state: 'running' })
    expect(changes.map((change) => change.status.state)).toEqual(['running', 'error', 'error', 'running'])
    expect(changes.every((change) => change.channel === 'telegram')).toBe(true)
    expect(JSON.stringify(changes)).not.toContain('status-event-test-secret')
    expect(changes.at(-1)).toEqual({ channel: 'telegram', status: { state: 'running' } })
    changes.length = 0
    await manager.testConnection('telegram')
    expect(changes).toEqual([])
    await manager.reload('telegram')
    callbacks[0]!({ state: 'error', lastError: 'retired' })
    callbacks[1]!({ state: 'running' })
    expect(changes).toEqual([
      { channel: 'telegram', status: { state: 'starting' } },
      { channel: 'telegram', status: { state: 'running' } }
    ])
    changes.length = 0
    await expect(manager.apply({ telegram: { ...input, secret: { action: 'clear' } } })).rejects.toThrow('Bot Token')
    expect((await settingsStore.resolve('telegram')).secret).toBe('status-event-test-secret')
    expect(changes).toEqual([])
    await manager.apply({ telegram: { ...input, enabled: false, secret: { action: 'clear' } } })
    callbacks[1]!({ state: 'running' })
    await manager.reload('telegram')
    await manager.stopAll()
    expect(changes).toEqual([{ channel: 'telegram', status: { state: 'disabled' } }])
    expect((await settingsStore.resolve('telegram')).secret).toBeUndefined()
  })

  it('leaves Telegram connection status to the driver during startup and delivery', async () => {
    const settingsStore = await store()
    await settingsStore.apply({ telegram: {
      enabled: true, secret: { action: 'replace', value: 'status-test-secret' },
      allowedSenderIds: [], allowGroupMessages: false
    } })
    let status!: (status: ChannelRuntimeStatus) => void
    let deliverySuccess!: () => void
    let deliveryFailure!: (error: Error) => void
    const manager = new ChannelManager(settingsStore, executor, {
      createDriver: (settings, onStatus) => {
        status = onStatus!
        return inertDriver(settings.channel)
      },
      createService: (_driver, _executor, options) => {
        deliverySuccess = () => options.onDeliverySuccess?.()
        deliveryFailure = (error) => options.onDeliveryFailure?.(error)
        return { start: async () => undefined, stop: async () => undefined }
      }
    })
    expect((await manager.initialize()).telegram.status).toEqual({ state: 'starting' })
    deliverySuccess()
    expect((await manager.snapshot()).telegram.status.state).toBe('starting')
    status({ state: 'error', lastError: 'Telegram polling conflict (409)' })
    deliverySuccess()
    deliveryFailure(new Error('send failed'))
    expect((await manager.snapshot()).telegram.status).toEqual({
      state: 'error', lastError: 'Telegram polling conflict (409)'
    })
    status({ state: 'running' })
    deliveryFailure(new Error('send failed'))
    expect((await manager.snapshot()).telegram.status).toEqual({ state: 'running' })
    await manager.stopAll()
  })

  it('updates Telegram whitelists without cancelling accepted work or restarting the service', async () => {
    const settingsStore = await store()
    const input = { enabled: true, allowedSenderIds: ['123'], allowGroupMessages: false as const }
    await settingsStore.apply({ telegram: { ...input, secret: { action: 'replace', value: 'active-test-secret' } } })
    let inbound!: ChannelInboundHandler
    let activeSignal!: AbortSignal
    let finish!: () => void
    const work = new Promise<void>((resolve) => { finish = resolve })
    const execute = vi.fn<ChannelExecutor>(async (_message, signal) => {
      activeSignal = signal
      await work
      return { status: 'completed', output: 'finished' }
    })
    const updateAllowedSenderIds = vi.fn()
    const stop = vi.fn(async () => undefined)
    const send = vi.fn(async () => undefined)
    const createDriver = vi.fn((settings: ResolvedChannelSettings) => ({
      ...inertDriver(settings.channel),
      start: async (handler: ChannelInboundHandler) => { inbound = handler },
      updateAllowedSenderIds, stop, send
    }))
    const manager = new ChannelManager(settingsStore, execute, { createDriver })
    await manager.initialize()
    const message = {
      channel: 'telegram', accountId: '456', eventId: '1', senderId: '123',
      conversationId: '456:123', conversationType: 'direct', text: 'hello'
    }
    await inbound(message, () => undefined)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    await manager.apply({ telegram: { ...input, allowedSenderIds: [], secret: { action: 'keep' } } })
    expect(updateAllowedSenderIds).toHaveBeenLastCalledWith([])
    expect(createDriver).toHaveBeenCalledOnce()
    expect(stop).not.toHaveBeenCalled()
    expect(activeSignal.aborted).toBe(false)
    await inbound({ ...message, eventId: '2' }, () => undefined)
    finish()
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    expect(execute).toHaveBeenCalledOnce()
    await manager.apply({ telegram: { ...input, allowedSenderIds: ['789'], secret: { action: 'keep' } } })
    await inbound({ ...message, eventId: '3', senderId: '789', conversationId: '456:789' }, () => undefined)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
    expect(createDriver).toHaveBeenCalledOnce()
    await manager.stopAll()
  })

  it.each(['keep', 'replace'] as const)('restarts a conflicted Telegram poller when saving the same token with %s', async (action) => {
    const settingsStore = await store()
    const input = { enabled: true, allowedSenderIds: ['123'], allowGroupMessages: false as const }
    const secret = 'recovery-test-placeholder'
    await settingsStore.apply({ telegram: { ...input, secret: { action: 'replace', value: secret } } })
    let conflict = true
    let polls = 0
    electronFetch.mockImplementation(async (input, init) => {
      const method = String(input).split('/').at(-1)
      if (method === 'getMe') return Response.json({ ok: true, result: { id: 456, is_bot: true } })
      if (method === 'getWebhookInfo') return Response.json({ ok: true, result: { url: '' } })
      if (method === 'getUpdates') {
        polls++
        if (conflict) return Response.json({ ok: false }, { status: 409 })
        return new Promise<Response>((_resolve, reject) => {
          const signal = init!.signal!
          if (signal.aborted) reject(signal.reason)
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const manager = new ChannelManager(settingsStore, executor)
    try {
      await manager.initialize()
      await vi.waitFor(async () => expect((await manager.snapshot()).telegram.status.state).toBe('error'))
      conflict = false
      expect((await manager.testConnection('telegram')).ok).toBe(true)
      await manager.apply({ telegram: { ...input, secret: action === 'keep' ? { action } : { action, value: secret } } })
      await vi.waitFor(async () => {
        expect(polls).toBe(2)
        expect((await manager.snapshot()).telegram.status.state).toBe('running')
      })
    } finally {
      await manager.stopAll()
    }
  })

  it('validates replacement tokens before saving or stopping the active Telegram service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-manager-'))
    roots.push(root)
    const path = join(root, 'settings.json')
    const settingsStore = new ChannelSettingsStore(path, cipher(), {})
    const input = { enabled: true, allowedSenderIds: ['123'], allowGroupMessages: false as const }
    await settingsStore.apply({ telegram: { ...input, secret: { action: 'replace', value: 'working-test-secret' } } })
    const original = await readFile(path, 'utf8')
    const events: string[] = []
    const probes: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = []
    let activeStatus!: (status: ChannelRuntimeStatus) => void
    const updateAllowedSenderIds = vi.fn()
    const manager = new ChannelManager(settingsStore, executor, {
      createDriver: (settings, onStatus) => {
        const secret = settings.channel === 'telegram' ? settings.secret : ''
        if (onStatus) {
          activeStatus = onStatus
          return { ...inertDriver(settings.channel), updateAllowedSenderIds }
        }
        const driver = {
          ...inertDriver(settings.channel), start: vi.fn(), stop: vi.fn(() => { events.push('probe-stop') }),
          testConnection: vi.fn(async () => {
            events.push('probe')
            expect(await readFile(path, 'utf8')).toBe(original)
            expect((await manager.snapshot()).telegram.status.state).toBe('running')
            if (secret === 'invalid-test-secret') throw new Error('invalid-test-secret invalid token')
            return { botId: '456' }
          })
        }
        probes.push(driver)
        return driver
      },
      createService: () => ({
        start: async () => { events.push('service-start'); activeStatus({ state: 'running' }) },
        stop: async () => { events.push('service-stop') },
        updateAllowedSenderIds
      })
    })
    await manager.initialize()
    events.length = 0
    await expect(manager.apply({ telegram: {
      ...input, secret: { action: 'replace', value: 'invalid-test-secret' }
    } })).rejects.not.toThrow('invalid-test-secret')
    expect(events).toEqual(['probe', 'probe-stop'])
    expect(await readFile(path, 'utf8')).toBe(original)
    expect((await settingsStore.resolve('telegram')).secret).toBe('working-test-secret')
    expect((await manager.snapshot()).telegram.status.state).toBe('running')
    events.length = 0
    await manager.apply({ telegram: { ...input, secret: { action: 'replace', value: 'valid-test-secret' } } })
    expect(events).toEqual(['probe', 'probe-stop', 'service-stop', 'service-start'])
    expect((await settingsStore.resolve('telegram')).secret).toBe('valid-test-secret')
    for (const probe of probes) {
      expect(probe.start).not.toHaveBeenCalled()
      expect(probe.stop).toHaveBeenCalledOnce()
    }
    expect(updateAllowedSenderIds).not.toHaveBeenCalled()
    await manager.stopAll()
  })

  it('uses Electron fetch in the default Telegram factory and only probes identity and webhook', async () => {
    electronFetch.mockImplementation(async (input) => {
      const method = String(input).split('/').at(-1)
      if (method === 'getMe') {
        return new Response(JSON.stringify({ ok: true, result: { id: 123, is_bot: true, username: 'example_bot' } }))
      }
      if (method === 'getWebhookInfo') {
        return new Response(JSON.stringify({ ok: true, result: { url: '' } }))
      }
      throw new Error(`Unexpected Telegram method: ${method}`)
    })
    const manager = new ChannelManager(await store(), executor)
    expect(await manager.testConnection('telegram', {
      enabled: false, secret: { action: 'replace', value: 'test-only-secret' },
      allowedSenderIds: [], allowGroupMessages: false
    })).toEqual({ channel: 'telegram', ok: true, botUsername: 'example_bot' })
    expect(electronFetch.mock.calls.map(([input]) => String(input).split('/').at(-1)))
      .toEqual(['getMe', 'getWebhookInfo'])
    expect((await manager.snapshot()).telegram.status.state).toBe('disabled')
  })
  it('tests Telegram identity without creating a second poller or changing active settings', async () => {
    const settingsStore = await store()
    const starts = vi.fn(async () => undefined)
    const stops = vi.fn(async () => undefined)
    const probe = vi.fn(async () => ({ botId: '123', botUsername: 'example_bot' }))
    const createService = vi.fn(() => ({ start: starts, stop: stops }))
    const testDrivers: ChannelDriver[] = []
    const manager = new ChannelManager(settingsStore, executor, {
      createDriver: (settings, onStatus) => {
        onStatus?.({ state: 'running' })
        const driver = { ...inertDriver(settings.channel), start: vi.fn(), stop: vi.fn(), testConnection: probe }
        testDrivers.push(driver)
        return driver
      },
      createService
    })
    const input = { enabled: true, allowedSenderIds: [], allowGroupMessages: false as const }
    await settingsStore.apply({ telegram: { ...input, secret: { action: 'replace', value: 'stored-test-secret' } } })
    await manager.initialize()
    expect((await manager.snapshot()).telegram.status.state).toBe('running')
    expect(await manager.testConnection('telegram', {
      ...input, secret: { action: 'replace', value: 'temporary-test-secret' }
    })).toEqual({ channel: 'telegram', ok: true, botUsername: 'example_bot' })
    expect(await manager.test('telegram')).toEqual({ channel: 'telegram', ok: true, botUsername: 'example_bot' })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(createService).toHaveBeenCalledOnce()
    expect(starts).toHaveBeenCalledOnce()
    expect(stops).not.toHaveBeenCalled()
    for (const driver of testDrivers.slice(1)) {
      expect(driver.start).not.toHaveBeenCalled()
      expect(driver.stop).toHaveBeenCalledOnce()
    }
    expect((await settingsStore.resolve('telegram')).secret).toBe('stored-test-secret')
    expect((await manager.snapshot()).telegram.status.state).toBe('running')
    probe.mockRejectedValueOnce(new Error('temporary-test-secret failed'))
    const failure = await manager.test('telegram', { ...input, secret: { action: 'replace', value: 'temporary-test-secret' } })
    expect(failure.ok).toBe(false)
    expect(failure.error).not.toContain('temporary-test-secret')
    await manager.stopAll()
  })

  it('tracks Telegram runtime statuses and ignores retired driver and service callbacks', async () => {
    const settingsStore = await store()
    const callbacks: Array<(status: ChannelRuntimeStatus) => void> = []
    const deliveryCallbacks: Array<() => void> = []
    const lifecycle: string[] = []
    const manager = new ChannelManager(settingsStore, executor, {
      createDriver: (settings, onStatus) => {
        callbacks.push(onStatus!)
        return inertDriver(settings.channel)
      },
      createService: (_driver, _executor, options) => {
        const index = callbacks.length - 1
        deliveryCallbacks.push(() => options.onDeliverySuccess?.())
        return {
          start: async () => {
            lifecycle.push(`start-${index}`)
            callbacks[index]?.({ state: 'running' })
          },
          stop: async () => {
            lifecycle.push(`stop-${index}`)
            callbacks[index]?.({ state: 'error', lastError: 'retired' })
          }
        }
      }
    })
    const input = { enabled: true, allowedSenderIds: [], allowGroupMessages: false as const }
    await settingsStore.apply({ telegram: { ...input, secret: { action: 'replace', value: 'status-test-secret' } } })
    await manager.initialize()
    callbacks[0]?.({ state: 'error', lastError: 'status-test-secret network failure' })
    expect((await manager.snapshot()).telegram.status).toMatchObject({ state: 'error' })
    expect((await manager.snapshot()).telegram.status.lastError).not.toContain('status-test-secret')
    callbacks[0]?.({ state: 'running' })
    expect((await manager.snapshot()).telegram.status).toEqual({ state: 'running' })
    await manager.apply({ telegram: { ...input, secret: { action: 'keep' }, allowedSenderIds: ['123'] } })
    expect(lifecycle).toEqual(['start-0', 'stop-0', 'start-1'])
    callbacks[0]?.({ state: 'error', lastError: 'late failure' })
    expect((await manager.snapshot()).telegram.status.state).toBe('running')
    await manager.apply({ telegram: { ...input, enabled: false, secret: { action: 'keep' } } })
    callbacks[1]?.({ state: 'running' })
    deliveryCallbacks[1]?.()
    expect((await manager.snapshot()).telegram.status.state).toBe('disabled')
    await manager.apply({ telegram: { ...input, secret: { action: 'keep' } } })
    await manager.stopAll()
    callbacks[2]?.({ state: 'running' })
    expect((await manager.snapshot()).telegram.status.state).toBe('stopped')
  })

  it('rejects temporary Telegram environment overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-manager-'))
    roots.push(root)
    const settingsStore = new ChannelSettingsStore(join(root, 'settings.json'), cipher(), {
      GOODBUDDY_TELEGRAM_BOT_TOKEN: 'environment-test-secret'
    })
    const createDriver = vi.fn(() => inertDriver('telegram'))
    const manager = new ChannelManager(settingsStore, executor, { createDriver })
    expect((await manager.testConnection('telegram', {
      enabled: true, secret: { action: 'keep' }, allowedSenderIds: [], allowGroupMessages: false
    })).ok).toBe(false)
    expect(createDriver).not.toHaveBeenCalled()
  })
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
