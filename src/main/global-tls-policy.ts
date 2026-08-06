import type { App, Certificate, Event, WebContents } from 'electron'
import { globalAgent as nodeHttpsGlobalAgent } from 'node:https'
import {
  Agent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher
} from 'undici'

type CertificateErrorListener = (
  event: Event,
  webContents: WebContents,
  url: string,
  error: string,
  certificate: Certificate,
  callback: (isTrusted: boolean) => void,
  isMainFrame: boolean
) => void

type CertificateErrorApp = Pick<App, 'on' | 'removeListener'>

type GlobalTlsPolicyDependencies = {
  environment: NodeJS.ProcessEnv
  getDispatcher: () => Dispatcher
  setDispatcher: (dispatcher: Dispatcher) => void
  createInsecureDispatcher: () => Dispatcher
  resetNodeHttpsConnections?: () => void
}

const defaultDependencies: GlobalTlsPolicyDependencies = {
  environment: process.env,
  getDispatcher: getGlobalDispatcher,
  setDispatcher: setGlobalDispatcher,
  createInsecureDispatcher: () =>
    new Agent({
      connect: {
        rejectUnauthorized: false
      }
    }),
  resetNodeHttpsConnections: () => nodeHttpsGlobalAgent.destroy()
}

let controlledChildTlsCompatibilityEnabled = false

export function isControlledChildTlsCompatibilityEnabled(): boolean {
  return controlledChildTlsCompatibilityEnabled
}

/**
 * Applies invalid-certificate compatibility to network traffic owned by this
 * Electron process. URLs opened with an external OS browser are outside the
 * process and continue to use that browser's certificate policy.
 */
export class GlobalTlsPolicy {
  private readonly originalDispatcher: Dispatcher
  private readonly originalNodeTlsValue: string | undefined
  private readonly hadOriginalNodeTlsValue: boolean
  private insecureDispatcher?: Dispatcher
  private enabled = false
  private certificateErrorListenerInstalled = false

  private readonly certificateErrorListener: CertificateErrorListener = (
    event,
    ...parameters
  ) => {
    const callback = parameters[4]
    event.preventDefault()
    callback(true)
  }

  constructor(
    private readonly app: CertificateErrorApp,
    private readonly dependencies: GlobalTlsPolicyDependencies =
      defaultDependencies
  ) {
    this.originalDispatcher = dependencies.getDispatcher()
    this.hadOriginalNodeTlsValue = Object.prototype.hasOwnProperty.call(
      dependencies.environment,
      'NODE_TLS_REJECT_UNAUTHORIZED'
    )
    this.originalNodeTlsValue =
      dependencies.environment.NODE_TLS_REJECT_UNAUTHORIZED
  }

  apply(enabled: boolean): void {
    if (enabled) {
      this.enable()
      return
    }
    this.disable()
  }

  async dispose(): Promise<void> {
    this.disable()
    await this.insecureDispatcher?.close()
    this.insecureDispatcher = undefined
  }

  private enable(): void {
    if (this.enabled) {
      return
    }
    this.insecureDispatcher ??=
      this.dependencies.createInsecureDispatcher()
    this.dependencies.environment.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    this.dependencies.setDispatcher(this.insecureDispatcher)
    if (!this.certificateErrorListenerInstalled) {
      this.app.on(
        'certificate-error',
        this.certificateErrorListener
      )
      this.certificateErrorListenerInstalled = true
    }
    controlledChildTlsCompatibilityEnabled = true
    this.enabled = true
  }

  private disable(): void {
    const wasEnabled = this.enabled
    if (this.hadOriginalNodeTlsValue) {
      this.dependencies.environment.NODE_TLS_REJECT_UNAUTHORIZED =
        this.originalNodeTlsValue
    } else {
      delete this.dependencies.environment
        .NODE_TLS_REJECT_UNAUTHORIZED
    }
    this.dependencies.setDispatcher(this.originalDispatcher)
    if (this.certificateErrorListenerInstalled) {
      this.app.removeListener(
        'certificate-error',
        this.certificateErrorListener
      )
      this.certificateErrorListenerInstalled = false
    }
    if (wasEnabled) {
      this.dependencies.resetNodeHttpsConnections?.()
    }
    controlledChildTlsCompatibilityEnabled = false
    this.enabled = false
  }
}
