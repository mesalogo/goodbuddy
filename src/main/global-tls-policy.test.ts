import type { App } from 'electron'
import type { Dispatcher } from 'undici'
import { describe, expect, it, vi } from 'vitest'
import {
  GlobalTlsPolicy,
  isControlledChildTlsCompatibilityEnabled
} from './global-tls-policy'

type CertificateListener = (
  event: { preventDefault(): void },
  webContents: unknown,
  url: string,
  error: string,
  certificate: unknown,
  callback: (trusted: boolean) => void,
  isMainFrame: boolean
) => void

function dispatcher(): Dispatcher {
  return {
    close: vi.fn().mockResolvedValue(undefined)
  } as unknown as Dispatcher
}

function certificateApp() {
  let listener: CertificateListener | undefined
  const app = {
    on: vi.fn((_event: string, next: CertificateListener) => {
      listener = next
      return app
    }),
    removeListener: vi.fn(
      (_event: string, removed: CertificateListener) => {
        if (listener === removed) {
          listener = undefined
        }
        return app
      }
    )
  }
  return {
    app: app as unknown as Pick<App, 'on' | 'removeListener'>,
    getListener: () => listener
  }
}

describe('GlobalTlsPolicy', () => {
  it('enables all in-process TLS compatibility paths and restores originals', () => {
    const originalDispatcher = dispatcher()
    const insecureDispatcher = dispatcher()
    const environment: NodeJS.ProcessEnv = {
      NODE_TLS_REJECT_UNAUTHORIZED: '1'
    }
    const setDispatcher = vi.fn()
    const resetNodeHttpsConnections = vi.fn()
    const electron = certificateApp()
    const policy = new GlobalTlsPolicy(electron.app, {
      environment,
      getDispatcher: () => originalDispatcher,
      setDispatcher,
      createInsecureDispatcher: () => insecureDispatcher,
      resetNodeHttpsConnections
    })

    policy.apply(true)

    expect(environment.NODE_TLS_REJECT_UNAUTHORIZED).toBe('0')
    expect(setDispatcher).toHaveBeenLastCalledWith(
      insecureDispatcher
    )
    expect(
      isControlledChildTlsCompatibilityEnabled()
    ).toBe(true)

    const preventDefault = vi.fn()
    const callback = vi.fn()
    electron.getListener()?.(
      { preventDefault },
      {},
      'https://intranet.test',
      'net::ERR_CERT_AUTHORITY_INVALID',
      {},
      callback,
      true
    )
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(true)

    policy.apply(false)

    expect(environment.NODE_TLS_REJECT_UNAUTHORIZED).toBe('1')
    expect(setDispatcher).toHaveBeenLastCalledWith(
      originalDispatcher
    )
    expect(electron.getListener()).toBeUndefined()
    expect(resetNodeHttpsConnections).toHaveBeenCalledOnce()
    expect(
      isControlledChildTlsCompatibilityEnabled()
    ).toBe(false)
  })

  it('restores an originally absent Node TLS environment value', async () => {
    const originalDispatcher = dispatcher()
    const insecureDispatcher = dispatcher()
    const environment: NodeJS.ProcessEnv = {}
    const setDispatcher = vi.fn()
    const electron = certificateApp()
    const policy = new GlobalTlsPolicy(electron.app, {
      environment,
      getDispatcher: () => originalDispatcher,
      setDispatcher,
      createInsecureDispatcher: () => insecureDispatcher
    })

    policy.apply(true)
    policy.apply(true)
    expect(electron.app.on).toHaveBeenCalledOnce()

    await policy.dispose()

    expect(
      Object.prototype.hasOwnProperty.call(
        environment,
        'NODE_TLS_REJECT_UNAUTHORIZED'
      )
    ).toBe(false)
    expect(insecureDispatcher.close).toHaveBeenCalledOnce()
  })

  it('only owns Electron traffic; external OS browsers retain their own TLS policy', () => {
    const originalDispatcher = dispatcher()
    const electron = certificateApp()
    const policy = new GlobalTlsPolicy(electron.app, {
      environment: {},
      getDispatcher: () => originalDispatcher,
      setDispatcher: vi.fn(),
      createInsecureDispatcher: dispatcher
    })

    policy.apply(true)

    expect(electron.app.on).toHaveBeenCalledWith(
      'certificate-error',
      expect.any(Function)
    )
    policy.apply(false)
  })
})
