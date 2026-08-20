import {
  areShortcutAcceleratorsEquivalent,
  defaultGlobalShortcutSettings,
  formatShortcutForDisplay,
  globalShortcutSettingsSchema,
  type GlobalShortcutRegistrationStatus,
  type GlobalShortcutSettings,
  type GlobalShortcutSettingsSnapshot,
  type GlobalShortcutSettingsUpdateResult
} from '../shared/shortcut'

export interface GlobalShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export interface ShortcutSettingsPersistence {
  get(): Promise<GlobalShortcutSettings>
  update(input: unknown): Promise<GlobalShortcutSettings>
}

export class ShortcutSettingsService {
  private settings: GlobalShortcutSettings = {
    ...defaultGlobalShortcutSettings
  }
  private registeredAccelerator?: string
  private status: GlobalShortcutRegistrationStatus = 'disabled'
  private updateQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: ShortcutSettingsPersistence,
    private readonly registry: GlobalShortcutRegistry,
    private readonly callback: () => void,
    private readonly platform: string
  ) {}

  async initialize(): Promise<GlobalShortcutSettingsSnapshot> {
    this.settings = await this.store.get()
    if (!this.settings.enabled) {
      this.status = 'disabled'
      return this.snapshot()
    }
    const result = this.tryRegister(this.settings.accelerator)
    if (result === 'registered') {
      this.registeredAccelerator = this.settings.accelerator
    }
    this.status = result
    return this.snapshot()
  }

  private tryRegister(
    accelerator: string
  ): Extract<
    GlobalShortcutRegistrationStatus,
    'registered' | 'conflict' | 'failed'
  > {
    try {
      return this.registry.register(accelerator, this.callback)
        ? 'registered'
        : 'conflict'
    } catch {
      return 'failed'
    }
  }

  snapshot(): GlobalShortcutSettingsSnapshot {
    return {
      settings: { ...this.settings },
      defaultSettings: { ...defaultGlobalShortcutSettings },
      platform: this.platform,
      displayAccelerator: formatShortcutForDisplay(
        this.settings.accelerator,
        this.platform
      ),
      registered: this.registeredAccelerator !== undefined,
      ...(this.registeredAccelerator
        ? { registeredAccelerator: this.registeredAccelerator }
        : {}),
      status: this.status
    }
  }

  getSnapshot(): GlobalShortcutSettingsSnapshot {
    return this.snapshot()
  }

  update(input: unknown): Promise<GlobalShortcutSettingsUpdateResult> {
    const operation = this.updateQueue.then(
      async (): Promise<GlobalShortcutSettingsUpdateResult> => {
        const next = globalShortcutSettingsSchema.parse(input)
        const previous = this.settings
        const previousRegistered = this.registeredAccelerator
        const previousStatus = this.status

        if (!next.enabled) {
          try {
            await this.store.update(next)
          } catch {
            return {
              ok: false,
              error: 'save-failed',
              snapshot: this.snapshot()
            }
          }
          if (previousRegistered) {
            this.registry.unregister(previousRegistered)
          }
          this.settings = next
          this.registeredAccelerator = undefined
          this.status = 'disabled'
          return { ok: true, snapshot: this.snapshot() }
        }

        const keepsWorkingRegistration =
          previousRegistered !== undefined &&
          areShortcutAcceleratorsEquivalent(
            previousRegistered,
            next.accelerator,
            this.platform
          )
        if (!keepsWorkingRegistration) {
          const registration = this.tryRegister(next.accelerator)
          if (registration !== 'registered') {
            this.status = previousRegistered
              ? 'registered'
              : registration
            return {
              ok: false,
              error:
                registration === 'conflict'
                  ? 'conflict'
                  : 'registration-failed',
              snapshot: this.snapshot()
            }
          }
        }

        try {
          await this.store.update(next)
        } catch {
          if (!keepsWorkingRegistration) {
            this.registry.unregister(next.accelerator)
          }
          this.settings = previous
          this.registeredAccelerator = previousRegistered
          this.status = previousRegistered
            ? 'registered'
            : previousStatus
          return {
            ok: false,
            error: 'save-failed',
            snapshot: this.snapshot()
          }
        }

        if (previousRegistered && !keepsWorkingRegistration) {
          this.registry.unregister(previousRegistered)
        }
        this.settings = next
        this.registeredAccelerator = keepsWorkingRegistration
          ? previousRegistered
          : next.accelerator
        this.status = 'registered'
        return { ok: true, snapshot: this.snapshot() }
      }
    )
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}
