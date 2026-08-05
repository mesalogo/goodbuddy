import { describe, expect, it, vi } from 'vitest'
import {
  LinuxDesktopInputRouter,
  type InjectedInputBackend,
  type SemanticInput,
  type YdotoolInputBackend
} from './input-router'

const semantic = (result: boolean): SemanticInput => ({
  perform: vi.fn(async () => result)
})

const backend = (): InjectedInputBackend => ({
  inject: vi.fn(async () => undefined),
  releasePressedInput: vi.fn(async () => undefined)
})

describe('LinuxDesktopInputRouter', () => {
  it('always attempts the semantic action before native injection', async () => {
    const portal = backend()
    const router = new LinuxDesktopInputRouter({
      semantic: semantic(true),
      portal,
      portalConsentActive: () => true,
      provenX11: () => false
    })

    await expect(
      router.route(
        { type: 'text', text: 'hello' },
        new AbortController().signal
      )
    ).resolves.toEqual({ route: 'semantic' })
    expect(portal.inject).not.toHaveBeenCalled()
  })

  it('uses portal input only while user consent is active', async () => {
    let consent = false
    const portal = backend()
    const router = new LinuxDesktopInputRouter({
      semantic: semantic(false),
      portal,
      portalConsentActive: () => consent,
      provenX11: () => false
    })

    await expect(
      router.route(
        { type: 'pointer-move', x: 1, y: 2 },
        new AbortController().signal,
        { backend: 'portal' }
      )
    ).rejects.toThrow('active user consent')
    consent = true
    await expect(
      router.route(
        { type: 'pointer-move', x: 1, y: 2 },
        new AbortController().signal
      )
    ).resolves.toEqual({ route: 'portal' })
  })

  it('uses XTest only for a proven X11 connection', async () => {
    let proven = false
    const xTest = backend()
    const router = new LinuxDesktopInputRouter({
      semantic: semantic(false),
      portalConsentActive: () => false,
      xTest,
      provenX11: () => proven
    })
    await expect(
      router.route(
        { type: 'key', key: 'Enter', pressed: true },
        new AbortController().signal,
        { backend: 'xtest' }
      )
    ).rejects.toThrow('proven X11')

    proven = true
    await expect(
      router.route(
        { type: 'key', key: 'Enter', pressed: true },
        new AbortController().signal
      )
    ).resolves.toEqual({ route: 'xtest' })
  })

  it('never silently selects ydotool and requires its exact fixed executable', async () => {
    const ydotool: YdotoolInputBackend = {
      ...backend(),
      executablePath: '/usr/bin/ydotool'
    }
    const router = new LinuxDesktopInputRouter({
      semantic: semantic(false),
      portalConsentActive: () => false,
      provenX11: () => false,
      ydotool,
      ydotoolOptIn: true,
      fixedYdotoolExecutable: '/usr/bin/ydotool'
    })

    await expect(
      router.route(
        { type: 'scroll', deltaX: 0, deltaY: 1 },
        new AbortController().signal
      )
    ).rejects.toThrow('No consented')
    await expect(
      router.route(
        { type: 'scroll', deltaX: 0, deltaY: 1 },
        new AbortController().signal,
        { backend: 'ydotool' }
      )
    ).resolves.toEqual({ route: 'ydotool' })

    expect(
      () =>
        new LinuxDesktopInputRouter({
          semantic: semantic(false),
          portalConsentActive: () => false,
          provenX11: () => false,
          ydotoolOptIn: true,
          fixedYdotoolExecutable: 'ydotool'
        })
    ).toThrow('absolute fixed executable')
  })

  it('releases pressed input best-effort when an operation is aborted', async () => {
    const controller = new AbortController()
    const portal = backend()
    portal.inject = vi.fn(
      async (_action, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
    )
    portal.releasePressedInput = vi.fn(async () => {
      throw new Error('release failed')
    })
    const router = new LinuxDesktopInputRouter({
      semantic: semantic(false),
      portal,
      portalConsentActive: () => true,
      provenX11: () => false
    })
    const routed = router.route(
      { type: 'pointer-button', button: 1, pressed: true },
      controller.signal
    )
    await Promise.resolve()
    controller.abort()

    await expect(routed).rejects.toThrow()
    expect(portal.releasePressedInput).toHaveBeenCalled()
  })

  it('releases partially pressed input after a non-abort injection failure', async () => {
    const portal = backend()
    portal.inject = vi.fn(async () => {
      throw new Error('partial native injection')
    })
    portal.releasePressedInput = vi.fn(async () => {
      throw new Error('best-effort release failed')
    })
    const router = new LinuxDesktopInputRouter({
      semantic: semantic(false),
      portal,
      portalConsentActive: () => true,
      provenX11: () => false
    })

    await expect(
      router.route(
        { type: 'key', key: 'Control_L', pressed: true },
        new AbortController().signal
      )
    ).rejects.toThrow('partial native injection')
    expect(portal.releasePressedInput).toHaveBeenCalledOnce()
  })

  it.each([
    { type: 'pointer-move', x: Number.NaN, y: 0 } as const,
    { type: 'pointer-button', button: 0, pressed: true } as const,
    { type: 'scroll', deltaX: 0, deltaY: Number.POSITIVE_INFINITY } as const,
    { type: 'key', key: '\n', pressed: true } as const,
    { type: 'text', text: '\u0000secret' } as const
  ])('rejects malformed actions before any backend sees them', async (action) => {
    const semanticInput = semantic(false)
    const portal = backend()
    const router = new LinuxDesktopInputRouter({
      semantic: semanticInput,
      portal,
      portalConsentActive: () => true,
      provenX11: () => false
    })

    await expect(
      router.route(action, new AbortController().signal)
    ).rejects.toThrow('Invalid')
    expect(semanticInput.perform).not.toHaveBeenCalled()
    expect(portal.inject).not.toHaveBeenCalled()
  })
})
