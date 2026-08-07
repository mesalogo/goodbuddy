import type { App } from 'electron'
import type { Dispatcher } from 'undici'
import { describe, expect, it, vi } from 'vitest'
import { GlobalTlsPolicy } from './global-tls-policy'

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
  it('accepts self-signed certificates on every in-process TLS path', () => {
    const insecureDispatcher = dispatcher()
    const environment: NodeJS.ProcessEnv = {
      NODE_TLS_REJECT_UNAUTHORIZED: '1'
    }
    const setDispatcher = vi.fn()
    const electron = certificateApp()
    const policy = new GlobalTlsPolicy(electron.app, {
      environment,
      getDispatcher: dispatcher,
      setDispatcher,
      createInsecureDispatcher: () => insecureDispatcher
    })

    policy.install()

    expect(environment.NODE_TLS_REJECT_UNAUTHORIZED).toBe('0')
    expect(setDispatcher).toHaveBeenLastCalledWith(insecureDispatcher)

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
  })

  it('installs the certificate listener once and releases it on dispose', async () => {
    const originalDispatcher = dispatcher()
    const insecureDispatcher = dispatcher()
    const setDispatcher = vi.fn()
    const electron = certificateApp()
    const policy = new GlobalTlsPolicy(electron.app, {
      environment: {},
      getDispatcher: () => originalDispatcher,
      setDispatcher,
      createInsecureDispatcher: () => insecureDispatcher
    })

    policy.install()
    policy.install()
    expect(electron.app.on).toHaveBeenCalledOnce()

    await policy.dispose()

    expect(setDispatcher).toHaveBeenLastCalledWith(originalDispatcher)
    expect(electron.getListener()).toBeUndefined()
    expect(insecureDispatcher.close).toHaveBeenCalledOnce()
  })
})
