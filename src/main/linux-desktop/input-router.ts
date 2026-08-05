import { isAbsolute } from 'node:path'

export type DesktopInputAction =
  | { type: 'pointer-move'; x: number; y: number }
  | { type: 'pointer-button'; button: number; pressed: boolean }
  | { type: 'scroll'; deltaX: number; deltaY: number }
  | { type: 'key'; key: string; pressed: boolean }
  | { type: 'text'; text: string }

export type InputBackendName = 'portal' | 'xtest' | 'ydotool'

export interface SemanticInput {
  perform(action: DesktopInputAction, signal: AbortSignal): Promise<boolean>
}

export interface InjectedInputBackend {
  inject(action: DesktopInputAction, signal: AbortSignal): Promise<void>
  releasePressedInput(): Promise<void>
}

export interface YdotoolInputBackend extends InjectedInputBackend {
  readonly executablePath: string
}

export type InputRouterOptions = {
  semantic: SemanticInput
  portal?: InjectedInputBackend
  portalConsentActive: () => boolean
  xTest?: InjectedInputBackend
  provenX11: () => boolean
  ydotool?: YdotoolInputBackend
  ydotoolOptIn?: boolean
  fixedYdotoolExecutable?: string
}

export type RouteInputOptions = {
  backend?: 'auto' | InputBackendName
}

export type RoutedInputResult = {
  route: 'semantic' | InputBackendName
}

const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })

const validateAction = (action: DesktopInputAction): void => {
  switch (action.type) {
    case 'pointer-move':
      if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) {
        throw new Error('Invalid pointer coordinates')
      }
      return
    case 'pointer-button':
      if (
        !Number.isSafeInteger(action.button) ||
        action.button < 1 ||
        action.button > 32
      ) {
        throw new Error('Invalid pointer button')
      }
      return
    case 'scroll':
      if (
        !Number.isFinite(action.deltaX) ||
        !Number.isFinite(action.deltaY) ||
        Math.abs(action.deltaX) > 100_000 ||
        Math.abs(action.deltaY) > 100_000
      ) {
        throw new Error('Invalid scroll delta')
      }
      return
    case 'key':
      if (
        action.key.length < 1 ||
        action.key.length > 64 ||
        hasControlCharacters(action.key)
      ) {
        throw new Error('Invalid key identifier')
      }
      return
    case 'text':
      if (
        action.text.length > 4_096 ||
        action.text.includes('\u0000')
      ) {
        throw new Error('Invalid text input')
      }
  }
}

export class LinuxDesktopInputRouter {
  private readonly usedBackends = new Set<InjectedInputBackend>()

  constructor(private readonly options: InputRouterOptions) {
    if (
      options.ydotoolOptIn &&
      (!options.fixedYdotoolExecutable ||
        !isAbsolute(options.fixedYdotoolExecutable))
    ) {
      throw new Error('ydotool requires an absolute fixed executable path')
    }
  }

  async route(
    action: DesktopInputAction,
    signal: AbortSignal,
    routeOptions: RouteInputOptions = {}
  ): Promise<RoutedInputResult> {
    validateAction(action)
    if (signal.aborted) {
      throw signal.reason
    }
    if (await this.options.semantic.perform(action, signal)) {
      return { route: 'semantic' }
    }

    const selected = this.selectBackend(routeOptions.backend ?? 'auto')
    this.usedBackends.add(selected.backend)
    let released = false
    let releasePromise: Promise<void> | undefined
    const releaseOnAbort = (): void => {
      if (!released) {
        released = true
        releasePromise = this.releasePressedInput()
      }
    }
    signal.addEventListener('abort', releaseOnAbort, { once: true })
    try {
      await selected.backend.inject(action, signal)
      if (signal.aborted) {
        releaseOnAbort()
        throw signal.reason
      }
      return { route: selected.name }
    } catch (error) {
      await (releasePromise ?? this.releasePressedInput())
      throw error
    } finally {
      signal.removeEventListener('abort', releaseOnAbort)
    }
  }

  async releasePressedInput(): Promise<void> {
    const backends = [...this.usedBackends]
    this.usedBackends.clear()
    await Promise.allSettled(
      backends.map((backend) => backend.releasePressedInput())
    )
  }

  private selectBackend(preference: 'auto' | InputBackendName): {
    name: InputBackendName
    backend: InjectedInputBackend
  } {
    if (preference === 'portal') {
      if (!this.options.portal || !this.options.portalConsentActive()) {
        throw new Error('Portal input requires active user consent')
      }
      return { name: 'portal', backend: this.options.portal }
    }
    if (preference === 'xtest') {
      if (!this.options.xTest || !this.options.provenX11()) {
        throw new Error('XTest requires a proven X11 connection')
      }
      return { name: 'xtest', backend: this.options.xTest }
    }
    if (preference === 'ydotool') {
      const fixed = this.options.fixedYdotoolExecutable
      if (
        !this.options.ydotoolOptIn ||
        !fixed ||
        !this.options.ydotool ||
        this.options.ydotool.executablePath !== fixed
      ) {
        throw new Error(
          'ydotool requires explicit opt-in and the fixed executable'
        )
      }
      return { name: 'ydotool', backend: this.options.ydotool }
    }

    if (this.options.portal && this.options.portalConsentActive()) {
      return { name: 'portal', backend: this.options.portal }
    }
    if (this.options.xTest && this.options.provenX11()) {
      return { name: 'xtest', backend: this.options.xTest }
    }
    throw new Error('No consented or proven input backend is available')
  }
}
