import { describe, expect, it, vi } from 'vitest'
import {
  areShortcutAcceleratorsEquivalent,
  type GlobalShortcutSettings
} from '../shared/shortcut'
import { ShortcutSettingsService } from './shortcut-settings-service'

function createFixture(
  initial: GlobalShortcutSettings = {
    enabled: true,
    accelerator: 'CommandOrControl+Shift+Space'
  },
  platform = 'win32'
) {
  let persisted = { ...initial }
  const store = {
    get: vi.fn(async () => ({ ...persisted })),
    update: vi.fn(async (input: unknown) => {
      persisted = input as GlobalShortcutSettings
      return { ...persisted }
    })
  }
  const registered = new Set<string>()
  const conflicts = new Set<string>()
  const registry = {
    register: vi.fn((accelerator: string) => {
      if (
        conflicts.has(accelerator) ||
        [...registered].some((current) =>
          areShortcutAcceleratorsEquivalent(
            current,
            accelerator,
            platform
          )
        )
      ) {
        return false
      }
      registered.add(accelerator)
      return true
    }),
    unregister: vi.fn((accelerator: string) => {
      registered.delete(accelerator)
    })
  }
  const service = new ShortcutSettingsService(
    store,
    registry,
    vi.fn(),
    platform
  )
  return {
    service,
    store,
    registry,
    registered,
    conflicts,
    getPersisted: () => persisted
  }
}

describe('ShortcutSettingsService', () => {
  it('registers the persisted shortcut at startup and reports display state', async () => {
    const { service, registered } = createFixture()

    await expect(service.initialize()).resolves.toMatchObject({
      registered: true,
      registeredAccelerator: 'CommandOrControl+Shift+Space',
      displayAccelerator: 'Ctrl+Shift+Space',
      status: 'registered'
    })
    expect(registered).toEqual(
      new Set(['CommandOrControl+Shift+Space'])
    )
  })

  it('keeps the old working registration and setting after a conflict', async () => {
    const fixture = createFixture()
    await fixture.service.initialize()
    fixture.conflicts.add('Control+Alt+K')

    await expect(
      fixture.service.update({
        enabled: true,
        accelerator: 'Control+Alt+K'
      })
    ).resolves.toMatchObject({
      ok: false,
      error: 'conflict',
      snapshot: {
        settings: {
          enabled: true,
          accelerator: 'CommandOrControl+Shift+Space'
        },
        registered: true,
        status: 'registered'
      }
    })
    expect(fixture.store.update).not.toHaveBeenCalled()
    expect(fixture.registered).toEqual(
      new Set(['CommandOrControl+Shift+Space'])
    )
  })

  it.each([
    [
      'win32',
      'CommandOrControl+Shift+Space',
      'Control+Shift+Space'
    ],
    [
      'linux',
      'CmdOrCtrl+Shift+Space',
      'Control+Shift+Space'
    ],
    [
      'darwin',
      'CommandOrControl+Shift+Space',
      'Command+Shift+Space'
    ]
  ])(
    'updates physically equivalent aliases on %s without self-conflict',
    async (platform, initialAccelerator, nextAccelerator) => {
      const fixture = createFixture(
        {
          enabled: true,
          accelerator: initialAccelerator
        },
        platform
      )
      await fixture.service.initialize()
      fixture.registry.register.mockClear()

      await expect(
        fixture.service.update({
          enabled: true,
          accelerator: nextAccelerator
        })
      ).resolves.toMatchObject({
        ok: true,
        snapshot: {
          settings: { accelerator: nextAccelerator },
          registeredAccelerator: initialAccelerator,
          status: 'registered'
        }
      })
      expect(fixture.registry.register).not.toHaveBeenCalled()
      expect(fixture.getPersisted().accelerator).toBe(nextAccelerator)
      expect(fixture.registered).toEqual(
        new Set([initialAccelerator])
      )
    }
  )

  it('rolls back a newly registered shortcut when persistence fails', async () => {
    const fixture = createFixture()
    await fixture.service.initialize()
    fixture.store.update.mockRejectedValueOnce(new Error('disk full'))

    await expect(
      fixture.service.update({
        enabled: true,
        accelerator: 'Control+Alt+K'
      })
    ).resolves.toMatchObject({
      ok: false,
      error: 'save-failed',
      snapshot: {
        settings: {
          accelerator: 'CommandOrControl+Shift+Space'
        },
        registeredAccelerator: 'CommandOrControl+Shift+Space'
      }
    })
    expect(fixture.registered).toEqual(
      new Set(['CommandOrControl+Shift+Space'])
    )
  })

  it('persists disabling before removing the working registration', async () => {
    const fixture = createFixture()
    await fixture.service.initialize()

    await expect(
      fixture.service.update({
        enabled: false,
        accelerator: 'CommandOrControl+Shift+Space'
      })
    ).resolves.toMatchObject({
      ok: true,
      snapshot: {
        registered: false,
        status: 'disabled'
      }
    })
    expect(fixture.getPersisted().enabled).toBe(false)
    expect(fixture.registered).toEqual(new Set())
  })
})
